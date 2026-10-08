/**
 * dsh-feed —— 把 feed 订阅变成**边沿触发**的自动任务。
 *
 * 与 `schedule` 同家族、同投递口(`sessionController.resolveAgent` + `agent.followup()`),
 * 唯一区别是触发源是「条目到达」而不是「到点」。
 *
 * 零依赖:只用内置模块。profile bundle **不能** import 任何 `@deepseek-ai/*` 或第三方包,
 * 所以这里不声明 `Config`(那需要一个校验库),常量直接写在下面。
 *
 * 完整设计见 ../feedwatch/DESIGN.md。
 *
 * @module @local/dsh-feed
 */

import { createLog, ensureDir, migrateLegacyStateDir, resolveStateDir } from './lib/log.js'
import { openStore } from './lib/store.js'
import { fetchFeed, nextCadence, pickNewItems, splitBaseline } from './lib/feed.js'
import { parseFeed } from './lib/parse.js'
import { buildFrame, deliverToSession, matchItem } from './lib/deliver.js'
import { registerTools } from './lib/tools.js'

/** Loader 行名,出现在诊断里。 */
export const name = 'dsh-feed'

/**
 * 依赖声明。
 *
 * 必须声明而不是在 apply 里 `ctx.get()` 一次:服务可能异步出现,
 * 读早了会静默变成 no-op 却仍然报 active(fs-local-fix 踩过这个坑)。
 */
export const inject = ['tools', 'sessionController']

/** 部署级默认值。用户数据(订阅/规则)在数据库里,不在这里。 */
const DEFAULTS = {
  /** 采集循环的粒度。抖动加在每个源的 next_due_at 上,不加在这里。 */
  tickMs: 30000,
  /** 新订阅的起始间隔。 */
  defaultIntervalSeconds: 1800,
  /** 自适应间隔的下限。 */
  minIntervalSeconds: 900,
  /** 自适应间隔的上限。 */
  maxIntervalSeconds: 86400,
  /** 一个 tick 里最多抓几个源。 */
  maxConcurrentFetches: 4,
  requestTimeoutMs: 15000,
  maxBodyBytes: 1024 * 1024,
  /**
   * 是否允许抓取私网地址。默认 false。
   *
   * 理由不是洁癖:Host 进程有完整网络能力,而一个恶意 feed 只要 302 到
   * `http://127.0.0.1:…`(DSH 的 Web GUI 就监听在本机),那个响应就会经解析层
   * 变成条目内容进入模型上下文。见 lib/feed.js 里手动跟随重定向的注释。
   */
  allowPrivateNetworks: false,
  /** 一次投递最多几条。 */
  defaultMaxItems: 20,
  /** 摘要截断长度。 */
  maxExcerptChars: 1200,
  /** 每源保留的去重身份条数。 */
  seenKeep: 200,
  /** 每个 monitor 最多积压多少条未投递;超出丢最旧的并记账。 */
  pendingCapPerMonitor: 200,
  /** 加载后是否立刻检查一次(补上 DSH 关闭期间的空档)。 */
  pollOnBoot: true,
}

/**
 * 当前活着的实例。
 *
 * 存在的理由:加载器可能对同一行再跑一次 `apply`(热重载、配置重算)。
 * 不拦的话就会有**两个** store 连接和**两个** timer 同时跑,
 * 表现为同一轮里重复抓取、重复投递。实测见过一次可疑的重复投递,
 * 与两次极近的 `apply` 时间吻合,所以这里显式做单例。
 */
let activeDispose = null

