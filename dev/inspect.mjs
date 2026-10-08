/**
 * 开发用的库检视器 —— 从另一个进程看 Host 里的状态。
 *
 * Host 进程持着这个库(WAL 模式支持多读者),所以这里可以安全地只读查看。
 * `--force-due` 会把所有源的 next_due_at 置 0,用来立刻触发一次采集
 * (否则要等自适应出来的间隔,那可是 15 分钟以上)。
 *
 * 跑法:
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<install>\DeepSeek Harness.exe" dev/inspect.mjs [forceDue]
 *
 * 注意:参数**不能**写成 `--force-due`。Electron 自己的选项解析器会先吃掉它,
 * 报 `bad option: --force-due` 并且根本不跑脚本(表现为"零输出、没有退出码")。
 */

const sqlite = process.getBuiltinModule('node:sqlite')
const path = process.getBuiltinModule('node:path')
const os = process.getBuiltinModule('node:os')

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const file = path.join(home, 'dsh-feed', 'dsh-feed.db')

const db = new sqlite.DatabaseSync(file)
db.exec('PRAGMA busy_timeout = 5000')

const forceDue = process.argv.includes('forceDue')
if (forceDue) {
  const changed = db.prepare('UPDATE sources SET next_due_at = 0, updated_at = ?').run(Date.now())
  console.log(`forced ${changed.changes} source(s) due\n`)
}

const dump = (label, sql) => {
  const rows = db.prepare(sql).all()
  console.log(`── ${label} (${rows.length})`)
  for (const row of rows) console.log('  ' + JSON.stringify(row))
  if (rows.length === 0) console.log('  (none)')
  console.log()
}

dump('sources', `
  SELECT id, url, enabled, interval_sec, min_interval, max_interval,
         datetime(next_due_at/1000, 'unixepoch') AS next_due,
         substr(etag, 1, 18) AS etag, cond_hits, cond_misses,
         window_size, mean_gap_ms, failures, last_status, last_error,
         datetime(last_checked_at/1000, 'unixepoch') AS last_checked
  FROM sources ORDER BY created_at
`)

dump('monitors', `
  SELECT id, title, enabled, max_items, quiet_minutes, delivered_seq,
         json_extract(target_json, '$.sessionId') AS session,
         json_extract(match_json, '$') AS match
  FROM monitors ORDER BY created_at
`)

dump('pending', 'SELECT monitor_id, seq, source_id, substr(title, 1, 60) AS title FROM pending ORDER BY seq')

dump('seen per source', 'SELECT source_id, COUNT(*) AS keys FROM seen GROUP BY source_id')

dump('meta', 'SELECT key, value FROM meta ORDER BY key')

db.close()
