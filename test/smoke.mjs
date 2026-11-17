/**
 * Smoke test for the Session Control plugin, runnable without installing it.
 *
 * It imports the real plugin module and drives `apply()` with a fake Cordis
 * context and a stubbed `sessionController`, so registration shape and every
 * execute() path are exercised before anything touches the live profile.
 *
 * Run: node test/smoke.mjs
 */

import { apply, inject, name } from '../index.js'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function callRecord() {
  return { create: [], prompt: [], list: [], rename: [], cancel: [], inspect: [], commands: [] }
}

function makeCtx(calls, overrides = {}, extras = {}) {
  const registered = []
  const controller = {
    async inspect() {
      calls.inspect.push(true)
      return { events: [], meta: {} }
    },
    async resolveAgent(sessionId) {
      if (sessionId === 's-unknown') return { error: { code: 'session/not-found' } }
      return { agent: { id: sessionId } }
    },
    async create(request) {
      calls.create.push(request)
      return { sessionId: 'session-test-1', agentPreset: request.agentPreset }
    },
    async prompt(request) {
      calls.prompt.push(request)
      return { accepted: true }
    },
    async list() {
      calls.list.push(true)
      return {
        items: [
          { sessionId: 's-a', updatedAt: 1700000000000, running: true, blank: false, cwd: 'E:\\a' },
          { sessionId: 's-b', updatedAt: 1700000001000, running: false, blank: true, origin: 'subagent' },
        ],
      }
    },
    async rename(request) {
      calls.rename.push(request)
      return { title: request.title, seq: 1 }
    },
    async cancel(request) {
      calls.cancel.push(request)
      return { accepted: true }
    },
    ...overrides,
  }

  const ctx = {
    get: (key) => {
      if (key === 'sessionController') return controller
      if (key === 'agents') return extras.agents
      if (key === 'commands') return extras.commands
      return undefined
    },
    effect: (factory) => factory(),
    logger: { warn: () => {} },
    tools: {
      register: (tool) => {
        registered.push(tool)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

const calls = callRecord()
const { ctx, registered } = makeCtx(calls)

console.log('— module shape —')
check('exports name', name === 'session-control')
check('inject waits for tools', Array.isArray(inject) && inject.includes('tools'))
check('apply is a function', typeof apply === 'function')

console.log('— registration —')
apply(ctx)
check('registers ten tools', registered.length === 10, `got ${registered.length}`)

const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]))
check('session_create registered', Boolean(byName.session_create))
check('session_inject registered', Boolean(byName.session_inject))
check('session_list registered', Boolean(byName.session_list))
check('session_cancel registered', Boolean(byName.session_cancel))
check('session_wait registered', Boolean(byName.session_wait))
check('session_segments registered', Boolean(byName.session_segments))
check('session_status registered', Boolean(byName.session_status))
check('session_migrate registered', Boolean(byName.session_migrate))
check('session_watch registered', Boolean(byName.session_watch))
check('session_watches registered', Boolean(byName.session_watches))

for (const tool of registered) {
  check(`${tool.name}: has description`, typeof tool.description === 'string' && tool.description.length > 10)
  check(
    `${tool.name}: parameters is an object schema`,
    tool.parameters?.type === 'object' && typeof tool.parameters.properties === 'object',
  )
  check(`${tool.name}: execute is a function`, typeof tool.execute === 'function')
  check(`${tool.name}: output render present`, typeof tool.output?.render === 'function')
}

console.log('— session_create —')
{
  const result = await byName.session_create.execute({ cwd: '  E:\\proj  ', agentPreset: 'preset-x', title: 'T1' })
  const request = calls.create.at(-1)
  check('returns sessionId', result.sessionId === 'session-test-1')
  check('new session carries a -1 anchor', result.sinceSeq === -1)
  check('trims cwd', request.cwd === 'E:\\proj')
  check('passes agentPreset', request.agentPreset === 'preset-x')
  check('echoes agentPreset', result.agentPreset === 'preset-x')
  check('applies title via rename', calls.rename.at(-1)?.title === 'T1')
  check('reports title', result.title === 'T1')
}

console.log('— session_create: empty args —')
{
  const before = calls.create.length
  const result = await byName.session_create.execute({})
  check('sends an empty request', JSON.stringify(calls.create.at(-1)) === '{}')
  check('still returns a sessionId', result.sessionId === 'session-test-1')
  check('one create call recorded', calls.create.length === before + 1)
}

console.log('— session_create: title failure is non-fatal —')
{
  const failing = callRecord()
  const { ctx: badCtx } = makeCtx(failing, {
    async rename() {
      throw new Error('rename boom')
    },
  })
  const tools = []
  badCtx.tools.register = (tool) => {
    tools.push(tool)
    return () => {}
  }
  apply(badCtx)
  const createTool = tools.find((tool) => tool.name === 'session_create')
  const result = await createTool.execute({ title: 'nope' })
  check('session still created', result.sessionId === 'session-test-1')
  check('warning surfaced', typeof result.warning === 'string' && result.warning.includes('rename boom'))
}

console.log('— session_inject —')
{
  const result = await byName.session_inject.execute({ sessionId: 's-target', message: '你好' })
  const request = calls.prompt.at(-1)
  check('accepted', result.accepted === true)
  check('defaults to queue', request.mode === 'queue')
  check('routes to the session', request.sessionId === 's-target')
  check('sends one text block', request.content?.[0]?.type === 'text' && request.content[0].text === '你好')
  check('mints a requestId', typeof request.requestId === 'string' && request.requestId.startsWith('session-control-'))
  check('echoes mode', result.mode === 'queue')
}

console.log('— session_inject: steer —')
{
  const result = await byName.session_inject.execute({ sessionId: 's-target', message: '改方向', mode: 'steer' })
  check('mode honours steer', calls.prompt.at(-1).mode === 'steer')
  check('result mode steer', result.mode === 'steer')
}

console.log('— session_inject: rejects bad input —')
{
  const before = calls.prompt.length
  let emptyMessage = false
  try {
    await byName.session_inject.execute({ sessionId: 's', message: '   ' })
  } catch {
    emptyMessage = true
  }
  check('rejects blank message', emptyMessage)

  let missingSession = false
  try {
    await byName.session_inject.execute({ message: 'x' })
  } catch {
    missingSession = true
  }
  check('rejects missing sessionId', missingSession)
  check('no prompt sent on rejection', calls.prompt.length === before)
}

console.log('— requestId uniqueness —')
{
  const ids = []
  for (let i = 0; i < 5; i += 1) {
    await byName.session_inject.execute({ sessionId: 's', message: `m${i}` })
    ids.push(calls.prompt.at(-1).requestId)
  }
  check('all requestIds distinct', new Set(ids).size === ids.length)
}

console.log('— session_inject: asCommand —')
{
  const cmdCalls = callRecord()
  const commands = {
    async execute(agent, line, attachments, signal) {
      cmdCalls.commands.push({ agent, line, attachments, hasSignal: signal !== undefined })
      if (line.startsWith('/unknown')) return undefined
      if (line === '/fail') return { commandId: 'cmd-2', result: { kind: 'error', text: '命令挂了' } }
      return { commandId: 'cmd-1', result: { kind: 'success', text: '已压缩上下文' } }
    },
  }
  const made = makeCtx(cmdCalls, {}, { commands })
  const tools = []
  made.ctx.tools.register = (tool) => {
    tools.push(tool)
    return () => {}
  }
  apply(made.ctx)
  const injectTool = tools.find((t) => t.name === 'session_inject')

  const ok = await injectTool.execute({ sessionId: 's-target', message: '/compact', asCommand: true })
  check('runs the command through the host service', cmdCalls.commands.length === 1 && cmdCalls.commands[0].line === '/compact')
  check('reports success', ok.kind === 'command' && ok.accepted === true && ok.commandText === '已压缩上下文')
  check('sends no prompt for a command', cmdCalls.prompt.length === 0)
  check('resolves the target agent', cmdCalls.commands[0].agent.id === 's-target')
  check('passes a signal', cmdCalls.commands[0].hasSignal === true)

  const unknown = await injectTool.execute({ sessionId: 's-target', message: '/unknown', asCommand: true })
  check('reports an unresolved command', unknown.accepted === false && unknown.commandError === true)

  const failed = await injectTool.execute({ sessionId: 's-target', message: '/fail', asCommand: true })
  check(
    'reports a command error',
    failed.accepted === false && failed.commandText === '命令挂了' && failed.commandError === true,
  )

  let noAgent = ''
  try {
    await injectTool.execute({ sessionId: 's-unknown', message: '/compact', asCommand: true })
  } catch (error) {
    noAgent = String(error.message)
  }
  check('refuses a session with no live agent', noAgent.includes('活会话'), noAgent)

  const plain = await injectTool.execute({ sessionId: 's-target', message: '/compact' })
  check('default stays a plain prompt', plain.kind === 'prompt' && cmdCalls.commands.length === 3)
  check('default sends the prompt', cmdCalls.prompt.length === 1 && cmdCalls.prompt[0].content[0].text === '/compact')

  const bare = makeCtx(callRecord(), {}, {})
  const bareTools = []
  bare.ctx.tools.register = (tool) => {
    bareTools.push(tool)
    return () => {}
  }
  apply(bare.ctx)
  let missing = ''
  try {
    await bareTools.find((t) => t.name === 'session_inject').execute({ sessionId: 's', message: '/x', asCommand: true })
  } catch (error) {
    missing = String(error.message)
  }
  check('fails clearly without the commands service', missing.includes('commands'), missing)
}

console.log('— 等待锚点（sinceSeq）—')
{
  const events = [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一句' }] } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 1200,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '旧回复' }] } },
    },
  ]
  const agent = { id: 's-anchor', status: 'idle', session: { events, header: { cwd: 'E:\\p' } }, inbox: {} }
  const rec = callRecord()
  const made = makeCtx(rec, {}, { agents: { get: (id) => (id === 's-anchor' ? agent : undefined) } })
  const tools = []
  made.ctx.tools.register = (tool) => {
    tools.push(tool)
    return () => {}
  }
  apply(made.ctx)
  const injectTool = tools.find((t) => t.name === 'session_inject')
  const waitTool = tools.find((t) => t.name === 'session_wait')

  const res = await injectTool.execute({ sessionId: 's-anchor', message: '新任务' })
  check('inject returns the pre-send anchor', res.sinceSeq === 3)
  check('anchor is a number the caller can pass on', typeof res.sinceSeq === 'number')

  // 模拟对方在这条之后回话
  events.push({
    type: 'assistant/message',
    seq: 4,
    time: 1300,
    data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '新回复' }] } },
  })
  const waited = await waitTool.execute({ sessionId: 's-anchor', sinceSeq: res.sinceSeq, timeoutMs: 1000 })
  check('waiting on the anchor returns the new reply', waited.replyText === '新回复' && waited.replySeq === 4)
  check('the anchored wait is neither stale nor timed out', waited.stale === false && waited.timedOut === false)
}

