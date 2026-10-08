/**
 * 采集层:条件请求、节奏推断、身份比对。
 *
 * 这一层**不知道**会话、匹配规则、投递 —— 它只回答一个问题:
 * 「这个地址现在有什么是我没见过的?」
 *
 * @module @local/dsh-feed/lib/feed
 */

import { parseFeed } from './parse.js'

const dns = process.getBuiltinModule('node:dns')
const net = process.getBuiltinModule('node:net')

/** 默认 UA。有些源会拒绝空 UA。 */
export const DEFAULT_USER_AGENT = 'dsh-feed/0.1 (+https://deepseek.com)'

/** 一次取数最多跟几跳重定向。 */
const MAX_REDIRECTS = 5

/**
 * **真正**要跟随的重定向状态码。
 *
 * 不能图省事写成 `300 <= status < 400`:304 Not Modified 正落在这个区间里,
 * 但它不是重定向、也没有 Location。用区间判断会把**每一次条件请求命中**都
 * 判成「HTTP 304 without Location」的错误 —— 而 304 是本插件最主要的省流路径。
 * (300 Multiple Choices 没有唯一目标,305/306 已废弃,都不跟。)
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Retry-After 的理智上限(7 天)。
 *
 * Retry-After **不受** `max_interval_seconds` 约束 —— 服务器比我们更清楚自己的限流
 * 窗口,它说等 3 天就是等 3 天。这个常量只用来防止一个坏掉的端点把我们停到永远。
 */
const RETRY_AFTER_CEILING_SECONDS = 7 * 86400

/**
 * 有上限地读响应体。
 * 不设上限的话,一个恶意/故障的端点能让我们一直读到内存爆掉。
 */
async function readBounded(response, maxBytes) {
  if (response.body === null) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      try {
        await reader.cancel()
      } catch {
        /* 取消失败无所谓,我们已经决定不要了 */
      }
      return { text: null, truncated: true }
    }
    chunks.push(value)
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: false }
}

/**
 * 丢弃式读取的字节上限。
 *
 * 这三处(重定向 / 限流 / 错误分支)读 body 的唯一目的是「读掉它让连接能复用」,
 * 不值得为此放弃上限。64KB 足够吃掉正常的小 body,超出的直接取消连接。
 */
const DRAIN_MAX_BYTES = 64 * 1024

/**
 * **有上限地**把响应体读掉并丢弃。
 *
 * 原来这三处直接 `await response.arrayBuffer()` —— 读多少完全由对端决定,
 * 而只有 200 路径走 `readBounded`。实测:`maxBytes: 1024` 下,一个
 * 「302 + 32MB body」的响应让 RSS 涨 43.7MB(undici 还会自动解压,gzip 炸弹同样生效);
 * 唯一的兜底是整条链共用的 15 秒超时,所以上限取决于对端在超时前能推多少。
 *
 * 读满上限就 `cancel()`:取消同样会释放连接,只是不再复用 —— 那正是我们要的。
 */
async function drainBounded(response, maxBytes = DRAIN_MAX_BYTES) {
  if (response.body === null) return
  let reader
  try {
    reader = response.body.getReader()
  } catch {
    return
  }
  try {
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return
      }
    }
  } catch {
    /* 读不动或已被取消都无所谓:这只是为了连接复用 */
  }
}

/** 从 Cache-Control 里取 max-age(秒)。 */
export function maxAgeFromCacheControl(header) {
  if (typeof header !== 'string') return null
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(header)
  if (!match) return null
  const seconds = Number.parseInt(match[1], 10)
  return Number.isFinite(seconds) ? seconds : null
}

/**
 * 从 `Expires` 里取**剩余**的 max-age(秒)。
 * 已经过期或解析不出来返回 null(没有信息,不是「等 0 秒」)。
 */
export function maxAgeFromExpires(header, now = Date.now()) {
  if (typeof header !== 'string' || header.trim() === '') return null
  const ms = Date.parse(header)
  if (!Number.isFinite(ms)) return null
  const seconds = Math.floor((ms - now) / 1000)
  return seconds > 0 ? seconds : null
}

/**
 * 解析 `Retry-After`。
 *
 * RFC 9110 允许**两种**形式:纯秒数,或 HTTP-date。两种都要认 ——
 * 只认秒数的话,一个发 HTTP-date 的服务器会被我们当成「没说」。
 *
 * @returns 秒数(非负);解析不出来返回 null
 */
