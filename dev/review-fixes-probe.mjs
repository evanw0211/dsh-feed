/**
 * 回归探针:HANDOFF-review.md 里 F1 / F3 / F4 / F5 的修复。
 *
 * 为什么单独一个文件,而不是加进已有的套件:
 *   - `dev/ported-miniflux.test.mjs` 是**冻结**的(改前请比对文件头的 SHA256),
 *     所以 F1 的验收向量不能加进它的第 4 节;
 *   - `smoke.mjs` / `tools-probe.mjs` 的项数(79 / 45)是上一轮交接记录的回归基线,
 *     不搅动它们更容易看出「本轮改动有没有碰坏既有行为」。
 *
 * 覆盖:
 *   F1  私网预检被 IPv4-mapped IPv6 **十六进制**字面量绕过(`::ffff:7f00:1` 等)
 *   F3  畸形 `<description>` / `<item>` / `<!--` 让解析退化成 O(n²)、冻结主线程
 *   F4  重定向 / 限流 / 错误分支读响应体没有字节上限
 *   F5  源级 `min_interval` / `max_interval` 存了却从不生效,也不可见
 *
 * 跑法(普通 node 即可,本机 v24.19.0 自带 node:sqlite):
 *   node dev/review-fixes-probe.mjs
 *
 * @module @local/dsh-feed/dev/review-fixes-probe
 */

import http from 'node:http'
import { fetchFeed, isPrivateAddress, nextCadence } from '../lib/feed.js'
import { parseFeed, stripHtml } from '../lib/parse.js'
import { openStore } from '../lib/store.js'
import { registerTools } from '../lib/tools.js'

const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')

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

