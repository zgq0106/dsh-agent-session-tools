/**
 * Session Control — Host half.
 *
 * Agent tools that let the model:
 *   1. create a brand-new Harness session (agent.create 语义的宿主入口), and
 *   2. inject one message into any existing session (queued, or steering).
 *
 * Both capabilities are thin, faithful wrappers over the already-composed
 * `ctx.sessionController` Host service:
 *   - `create(request)`  -> SessionCreateValue  { sessionId, agentPreset? }
 *   - `prompt(request)`  -> SessionPromptValue  { accepted: true }
 *
 * `prompt` is the same admission path the Web composer uses, so an injected
 * message lands in the target Session log as a durable user message. Called
 * from the Host plugin (no Remote principal) it is attributed to the owner.
 * `requestId` makes retries idempotent: the service returns the original
 * acceptance instead of appending a second message.
 */

import { appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDetector } from './src/watch-detector.js'
import { evaluateGate } from './src/watch-gate.js'
import { createWatchStore } from './src/watch-store.js'
import { createTelemetry } from './src/watch-telemetry.js'

export const name = 'session-control'

/** Wait for the tool registry; `sessionController` is resolved lazily per call. */
export const inject = ['tools']

/** Resolve the session controller or fail with an actionable message. */
function controllerOf(ctx) {
  const service = ctx.get('sessionController')
  if (!service) {
    throw new Error(
      'sessionController 不可用：当前 profile 未组合 @deepseek-ai/dsh-api-session-controller，无法创建或注入会话。',
    )
  }
  return service
}

/** One-shot abort signal for Host-side calls. */
function signalOf() {
  return new AbortController().signal
}

