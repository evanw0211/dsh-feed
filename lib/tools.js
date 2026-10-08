/**
 * 面向模型的 5 个工具。
 *
 * 设计取舍:
 *   - **5 个而不是更多**:每多一个 schema 都是固定前缀 token。
 *     `feed_update` 并进 `feed_subscribe`(按 url upsert);`feed_poll_now` 留到 M2。
 *   - 订阅时**自动建一个 1:1 的默认 monitor**,所以只想「订一个源」的用户
 *     不会接触到 monitor 这个概念。
 *   - 所有工具绑定到**调用方会话**(`exec.agent.id`),与 `schedule` 同形。
 *
 * @module @local/dsh-feed/lib/tools
 */

import { matchItem } from './deliver.js'

const MAX_TITLE = 120
const MAX_ITEMS_CAP = 200

/** 生成一个短 id。 */
function makeId(prefix) {
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  return `${prefix}_${hex}`
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asText(value, limit = MAX_TITLE) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
}

function boundedInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number.parseInt(value, 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** 校验一个 http(s) URL。 */
function validUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 按 id 或 url 找一个源。 */
function findSource(store, reference) {
  if (typeof reference !== 'string' || reference.trim() === '') return undefined
  const needle = reference.trim()
  return store.sources.byId(needle) ?? store.sources.byUrl(needle)
}

/** 调用方会话 id。 */
function callerSession(exec) {
  const id = exec?.agent?.id
  return typeof id === 'string' && id !== '' ? id : null
}

const SOURCE_VIEW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    title: { type: 'string' },
    enabled: { type: 'boolean' },
    interval_seconds: { type: 'integer' },
    /**
     * 这个源自己的自适应边界(源级,优先于部署配置)。
     *
     * 必须暴露出来:它们在 `feed_subscribe` 里可设、也确实生效,但 `feed_list`
     * 不显示的话,用户无法察觉自己设的值有没有被采用(F5 的另一半)。
     */
    min_interval_seconds: { type: 'integer' },
    max_interval_seconds: { type: 'integer' },
    next_due_at: { type: 'integer' },
    last_status: { type: 'string' },
    last_error: { type: 'string' },
    window_size: { type: 'integer' },
    mean_gap_seconds: { type: 'integer' },
    seen_keys: { type: 'integer' },
    conditional_hits: { type: 'integer' },
    conditional_misses: { type: 'integer' },
    failures: { type: 'integer' },
    /**
     * 盯着这个源的 monitor(含已停用的)。
     *
     * 为什么源这边要暴露它:订阅与 monitor 是**分开**的两件事,所以「订了一个源
     * 却什么都没收到」是一个正常的、可预期的状态。没有这个字段,`feed_list` 里
     * 根本看不出一个源有没有人盯 —— 用户只会以为插件坏了。
     */
    monitors: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'url', 'title', 'enabled', 'interval_seconds', 'min_interval_seconds', 'max_interval_seconds', 'next_due_at', 'last_status', 'failures', 'monitors'],
}

const MONITOR_VIEW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    enabled: { type: 'boolean' },
    sources: { type: 'array', items: { type: 'string' } },
    match: { type: 'object', additionalProperties: true },
    quiet_minutes: { type: 'integer' },
    max_items: { type: 'integer' },
    target_session: { type: 'string' },
    delivered_seq: { type: 'integer' },
    pending: { type: 'integer' },
  },
  required: ['id', 'title', 'enabled', 'sources', 'pending'],
}

const ITEM_VIEW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seq: { type: 'integer' },
    key: { type: 'string' },
    source_id: { type: 'string' },
    title: { type: 'string' },
    link: { type: 'string' },
    published_at: { type: 'string' },
    untrusted_summary: { type: 'string' },
  },
  required: ['seq', 'key', 'source_id', 'title'],
}