export function parseRetryDelay(header, now = Date.now()) {
  if (typeof header !== 'string') return null
  const value = header.trim()
  if (value === '') return null
  if (/^\d+$/.test(value)) {
    const seconds = Number.parseInt(value, 10)
    return Number.isFinite(seconds) ? seconds : null
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.ceil((ms - now) / 1000))
}

/**
 * IPv6 字面量 → 8 个 16 位组。
 *
 * **判定必须建在规范化之后的字节上,不能建在字符串写法上。**
 * 原来只认 `::ffff:` 后面的点分四段,于是同一个地址的另一种合法写法
 * (`::ffff:7f00:1`、`0:0:0:0:0:ffff:127.0.0.1`)既不匹配那条正则、
 * 也落不进别的分支 —— 预检直接放行(实测复现,见 HANDOFF-review F1)。
 *
 * 这里只做**解析**:补齐 `::`、接受十六进制组、把尾部的点分四段折成两组。
 * 是不是私网由调用方在组上判。
 *
 * @param input - IPv6 字面量(可带方括号与 `%zone`)
 * @returns 8 个 0..65535 的组;解析不出来返回 null
 */
function ipv6Groups(input) {
  let text = String(input).trim().toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  if (text === '') return null

  // 尾部的点分四段(`::ffff:127.0.0.1`)折成两个 16 位组,剩下的部分照常按 `:` 分组。
  let tail = []
  let head = text
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text)
  if (dotted !== null) {
    const octets = dotted[2].split('.').map(Number)
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]]
    head = dotted[1].slice(0, -1)
  }

  const doubleColon = head.indexOf('::')
  if (doubleColon !== -1 && head.indexOf('::', doubleColon + 2) !== -1) return null

  const parseGroups = (part) => {
    if (part === '') return []
    const out = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      out.push(Number.parseInt(group, 16))
    }
    return out
  }

  let groups
  if (doubleColon === -1) {
    const parsed = parseGroups(head)
    if (parsed === null) return null
    groups = parsed
  } else {
    const left = parseGroups(head.slice(0, doubleColon))
    const right = parseGroups(head.slice(doubleColon + 2))
    if (left === null || right === null) return null
    const fill = 8 - left.length - right.length - tail.length
    if (fill < 0) return null
    groups = [...left, ...new Array(fill).fill(0), ...right]
  }
  groups.push(...tail)
  return groups.length === 8 ? groups : null
}

/** IPv4 的私有/环回/链路本地/CGNAT/保留段判定。四个八位组。 */
function isPrivateV4(octets) {
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true      // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true                // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 0) return true                  // 192.0.0.0/24(IETF 专用)
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true   // 基准测试段
  if (a >= 224) return true                              // 组播 + 保留
  return false
}

/**
 * 一个 IP 字面量是否属于「不该去连」的地址段。
 *
 * 覆盖 IPv4 的私有/环回/链路本地/CGNAT/保留段,以及 IPv6 的环回、链路本地、
 * 唯一本地、组播,和三类**内嵌 IPv4** 的前缀:
 *   - `::ffff:0:0/96`(IPv4-mapped,含 `::ffff:7f00:1` 这种十六进制写法)
 *   - `::/96`(IPv4-compatible,如 `::7f00:1`)
 *   - `64:ff9b::/96` 与 `64:ff9b:1::/48`(NAT64;网关会替我们连到那个 v4 地址)
 * 提取出后 32 位之后**递归走 IPv4 判定**,不是给某个写法加特判 ——
 * 特判只会漏掉下一种写法。
 */
export function isPrivateAddress(ip) {
  const version = net.isIP(ip)
  if (version === 4) return isPrivateV4(String(ip).split('.').map(Number))
  if (version !== 6) return false

  const groups = ipv6Groups(ip)
  // `net.isIP` 已经认过它,这里解析不出来说明我们漏了某种写法。保守拒绝。
  if (groups === null) return true

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0) return true // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true // ::1
  if ((g0 & 0xffc0) === 0xfe80) return true   // 链路本地 fe80::/10
  if ((g0 & 0xfe00) === 0xfc00) return true   // 唯一本地 fc00::/7
  if ((g0 & 0xff00) === 0xff00) return true   // 组播 ff00::/8(IPv4 侧有 a >= 224,v6 侧原来没有对应项)

  let embedded = null
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) embedded = [g6, g7]
  else if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) embedded = [g6, g7]
  else if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) embedded = [g6, g7]
  else if (g0 === 0x0064 && g1 === 0xff9b && g2 === 1) embedded = [g6, g7]

  if (embedded !== null) {
    const [high, low] = embedded
    return isPrivateV4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff])
  }
  return false
}

