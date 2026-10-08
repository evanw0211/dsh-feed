/**
 * 从 Miniflux v2 移植的用例集(提交 c52bdef6e9811f7c20cebc034a6c0ec6799dc6df)。
 *
 * ⚠️ **本文件写完即冻结。**
 * 只允许改**实现**去迁就它,不允许改它去迁就实现,也不允许加 skip 绕过去。
 * 若某条断言与 feedwatch 的既定语义冲突,必须把冲突提出来讨论。
 *
 * 来源(Apache-2.0,The Miniflux Authors)。这里是**按用例重写为 JS**,
 * 不是逐行照抄 Go 代码 —— 但用例的输入与期望值取自原文,故意保留。
 *
 *   internal/model/feed_test.go                      调度与夹紧(第 1 节)
 *   internal/model/feed.go:123-150                   ScheduleNextCheck 的顺序
 *   internal/reader/fetcher/request_builder_test.go  条件请求 / 私网 / 重定向(第 2、3 节)
 *   internal/reader/parser/format_test.go            格式嗅探(第 4 节)
 *   internal/reader/date/parser_test.go              日期解析(第 5 节)
 *
 * 明确**没有**移植的部分(理由见文件末「未移植清单」),不要以为是遗漏。
 *
 * 跑法(必须用 Electron 二进制,才有 node:sqlite):
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<install>\DeepSeek Harness.exe" dev/ported-miniflux.test.mjs
 */

import http from 'node:http'
import { parseFeed } from '../lib/parse.js'
import {
  fetchFeed,
  isPrivateAddress,
  maxAgeFromExpires,
  nextCadence,
  parseDate,
  parseRetryDelay,
} from '../lib/feed.js'

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
    server.close()
  }
}

const CFG = { minIntervalSeconds: 900, maxIntervalSeconds: 86400 }

/** 一个「什么都还没学到」的源状态,便于让断言只反映被测的那一项。 */
function state(patch = {}) {
  return {
    interval_sec: 100,
    cdn_max_age: null,
    window_size: null,
    mean_gap_ms: null,
    last_item_at: null,
    last_checked_at: null,
    ...patch,
  }
}

// ── 1. 调度与夹紧 ─────────────────────────────────────────────────────────
// 移植自 internal/model/feed_test.go。
//
// 映射关系:Miniflux 的 `refreshDelay` 是 `max(RSS <ttl>, Retry-After,
// Cache-Control, Expires)`;我们拆成分项传进 observation,由被测函数取 max。
// Miniflux 的「基础间隔」由调度器给出,我们的基础是 AIMD 的结果 —— 所以断言
// 只落在**夹紧**上,不落在基础值上。

{
  // 对应 TestFeedScheduleNextCheckRoundRobinWithRefreshDelayAboveMinInterval
  const r = nextCadence(
    state(),
    { now: 1_000_000, outcome: 'ok', newCount: 0, windowSize: null, ttlSeconds: 7200 },
    CFG,
  )
  equal('1.1 延迟高于下限时,间隔跟着延迟走', r.intervalSec, 7200)
}

{
  // 对应 TestFeedScheduleNextCheckEntryFrequencySmallNewTTL
  // 原文有**两条**断言:targetInterval = minInterval;且不得早于 TTL。
  const r = nextCadence(
    state(),
    { now: 1_000_000, outcome: 'ok', newCount: 0, windowSize: null, ttlSeconds: 300 },
    CFG,
  )
  equal('1.2 TTL 低于下限时,下限胜出', r.intervalSec, 900)
  check('1.2 TTL 不得被无视(next_due 不早于 TTL)', r.intervalSec >= 300, `got ${r.intervalSec}`)
}

{
  // 对应 TestFeedScheduleNextCheckRoundRobinWithRefreshDelayAboveMaxInterval
  // 这是「上限是硬的」那条:Miniflux 把夹紧放在 max() 之后。
  const r = nextCadence(
    state(),
    { now: 1_000_000, outcome: 'ok', newCount: 0, windowSize: null, ttlSeconds: 200_000 },
    CFG,
  )
  equal('1.3 延迟高于上限时,被夹到上限', r.intervalSec, 86400)
}