console.log('— session_list —')
{
  const result = await byName.session_list.execute({ limit: 1 })
  check('honours limit', result.count === 1 && result.sessions.length === 1)
  check('maps updatedAt to ISO', /^\d{4}-\d{2}-\d{2}T/.test(result.sessions[0].updatedAt))
  check('keeps cwd', result.sessions[0].cwd === 'E:\\a')

  const all = await byName.session_list.execute({})
  check('defaults to every row', all.count === 2)
  check('keeps origin', all.sessions.some((row) => row.origin === 'subagent'))
}

console.log('— session_segments / session_status / session_wait —')
{
  const events = [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 1200,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的' }], toolCalls: [{ name: 'read' }] } },
    },
    { type: 'turn/end', seq: 4, time: 1300, data: { turn: 1 } },
    { type: 'turn/start', seq: 5, time: 1400, data: { turn: 2 } },
    {
      type: 'assistant/message',
      seq: 6,
      time: 1500,
      data: {
        turn: 2,
        step: 1,
        message: { content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '处理中' }] },
      },
    },
  ]
  const fakeAgent = {
    id: 's-live',
    status: 'running',
    session: { events, header: { cwd: 'E:\\proj' } },
    inbox: { nextTurn: [], nextStep: [] },
  }

  const build = (agent) => {
    const calls = callRecord()
    const made = makeCtx(calls, {}, { agents: { get: (id) => (id === 's-live' ? agent : undefined) } })
    const tools = []
    made.ctx.tools.register = (tool) => {
      tools.push(tool)
      return () => {}
    }
    apply(made.ctx)
    return { tools, calls }
  }
  const live = build(fakeAgent)
  const tool = (n) => live.tools.find((t) => t.name === n)

  console.log('— session_segments —')
  const seg1 = await tool('session_segments').execute({ sessionId: 's-live', sinceSeq: 0, limit: 1 })
  check('pages one segment at a time', seg1.returned === 1 && seg1.segments[0].seq === 3)
  check('cursor advances', seg1.nextCursorSeq === 3)
  check('hides reasoning by default', seg1.segments[0].reasoning === undefined)
  check('keeps tool names', seg1.segments[0].toolCalls?.[0] === 'read')
  check('live flag', seg1.live === true)
  const seg2 = await tool('session_segments').execute({ sessionId: 's-live', sinceSeq: 3, includeReasoning: true })
  check('reads the open turn', seg2.segments[0].seq === 6 && seg2.segments[0].openTurn === true)
  check('reasoning on demand', seg2.segments[0].reasoning === '想一想')

  console.log('— session_status —')
  const status = await tool('session_status').execute({ sessionId: 's-live', reasoning: 'none' })
  check('running from the live agent', status.running === 'running')
  check('open turn detected', status.openTurn === true && status.lastTurn === 2)
  check('latest reply', status.lastAssistantText === '处理中')
  check('reasoning suppressed', status.lastReasoning === undefined && status.reasoningTail === undefined)
  check('title falls back to first user message', status.title === '你好')
  check('pending work reported', status.pendingWork === false)
  check('cwd reported', status.cwd === 'E:\\proj')
  const stalled = await tool('session_status').execute({ sessionId: 's-live', stalledMsThreshold: 0 })
  check('flags a silent running session as stalled', stalled.stalled === true)

  console.log('— session_wait —')
  const waitNew = await tool('session_wait').execute({ sessionId: 's-live', sinceSeq: 3, timeoutMs: 1000 })
  check('returns readable new reply', waitNew.replyText === '处理中' && waitNew.timedOut === false)
  check('not stale', waitNew.stale === false)
  check('echoes baseline', waitNew.sinceSeq === 3)
  const waitStale = await tool('session_wait').execute({ sessionId: 's-live', timeoutMs: 1000 })
  check('times out', waitStale.timedOut === true)
  check('falls back to the pre-existing reply', waitStale.stale === true && waitStale.replyText === '处理中')
  let blankRejected = false
  try {
    await tool('session_wait').execute({})
  } catch {
    blankRejected = true
  }
  check('rejects a missing sessionId', blankRejected)

  console.log('— idle session —')
  const idle = build({ ...fakeAgent, status: 'idle' })
  const idleStatus = await idle.tools
    .find((t) => t.name === 'session_status')
    .execute({ sessionId: 's-live', stalledMsThreshold: 0 })
  check('idle is never stalled', idleStatus.stalled === false)
}

