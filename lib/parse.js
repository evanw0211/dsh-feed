/**
 * 最小 feed 解析器:把 RSS 2.0 / Atom / RDF(RSS 1.0)归一化成同一种条目形状。
 *
 * 零依赖,自己扫 XML。feed 的结构非常简单(一个列表,每条几个已知子标签),
 * 为它引入一个 XML 解析器不划算。
 *
 * 归一化后的条目:
 *   { key, title, link, publishedAt, summary }
 *
 * @module @local/dsh-feed/lib/parse
 */

const crypto = process.getBuiltinModule('node:crypto')

/** 一次解析最多取多少条(防止恶意/畸形 feed 撑爆内存)。 */
const MAX_ITEMS = 200
/** 单个字段保留多少字符。 */
const MAX_FIELD = 8000
/** summary 默认截断长度。 */
export const DEFAULT_EXCERPT_CHARS = 1200

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  trade: '™',
}

/**
 * 解 XML/HTML 实体。
 * @param input - 含实体的文本
 * @returns 解码后的文本
 */
export function decodeEntities(input) {
  if (typeof input !== 'string' || input.indexOf('&') === -1) return input
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? whole : named
  })
}

/**
 * 单个字段最多扫多少字符。
 *
 * 摘要最终只用 `excerptChars`(默认 1200),`MAX_FIELD` 也才 8000,所以对原始 HTML
 * 留 64KB 余量足够。这是**纵深防御**:二次方扫描已经换成线性扫描,但单块极大时
 * 每轮仍要走一遍全文,而多出来的字符一个都不会进摘要。
 */
const MAX_HTML_SCAN = 64 * 1024

const isSpace = (code) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d

/**
 * 在 `lower`(text 的小写副本)里,从 `from` 起找一个**开始标签**。
 *
 * `allowSlash` 决定 `<tag/>` 算不算开始标签 —— 要与原来那几条正则的写法一致:
 * stripHtml 的 `<(script|style)\b[^>]*>` 认,`blocksOf` / `tagText` 的
 * `<${tag}(?:\s[^>]*)?>` 不认。
 *
 * @returns `{ start, openEnd }`(`openEnd` 是开始标签 `>` 的下标);找不到返回 null
 */
function findOpenTag(lower, tag, from, allowSlash = false) {
  const needle = `<${tag}`
  let at = from
  for (;;) {
    const start = lower.indexOf(needle, at)
    if (start === -1) return null
    const next = lower.charCodeAt(start + needle.length)
    let openEnd = -1
    if (next === 0x3e) openEnd = start + needle.length
    else if (isSpace(next)) openEnd = lower.indexOf('>', start + needle.length)
    else if (allowSlash && next === 0x2f && lower.charCodeAt(start + needle.length + 1) === 0x3e) {
      openEnd = start + needle.length + 1
    }
    if (openEnd === -1) {
      at = start + needle.length
      continue
    }
    return { start, openEnd }
  }
}

/** 从 `from` 起找 `</tag\s*>`。返回 `{ start, end }`(`end` 是 `>` 的下标)或 null。 */
function findCloseTag(lower, tag, from) {
  const needle = `</${tag}`
  let at = from
  for (;;) {
    const start = lower.indexOf(needle, at)
    if (start === -1) return null
    let i = start + needle.length
    while (isSpace(lower.charCodeAt(i))) i += 1
    if (lower.charCodeAt(i) === 0x3e) return { start, end: i }
    at = start + needle.length
  }
}

/**
 * 删掉成对的块标签(script / style),用**顺序扫描**而不是惰性正则。
 *
 * 原写法 `/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi` 在「大量开始标签、
 * 没有结束标签」时退化成 O(n²):实测 879KB 全为 `<script>` 要 39.7 秒、
 * 全为 `<style>` 要 95.6 秒。解析是同步的、跑在 Electron 主线程上
 * (`lib/store.js` 写明了这条约束),期间整个 GUI 冻结 —— 而每个采集轮次都会重跑。
 *
 * 找不到结束标签时**保留原文**(与惰性正则不匹配时的行为一致),并且可以直接停:
 * 从这里往后不会再有结束标签,后面的开始标签也不可能配对。
 */
function dropPairedBlocks(text, tag) {
  const lower = text.toLowerCase()
  let out = ''
  let cursor = 0
  for (;;) {
    const open = findOpenTag(lower, tag, cursor, true)
    if (open === null) break
    const close = findCloseTag(lower, tag, open.openEnd + 1)
    if (close === null) break
    out += `${text.slice(cursor, open.start)} `
    cursor = close.end + 1
  }
  return out + text.slice(cursor)
}