{
  // Expires 也是下限来源之一(Miniflux 的 refreshDelay 含它)。
  const r = nextCadence(
    state(),
    { now: 1_000_000, outcome: 'ok', newCount: 0, windowSize: null, expiresMaxAge: 5400 },
    CFG,
  )
  equal('1.4 Expires 参与下限', r.intervalSec, 5400)
}

{
  // 对应 TestFeedScheduleNextCheckEntryFrequencyMaxIntervalZeroWeeklyCount:
  // 原文那条测的是「计数为 0 时不得除零,要退到最大间隔」。
  // 我们的对应风险是 `mean_gap × window_size`(window_size 为 0)与 `elapsed/newCount`。
  const r = nextCadence(
    state({ mean_gap_ms: 600_000, window_size: 0 }),
    { now: 1_000_000, outcome: 'ok', newCount: 0, windowSize: 0 },
    CFG,
  )
  check('1.5 计数为 0 时不得产生 NaN/Infinity',
    Number.isFinite(r.intervalSec) && Number.isFinite(r.nextDueAt),
    `interval=${r.intervalSec} due=${r.nextDueAt}`)
  check('1.5 计数为 0 时不越过上限', r.intervalSec <= CFG.maxIntervalSeconds, `got ${r.intervalSec}`)
}

{
  // feedwatch 特有的回归(同一族语义:夹紧放最后)。
  // overreacted 实测:gap 7 天 → mean_gap/3 = 201600s,原来 `Math.max(upper, lower)`
  // 会把它顶成上限,配置的 86400 变成谎话。
  const r = nextCadence(
    state({ interval_sec: 201_600, mean_gap_ms: 7 * 86400 * 1000, window_size: 10 }),
    { now: 1_000_000, outcome: 'ok', newCount: 0, windowSize: 10 },
    CFG,
  )
  equal('1.6 mean_gap/3 不得突破配置上限', r.intervalSec, 86400)
}

{
  // 出错退避(原 TestFeedScheduleNextCheck* 不含此条,取自 README 的既有行为,保回归)
  const r = nextCadence(state({ interval_sec: 1800 }), { now: 1_000_000, outcome: 'error', newCount: 0 }, CFG)
  equal('1.7 出错时翻倍退避', r.intervalSec, 3600)
}

// ── 2. Retry-After ────────────────────────────────────────────────────────
// RFC 9110:两种形式都必须认。

{
  equal('2.1 Retry-After 秒数', parseRetryDelay('120'), 120)
  equal('2.1 Retry-After 秒数带空白', parseRetryDelay('  120  '), 120)
}
{
  const when = new Date(Date.now() + 60_000).toUTCString()
  const got = parseRetryDelay(when)
  check('2.2 Retry-After HTTP-date', got !== null && Math.abs(got - 60) <= 2, `got ${got} for ${when}`)
}
{
  equal('2.3 Retry-After 垃圾输入返回 null', parseRetryDelay('soon'), null)
  equal('2.3 Retry-After 空返回 null', parseRetryDelay(''), null)
  equal('2.3 Retry-After 缺失返回 null', parseRetryDelay(null), null)
}
{
  const past = new Date(Date.now() - 60_000).toUTCString()
  equal('2.4 已过期的 Retry-After 是 0,不是 null', parseRetryDelay(past), 0)
}
{
  const r = nextCadence(
    state({ interval_sec: 100 }),
    { now: 1_000_000, outcome: 'rate-limited', newCount: 0, retryAfterSeconds: 3600 },
    CFG,
  )
  equal('2.5 429 用服务器给的时长', r.intervalSec, 3600)
  equal('2.5 429 不加抖动', r.nextDueAt, 1_000_000 + 3600 * 1000)
}
{
  const r = nextCadence(
    state({ interval_sec: 100 }),
    { now: 1_000_000, outcome: 'rate-limited', newCount: 0, retryAfterSeconds: 60 },
    CFG,
  )
  equal('2.6 Retry-After 低于下限时抬到下限', r.intervalSec, 900)
}
{
  const r = nextCadence(
    state({ interval_sec: 1800 }),
    { now: 1_000_000, outcome: 'rate-limited', newCount: 0, retryAfterSeconds: null },
    CFG,
  )
  equal('2.7 没有 Retry-After 的限流退回普通退避', r.intervalSec, 3600)
}

