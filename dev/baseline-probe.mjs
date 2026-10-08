/**
 * 探针:`splitBaseline` 的边界行为。
 *
 * 要钉死三点:
 *   1. 早于订阅时刻的 → 基线(不投递)
 *   2. 晚于订阅时刻的 → 投递(否则"不倒历史"会变成"永远不投")
 *   3. 没有日期的 → 保守当基线(宁可漏一条,不倒一屏)
 *
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<install>\DeepSeek Harness.exe" dev/baseline-probe.mjs
 *
 * @module @local/dsh-feed/dev/baseline-probe
 */
import { parseDate, splitBaseline } from '../lib/feed.js'

const subscribedAt = parseDate('Fri, 01 May 2026 00:00:00 GMT')

const items = [
  { key: 'archived', publishedAt: 'Fri, 01 Jan 2026 00:00:00 GMT' },
  { key: 'just-before', publishedAt: 'Thu, 30 Apr 2026 23:59:59 GMT' },
  { key: 'just-after', publishedAt: 'Fri, 01 May 2026 00:00:01 GMT' },
  { key: 'later', publishedAt: 'Fri, 18 Sep 2026 00:00:00 GMT' },
  { key: 'no-date', publishedAt: '' },
  { key: 'garbage-date', publishedAt: 'not a date' },
]

const { baseline, deliver } = splitBaseline(items, subscribedAt)

const got = (list) => list.map((item) => item.key).join(',')
const wantBaseline = 'archived,just-before,no-date,garbage-date'
const wantDeliver = 'just-after,later'

console.log(`subscribedAt = ${new Date(subscribedAt).toISOString()}`)
console.log(`baseline = ${got(baseline)}`)
console.log(`deliver  = ${got(deliver)}`)

const ok = got(baseline) === wantBaseline && got(deliver) === wantDeliver
console.log(ok ? '\nPASS' : `\nFAIL  want baseline=${wantBaseline} deliver=${wantDeliver}`)
process.exitCode = ok ? 0 : 1
