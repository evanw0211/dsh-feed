/**
 * 只读 dump:把 dsh-feed 的关键表打成表格。
 *
 * 这是 SQLite 相对 JSON 文档唯一的劣势(不能直接打开看)的补偿。
 *
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<install>\DeepSeek Harness.exe" dev/dump.mjs
 *
 * @module @local/dsh-feed/dev/dump
 */
import { openStore } from '../lib/store.js'
import { resolveStateDir, LEGACY_STATE_DIRNAME } from '../lib/log.js'

const fs = process.getBuiltinModule('node:fs')

const stateDir = resolveStateDir()
// 只读工具**不建库**。改名过渡期里 `dsh-feed/` 还没被插件建出来,在这里
// ensureDir + openStore 会先开出一个空库 —— 插件启动时的迁移判定是「两边都有库
// 就不搬」,于是旧库(feedwatch/)里的订阅永远用不上,而 dump 看到的却是个空表。
if (!fs.existsSync(stateDir)) {
  console.error(`state dir does not exist yet: ${stateDir}`)
  console.error(`(插件还没在新目录下启动过;改名前的旧布局在 $DSH_HOME/${LEGACY_STATE_DIRNAME}/)`)
  process.exit(1)
}
const store = openStore({ dir: stateDir })

const table = (rows, columns) => {
  if (rows.length === 0) return ['(empty)']
  const width = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)))
  const line = (cells) => cells.map((cell, i) => String(cell ?? '').padEnd(width[i])).join('  ')
  return [line(columns), line(width.map((w) => '-'.repeat(w))), ...rows.map((r) => line(columns.map((c) => r[c])))]
}

console.log(`db: ${store.file}\n`)

console.log('## sources')
console.log(table(store.sources.list().map((s) => ({
  id: s.id,
  title: String(s.title).slice(0, 24),
  interval: `${s.interval_sec}s`,
  next_due: new Date(Number(s.next_due_at)).toISOString().slice(5, 16),
  last: s.last_status ?? '-',
  fails: s.failures,
  cond: `${s.cond_hits}/${s.cond_misses}`,
  window: s.window_size ?? '-',
  seen: store.seen.countOf(s.id),
})), ['id', 'title', 'interval', 'next_due', 'last', 'fails', 'cond', 'window', 'seen']).join('\n'))

console.log('\n## monitors')
console.log(table(store.monitors.list().map((m) => ({
  id: m.id,
  title: String(m.title).slice(0, 24),
  on: m.enabled,
  match: String(m.match_json).slice(0, 34),
  target: String(JSON.parse(m.target_json ?? '{}').sessionId ?? '-').slice(0, 20),
  delivered: m.delivered_seq,
  pending: store.pending.list(m.id, 1000).length,
})), ['id', 'title', 'on', 'match', 'target', 'delivered', 'pending']).join('\n'))

console.log('\n## pending')
console.log(table(store.pending.counts().size === 0 ? [] : [...store.pending.counts()].map(([id, c]) => ({ monitor: id, undelivered: c })),
  ['monitor', 'undelivered']).join('\n'))

console.log(`\nseen total: ${store.sources.list().reduce((sum, s) => sum + store.seen.countOf(s.id), 0)}`)
console.log(`pending total: ${store.pending.total()}`)

store.close()
