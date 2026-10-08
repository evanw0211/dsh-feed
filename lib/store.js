/**
 * SQLite 存储层。
 *
 * 用 `node:sqlite`(Node 24 内置,实测不需要任何 flag),所以**零依赖** ——
 * profile bundle 不能 import dsh 包或 zod,但内置模块不受这条约束。
 *
 * 为什么不是 JSON 文档:去重记忆(每源约 90 个身份 × 30 源)会让文档涨到 ~160KB,
 * 而整单重写意味着每轮采集都要重写这 160KB。
 *
 * 硬约束:`DatabaseSync` 是**同步** API,跑在 Electron 主线程上。
 * 所以**只做索引点查,禁止全表扫,批量写包事务**。
 *
 * @module @local/dsh-feed/lib/store
 */

import { DB_FILENAME, LEGACY_DB_FILENAME } from './log.js'

const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')

/** 每源保留的去重身份条数。 */
export const SEEN_KEEP_PER_SOURCE = 200

const SCHEMA_VERSION = 2

/**
 * 按序执行的迁移。数组下标 i 执行后版本为 i+1。
 * 只在版本落后时跑,整批包在一个事务里。
 */
const MIGRATIONS = [
  // → v1
  (db) => {
    db.exec(`
      CREATE TABLE sources (
        id             TEXT PRIMARY KEY,
        url            TEXT NOT NULL UNIQUE,
        title          TEXT NOT NULL,
        adapter        TEXT NOT NULL DEFAULT 'feed',
        enabled        INTEGER NOT NULL DEFAULT 1,
        interval_sec   INTEGER NOT NULL,
        min_interval   INTEGER NOT NULL,
        max_interval   INTEGER NOT NULL,
        next_due_at    INTEGER NOT NULL,
        etag           TEXT,
        last_modified  TEXT,
        cond_hits      INTEGER NOT NULL DEFAULT 0,
        cond_misses    INTEGER NOT NULL DEFAULT 0,
        cdn_max_age    INTEGER,
        window_size    INTEGER,
        mean_gap_ms    INTEGER,
        failures       INTEGER NOT NULL DEFAULT 0,
        last_status    TEXT,
        last_error     TEXT,
        last_checked_at INTEGER,
        last_item_at   INTEGER,
        late_detected  INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_sources_due ON sources (enabled, next_due_at);

      CREATE TABLE seen (
        source_id  TEXT NOT NULL,
        item_key   TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        PRIMARY KEY (source_id, item_key)
      ) WITHOUT ROWID;
      CREATE INDEX idx_seen_age ON seen (source_id, first_seen);

      CREATE TABLE monitors (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        match_json    TEXT NOT NULL,
        quiet_minutes INTEGER NOT NULL DEFAULT 0,
        max_items     INTEGER NOT NULL DEFAULT 20,
        target_json   TEXT NOT NULL,
        delivered_seq INTEGER NOT NULL DEFAULT 0,
        last_delivery INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE monitor_sources (
        monitor_id TEXT NOT NULL,
        source_id  TEXT NOT NULL,
        PRIMARY KEY (monitor_id, source_id)
      ) WITHOUT ROWID;
      CREATE INDEX idx_ms_source ON monitor_sources (source_id);

      CREATE TABLE pending (
        monitor_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        source_id  TEXT NOT NULL,
        item_key   TEXT NOT NULL,
        title      TEXT NOT NULL,
        link       TEXT,
        published  TEXT,
        summary    TEXT,
        PRIMARY KEY (monitor_id, seq)
      ) WITHOUT ROWID;
    `)
  },
  // → v2
  (db) => {
    // 显式的「第一次**成功**抓取完成了」标志。
    //
    // 原来用 `last_checked_at === null` 表示这件事,但 updateAfterPoll 在任何 outcome
    // 下都会写 last_checked_at —— 于是首次抓取只要失败一次(离线、DNS 抖动、5xx、
    // 429、超时、超 maxBodyBytes),这个源就**永久**拿不到基线处理,下一次成功抓取
    // 会把窗口内全部条目当新条目投给模型(实测 pending=20,对照为 0)。
    // 用一列专表其意:它只会在 `outcome === 'ok'` 的轮次里 0 → 1,失败轮次不碰它。
    db.exec('ALTER TABLE sources ADD COLUMN bootstrapped INTEGER NOT NULL DEFAULT 0')
    // 回填:已经在跑的源都成功抓过至少一次,必须标成已引导 ——
    // 否则升级后它们的下一次成功抓取会被重判成首抓,反而倒一次历史。
    db.exec('UPDATE sources SET bootstrapped = 1 WHERE last_checked_at IS NOT NULL')
  },
]