/** 删掉注释。同样不能用 `<!--[\s\S]*?-->`:实测 879KB 的 `<!--` 超过 7 分钟没跑完。 */
function dropComments(text) {
  let out = ''
  let cursor = 0
  for (;;) {
    const start = text.indexOf('<!--', cursor)
    if (start === -1) break
    const end = text.indexOf('-->', start + 4)
    if (end === -1) break
    out += `${text.slice(cursor, start)} `
    cursor = end + 3
  }
  return out + text.slice(cursor)
}

/**
 * 删掉 `<…>` 形式的标签。
 *
 * 手写扫描,不用 `/<[^>]*>/g` —— 全局正则遇到「大量 `<` 而没有 `>`」同样是 O(n²):
 * 实测 64KB 的 `<!--<!--…` 要 934ms(每个 `<` 都扫到串尾才发现没有 `>`),
 * 而截断上限是 64KB、一个 feed 里可以有很多个字段。
 * 没有 `>` 时原正则不匹配,所以后面也不会再有匹配,可以直接停。
 */
function dropTags(text) {
  let out = ''
  let cursor = 0
  for (;;) {
    const start = text.indexOf('<', cursor)
    if (start === -1) break
    const end = text.indexOf('>', start + 1)
    if (end === -1) break
    out += `${text.slice(cursor, start)} `
    cursor = end + 1
  }
  return out + text.slice(cursor)
}

/**
 * 去掉 HTML 标签并折叠空白。
 *
 * **解码与去标签必须交替做,而且要从解码开始。**
 *
 * 多数 RSS/Atom 源的 `description` / `content` 里装的是**被转义的 HTML**
 * (`&lt;p&gt;…&lt;/p&gt;`)。先去标签的话,正则看到的只是普通文本、一个标签也匹配不到;
 * 之后解码又把标记原样还原进正文 —— 实测投给模型的摘要里全是 `<p>`、`<a href=…>`、
 * `<span class="giallo-l">`,而且把一次投递的字符预算吃光,少投了一条。
 *
 * 反过来(先解码再去标签)的代价:正文里本来就写成 `&lt;T&gt;` 的**字面量**
 * 会被当成标签吃掉。这个损失是外观级的,而反过来的损失是「整段是标记 + 预算翻倍」,
 * 所以选前者。
 *
 * 跑两轮是因为存在二次转义(`&amp;lt;p&amp;gt;`)。
 *
 * 性能:script/style 的整块删除、注释删除与普通标签删除都是线性扫描
 * (见 dropPairedBlocks / dropComments / dropTags),入口再按 `MAX_HTML_SCAN` 截断一次。
 *
 * @param input - 原始 HTML 片段
 * @returns 纯文本
 */
export function stripHtml(input) {
  if (typeof input !== 'string') return ''
  let text = input
  if (text.length > MAX_HTML_SCAN) {
    text = text.slice(0, MAX_HTML_SCAN)
    // 截断可能把一个标签切成两半,丢掉那个没有 `>` 的尾巴。
    const lastOpen = text.lastIndexOf('<')
    if (lastOpen !== -1 && text.indexOf('>', lastOpen) === -1) text = text.slice(0, lastOpen)
  }
  // script/style 与注释要先整块删掉,且必须先于解码 —— 否则解码出来的脚本
  // 会重新变回标签被下一轮的去标签处理掉,但它中间的文本会漏出来。
  text = dropPairedBlocks(text, 'script')
  text = dropPairedBlocks(text, 'style')
  text = dropComments(text)
  for (let round = 0; round < 2; round += 1) {
    text = decodeEntities(text)
    text = dropTags(text)
  }
  text = text.replace(/\s+/g, ' ')
  // 标签被换成空格后会留下 "link , world" 这种空隙,收一下。
  text = text.replace(/\s+([,.;:!?%)\]])/g, '$1')
  return text.trim()
}

/** 取出 CDATA 内容,没有 CDATA 就返回去标签后的文本。 */
function textOf(raw) {
  if (typeof raw !== 'string') return ''
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw)
  if (cdata) return cdata[1].trim()
  return raw.trim()
}

/**
 * 找某个标签的**第一个**完整块的内容;没有配对返回 null。
 *
 * 与惰性正则 `[\\s\\S]*?` 的语义一致:从第一个开始标签配到它之后的第一个结束标签。
 * 区别只是**线性** —— 原正则在「大量开始标签、没有结束标签」时是 O(n²)
 * (实测 200KB 全是 `<item>` 要 4.9 秒;`maxBodyBytes` 是 1MB,线性放大到约 2 分钟)。
 */
