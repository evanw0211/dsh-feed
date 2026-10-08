/**
 * 回归探针:基线门(F2)+ schema v2 迁移。
 *
 * 背景(HANDOFF-review F2):`isFirstPoll` 原来用 `last_checked_at === null` 表示
 * 「第一次**成功**抓取」,但 `updateAfterPoll` 在任何 outcome 下都会写
 * `last_checked_at`。于是首次抓取只要失败一次(离线 / DNS 抖动 / 5xx / 429 / 超时 /
 * 超 maxBodyBytes),这个源就**永久**拿不到基线处理 —— 下一次成功抓取会把窗口内
 * 全部条目当新条目投进会话,正是 `splitBaseline` 声明要避免的「倒一年历史」。
 *
 * 审查实测(改前):首次成功 → pending=0;首次失败 → pending=20(全部历史入队)。
 *
 * 现在判据是显式的 `sources.bootstrapped` 列(schema v2),只在 `outcome === 'ok'`
 * 的轮次里 0 → 1。这里跑真 `apply()` + stub `globalThis.fetch`,把四条路径钉死:
 *   A 对照:首次成功 → 基线生效
 *   B 本例:首次失败、第二次成功 → 基线**仍然**生效(改前 pending=20)
 *   C 空 feed 不算失败:成功抓到空 feed 后,新条目照常投递
 *   D 200 + 垃圾内容(parse-error)同样不能吃掉基线门
 *
 * 跑法:node dev/baseline-gate-probe.mjs
 *
 * @module @local/dsh-feed/dev/baseline-gate-probe
 */

import { openStore } from '../lib/store.js'

const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')
const { DatabaseSync } = process.getBuiltinModule('node:sqlite')

let passed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

function equal(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, label, timeoutMs = 5000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(20)
  }
}

const ITEMS = Array.from({ length: 20 }, (_, index) =>
  `<item><title>old ${index}</title><link>https://feed.test/a/${index}</link>`
  + '<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description>body</description></item>').join('')