/** A request id unique enough for the service's idempotency check. */
function newRequestId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `session-control-${uuid}`
  return `session-control-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/* ═════════════════════════ 移植区：dsh-session-bridge ═════════════════════════
 *
 * 事件折叠、等待、快照逻辑移植自 dsh-session-bridge v0.7.0
 *   https://github.com/heartmove/dsh-session-bridge
 *   MIT License, Copyright (c) heartmove
 * 源文件：src/core.ts（foldMessages / segmentsSince / waitForReply / statusSnapshot /
 *         liveReasoningSnapshot / reasoningTailOf / titleOf 等）、src/tools.ts（工具参数）。
 *
 * 移植时的两处适配（其余逻辑逐行保真）：
 *   1. 事件源：原实现依赖 Session 同步 `events`/`snapshotEvents()`（DSH 0.1.6 起已
 *      @deprecated，官方禁止新增调用）。这里改为「有活 agent 走内存事件，否则走
 *      sessionController 的冷读入口」——0.2.1 时代是 `inspect()`，0.2.2-rc.2 起改为
 *      `events({ address, beforeSeq, maxMessages })` 分页，`page()` 是其 deprecated 别名。
 *      两条路径都保留：先认 `inspect`（旧版），没有再走 `events`（新版）。
 *   2. 等待改为 async 轮询（原实现同步读 session.events），间隔 100ms 与原版一致。
 *
 * 相对原版的改进（有意为之，不是偏差）：
 *   - segments 真正应用 limit（原版解析了却没用，会一次返回全部段落）。
 *   - segments 默认不返回思维链，需 includeReasoning:true 才读（省 token）。
 *   - status 对冷会话也可用（原版强制要求 live），并回报 agentAvailable。
 */

const REASONING_TAIL_LIMIT = 600
const SEGMENT_TEXT_LIMIT = 1200
const REPLY_TEXT_LIMIT = 4000

/** 兼容两代会话事件读取：旧版 `events` getter，新版 `snapshotEvents()` 方法。 */
function eventsOf(session) {
  if (!session) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    try {
      const value = session.snapshotEvents()
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  }
  return []
}

function blockText(content) {
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const raw of content) {
    const block = raw
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      if (block.text !== '') parts.push(block.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

function blockTextByType(content, wantedType) {
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const raw of content) {
    const block = raw
    if (block !== null && typeof block === 'object' && block.type === wantedType && typeof block.text === 'string') {
      if (block.text !== '') parts.push(block.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

function countImages(content) {
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const raw of content) {
    if (raw !== null && typeof raw === 'object' && raw.type === 'image') n += 1
  }
  return n
}

function toolNamesOf(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  const names = []
  for (const raw of toolCalls) {
    const call = raw
    if (call !== null && typeof call === 'object' && typeof call.name === 'string' && !names.includes(call.name)) {
      names.push(call.name)
    }
  }
  return names
}

/** 折叠会话事件日志为可读消息行（跳过非 user 来源与空消息）。 */
function foldMessages(events) {
  const list = Array.isArray(events) ? events : []
  const rows = []
  for (const event of list) {
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source !== undefined && source.kind !== 'user') continue
      const text = blockText(event.data?.content)
      if (text === undefined) continue
      rows.push({ seq: event.seq, time: event.time, role: 'user', text, images: countImages(event.data?.content) })
    } else if (event.type === 'assistant/message') {
      const message = event.data?.message ?? null
      const text = message === null ? undefined : blockText(message.content)
      // 思维链是 content 里 type:'reasoning' 的块；老版本曾放在 message.reasoning。
      const reasoning =
        message === null ? undefined : (blockTextByType(message.content, 'reasoning') ?? blockText(message.reasoning))
      const images = message === null ? 0 : countImages(message.content)
      const toolCalls = message === null ? [] : toolNamesOf(message.toolCalls)
      if (text === undefined && reasoning === undefined && toolCalls.length === 0) continue
      const row = { seq: event.seq, time: event.time, role: 'assistant', images }
      if (text !== undefined) row.text = text
      if (reasoning !== undefined) row.reasoning = reasoning
      if (toolCalls.length > 0) row.toolCalls = toolCalls
      rows.push(row)
    }
  }
  return rows
}

/** 按已完成输出段落折叠：每个 assistant/message 割一段，返回 sinceSeq 之后的段落。 */
function segmentsSince(events, sinceSeq = 0) {
  const list = Array.isArray(events) ? events : []
  const out = []
  let openTurn = false
  for (const event of list) {
    if (event.type === 'turn/start') {
      openTurn = true
      continue
    }
    if (event.type === 'turn/end') {
      openTurn = false
      continue
    }
    if (event.type !== 'assistant/message') continue
    if (event.seq <= sinceSeq) continue
    const message = event.data?.message ?? null
    const text = message === null ? undefined : blockText(message.content)
    const reasoning =
      message === null ? undefined : (blockTextByType(message.content, 'reasoning') ?? blockText(message.reasoning))
    const toolCalls = message === null ? [] : toolNamesOf(message.toolCalls)
    const turn = event.data?.turn
    const step = event.data?.step
    const seg = {
      seq: event.seq,
      time: event.time,
      turn: typeof turn === 'number' ? turn : 0,
      step: typeof step === 'number' ? step : 0,
      toolCalls,
      openTurn,
    }
    if (text !== undefined) seg.text = text
    if (reasoning !== undefined) seg.reasoning = reasoning
    out.push(seg)
  }
  return out
}

function latestSegmentSince(events, sinceSeq = 0) {
  const segs = segmentsSince(events, sinceSeq)
  return segs.length === 0 ? null : segs[segs.length - 1]
}

/** seq 及之前最新一个已完成段落（wait 零新输出时回落既有段落）。 */
function lastSegmentUpTo(events, seq) {
  const segs = segmentsSince(events)
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    if (segs[i].seq <= seq) return segs[i]
  }
  return null
}

/** seq 及之前最新一条带文本的 assistant 行（wait 零新文本回复时回落既有回复）。 */
function lastTextRowUpTo(rows, seq) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row.role === 'assistant' && row.text !== undefined && row.seq <= seq) return row
  }
  return null
}

/** 折叠 live 会话"进行中"的推理/文本增量（兼容 reasoning-chunks 与 reasoning-delta 两代形状）。 */
function liveReasoningSnapshot(events) {
  const list = Array.isArray(events) ? events : []
  let reasoning = ''
  let text = ''
  let seq = -1
  let time = 0
  let turn = 0
  let step = 0
  let found = false
  for (const event of list) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const data = event.data
    if (!data || !Array.isArray(data.stream)) continue
    let r = ''
    let t = ''
    for (const raw of data.stream) {
      const record = raw
      if (record === null || typeof record !== 'object') continue
      if (record.type === 'reasoning-chunks' && Array.isArray(record.texts)) {
        for (const s of record.texts) if (typeof s === 'string') r += s
      } else if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
        for (const s of record.texts) if (typeof s === 'string') t += s
      } else if (record.type === 'chunk') {
        const c = record.chunk
        if (c !== null && typeof c === 'object' && typeof c.text === 'string') {
          if (c.type === 'reasoning-delta') r += c.text
          else if (c.type === 'text-delta') t += c.text
        }
      }
    }
    if (r !== '' || t !== '') {
      if (typeof data.turn === 'number') turn = data.turn
      if (typeof data.step === 'number') step = data.step
      reasoning = r
      text = t
      seq = event.seq
      time = event.time
      found = true
    }
  }
  if (!found) return null
  return { turn, step, reasoning, text, seq, time }
}

function reasoningTailOf(liveReasoning, lastReasoning, limit = REASONING_TAIL_LIMIT) {
  const source = liveReasoning ?? lastReasoning
  if (source === undefined || source === '') return undefined
  return source.length <= limit ? source : `${source.slice(0, limit)}…`
}

/** 会话标题：优先 session/title 事件（last-wins），否则回落第一条用户消息（截断 80 字符）。 */
function titleOf(events) {
  const list = Array.isArray(events) ? events : []
  let title
  for (const event of list) {
    if (event.type === 'session/title') {
      const t = event.data?.title
      if (typeof t === 'string' && t !== '') title = t
    }
  }
  if (title !== undefined) return title
  for (const event of list) {
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source !== undefined && source.kind !== 'user') continue
    const text = blockText(event.data?.content)
    if (text !== undefined) {
      const trimmed = text.replace(/\s+/g, ' ').trim()
      return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
    }
  }
  return undefined
}

function maxSeq(events) {
  const list = Array.isArray(events) ? events : []
  let m = -1
  for (const event of list) if (event.seq > m) m = event.seq
  return m
}

/** 卡住判定唯一真源：只有 running 会话可能卡住；语义为"超过"（严格大于）。 */
function isStalled(running, stalledMs, thresholdMs) {
  return running === 'running' && stalledMs !== null && stalledMs > thresholdMs
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncate(text, limit) {
  if (typeof text !== 'string') return text
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** 冷读单页的消息预算（rc.2 `events()` 的 maxMessages）。 */
const COLD_PAGE_MESSAGES = 200

/** 冷读最多翻多少页，防止超大日志把工具拖死。 */
const COLD_MAX_PAGES = 100

/**
 * 冷会话事件读取。
 *
 * rc.2 起官方冷读入口是 `sessionController.events({ address, beforeSeq, maxMessages })`
 * （`page()` 是它的 @deprecated 别名；0.2.1 时代的 `inspect()` 已不存在）。
 * 返回 `{ cursor, records, hasMore }`，records 形如 `{ type: 'event', event }`，
 * `cursor` 是本次页的**末条 seq**，所以下一页要用首条 event 的 seq 作 `beforeSeq` 往回翻。
 */
async function readColdEvents(controller, sessionId, signal) {
  if (typeof controller.inspect === 'function') {
    const inspection = await controller.inspect(sessionId, signal)
    return Array.isArray(inspection?.events) ? inspection.events : []
  }
  const address = { kind: 'session', sessionId }
  const chunks = []
  let beforeSeq
  for (let page = 0; page < COLD_MAX_PAGES; page += 1) {
    const request = { address, maxMessages: COLD_PAGE_MESSAGES }
    if (beforeSeq !== undefined) request.beforeSeq = beforeSeq
    const result = await controller.events(request, signal)
    const records = Array.isArray(result?.records) ? result.records : []
    const events = []
    for (const record of records) {
      const event = record?.type === 'event' ? record.event : record?.seq !== undefined ? record : undefined
      if (event !== undefined && event !== null && typeof event === 'object') events.push(event)
    }
    chunks.push(events)
    if (result?.hasMore !== true) break
    const oldest = events.length > 0 ? events[0].seq : undefined
    if (!Number.isInteger(oldest) || oldest <= 0) break
    beforeSeq = oldest
  }
  return chunks.reverse().flat().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
}

/**
 * 读一个会话的事件日志。
 * 优先活 agent 的内存事件（与原版一致）；否则走 sessionController 的冷读入口。
 */
async function readSessionLog(ctx, sessionId, signal) {
  const agents = ctx.get('agents')
  const agentsAvailable = agents !== undefined && typeof agents.get === 'function'
  const agent = agentsAvailable ? agents.get(sessionId) : undefined
  if (agent) {
    return { events: eventsOf(agent.session), live: true, agent, agentsAvailable }
  }
  const controller = controllerOf(ctx)
  if (typeof controller.inspect !== 'function' && typeof controller.events !== 'function') {
    throw new Error('sessionController 缺少冷读入口（inspect / events）：当前 DSH 版本读不到会话日志，session_wait / session_segments / session_status 无法工作。')
  }
  // 冷读接口的 signal 是必需参数（rc.2 的 events() 内部直接 signal.throwIfAborted()）；
  // 多数调用方（segments / status）不传 signal，这里补一次性 signal，漏传会报
  // 「Cannot read properties of undefined (reading 'throwIfAborted')」。
  const activeSignal = signal !== undefined && signal !== null ? signal : signalOf()
  const events = await readColdEvents(controller, sessionId, activeSignal)
  return { events, live: false, agent: undefined, agentsAvailable }
}

/**
 * 投递前的最大事件序号——交给调用方当 `session_wait` 的 sinceSeq 锚点，
 * 这样「等这条消息之后的回复」才精确，不必靠调用时刻的最大序号去猜。
 * 读不到就返回 undefined（只是少了锚点，绝不让投递本身失败）。
 */
async function anchorOf(ctx, sessionId) {
  try {
    const log = await readSessionLog(ctx, sessionId)
    return maxSeq(log.events)
  } catch {
    return undefined
  }
}

/**
 * 轮询等待某会话在 baseline 之后出现新的 assistant 输出（移植 waitForReply）。
 * 完成条件默认是"出现一条带文本的新 assistant 回复"，不是等 turn/end：
 * agent 驱动的 turn 不保证产生 turn/end，用它做门控会让"回复早就有、却要等满超时"。
 */
async function waitForReply(ctx, opts) {
  const started = Date.now()
  const deadline = started + opts.timeoutMs
  const requireTurnEnd = opts.requireTurnEnd === true
  const waitForSegment = opts.waitForSegment === true
  let latest = null
  let textReply = null
  let segment = null
  let turnEnded = false
  let events = []

  for (;;) {
    if (opts.signal !== undefined && opts.signal.aborted) break
    const log = await readSessionLog(ctx, opts.sessionId, opts.signal)
    events = log.events
    for (const row of foldMessages(events)) {
      if (row.seq <= opts.baselineSeq || row.role !== 'assistant') continue
      if (latest === null || row.seq > latest.seq) latest = row
      if (row.text !== undefined && (textReply === null || row.seq > textReply.seq)) textReply = row
    }
    if (waitForSegment) {
      const seg = latestSegmentSince(events, opts.baselineSeq)
      if (seg !== null && (segment === null || seg.seq > segment.seq)) segment = seg
    }
    if (requireTurnEnd && latest !== null) {
      for (const event of events) {
        if (event.seq > latest.seq && event.type === 'turn/end') {
          turnEnded = true
          break
        }
      }
    }
    const done = requireTurnEnd
      ? latest !== null && turnEnded
      : waitForSegment
        ? segment !== null
        : textReply !== null
    if (done) break
    if (Date.now() >= deadline) break
    await sleep(100)
  }

  const observedNew = waitForSegment ? segment !== null : textReply !== null
  const sawNewRow = latest !== null
  // 零新输出时回落既有内容；扫描限定 seq <= baselineSeq，保证 stale 不变式成立。
  let stale = false
  if (waitForSegment) {
    if (segment === null) {
      const prev = lastSegmentUpTo(events, opts.baselineSeq)
      if (prev !== null) {
        segment = prev
        stale = true
      }
    }
  } else if (textReply === null) {
    const prev = lastTextRowUpTo(foldMessages(events), opts.baselineSeq)
    if (prev !== null) {
      textReply = prev
      stale = true
    }
  }

  const message = waitForSegment && segment !== null
    ? {
        seq: segment.seq,
        time: segment.time,
        role: 'assistant',
        images: 0,
        ...(segment.text !== undefined ? { text: segment.text } : {}),
        ...(segment.reasoning !== undefined ? { reasoning: segment.reasoning } : {}),
        ...(segment.toolCalls.length > 0 ? { toolCalls: segment.toolCalls } : {}),
      }
    : textReply

  return {
    message,
    seq: message === null ? opts.baselineSeq : message.seq,
    turnEnded,
    timedOut: requireTurnEnd ? !(sawNewRow && turnEnded) : !observedNew,
    stale,
    aborted: opts.signal !== undefined && opts.signal.aborted,
    waitedMs: Date.now() - started,
  }
}

/* ───────────────── 移植区：交接（handoff）· 源 src/handoff.ts ───────────────── */

const TASK_LIMIT = 1200
const USER_LIMIT = 600
const ASSISTANT_LIMIT = 800
const REASONING_LIMIT = 1200
const DESCENDANT_TASK_LIMIT = 400
const HANDOFF_DESCENDANT_LIMIT = 5

function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function firstUserText(rows) {
  for (const row of rows) if (row.role === 'user' && row.text !== undefined) return row.text
  return undefined
}

/**
 * 从事件日志折叠出交接所需的任务上下文。
 * 思维链优先取已定型的最后一段；没有再回落到进行中的增量流——卡在循环里的会话正是后者。
 */
function extractTaskContext(events, options = {}) {
  const taskLimit = options.taskLimit ?? TASK_LIMIT
  const userLimit = options.userLimit ?? USER_LIMIT
  const assistantLimit = options.assistantLimit ?? ASSISTANT_LIMIT
  const reasoningLimit = options.reasoningLimit ?? REASONING_LIMIT
  const recentUsers = options.recentUsers ?? 3

  const rows = foldMessages(events)
  const task = firstUserText(rows)
  const userRows = rows.filter((row) => row.role === 'user' && row.text !== undefined)
  const recentUser = userRows.slice(-recentUsers).map((row) => clip(row.text ?? '', userLimit))

  let lastAssistant
  let lastReasoning
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row.role !== 'assistant') continue
    if (lastAssistant === undefined && row.text !== undefined) lastAssistant = clip(row.text, assistantLimit)
    if (lastReasoning === undefined && row.reasoning !== undefined) lastReasoning = clip(row.reasoning, reasoningLimit)
    if (lastAssistant !== undefined && lastReasoning !== undefined) break
  }
  if (lastReasoning === undefined) {
    const live = liveReasoningSnapshot(events)
    if (live !== null && live.reasoning !== '') lastReasoning = clip(live.reasoning, reasoningLimit)
  }

  const out = { recentUser }
  if (task !== undefined) out.task = clip(task, taskLimit)
  if (lastAssistant !== undefined) out.lastAssistant = lastAssistant
  if (lastReasoning !== undefined) out.lastReasoning = lastReasoning
  return out
}

/** 原会话派生的子代理清单。只读；任何一步异常都不抛——宁可少列一个，也不能让迁移失败。 */
function collectDescendants(ctx, owner) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.list !== 'function') return []
  let list = []
  try {
    list = agents.list()
  } catch {
    return []
  }
  const owned = []
  for (const candidate of list) {
    if (!candidate || candidate === owner || candidate.id === owner.id) continue
    if (typeof agents.isOwnedBy === 'function') {
      let byOwner = false
      try {
        byOwner = agents.isOwnedBy(candidate.id, owner)
      } catch {
        byOwner = false
      }
      if (byOwner) owned.push(candidate)
      continue
    }
    const lineage = candidate.session?.header
    if (lineage?.parentSession === owner.id) owned.push(candidate)
  }
  return owned.map((child) => {
    const header = child.session?.header ?? {}
    const task = firstUserText(foldMessages(eventsOf(child.session)))
    const item = { id: String(child.id), status: child.status, running: child.status === 'running' }
    if (header.origin !== undefined) item.origin = header.origin
    if (header.delegationDepth !== undefined) item.delegationDepth = header.delegationDepth
    if (task !== undefined) item.task = clip(task, DESCENDANT_TASK_LIMIT)
    return item
  })
}

const DEFAULT_HANDOFF_TEMPLATE = [
  '你接续一个被中断的任务。{{reason}}',
  '',
  '原会话: {{sessionId}}',
  '工作目录: {{cwd}}',
  '',
  '原任务指令:',
  '{{task}}',
  '',
  '中断前近况:',
  '{{evidence}}',
  '',
  '{{descendants}}',
  '',
  '请先用 session_segments(sessionId="{{sessionId}}", sinceSeq=0) 读取原会话的已完成段落以了解上下文',
  '（需要看它当时在想什么时可传 includeReasoning:true），然后继续推进该任务。',
  '不要重复原会话已完成的步骤。',
].join('\n')

function renderEvidence(context) {
  const parts = []
  if (context.recentUser.length > 0) {
    parts.push(`最近的用户指令:\n${context.recentUser.map((text) => `- ${text.replace(/\n+/g, ' ')}`).join('\n')}`)
  }
  if (context.lastAssistant !== undefined) parts.push(`最后一条回复:\n${context.lastAssistant}`)
  if (context.lastReasoning !== undefined) parts.push(`最后一段思维链:\n${context.lastReasoning}`)
  return parts.length === 0 ? '(无可用摘要)' : parts.join('\n\n')
}

function renderDescendants(items) {
  const shown = items.slice(0, HANDOFF_DESCENDANT_LIMIT)
  const lines = shown.map((item) => {
    const depth = item.delegationDepth === undefined ? '' : `, depth ${item.delegationDepth}`
    const task = item.task === undefined ? '' : `: ${item.task.replace(/\n+/g, ' ')}`
    return `- ${item.id} (${item.status}${depth})${task}`
  })
  if (items.length > shown.length) lines.push(`- …另有 ${items.length - shown.length} 个未列出`)
  return lines
}

/** 渲染交接提示：仍在跑的子代理不要重做，被终止的按原分工重派，已结束的直接读结果。 */
function buildHandoffPrompt(input) {
  const descendants = input.descendants ?? []
  const running = descendants.filter((item) => item.running)
  const finished = descendants.filter((item) => !item.running)

  const blocks = []
  if (running.length > 0) {
    blocks.push(
      [
        '原会话仍在运行的子代理（不要重做它们的工作；可用 session_status / session_wait 观察，完成后用 session_segments 取结果）:',
        ...renderDescendants(running),
      ].join('\n'),
    )
  }
  if (finished.length > 0) {
    blocks.push(['已结束的子代理（结果留在原会话日志里，可用 session_segments 取回）:', ...renderDescendants(finished)].join('\n'))
  }

  const template = input.template !== undefined && input.template.trim() !== '' ? input.template : DEFAULT_HANDOFF_TEMPLATE
  return template
    .replaceAll('{{sessionId}}', input.sessionId)
    .replaceAll('{{cwd}}', input.cwd)
    .replaceAll('{{reason}}', input.reason)
    .replaceAll('{{task}}', input.context.task ?? '(未能从原会话日志中解析出任务指令)')
    .replaceAll('{{evidence}}', renderEvidence(input.context))
    .replaceAll('{{descendants}}', blocks.join('\n\n'))
}

/* ─────────────────────────────── tools ─────────────────────────────── */

function createSessionTool(ctx) {
  return {
    name: 'session_create',
    description:
      '新建一个 Harness 会话并返回 sessionId（可直接用于 session_inject）。可指定工作目录与预设。',
    parameters: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: '工作目录绝对路径，省略用默认。',
        },
        agentPreset: {
          type: 'string',
          description: '预设 id，省略用默认。',
        },
        title: {
          type: 'string',
          description: '创建后设置的标题。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          sinceSeq: { type: 'number' },
          agentPreset: { type: 'string' },
          title: { type: 'string' },
          warning: { type: 'string' },
        },
        required: ['sessionId', 'sinceSeq'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const lines = [`已创建会话：${value.sessionId}`]
        if (value.agentPreset) lines.push(`预设：${value.agentPreset}`)
        if (value.title) lines.push(`标题：${value.title}`)
        if (value.warning) lines.push(`提示：${value.warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const request = {}

      const cwd = nonEmptyString(args.cwd)
      if (cwd) request.cwd = cwd
      const agentPreset = nonEmptyString(args.agentPreset)
      if (agentPreset) request.agentPreset = agentPreset

      const controller = controllerOf(ctx)
      const created = await controller.create(request)
      const sessionId = created?.sessionId
      if (!sessionId) {
        throw new Error('session.create 未返回 sessionId，创建未生效。')
      }

      const result = { sessionId: String(sessionId), sinceSeq: -1 }
      if (created.agentPreset) result.agentPreset = String(created.agentPreset)

      const title = nonEmptyString(args.title)
      if (title) {
        try {
          const renamed = await controller.rename({ sessionId, title })
          result.title = String(renamed?.title ?? title)
        } catch (error) {
          result.warning = `会话已创建，但设置标题失败：${
            error instanceof Error ? error.message : String(error)
          }`
        }
      }

      return result
    },
  }
}

