/**
 * 激活面包屑与状态目录解析。
 *
 * 为什么需要它:这个项目里已经踩过一次"看起来正常其实什么都没做"的坑 ——
 * fs-local-fix 的 patch 没生效、只写了一句把日志吞掉的 warning、
 * 却仍然报 `fiberPhase: "active"`(见 fs-local-fix-bundle/index.js 的注释)。
 *
 * 所以每个关键步骤都往 `$DSH_HOME/dsh-feed/apply.log` 追一行 JSON。
 * 诊断永远不能反过来破坏激活,所有失败都吞掉。
 *
 * @module @local/dsh-feed/lib/log
 */

const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')

/** DSH 家目录:`$DSH_HOME`,回退 `~/.dsh`。 */
export function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * 本插件的状态目录。
 *
 * 刻意**不放在 `$DSH_HOME/storages/`** —— 那是 storage-json 后端的命名空间
 * (profile 的 cordis.yml 里 `root: !!js dshHomePath('storages')`,
 * 里面已经有 workspace.json 和 session_projcache/)。混进去以后分不清谁在写。
 */
export function resolveStateDir() {
  return path.join(resolveHome(), 'dsh-feed')
}

/** 改名前的状态目录名(插件还叫 feedwatch 时用的)。 */
export const LEGACY_STATE_DIRNAME = 'feedwatch'

/** 改名前的库文件名。 */
export const LEGACY_DB_FILENAME = 'feedwatch.db'

/** 当前库文件名。 */
export const DB_FILENAME = 'dsh-feed.db'

/**
 * 旧状态目录 `$DSH_HOME/feedwatch/` → `$DSH_HOME/dsh-feed/` 的一次性搬家。
 *
 * 为什么放在插件里而不是手工 mv:搬家必须在**上一份代码放开 sqlite 句柄之后**发生,
 * 而那个时刻只有插件自己知道(重启后的第一次 apply,或配置重算时 apply 内部先
 * dispose 上一实例)。放在这里,「改名」就不会退化成「静默换了一个空库」——
 * 而那正是订阅/规则数据凭空消失的样子。
 *
 * 判据:**目标状态目录里两种库名都没有,且旧目录里有旧库**。任何一边已经有库,
 * 就什么都不做(以当前状态目录里的为准),绝不覆盖;失败也不抛,让调用方照常开库。
 *
 * @param stateDir - 当前状态目录(resolveStateDir 的结果)
 * @returns 搬没搬、从哪到哪,或没搬的原因
 */
export function migrateLegacyStateDir(stateDir) {
  const legacyDir = path.join(resolveHome(), LEGACY_STATE_DIRNAME)
  try {
    if (path.resolve(legacyDir) === path.resolve(stateDir)) return { moved: false, reason: 'same-dir' }
    // 两种库名都算「目标已经有库」:改名是分两步生效的,中间态是
    // 「目录已经是 dsh-feed/、库还叫 feedwatch.db」,那同样轮不到我们覆盖。
    if (fs.existsSync(path.join(stateDir, DB_FILENAME))) return { moved: false, reason: 'target-exists' }
    if (fs.existsSync(path.join(stateDir, LEGACY_DB_FILENAME))) return { moved: false, reason: 'target-exists' }
    if (!fs.existsSync(path.join(legacyDir, LEGACY_DB_FILENAME))) return { moved: false, reason: 'no-legacy-db' }

    try {
      // 同卷:整个目录 rename,apply.log 的历史一起带走。
      fs.renameSync(legacyDir, stateDir)
      return { moved: true, from: legacyDir, to: stateDir, mode: 'rename' }
    } catch {
      // 跨卷(DSH_HOME 挪过盘),或目标目录已经被建出来:逐个文件搬。
      // 库文件已在上面确认过不冲突,所以这里**只搬目标没有的条目** ——
      // 覆盖式搬法在「目标已有同名文件」时是静默丢数据。
      fs.mkdirSync(stateDir, { recursive: true })
      const skipped = []
      for (const entry of fs.readdirSync(legacyDir)) {
        const target = path.join(stateDir, entry)
        if (fs.existsSync(target)) {
          skipped.push(entry)
          continue
        }
        fs.renameSync(path.join(legacyDir, entry), target)
      }
      try {
        fs.rmdirSync(legacyDir)
      } catch {
        /* 没搬空就留着,下一次 apply 再收尾 */
      }
      return { moved: true, from: legacyDir, to: stateDir, mode: 'file-by-file', skipped }
    }
  } catch (error) {
    return { moved: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 建一个往 stateDir/apply.log 追加 JSON 行的记录器。
 * 目录建不出来或写不进去时降级成静默,绝不抛。
 *
 * @param stateDir - 状态目录(应当已存在或被创建)
 * @returns 记录器,带 `file` 字段指向日志路径
 */
export function createLog(stateDir) {
  const file = path.join(stateDir, 'apply.log')

  const write = (level, message, extra) => {
    try {
      const line = JSON.stringify({
        time: new Date().toISOString(),
        pid: process.pid,
        level,
        message,
        ...extra,
      })
      fs.appendFileSync(file, `${line}\n`)
    } catch {
      /* 面包屑写不进去不能影响插件 */
    }
  }

  return {
    file,
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
  }
}

/** 确保目录存在;失败返回 false 而不抛。 */
export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}
