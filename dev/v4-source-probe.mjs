/**
 * 探针:把 dsh-feed **真实送出的** followup 消息,喂给**装机自带的**校验器。
 *
 * 为什么需要它:两个真实的致命 bug 都发生在**异步的会话接纳路径**(持久化 worker)上,
 * `agent.followup()` 正常返回**不代表**消息被接纳,而且 `try/catch` 兜不住 ——
 * 它是在会话落盘时抛的:
 *
 * | 症状 | 被谁拒 |
 * |---|---|
 * | `format v4 message requires a producer-owned source kind` | `assertV4RowAdmission`(source) |
 * | `session event at seq N lacks an identified message` | `adoptSessionEvent`(消息形状) |
 *
 * 后者 2026-09-30 16:11 把 session-42896e5b 与 session-406fecc5 直接打死:
 * 缺 `id` / `role` 的 `user/message` 是**已提交**的坏记录,加载器拒绝整条日志。
 *
 * 跑法(必须用 Electron 二进制,才能读 app.asar 内的包):
 *   $env:ELECTRON_RUN_AS_NODE = "1"
 *   & "<install>\DeepSeek Harness.exe" dev/v4-source-probe.mjs
 */
import { pathToFileURL } from 'node:url'
import { deliverToSession, SOURCE_KIND } from '../lib/deliver.js'

const path = process.getBuiltinModule('node:path')

/**
 * 装机内的 app.asar。
 *
 * 原来是写死的本机路径 —— 两个问题:换台机器就得改代码,而且这条路径把 Windows
 * 用户名一起暴露了(本仓库是公开的)。改成从 `process.execPath` 反推:
 * 按文件头的方式用 `ELECTRON_RUN_AS_NODE=1` 跑时,它就是 Electron 可执行文件本身,
 * 同级的 `resources/app.asar` 就是要找的东西。装机位置特殊时用 `DSH_ASAR` 覆盖。
 */
const ASAR = process.env.DSH_ASAR ?? `${path.dirname(process.execPath)}/resources/app.asar`
const FORMAT_PKG = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js`
const SESSION_PKG = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`
const { assertV4RowAdmission } = await import(pathToFileURL(FORMAT_PKG).href)
const { adoptSessionEvent } = await import(pathToFileURL(SESSION_PKG).href)

/** 会话写入器为一次 inbox splice 追加的那一行。 */
function spliceRow(message) {
  return {
    type: 'agent/inbox/spliced',
    seq: 100,
    time: 1790753397413,
    data: { target: 'next-turn', start: 0, inserted: [message] },
  }
}

/**
 * 消息被接纳后,**落进日志的那条 `user/message` 事件**(data 就是消息本身)。
 * 这是持久化层真正送去 `adoptSessionEvent` 的形状。
 */
function storedUserMessageEvent(message) {
  return {
    type: 'user/message',
    seq: 101,
    time: 1790753397583,
    data: message,
    surfaceOp: 'append',
  }
}

/** 两道路闸,缺一不可:source 归属 && 消息形状。 */
function admit(label, message) {
  const checks = [
    ['source ', () => assertV4RowAdmission(spliceRow(message))],
    ['message', () => adoptSessionEvent(structuredClone(storedUserMessageEvent(message)))],
  ]
  let passed = 0
  for (const [what, run] of checks) {
    try {
      run()
      passed += 1
      console.log(`  PASS ${what}  ${label}`)
    } catch (error) {
      console.log(`  THROW ${what} ${label}\n        ${error.name}: ${error.message}`)
    }
  }
  console.log(`  source = ${JSON.stringify(message.source)}`)
  console.log(`  id = ${JSON.stringify(message.id)}  role = ${JSON.stringify(message.role)}`)
  return passed === checks.length
}

/** 捕获 deliverToSession 真正交给 followup 的那条消息。 */
async function capturedMessage() {
  const sent = []
  const ctx = {
    get: (service) => (service === 'sessionController'
      ? { resolveAgent: async () => ({ agent: { followup: (message) => sent.push(message) } }) }
      : undefined),
  }
  const outcome = await deliverToSession(ctx, 'session-probe', '[FEED UPDATE]\n…', { monitors: 1, items: 10 })
  if (!outcome.ok) throw new Error(`deliverToSession refused: ${outcome.error}`)
  return sent[0]
}

const message = await capturedMessage()

console.log(`SOURCE_KIND = ${JSON.stringify(SOURCE_KIND)}\n`)
const results = [
  admit('dsh-feed deliverToSession()', message),
  admit('retired V3 wrapper (2026-09-30 15:29 death)', {
    ...message,
    source: { kind: 'plugin', plugin: 'dsh-feed' },
  }),
  admit('message without id/role (2026-09-30 16:11 death)', {
    ...message,
    id: undefined,
    role: undefined,
  }),
]

console.log(`\n${results.filter(Boolean).length}/${results.length} rows fully accepted by the shipped validators`)
console.log('(only the first must pass; the other two reproduce the two historical crashes)')
process.exitCode = results[0] ? 0 : 1