const rss = (items = ITEMS) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Probe</title>${items}</channel></rss>`
const EMPTY_FEED = rss('')
const NEW_ITEM = '<item><title>brand new</title><link>https://feed.test/new</link>'
  + '<pubDate>Mon, 01 Jan 2030 00:00:00 GMT</pubDate><description>body</description></item>'
const CAPTIVE_PORTAL = '<!DOCTYPE html><html><body>sign in to the wifi</body></html>'

const okResponse = (body) => () => new Response(body, {
  status: 200,
  headers: { 'content-type': 'application/rss+xml' },
})
const failResponse = () => { throw new Error('simulated network failure') }

/**
 * 跑一个场景:真 `apply()`,stub 掉 `globalThis.fetch` 按轮次给响应。
 *
 * 用真 apply 而不是单元测试,是因为缺陷在 `pollSource` 的编排里 ——
 * `isFirstPoll` 只是内联的一个判断,没有可以单独调的入口。
 */
async function runScenario(responses) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-gate-'))
  process.env.DSH_HOME = home

  const tools = new Map()
  const ctx = {
    logger: { info() {} },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    // 投递故意失败:条目留在 pending 里,断言才能看到「入队了什么」。
    get: (service) => (service === 'sessionController'
      ? { resolveAgent: async () => ({ error: { code: 'session/not-found' } }) }
      : undefined),
  }

  let calls = 0
  globalThis.fetch = async () => {
    const handler = responses[Math.min(calls, responses.length - 1)]
    calls += 1
    return handler()
  }

  const { apply } = await import('../index.js')
  const dispose = apply(ctx, { pollOnBoot: true, tickMs: 3_600_000, allowPrivateNetworks: true })

  const exec = { agent: { id: 'session-probe' } }
  const sub = await tools.get('feed_subscribe').execute({ url: 'https://feed.test/feed' }, exec)

  await waitFor(() => calls >= 1, 'the first fetch')
  await sleep(400)                                     // 第一轮写库完成
  await tools.get('feed_monitor').execute({ title: 'M', sources: [sub.source.id] }, exec)
  // 再订阅同一个 URL = 把 next_due_at 拉回现在,逼出第二轮抓取。
  await tools.get('feed_subscribe').execute({ url: 'https://feed.test/feed' }, exec)

  await waitFor(() => calls >= 2, 'the second fetch')
  await sleep(500)                                     // 第二轮写库 + 一次投递尝试
  dispose()
  await sleep(50)

  const db = new DatabaseSync(path.join(home, 'dsh-feed', 'dsh-feed.db'))
  const row = db.prepare('SELECT last_status, failures, bootstrapped, last_checked_at FROM sources').get()
  const seen = Number(db.prepare('SELECT COUNT(*) AS c FROM seen').get().c)
  const pending = Number(db.prepare('SELECT COUNT(*) AS c FROM pending').get().c)
  db.close()
  fs.rmSync(home, { recursive: true, force: true })

  return {
    calls,
    status: row.last_status,
    failures: Number(row.failures),
    bootstrapped: Number(row.bootstrapped),
    seen,
    pending,
  }
}

// ── A 对照:首次成功 ───────────────────────────────────────────────────────
{
  const result = await runScenario([okResponse(rss()), okResponse(rss())])
  equal('A 两次抓取都发生', result.calls, 2)
  equal('A 首次成功后标成已引导', result.bootstrapped, 1)
  equal('A 历史条目只记账', result.seen, 20)
  equal('A 基线门生效:pending = 0', result.pending, 0)
}

// ── B 本例:首次失败,第二次成功 ────────────────────────────────────────────
{
  const result = await runScenario([failResponse, okResponse(rss())])
  equal('B 两次抓取都发生', result.calls, 2)
  equal('B 失败轮次不置引导标志…', result.bootstrapped, 1)   // 第二次成功才置上
  equal('B …但历史条目仍然只记账', result.seen, 20)
  equal('B 基线门没被吃掉:pending = 0(改前是 20)', result.pending, 0)
}

// ── C 空 feed 是**成功**,不是失败 ──────────────────────────────────────────
{
  const result = await runScenario([okResponse(EMPTY_FEED), okResponse(rss(NEW_ITEM))])
  equal('C 空 feed 也算成功抓取', result.bootstrapped, 1)
  equal('C 空 feed 没有条目', result.status, 'ok')
  equal('C 之后的新条目照常投递', result.pending, 1)
  equal('C 只有这一条进了 seen', result.seen, 1)
}

// ── D 200 + 垃圾内容(parse-error)同样不能吃掉基线门 ────────────────────────
{
  const result = await runScenario([okResponse(CAPTIVE_PORTAL), okResponse(rss())])
  equal('D 垃圾内容记为 parse-error', result.status, 'ok')     // 第二轮成功已重置
  equal('D 第二轮成功后才标成已引导', result.bootstrapped, 1)
  equal('D 基线门同样生效:pending = 0', result.pending, 0)
  equal('D 历史条目仍然只记账', result.seen, 20)
}

// ── schema v2 迁移:已有库升级后不能被重判成「首抓」 ────────────────────────
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-migrate-'))
  const dir = path.join(home, 'dsh-feed')
  fs.mkdirSync(dir, { recursive: true })
  const silent = { info() {}, warn() {}, error() {}, file: '' }
  const now = Date.now()

  let store = openStore({ dir, log: silent })
  const version = () => Number(store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value)

  equal('迁移:新库直接是 v2', version(), 2)
  store.sources.insert({
    id: 'src_done', url: 'https://migrate.test/1', title: 'A', intervalSec: 1800,
    minInterval: 900, maxInterval: 86400, nextDueAt: now, createdAt: now, updatedAt: now,
    lastCheckedAt: now,
  })
  store.sources.insert({
    id: 'src_fresh', url: 'https://migrate.test/2', title: 'B', intervalSec: 1800,
    minInterval: 900, maxInterval: 86400, nextDueAt: now, createdAt: now, updatedAt: now,
  })
  equal('迁移:新源默认未引导', Number(store.sources.byId('src_fresh').bootstrapped), 0)

  // 把库伪装成 v1:去掉 v2 加的列,并把版本退回去。
  store.db.exec('ALTER TABLE sources DROP COLUMN bootstrapped')
  store.db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run()
  store.close()

  store = openStore({ dir, log: silent })
  equal('迁移:v1 库升级到 v2', version(), 2)
  equal('迁移:回填 —— 成功抓过的源标成已引导', Number(store.sources.byId('src_done').bootstrapped), 1)
  equal('迁移:回填 —— 从未成功过的源保持未引导', Number(store.sources.byId('src_fresh').bootstrapped), 0)
  store.close()
  fs.rmSync(home, { recursive: true, force: true })
}

// ── 结果 ───────────────────────────────────────────────────────────────────
console.log(`\npassed: ${passed}`)
if (failures.length === 0) {
  console.log('all checks passed')
} else {
  console.log(`failed: ${failures.length}`)
  for (const failure of failures) console.log(`  x ${failure}`)
}
process.exitCode = failures.length === 0 ? 0 : 1