/**
 * 这个主机名/字面地址现在能不能去取?
 *
 * **诚实说明强度**:Miniflux 把私网检查放在 Go 的 `net.Dialer.Control` 里 ——
 * 那是 DNS 解析之后、TCP 连接之前,检查的 IP 就是即将连接的 IP,TOCTOU 被消除。
 * 我们在 `fetch` 之上拿不到那个钩子,所以这里只是**预检**:检查与真正连接之间
 * DNS 仍可能变。它挡的是「恶意 feed 302 到内网」这类主动重定向,
 * 挡不住针对本机解析器的定向投毒。
 *
 * @returns 拒绝的原因;可以安全取时返回 null
 */
export async function blockedAddressReason(host) {
  const bare = String(host ?? '').replace(/^\[/, '').replace(/\]$/, '')
  if (bare === '') return 'refusing to fetch: empty host'

  if (net.isIP(bare) !== 0) {
    return isPrivateAddress(bare) ? `refusing to fetch a private address (${bare})` : null
  }

  const lower = bare.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return `refusing to fetch ${bare}: loopback name`
  }

  let records
  try {
    records = await dns.promises.lookup(bare, { all: true })
  } catch (error) {
    return `dns lookup failed for ${bare}: ${error?.message ?? error}`
  }
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      return `refusing to fetch ${bare}: it resolves to a private address (${record.address})`
    }
  }
  return null
}

/**
 * 解析 RFC 822 / ISO 时间戳。
 * @returns 毫秒时间戳,解析不出来返回 null
 */
export function parseDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * 发一次条件请求。
 *
 * 304 只是**省钱优化**:正确性永远来自身份比对,那是 body 到手之后的事。
 * 服务器不支持条件请求 → 全量下载,**结果一样正确**。
 *
 * 重定向是**手动**跟随的,原因见下面的注释 —— 不能用 `redirect: 'follow'`。
 *
 * @param url - feed 地址
 * @param options - 上次的验证器、本次限额,以及是否允许私网
 * @returns 归一化的取数结果
 */