/** SQLite 只吃 null / number / string / bigint / Uint8Array;布尔必须转成 0|1。 */
const int = (value) => (value ? 1 : 0)
const orNull = (value) => (value === undefined || value === '' ? null : value)

/**
 * 打开数据库。打不开就备份并重建,绝不静默清空。
 *
 * @param file - 数据库路径
 * @param log - 面包屑记录器
 * @returns DatabaseSync 实例
 */
function openDatabase(file, log) {
  let sqlite
  try {
    sqlite = process.getBuiltinModule('node:sqlite')
  } catch (error) {
    throw new Error(`node:sqlite unavailable: ${error?.message ?? error}`)
  }

  const prepare = () => {
    const db = new sqlite.DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('SELECT 1')
    return db
  }

  try {
    return prepare()
  } catch (error) {
    // 损坏 → 备份到一边,重建空库。上一轮 fs-local-fix 的教训:绝不静默。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const moved = []
    for (const suffix of ['', '-wal', '-shm']) {
      const from = `${file}${suffix}`
      if (!fs.existsSync(from)) continue
      const to = `${file}.corrupt-${stamp}${suffix}`
      try {
        fs.renameSync(from, to)
        moved.push(path.basename(to))
      } catch {
        /* 备份不了就继续尝试重建 */
      }
    }
    log?.error('database unreadable; backed up and recreating', {
      file,
      error: String(error?.message ?? error),
      backedUp: moved,
    })
    return prepare()
  }
}

/**
 * 同一个状态目录里换库名:`feedwatch.db` → `dsh-feed.db`。
 *
 * 目录级搬家见 `lib/log.js` 的 `migrateLegacyStateDir`。这一层挡的是它盖不住的
 * 中间态:**目录已经是新的、库名还是旧的**(比如代码分两次生效)。这时若直接开
 * 新名字,就会开出一个空库 —— 订阅数据看着像凭空消失。两边都在时以新名字为准,
 * 绝不覆盖。`-wal` / `-shm` 必须跟着一起走,否则 SQLite 会从一个错位的 WAL 恢复。
 *
 * @param dir - 状态目录
 * @param file - 当前应当使用的库文件路径
 * @param log - 面包屑记录器
 * @returns 实际应当打开的库文件路径
 */
function adoptLegacyDatabase(dir, file, log) {
  const legacy = path.join(dir, LEGACY_DB_FILENAME)
  try {
    if (fs.existsSync(file) || !fs.existsSync(legacy)) return file
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(`${legacy}${suffix}`)) fs.renameSync(`${legacy}${suffix}`, `${file}${suffix}`)
    }
    log?.info('database renamed', { from: LEGACY_DB_FILENAME, to: DB_FILENAME })
    return file
  } catch (error) {
    // 搬不动就用旧库名继续跑:开得了库、不丢数据,比强上新名字重要。
    log?.warn('database rename failed; falling back to the legacy name', {
      error: String(error?.message ?? error),
    })
    return fs.existsSync(legacy) && !fs.existsSync(file) ? legacy : file
  }
}

/**
 * 打开本插件的存储。
 *
 * @param options.dir - 状态目录(数据库放在其下)
 * @param options.log - 面包屑记录器
 * @returns 存储句柄
 */