/** 起一个本地 HTTP 服务,`routes` 是路径 → 处理函数。 */
async function withServer(routes, run) {
  const server = http.createServer((req, res) => {
    const handler = routes[req.url]
    if (handler === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await run(base)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
}

/** 推一个永远不结束的 body(客户端必须自己决定什么时候停)。 */
function streamForever(res, chunkSize = 64 * 1024) {
  const chunk = Buffer.alloc(chunkSize, 0x61)
  let stopped = false
  const stop = () => { stopped = true }
  res.on('close', stop)
  res.on('error', stop)
  const pump = () => {
    while (!stopped && !res.destroyed) {
      if (!res.write(chunk)) {
        res.once('drain', pump)
        return
      }
    }
  }
  pump()
}

/** 推一个有限但很大的 body。 */
function streamBig(res, megabytes, chunkSize = 1024 * 1024) {
  const chunk = Buffer.alloc(chunkSize, 0x61)
  let sent = 0
  const pump = () => {
    while (sent < megabytes) {
      sent += 1
      if (!res.write(chunk)) {
        res.once('drain', pump)
        return
      }
    }
    res.end()
  }
  pump()
}

const BUDGET_MS = 5000
/**
 * `stripHtml` 的单项预算。
 *
 * 它自己按 64KB 截断,所以改前那三种退化输入在这里最多只会慢到「64KB 的二次方」
 * 而不是「879KB 的二次方」。改前实测:`<script>` 200KB 要 853ms、
 * `<!--` 100KB 要 5830ms;改后 0–2ms。500ms 留了 200 倍余量,同时仍能抓住
 * 「退回惰性正则」的回归。
 */
const STRIP_BUDGET_MS = 500

/** 同步跑一段代码,断言它在预算内返回。 */
function withinBudget(label, fn, budget = BUDGET_MS) {
  const started = Date.now()
  const value = fn()
  const ms = Date.now() - started
  check(`${label} 在 ${budget}ms 预算内返回(实测 ${ms}ms)`, ms <= budget, `took ${ms}ms`)
  return value
}

// ── F1 私网预检:判定必须建在规范化之后的字节上 ──────────────────────────────
{
  // 十六进制写法、IPv4-compatible、NAT64、组播 —— 都是原来漏掉的。
  const privateV6 = [
    '::ffff:127.0.0.1',            // 原来唯一认得的写法
    '::ffff:7f00:1',               // 同一个地址的十六进制写法(审查实测可绕过)
    '0:0:0:0:0:ffff:127.0.0.1',    // 完全展开
    '::FFFF:7F00:1',               // 大小写
    '::7f00:1',                    // IPv4-compatible ::/96
    '::ffff:0:0',
    '64:ff9b::7f00:1',             // NAT64 64:ff9b::/96
    '64:ff9b:1::7f00:1',           // 本地 NAT64 64:ff9b:1::/48
    'ff02::1',                     // 组播 ff00::/8(v6 侧原来没有对应项)
    'ff00::1',
    'fe80::1',
    'fc00::1',
    '::1',
    '::',
  ]
  for (const address of privateV6) {
    equal(`F1 私网 v6:${address}`, isPrivateAddress(address), true)
  }

  // 别矫枉过正:公网 v6 必须仍然放行。
  const publicV6 = [
    '2606:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450:4001:80e::200e',
    '64:ff9b::808:808',            // NAT64 包的是公网 v4
  ]
  for (const address of publicV6) {
    equal(`F1 公网 v6 仍然放行:${address}`, isPrivateAddress(address), false)
  }
  equal('F1 公网 v4 仍然放行', isPrivateAddress('8.8.8.8'), false)
  equal('F1 私网 v4 仍然拒绝', isPrivateAddress('10.1.2.3'), true)

  // fetchFeed 级别:绕过点在 URL 里,必须整条路径都拒。
  await withServer({
    '/feed': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end('<rss version="2.0"><channel><title>secret internal</title></channel></rss>')
    },
  }, async (base) => {
    const port = new URL(base).port
    const hosts = ['127.0.0.1', 'localhost', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:127.0.0.1]']
    for (const host of hosts) {
      const r = await fetchFeed(`http://${host}:${port}/feed`, { allowPrivateNetworks: false, timeoutMs: 5000 })
      equal(`F1 fetchFeed 拒绝 ${host}`, r.outcome, 'error')
      const reason = String(r.error)
      check(
        `F1 拒绝原因说明是私网/环回 ${host}`,
        reason.includes('private address') || reason.includes('loopback'),
        reason,
      )
    }
    // 防护是可关的,不是把功能锁死。
    const allowed = await fetchFeed(`${base}/feed`, { allowPrivateNetworks: true, timeoutMs: 5000 })
    equal('F1 显式放行私网仍然可用', allowed.outcome, 'ok')
    equal('F1 放行时真的取到了内网响应体', allowed.text.includes('secret internal'), true)
  })
}

// ── F3 畸形输入不得退化成 O(n²) ─────────────────────────────────────────────
{
  // 审查实测(改前):`<script>` 879KB → 39.7s,`<style>` 879KB → 95.6s,
  // `<!--` 879KB → >7 分钟。这里用 200KB 量级,预算 5s(改后应在几十毫秒)。
  const scriptOnly = withinBudget('F3 stripHtml 50k 个 <script>', () => stripHtml('<script>'.repeat(50_000)), STRIP_BUDGET_MS)
  equal('F3 无闭合的 <script> 不吐内容', scriptOnly, '')

  const styleOnly = withinBudget('F3 stripHtml 50k 个 <style>', () => stripHtml('<style>'.repeat(50_000)), STRIP_BUDGET_MS)
  equal('F3 无闭合的 <style> 不吐内容', styleOnly, '')

  const commentsOnly = withinBudget('F3 stripHtml 50k 个 <!--', () => stripHtml('<!--'.repeat(50_000)), STRIP_BUDGET_MS)
  // 没有 `-->` 就不算注释(与原来的惰性正则一致),但不能因此卡住。
  check('F3 无闭合的 <!-- 只是被原样留下', commentsOnly.length <= 64 * 1024, `got ${commentsOnly.length}`)

  // 审查给的原始向量:0.89MB 的恶意 description。
  const maliciousDescription = '<script>'.repeat(116_000)
  const xml = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>a</title>'
    + `<link>https://x/y</link><description>${maliciousDescription}</description></item></channel></rss>`
  const parsed = withinBudget('F3 parseFeed 0.89MB 恶意 description', () => parseFeed(xml))
  equal('F3 恶意 description 仍解析出条目', parsed.items.length, 1)
  check(
    'F3 摘要不超过 excerptChars',
    parsed.items[0].summary.length <= 1201,
    `got ${parsed.items[0].summary.length}`,
  )

  // blocksOf / tagText 是同一类二次方退化(审查没测,本轮实测:200KB 全 `<item>` 要 4.9s,
  // 1MB 线性放大到约 2 分钟 —— 而 maxBodyBytes 就是 1MB)。
  const itemsOnly = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>'
    + '<item>'.repeat(Math.floor((1024 * 1024) / 6)) + '</channel></rss>'
  const itemsParsed = withinBudget('F3 parseFeed 1MB 全是 <item> 开始标签', () => parseFeed(itemsOnly))
  equal('F3 无闭合的 <item> 不产生条目', itemsParsed.items.length, 0)

  const descriptionsOnly = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>a</title>'
    + '<description>'.repeat(Math.floor((1024 * 1024) / 13)) + '</item></channel></rss>'
  withinBudget('F3 parseFeed 1MB 全是 <description> 开始标签', () => parseFeed(descriptionsOnly))

  // 正常输入不能被改坏(既有套件覆盖更全,这里钉最小的两条)。
  equal('F3 正常 HTML 仍然净化', stripHtml('<p>a</p><script>evil()</script><p>b</p>'), 'a b')
  equal('F3 正常注释仍然删掉', stripHtml('a<!-- hidden -->b'), 'a b')
}

// ── F4 非 200 分支读 body 必须有字节上限 ────────────────────────────────────
{
  // 审查实测(改前):302 + 32MB body → RSS +43.7MB,而 200 路径有 maxBytes 兜底。
  // 这里用一个**永远不结束**的 body:旧代码会在 arrayBuffer() 上一直读到 15s 超时,
  // 新代码读满 64KB 就 cancel —— 所以「是否在预算内返回」就是确定性判据。
  await withServer({
    '/forever-302': (_req, res) => {
      res.writeHead(302, { location: '/small' })
      streamForever(res)
    },
    '/forever-429': (_req, res) => {
      res.writeHead(429, { 'retry-after': '120' })
      streamForever(res)
    },
    '/forever-500': (_req, res) => {
      res.writeHead(500)
      streamForever(res)
    },
    '/big-302': (_req, res) => {
      res.writeHead(302, { location: '/small' })
      streamBig(res, 32)
    },
    // 只发一个字节就挂住:走的是整条链共用的 15s 超时,而不是「读满上限就取消」。
    // 旧代码在这里会从 AbortController 的定时器里抛出未捕获的 DOMException,
    // **直接把 Host 主进程打死**(实测 `--unhandled-rejections=warn` 也拦不住)。
    '/stall-302': (_req, res) => {
      res.writeHead(302, { location: '/small' })
      res.write('x')
    },
    '/stall-200': (_req, res) => {
      res.writeHead(200)
      res.write('x')
    },
    '/stall-429': (_req, res) => {
      res.writeHead(429, { 'retry-after': '60' })
      res.write('x')
    },
    '/small': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end('<rss version="2.0"><channel></channel></rss>')
    },
  }, async (base) => {
    const cases = [
      ['302 无尽 body', '/forever-302', 'ok', 15000],
      ['429 无尽 body', '/forever-429', 'rate-limited', 15000],
      ['500 无尽 body', '/forever-500', 'error', 15000],
      ['302 32MB body', '/big-302', 'ok', 15000],
      // 挂住的 body:必须在超时预算内干净地返回,不能挂死、也不能炸进程。
      ['302 挂住的 body', '/stall-302', 'error', 1000],
      ['200 挂住的 body', '/stall-200', 'error', 1000],
      ['429 挂住的 body', '/stall-429', 'rate-limited', 1000],
    ]
    for (const [label, route, expected, timeoutMs] of cases) {
      const started = Date.now()
      const r = await fetchFeed(`${base}${route}`, {
        allowPrivateNetworks: true,
        timeoutMs,
        maxBytes: 1024,
      })
      const ms = Date.now() - started
      equal(`F4 ${label} outcome`, r.outcome, expected)
      check(`F4 ${label} 在预算内返回(实测 ${ms}ms)`, ms < BUDGET_MS, `took ${ms}ms`)
    }
  })
}

// ── F5 源级 min/max 间隔真的生效,而且看得见 ────────────────────────────────
{
  const CFG = {
    defaultIntervalSeconds: 1800,
    minIntervalSeconds: 900,
    maxIntervalSeconds: 86400,
    defaultMaxItems: 20,
  }
  const base = {
    interval_sec: 100,
    cdn_max_age: null,
    window_size: null,
    mean_gap_ms: null,
    last_item_at: null,
    last_checked_at: null,
  }

  // 源存了 max_interval = 1800,而服务器声明的 TTL 是 200000s —— 上限必须是硬的。
  const capped = nextCadence(
    { ...base, min_interval: 60, max_interval: 1800 },
    { now: 1_000_000, outcome: 'ok', newCount: 0, windowSize: null, ttlSeconds: 200_000 },
    CFG,
  )
  check('F5 源级上限优先于部署上限(≤1800)', capped.intervalSec <= 1800, `got ${capped.intervalSec}`)

  const floored = nextCadence(
    { ...base, min_interval: 7200, max_interval: 86400 },
    { now: 1_000_000, outcome: 'ok', newCount: 0, windowSize: null },
    CFG,
  )
  check('F5 源级下限生效(≥7200)', floored.intervalSec >= 7200, `got ${floored.intervalSec}`)

  const fallback = nextCadence(
    { ...base },
    { now: 1_000_000, outcome: 'ok', newCount: 0, windowSize: null, ttlSeconds: 200_000 },
    CFG,
  )
  equal('F5 源级字段缺失时回退部署上限', fallback.intervalSec, 86400)

  // §6 的警告:源级字段只换边界,不能取消「最后夹到上限」。
  const hardCeiling = nextCadence(
    { ...base, min_interval: 900, max_interval: 3600, mean_gap_ms: 7 * 86400 * 1000, window_size: 10 },
    { now: 1_000_000, outcome: 'ok', newCount: 0, windowSize: 10 },
    CFG,
  )
  check('F5 源级上限仍然是硬的(mean_gap/3 顶不穿)', hardCeiling.intervalSec <= 3600, `got ${hardCeiling.intervalSec}`)

  // 工具层:两个值要真的落库、被采集层用上、并且在 feed_list 里看得见。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-feed-fixes-'))
  const silent = { info() {}, warn() {}, error() {}, file: '' }
  const store = openStore({ dir, log: silent })
  try {
    const tools = new Map()
    registerTools(
      { tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } } },
      { store, config: CFG, log: silent, poke: () => {} },
    )
    const exec = { agent: { id: 'session-fixes' } }
    const sub = await tools.get('feed_subscribe').execute(
      { url: 'https://example.com/f.xml', min_interval_seconds: 300, max_interval_seconds: 1800 },
      exec,
    )
    equal('F5 视图暴露源级下限', sub.source.min_interval_seconds, 300)
    equal('F5 视图暴露源级上限', sub.source.max_interval_seconds, 1800)

    const listed = await tools.get('feed_list').execute({}, exec)
    equal('F5 feed_list 也报出源级上限', listed.sources[0].max_interval_seconds, 1800)
    const listText = tools.get('feed_list').output.render({}, listed)[0].text
    check('F5 feed_list 文本里看得见边界', listText.includes('bounds 300-1800s'), listText)

    // 落库的那一行直接喂给 nextCadence —— 采集层用的就是它。
    const row = store.sources.byUrl('https://example.com/f.xml')
    check(
      'F5 库里的源行带着边界',
      Number(row.min_interval) === 300 && Number(row.max_interval) === 1800,
      `got [${row.min_interval}, ${row.max_interval}]`,
    )
    const viaRow = nextCadence(
      row,
      { now: 1_000_000, outcome: 'ok', newCount: 0, windowSize: null, ttlSeconds: 200_000 },
      CFG,
    )
    check('F5 库里的源行直接驱动源级上限', viaRow.intervalSec <= 1800, `got ${viaRow.intervalSec}`)
  } finally {
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
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