export async function fetchFeed(url, options = {}) {
  const {
    etag = null,
    lastModified = null,
    timeoutMs = 15000,
    maxBytes = 1024 * 1024,
    userAgent = DEFAULT_USER_AGENT,
    allowPrivateNetworks = false,
  } = options

  const headers = {
    'user-agent': userAgent,
    accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
  }
  // 原样回送。trim 掉引号或自己造时间戳都是 bug。
  if (etag) headers['if-none-match'] = etag
  if (lastModified) headers['if-modified-since'] = lastModified

  // 整条重定向链共用一个超时预算:五跳各自超时一次等于五倍等待。
  const signal = AbortSignal.timeout(timeoutMs)

  // ── 手动跟随重定向 ──
  //
  // **不能用 `redirect: 'follow'`。** 那样 Host 会先连上去,才轮到我们看地址;
  // 一个恶意 feed 只要 302 到 `http://127.0.0.1:…` 就能让内网响应进入解析层,
  // 进而作为条目内容进入模型上下文 —— Host 进程有这个网络能力。
  //
  // Miniflux 把检查放在 Go 的 `net.Dialer.Control`(DNS 之后、TCP 之前),
  // 检查的 IP 就是即将连接的 IP,TOCTOU 被消除。我们在 `fetch` 之上拿不到那个钩子,
  // 只能**每一跳之前**预检地址 —— 强度更低,残留 TOCTOU(见 blockedAddressReason)。
  // 实测确认:Node 的 `redirect: 'manual'` 会返回 3xx 本身且 Location 可读
  // (浏览器会得到 opaqueredirect,Node 不会),所以这套是可行的。
  let target = url
  let response = null
  for (let redirects = 0; ; redirects += 1) {
    if (!allowPrivateNetworks) {
      let host
      try {
        host = new URL(target).hostname
      } catch {
        return { outcome: 'error', error: `invalid url: ${target}` }
      }
      const blocked = await blockedAddressReason(host)
      if (blocked !== null) return { outcome: 'error', error: blocked }
    }

    try {
      response = await fetch(target, { headers, redirect: 'manual', signal })
    } catch (error) {
      return { outcome: 'error', error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message ?? error) }
    }

    if (!REDIRECT_STATUSES.has(response.status)) break

    const location = response.headers.get('location')
    // 读掉重定向的 body,让连接能复用 —— 但**必须有字节上限**(见 drainBounded)。
    await drainBounded(response)
    if (location === null || location === '') {
      return { outcome: 'error', error: `HTTP ${response.status} without Location`, status: response.status }
    }
    if (redirects >= MAX_REDIRECTS) {
      return { outcome: 'error', error: `too many redirects (>${MAX_REDIRECTS})` }
    }
    try {
      // Location 可以是相对路径(实测见到 `"/final"`),必须基于当前地址解析。
      target = new URL(location, target).href
    } catch {
      return { outcome: 'error', error: `invalid redirect target: ${location}` }
    }
  }

  const responseEtag = response.headers.get('etag')
  const responseLastModified = response.headers.get('last-modified')
  const cdnMaxAge = maxAgeFromCacheControl(response.headers.get('cache-control'))
  const expiresMaxAge = maxAgeFromExpires(response.headers.get('expires'))

  if (response.status === 304) {
    return {
      outcome: 'not-modified',
      etag: responseEtag ?? etag,
      lastModified: responseLastModified ?? lastModified,
      cdnMaxAge,
      expiresMaxAge,
      status: 304,
    }
  }

  // 429 一定算限流;503 只在服务器明说 Retry-After 时才算(否则它只是普通故障)。
  if (response.status === 429 || response.status === 503) {
    const retryAfterSeconds = parseRetryDelay(response.headers.get('retry-after'))
    if (response.status === 429 || retryAfterSeconds !== null) {
      await drainBounded(response)
      return {
        outcome: 'rate-limited',
        status: response.status,
        retryAfterSeconds,
        etag: responseEtag ?? etag,
        lastModified: responseLastModified ?? lastModified,
        cdnMaxAge,
        expiresMaxAge,
      }
    }
  }

  if (!response.ok) {
    // 读掉一点 body,让连接能复用 —— 同样有上限。
    await drainBounded(response)
    return { outcome: 'error', error: `HTTP ${response.status}`, status: response.status }
  }

  let body
  try {
    body = await readBounded(response, maxBytes)
  } catch (error) {
    return { outcome: 'error', error: String(error?.message ?? error) }
  }
  if (body.truncated) {
    return { outcome: 'error', error: `body exceeds ${maxBytes} bytes` }
  }

  return {
    outcome: 'ok',
    status: response.status,
    text: body.text,
    // 服务器这次没给就沿用上次的,不要把它抹掉。
    etag: responseEtag ?? etag,
    lastModified: responseLastModified ?? lastModified,
    cdnMaxAge,
    expiresMaxAge,
  }
}

/**
 * 从条目里挑出没见过的。
 *
 * 身份比对是**唯一**的判断依据 —— 不用时间戳(实测大量重复),
 * 也不看顺序(源会重排)。
 *
 * @param items - 本次解析出的条目
 * @param seenKeys - 这个源已见过的身份集合
 * @returns 新条目,按 feed 给出的顺序
 */
export function pickNewItems(items, seenKeys) {
  const fresh = []
  const batchSeen = new Set()
  for (const item of items) {
    if (seenKeys.has(item.key) || batchSeen.has(item.key)) continue
    batchSeen.add(item.key)
    fresh.push(item)
  }
  return fresh
}

/**
 * 首次抓取时,把「早于订阅时刻」的条目挑出来当**基线**:只记账,不投递。
 *
 * 不这么做的话,订阅一个博客等于当场把它过去一年的文章念一遍 ——
 * 用户要的是「以后有新的告诉我」,不是「把存档倒给我」。
 *
 * 日期不可用(`parseDate` 返回 null)时**保守地当作基线**:宁可漏掉订阅前后
 * 那几十秒内发的一条,也不倒一屏历史。
 *
 * 这个取舍**只作用于第一次成功抓取**。之后的轮次走正常的身份比对,
 * 新条目照常投递,不受影响。
 *
 * @param items - 本轮判定为新条目的条目
 * @param subscribedAt - 订阅时刻(ms)
 * @returns `{ baseline, deliver }`
 */
export function splitBaseline(items, subscribedAt) {
  const baseline = []
  const deliver = []
  for (const item of items) {
    const ms = parseDate(item.publishedAt)
    if (ms === null || ms < subscribedAt) baseline.push(item)
    else deliver.push(item)
  }
  return { baseline, deliver }
}