export function openStore({ dir, log }) {
  const file = path.join(dir, DB_FILENAME)
  adoptLegacyDatabase(dir, file, log)
  const db = openDatabase(file, log)

  // meta 必须先存在,迁移版本才读得到。
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')

  const readVersion = () => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    return row === undefined ? 0 : Number(row.value)
  }
  const writeVersion = (value) => {
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('schema_version', String(value))
  }

  const from = readVersion()
  if (from > SCHEMA_VERSION) {
    throw new Error(`database schema v${from} is newer than this plugin (v${SCHEMA_VERSION})`)
  }
  if (from < SCHEMA_VERSION) {
    db.exec('BEGIN')
    try {
      for (let version = from; version < SCHEMA_VERSION; version += 1) {
        MIGRATIONS[version](db)
      }
      writeVersion(SCHEMA_VERSION)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    log?.info('schema migrated', { from, to: SCHEMA_VERSION })
  }

  /** 取全局到达序号的下一个值。 */
  const nextSeq = () => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('next_seq')
    const current = row === undefined ? 0 : Number(row.value)
    const next = current + 1
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('next_seq', String(next))
    return next
  }

  /** 把一批写操作包进一个事务;抛错则回滚。 */
  const tx = (work) => {
    db.exec('BEGIN')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 回滚失败时保留原始错误 */
      }
      throw error
    }
  }

  const sources = {
    list: () => db.prepare('SELECT * FROM sources ORDER BY created_at').all(),
    byId: (id) => db.prepare('SELECT * FROM sources WHERE id = ?').get(id),
    byUrl: (url) => db.prepare('SELECT * FROM sources WHERE url = ?').get(url),
    /** 到点的源 —— 每个 tick 的热路径,走 idx_sources_due。 */
    due: (now, limit = 8) =>
      db.prepare(
        'SELECT * FROM sources WHERE enabled = 1 AND next_due_at <= ? ORDER BY next_due_at LIMIT ?',
      ).all(now, limit),
    count: () => Number(db.prepare('SELECT COUNT(*) AS c FROM sources').get().c),

    insert: (record) =>
      db.prepare(`
        INSERT INTO sources (
          id, url, title, adapter, enabled, interval_sec, min_interval, max_interval,
          next_due_at, etag, last_modified, cond_hits, cond_misses,
          cdn_max_age, window_size, mean_gap_ms, failures, last_status, last_error,
          last_checked_at, last_item_at, late_detected, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        record.id, record.url, record.title, record.adapter ?? 'feed', int(record.enabled !== false),
        record.intervalSec, record.minInterval, record.maxInterval, record.nextDueAt,
        orNull(record.etag), orNull(record.lastModified), record.condHits ?? 0, record.condMisses ?? 0,
        orNull(record.cdnMaxAge), orNull(record.windowSize), orNull(record.meanGapMs),
        record.failures ?? 0, orNull(record.lastStatus), orNull(record.lastError),
        orNull(record.lastCheckedAt), orNull(record.lastItemAt), int(record.lateDetected),
        record.createdAt, record.updatedAt,
      ),

    /** 只更新采集周期里会变的那几列。 */
    updateAfterPoll: (id, patch, now) =>
      db.prepare(`
        UPDATE sources SET
          interval_sec = ?, next_due_at = ?, etag = ?, last_modified = ?,
          cond_hits = ?, cond_misses = ?, cdn_max_age = ?, window_size = ?,
          mean_gap_ms = ?, failures = ?, last_status = ?, last_error = ?,
          last_checked_at = ?, last_item_at = ?, late_detected = ?,
          bootstrapped = COALESCE(?, bootstrapped),
          updated_at = ?
        WHERE id = ?
      `).run(
        patch.intervalSec, patch.nextDueAt, orNull(patch.etag), orNull(patch.lastModified),
        patch.condHits ?? 0, patch.condMisses ?? 0, orNull(patch.cdnMaxAge), orNull(patch.windowSize),
        orNull(patch.meanGapMs), patch.failures ?? 0, orNull(patch.lastStatus), orNull(patch.lastError),
        now, orNull(patch.lastItemAt), int(patch.lateDetected),
        // COALESCE + undefined → null:调用方不传时**保持原值**,
        // 绝不能因为一次失败轮次把已经置上的引导标志抹回 0。
        patch.bootstrapped === undefined ? null : int(patch.bootstrapped),
        now, id,
      ),

    setEnabled: (id, enabled, now) =>
      db.prepare('UPDATE sources SET enabled = ?, updated_at = ? WHERE id = ?').run(int(enabled), now, id),
    touch: (id, title, now) =>
      db.prepare('UPDATE sources SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id),
    remove: (id) => db.prepare('DELETE FROM sources WHERE id = ?').run(id),
  }

  const seen = {
    /** 一个源已见过的全部身份。有界(见 prune),所以直接载入内存比对最快。 */
    keysOf: (sourceId) =>
      new Set(db.prepare('SELECT item_key FROM seen WHERE source_id = ?').all(sourceId).map((r) => r.item_key)),
    addMany: (sourceId, keys, now) => {
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO seen (source_id, item_key, first_seen) VALUES (?, ?, ?)',
      )
      for (const key of keys) stmt.run(sourceId, key, now)
    },
    /**
     * 「记下已见」并**同时**回答「它是不是新的」—— 一次原子写,而不是先读集合再在 JS 里比对。
     *
     * 为什么必须这样做:实测出现过「`seen` 表里明明有这 10 条身份,下一次抓取却把 10 条
     * 全报成新的」并且重复投递。读集合 + 内存比对把「判断」和「记账」分成了两个时刻,
     * 期间任何快照差异、重复实例或重载都会让判断看到空的旧集合。
     * 依赖 `INSERT OR IGNORE` 的 `changes` 把两者合成一个原子动作,SQLite 自己保证串行。
     *
     * @returns true 表示这条身份**此前没见过**(也就是真的新条目)
     */
    markSeen: (sourceId, key, now) => {
      const result = db.prepare(
        'INSERT OR IGNORE INTO seen (source_id, item_key, first_seen) VALUES (?, ?, ?)',
      ).run(sourceId, key, now)
      return Number(result.changes) === 1
    },
    /** 每源只保留最新 N 条,防止无限增长。 */
    prune: (sourceId, keep = SEEN_KEEP_PER_SOURCE) =>
      db.prepare(`
        DELETE FROM seen WHERE source_id = ? AND item_key NOT IN (
          SELECT item_key FROM seen WHERE source_id = ? ORDER BY first_seen DESC LIMIT ?
        )
      `).run(sourceId, sourceId, keep),
    countOf: (sourceId) =>
      Number(db.prepare('SELECT COUNT(*) AS c FROM seen WHERE source_id = ?').get(sourceId).c),
  }

  const monitors = {
    list: () => db.prepare('SELECT * FROM monitors ORDER BY created_at').all(),
    byId: (id) => db.prepare('SELECT * FROM monitors WHERE id = ?').get(id),
    /** 反查:谁在盯着这个源。走 idx_ms_source,每次抓到新条目都要跑。 */
    forSource: (sourceId) =>
      db.prepare(`
        SELECT m.* FROM monitors m
        JOIN monitor_sources ms ON ms.monitor_id = m.id
        WHERE ms.source_id = ? AND m.enabled = 1
      `).all(sourceId),
    count: () => Number(db.prepare('SELECT COUNT(*) AS c FROM monitors').get().c),

    upsert: (record) => {
      db.prepare(`
        INSERT INTO monitors (
          id, title, enabled, match_json, quiet_minutes, max_items, target_json,
          delivered_seq, last_delivery, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title, enabled = excluded.enabled, match_json = excluded.match_json,
          quiet_minutes = excluded.quiet_minutes, max_items = excluded.max_items,
          target_json = excluded.target_json, updated_at = excluded.updated_at
      `).run(
        record.id, record.title, int(record.enabled !== false), JSON.stringify(record.match ?? {}),
        record.quietMinutes ?? 0, record.maxItems ?? 20, JSON.stringify(record.target),
        record.deliveredSeq ?? 0, orNull(record.lastDelivery),
        record.createdAt ?? Date.now(), record.updatedAt ?? Date.now(),
      )
      db.prepare('DELETE FROM monitor_sources WHERE monitor_id = ?').run(record.id)
      const link = db.prepare(
        'INSERT OR IGNORE INTO monitor_sources (monitor_id, source_id) VALUES (?, ?)',
      )
      for (const sourceId of record.sources ?? []) link.run(record.id, sourceId)
    },

    markDelivered: (id, seq, now) =>
      db.prepare(
        'UPDATE monitors SET delivered_seq = ?, last_delivery = ?, updated_at = ? WHERE id = ?',
      ).run(seq, now, now, id),
    remove: (id) => {
      db.prepare('DELETE FROM monitor_sources WHERE monitor_id = ?').run(id)
      db.prepare('DELETE FROM pending WHERE monitor_id = ?').run(id)
      db.prepare('DELETE FROM monitors WHERE id = ?').run(id)
    },
    /** 删源时解除关联;返回因此变成无源可看的 monitor id。 */
    unlinkSource: (sourceId) => {
      const affected = db.prepare(
        'SELECT monitor_id FROM monitor_sources WHERE source_id = ?',
      ).all(sourceId).map((r) => r.monitor_id)
      db.prepare('DELETE FROM monitor_sources WHERE source_id = ?').run(sourceId)
      return affected
    },
  }

  const pending = {
    add: (rows) => {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO pending
          (monitor_id, seq, source_id, item_key, title, link, published, summary)
        VALUES (?,?,?,?,?,?,?,?)
      `)
      for (const row of rows) {
        stmt.run(
          row.monitorId, row.seq, row.sourceId, row.itemKey, row.title,
          orNull(row.link), orNull(row.published), orNull(row.summary),
        )
      }
    },
    list: (monitorId, limit = 50) =>
      db.prepare('SELECT * FROM pending WHERE monitor_id = ? ORDER BY seq LIMIT ?').all(monitorId, limit),
    /** 全表的未投递计数。pending 有界(PK 前缀即 monitor_id),这个 GROUP BY 走索引。 */
    counts: () => {
      const map = new Map()
      for (const row of db.prepare('SELECT monitor_id, COUNT(*) AS c FROM pending GROUP BY monitor_id').all()) {
        map.set(row.monitor_id, Number(row.c))
      }
      return map
    },
    total: () => Number(db.prepare('SELECT COUNT(*) AS c FROM pending').get().c),
    /**
     * 只保留每个 monitor 最新的 N 条未投递,丢最旧的。
     * 这是防止超高产的源把 pending 撑爆的兜底;丢了多少要由调用方记账。
     *
     * @returns 实际删掉的行数
     */
    trimOldest: (monitorId, keep) => Number(db.prepare(`
      DELETE FROM pending WHERE monitor_id = ? AND seq NOT IN (
        SELECT seq FROM pending WHERE monitor_id = ? ORDER BY seq DESC LIMIT ?
      )
    `).run(monitorId, monitorId, keep).changes),
    removeUpTo: (monitorId, seq) =>
      db.prepare('DELETE FROM pending WHERE monitor_id = ? AND seq <= ?').run(monitorId, seq),
    remove: (monitorId, seqs) => {
      const stmt = db.prepare('DELETE FROM pending WHERE monitor_id = ? AND seq = ?')
      for (const seq of seqs) stmt.run(monitorId, seq)
    },
    clear: (monitorId) => db.prepare('DELETE FROM pending WHERE monitor_id = ?').run(monitorId),
  }

  return {
    file,
    db,
    sources,
    seen,
    monitors,
    pending,
    nextSeq,
    tx,
    close: () => {
      try {
        db.close()
      } catch {
        /* 关闭失败无计可施 */
      }
    },
  }
}