console.log('— cold session via inspect() —')
{
  const coldCalls = callRecord()
  const coldCtx = makeCtx(
    coldCalls,
    {
      async inspect(id) {
        coldCalls.inspect.push(id)
        return {
          events: [
            { type: 'turn/start', seq: 1, time: 5000, data: { turn: 1 } },
            {
              type: 'assistant/message',
              seq: 2,
              time: 5100,
              data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '冷会话的旧回复' }] } },
            },
            { type: 'turn/end', seq: 3, time: 5200, data: { turn: 1 } },
          ],
          meta: {},
        }
      },
    },
    { agents: { get: () => undefined } },
  )
  const coldTools = []
  coldCtx.ctx.tools.register = (tool) => {
    coldTools.push(tool)
    return () => {}
  }
  apply(coldCtx.ctx)
  const coldTool = (n) => coldTools.find((t) => t.name === n)

  const coldSeg = await coldTool('session_segments').execute({ sessionId: 's-cold' })
  check('segments: reads an offline session', coldSeg.live === false && coldSeg.segments[0].text === '冷会话的旧回复')
  check('segments: went through inspect()', coldCalls.inspect.includes('s-cold'))
  const coldStatus = await coldTool('session_status').execute({ sessionId: 's-cold' })
  check('status: works for an offline session', coldStatus.live === false && coldStatus.openTurn === false)
  check('status: pending work unknown without a live agent', coldStatus.pendingWork === undefined)
  check('status: agentAvailable false when offline', coldStatus.agentAvailable === false)

  const coldWait = await coldTool('session_wait').execute({ sessionId: 's-cold', timeoutMs: 60000 })
  check(
    'wait: does not burn the budget when no live agent exists',
    coldWait.timedOut === true && coldWait.waitedMs < 5000,
    `waitedMs=${coldWait.waitedMs}`,
  )
  check('wait: still reports the pre-existing reply', coldWait.stale === true && coldWait.replyText === '冷会话的旧回复')
}