function createInjectTool(ctx) {
  return {
    name: 'session_inject',
    description:
      '向指定会话投递消息：queue 排队到下一轮，steer 立即引导。默认纯文本、不解析斜杠命令；asCommand=true 才真正执行命令（有副作用，慎用）。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '目标会话 id（session_list 或 session_create 返回）。',
        },
        message: {
          type: 'string',
          description: '投递文本；asCommand=true 时为完整斜杠命令。',
        },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: 'queue＝排队（默认）；steer＝立即引导。',
        },
        asCommand: {
          type: 'boolean',
          description: 'true＝真执行斜杠命令（有副作用）；默认 false。',
        },
      },
      required: ['sessionId', 'message'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          kind: { type: 'string' },
          mode: { type: 'string' },
          accepted: { type: 'boolean' },
          requestId: { type: 'string' },
          sinceSeq: { type: 'number' },
          commandId: { type: 'string' },
          commandText: { type: 'string' },
          commandError: { type: 'boolean' },
        },
        required: ['sessionId', 'kind', 'mode', 'accepted'],
        additionalProperties: false,
      },
      render: (args, value) => {
        if (value.kind === 'command') {
          const lines = [
            value.accepted
              ? `已执行斜杠命令（会话 ${value.sessionId}）`
              : `斜杠命令未成功（会话 ${value.sessionId}）`,
          ]
          if (value.commandText) lines.push(truncate(value.commandText, 600))
          if (value.commandError) lines.push('［命令返回错误或未解析］')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const lines = [
          `已注入会话 ${value.sessionId}（mode=${value.mode}，accepted=${value.accepted}）。`,
        ]
        if (value.sinceSeq !== undefined) {
          lines.push(`sinceSeq=${value.sinceSeq}（传给 session_wait 即可精确等这条的回复）`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = nonEmptyString(args.sessionId)
      if (!sessionId) throw new Error('sessionId 不能为空，请先用 session_list 确认目标会话。')

      const message = typeof args.message === 'string' ? args.message : ''
      if (message.trim() === '') throw new Error('message 不能为空。')

      if (args.asCommand === true) {
        const commands = ctx.get('commands')
        if (!commands || typeof commands.execute !== 'function') {
          throw new Error('commands 服务不可用：当前 profile 没有组合命令服务，无法执行斜杠命令。')
        }
        const controller = controllerOf(ctx)
        const resolved = await controller.resolveAgent(sessionId)
        const agent = resolved && resolved.agent
        if (!agent) {
          const error = resolved && resolved.error
          const code = error && typeof error === 'object' ? (error.code ?? 'unknown') : 'unknown'
          throw new Error(
            `斜杠命令只能在活会话上执行：会话 ${sessionId} 解析不出 agent（${String(code)}）。先用普通投递让其上线。`,
          )
        }
        const signal = exec && exec.signal !== undefined ? exec.signal : signalOf()
        const execution = await commands.execute(agent, message, [], signal)
        if (!execution) {
          return {
            sessionId,
            kind: 'command',
            mode: 'command',
            accepted: false,
            commandText: `未解析：${message} 不是宿主认识的斜杠命令。`,
            commandError: true,
          }
        }
        const result = execution.result ?? {}
        const out = {
          sessionId,
          kind: 'command',
          mode: 'command',
          accepted: result.kind === 'success',
        }
        if (execution.commandId !== undefined) out.commandId = String(execution.commandId)
        if (typeof result.text === 'string' && result.text !== '') out.commandText = truncate(result.text, 800)
        if (result.kind !== 'success') out.commandError = true
        return out
      }

      const mode = args.mode === 'steer' ? 'steer' : 'queue'
      const requestId = newRequestId()

      // 投递前先记下「此刻最大事件序号」作为等待锚点：调用方把它传给 session_wait，
      // 就能精确取到「我这次发言之后」的回复，而不是靠调用时刻的最大序号去猜。
      const anchor = await anchorOf(ctx, sessionId)

      const controller = controllerOf(ctx)
      const admitted = await controller.prompt(
        {
          requestId,
          sessionId,
          mode,
          content: [{ type: 'text', text: message }],
        },
        signalOf(),
      )

      const out = {
        sessionId,
        kind: 'prompt',
        mode,
        accepted: admitted?.accepted === true,
        requestId,
      }
      if (anchor !== undefined) out.sinceSeq = anchor
      return out
    },
  }
}

function createListTool(ctx) {
  return {
    name: 'session_list',
    description:
      '按活跃度列出可见会话，用于找 sessionId。只读，不唤醒冷会话。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '默认 20，范围 1-100。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sessionId: { type: 'string' },
                updatedAt: { type: 'string' },
                running: { type: 'boolean' },
                blank: { type: 'boolean' },
                origin: { type: 'string' },
                cwd: { type: 'string' },
              },
              required: ['sessionId', 'running', 'blank'],
              additionalProperties: false,
            },
          },
        },
        required: ['count', 'sessions'],
        additionalProperties: false,
      },
      render: (args, value) => {
        if (value.count === 0) return [{ type: 'text', text: '（没有可见会话）' }]
        const rows = value.sessions.map((row) => {
          const flags = [row.running ? 'running' : 'idle']
          if (row.blank) flags.push('blank')
          if (row.origin) flags.push(row.origin)
          const tail = row.cwd ? `  ${row.cwd}` : ''
          return `- ${row.sessionId}  [${flags.join(', ')}]  ${row.updatedAt}${tail}`
        })
        return [{ type: 'text', text: `${value.count} 个会话：\n${rows.join('\n')}` }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const rawLimit = Number(args.limit)
      const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 20

      const controller = controllerOf(ctx)
      const value = await controller.list({}, signalOf())
      const items = Array.isArray(value?.items) ? value.items : []

      const sessions = items.slice(0, limit).map((item) => {
        const row = {
          sessionId: String(item.sessionId),
          running: item.running === true,
          blank: item.blank === true,
        }
        if (typeof item.updatedAt === 'number') row.updatedAt = new Date(item.updatedAt).toISOString()
        else row.updatedAt = ''
        if (item.origin) row.origin = String(item.origin)
        if (item.cwd) row.cwd = String(item.cwd)
        return row
      })

      return { count: sessions.length, sessions }
    },
  }
}

function createCancelTool(ctx) {
  return {
    name: 'session_cancel',
    description:
      '取消会话当前轮次（不丢弃已排队消息）。用于解救卡在未结算工具调用上的会话。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '目标会话 id。',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          accepted: { type: 'boolean' },
        },
        required: ['sessionId', 'accepted'],
        additionalProperties: false,
      },
      render: (args, value) => [
        {
          type: 'text',
          text: value.accepted
            ? `已请求取消会话 ${value.sessionId} 的当前轮次。`
            : `会话 ${value.sessionId} 没有可取消的活动轮次。`,
        },
      ],
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = nonEmptyString(args.sessionId)
      if (!sessionId) throw new Error('sessionId 不能为空。')

      const controller = controllerOf(ctx)
      const result = await controller.cancel({ sessionId })
      return { sessionId, accepted: result?.accepted === true }
    },
  }
}

/* ───────────────────── 移植工具：wait / segments / status ───────────────────── */

function clampTimeout(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 180000
  return Math.min(3600000, Math.max(1000, Math.trunc(n)))
}

function createWaitTool(ctx) {
  return {
    name: 'session_wait',
    description:
      '等待会话产生新输出。默认等一条 assistant 文本回复；waitFor=segment 等任一已完成段落。预算内无新输出时返回既有回复并置 stale，不抛异常。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '目标会话 id。' },
        sinceSeq: {
          type: 'number',
          description: '只算该序号之后的输出（默认＝调用时最大序号；-1＝含既有）。',
        },
        timeoutMs: { type: 'number', description: '等待毫秒，默认 180000，最大 3600000。' },
        requireTurnEnd: {
          type: 'boolean',
          description: 'true＝等到该轮收尾再返回。',
        },
        waitFor: {
          type: 'string',
          enum: ['reply', 'segment'],
          description: 'reply（默认）等文本；segment 等任一完成段落。',
        },
        includeReasoning: { type: 'boolean', description: 'segment 时附带思维链（默认 false）。' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          sinceSeq: { type: 'number' },
          live: { type: 'boolean' },
          running: { type: 'boolean' },
          replySeq: { type: 'number' },
          replyText: { type: 'string' },
          replyReasoning: { type: 'string' },
          replyToolCalls: { type: 'array', items: { type: 'string' } },
          turnEnded: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          stale: { type: 'boolean' },
          aborted: { type: 'boolean' },
          waitedMs: { type: 'number' },
        },
        required: ['sessionId', 'sinceSeq', 'live', 'turnEnded', 'timedOut', 'stale', 'aborted', 'waitedMs'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const lines = []
        if (value.replyText !== undefined) {
          lines.push(`回复 seq ${value.replySeq ?? '?'}：${truncate(value.replyText, REPLY_TEXT_LIMIT)}`)
        } else {
          lines.push(`等待 ${value.waitedMs}ms：没有可读的 assistant 文本回复`)
        }
        if (value.replyToolCalls && value.replyToolCalls.length > 0) {
          lines.push(`工具：${value.replyToolCalls.join(', ')}`)
        }
        if (value.replyReasoning !== undefined) lines.push(`思维链：${truncate(value.replyReasoning, 300)}`)
        lines.push(`turnEnded=${value.turnEnded}　live=${value.live}`)
        if (value.live === false) lines.push('［离线］该会话当前没有活 agent，不会产出新输出；返回的是既有回复')
        else if (value.timedOut) lines.push('［等待超时］预算内没有出现新输出')
        if (value.stale) lines.push('［stale］返回的是等待开始前就有的回复')
        if (value.aborted) lines.push('［已取消］等待被调用方中止')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = nonEmptyString(args.sessionId)
      if (!sessionId) throw new Error('sessionId 不能为空，请先用 session_list 确认目标会话。')

      const signal = exec && exec.signal !== undefined ? exec.signal : undefined
      const log = await readSessionLog(ctx, sessionId, signal)
      const requested = Number(args.sinceSeq)
      const baseline = Number.isInteger(requested) && requested >= -1 ? requested : maxSeq(log.events)

      const result = await waitForReply(ctx, {
        sessionId,
        baselineSeq: baseline,
        // 没有活 agent 的会话不会产出新输出：只做一次检查就返回，不白占等待预算。
        timeoutMs: log.agentsAvailable && !log.live ? 0 : clampTimeout(args.timeoutMs),
        requireTurnEnd: args.requireTurnEnd === true,
        waitForSegment: args.waitFor === 'segment',
        signal,
      })

      const out = {
        sessionId,
        sinceSeq: baseline,
        live: log.live,
        turnEnded: result.turnEnded,
        timedOut: result.timedOut,
        stale: result.stale,
        aborted: result.aborted,
        waitedMs: result.waitedMs,
      }
      if (log.agent !== undefined) out.running = log.agent.status === 'running'
      const reply = result.message
      if (reply !== null) {
        out.replySeq = reply.seq
        if (reply.text !== undefined) out.replyText = truncate(reply.text, REPLY_TEXT_LIMIT)
        if (reply.toolCalls !== undefined) out.replyToolCalls = reply.toolCalls
        if (args.includeReasoning === true && reply.reasoning !== undefined) {
          out.replyReasoning = truncate(reply.reasoning, REASONING_TAIL_LIMIT)
        }
      }
      return out
    },
  }
}