/** 把源行转成模型看的视图。 */
function sourceView(row, store) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    enabled: row.enabled === 1,
    interval_seconds: Number(row.interval_sec),
    // 源级边界:nextCadence 用的就是这两个值(缺失才回退部署配置)。
    min_interval_seconds: Number(row.min_interval),
    max_interval_seconds: Number(row.max_interval),
    next_due_at: Number(row.next_due_at),
    last_status: row.last_status ?? '',
    last_error: row.last_error ?? '',
    window_size: row.window_size === null ? 0 : Number(row.window_size),
    mean_gap_seconds: row.mean_gap_ms === null ? 0 : Math.round(Number(row.mean_gap_ms) / 1000),
    // 这两个原来一个是写死的 0(假信息),一个根本不存在。既然
    // 「订了源但没人盯」现在是一个合法状态,就必须如实报出来。
    seen_keys: store.seen.countOf(row.id),
    conditional_hits: Number(row.cond_hits),
    conditional_misses: Number(row.cond_misses),
    failures: Number(row.failures),
    monitors: monitorsOfSource(store, row.id),
  }
}

function monitorView(row, sources, pendingCount) {
  let target = {}
  try {
    target = JSON.parse(row.target_json)
  } catch {
    target = {}
  }
  let match = {}
  try {
    match = JSON.parse(row.match_json)
  } catch {
    match = {}
  }
  return {
    id: row.id,
    title: row.title,
    enabled: row.enabled === 1,
    sources,
    match,
    quiet_minutes: Number(row.quiet_minutes),
    max_items: Number(row.max_items),
    target_session: typeof target.sessionId === 'string' ? target.sessionId : '',
    delivered_seq: Number(row.delivered_seq),
    pending: pendingCount,
  }
}

/** 列出某个 monitor 关联的源 id。 */
function sourcesOfMonitor(store, monitorId) {
  return store.db
    .prepare('SELECT source_id FROM monitor_sources WHERE monitor_id = ? ORDER BY source_id')
    .all(monitorId)
    .map((row) => row.source_id)
}

/**
 * 列出盯着某个源的 monitor id(**含已停用的**)。
 *
 * 与 `store.monitors.forSource` 的区别:那个只取 `enabled = 1`,是投递路径要的;
 * 这里是「谁在盯着我」的可见性,停用的也必须列出来 —— 否则用户会看到一个
 * 「没人盯」的源,而实际上只是 monitor 被暂停了。
 */
function monitorsOfSource(store, sourceId) {
  return store.db
    .prepare('SELECT monitor_id FROM monitor_sources WHERE source_id = ? ORDER BY monitor_id')
    .all(sourceId)
    .map((row) => row.monitor_id)
}

/**
 * 注册全部工具。
 *
 * @param ctx - 插件上下文
 * @param runtime - `{ store, config, log, poke }`
 */
