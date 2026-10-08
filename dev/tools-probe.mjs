/**
 * 工具层探针:验证 monitor 与 source 已经**解耦**。
 *
 * 为什么单独有这个文件:`dev/smoke.mjs` 只 import 了 parse / store / feed /
 * deliver,**完全没有覆盖 `lib/tools.js`**。而解耦改的正是工具层,所以这里补上。
 * 直接调各工具的 `execute()`,需要临时库,不出网、不装插件。
 *
 * 它钉死的行为:
 *   1. `feed_subscribe` 只建源,**不再**顺手建 monitor
 *   2. 一个 monitor 可以盯多个源;给已有 monitor 加源**不会**多出全收 monitor
 *      (这是解耦前最实际的 bug:同一条目会被两个 monitor 各投一遍)
 *   3. `feed_unsubscribe` 不再删 monitor、不再要求 confirm
 *   4. 「零源 monitor」被保留并如实报告
 *   5. `feed_monitor delete: true` 是唯一的删除入口,且连带清掉关联与 pending
 *
 * 跑法(必须用 Electron 二进制,才有 node:sqlite):
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<install>\DeepSeek Harness.exe" dev/tools-probe.mjs
 */

import { openStore } from '../lib/store.js'
import { registerTools } from '../lib/tools.js'

const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')

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

function equalJson(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(label, a === b, `expected ${b}, got ${a}`)
}