function firstBlockOf(xml, tag) {
  const lower = xml.toLowerCase()
  const open = findOpenTag(lower, tag, 0)
  if (open === null) return null
  const close = findCloseTag(lower, tag, open.openEnd + 1)
  if (close === null) return null
  return xml.slice(open.openEnd + 1, close.start)
}

/** 找某个标签的所有完整块(允许带命名空间前缀的调用方自行传入完整名)。 */
function blocksOf(xml, tag) {
  const lower = xml.toLowerCase()
  const out = []
  let cursor = 0
  for (;;) {
    const open = findOpenTag(lower, tag, cursor)
    if (open === null) break
    const close = findCloseTag(lower, tag, open.openEnd + 1)
    // 从这里往后没有结束标签了 → 后面的开始标签也不可能配对(原正则同样不匹配)。
    if (close === null) break
    out.push(xml.slice(open.openEnd + 1, close.start))
    if (out.length >= MAX_ITEMS) break
    cursor = close.end + 1
  }
  return out
}

/**
 * 取一个标签的文本内容(第一次出现)。
 * @param block - 所属块
 * @param tag - 标签名,可含命名空间前缀
 * @returns 去标签、解实体后的文本,找不到返回空串
 */
function tagText(block, tag) {
  const content = firstBlockOf(block, tag)
  if (content === null) return ''
  return stripHtml(textOf(content)).slice(0, MAX_FIELD)
}

/**
 * 在一个**已经切好的**标签区间(`<tag …>`)里取属性值。
 * @returns 属性值(已解实体、已 trim);没有这个属性返回 null(注意 `attr=""` 是空串,不是 null)
 */
function attrValueIn(region, attr) {
  const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
  const match = re.exec(region)
  if (match === null) return null
  return decodeEntities(match[2] ?? match[3] ?? '').trim()
}

/**
 * 取一个标签的属性值。
 *
 * 与原来的 `<${tag}\b[^>]*?\b${attr}\s*=…` 一致:按文档顺序找**第一个**带该属性的
 * 标签(第一个标签没有就继续看下一个),属性只在它自己的 `<…>` 区间里找。
 *
 * @param block - 所属块
 * @param tag - 标签名
 * @param attr - 属性名
 * @returns 属性值(已解实体),找不到返回空串
 */
function tagAttr(block, tag, attr) {
  const lower = block.toLowerCase()
  let cursor = 0
  for (;;) {
    const open = findOpenTag(lower, tag, cursor, true)
    if (open === null) return ''
    const value = attrValueIn(block.slice(open.start, open.openEnd + 1), attr)
    if (value !== null) return value
    cursor = open.openEnd + 1
  }
}

/** 是否有某个标签(含自闭合形式)。 */
function hasTag(xml, tag) {
  return findOpenTag(xml.toLowerCase(), tag, 0, true) !== null
}

/**
 * Atom 的 link:优先 `rel="alternate"`,否则第一个带 href 的。
 * Atom 里 `<link>` 是自闭合的,与 RSS 的文本型 `<link>` 不同。
 */
function atomLink(entry) {
  const lower = entry.toLowerCase()
  let cursor = 0
  let fallback = null
  for (;;) {
    const open = findOpenTag(lower, 'link', cursor, true)
    if (open === null) return fallback ?? ''
    const region = entry.slice(open.start, open.openEnd + 1)
    const rel = attrValueIn(region, 'rel')
    const href = attrValueIn(region, 'href')
    if (rel !== null && rel.toLowerCase() === 'alternate' && href !== null) return href
    if (fallback === null && href !== null) fallback = href
    cursor = open.openEnd + 1
  }
}

/** 由标题+摘要算内容指纹,作为没有 guid/link 时的身份兜底。 */
function contentHash(title, summary) {
  return `sha1:${crypto.createHash('sha1').update(`${title}\u0000${summary}`).digest('hex').slice(0, 32)}`
}

/**
 * 归一化单条条目,并算出它的身份 key。
 *
 * 身份优先级:`guid`/`id` → `link` → 内容指纹。
 * **绝不用发布时间当身份** —— 实测 Cloudflare 20 条里 13 条时间戳完全相同,
 * OpenAI 1238 条里 259 条重复,用它去重会把多篇认成一篇。
 *
 * @param raw - 已抽出的字段
 * @returns 归一化条目,或 null(标题和链接都没有,无法识别)
 */