function createSegmentsTool(ctx) {
  return {
    name: 'session_segments',
    description:
      '按 sinceSeq 翻页读取会话的已完成段落。默认只回文本与工具名；思维链需 includeReasoning=true。活/离线会话都可读。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '目标会话 id（活会话或离线会话）。' },
        sinceSeq: { type: 'number', description: '只返回该事件序号之后的已完成段落（翻页游标，默认 0）。' },
        limit: { type: 'number', description: '最多返回多少段（默认 10，最大 50）。' },
        includeReasoning: { type: 'boolean', description: '是否附带每段的思维链（默认 false）。' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          live: { type: 'boolean' },
          nextCursorSeq: { type: 'number' },
          returned: { type: 'number' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                seq: { type: 'number' },
                turn: { type: 'number' },
                step: { type: 'number' },
                openTurn: { type: 'boolean' },
                text: { type: 'string' },
                reasoning: { type: 'string' },
                toolCalls: { type: 'array', items: { type: 'string' } },
              },
              required: ['seq', 'turn', 'step', 'openTurn'],
              additionalProperties: false,
            },
          },
        },
        required: ['sessionId', 'live', 'nextCursorSeq', 'returned', 'segments'],
        additionalProperties: false,
      },
      render: (args, value) => {
        if (value.segments.length === 0) return [{ type: 'text', text: '（没有新的已完成段落）' }]
        const rows = value.segments.map((seg) => {
          const head = `#${seg.seq} (turn ${seg.turn} step ${seg.step}${seg.openTurn ? ' 进行中' : ''})`
          const tools = seg.toolCalls && seg.toolCalls.length > 0 ? `［工具：${seg.toolCalls.join(',')}］` : ''
          const reason = seg.reasoning !== undefined ? `［思维链 ${seg.reasoning.length} 字］` : ''
          const body = seg.text !== undefined ? truncate(seg.text, 200) : '（无文本）'
          return `${head}${tools}${reason}\n  ${body}`
        })
        rows.push(`共 ${value.returned} 段；下一页游标 sinceSeq=${value.nextCursorSeq}`)
        return [{ type: 'text', text: rows.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = nonEmptyString(args.sessionId)
      if (!sessionId) throw new Error('sessionId 不能为空。')

      const sinceSeq = Number.isInteger(Number(args.sinceSeq)) && Number(args.sinceSeq) >= 0 ? Number(args.sinceSeq) : 0
      const rawLimit = Number(args.limit)
      const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 10
      const includeReasoning = args.includeReasoning === true

      const log = await readSessionLog(ctx, sessionId)
      const all = segmentsSince(log.events, sinceSeq)
      const page = all.slice(0, limit)

      return {
        sessionId,
        live: log.live,
        nextCursorSeq: page.length === 0 ? sinceSeq : page[page.length - 1].seq,
        returned: page.length,
        segments: page.map((seg) => {
          const row = { seq: seg.seq, turn: seg.turn, step: seg.step, openTurn: seg.openTurn }
          if (seg.text !== undefined) row.text = truncate(seg.text, SEGMENT_TEXT_LIMIT)
          if (seg.toolCalls.length > 0) row.toolCalls = seg.toolCalls
          if (includeReasoning && seg.reasoning !== undefined) row.reasoning = truncate(seg.reasoning, REASONING_TAIL_LIMIT)
          return row
        }),
      }
    },
  }
}

function createStatusTool(ctx) {
  return {
    name: 'session_status',
    description:
      '读取会话实时进度：running/idle、在线状态、未闭合轮次、最近 turn、停滞判定、待处理输入、最新回复与思维链。用于判断目标会话卡住、在算还是已收尾。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '目标会话 id。' },
        stalledMsThreshold: {
          type: 'number',
          description: '多少毫秒无事件算卡住（默认 60000；idle 不判）。',
        },
        recent: { type: 'number', description: '最近消息条数，默认 8，最大 20。' },
        reasoning: {
          type: 'string',
          enum: ['none', 'last', 'live', 'tail'],
          description: 'tail（默认）、last、live、none 四选一。',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          live: { type: 'boolean' },
          agentAvailable: { type: 'boolean' },
          running: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          openTurn: { type: 'boolean' },
          lastTurn: { type: 'number' },
          lastActivityAt: { type: 'string' },
          stalledMs: { type: 'number' },
          stalled: { type: 'boolean' },
          stalledMsThreshold: { type: 'number' },
          pendingWork: { type: 'boolean' },
          nextTurnCount: { type: 'number' },
          nextStepCount: { type: 'number' },
          lastAssistantText: { type: 'string' },
          lastReasoning: { type: 'string' },
          liveReasoning: { type: 'string' },
          reasoningTail: { type: 'string' },
          messageCount: { type: 'number' },
          recent: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                seq: { type: 'number' },
                role: { type: 'string' },
                text: { type: 'string' },
                toolCalls: { type: 'array', items: { type: 'string' } },
              },
              required: ['seq', 'role'],
              additionalProperties: false,
            },
          },
        },
        required: ['sessionId', 'live', 'running', 'openTurn', 'lastTurn', 'stalled', 'messageCount', 'recent'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const flag = value.stalled ? ' ［STALLED］' : ''
        const head = `${value.sessionId} = ${value.running}${value.live ? '（在线）' : '（离线）'}${flag}`
        const lines = [value.title ? `${head}　${value.title}` : head]
        const meta = [`openTurn=${value.openTurn}`, `lastTurn=${value.lastTurn}`, `消息 ${value.messageCount} 条`]
        if (value.stalledMs !== undefined) meta.push(`距上一事件 ${Math.round(value.stalledMs / 1000)}s`)
        lines.push(meta.join('　'))
        if (value.pendingWork !== undefined) {
          lines.push(`待处理输入：${value.pendingWork ? '有' : '无'}（队列 ${value.nextTurnCount ?? 0} / 步内 ${value.nextStepCount ?? 0}）`)
        }
        if (value.lastAssistantText !== undefined) {
          lines.push(`最新回复：${truncate(value.lastAssistantText, 300)}`)
        }
        if (value.reasoningTail !== undefined) lines.push(`思维链尾巴：${truncate(value.reasoningTail, 200)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = nonEmptyString(args.sessionId)
      if (!sessionId) throw new Error('sessionId 不能为空。')

      const rawThreshold = Number(args.stalledMsThreshold)
      const threshold = Number.isFinite(rawThreshold) && rawThreshold >= 0 ? Math.trunc(rawThreshold) : 60000
      const reasoningMode =
        args.reasoning === 'none' || args.reasoning === 'last' || args.reasoning === 'live' ? args.reasoning : 'tail'
      const rawRecent = Number(args.recent)
      const shown = Number.isInteger(rawRecent) && rawRecent >= 0 ? Math.min(rawRecent, 20) : 8

      const log = await readSessionLog(ctx, sessionId)

      // 会话行（在线状态、running、cwd）来自 list()；读不到就退回 agent/事件推断。
      let summary
      try {
        const listed = await controllerOf(ctx).list({}, signalOf())
        const items = Array.isArray(listed?.items) ? listed.items : []
        summary = items.find((item) => String(item.sessionId) === sessionId)
      } catch {
        summary = undefined
      }

      const events = log.events
      const rows = foldMessages(events)
      let lastActivityAt = null
      let lastTurn = 0
      let openTurn = false
      for (const event of events) {
        if (event.type === 'turn/start' || event.type === 'turn/end') {
          const turn = event.data?.turn
          if (typeof turn === 'number' && turn > 0) lastTurn = turn
        }
        if (event.type === 'turn/start') openTurn = true
        if (event.type === 'turn/end') openTurn = false
        if (typeof event.time === 'number' && event.time > (lastActivityAt ?? 0)) lastActivityAt = event.time
      }

      let lastAssistantText
      let lastReasoning
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i]
        if (row.role !== 'assistant') continue
        if (lastAssistantText === undefined && row.text !== undefined) lastAssistantText = row.text
        if (lastReasoning === undefined && row.reasoning !== undefined) lastReasoning = row.reasoning
        if (lastAssistantText !== undefined && lastReasoning !== undefined) break
      }

      const liveSlice = liveReasoningSnapshot(events)
      const liveReasoning = liveSlice !== null && liveSlice.reasoning !== '' ? liveSlice.reasoning : undefined
      const tail = reasoningTailOf(liveReasoning, lastReasoning)
      const inbox = log.agent?.inbox

      const running = log.agent !== undefined
        ? log.agent.status === 'running' ? 'running' : 'idle'
        : summary?.running === true ? 'running' : 'idle'
      const stalledMs = lastActivityAt === null ? null : Date.now() - lastActivityAt

      const out = {
        sessionId,
        live: log.live,
        agentAvailable: summary ? summary.agentAvailable === true : log.live,
        running,
        openTurn,
        lastTurn,
        stalled: isStalled(running, stalledMs, threshold),
        stalledMsThreshold: threshold,
        messageCount: rows.length,
        recent: rows.slice(-shown).map((row) => {
          const item = { seq: row.seq, role: row.role }
          if (row.text !== undefined) item.text = truncate(row.text, 300)
          if (row.toolCalls !== undefined) item.toolCalls = row.toolCalls
          return item
        }),
      }
      const title = titleOf(events)
      if (title !== undefined) out.title = title
      const cwd = summary?.cwd ?? log.agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') out.cwd = cwd
      if (lastActivityAt !== null) out.lastActivityAt = new Date(lastActivityAt).toISOString()
      if (stalledMs !== null) out.stalledMs = stalledMs
      if (inbox !== undefined) {
        const nextTurnCount = Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0
        const nextStepCount = Array.isArray(inbox.nextStep) ? inbox.nextStep.length : 0
        out.pendingWork = inbox.hasPending === true || nextTurnCount + nextStepCount > 0
        out.nextTurnCount = nextTurnCount
        out.nextStepCount = nextStepCount
      }
      if (lastAssistantText !== undefined) out.lastAssistantText = truncate(lastAssistantText, REPLY_TEXT_LIMIT)
      if (reasoningMode !== 'none') {
        if (reasoningMode !== 'live' && lastReasoning !== undefined) {
          out.lastReasoning = truncate(lastReasoning, REASONING_TAIL_LIMIT)
        }
        if (reasoningMode !== 'last' && liveReasoning !== undefined) {
          out.liveReasoning = truncate(liveReasoning, REASONING_TAIL_LIMIT)
        }
        if (reasoningMode === 'tail' && tail !== undefined) out.reasoningTail = tail
      }
      return out
    },
  }
}

function createMigrateTool(ctx) {
  return {
    name: 'session_migrate',
    description:
      '把会话任务迁移到新建的继任会话：提取任务与上下文成交接提示，新建会话投递，**交接成功后才取消原会话当前轮**。用于会话卡死或换会话继续。',
    parameters: {
      type: 'object',
      properties: {
        fromSessionId: { type: 'string', description: '被接管的原会话 id。' },
        task: { type: 'string', description: '显式指定任务指令，覆盖自动提取。' },
        reason: { type: 'string', description: '写进交接提示的中断原因。' },
        cwd: { type: 'string', description: '继任会话工作目录，省略沿用原会话。' },
        agentPreset: { type: 'string', description: '继任会话预设，省略用默认。' },
        stopSource: { type: 'boolean', description: '交接后取消原会话当前轮（默认 true）。' },
        includeReasoning: { type: 'boolean', description: '交接时带原会话思维链（默认 true）。' },
      },
      required: ['fromSessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          fromSessionId: { type: 'string' },
          toSessionId: { type: 'string' },
          stopped: { type: 'boolean' },
          descendantCount: { type: 'number' },
          promptChars: { type: 'number' },
          stopWarning: { type: 'string' },
        },
        required: ['fromSessionId', 'toSessionId', 'stopped', 'descendantCount', 'promptChars'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const lines = [
          `任务已迁移：${value.fromSessionId} → ${value.toSessionId}`,
          `原会话${value.stopped ? '已取消' : '保持运行（stopSource=false 或取消失败）'}　子代理 ${value.descendantCount} 个　交接提示 ${value.promptChars} 字`,
        ]
        if (value.stopWarning) lines.push(`⚠️ 取消原会话失败：${value.stopWarning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const fromSessionId = nonEmptyString(args.fromSessionId)
      if (!fromSessionId) throw new Error('fromSessionId 不能为空。')

      const controller = controllerOf(ctx)
      const log = await readSessionLog(ctx, fromSessionId)

      // 目标目录：显式 cwd > 活 agent 的 header > list 里的记录。
      let cwd = nonEmptyString(args.cwd)
      if (!cwd) {
        const headerCwd = log.agent?.session?.header?.cwd
        if (typeof headerCwd === 'string' && headerCwd !== '') cwd = headerCwd
      }
      if (!cwd) {
        try {
          const listed = await controller.list({}, signalOf())
          const row = (Array.isArray(listed?.items) ? listed.items : []).find(
            (item) => String(item.sessionId) === fromSessionId,
          )
          if (row && typeof row.cwd === 'string' && row.cwd !== '') cwd = row.cwd
        } catch {
          /* 读不到就让下面的显式报错接手 */
        }
      }
      if (!cwd) {
        throw new Error('无法确定继任会话的工作目录：原会话没有记录的 cwd，请显式传 cwd。')
      }

      const context = extractTaskContext(log.events)
      const taskOverride = nonEmptyString(args.task)
      if (taskOverride) context.task = clip(taskOverride, TASK_LIMIT)
      if (args.includeReasoning === false) delete context.lastReasoning

      const descendants = log.agent !== undefined ? collectDescendants(ctx, log.agent) : []
      const reason = nonEmptyString(args.reason) ?? '原会话任务被转移到新会话继续执行。'
      const promptText = buildHandoffPrompt({ sessionId: fromSessionId, cwd, reason, context, descendants })

      // 第一步：先建继任会话。创建失败绝不能先停原会话。
      const request = { cwd }
      const preset = nonEmptyString(args.agentPreset)
      if (preset) request.agentPreset = preset
      const created = await controller.create(request)
      const toSessionId = created?.sessionId
      if (!toSessionId) {
        throw new Error('创建继任会话失败（create 未返回 sessionId）：原会话未做任何改动。')
      }

      // 第二步：交接提示必须投递成功，否则同样不停原会话。
      const requestId = newRequestId()
      try {
        await controller.prompt(
          {
            requestId,
            sessionId: String(toSessionId),
            mode: 'queue',
            content: [{ type: 'text', text: promptText }],
          },
          signalOf(),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          `继任会话已创建（${toSessionId}）但交接提示投递失败：${message}。原会话未停止，请手动接管或重试。`,
        )
      }

      // 第三步：交接成功后才停原会话。
      let stopped = false
      let stopWarning
      if (args.stopSource !== false) {
        try {
          const cancelled = await controller.cancel({ sessionId: fromSessionId })
          stopped = cancelled?.accepted === true
        } catch (error) {
          stopWarning = error instanceof Error ? error.message : String(error)
        }
      }

      const out = {
        fromSessionId,
        toSessionId: String(toSessionId),
        stopped,
        descendantCount: descendants.length,
        promptChars: promptText.length,
      }
      if (stopWarning !== undefined) out.stopWarning = truncate(stopWarning, 300)
      return out
    },
  }
}