// ── 3. 条件请求 ───────────────────────────────────────────────────────────
// 移植自 TestRequestBuilder_WithETag / WithLastModified / DefaultAcceptHeader。

{
  const seen = {}
  await withServer({
    '/feed': (req, res) => {
      seen.ifNoneMatch = req.headers['if-none-match'] ?? null
      seen.ifModifiedSince = req.headers['if-modified-since'] ?? null
      seen.accept = req.headers.accept ?? null
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end('<rss version="2.0"><channel></channel></rss>')
    },
  }, async (base) => {
    const r = await fetchFeed(`${base}/feed`, {
      etag: 'test-etag',
      lastModified: 'Mon, 02 Jan 2006 15:04:05 GMT',
      allowPrivateNetworks: true,
    })
    equal('3.1 取数成功', r.outcome, 'ok')
    equal('3.1 ETag 原样回送', seen.ifNoneMatch, 'test-etag')
    equal('3.1 Last-Modified 原样回送', seen.ifModifiedSince, 'Mon, 02 Jan 2006 15:04:05 GMT')
    check('3.1 带默认 Accept 头', typeof seen.accept === 'string' && seen.accept.includes('application/rss+xml'), String(seen.accept))
  })
}

{
  const seen = {}
  await withServer({
    '/feed': (req, res) => {
      seen.ifNoneMatch = req.headers['if-none-match'] ?? null
      seen.ifModifiedSince = req.headers['if-modified-since'] ?? null
      res.writeHead(200)
      res.end('<rss version="2.0"><channel></channel></rss>')
    },
  }, async (base) => {
    await fetchFeed(`${base}/feed`, { etag: '', lastModified: '', allowPrivateNetworks: true })
    equal('3.2 空 ETag 不发条件头', seen.ifNoneMatch, null)
    equal('3.2 空 Last-Modified 不发条件头', seen.ifModifiedSince, null)
  })
}

{
  await withServer({
    '/feed': (_req, res) => {
      res.writeHead(304, { etag: '"v2"' })
      res.end()
    },
  }, async (base) => {
    const r = await fetchFeed(`${base}/feed`, { etag: '"v1"', allowPrivateNetworks: true })
    equal('3.3 304 归一化为 not-modified', r.outcome, 'not-modified')
    equal('3.3 304 更新 ETag', r.etag, '"v2"')
  })
}

// ── 4. 私网与重定向 ───────────────────────────────────────────────────────
// 移植自 TestRequestBuilder_RefusePrivateNetworkByDefault /
// AllowPrivateNetworkWhenEnabled / RefusePrivateNetworkOnRedirect。

{
  equal('4.1 环回是私网', isPrivateAddress('127.0.0.1'), true)
  equal('4.1 10/8 是私网', isPrivateAddress('10.1.2.3'), true)
  equal('4.1 172.16/12 是私网', isPrivateAddress('172.16.0.1'), true)
  equal('4.1 192.168/16 是私网', isPrivateAddress('192.168.1.1'), true)
  equal('4.1 链路本地是私网', isPrivateAddress('169.254.169.254'), true)
  equal('4.1 CGNAT 是私网', isPrivateAddress('100.64.0.1'), true)
  equal('4.1 组播是私网', isPrivateAddress('224.0.0.1'), true)
  equal('4.1 公网不是私网', isPrivateAddress('8.8.8.8'), false)
  equal('4.1 环回 v6 是私网', isPrivateAddress('::1'), true)
  equal('4.1 唯一本地 v6 是私网', isPrivateAddress('fc00::1'), true)
  equal('4.1 链路本地 v6 是私网', isPrivateAddress('fe80::1'), true)
  // 这条最要紧:不处理 IPv4-mapped 就等于没挡。
  equal('4.1 IPv4-mapped 环回是私网', isPrivateAddress('::ffff:127.0.0.1'), true)
}