/**
 * 用发布时间的中位数间隔做初始估计。
 * 只在还没有到达间隔样本时用,且**容忍重复时间戳**(实测 Cloudflare 20 条里 13 条相同)。
 */
function seedGapFromTimestamps(items) {
  const times = []
  for (const item of items) {
    const ms = parseDate(item.publishedAt)
    if (ms !== null) times.push(ms)
  }
  if (times.length < 3) return null
  times.sort((a, b) => a - b)
  const deltas = []
  for (let i = 1; i < times.length; i += 1) {
    const delta = times[i] - times[i - 1]
    if (delta > 0) deltas.push(delta)
  }
  if (deltas.length < 2) return null
  deltas.sort((a, b) => a - b)
  return deltas[Math.floor(deltas.length / 2)]
}

/**
 * 推进一个源的自适应节奏。
 *
 * 夹紧的**顺序照 Miniflux**(`model/feed.go:123-150`):
 *
 *   1. 先算出 AIMD 给出的候选间隔
 *   2. 取 `max(候选, min_interval, Cache-Control, Expires, RSS <ttl>, mean_gap/3)`
 *   3. **最后**才夹到 `[min_interval, max_interval]`
 *
 * 顺序是有含义的:**上限必须是硬的**。反面教材就是原来那行
 * `Math.max(upper, lower)` —— 慢源上 `mean_gap / 3`(overreacted:gap 7 天 →
 * 201600s)会直接把配置的 86400 顶掉,上限变成一句谎话。
 *
 * 两条约束的来源不同,所以都要留:
 *   下限(省)   别比源产出得还勤 —— `mean_gap/3` 是必需的:`late`(补发检测)会被
 *              源自身的重排误判,没有它 HN 的间隔会 600 → 300 → 150 一路自激到 60s
 *   上限(准)   别慢到一次窗口翻掉一半以上,否则条目还没被看到就滑出 feed 自己的窗口
 *
 * `mean_gap/3` 这个下限本身也受上限约束(见下面的 `Math.min`)—— 它只是「别再快了」
 * 的护栏,不该有权突破用户配置的天花板。
 *
 * 边界值取**源级**(`state.min_interval` / `state.max_interval`,由 `feed_subscribe`
 * 落库),缺失时才回退到部署配置。源级字段只替换边界,**不**取消最后那一步夹紧。
 *
 * @param state - 该源的持久化状态(含 min_interval / max_interval)
 * @param observation - 本次采集的观察结果
 * @param config - 部署配置(源级边界缺失时的回退值)
 * @returns 该更新回数据库的字段
 */