/* ═════════════════════════ 跨会话守候（watch）· 接线层 ═════════════════════════
 *
 * 三个模块各管一段（store 持久化 / detector 判定 / gate 闸门），本段只负责把它们
 * 接起来：登记与查看的口子交给模型，命中之后按动作投递回守候方。
 * 契约见 docs/cross-session-trigger-contract.md §4。
 *
 * 四条硬约束，每条都对着一次真实的坑：
 *   1. `session/event` 是高频路径：没有 pending 守候盯着这个会话就立刻 return，
 *      连一个字符串都不解析——插件没有理由让整条宿主事件总线陪着它做无用功。
 *   2. 所有回调自兜 try/catch：宿主不替监听器收异常，抛出去会拖累整批分发。
 *   3. 两个工具必须同时给 `output.schema` 与 `output.render`，缺一个会让整批工具
 *      注册失败（本机踩过，代价是会话控制整块消失）。
 *   4. 时间固定 +08:00：持久化与消息里的时间都按东八区算，不随机器时区漂。
 */

/** 巡检周期：5 分钟。事件是主路径，定时只兜底那些「等出来」的条件。 */
const WATCH_TICK_MS = 5 * 60 * 1000
/** idle 条件的默认静默阈值，与工具参数默认值、契约一致。 */
const WATCH_DEFAULT_IDLE_MS = 300000
/** 默认有效期 7 天（168 小时）。写出来是为了让契约里的数字只出现在一处。 */
const WATCH_DEFAULT_EXPIRES_HOURS = 168
/** M0 作用域实测的日志上限：够证明「看得到多个会话」，又不至于把日志刷满。 */
const WATCH_SCOPE_LOG_LIMIT = 20
/**
 * `completed` 的静默窗口（计划 §2.4）：一轮结束不等于活干完了。
 * 一个会话做完一件事往往连续几轮（改代码 → 跑测试 → 写文档），每轮都唤醒等于一次派活叫醒四次。
 * 窗口内又来一轮就重置计时，只留最后一轮的尾部文本。
 */
const WATCH_QUIET_MS = 60 * 1000
/** 静默窗口的收账周期：15 秒扫一次，保证「完成 → 唤醒」能在 90 秒内走完（验收 §8.1）。 */
const WATCH_QUIET_DRAIN_MS = 15 * 1000
/**
 * 目标会话从 list 里消失几次才算「没了」。
 * 取 2 而不是 1：list 会读持久化，偶发一次读空不该把正在等的守候判死。
 */
const WATCH_MISS_LIMIT = 2
const WATCH_CONDITIONS = ['completed', 'failed', 'truncated', 'settled', 'idle', 'question', 'stalled']

/**
 * `settled` 的匹配集合：一轮结束的任何形态。
 *
 * 2026-11-13 的教训——派活时只订 completed，目标那轮以 `reason=error` 结束，
 * detector 判成 failed 却没有任何守候在听，结果「会话断了」这件事谁也没收到。
 * 订 settled 就是「不管成败，收尾就叫醒我」，派活场景应该用它，而不是 completed。
 */
const SETTLED_KINDS = ['completed', 'failed']
const WATCH_ACTIONS = ['wake', 'notify', 'record']
/** 命中消息的固定尾句。有了它，被唤起的会话才不会把通知当提问回一句，避免两台会话互相叫醒。 */
const WATCH_FOOTER = '（这是自动通知，无需回复本条消息。）'

/**
 * 守候存储根：`<DSH_HOME>/session-control`。
 *
 * 兜底顺序：`ctx.get('home')`（若服务可用且给字符串）→ `DSH_HOME` → `~/.dsh`。
 *
 * 为什么不用 `ctx.home`：Cordis 的服务属性在未 inject 时**访问即抛**
 * （`cannot get property "home" without inject`）。2026-11-12 就是栽在这里——
 * 异常被 installWatchWiring 兜住后整段守候静默跳过，表现成「插件加载了但工具不存在」。
 * `ctx.get(key)` 是安全读取：服务不存在返回 undefined，不抛。
 */
function watchesRootOf(ctx) {
  let fromCtx
  try {
    const value = typeof ctx?.get === 'function' ? ctx.get('home') : undefined
    if (typeof value === 'string') fromCtx = nonEmptyString(value)
  } catch {
    /* 读不到服务就退回环境变量与默认值，绝不把异常带进接线 */
  }
  const fromEnv = nonEmptyString(process.env.DSH_HOME)
  return join(fromCtx ?? fromEnv ?? join(homedir(), '.dsh'), 'session-control')
}

/**
 * epoch 毫秒 → ISO（固定 +08:00）。
 * 与 watch-store 内的格式化同口径：UTC 取值再手工加偏移，不查系统时区也不依赖 ICU，
 * 换台机器输出一致，日志与 watches.json 才能互相对照。
 */
function watchIsoOf(epochMs) {
  const shifted = new Date(Number(epochMs) + 8 * 60 * 60 * 1000)
  const pad = (value) => (value < 10 ? `0${value}` : String(value))
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  return `${date}T${time}+08:00`
}

/** ISO 或 epoch → epoch。解析不出来返 undefined：宁可少判一次，也不凭坏值算差值。 */
function watchEpochOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value === '') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** 异常 → 一行可读文本。日志与 lastError 都只留一行。 */
function watchErrorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 今天已经 wake 过几次（按 +08:00 的自然日切）。
 *
 * 读的是**实际生效**的动作（`effectiveAction`），不是登记时请求的动作：
 * 夜里被闸门降级成 notify/record 的那次如果照旧记成 wake，就会悄悄削掉白天的额度，
 * 而注释里写的是「降级不消耗预算」——两者必须一致，否则预算会自己吃自己。
 *
 * 旧记录没有 `effectiveAction`（字段是后加的）时退回 `action`，保持向后兼容。
 */
function firedTodayCount(store, nowMs) {
  const today = watchIsoOf(nowMs).slice(0, 10)
  let count = 0
  for (const watch of store.all()) {
    if (watch.state !== 'fired') continue
    const firedAs = typeof watch.effectiveAction === 'string' ? watch.effectiveAction : watch.action
    if (firedAs !== 'wake') continue
    if (typeof watch.firedAt === 'string' && watch.firedAt.slice(0, 10) === today) count += 1
  }
  return count
}

/** 一条 watch → 工具返回行。remainingMs 只对仍在生效的算：已结束的没有剩余可言。 */
function watchRowOf(watch, nowMs, outcome) {
  const row = {
    watchId: String(watch.id),
    target: String(watch.target),
    condition: String(watch.condition),
    action: String(watch.action),
    state: String(watch.state),
  }
  if (typeof outcome === 'string' && outcome !== '') row.outcome = outcome
  if (watch.state === 'pending') {
    const expires = watchEpochOf(watch.expiresAt)
    if (expires !== undefined && expires > nowMs) row.remainingMs = expires - nowMs
  }
  return row
}

/**
 * 命中消息。刻意写成自足的一段：被叫起来的会话可能刚醒，不该再去猜「谁在等我、等到什么」。
 * 末尾那句固定说明不是客套——没有它，两个会话会互相回话、互为触发源。
 */
function renderWatchMessage(watch, hit) {
  const tail = typeof hit.text === 'string' && hit.text !== '' ? hit.text : '无尾部文本'
  const seq = Number.isFinite(Number(hit.seq)) ? Number(hit.seq) : -1
  return [
    `[守候命中] ${watch.target} 的 ${watch.condition} 条件已满足（${watchIsoOf(hit.at)}）。`,
    `尾部：${tail}`,
    `下一步：session_segments({ sessionId: '${watch.target}', sinceSeq: ${seq} }) 取全文再判断。`,
    WATCH_FOOTER,
  ].join('\n')
}