function normalizeItem(raw) {
  const title = raw.title.slice(0, MAX_FIELD)
  const link = raw.link.slice(0, MAX_FIELD)
  const summary = raw.summary.slice(0, MAX_FIELD)
  if (title === '' && link === '') return null

  const guid = raw.guid.slice(0, MAX_FIELD)
  let key
  if (guid !== '') key = `g:${guid}`
  else if (link !== '') key = `l:${link}`
  else key = contentHash(title, summary)

  return {
    key,
    title: title === '' ? link : title,
    link,
    publishedAt: raw.publishedAt.slice(0, MAX_FIELD),
    summary,
  }
}

/**
 * 解析一个 feed 文档。
 *
 * @param xml - 响应正文
 * @param excerptChars - summary 截断长度
 * @returns `{ format, title, items, ttlSeconds }`;无法识别时 format 为 `unknown` 且 items 为空
 */
export function parseFeed(xml, excerptChars = DEFAULT_EXCERPT_CHARS) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    return { format: 'unknown', title: '', items: [], truncated: false, windowSize: 0, ttlSeconds: null }
  }

  // 只从文档**开头**嗅探格式。根元素一定在最前面;而正文里可能出现字面量
  // `<feed>` / `<rss>`(转义过的不会,但确实有人把 XML 原样塞进 CDATA),
  // 扫全文会误判。Miniflux 的 Detector 也是只读一个前缀。
  const head = xml.slice(0, 4096)

  // 格式由**根元素**决定,**不要求**已经出现 `<item>` / `<entry>`。
  //
  // 这一点是 Miniflux 的 format_test.go 抓出来的:按「有没有条目」判断的话,
  // 一个结构合法但暂时没有内容的 feed(新博客、刚被清空)会被判成「无法识别」,
  // 进而被记成解析失败、`failures` 一路累计 —— 一个健康的源被标记成坏源。
  const isRdf = /<rdf:RDF\b/i.test(head) || /<rss[^>]*version\s*=\s*["']1\.0["']/i.test(head)
  const isAtom = /<feed\b/i.test(head)
  const isRss = /<rss\b/i.test(head) || hasTag(head, 'item')

  const format = isAtom ? 'atom' : isRdf ? 'rdf' : isRss ? 'rss' : 'unknown'
  if (format === 'unknown') {
    return { format, title: '', items: [], truncated: false, windowSize: 0, ttlSeconds: null }
  }

  // 频道标题:RSS/RDF 在 <channel> 里,Atom 直接在 <feed> 里。
  // 走线性扫描,不用 `<channel\b[^>]*>([\s\S]*?)<\/channel\s*>` —— 同一类二次方退化。
  let title = ''
  const channel = firstBlockOf(xml, 'channel')
  title = channel === null ? tagText(xml, 'title') : tagText(channel, 'title')

  // 频道级 <ttl>(RSS 2.0,单位**分钟**):源自己声明「不必查得比我更新更快」。
  // 语义与 Cache-Control: max-age 同类,但它写在 feed 里 —— 不少静态博客只声明这个、
  // 完全不发缓存头。取不到就是 null,由节奏层忽略。
  let ttlSeconds = null
  if (channel !== null) {
    const minutes = Number.parseInt(tagText(channel, 'ttl'), 10)
    if (Number.isFinite(minutes) && minutes > 0) ttlSeconds = minutes * 60
  }

  const entryTag = format === 'atom' ? 'entry' : 'item'
  const raws = blocksOf(xml, entryTag)

  const items = []
  let truncated = false
  for (const block of raws) {
    const raw = format === 'atom'
      ? {
          guid: tagText(block, 'id'),
          title: tagText(block, 'title'),
          link: atomLink(block),
          publishedAt: tagText(block, 'published') || tagText(block, 'updated'),
          summary: tagText(block, 'summary') || tagText(block, 'content'),
        }
      : {
          guid: tagText(block, 'guid'),
          title: tagText(block, 'title'),
          link: tagText(block, 'link'),
          publishedAt: tagText(block, 'pubDate') || tagText(block, 'dc:date'),
          summary: tagText(block, 'description') || tagText(block, 'content:encoded'),
        }

    const item = normalizeItem(raw)
    if (item === null) continue
    if (item.summary.length > excerptChars) {
      item.summary = `${item.summary.slice(0, excerptChars)}…`
      truncated = true
    }
    items.push(item)
  }

  return { format, title, items, truncated, windowSize: items.length, ttlSeconds }
}