/** 跑一个应当抛错的动作,返回错误消息(没抛则返回 null)。 */
async function throws(action) {
  try {
    await action()
  } catch (error) {
    return String(error?.message ?? error)
  }
  return null
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-feed-tools-'))
const silent = { info() {}, warn() {}, error() {}, file: '' }
const store = openStore({ dir, log: silent })

// 工具注册只需要 ctx.tools.register;其余服务工具层不用。
const tools = new Map()
const ctx = {
  tools: {
    register: (definition) => {
      tools.set(definition.name, definition)
      return () => {}
    },
  },
}

const config = {
  defaultIntervalSeconds: 1800,
  minIntervalSeconds: 900,
  maxIntervalSeconds: 86400,
  defaultMaxItems: 20,
}

let poked = 0
registerTools(ctx, { store, config, log: silent, poke: () => { poked += 1 } })

const exec = { agent: { id: 'session-probe' } }
const call = (name, args) => tools.get(name).execute(args, exec)
const render = (name, args, value) => tools.get(name).output.render(args, value)[0].text
const required = (name) => tools.get(name).output.schema.required
const sourcesOf = (monitorId) => store.db
  .prepare('SELECT source_id FROM monitor_sources WHERE monitor_id = ? ORDER BY source_id')
  .all(monitorId)
  .map((row) => row.source_id)
/** 投递路径用的反查:只看 enabled = 1。 */
const watchingEnabled = (sourceId) => store.monitors.forSource(sourceId).map((row) => row.id)

const URL_A = 'https://example.com/a.xml'
const URL_B = 'https://example.com/b.xml'

try {
  equal('tools: 仍然是 5 个', tools.size, 5)

  // ── 1. 订阅只管源 ──────────────────────────────────────────────────────
  const subA = await call('feed_subscribe', { url: URL_A })
  equal('subscribe: 建了源', store.sources.count(), 1)
  equal('subscribe: 没有连带建 monitor', store.monitors.count(), 0)
  equal('subscribe: 回执里不再有 monitor_id', Object.hasOwn(subA, 'monitor_id'), false)
  equalJson('subscribe: source.monitors 为空', subA.source.monitors, [])
  equal('subscribe: schema 不再要求 monitor_id', required('feed_subscribe').includes('monitor_id'), false)
  const subAText = render('feed_subscribe', { url: URL_A }, subA)
  check('subscribe: 明说「没人投递」', subAText.includes('No monitor watches this source'), subAText)
  equal('subscribe: 仍然触发采集', poked, 1)

  const srcA = store.sources.byUrl(URL_A).id

  // ── 2. seen_keys 是真数,不是写死的 0 ──────────────────────────────────
  store.seen.addMany(srcA, ['k1', 'k2'], Date.now())
  const listed1 = await call('feed_list', {})
  equal('list: 源在列表里', listed1.sources.length, 1)
  equal('list: seen_keys 反映真实条数', listed1.sources[0].seen_keys, 2)
  equalJson('list: 源如实报出「没人盯」', listed1.sources[0].monitors, [])
  const listText1 = render('feed_list', {}, listed1)
  check('list: 源那行标出没有 monitor', listText1.includes('[no monitor watching'), listText1)

  // ── 3. 建 monitor,并让它盯多个源 ──────────────────────────────────────
  const mon = await call('feed_monitor', { title: 'M', sources: [srcA], match: { any: ['rust'] } })
  equal('monitor: 建了一个', store.monitors.count(), 1)
  equal('monitor: created', mon.created, true)
  equalJson('monitor: 关联了源', mon.monitor.sources, [srcA])
  equalJson('monitor: 回执带 deleted 字段', [mon.deleted, mon.deleted_id], [false, ''])

  const subB = await call('feed_subscribe', { url: URL_B })
  const srcB = store.sources.byUrl(URL_B).id
  // ↓ 这是解耦前最实际的 bug:以前这里会多出一个 match 全收的默认 monitor,
  //   于是同一条目被两个 monitor 各投一遍(一条消息里出现两次)。
  equal('subscribe B: 没有多出全收 monitor', store.monitors.count(), 1)
  equalJson('subscribe B: 新源没人盯', subB.source.monitors, [])

  const attached = await call('feed_monitor', { id: mon.monitor.id, sources: [srcA, srcB] })
  equalJson('monitor: 一个 monitor 盯两个源', attached.monitor.sources.slice().sort(), [srcA, srcB].sort())
  equal('monitor: 仍然只有一个 monitor', store.monitors.count(), 1)

  const listed2 = await call('feed_list', {})
  equalJson('list: 两个源都被同一个 monitor 盯', listed2.sources.map((row) => row.monitors.length), [1, 1])

  // ── 4. 源侧可见性包含已停用的 monitor ──────────────────────────────────
  await call('feed_monitor', { id: mon.monitor.id, enabled: false })
  const listed3 = await call('feed_list', {})
  equalJson('list: 停用的 monitor 仍然列在源上', listed3.sources[0].monitors, [mon.monitor.id])
  equalJson('投递路径: 停用的 monitor 不参与投递', watchingEnabled(srcA), [])
  const pausedText = render('feed_list', {}, listed3)
  check('list: monitor 标为 paused', pausedText.includes('(paused)'), pausedText)
  await call('feed_monitor', { id: mon.monitor.id, enabled: true })

  // ── 5. 删源不删 monitor、不要 confirm ──────────────────────────────────
  store.tx(() => {
    store.pending.add([
      { monitorId: mon.monitor.id, seq: store.nextSeq(), sourceId: srcA, itemKey: 'k1', title: 'A1', link: '', published: '', summary: 's' },
      { monitorId: mon.monitor.id, seq: store.nextSeq(), sourceId: srcB, itemKey: 'k2', title: 'B1', link: '', published: '', summary: 's' },
    ])
  })
  equal('前置: pending 里两条', store.pending.counts().get(mon.monitor.id), 2)

  const offA = await call('feed_unsubscribe', { source: srcA })
  equal('unsubscribe A: 源没了', store.sources.count(), 1)
  equal('unsubscribe A: monitor 没被删', store.monitors.count(), 1)
  equalJson('unsubscribe A: 没有孤儿', offA.orphaned_monitors, [])
  equalJson('unsubscribe A: monitor 还剩一个源', sourcesOf(mon.monitor.id), [srcB])

  const offB = await call('feed_unsubscribe', { source: srcB })
  equal('unsubscribe B: 不再要求 confirm', offB.removed, true)
  equalJson('unsubscribe B: 报出孤儿', offB.orphaned_monitors, [mon.monitor.id])
  equal('unsubscribe B: 孤儿 monitor 仍然存在', store.monitors.count(), 1)
  equalJson('unsubscribe B: 孤儿 monitor 已无源', sourcesOf(mon.monitor.id), [])
  equal('unsubscribe B: 已入队的条目不受影响', store.pending.counts().get(mon.monitor.id), 2)
  const offBText = render('feed_unsubscribe', { source: srcB }, offB)
  check('unsubscribe B: 提示善后方式', offBText.includes('delete: true'), offBText)

  // ── 6. 显式删除是唯一的删除入口 ───────────────────────────────────────
  const noId = await throws(() => call('feed_monitor', { delete: true }))
  check('delete: 缺 id 报错', noId !== null && noId.includes('requires id'), String(noId))

  const badId = await throws(() => call('feed_monitor', { delete: true, id: 'mon_nope' }))
  check('delete: 不存在的 id 报错', badId !== null && badId.includes('no monitor with id'), String(badId))

  const removed = await call('feed_monitor', { delete: true, id: mon.monitor.id })
  equal('delete: deleted 为真', removed.deleted, true)
  equal('delete: 回执带被删 id', removed.deleted_id, mon.monitor.id)
  equal('delete: monitor 没了', store.monitors.count(), 0)
  equalJson('delete: 关联清干净', sourcesOf(mon.monitor.id), [])
  equal('delete: 它的 pending 也清了', store.pending.total(), 0)
  const delText = render('feed_monitor', { delete: true, id: mon.monitor.id }, removed)
  check('delete: 明说没动源', delText.includes('Deleted monitor'), delText)

  // ── 7. 删 monitor 不需要会话 ───────────────────────────────────────────
  const mon2 = await call('feed_monitor', { title: 'M2', sources: [] })
  const anon = { agent: undefined }
  const removedAnon = await tools.get('feed_monitor').execute({ delete: true, id: mon2.monitor.id }, anon)
  equal('delete: 无会话也能删', removedAnon.deleted, true)
  equal('delete: 删掉了', store.monitors.count(), 0)
} finally {
  try {
    store.close()
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log(`\npassed: ${passed}`)
if (failures.length === 0) {
  console.log('all checks passed')
} else {
  console.log(`failed: ${failures.length}`)
  for (const failure of failures) console.log(`  x ${failure}`)
}
process.exitCode = failures.length === 0 ? 0 : 1