/**
 * 该轮最后一条 assistant 消息的文本，喂给 detector 当「尾部」。
 *
 * 只认**最后一条 assistant 消息本身**：它没有文本就是没有，绝不往前找一条带文本的
 * 顶上。早先的实现会往前回溯，于是「最后一步只发了工具调用」这种半途收尾，
 * 会被上一轮的总结掩盖成正常完成——2026-11-13 的派活中断正好落在这个形状上。
 */
function latestAssistantTextOf(session) {
  try {
    const events = eventsOf(session)
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type !== 'assistant/message') continue
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return ''
      return content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
    }
  } catch {
    /* 读不到就当没有尾部文本：命中本身不依赖它 */
  }
  return ''
}

/**
 * 悬空提问的记账（只对**被守候的会话**做，见监听器里的早退）。
 * detector.tick 需要 `openQuestionSince`，而宿主的提问投影里只有 callId 与问题本身、
 * 没有时间戳；与其每轮巡检去翻事件日志，不如在事件经过时记一笔：
 * `tool/call` 见到 ask_user_question 记下 callId 与时刻，配对的 `tool/result` 到了就清掉。
 *
 * 已知局限：插件加载前就已经挂着的提问不会补记——补记要读历史日志，代价不值。
 */
function rememberOpenQuestion(openQuestions, sessionId, event) {
  try {
    if (event.type === 'tool/call') {
      if (event.data?.name !== 'ask_user_question') return
      const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
      openQuestions.set(sessionId, { callId, since: typeof event.time === 'number' ? event.time : Date.now() })
      return
    }
    if (event.type !== 'tool/result') return
    const current = openQuestions.get(sessionId)
    if (current === undefined) return
    const callId = String(event.data?.message?.toolCallId ?? event.data?.callId ?? '')
    if (current.callId === '' || callId === '' || callId === current.callId) openQuestions.delete(sessionId)
  } catch {
    /* 记账失败只影响 question 条件的一轮巡检，不该盖掉事件本身 */
  }
}

/**
 * 目标会话是否还在。查不到返回 undefined（＝「未观测」，闸门按还活着处理）：
 * 一次读不到状态不该把整批守候判死。
 */
async function targetAliveOf(ctx, sessionId) {
  try {
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.list !== 'function') return undefined
    const listed = await controller.list({}, signalOf())
    const items = Array.isArray(listed?.items) ? listed.items : []
    return items.some((item) => String(item.sessionId) === sessionId)
  } catch {
    return undefined
  }
}

/** 闸门拒绝原因 → 给模型看的一句话。拒绝登记只有三种，别把内部代号直接丢给模型。 */
function gateExplain(reason) {
  if (reason === 'self-watch') return '守候方与被守候方是同一个会话（自己等自己会成环）。'
  if (reason === 'target-gone') return '被守候的会话不存在，先用 session_list 核对 id。'
  if (reason === 'too-many-pending') return '挂着的守候已达上限，先取消几条或等它们命中。'
  return String(reason)
}

/**
 * 执行一次命中。
 *
 * 异步投递，但**调用方不 await**：事件处理器必须立刻返回，否则一条 turn/end 会卡住
 * 整个会话的事件分发。也正因为没人接得住异常，本函数把投递与落盘都兜在自己的 try 里。
 */
async function fireWatch(ctx, store, watch, hit, warn, telemetry) {
  const at = Date.now()
  const evidence = { seq: hit.seq, text: hit.text, reason: hit.reason }
  try {
    // 登记时的判定早就过期了（可能隔了几小时）：真正该拦的是此刻，所以再走一次闸门。
    const gate = evaluateGate({
      requested: watch.action,
      now: at,
      firedToday: firedTodayCount(store, at),
      // 队列上限是「登记」闸门，不是「点火」闸门：拿它拦自己，只会让已有守候在夜间集体哑火。
      pendingCount: 0,
      watcherIsTarget: false,
    })
    const effective = gate.allowed ? gate.effective : 'record'

    // 「降级」只指闸门把请求的动作压轻了。`record-requested` 是调用方本来就只要 record，
    // `allowed` 是原样放行——把他们记成降级，统计里会凭空长出一堆不存在的降级。
    const degraded = gate.reason === 'quiet-hours' || gate.reason === 'wake-budget' ? gate.reason : ''

    // 先入账再投递：投递抛异常时账上已经有一条，settle('failed') 才找得到它。
    try {
      telemetry?.record({
        watchId: watch.id,
        target: watch.target,
        watcher: watch.watcher,
        condition: watch.condition,
        requested: watch.action,
        effective,
        degraded,
        eventAt: Number.isFinite(Number(hit.eventAt)) ? Number(hit.eventAt) : at,
      })
    } catch {
      /* 账本失败不影响守候本身 */
    }

    if (effective === 'record') {
      store.update(watch.id, {
        state: 'fired',
        firedAt: watchIsoOf(at),
        attempts: watch.attempts + 1,
        evidence,
        effectiveAction: 'record',
      })
      warn(`守候命中，按 record 落盘（${gate.reason}）：${watch.id} ← ${watch.target} ${hit.kind}`)
      return
    }

    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.prompt !== 'function') {
      store.update(watch.id, {
        state: 'failed',
        attempts: watch.attempts + 1,
        evidence,
        lastError: 'sessionController 不可用，无法投递命中消息。',
      })
      try {
        telemetry?.settle(watch.id, 'failed', { note: 'sessionController 不可用' })
      } catch {
        /* 账本失败不影响守候本身 */
      }
      warn(`守候命中但投递失败（sessionController 不可用）：${watch.id} ← ${watch.target}`)
      return
    }

    // wake 与 notify 都走 prompt 的 queue 通道（契约 §4.3）：会话空闲时它拉起新一轮，
    // 正在跑时它排进下一轮。两者真正的差额由闸门的日预算来限，而不在这里分叉。
    await controller.prompt(
      {
        requestId: newRequestId(),
        sessionId: watch.watcher,
        mode: 'queue',
        content: [{ type: 'text', text: renderWatchMessage(watch, hit) }],
      },
      signalOf(),
    )
    store.update(watch.id, {
      state: 'fired',
      firedAt: watchIsoOf(at),
      attempts: watch.attempts + 1,
      evidence,
      effectiveAction: effective,
    })
    warn(`守候命中（${effective}）：${watch.id} ← ${watch.target} ${hit.kind}`)
  } catch (error) {
    const text = watchErrorText(error)
    try {
      store.update(watch.id, { state: 'failed', attempts: (watch.attempts ?? 0) + 1, evidence, lastError: text })
    } catch {
      /* 连落盘都失败，就只剩下面这行日志了 */
    }
    try {
      telemetry?.settle(watch.id, 'failed', { note: text })
    } catch {
      /* 账本失败不影响守候本身 */
    }
    warn(`守候执行失败（${watch.id}）：${text}`)
  }
}

/**
 * 认领一次投递：同一条守候在同一时刻只允许一次投递在路上。
 *
 * 事件是并发派发的。2026-11-13 实测：一次 cancel 在 12ms 内送来两个终态事件
 * （`turn/end` 与随后的 `tool/result`），两次判定都在 store 把状态改成 `fired`
 * 之前通过，于是同一条守候被投递两次、账本里多出一条记录，主人看到重复通知。
 *
 * 占位必须在**调用 `fireWatch` 之前**同步完成——写成 `void fireWatch(...)`
 * 再靠它内部的 `store.update` 去防重是不够的，那已经晚了一个微任务。
 *
 * @param {Set<string>} firing 正在投递中的 watchId 集合。
 */
function claimFire(firing, watch, ctx, store, hit, warn, telemetry) {
  if (firing.has(watch.id)) return
  firing.add(watch.id)
  void fireWatch(ctx, store, watch, hit, warn, telemetry)
    .catch(() => {
      /* fireWatch 自己已经兜过异常并落账；这里只保证不会漏成未处理的 rejection */
    })
    .finally(() => firing.delete(watch.id))
}

/**
 * 构造 `session/event` 监听器。
 *
 * 顺序是刻意的：先打 M0 作用域日志（只读 `session.id` 与 `event.type`），再问
 * 「有没有人等这个会话」，没有就立刻 return——高频路径上不碰 `event.data` 一个字段。
 */
function makeWatchListener(ctx, store, detector, warn, lastEventAt, openQuestions, scopeSeen, telemetry, pendingHits, firing) {
  return (session, event) => {
    try {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      const type = typeof event?.type === 'string' ? event.type : ''

      // M0 作用域实测：只有根作用域的监听器才看得见其它会话，这行日志是唯一实证。
      // 每个会话只打一次，且总数封顶，免得把日志刷成噪音。
      if (sessionId !== '' && !scopeSeen.has(sessionId) && scopeSeen.size < WATCH_SCOPE_LOG_LIMIT) {
        scopeSeen.add(sessionId)
        warn(`event scope ok, saw ${sessionId} ${type}`)
        // 宿主的 logger.warn 在桌面端不落文件，M0 的作用域实证只能靠落盘轨迹取：
        // 重启后数这个文件里有几个不同 sessionId，就知道监听器跨不跨会话。
        recordBootTrace(`scope ok ${sessionId} ${type}`)
      }

      if (sessionId === '') return
      const at = typeof event?.time === 'number' ? event.time : Date.now()

      // 账本的两条观察通道**必须排在早退之前**：守候一旦 fired 就不再是 pending，
      // 走不到下面的 watch 查询。而「它到底有没有用」恰恰要在这之后才能判。
      if (telemetry !== undefined) {
        try {
          if (type === 'turn/end') {
            for (const row of telemetry.noteTargetTurnEnd(sessionId, at)) {
              warn(`守候判早了（premature）：${row.watchId} ← ${row.target} 命中后目标又收了一轮`)
            }
          }
          telemetry.noteWatcherActivity(sessionId, at)
          telemetry.expireDue(at)
        } catch {
          /* 账本失败不影响守候本身 */
        }
      }

      const watches = store.pending().filter((watch) => watch.target === sessionId)
      if (watches.length === 0) return

      // 两个观测值只在被守候的会话上记：不为整条事件流做记账。
      lastEventAt.set(sessionId, at)
      rememberOpenQuestion(openQuestions, sessionId, event)

      const hit = detector.observe({
        sessionId,
        event,
        session: { lastAssistantText: () => latestAssistantTextOf(session) },
        at,
      })
      if (hit === null) return

      for (const watch of watches) {
        // settled 是「终态任一」的匹配口径：completed 与 failed 都算收尾。
        // truncated 是 completed 的子类：同一轮结束、但没有产出（reason='no-output'），
        // 订阅 completed 的人照收不误，订 truncated 的只收这一种。
        const matched =
          watch.condition === hit.kind ||
          (watch.condition === 'settled' && SETTLED_KINDS.includes(hit.kind)) ||
          (watch.condition === 'truncated' && hit.kind === 'completed' && hit.reason === 'no-output')
        if (!matched) continue
        // completed 要过静默窗口（计划 §2.4）：窗口内又来一轮就重置，只留最后一轮。
        // record 动作不打扰任何人，没有等的必要，立即落账。
        if (hit.kind === 'completed' && watch.action !== 'record') {
          pendingHits?.set(watch.id, { watch, hit, dueAt: Date.now() + WATCH_QUIET_MS })
          continue
        }
        // 不 await：事件分发必须先返回；fireWatch 自己兜住所有异常。
        claimFire(firing, watch, ctx, store, hit, warn, telemetry)
      }
    } catch (error) {
      warn(`处理 session/event 失败（已忽略）：${watchErrorText(error)}`)
    }
  }
}

/**
 * 收掉到期（或已作废）的静默窗口命中。
 *
 * 独立于 5 分钟巡检：验收要求「90 秒内被唤醒」，而巡检周期就是 5 分钟。
 * 这里只扫一个 Map，没到期就一个对象都不碰。
 *
 * @param ctx Cordis 上下文
 * @param store 守候存储
 * @param pendingHits watchId → { watch, hit, dueAt }
 * @param warn 日志函数
 * @param telemetry 账本（可缺省）
 * @returns {number} 本轮真正投递出去的条数
 */
