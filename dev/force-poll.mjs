/**
 * 测试用:强制让一个源立刻重新到期,并清掉它的去重记忆。
 *
 * 不给生产用。它的存在只是因为验证时需要一个"马上有新条目"的时刻,
 * 而正常节奏下要等到 next_due_at(可能是 32 小时后)。
 *
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<install>\DeepSeek Harness.exe" dev/force-poll.mjs [sourceId]
 *
 * @module @local/dsh-feed/dev/force-poll
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
  // 必须连条件请求的凭证一起清掉:只清 seen 的话下一轮会拿到 304,
  // 没有 body 就没有条目,投递路径根本不会被走到。
  store.db.prepare(`
    UPDATE sources
       SET next_due_at = 0, last_checked_at = NULL, etag = NULL, last_modified = NULL
     WHERE id = ?
  `).run(sourceId)
})

console.log(`sourceId=${sourceId}`)
console.log(`seen cleared: ${before} -> ${store.seen.countOf(sourceId)}`)
console.log(`next_due_at: ${store.sources.byId(sourceId).next_due_at} (due immediately)`)
console.log(`pending: ${store.pending.total()}`)
console.log('\n等待下一个 tick(默认 30s)。')

store.close()