console.log('— cold session via events()（DSH 0.2.2-rc.2 起）—')
{
  const rc2Calls = callRecord()
  const requests = []
  const signals = []
  // rc.2 的 events() 从日志尾部往回翻页：第一次不带 beforeSeq，之后用首条 seq 作 beforeSeq。
  const rc2Log = [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 1100,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '旧回复' }] } },
    },
    { type: 'turn/end', seq: 3, time: 1200, data: { turn: 1 } },
    { type: 'turn/start', seq: 4, time: 4000, data: { turn: 2 } },
    {
      type: 'assistant/message',
      seq: 5,
      time: 4100,
      data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '新回复' }] } },
    },
    { type: 'turn/end', seq: 6, time: 4200, data: { turn: 2 } },
  ]
  const rc2Page = (beforeSeq) => {
    const end = beforeSeq === undefined ? rc2Log.length : rc2Log.findIndex((e) => e.seq === beforeSeq)
    const start = Math.max(0, end - 3)
    return {
      cursor: rc2Log[end - 1].seq,
      records: rc2Log.slice(start, end).map((event) => ({ type: 'event', event })),
      hasMore: start > 0,
    }
  }
  const rc2Ctx = makeCtx(
    rc2Calls,
    {
      inspect: undefined,
      async events(request, signal) {
        requests.push(request)
        signals.push(signal)
        return rc2Page(request.beforeSeq)
      },
    },
    { agents: { get: () => undefined } },
  )
  const rc2Tools = []
  rc2Ctx.ctx.tools.register = (tool) => {
    rc2Tools.push(tool)
    return () => {}
  }
  apply(rc2Ctx.ctx)
  const rc2Tool = (n) => rc2Tools.find((t) => t.name === n)

  const rc2Seg = await rc2Tool('session_segments').execute({ sessionId: 's-cold-rc2' })
  check('segments(rc2): 两次翻页读完整日志', requests.length === 2, `requests=${requests.length}`)
  check(
    'segments(rc2): 请求用 session 地址',
    requests[0]?.address?.kind === 'session' && requests[0]?.address?.sessionId === 's-cold-rc2',
  )
  check('segments(rc2): 第二页用首条 seq 作 beforeSeq', requests[1]?.beforeSeq === 4, `beforeSeq=${requests[1]?.beforeSeq}`)
  check(
    'segments(rc2): 每次调用都带可用的 signal（rc.2 必需）',
    signals.length === 2 && signals.every((s) => typeof s?.throwIfAborted === 'function'),
    `signals=${signals.map((s) => typeof s).join(',')}`,
  )
  check(
    'segments(rc2): 跨页拼出两段回复',
    rc2Seg.live === false &&
      rc2Seg.segments.length === 2 &&
      rc2Seg.segments[0].text === '旧回复' &&
      rc2Seg.segments[1].text === '新回复',
    JSON.stringify(rc2Seg.segments.map((s) => s.text)),
  )
  check('segments(rc2): 游标落在最后一段', rc2Seg.nextCursorSeq === 5)

  const rc2Status = await rc2Tool('session_status').execute({ sessionId: 's-cold-rc2' })
  check('status(rc2): 离线会话可读且轮次已闭合', rc2Status.live === false && rc2Status.openTurn === false && rc2Status.lastTurn === 2)
}