function drainQuietHits(ctx, store, pendingHits, firing, warn, telemetry) {
  if (pendingHits.size === 0) return 0
  const at = Date.now()
  let fired = 0
  for (const [id, entry] of Array.from(pendingHits)) {
    if (entry.dueAt > at) continue
    pendingHits.delete(id)
    // 窗口期间可能被取消、过期，或目标已被判死：只有还 pending 的才投递。
    const current = store.all().find((watch) => watch.id === id)
    if (current === undefined || current.state !== 'pending') continue
    fired += 1
    claimFire(firing, current, ctx, store, entry.hit, warn, telemetry)
  }
  return fired
}

/**
 * 目标会话被 dispose（销毁）→ 挂着的守候落 `failed`，不静默悬挂（计划 §2.6「失效清理」）。
 *
 * 为什么不用巡检代替：`sessionController.list` 会一并列出**持久化里还在的冷会话**，
 * 所以 dispose 之后它仍然出现在 list 里，缺席判定根本发现不了。
 * 宿主的 `session/disposed` 事件才是唯一确定的信号（dsh-session 的 `emitDisposed`）。
 *
 * @param store 守候存储
 * @param pendingHits 静默窗口待投递表
 * @param warn 日志函数
 * @param telemetry 账本（可缺省）
 * @returns {(session: { id?: string }) => void} 监听器
 */
function makeDisposedListener(store, pendingHits, warn, telemetry) {
  return (session) => {
    try {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (sessionId === '') return
      for (const watch of store.pending()) {
        if (watch.target !== sessionId) continue
        pendingHits.delete(watch.id)
        store.update(watch.id, {
          state: 'failed',
          lastError: '目标会话已 dispose（会话被销毁），守候作废。',
        })
        try {
          telemetry?.settle(watch.id, 'failed', { note: 'target-disposed' })
        } catch {
          /* 账本失败不影响守候本身 */
        }
        warn(`守候作废：目标会话已 dispose ${watch.id} ← ${sessionId}`)
      }
    } catch (error) {
      warn(`处理 session/disposed 失败（已忽略）：${watchErrorText(error)}`)
    }
  }
}

/**
 * 定时兜底：question / stalled / idle 这三类只能靠「等」发现，事件流里没有它们。
 *
 * 只给仍有 pending 守候的会话组装巡检记录：没人等的会话，连一条记录都不占。
 */
async function runWatchTick(ctx, store, detector, warn, lastEventAt, openQuestions, telemetry, pendingHits, missingTicks, firing) {
  try {
    // 静默窗口的到期投递与账本收口都要跑，且**不能**排在「没有 pending 就 return」之后：
    // 守候已经 fired、只等应答判定的那些账，此时一条 pending 都没有。
    drainQuietHits(ctx, store, pendingHits, firing, warn, telemetry)
    try {
      telemetry?.expireDue(Date.now())
    } catch {
      /* 账本失败不影响守候本身 */
    }

    const pending = store.pending()
    if (pending.length === 0) return
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.list !== 'function') return

    const listed = await controller.list({}, signalOf())
    const items = Array.isArray(listed?.items) ? listed.items : []
    const byId = new Map(items.map((item) => [String(item.sessionId), item]))
    const at = Date.now()

    const inspections = []
    for (const watch of pending) {
      const item = byId.get(watch.target)
      if (item === undefined) {
        // 事件通道全失灵时的兜底失效判定。注意 list 会带上持久化里的冷会话，
        // 所以「不在 list 里」比 dispose 更彻底：连记录都没了。连丢 2 次才判死。
        const misses = (missingTicks.get(watch.id) ?? 0) + 1
        missingTicks.set(watch.id, misses)
        if (misses >= WATCH_MISS_LIMIT) {
          pendingHits.delete(watch.id)
          store.update(watch.id, {
            state: 'failed',
            lastError: `目标会话连续 ${WATCH_MISS_LIMIT} 次巡检不在会话列表里，守候作废。`,
          })
          try {
            telemetry?.settle(watch.id, 'failed', { note: 'target-missing' })
          } catch {
            /* 账本失败不影响守候本身 */
          }
          warn(`守候作废：目标会话连续缺席 ${watch.id} ← ${watch.target}`)
        }
        continue
      }
      missingTicks.delete(watch.id)
      const inspection = { sessionId: watch.target, running: item.running === true }
      const lastSeen = lastEventAt.get(watch.target) ?? (typeof item.updatedAt === 'number' ? item.updatedAt : undefined)
      if (lastSeen !== undefined) inspection.lastEventAt = lastSeen
      const open = openQuestions.get(watch.target)
      if (open !== undefined) inspection.openQuestionSince = open.since
      inspections.push(inspection)
    }

    const hits = detector.tick({ inspections, at })

    // idle 由本层自己判：detector 刻意不持有 watch，也就读不到 idleMs。
    // 基线是「最后一次见到它的事件」，没见过事件就用登记时刻——即「此后安静了 idleMs」。
    for (const watch of pending) {
      if (watch.condition !== 'idle') continue
      const baseline = lastEventAt.get(watch.target) ?? watchEpochOf(watch.createdAt)
      if (baseline === undefined) continue
      const threshold = Number.isFinite(Number(watch.idleMs)) ? Number(watch.idleMs) : WATCH_DEFAULT_IDLE_MS
      if (at - baseline > threshold) {
        hits.push({ kind: 'idle', sessionId: watch.target, seq: -1, text: '', reason: 'idle', at, eventAt: baseline })
      }
    }

    for (const hit of hits) {
      for (const watch of pending) {
        if (watch.target !== hit.sessionId || watch.condition !== hit.kind) continue
        claimFire(firing, watch, ctx, store, hit, warn, telemetry)
      }
    }
  } catch (error) {
    warn(`守候巡检失败（已跳过本轮）：${watchErrorText(error)}`)
  }
}

/**
 * 工具 1：登记守候。parameters 与契约 §4 一字不差。
 *
 * 闸门在**登记**时先跑一次：自守候、目标不存在、队列满当场拒绝；静默段与 wake 预算
 * 则降级成轻一点的动作并回填 `degraded`——让调用方知道它登记的其实不是 wake。
 */