{
  // 对应 TestRequestBuilder_RefusePrivateNetworkByDefault
  await withServer({
    '/feed': (_req, res) => { res.writeHead(200); res.end('x') },
  }, async (base) => {
    const r = await fetchFeed(`${base}/feed`, { allowPrivateNetworks: false })
    equal('4.2 默认拒绝私网', r.outcome, 'error')
    check('4.2 拒绝原因说明是私网', String(r.error).includes('private address'), String(r.error))
  })
}

{
  // 对应 TestRequestBuilder_AllowPrivateNetworkWhenEnabled
  await withServer({
    '/feed': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end('<rss version="2.0"><channel></channel></rss>')
    },
  }, async (base) => {
    const r = await fetchFeed(`${base}/feed`, { allowPrivateNetworks: true })
    equal('4.3 显式开启后放行私网', r.outcome, 'ok')
  })
}

{
  // 对应 TestRequestBuilder_WithoutRedirects 的反面:我们**要**跟随重定向,
  // 且 Location 可能是相对路径(实测见到 `"/final"`)。
  await withServer({
    '/start': (_req, res) => {
      res.writeHead(302, { location: '/final' })
      res.end('redir')
    },
    '/final': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end('<rss version="2.0"><channel></channel></rss>')
    },
  }, async (base) => {
    const r = await fetchFeed(`${base}/start`, { allowPrivateNetworks: true })
    equal('4.4 跟随相对 Location', r.outcome, 'ok')
  })
}

{
  // 对应 TestRequestBuilder_RefusePrivateNetworkOnRedirect 的**可达部分**。
  // 说明:原文靠 Go 的 dialer 在连接时校验,首跳是公网、次跳是私网。
  // 我们在 `fetch` 之上只能预检,而本地起不了「公网首跳」,所以
  //   - 首跳即私网 → 必须拒(下面这条)
  //   - 次跳才私网 → 无法在本地独立构造,只由 blockedAddressReason 的单元用例覆盖(上一节)
  // 这是**已知的覆盖缺口**,不是遗漏。
  await withServer({
    '/start': (_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
      res.end('redir')
    },
  }, async (base) => {
    const r = await fetchFeed(`${base}/start`, { allowPrivateNetworks: false })
    equal('4.5 私网首跳被拒', r.outcome, 'error')
    check('4.5 拒绝原因说明是私网', String(r.error).includes('private address'), String(r.error))
  })
}

{
  // 重定向次数上限:不能无限跟。
  await withServer({
    '/loop': (_req, res) => {
      res.writeHead(302, { location: '/loop' })
      res.end()
    },
  }, async (base) => {
    const r = await fetchFeed(`${base}/loop`, { allowPrivateNetworks: true })
    equal('4.6 超量重定向被拒', r.outcome, 'error')
    check('4.6 错误说明是重定向过多', String(r.error).includes('too many redirects'), String(r.error))
  })
}

{
  await withServer({
    '/nowhere': (_req, res) => {
      res.writeHead(302)
      res.end()
    },
  }, async (base) => {
    const r = await fetchFeed(`${base}/nowhere`, { allowPrivateNetworks: true })
    equal('4.7 3xx 无 Location 是错误', r.outcome, 'error')
    check('4.7 错误说明缺 Location', String(r.error).includes('without Location'), String(r.error))
  })
}

// ── 5. 格式嗅探 ───────────────────────────────────────────────────────────
// 移植自 internal/reader/parser/format_test.go。
//
// 关键点:格式由**根元素**决定,不要求已经出现 `<item>` / `<entry>` ——
// 一个结构合法但暂时没有条目的 feed(新博客)不能被判成「无法识别」,
// 否则它会被归为解析失败、`failures` 一路累计。

{
  const rdf = '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://my.netscape.com/rdf/simple/0.9/"></rdf:RDF>'
  equal('5.1 RDF 被识别', parseFeed(rdf).format, 'rdf')
}

{
  const rss = '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'
  equal('5.2 空 RSS 仍是 RSS(不是 unknown)', parseFeed(rss).format, 'rss')
}

{
  const atom = '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'
  equal('5.3 空 Atom 1.0 仍是 Atom', parseFeed(atom).format, 'atom')
}