console.log('— 冷读入口双双缺失时给出明确报错 —')
{
  const deadCtx = makeCtx(callRecord(), { inspect: undefined }, { agents: { get: () => undefined } })
  const deadTools = []
  deadCtx.ctx.tools.register = (tool) => {
    deadTools.push(tool)
    return () => {}
  }
  apply(deadCtx.ctx)
  let message = ''
  try {
    await deadTools.find((t) => t.name === 'session_segments').execute({ sessionId: 's-dead' })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('缺少冷读入口时报错点名 inspect / events', message.includes('inspect') && message.includes('events'), message)
}

console.log('— session_migrate —')
{
  const srcEvents = [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把设计文档补完' }] } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 1200,
      data: {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'reasoning', text: '先看目录再写' }, { type: 'text', text: '已补到第三章' }] },
      },
    },
  ]
  const srcAgent = { id: 's-src', status: 'running', session: { events: srcEvents, header: { cwd: 'E:\\proj' } }, inbox: {} }
  const subRunning = {
    id: 's-sub1',
    status: 'running',
    session: { events: [{ type: 'user/message', seq: 1, time: 900, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '查一遍名词表' }] } }], header: { origin: 'subagent' } },
  }
  const subIdle = {
    id: 's-sub2',
    status: 'idle',
    session: { events: [{ type: 'user/message', seq: 1, time: 800, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '画一张流程图' }] } }], header: { origin: 'subagent' } },
  }
  const agents = {
    get: (id) => (id === 's-src' ? srcAgent : undefined),
    list: () => [srcAgent, subRunning, subIdle],
    isOwnedBy: (id, owner) => owner.id === 's-src' && String(id).startsWith('s-sub'),
  }

  const runMigrate = async (promptImpl) => {
    const rec = callRecord()
    const timeline = []
    const made = makeCtx(
      rec,
      {
        async create(request) {
          timeline.push('create')
          rec.create.push(request)
          return { sessionId: 'session-new' }
        },
        async prompt(request) {
          timeline.push('prompt')
          rec.prompt.push(request)
          if (promptImpl) return promptImpl(request)
          return { accepted: true }
        },
        async cancel(request) {
          timeline.push('cancel')
          rec.cancel.push(request)
          return { accepted: true }
        },
      },
      { agents },
    )
    const tools = []
    made.ctx.tools.register = (tool) => {
      tools.push(tool)
      return () => {}
    }
    apply(made.ctx)
    return { tool: tools.find((t) => t.name === 'session_migrate'), rec, timeline }
  }

  {
    const { tool, rec, timeline } = await runMigrate()
    const result = await tool.execute({ fromSessionId: 's-src' })
    check('creates the successor session', result.toSessionId === 'session-new')
    check('orders create → prompt → cancel', timeline.join(',') === 'create,prompt,cancel')
    check('reports the source as stopped', result.stopped === true && rec.cancel.at(-1)?.sessionId === 's-src')
    check('reuses the source cwd', rec.create.at(-1)?.cwd === 'E:\\proj')
    check('counts descendants', result.descendantCount === 2)
    const handoff = rec.prompt.at(-1)?.content?.[0]?.text ?? ''
    check('handoff names the source session', handoff.includes('s-src'))
    check('handoff carries the task', handoff.includes('把设计文档补完'))
    check('handoff carries recent progress', handoff.includes('已补到第三章'))
    check('handoff lists running subagents separately', handoff.includes('仍在运行的子代理'))
    check('handoff lists finished subagents', handoff.includes('已结束的子代理'))
    check('handoff points at our own read tool', handoff.includes('session_segments'))
  }

  {
    const { tool, timeline } = await runMigrate()
    const result = await tool.execute({ fromSessionId: 's-src', stopSource: false, task: '换成我指定的任务' })
    check('stopSource=false keeps the source running', result.stopped === false && !timeline.includes('cancel'))
  }

  {
    const { tool, rec } = await runMigrate()
    const result = await tool.execute({ fromSessionId: 's-src', includeReasoning: false, task: 'X' })
    const handoff = rec.prompt.at(-1)?.content?.[0]?.text ?? ''
    check('includeReasoning=false drops the reasoning', !handoff.includes('先看目录再写'))
    check('task override wins', handoff.includes('X'))
    check('migration still completes', result.toSessionId === 'session-new')
  }

  // 创建失败：绝不能先停原会话
  {
    const rec = callRecord()
    const made = makeCtx(
      rec,
      {
        async create() {
          throw new Error('create boom')
        },
      },
      { agents },
    )
    const tools = []
    made.ctx.tools.register = (tool) => {
      tools.push(tool)
      return () => {}
    }
    apply(made.ctx)
    let message = ''
    try {
      await tools.find((t) => t.name === 'session_migrate').execute({ fromSessionId: 's-src' })
    } catch (error) {
      message = String(error.message)
    }
    check('create failure surfaces clearly', message.includes('create boom'))
    check('create failure never cancels the source', rec.cancel.length === 0)
  }

  // 投递失败：同样不停原会话
  {
    const { tool, rec } = await runMigrate(() => {
      throw new Error('prompt boom')
    })
    let message = ''
    try {
      await tool.execute({ fromSessionId: 's-src' })
    } catch (error) {
      message = String(error.message)
    }
    check('prompt failure surfaces clearly', message.includes('prompt boom'))
    check('prompt failure never cancels the source', rec.cancel.length === 0)
  }

  // 只能接管能读到日志的会话
  {
    const { tool } = await runMigrate()
    let message = ''
    try {
      await tool.execute({ fromSessionId: 's-nope' })
    } catch (error) {
      message = String(error.message)
    }
    check('rejects an unreadable source session', message.includes('工作目录'), message)
  }
}

console.log('— missing service —')
{
  const bare = { effect: (f) => f(), logger: { warn: () => {} }, get: () => undefined, tools: { register: () => () => {} } }
  apply(bare)
  const tools = []
  const bareCtx = { ...bare, tools: { register: (tool) => (tools.push(tool), () => {}) } }
  apply(bareCtx)
  let message = ''
  try {
    await tools.find((tool) => tool.name === 'session_list').execute({})
  } catch (error) {
    message = String(error.message)
  }
  check('fails with actionable error', message.includes('sessionController'))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