function createWatchTool(ctx, store) {
  return {
    name: 'session_watch',
    description:
      '登记一条跨会话守候：目标会话发生指定事件时，往本会话投一条通知（wake/notify）或只留痕（record）。登记即返回 watchId，不阻塞等待。',
    parameters: {
      type: 'object',
      properties: {
        targetSessionId: { type: 'string', description: '被守候的会话 id。' },
        condition: {
          type: 'string',
          enum: WATCH_CONDITIONS,
          description:
            '守候哪类事件。派活等结果用 settled（completed 与 failed 都通知）；只关心正常结束才用 completed。',
        },
        action: {
          type: 'string',
          enum: WATCH_ACTIONS,
          description: '命中后做什么：wake 拉起新一轮（贵），notify 投一条消息，record 只记录。默认 wake。',
        },
        idleMs: { type: 'integer', description: 'idle 条件的静默阈值，默认 300000。' },
        expiresInHours: { type: 'integer', description: '有效期小时数，默认 168。' },
      },
      required: ['targetSessionId', 'condition'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          watchId: { type: 'string' },
          target: { type: 'string' },
          condition: { type: 'string' },
          action: { type: 'string' },
          expiresAt: { type: 'string' },
          degraded: { type: 'string' },
        },
        required: ['watchId', 'target', 'condition', 'action', 'expiresAt'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const lines = [`已登记守候 ${value.watchId}：${value.target} 的 ${value.condition} 条件 → ${value.action}`]
        lines.push(`有效期至 ${value.expiresAt}`)
        if (value.degraded) lines.push(`⚠️ 动作已被闸门降级（${value.degraded}），实际按降级后的动作执行`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs, exec) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const target = nonEmptyString(args.targetSessionId)
      if (!target) throw new Error('targetSessionId 不能为空，请先用 session_list 确认要守候的会话。')
      const condition = nonEmptyString(args.condition)
      if (!condition || !WATCH_CONDITIONS.includes(condition)) {
        throw new Error(`condition 只能是 ${WATCH_CONDITIONS.join(' / ')}，收到：${String(args.condition)}`)
      }
      const requested = nonEmptyString(args.action) ?? 'wake'
      if (!WATCH_ACTIONS.includes(requested)) {
        throw new Error(`action 只能是 ${WATCH_ACTIONS.join(' / ')}，收到：${requested}`)
      }
      // 守候方＝调用本工具的会话。拿不到就没法投递回谁，宁可当场报错。
      const watcher = nonEmptyString(exec?.agent?.session?.id) ?? nonEmptyString(exec?.agent?.id)
      if (!watcher) throw new Error('无法确定调用方会话：session_watch 必须在会话内调用。')

      const rawIdle = Number(args.idleMs)
      const idleMs = Number.isFinite(rawIdle) && rawIdle > 0 ? Math.trunc(rawIdle) : WATCH_DEFAULT_IDLE_MS
      const rawExpires = Number(args.expiresInHours)
      const expiresInHours =
        Number.isFinite(rawExpires) && rawExpires > 0 ? Math.trunc(rawExpires) : WATCH_DEFAULT_EXPIRES_HOURS

      const now = Date.now()
      const gate = evaluateGate({
        requested,
        now,
        firedToday: firedTodayCount(store, now),
        pendingCount: store.pending().length,
        watcherIsTarget: watcher === target,
        targetAlive: await targetAliveOf(ctx, target),
      })
      if (!gate.allowed) throw new Error(`守候未登记：${gateExplain(gate.reason)}`)

      const watch = store.add({ target, watcher, condition, action: gate.effective, idleMs, expiresInHours })

      const out = {
        watchId: watch.id,
        target: watch.target,
        condition: watch.condition,
        action: watch.action,
        expiresAt: watch.expiresAt,
      }
      if (gate.effective !== requested) out.degraded = gate.reason
      return out
    },
  }
}

/**
 * 工具 2：查看 / 取消 / 看统计。返回结构按契约 §4：`{ count, watches: [...] }`。
 * cancel 失败时抛错而不是回一个 0——模型需要知道「没取消掉」和「没有这条」是两件事。
 *
 * `stats` 动作是 M4 的观测出口：命中率/误报率不落在这个工具里就没人看得到，
 * 也就没法回答「这套守候值不值得留」。
 */
function createWatchesTool(store, telemetry) {
  return {
    name: 'session_watches',
    description:
      '列出、取消或统计守候登记。默认 list 只列仍在生效的；includeSettled=true 带上已结束的（含命中结局）；action=stats 看命中率与误报率。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'cancel', 'stats'], description: '默认 list。' },
        watchId: { type: 'string', description: 'cancel 时必填。' },
        includeSettled: { type: 'boolean', description: 'list 时是否带已结束的，默认 false。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          watches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                watchId: { type: 'string' },
                target: { type: 'string' },
                condition: { type: 'string' },
                action: { type: 'string' },
                state: { type: 'string' },
                outcome: { type: 'string' },
                remainingMs: { type: 'number' },
              },
              required: ['watchId', 'target', 'condition', 'action', 'state'],
              additionalProperties: false,
            },
          },
          stats: {
            type: 'object',
            properties: {
              total: { type: 'number' },
              pending: { type: 'number' },
              confirmed: { type: 'number' },
              acknowledged: { type: 'number' },
              unanswered: { type: 'number' },
              premature: { type: 'number' },
              recorded: { type: 'number' },
              failed: { type: 'number' },
              degraded: { type: 'number' },
              avgLatencyMs: { type: 'number' },
              days: { type: 'string' },
            },
            required: ['total', 'confirmed', 'unanswered', 'premature'],
            additionalProperties: false,
          },
        },
        required: ['count', 'watches'],
        additionalProperties: false,
      },
      render: (args, value) => {
        if (value.stats !== undefined) {
          const s = value.stats
          const lines = [
            `守候统计：触发 ${s.total} 次｜叫起 ${s.acknowledged}｜确认 ${s.confirmed}｜空炮 ${s.unanswered}｜误报 ${s.premature}｜只记录 ${s.recorded}｜失败 ${s.failed}｜降级 ${s.degraded}｜平均延迟 ${Math.round((s.avgLatencyMs ?? 0) / 1000)} 秒`,
          ]
          if (typeof s.days === 'string' && s.days !== '') lines.push(`按天：${s.days}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (value.count === 0) return [{ type: 'text', text: '（没有匹配的守候）' }]
        const rows = value.watches.map((row) => {
          const left = row.remainingMs === undefined ? '' : `　剩余 ${Math.round(row.remainingMs / 60000)} 分钟`
          const outcome = row.outcome === undefined ? '' : `, ${row.outcome}`
          return `- ${row.watchId}  ${row.target}  [${row.condition} → ${row.action}, ${row.state}${outcome}]${left}`
        })
        return [{ type: 'text', text: `${value.count} 条守候：\n${rows.join('\n')}` }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const action = nonEmptyString(args.action) ?? 'list'
      const now = Date.now()

      if (action === 'stats') {
        const summary = telemetry?.stats(now) ?? { total: 0, confirmed: 0, unanswered: 0, premature: 0 }
        const days = Array.isArray(summary.days)
          ? summary.days.map((day) => `${day.date.slice(5)} 触发${day.fired}/确认${day.confirmed}/空炮${day.unanswered}/误报${day.premature}`).join('｜')
          : ''
        return {
          count: summary.total,
          watches: [],
          stats: {
            total: summary.total,
            pending: summary.pending,
            confirmed: summary.confirmed,
            acknowledged: summary.acknowledged,
            unanswered: summary.unanswered,
            premature: summary.premature,
            recorded: summary.recorded,
            failed: summary.failed,
            degraded: summary.degraded,
            avgLatencyMs: summary.avgLatencyMs,
            days,
          },
        }
      }

      if (action === 'cancel') {
        const watchId = nonEmptyString(args.watchId)
        if (!watchId) throw new Error('cancel 需要 watchId。')
        if (!store.cancel(watchId)) {
          const existing = store.all().find((watch) => watch.id === watchId)
          throw new Error(
            existing === undefined
              ? `没有 id 为 ${watchId} 的守候。`
              : `守候 ${watchId} 已是 ${existing.state}，只有 pending 能被取消。`,
          )
        }
        const canceled = store.all().find((watch) => watch.id === watchId)
        return {
          count: canceled === undefined ? 0 : 1,
          watches: canceled === undefined ? [] : [watchRowOf(canceled, now, telemetry?.outcomeOf(canceled.id))],
        }
      }

      if (action !== 'list') throw new Error(`action 只能是 list / cancel / stats，收到：${action}`)
      const list = args.includeSettled === true ? store.all() : store.pending()
      return {
        count: list.length,
        watches: list.map((watch) => watchRowOf(watch, now, telemetry?.outcomeOf(watch.id))),
      }
    },
  }
}

/**
 * 把接线期异常落盘一份。
 *
 * 为什么需要：宿主的 `ctx.logger.warn` 在桌面端不落文件，插件起不来时既看不到
 * 工具、也看不到原因（2026-11-12 实测：两个新工具在真实环境注册失败，日志里
 * 一片空白，只能靠落盘把错误逼出来）。诊断用，代价是一个几 KB 的临时文件。
 */
function recordBootFailure(error) {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : String(error)
  const line = `${new Date().toISOString()} ${detail}\n\n`
  try {
    appendFileSync(join(tmpdir(), 'session-control-boot.log'), line, 'utf8')
  } catch {
    /* 诊断落盘失败不影响加载 */
  }
  return detail
}

/**
 * 无条件打一行启动轨迹。
 *
 * 用于回答「apply 到底走到哪一步」——工具的注册可能不抛错却依然不可见，
 * 这时只有轨迹能区分「没执行」和「执行了但不生效」。
 */
function recordBootTrace(message) {
  try {
    appendFileSync(join(tmpdir(), 'session-control-boot.log'), `${new Date().toISOString()} TRACE ${message}\n`, 'utf8')
  } catch {
    /* 诊断落盘失败不影响加载 */
  }
}

/**
 * 装好守候的三件套：两个工具、一个事件监听、一个 5 分钟巡检。
 *
 * 整个安装过程自兜异常：守候是新功能，绝不能因为它起不来而连带影响既有的 8 个工具
 * ——那会把一次失败的接线放大成「会话控制整块消失」。
 */
function installWatchWiring(ctx, warn, effect) {
  const root = watchesRootOf(ctx)
  let store
  try {
    store = createWatchStore({ root })
  } catch (error) {
    recordBootFailure(error)
    recordBootTrace(`store failed: ${watchErrorText(error)}`)
    warn(`守候存储不可用，跨会话触发未启用：${watchErrorText(error)}`)
    return
  }

  try {
    const loaded = store.load()
    if (loaded.corrupt === true) warn('守候文件损坏，已备份为 watches.corrupt-*.json 并从空开始。')
    const pruned = store.prune()
    if (pruned > 0) warn(`守候记录清理 ${pruned} 条（结束超过 7 天的终态）。`)
  } catch (error) {
    // load / prune 本身都保证不抛，这里只是最后一道保险。
    warn(`守候记录载入失败，按空开始：${watchErrorText(error)}`)
  }

  // 账本单独兜一层：统计坏了只丢观测，绝不能连带守候本身。
  let telemetry
  try {
    telemetry = createTelemetry({ root })
    const loadedTelemetry = telemetry.load()
    if (loadedTelemetry.corrupt === true) warn('守候账本损坏，已从空开始（只影响统计）。')
  } catch (error) {
    telemetry = undefined
    warn(`守候账本不可用，观测功能关闭：${watchErrorText(error)}`)
  }

  const detector = createDetector()
  const scopeSeen = new Set()
  const lastEventAt = new Map()
  const openQuestions = new Map()
  /** 静默窗口内待投递的命中：watchId → { watch, hit, dueAt }。 */
  const pendingHits = new Map()
  /** 目标从 list 里连续缺席的次数：watchId → count。 */
  const missingTicks = new Map()
  /** 正在投递中的守候：同一时刻只允许一条投递，防并发事件重复触发（见 claimFire）。 */
  const firing = new Set()

  // 两个工具：schema 与 render 缺一不可，缺了会让整批注册失败。
  // 逐个兜异常：一个注册失败不该连带另一个（2026-11-12 实测就是前一个失败后
  // 后一个一起消失，看起来像「插件根本没加载」）。
  for (const tool of [createWatchTool(ctx, store), createWatchesTool(store, telemetry)]) {
    try {
      effect(() => ctx.tools.register(tool), `${name}.tool.${tool.name}()`)
    } catch (error) {
      const detail = recordBootFailure(error)
      warn(`工具 ${tool.name} 注册失败：${watchErrorText(error)}`)
      if (detail !== '') warn(`失败详情已落盘：${join(tmpdir(), 'session-control-boot.log')}`)
    }
  }

  const listener = makeWatchListener(
    ctx,
    store,
    detector,
    warn,
    lastEventAt,
    openQuestions,
    scopeSeen,
    telemetry,
    pendingHits,
    firing,
  )
  const disposedListener = makeDisposedListener(store, pendingHits, warn, telemetry)
  const hookup = () => {
    const disposers = []
    try {
      const disposer = ctx.on('session/event', listener)
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      warn(`注册 session/event 监听失败，跨会话触发只保留登记工具：${watchErrorText(error)}`)
    }
    // dispose 是独立的宿主事件（不是 session/event 流里的一类）：挂不上只丢失效清理，
    // 事件与巡检两条路径不受影响，所以单独兜异常而不是整段跳过。
    try {
      const disposer = ctx.on('session/disposed', disposedListener)
      if (typeof disposer === 'function') disposers.push(disposer)
    } catch (error) {
      warn(`注册 session/disposed 监听失败，目标会话销毁后守候不会自动作废：${watchErrorText(error)}`)
    }
    return () => {
      for (const disposer of disposers) {
        try {
          disposer()
        } catch {
          /* 卸载期异常不该外抛 */
        }
      }
    }
  }
  if (typeof ctx.on !== 'function') {
    warn('ctx.on 不可用：跨会话守候只能登记，不会自动触发。')
  } else if (typeof ctx.effect === 'function') {
    ctx.effect(hookup, `${name}.watch.listen()`)
  } else {
    hookup()
  }

  // 没有 timer 服务就静默跳过：巡检是兜底，缺了它事件路径照常工作，不算错误。
  // 与 `ctx.home` 同一个坑：`ctx.timer` 是服务属性，未 inject 时访问即抛
  // （`cannot get property "timer" without inject`）。改用 ctx.get 安全读取。
  let timer
  try {
    timer = typeof ctx?.get === 'function' ? ctx.get('timer') : undefined
  } catch {
    timer = undefined
  }
  const timerReady = Boolean(timer && typeof timer.interval === 'function')
  // 一行启动摘要：够定位「装到哪、根在哪、巡检开没开」，又不至于把日志刷成噪音。
  recordBootTrace(
    `wired root=${root} tools=session_watch,session_watches tick=${timerReady ? '5m' : 'off'} telemetry=${telemetry === undefined ? 'off' : 'on'}`,
  )
  if (!timerReady) return
  let ticking = false
  const tick = () => {
    if (ticking) return
    ticking = true
    Promise.resolve(
      runWatchTick(ctx, store, detector, warn, lastEventAt, openQuestions, telemetry, pendingHits, missingTicks, firing),
    )
      .catch((error) => warn(`守候巡检异常：${watchErrorText(error)}`))
      .finally(() => {
        ticking = false
      })
  }
  try {
    timer.interval(tick, WATCH_TICK_MS)
  } catch (error) {
    warn(`守候巡检定时器未装上，跨会话触发只靠事件：${watchErrorText(error)}`)
  }
  // 静默窗口的收账另起一个 15 秒的小周期：巡检是 5 分钟一次，
  // 用它投递「60 秒静默后唤醒」会把验收要求的 90 秒拖成 6 分钟。
  try {
    timer.interval(() => {
      try {
        drainQuietHits(ctx, store, pendingHits, firing, warn, telemetry)
      } catch (error) {
        warn(`静默窗口收账失败（已跳过本轮）：${watchErrorText(error)}`)
      }
    }, WATCH_QUIET_DRAIN_MS)
  } catch (error) {
    warn(`静默窗口收账定时器未装上，完成判定会退到 5 分钟巡检节奏：${watchErrorText(error)}`)
  }
}

/* ─────────────────────────────── entry ─────────────────────────────── */

/**
 * Register the Session Control tools (the original eight) plus the cross-session
 * watch pair, its `session/event` listener, and the 5-minute fallback tick.
 * @param ctx Cordis plugin context.
 */
export function apply(ctx) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {
      /* logging must never break activation */
    }
  }

  const effect = (factory, label) => {
    if (typeof ctx.effect === 'function') return ctx.effect(factory, label)
    return factory()
  }

  if (!ctx.get('sessionController')) {
    warn('sessionController 未组合：工具已注册，但调用会返回不可用错误。')
  }

  for (const tool of [
    createSessionTool(ctx),
    createInjectTool(ctx),
    createListTool(ctx),
    createCancelTool(ctx),
    createWaitTool(ctx),
    createSegmentsTool(ctx),
    createStatusTool(ctx),
    createMigrateTool(ctx),
  ]) {
    effect(() => ctx.tools.register(tool), `${name}.tool.${tool.name}()`)
  }

  // 跨会话守候（契约 §4）：独立安装，起不来只告警，不牵连上面 8 个工具。
  try {
    installWatchWiring(ctx, warn, effect)
  } catch (error) {
    recordBootFailure(error)
    warn(`跨会话触发接线失败（已跳过）：${error instanceof Error ? error.message : String(error)}`)
  }
}
