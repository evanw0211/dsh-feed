/**
 * 探针:`stripHtml` 的净化结果。
 *
 * 背景:2026-09-30 那次投给模型的摘要是满屏 `<p>` `<a href=…>` ——
 * 因为 `stripHtml` 当时「先去标签、最后解实体」,而被转义的 HTML
 * (`&lt;p&gt;`)在去标签那一步根本匹配不到任何东西,随后又被解码还原成真标签。
 *
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<install>\DeepSeek Harness.exe" dev/sanitize-probe.mjs
 *
 * @module @local/dsh-feed/dev/sanitize-probe
 */
import { stripHtml } from '../lib/parse.js'

const cases = [
  {
    name: 'escaped HTML（RSS 的常态，就是它出过事）',
    input: '&lt;p&gt;Hello &lt;a href="x"&gt;link&lt;/a&gt;, world&lt;/p&gt;',
    want: 'Hello link, world',
  },
  {
    name: 'raw HTML（CDATA 源）',
    input: '<p>Hello <b>world</b></p>',
    want: 'Hello world',
  },
  {
    name: 'script / style 整块删掉，内容不许漏出来',
    input: '<p>a</p><script>evil()</script><style>.x{}</style><p>b</p>',
    want: 'a b',
  },
  {
    name: '二次转义 &amp;lt;…&amp;gt;',
    input: '&amp;lt;p&amp;gt;deep&amp;lt;/p&amp;gt;',
    want: 'deep',
  },
  {
    name: '注释',
    input: 'a<!-- hidden -->b',
    want: 'a b',
  },
  {
    name: '实体当文本保留（不能吃掉破折号/和号）',
    input: 'Rust &mdash; fast &amp; safe',
    want: 'Rust — fast & safe',
  },
  {
    name: '（已知取舍）正文里字面量写的 &lt;T&gt; 会被当成标签吃掉',
    input: 'the &lt;T&gt; generic',
    want: 'the generic',
  },
]

let bad = 0
for (const c of cases) {
  const got = stripHtml(c.input)
  const ok = got === c.want
  if (!ok) bad += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!ok) console.log(`        got  = ${JSON.stringify(got)}\n        want = ${JSON.stringify(c.want)}`)
}

console.log(`\n${cases.length - bad}/${cases.length} passed`)
process.exitCode = bad === 0 ? 0 : 1