/**
 * 插件入口。
 *
 * @param ctx - 插件上下文;`tools` 与 `sessionController` 由 `inject` 保证存在
 * @param config - Loader 行上的 config(未校验,直接与默认值合并)
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }

  const stateDir = resolveStateDir()
  // 旧目录名(feedwatch/)→ 新目录名(dsh-feed/)的一次性搬家,必须在开库之前跑。
  const moved = migrateLegacyStateDir(stateDir)
  ensureDir(stateDir)
  const log = createLog(stateDir)
  log.info('apply:start', { stateDir, pid: process.pid })
  if (moved.moved) log.warn('state-dir migrated', moved)
  // 两边都有库(改名只生效了一半)。以当前目录为准,但必须留痕:
  // 否则「旧目录里还有一份数据没被用上」这件事只存在于文件系统里。
  else if (moved.reason === 'target-exists') log.warn('state-dir migration skipped', moved)

  if (activeDispose !== null) {
    log.warn('apply called again while an instance is live; disposing the previous one')
    try {
      activeDispose()
    } catch {
      /* 上一个实例清理失败不能挡住新的 */
    }
    activeDispose = null
  }

  // ── 存储:整个插件的地基,也是唯一一处"验证过但没在 Host 主进程里验过"的假设 ──
  let store
  try {
    store = openStore({ dir: stateDir, log })
    log.info('sqlite=ok', { file: store.file, sources: store.sources.count(), monitors: store.monitors.count() })
  } catch (error) {
    // 不吞。地基没了就大声失败,让 Loader 把这一行标成 failed。
    log.error('sqlite=unavailable', { error: String(error?.message ?? error) })
    throw error
  }

  let disposed = false
  let ticking = false
  let timer = null

  const sourceUrlOf = (sourceId) => store.sources.byId(sourceId)?.url ?? ''

  /**
   * 按 monitor 的规则把新条目写进 pending。
   * @returns 入队的行数
   */
  function enqueue(sourceRow, items) {
    const monitors = store.monitors.forSource(sourceRow.id)
    if (monitors.length === 0 || items.length === 0) return 0

    const rows = []
    for (const monitor of monitors) {
      let match
      try {
        match = JSON.parse(monitor.match_json)
      } catch {
        match = {}
      }
      // 这里**不**按 max_items 截断。max_items 只决定「一次投递几条」,
      // 用它来限制入队会让超出的条目直接消失 —— 那是静默丢数据。
      // 超出的留在 pending 里,由下一次投递带走(消息里会提示还有多少条)。
      for (const item of items) {
        if (!matchItem({ match }, item).hit) continue
        rows.push({
          monitorId: monitor.id,
          seq: store.nextSeq(),
          sourceId: sourceRow.id,
          itemKey: item.key,
          title: item.title,
          link: item.link,
          published: item.publishedAt,
          summary: item.summary,
        })
      }
    }

    if (rows.length > 0) {
      store.pending.add(rows)
      // 上限保护:一个超高产的源不能把 pending 撑到无限。
      // 丢最旧的(最不可能还关心),并且**记账**,不静默。
      for (const monitor of monitors) {
        const dropped = store.pending.trimOldest(monitor.id, settings.pendingCapPerMonitor)
        if (dropped > 0) {
          log.warn('pending-capped', { monitorId: monitor.id, dropped, cap: settings.pendingCapPerMonitor })
        }
      }
    }
    return rows.length
  }

  /**
   * 抓一个源,推进它的节奏,并把命中的条目入队。
   *
   * 这是唯一"死了就真丢数据"的环节:窗口只有 10 条的源,停一轮就可能永久漏条目。
   */
  async function pollSource(sourceRow) {
    const started = Date.now()
    const result = await fetchFeed(sourceRow.url, {
      etag: sourceRow.etag,
      lastModified: sourceRow.last_modified,
      timeoutMs: settings.requestTimeoutMs,
      maxBytes: settings.maxBodyBytes,
      allowPrivateNetworks: settings.allowPrivateNetworks,
    })

    let fresh = []
    let parsed = null
    let baseline = []

    // 第一次**成功**抓取 = 订阅时刻之前的东西只记账、不投递(见 splitBaseline)。
    //
    // 判据是显式的 `bootstrapped` 列(schema v2),**不是** `last_checked_at === null`:
    // 后者在任何 outcome 下都会被写,于是首次抓取失败一次(离线/5xx/429/超时/超
    // maxBodyBytes)就永久吃掉了基线门 —— 下一次成功抓取会把窗口内全部条目
    // 当新条目投进会话,正是 splitBaseline 声明要避免的「倒一年历史」。
    const isFirstPoll = Number(sourceRow.bootstrapped) !== 1

    if (result.outcome === 'ok') {
      parsed = parseFeed(result.text, settings.maxExcerptChars)
      fresh = pickNewItems(parsed.items, store.seen.keysOf(sourceRow.id))
      if (isFirstPoll && fresh.length > 0) {
        const split = splitBaseline(fresh, Number(sourceRow.created_at))
        baseline = split.baseline
        fresh = split.deliver
      }
    }

    const cadence = nextCadence(sourceRow, {
      now: started,
      outcome: result.outcome,
      // 用「看见的」而不是「要投的」:基线里的条目同样是这个源的产出,
      // 节奏控制器应该知道,否则第一次抓取会被误判成"静默"而减速。
      newCount: fresh.length + baseline.length,
      windowSize: parsed?.windowSize ?? null,
      items: parsed?.items ?? null,
      cdnMaxAge: result.cdnMaxAge ?? null,
      expiresMaxAge: result.expiresMaxAge ?? null,
      // 频道级 <ttl>:源自己声明「不必查得比我更新更快」。
      ttlSeconds: parsed?.ttlSeconds ?? null,
      // 429/503 上服务器给的等待时长,优先级高于一切(见 nextCadence)。
      retryAfterSeconds: result.retryAfterSeconds ?? null,
    }, settings)

    // 取数失败与解析失败是两件事,但共用同一个计数器(Miniflux 也是
    // `ParsingErrorCount` 一个计数器,见 model/feed.go:36-37)。
    //
    // 这里修的是一个真实缺口:一个返回 **200 + 垃圾内容** 的源,原来会被记成
    // 'ok'、`failures` 归零、`last_error` 为空 —— 于是它在 feed_list 里
    // **永远显示健康,却一条都不会投**。
    const parseFailed = result.outcome === 'ok' && parsed !== null && parsed.format === 'unknown'
    const outcome = result.outcome === 'not-modified' ? 'not-modified'
      : parseFailed ? 'parse-error'
        : result.outcome === 'ok' ? 'ok'
          : result.outcome === 'rate-limited' ? 'rate-limited'
            : 'error'

    // 「记下已见」和「入队」必须在**同一个事务**里。分两次写的话,
    // 中间崩一次就会把条目永久抹掉:已见已记,却从没进过 pending。
    let queued = 0
    store.tx(() => {
      // 基线条目也必须记进 seen:否则下一轮它们又会被当成"新条目"重新挑出来,
      // 于是"不倒历史"就变成了"每次都倒一遍历史"。
      const toMark = [...fresh, ...baseline].map((item) => item.key)
      if (toMark.length > 0) {
        store.seen.addMany(sourceRow.id, toMark, started)
        store.seen.prune(sourceRow.id, settings.seenKeep)
      }
      if (parsed !== null && parsed.title !== ''
        && (sourceRow.title === sourceRow.url || sourceRow.title === '')) {
        store.sources.touch(sourceRow.id, parsed.title.slice(0, 200), started)
      }
      queued = enqueue({ ...sourceRow, title: parsed?.title || sourceRow.title }, fresh)
      store.sources.updateAfterPoll(sourceRow.id, {
        intervalSec: cadence.intervalSec,
        // 上限由 nextCadence 单点保证(夹紧放在最后,见那里的注释)。
        // 原来这里还有个针对 error 的 `Math.min(...)` 兜底,现在是多余的 ——
        // 两处各管一半的上限只会让「到底谁是硬的」变得说不清。
        // 注意 nextDueAt 仍带 ±10% 抖动(避免整点惊群),所以它可比 intervalSec 晚一点。
        nextDueAt: cadence.nextDueAt,
        etag: result.etag ?? sourceRow.etag,
        lastModified: result.lastModified ?? sourceRow.last_modified,
        condHits: Number(sourceRow.cond_hits) + (result.outcome === 'not-modified' ? 1 : 0),
        condMisses: Number(sourceRow.cond_misses)
          + (result.outcome === 'ok' && (sourceRow.etag || sourceRow.last_modified) ? 1 : 0),
        cdnMaxAge: result.cdnMaxAge ?? sourceRow.cdn_max_age,
        windowSize: cadence.windowSize,
        meanGapMs: cadence.meanGapMs,
        // 限流不计入 failures:那是我们在守规矩,不是源坏了。
        failures: outcome === 'error' || outcome === 'parse-error' ? Number(sourceRow.failures) + 1 : 0,
        lastStatus: outcome,
        lastError: outcome === 'parse-error'
          ? `unrecognised feed format (HTTP ${result.status})`
          : result.outcome === 'error' ? String(result.error).slice(0, 500) : null,
        lastItemAt: cadence.lastItemAt,
        lateDetected: cadence.lateDetected,
        // 只有**成功解析**的一轮才算「引导完成」。失败轮次不传这个字段 →
        // store 侧 COALESCE 保持原值,基线门留给下一次成功抓取。
        bootstrapped: outcome === 'ok' ? 1 : undefined,
      }, started)
    })

    log.info('poll', {
      sourceId: sourceRow.id,
      outcome,
      window: parsed?.items.length ?? 0,
      fresh: fresh.length,
      baseline: baseline.length,
      queued,
      intervalSec: cadence.intervalSec,
      late: cadence.lateDetected,
    })

    return { outcome, newCount: fresh.length, baseline: baseline.length }
  }

  /**
   * 把 pending 投进各自的会话。
   *
   * **同一会话在同一轮的多条命中合并成一条消息** —— 否则 20 个 monitor 同时命中
   * 就是 20 次 followup。这是 schedule 已验证的做法。
   */
  async function deliverPending() {
    const counts = store.pending.counts()
    if (counts.size === 0) return 0

    const now = Date.now()
    const groups = new Map()
    for (const monitor of store.monitors.list()) {
      if (monitor.enabled !== 1) continue
      if ((counts.get(monitor.id) ?? 0) === 0) continue
      const quietMs = Number(monitor.quiet_minutes) * 60000
      if (quietMs > 0 && monitor.last_delivery !== null
        && now - Number(monitor.last_delivery) < quietMs) continue
      let target
      try {
        target = JSON.parse(monitor.target_json)
      } catch {
        continue
      }
      if (typeof target?.sessionId !== 'string' || target.sessionId === '') continue
      if (!groups.has(target.sessionId)) groups.set(target.sessionId, [])
      groups.get(target.sessionId).push(monitor)
    }

    let delivered = 0
    for (const [sessionId, monitors] of groups) {
      const entries = []
      for (const monitor of monitors) {
        const maxItems = Number(monitor.max_items) || settings.defaultMaxItems
        const rows = store.pending.list(monitor.id, maxItems)
        if (rows.length === 0) continue
        entries.push({
          monitorId: monitor.id,
          monitorTitle: monitor.title,
          sourceUrl: sourceUrlOf(rows[0].source_id),
          items: rows.map((row) => ({
            seq: Number(row.seq),
            key: row.item_key,
            title: row.title,
            link: row.link ?? '',
            publishedAt: row.published ?? '',
            summary: row.summary ?? '',
          })),
        })
      }
      if (entries.length === 0) continue

      // 还没进这一批的:被 max_items 挡在外面的那些。
      const cappedOut = monitors.reduce((sum, monitor) => {
        const total = counts.get(monitor.id) ?? 0
        const listed = entries.find((entry) => entry.monitorId === monitor.id)?.items.length ?? 0
        return sum + Math.max(0, total - listed)
      }, 0)

      const frame = buildFrame(entries, { remaining: cappedOut })

      // 只删**真正进了消息**的条目。buildFrame 在超预算时会砍掉尾巴,那些必须
      // 留在 pending 里 —— 否则消息末尾那句 "call feed_read to fetch them" 就是假的,
      // 而模型会照着去取、什么也取不到。
      const batch = new Map()
      for (const { monitorId, seq } of frame.kept) {
        if (!batch.has(monitorId)) batch.set(monitorId, [])
        batch.get(monitorId).push(seq)
      }
      const items = frame.kept.length
      // 归属元数据:v4 保留 source 上的自有 JSON 字段,kind 由 deliver.js 钉死。
      const outcome = await deliverToSession(ctx, sessionId, frame.text, { monitors: batch.size, items })

      if (!outcome.ok) {
        // 条目留在 pending,下一轮重投。at-least-once。
        log.warn('delivery-failed', { sessionId, error: outcome.error, monitors: batch.size })
        continue
      }

      store.tx(() => {
        for (const [monitorId, seqs] of batch) {
          store.pending.remove(monitorId, seqs)
          store.monitors.markDelivered(monitorId, Math.max(...seqs), Date.now())
        }
      })
      delivered += items
      log.info('delivered', { sessionId, monitors: batch.size, items, remaining: cappedOut })
    }

    return delivered
  }

  /** 一次采集循环。重入保护:上一轮没跑完就不再进。 */
  async function tick() {
    if (disposed || ticking) return
    ticking = true
    try {
      const now = Date.now()
      const due = store.sources.due(now, settings.maxConcurrentFetches)
      if (due.length > 0) {
        // 诊断:为什么这一轮会去抓。next_due_at 本该把绝大多数轮次挡在外面。
        log.info('tick-due', {
          now,
          count: due.length,
          rows: due.map((row) => `${row.id}@${row.next_due_at}(${row.next_due_at - now}ms)`).join(' '),
        })
        // 网络部分是并行的;数据库写入是同步的,不会交错。
        await Promise.all(due.map((row) => pollSource(row).catch((error) => {
          log.error('poll-threw', { sourceId: row.id, error: String(error?.message ?? error) })
        })))
      }
      await deliverPending()
    } catch (error) {
      log.error('tick-threw', { error: String(error?.message ?? error) })
    } finally {
      ticking = false
    }
  }

  const poke = () => {
    if (disposed) return
    setTimeout(() => { void tick() }, 0)
  }

  // ── 接线 ──
  const unregisterTools = registerTools(ctx, { store, config: settings, log, poke })

  timer = setInterval(() => { void tick() }, settings.tickMs)
  if (settings.pollOnBoot) poke()

  ctx.logger?.info?.(`dsh-feed: active (${store.file})`)
  log.info('apply:done', {
    tools: 5,
    tickMs: settings.tickMs,
    pollOnBoot: settings.pollOnBoot,
    file: store.file,
  })

  const dispose = () => {
    disposed = true
    if (timer !== null) clearInterval(timer)
    try {
      unregisterTools()
    } catch {
      /* 注销失败不影响卸载 */
    }
    store.close()
    log.info('dispose')
  }

  activeDispose = dispose

  return () => {
    // 只有"当前活着的那个"才允许清空单例标记,
    // 否则一个过期的 disposer 会把新实例的标记抹掉。
    if (activeDispose === dispose) activeDispose = null
    dispose()
  }
}
