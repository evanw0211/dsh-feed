/**
 * 测试用:强制让一个源**真的投递一次**。
 *
 * 与 force-poll.mjs 的区别:它把 `created_at` 也归零,于是
 * 「早于订阅时刻的条目当基线」这条规则不会吃掉任何东西 ——
 * 窗口里的每一条都会被判定为新条目,投递路径被完整走到。
 *
 * 用途只有一个:验证投递写出来的消息**形状合法**(带 id / role),
 * 因为重放一次坏消息会把会话日志写坏,而坏日志要到下次读取才暴露。
 *
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<install>\DeepSeek Harness.exe" dev/force-deliver.mjs [sourceId]
 *
 * @module @local/dsh-feed/dev/force-deliver
 */
import { openStore } from '../lib/store.js'
import { ensureDir, resolveStateDir } from '../lib/log.js'

const stateDir = resolveStateDir()
ensureDir(stateDir)
const store = openStore({ dir: stateDir })

const sourceId = process.argv[2] ?? store.sources.list()[0]?.id
if (sourceId === undefined) {
  console.error('no source to force')
  process.exit(1)
}

const before = store.seen.countOf(sourceId)

store.tx(() => {
  store.db.prepare('DELETE FROM seen WHERE source_id = ?').run(sourceId)
  store.db.prepare('DELETE FROM pending WHERE source_id = ?').run(sourceId)
  // `bootstrapped = 0` 与 `last_checked_at = NULL` 必须一起复位:
  // 基线门的判据是前者(schema v2),后者只是「上次检查时刻」。
  // 少复位 bootstrapped 的话,这一轮会被当成非首抓 —— 基线规则不会吃掉条目
  // (created_at=0 已经保证了),但判据本身就不再是「首抓」了。
  store.db.prepare(`
    UPDATE sources
       SET next_due_at = 0, last_checked_at = NULL, etag = NULL, last_modified = NULL,
           created_at = 0, bootstrapped = 0
     WHERE id = ?
  `).run(sourceId)
})

console.log(`sourceId=${sourceId}`)
console.log(`seen cleared: ${before} -> ${store.seen.countOf(sourceId)}`)
console.log('created_at=0 → 窗口内所有条目都算"新",基线规则不会吃掉它们')
console.log('等待下一个 tick(默认 30s)。')

store.close()