{
  const atom03 = '<?xml version="1.0" encoding="utf-8"?><feed version="0.3" xmlns="http://purl.org/atom/ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xml:lang="en"></feed>'
  equal('5.4 Atom 0.3 被识别', parseFeed(atom03).format, 'atom')
}

{
  const atomIso = '<?xml version="1.0" encoding="ISO-8859-15"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'
  equal('5.5 带 ISO charset 声明的 Atom 被识别', parseFeed(atomIso).format, 'atom')
}

{
  equal('5.6 HTML 是 unknown', parseFeed('<!DOCTYPE html> <html> </html>').format, 'unknown')
}

{
  equal('5.7 纯空白是 unknown', parseFeed(' \t\n\r'.repeat(10_000)).format, 'unknown')
}

{
  // 空 feed 判为已知格式还不够 —— 它必须**不是**解析失败,
  // 否则新的 parse-error 分类会把「新博客」记成坏源。
  const rss = parseFeed('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>')
  equal('5.8 空 feed 解析出 0 条', rss.items.length, 0)
  equal('5.8 空 feed 的 windowSize 是 0', rss.windowSize, 0)
}

{
  // RSS 2.0 的频道级 <ttl>,单位分钟。
  const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><ttl>60</ttl></channel></rss>'
  equal('5.9 <ttl> 换算成秒', parseFeed(rss).ttlSeconds, 3600)
  equal('5.9 没有 <ttl> 时是 null', parseFeed('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>').ttlSeconds, null)
}

// ── 6. 日期解析 ───────────────────────────────────────────────────────────
// 移植自 internal/reader/date/parser_test.go(可移植的部分)。

{
  equal('6.1 空日期返回 null', parseDate('  '), null)
  equal('6.2 非法日期返回 null', parseDate('invalid'), null)
  // 原文 expectedTS = 1513980589(秒)
  equal('6.3 Atom ISO 日期', parseDate('2017-12-22T22:09:49+00:00'), 1513980589000)
}

// ── 结果 ──────────────────────────────────────────────────────────────────
console.log(`\npassed: ${passed}`)
if (failures.length === 0) {
  console.log('all checks passed')
} else {
  console.log(`failed: ${failures.length}`)
  for (const failure of failures) console.log(`  x ${failure}`)
}
process.exitCode = failures.length === 0 ? 0 : 1

/**
 * 未移植清单(逐条给理由,不是遗漏):
 *
 * 1. format_test.go 的 5 个 JSON 用例(TestDetectJSON / LargeLeadingWhitespace /
 *    MixedWhitespace / SmallerThanBuffer / WithWhitespaceSmallerThanBuffer)
 *    —— 我们**根本不支持 JSON Feed**。这是功能缺失而非回归,移植进来只会得到
 *    一个永久失败的断言。注意 `feed_subscribe` 的工具描述写着 "RSS/Atom/JSON",
 *    这属于**文档与实现不一致**,应单独决定:要么实现 JSON,要么改描述。
 *
 * 2. date/parser_test.go 的 **命名时区**用例
 *    (`Fri, 31 Mar 2023 20:19:00 America/Los_Angeles`)—— 我们的 `parseDate` 是
 *    `Date.parse` 的薄封装,返回 null;Miniflux 有自己的解析器,能处理 IANA 名字。
 *    这是**真实的语义分歧**,不是明显的一方错:采用哪个要先决定,所以不写成断言。
 *
 * 3. request_builder_test.go 里与 Go HTTP 栈绑定的部分:Cookie /
 *    Basic Auth / DisableHTTP2 / IgnoreTLSErrors / 压缩开关 / 外部代理 /
 *    Connection: close —— feedwatch 的这些能力由 Host 的 fetch 决定,
 *    插件侧没有开关,移植过来没有对应的实现可测。
 *
 * 4. `WithoutRedirects`:Miniflux 可以关掉重定向,我们需要跟随(feed 换域名是常态)。
 *    我们改为**限制跳数 + 每跳校验地址**,对应的用例是 4.4/4.6。
 *
 * 5. `RefusePrivateNetworkOnRedirect` 的**次跳**场景:本地无法构造「公网首跳 →
 *    私网次跳」。首跳部分见 4.5;次跳的地址判定由 4.1 的纯函数用例覆盖。
 */