export function nextCadence(state, observation, config) {
  const now = observation.now

  // ── 夹紧边界:源级优先,缺省回退部署级 ──
  //
  // `sources.min_interval` / `max_interval` 是 `feed_subscribe` 校验并落库的**每源**
  // 设置,但原来全仓没有任何地方读回它们(只有 dev/inspect.mjs 的 SELECT):
  // 源存了 `max_interval = 1800`,`nextCadence` 仍然按部署上限返回 86400 ——
  // 工具描述承诺的 "Floor / ceiling for the adaptive interval" 是空话。
  //
  // 注意:源级字段只**替换边界值**,不取消下面「最后夹到上限」那一步 ——
  // 上限必须仍然是硬的(见本函数上面「夹紧的顺序」那段论证)。
  const { minIntervalSeconds: fallbackMin = 900, maxIntervalSeconds: fallbackMax = 86400 } = config ?? {}
  const sourceMin = Number(state?.min_interval)
  const sourceMax = Number(state?.max_interval)
  const minIntervalSeconds = Number.isFinite(sourceMin) && sourceMin > 0 ? sourceMin : fallbackMin
  const maxIntervalSeconds = Number.isFinite(sourceMax) && sourceMax > 0 ? sourceMax : fallbackMax

  // ── 服务器直接指定的重排:优先级高于一切,包括配置上限 ──
  //
  // Retry-After 是服务器在说「别再来了」,它比我们更清楚自己的限流窗口。
  // 把它夹进 max_interval_seconds 就等于宣称我们比对方更懂 —— 那正是原来
  // 「采集了 Retry-After 然后丢掉」的同一个错,只是换个方向。
  // 只保留一个理智上限,防止坏掉的端点把我们停到永远。
  const retryAfterSeconds = Number.isFinite(observation.retryAfterSeconds)
    && observation.retryAfterSeconds >= 0
    ? observation.retryAfterSeconds
    : null
  if (observation.outcome === 'rate-limited' && retryAfterSeconds !== null) {
    const seconds = Math.max(minIntervalSeconds, Math.min(retryAfterSeconds, RETRY_AFTER_CEILING_SECONDS))
    return {
      intervalSec: Math.round(seconds),
      // **不加抖动**:服务器说「N 秒后再来」,抖到 N 秒以下就是不守规矩。
      nextDueAt: now + Math.round(seconds * 1000),
      meanGapMs: state.mean_gap_ms ?? null,
      windowSize: observation.windowSize ?? state.window_size ?? null,
      lastItemAt: state.last_item_at ?? null,
      lateDetected: false,
    }
  }

  let meanGapMs = state.mean_gap_ms ?? null
  let windowSize = observation.windowSize ?? state.window_size ?? null
  let lastItemAt = state.last_item_at ?? null
  let lateDetected = false

  const newCount = observation.newCount
  const elapsedMs = state.last_checked_at ? Math.max(0, now - state.last_checked_at) : null

  // ── 间隔估计:优先用「到达间隔」(不依赖 feed 时间戳),没有样本才退回时间戳 ──
  if (observation.outcome === 'ok' && newCount > 0 && elapsedMs !== null && elapsedMs > 0) {
    const sample = elapsedMs / newCount
    meanGapMs = meanGapMs === null ? sample : Math.round(meanGapMs * 0.7 + sample * 0.3)
  } else if (meanGapMs === null && observation.items) {
    const seeded = seedGapFromTimestamps(observation.items)
    if (seeded !== null) meanGapMs = seeded
  }

  // ── late:比已知最新还旧的新条目 = 源在补发/重排,可能有漏收 ──
  if (observation.outcome === 'ok' && newCount > 0 && observation.items && lastItemAt !== null) {
    const suspected = lastItemAt - (meanGapMs ?? 0)
    for (const item of observation.items) {
      const ms = parseDate(item.publishedAt)
      if (ms !== null && ms < suspected) {
        lateDetected = true
        break
      }
    }
  }
  if (observation.outcome === 'ok' && observation.items) {
    for (const item of observation.items) {
      const ms = parseDate(item.publishedAt)
      if (ms !== null && (lastItemAt === null || ms > lastItemAt)) lastItemAt = ms
    }
  }

  // ── AIMD ──
  let interval = state.interval_sec
  if (observation.outcome === 'error' || observation.outcome === 'rate-limited') {
    // rate-limited 但没有 Retry-After:服务器没说等多久,只能按普通故障退避。
    interval = interval * 2
  } else if (newCount > 0) {
    interval = interval / (lateDetected ? 4 : 2)
  } else {
    interval = interval * 1.5
  }

  // ── 所有「服务器声明的最小间隔」取 max,然后**最后**夹到 [min, max] ──
  const floors = [minIntervalSeconds]
  if (state.cdn_max_age) floors.push(state.cdn_max_age)
  if (observation.cdnMaxAge) floors.push(observation.cdnMaxAge)
  if (observation.expiresMaxAge) floors.push(observation.expiresMaxAge)
  if (observation.ttlSeconds) floors.push(observation.ttlSeconds)
  if (meanGapMs !== null) floors.push(Math.floor(meanGapMs / 3 / 1000))

  // `Math.min(maxIntervalSeconds, …)`:下限可以把自己顶到上限,但不能顶穿它。
  const lower = Math.min(maxIntervalSeconds, Math.max(...floors))

  // 漏收保护:别慢到一次窗口翻掉一半以上。
  let accuracyUpper = maxIntervalSeconds
  if (meanGapMs !== null && windowSize) {
    accuracyUpper = Math.min(accuracyUpper, Math.floor((meanGapMs * windowSize) / 2 / 1000))
  }
  // 窗口极小 + 更新极快时 accuracyUpper 可能低于下限,那时以下限为准(查得密不会漏)。
  // 两者都已被 maxIntervalSeconds 夹过,所以 upper ≤ maxIntervalSeconds 恒成立。
  const upper = Math.max(lower, accuracyUpper)
  interval = Math.min(upper, Math.max(lower, interval))

  // ── 抖动加在 next_due_at 上,不加在 tick 上(避免整点惊群)──
  const jitter = 0.9 + Math.random() * 0.2
  const nextDueAt = now + Math.round(interval * 1000 * jitter)

  return {
    intervalSec: Math.round(interval),
    nextDueAt,
    meanGapMs,
    windowSize,
    lastItemAt,
    lateDetected,
  }
}