export function registerTools(ctx, runtime) {
  const { store, config, log } = runtime

  const disposers = []

  // ── feed_subscribe ──────────────────────────────────────────────────────
  disposers.push(ctx.tools.register({
    name: 'feed_subscribe',
    description: 'Subscribe to an RSS/Atom/JSON feed, or update an existing subscription with the same URL. Manages the SOURCE only: it is polled on an adaptive schedule, but nothing is ever delivered until you attach the source to a monitor with feed_monitor. Returns the source; its `monitors` field lists what (if anything) currently watches it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Feed URL. Must be http or https.' },
        title: { type: 'string', description: 'Display name. Defaults to the feed channel title once fetched, or the URL.' },
        interval_seconds: {
          type: 'integer',
          description: `Starting poll interval in seconds. Defaults to ${config.defaultIntervalSeconds}. The adaptive controller moves it within the min/max bounds.`,
        },
        min_interval_seconds: { type: 'integer', description: `Floor for this source's adaptive interval. Defaults to ${config.minIntervalSeconds}. It is a hard floor: no delay source (Cache-Control, Expires, <ttl>, mean gap) can push the interval below it.` },
        max_interval_seconds: { type: 'integer', description: `Hard ceiling for this source's adaptive interval. Defaults to ${config.maxIntervalSeconds}. The final clamp is always applied, so the effective interval never exceeds this value (the only exception is Retry-After, where the server's own backoff wins).` },
      },
      required: ['url'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: SOURCE_VIEW,
          created: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['source', 'created', 'note'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.created ? 'Subscribed to' : 'Updated'} ${value.source.url}\n`
          + `source id: ${value.source.id}\n`
          + `interval: ${value.source.interval_seconds}s\n`
          // 订阅不再顺手建 monitor。所以要明确说出「现在什么都没被投递」这件事,
          // 而不是替用户决定 —— 沉默的源会让用户以为插件坏了。
          + (value.source.monitors.length === 0
            ? 'No monitor watches this source yet: it will be polled, but nothing will be delivered. Use feed_monitor with this source id (or URL) to attach it.\n'
            : `watched by ${value.source.monitors.length} monitor(s): ${value.source.monitors.join(', ')}\n`)
          + (value.note === '' ? '' : `${value.note}\n`)
          + 'The first fetch happens on the next tick.',
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const record = isRecord(args) ? args : {}
      const url = asText(record.url, 2048)
      if (!validUrl(url)) throw new Error('url must be an absolute http(s) URL')

      // 订阅**不再**要求会话:源是全局的,投给谁由 monitor 决定。
      // 这里只在有会话可记时留个面包屑。
      const sessionId = callerSession(exec)

      const now = Date.now()
      const minInterval = boundedInt(record.min_interval_seconds, config.minIntervalSeconds, 60, config.maxIntervalSeconds)
      const maxInterval = boundedInt(record.max_interval_seconds, config.maxIntervalSeconds, minInterval, 30 * 86400)
      const interval = boundedInt(record.interval_seconds, config.defaultIntervalSeconds, minInterval, maxInterval)

      const existing = store.sources.byUrl(url)
      const id = existing?.id ?? makeId('src')
      const title = asText(record.title) || existing?.title || url

      store.tx(() => {
        if (existing === undefined) {
          store.sources.insert({
            id,
            url,
            title,
            intervalSec: interval,
            minInterval,
            maxInterval,
            nextDueAt: now,
            createdAt: now,
            updatedAt: now,
            lastStatus: 'pending',
          })
        } else {
          store.db.prepare(`
            UPDATE sources SET title = ?, interval_sec = ?, min_interval = ?, max_interval = ?,
              enabled = 1, next_due_at = ?, updated_at = ? WHERE id = ?
          `).run(title, interval, minInterval, maxInterval, now, now, id)
        }
      })

      // 这里**不再**顺手建 monitor。
      //
      // 原来会建一个 1:1 的默认 monitor(match 全收),理由是「只想订一个源的用户
      // 不必接触 monitor 这个概念」。代价是订阅与投递被绑成一个动作:
      //   - 想让已有 monitor 顺带盯一个新源时,会多出一个全收 monitor,
      //     于是同一个源的条目被投递两遍(两个 monitor 各一条 entry);
      //   - 想「只订源、不投递」(先观察一阵)就完全做不到。
      // 加个 `monitor: false` 开关只是把决定推给调用方,并没有解开这个绑定。
      // 两端拆开之后,「源会被抓、但没人投递」是一个合法且可见的状态。
      const note = existing === undefined
        ? ''
        : 'This URL was already subscribed; its settings were updated in place.'
      log.info('feed_subscribe', { sourceId: id, url, sessionId, created: existing === undefined })
      runtime.poke()

      return {
        source: sourceView(store.sources.byId(id), store),
        created: existing === undefined,
        note,
      }
    },
  }))

  // ── feed_unsubscribe ────────────────────────────────────────────────────
  disposers.push(ctx.tools.register({
    name: 'feed_unsubscribe',
    description: 'Remove a feed subscription. Only the SOURCE is removed: monitors that watched it are left untouched and simply lose that source, keeping any others they had. The reply lists monitors that are now left with no sources (and therefore deliver nothing); remove those with feed_monitor delete: true if you want them gone.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', description: 'Source id or feed URL.' },
      },
      required: ['source'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'boolean' },
          source_id: { type: 'string' },
          orphaned_monitors: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['removed', 'source_id', 'orphaned_monitors', 'note'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed
          ? `Removed ${value.source_id}.`
            // 只报告,不删除:monitor 装的是用户写的规则(match/上限/节流),
            // 删源顺手把它删掉是销毁配置,而且不可逆 —— 用户可能只是打算之后
            // 重新订这个源,或者把 monitor 指到别的源上。
            + (value.orphaned_monitors.length === 0
              ? ''
              : ` ${value.orphaned_monitors.length} monitor(s) are now left with no sources and will not deliver anything: `
                + `${value.orphaned_monitors.join(', ')}. Attach another source with feed_monitor, or remove them with feed_monitor delete: true.`)
          : value.note,
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const record = isRecord(args) ? args : {}
      const row = findSource(store, record.source)
      if (row === undefined) {
        return { removed: false, source_id: '', orphaned_monitors: [], note: 'No subscription matches that id or URL.' }
      }

      const affected = monitorsOfSource(store, row.id)

      const orphaned = []
      store.tx(() => {
        store.monitors.unlinkSource(row.id)
        // 这里只记账,不删 monitor。删源是源的事,monitor 的去留由用户决定。
        for (const monitorId of affected) {
          if (sourcesOfMonitor(store, monitorId).length === 0) orphaned.push(monitorId)
        }
        store.db.prepare('DELETE FROM seen WHERE source_id = ?').run(row.id)
        store.sources.remove(row.id)
      })

      log.info('feed_unsubscribe', { sourceId: row.id, orphaned })
      return { removed: true, source_id: row.id, orphaned_monitors: orphaned, note: '' }
    },
  }))

  // ── feed_monitor ────────────────────────────────────────────────────────
  disposers.push(ctx.tools.register({
    name: 'feed_monitor',
    description: 'Create, update or delete a monitor: a rule that decides which new items from one or more subscriptions are worth waking this session for. A subscription with no monitor still polls but never delivers. Omitted fields keep their stored value; set enabled: false to pause, or delete: true (with id) to remove it for good.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Existing monitor id to update. Omit to create a new one.' },
        title: { type: 'string', description: `Short name shown in deliveries and feed_list. At most ${MAX_TITLE} characters.` },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Source ids or feed URLs this monitor watches. Replaces the whole set.',
        },
        match: {
          type: 'object',
          additionalProperties: false,
          properties: {
            any: { type: 'array', items: { type: 'string' }, description: 'Keep items containing at least one of these.' },
            all: { type: 'array', items: { type: 'string' }, description: 'Keep only items containing every one of these.' },
            exclude: { type: 'array', items: { type: 'string' }, description: 'Drop items containing any of these.' },
            regex: { type: 'string', description: 'Additional case-insensitive regular expression applied to title + summary.' },
          },
        },
        quiet_minutes: { type: 'integer', description: 'Minimum minutes between deliveries from this monitor. Use for digests rather than per-item alerts.' },
        max_items: { type: 'integer', description: `Most items in one delivery. Defaults to ${config.defaultMaxItems}.` },
        enabled: { type: 'boolean', description: 'Defaults to true on create. Pausing keeps the rules and the undelivered items.' },
        delete: {
          type: 'boolean',
          description: 'Delete this monitor instead of creating or updating one. Requires id. Its rules, its source links and its undelivered items are all removed. Sources it watched are untouched.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          monitor: MONITOR_VIEW,
          deleted: { type: 'boolean' },
          deleted_id: { type: 'string' },
          created: { type: 'boolean' },
          unresolved: { type: 'array', items: { type: 'string' } },
        },
        required: ['deleted', 'deleted_id', 'created', 'unresolved'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.deleted
          ? `Deleted monitor ${value.deleted_id}. Its sources are untouched.`
          : `${value.created ? 'Created' : 'Updated'} monitor ${value.monitor.id} "${value.monitor.title}"\n`
            + `watching ${value.monitor.sources.length} source(s): ${value.monitor.sources.join(', ') || '(none)'}\n`
            + `match: ${JSON.stringify(value.monitor.match)}\n`
            + (value.unresolved.length === 0 ? '' : `Unresolved source references: ${value.unresolved.join(', ')}\n`)
            + (value.monitor.sources.length === 0
              ? 'This monitor has no sources, so it will not deliver anything. Add some with the sources parameter.\n'
              : ''),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const record = isRecord(args) ? args : {}

      // 删 monitor 是唯一一个**不需要会话**的分支:规则是全局配置,
      // 而删除常常正是在「会话没了/换了」之后才要做的清理。
      if (record.delete === true) {
        const id = typeof record.id === 'string' ? record.id.trim() : ''
        if (id === '') throw new Error('feed_monitor requires id when delete is true')
        const target = store.monitors.byId(id)
        if (target === undefined) throw new Error(`no monitor with id ${id}`)
        // `monitors.remove` 内部是三条独立语句(关联 / pending / 主行),**不自带事务** ——
        // 旧的级联删除是在 `store.tx()` 里调它的。这里必须同样包起来,
        // 否则中途失败会留下「关联没了但 monitor 还在」的半删状态。
        store.tx(() => store.monitors.remove(target.id))
        log.info('feed_monitor', { monitorId: target.id, deleted: true })
        return { deleted: true, deleted_id: target.id, created: false, unresolved: [] }
      }

      const sessionId = callerSession(exec)
      if (sessionId === null) throw new Error('feed_monitor requires an agent session')

      const now = Date.now()
      const existing = typeof record.id === 'string' ? store.monitors.byId(record.id.trim()) : undefined
      if (typeof record.id === 'string' && record.id.trim() !== '' && existing === undefined) {
        throw new Error(`no monitor with id ${record.id}`)
      }

      const unresolved = []
      let sourceIds
      if (Array.isArray(record.sources)) {
        sourceIds = []
        for (const reference of asStringArray(record.sources)) {
          const row = findSource(store, reference)
          if (row === undefined) unresolved.push(reference)
          else sourceIds.push(row.id)
        }
      } else {
        sourceIds = existing === undefined ? [] : sourcesOfMonitor(store, existing.id)
      }

      const storedMatch = existing === undefined ? {} : JSON.parse(existing.match_json)
      const match = isRecord(record.match)
        ? {
            any: asStringArray(record.match.any),
            all: asStringArray(record.match.all),
            exclude: asStringArray(record.match.exclude),
            regex: asText(record.match.regex, 500),
          }
        : storedMatch

      const title = asText(record.title) || existing?.title || 'Feed monitor'
      const id = existing?.id ?? makeId('mon')

      store.monitors.upsert({
        id,
        title,
        enabled: typeof record.enabled === 'boolean' ? record.enabled : existing === undefined ? true : existing.enabled === 1,
        match,
        quietMinutes: boundedInt(record.quiet_minutes, existing === undefined ? 0 : Number(existing.quiet_minutes), 0, 10080),
        maxItems: boundedInt(record.max_items, existing === undefined ? config.defaultMaxItems : Number(existing.max_items), 1, MAX_ITEMS_CAP),
        target: { kind: 'session', sessionId },
        sources: sourceIds,
        createdAt: existing === undefined ? now : Number(existing.created_at),
        updatedAt: now,
      })

      log.info('feed_monitor', { monitorId: id, sources: sourceIds.length, created: existing === undefined })
      return {
        monitor: monitorView(store.monitors.byId(id), sourceIds, store.pending.list(id, 1).length),
        deleted: false,
        deleted_id: '',
        created: existing === undefined,
        unresolved,
      }
    },
  }))

  // ── feed_list ───────────────────────────────────────────────────────────
  disposers.push(ctx.tools.register({
    name: 'feed_list',
    description: 'List feed subscriptions and monitors with their poll interval, next due time, last result, and undelivered item count.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sources: { type: 'array', items: SOURCE_VIEW },
          monitors: { type: 'array', items: MONITOR_VIEW },
          undelivered: { type: 'integer' },
        },
        required: ['sources', 'monitors', 'undelivered'],
      },
      render: (_args, value) => {
        const lines = []
        lines.push(`Subscriptions: ${value.sources.length}`)
        for (const source of value.sources) {
          const gap = source.mean_gap_seconds > 0 ? `, ~${Math.round(source.mean_gap_seconds / 60)}min between items` : ''
          const problem = source.last_error === '' ? '' : `, last error: ${source.last_error}`
          // 「订了源但没人盯」是解耦之后的正常状态,但它必须**看得见**,
          // 否则表现得就像插件坏了:源在抓,却永远不投递。
          const watching = source.monitors.length === 0
            ? '  [no monitor watching: polled but never delivered]'
            : `  [watched by ${source.monitors.join(', ')}]`
          lines.push(`- ${source.id}  ${source.url}${watching}`)
          // 边界也报出来:源级 min/max 是**生效**的(F5),不显示就无从核对。
          lines.push(`    every ${source.interval_seconds}s (bounds ${source.min_interval_seconds}-${source.max_interval_seconds}s)${gap}; ${source.last_status || 'never polled'}${problem}`)
        }
        lines.push('', `Monitors: ${value.monitors.length}`)
        for (const monitor of value.monitors) {
          lines.push(`- ${monitor.id}  "${monitor.title}"${monitor.enabled ? '' : ' (paused)'}`)
          lines.push(`    sources: ${monitor.sources.join(', ') || '(none)'}; undelivered: ${monitor.pending}`)
        }
        lines.push('', `Undelivered items total: ${value.undelivered}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      const counts = store.pending.counts()
      const sources = store.sources.list().map((row) => sourceView(row, store))
      const monitors = store.monitors.list().map((row) =>
        monitorView(row, sourcesOfMonitor(store, row.id), counts.get(row.id) ?? 0))
      return { sources, monitors, undelivered: store.pending.total() }
    },
  }))

  // ── feed_read ───────────────────────────────────────────────────────────
  disposers.push(ctx.tools.register({
    name: 'feed_read',
    description: 'Read undelivered items without waiting for the next delivery. Use after a FEED UPDATE to fetch the rest, or to inspect a monitor on demand. Returns items oldest first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        monitor_id: { type: 'string', description: 'Monitor to read. Defaults to every monitor bound to this session.' },
        limit: { type: 'integer', description: `Items per monitor. Defaults to ${config.defaultMaxItems}, maximum ${MAX_ITEMS_CAP}.` },
        ack: { type: 'boolean', description: 'Drop the returned items instead of leaving them queued for the next delivery.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', items: ITEM_VIEW },
          remaining: { type: 'integer' },
          acknowledged: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['items', 'remaining', 'acknowledged', 'note'],
      },
      render: (_args, value) => {
        const lines = [`Undelivered items: ${value.items.length}`]
        for (const item of value.items) {
          lines.push(`- [${item.source_id}] ${item.title}`)
          if (item.link !== '') lines.push(`    ${item.link}`)
          if (item.untrusted_summary !== '') {
            lines.push(`    ${item.untrusted_summary.slice(0, 400)}`)
          }
        }
        if (value.note !== '') lines.push('', value.note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const record = isRecord(args) ? args : {}
      const sessionId = callerSession(exec)
      const limit = boundedInt(record.limit, config.defaultMaxItems, 1, MAX_ITEMS_CAP)

      let monitorIds
      if (typeof record.monitor_id === 'string' && record.monitor_id.trim() !== '') {
        const row = store.monitors.byId(record.monitor_id.trim())
        if (row === undefined) {
          return { items: [], remaining: 0, acknowledged: false, note: `No monitor with id ${record.monitor_id}.` }
        }
        monitorIds = [row.id]
      } else {
        monitorIds = store.monitors.list()
          .filter((row) => JSON.parse(row.target_json).sessionId === sessionId)
          .map((row) => row.id)
      }

      const collected = []
      for (const monitorId of monitorIds) {
        const rows = store.pending.list(monitorId, limit)
        for (const row of rows) {
          collected.push({
            seq: Number(row.seq),
            key: row.item_key,
            source_id: row.source_id,
            title: row.title,
            link: row.link ?? '',
            published_at: row.published ?? '',
            untrusted_summary: row.summary ?? '',
          })
        }
      }
      collected.sort((left, right) => left.seq - right.seq)

      const acknowledged = record.ack === true
      if (acknowledged) {
        store.tx(() => {
          for (const monitorId of monitorIds) {
            const rows = store.pending.list(monitorId, limit)
            store.pending.remove(monitorId, rows.map((row) => Number(row.seq)))
            if (rows.length > 0) {
              store.monitors.markDelivered(monitorId, Math.max(...rows.map((row) => Number(row.seq))), Date.now())
            }
          }
        })
      }

      const remaining = monitorIds.reduce((sum, id) => sum + store.pending.list(id, MAX_ITEMS_CAP).length, 0)
      return {
        items: collected,
        remaining,
        acknowledged,
        note: acknowledged ? 'Items were dropped from the queue.' : 'Items remain queued and may still be delivered.',
      }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 注销失败不影响卸载 */
      }
    }
  }
}

export { matchItem }
