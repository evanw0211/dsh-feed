/**
 * 回归探针:改名 `feedwatch` → `dsh-feed` 时的一次性状态迁移。
 *
 * 为什么必须钉死:迁移是**一次性**的 —— 上线那次 `apply()` 没搬成,用户看到的
 * 就是一个空库,订阅和规则像凭空消失。而它平时不会被任何用例覆盖
 * (只有「旧布局」这一个瞬间存在)。
 *
 * 覆盖:
 *   1. 旧目录 + 旧库名(`feedwatch/feedwatch.db`)→ 整目录搬到 `dsh-feed/`
 *   2. 目录已新、库名仍旧 → 同目录内换名,数据不动
 *   3. 两边都有库 → 拒绝覆盖,以当前目录为准,旧目录原样留着
 *   4. 目标目录已存在(只落了 apply.log)→ 逐个搬,跳过同名文件、不覆盖
 *
 * 跑法:普通 node 即可(本机 v24 自带 node:sqlite)。
 *   node dev/rename-migration-probe.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openStore } from '../lib/store.js'
import {
  DB_FILENAME,
  LEGACY_DB_FILENAME,
  LEGACY_STATE_DIRNAME,
  migrateLegacyStateDir,
  resolveStateDir,
} from '../lib/log.js'

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

const silent = { info() {}, warn() {}, error() {}, file: '' }

/** 造一个隔离的 DSH_HOME(迁移读的是这个环境变量)。 */
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-feed-rename-'))
  process.env.DSH_HOME = home
  return home
}

/** 用当前 store 在某目录里造一份真数据,返回库文件路径。 */
function seed(dir, url) {
  const store = openStore({ dir, log: silent })
  const now = Date.now()
  store.sources.insert({
    id: 'src_seed', url, title: 'Seed', intervalSec: 1800,
    minInterval: 900, maxInterval: 86400, nextDueAt: now, createdAt: now, updatedAt: now,
  })
  const file = store.file
  store.close()
  return file
}

/**
 * 把 `dsh-feed.db` 就地改名成 `feedwatch.db`,伪造出「改名前的磁盘布局」。
 * `-wal` / `-shm` 一起改,否则 SQLite 会从一个错位的 WAL 恢复。
 */
function toLegacyLayout(dir) {
  for (const suffix of ['', '-wal', '-shm']) {
    const from = path.join(dir, `${DB_FILENAME}${suffix}`)
    if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, `${LEGACY_DB_FILENAME}${suffix}`))
  }
  return path.join(dir, LEGACY_DB_FILENAME)
}

const urls = (store) => store.sources.list().map((row) => row.url)

// ── 1. 旧目录 + 旧库名:整目录搬家 ─────────────────────────────────────────
{
  const home = freshHome()
  const legacyDir = path.join(home, LEGACY_STATE_DIRNAME)
  fs.mkdirSync(legacyDir, { recursive: true })
  seed(legacyDir, 'https://rename.test/1')
  const oldFile = toLegacyLayout(legacyDir)

  const moved = migrateLegacyStateDir(resolveStateDir())
  const store = openStore({ dir: resolveStateDir(), log: silent })
  const rows = urls(store)

  equal('1 旧布局被认出来并搬家', moved.moved, true)
  equal('1 旧库文件名确实是 feedwatch.db', path.basename(oldFile), LEGACY_DB_FILENAME)
  check('1 新库落在 dsh-feed/dsh-feed.db', store.file.endsWith(path.join('dsh-feed', DB_FILENAME)), store.file)
  equal('1 订阅数据没丢', rows.join(), 'https://rename.test/1')
  check('1 旧目录已清空', !fs.existsSync(legacyDir))
  store.close()
}

// ── 2. 目录已新、库名仍旧:同目录换库名 ───────────────────────────────────
{
  const home = freshHome()
  const newDir = path.join(home, 'dsh-feed')
  fs.mkdirSync(newDir, { recursive: true })
  seed(newDir, 'https://rename.test/2')
  const oldFile = toLegacyLayout(newDir)

  const moved = migrateLegacyStateDir(resolveStateDir())
  const store = openStore({ dir: resolveStateDir(), log: silent })

  equal('2 目录级搬家不动手(目标目录已有库)', moved.reason, 'target-exists')
  equal('2 库名确实还是旧的', path.basename(oldFile), LEGACY_DB_FILENAME)
  equal('2 同目录换库名后数据仍在', urls(store).join(), 'https://rename.test/2')
  check('2 库文件已改名', store.file.endsWith(DB_FILENAME) && !fs.existsSync(path.join(newDir, LEGACY_DB_FILENAME)))
  store.close()
}

// ── 3. 两边都有库:不许覆盖当前目录 ──────────────────────────────────────
{
  const home = freshHome()
  const legacyDir = path.join(home, LEGACY_STATE_DIRNAME)
  fs.mkdirSync(legacyDir, { recursive: true })
  seed(legacyDir, 'https://rename.test/old')
  toLegacyLayout(legacyDir)
  const newDir = path.join(home, 'dsh-feed')
  fs.mkdirSync(newDir, { recursive: true })
  seed(newDir, 'https://rename.test/new')

  const moved = migrateLegacyStateDir(resolveStateDir())
  const store = openStore({ dir: resolveStateDir(), log: silent })

  equal('3 拒绝覆盖', moved.reason, 'target-exists')
  check('3 旧目录原样留着没被动', fs.existsSync(path.join(legacyDir, LEGACY_DB_FILENAME)))
  equal('3 当前目录的数据原样保留', urls(store).join(), 'https://rename.test/new')
  store.close()
}

// ── 4. 目标目录已存在但不含库:逐个搬,跳过同名文件 ──────────────────────
{
  const home = freshHome()
  const legacyDir = path.join(home, LEGACY_STATE_DIRNAME)
  fs.mkdirSync(legacyDir, { recursive: true })
  seed(legacyDir, 'https://rename.test/4')
  toLegacyLayout(legacyDir)
  fs.appendFileSync(path.join(legacyDir, 'apply.log'), '{"old":true}\n')
  const newDir = path.join(home, 'dsh-feed')
  fs.mkdirSync(newDir, { recursive: true })
  fs.appendFileSync(path.join(newDir, 'apply.log'), '{"new":true}\n')

  const moved = migrateLegacyStateDir(resolveStateDir())
  const store = openStore({ dir: resolveStateDir(), log: silent })
  const logText = fs.readFileSync(path.join(newDir, 'apply.log'), 'utf8')

  equal('4 走逐个搬', moved.mode, 'file-by-file')
  check('4 同名 apply.log 被跳过', moved.skipped.includes('apply.log'), JSON.stringify(moved.skipped))
  check('4 已有的 apply.log 没被覆盖', logText.includes('"new":true') && !logText.includes('"old":true'), logText.trim())
  equal('4 数据仍在', urls(store).join(), 'https://rename.test/4')
  store.close()
}

console.log(`\npassed: ${passed}`)
if (failures.length === 0) {
  console.log('all checks passed')
} else {
  console.log(`failed: ${failures.length}`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}
