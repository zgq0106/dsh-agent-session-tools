/**
 * 接线层回归测试：`apply()` → `session/event` 监听 → 早退 / 命中 → 投递。
 *
 * 已有的 smoke.mjs 与 watches.test.mjs 分别覆盖「工具本身」和「store / detector /
 * gate 三个纯逻辑模块」，但没有任何用例把这几段真正接起来跑一遍。本文件补的正是
 * 这条链路，尤其是最容易在重构中被悄悄改坏的两处：
 *   1. 没有 pending 守候时必须早退——连 `event.data` 一个字段都不该碰；
 *   2. 命中之后必须投递给「守候方」而不是「被守候方」，且只投递一次。
 *
 * 三条纪律（与 watches.test.mjs 一致）：
 *   1. 每个用例 `mkdtempSync` 一个临时 home，结束 `rmSync`——绝不读写真机
 *      `~/.dsh/session-control`；
 *   2. 全部使用假 ctx，不启动进程、不加载真实 profile；
 *   3. 时间只通过临时替换 `Date.now` 伪造，用例结束一定还原，不留下全局副作用。
 *
 * 运行：node --test-isolation=none --test test/wiring.test.mjs
 * （本机沙箱下不加 --test-isolation=none 会因 spawn EPERM 失败。）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

/** 命中消息里的固定尾句（契约要求逐字包含）。 */
const WATCH_FOOTER = '这是自动通知，无需回复本条消息'
/** 10 个工具的名字与注册顺序：前 8 个既有工具 + 守候对。 */
const EXPECTED_TOOLS = [
  'session_create',
  'session_inject',
  'session_list',
  'session_cancel',
  'session_wait',
  'session_segments',
  'session_status',
  'session_migrate',
  'session_watch',
  'session_watches',
]
/** 契约巡检周期：5 分钟。 */
const WATCH_TICK_MS = 5 * 60 * 1000
/** 白天基准：2026-11-12 20:00 +08:00，刻意避开静默段。 */
const DAYTIME = Date.parse('2026-11-12T20:00:00+08:00')
/** 夜间基准：2026-11-12 23:30 +08:00，落在 23:00–07:30 静默段内。 */
const NIGHT = Date.parse('2026-11-12T23:30:00+08:00')

/**
 * 用例独占的临时 home，并登记结束后的递归删除。
 * @param {import('node:test').TestContext} t 用例上下文
 * @returns {string} 临时目录绝对路径
 */
function tempHome(t) {
  const root = mkdtempSync(join(tmpdir(), 'session-control-wiring-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/**
 * 构造一个只实现接线所需面的假 Cordis ctx。
 *
 * `get('home')` 永远指向临时目录，这是「绝不碰真实 ~/.dsh」的关键：
 * `watchesRootOf()` 会优先采用它，存储根于是变成 `<root>/session-control`。
 *
 * @param {{ root: string, timer?: object }} options
 *   root：临时 home；timer：模拟 `ctx.get('timer')` 的返回值（省略即服务缺席）
 * @returns {{
 *   ctx: object,
 *   calls: { prompt: object[], list: object[] },
 *   registered: object[],
 *   listeners: Array<{ event: string, listener: Function }>,
 *   warnings: string[],
 *   getCalls: string[],
 * }}
 */
function makeCtx({ root, timer, listItems } = {}) {
  const calls = { prompt: [], list: [] }
  const registered = []
  const listeners = []
  const warnings = []
  const getCalls = []
  // 用例可以持有一份可变的会话列表：先登记成功、再让它消失，用来测「目标没了」。
  const items =
    listItems ??
    [
      { sessionId: 's-target', updatedAt: Date.now(), running: false },
      { sessionId: 's-other', updatedAt: Date.now(), running: false },
    ]

  const controller = {
    async list() {
      calls.list.push(true)
      return { items }
    },
    async prompt(request) {
      calls.prompt.push(request)
      return { accepted: true }
    },
  }

  const ctx = {
    get(key) {
      getCalls.push(key)
      if (key === 'home') return root
      if (key === 'sessionController') return controller
      if (key === 'timer') return timer
      return undefined
    },
    effect(factory) {
      return factory()
    },
    logger: {
      warn(message) {
        warnings.push(message)
      },
    },
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {}
      },
    },
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
  }

  return { ctx, calls, registered, listeners, warnings, getCalls }
}

/** 取唯一一个 `session/event` 监听器；注册失败时让用例直接失败。 */
function sessionEventListener(listeners) {
  const hits = listeners.filter((entry) => entry.event === 'session/event')
  assert.equal(hits.length, 1, '应当只注册一个 session/event 监听器')
  return hits[0].listener
}

/** 取 `session/disposed` 监听器。 */
function disposedListener(listeners) {
  const hits = listeners.filter((entry) => entry.event === 'session/disposed')
  assert.equal(hits.length, 1, '应当只注册一个 session/disposed 监听器')
  return hits[0].listener
}

/**
 * 取静默窗口的收账定时器（15 秒周期）。
 * 完成判定要过 60 秒静默窗口，用例得手动把它推到窗口之后，否则永远等不到投递。
 */
function quietDrainOf(intervalCalls) {
  const entry = intervalCalls.find((candidate) => candidate.ms === 15000)
  assert.ok(entry, '应注册 15000ms 的静默窗口收账定时器')
  return entry.fn
}

/** 按名字取已注册工具。 */
function toolNamed(registered, toolName) {
  const tool = registered.find((candidate) => candidate.name === toolName)
  assert.ok(tool, `工具 ${toolName} 应当已注册`)
  return tool
}

/** `session_watch` 工具所要求的调用方身份。 */
function execFor(watcher) {
  return { agent: { session: { id: watcher } } }
}

/**
 * 临时把 `Date.now()` 固定在某个时刻再执行，无论同步还是异步都一定还原。
 * 接线层的时间判定直接读 `Date.now()`，这是唯一需要伪造的系统面。
 */
async function atTime(epochMs, fn) {
  const original = Date.now
  Date.now = () => epochMs
  try {
    return await fn()
  } finally {
    Date.now = original
  }
}

/** 真实时间下的轮询等待（不能在 `Date.now` 被伪造时调用）。 */
async function waitFor(predicate, label, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** 记录所有 interval 注册的假 timer；用例据此手动触发收账回调。 */
function recordingTimer() {
  const intervalCalls = []
  return {
    intervalCalls,
    timer: {
      interval(fn, ms) {
        intervalCalls.push({ fn, ms })
        return () => {}
      },
    },
  }
}

/** 读取当前用例临时 home 下的 watches.json；文件尚未落盘时返回空数组。 */
function readWatches(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'session-control', 'watches.json'), 'utf8'))
  } catch {
    return []
  }
}

/** 投递一条 `turn/end`（completed）。 */
function completedEvent(seq, epochMs = DAYTIME) {
  return {
    type: 'turn/end',
    seq,
    time: epochMs,
    data: { reason: { kind: 'completed' } },
  }
}

// ───────────────────────────── 1. 工具注册 ─────────────────────────────

test('1. apply 注册 10 个工具（名字逐一核对）', (t) => {
  const root = tempHome(t)
  const { ctx, registered } = makeCtx({ root })

  assert.doesNotThrow(() => apply(ctx))
  assert.deepEqual(
    registered.map((tool) => tool.name),
    EXPECTED_TOOLS,
  )
  assert.equal(new Set(registered.map((tool) => tool.name)).size, 10, '10 个工具名必须互不重复')
})

// ───────────────────────────── 2. 无守候早退 ─────────────────────────────

test('2. 没有 pending 守候时 session/event 早退，event.data 从未被读取', (t) => {
  const root = tempHome(t)
  const { ctx, calls, listeners } = makeCtx({ root })
  apply(ctx)
  const listener = sessionEventListener(listeners)

  // 带 getter 的 data：只要有人读一次，计数就不是 0。
  let dataReads = 0
  const event = {
    type: 'turn/end',
    seq: 42,
    time: Date.now(),
    get data() {
      dataReads += 1
      return { reason: { kind: 'completed' } }
    },
  }

  assert.doesNotThrow(() => listener({ id: 's-target' }, event))
  assert.equal(dataReads, 0, '没有 pending 守候时不应触碰 event.data')
  assert.equal(calls.prompt.length, 0, '早退路径不应投递任何消息')
  assert.deepEqual(readWatches(root), [], '早退路径不应写守候文件')
})

// ───────────────────────────── 3. 命中投递 ─────────────────────────────

test('3. notify 守候命中：过静默窗口后 prompt 投给 watcher、queue 模式、含命中标记与固定尾句', async (t) => {
  const root = tempHome(t)
  const { timer, intervalCalls } = recordingTimer()
  const { ctx, calls, registered, listeners } = makeCtx({ root, timer })
  apply(ctx)

  const watchTool = toolNamed(registered, 'session_watch')
  const watch = await atTime(DAYTIME, () =>
    watchTool.execute(
      { targetSessionId: 's-target', condition: 'completed', action: 'notify' },
      execFor('s-watcher'),
    ),
  )
  assert.equal(watch.action, 'notify')
  assert.equal(watch.degraded, undefined, '白天登记 notify 不应被降级')

  const listener = sessionEventListener(listeners)
  await atTime(DAYTIME, () => listener({ id: 's-target' }, completedEvent(7)))

  // 计划 §2.4：一轮结束不等于活干完了，60 秒静默窗口内不得投递。
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls.prompt.length, 0, '静默窗口内不得投递')

  await atTime(DAYTIME + 61_000, () => quietDrainOf(intervalCalls)())

  await waitFor(() => calls.prompt.length === 1, '静默窗口到期后应投递一次')
  await waitFor(
    () => readWatches(root).some((entry) => entry.id === watch.watchId && entry.state === 'fired'),
    '命中后 watch 应落盘为 fired',
  )

  const request = calls.prompt[0]
  assert.equal(request.sessionId, 's-watcher', '必须投给守候方，不是被守候方')
  assert.notEqual(request.sessionId, 's-target')
  assert.equal(request.mode, 'queue')
  assert.equal(request.content.length, 1)
  assert.equal(request.content[0].type, 'text')
  assert.match(request.content[0].text, /\[守候命中\]/)
  assert.ok(
    request.content[0].text.includes(WATCH_FOOTER),
    '命中消息必须包含固定尾句，避免两个会话互相回话',
  )
})

// ───────────────────────────── 4. 只投递一次 ─────────────────────────────

test('4. 同一个 watch 命中后是终态，重放同一条事件不会二次投递', async (t) => {
  const root = tempHome(t)
  const { timer, intervalCalls } = recordingTimer()
  const { ctx, calls, registered, listeners } = makeCtx({ root, timer })
  apply(ctx)

  const watchTool = toolNamed(registered, 'session_watch')
  const watch = await atTime(DAYTIME, () =>
    watchTool.execute(
      { targetSessionId: 's-target', condition: 'completed', action: 'notify' },
      execFor('s-watcher'),
    ),
  )

  const listener = sessionEventListener(listeners)
  const event = completedEvent(8)
  await atTime(DAYTIME, () => listener({ id: 's-target' }, event))
  await atTime(DAYTIME + 61_000, () => quietDrainOf(intervalCalls)())

  await waitFor(() => calls.prompt.length === 1, '第一次命中应投递')
  await waitFor(
    () => readWatches(root).some((entry) => entry.id === watch.watchId && entry.state === 'fired'),
    '第一次命中后 watch 应进入 fired 终态',
  )

  // fired 后再放同一条事件：pending 里已经没有它，监听器应当直接早退。
  await atTime(DAYTIME + 120_000, () => listener({ id: 's-target' }, event))
  await atTime(DAYTIME + 180_000, () => quietDrainOf(intervalCalls)())
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(calls.prompt.length, 1, '终态 watch 不得被同一事件二次投递')

  const watchesTool = toolNamed(registered, 'session_watches')
  const listed = await watchesTool.execute({ action: 'list', includeSettled: true })
  assert.equal(listed.count, 1)
  assert.equal(listed.watches[0].watchId, watch.watchId)
  assert.equal(listed.watches[0].state, 'fired')
})

// ───────────────────────────── 5. timer 缺席 ─────────────────────────────

test('5. ctx.get("timer") 返回 undefined 时 apply 不抛错，也不注册 interval', (t) => {
  const root = tempHome(t)
  const { ctx, registered, warnings, getCalls } = makeCtx({ root })

  // 若有人退回不安全的 `ctx.timer` 服务属性读取，这里会立刻抛错并被 apply 的兜底
  // 接住；下面的断言通过 warnings 把这种「静默降级」也钉住。
  let directTimerAccess = 0
  Object.defineProperty(ctx, 'timer', {
    configurable: true,
    get() {
      directTimerAccess += 1
      throw new Error('不得直接访问 ctx.timer，应使用 ctx.get("timer")')
    },
  })

  assert.doesNotThrow(() => apply(ctx), 'timer 缺席不应让 apply 抛错')
  assert.equal(registered.length, 10, 'timer 缺席不影响 10 个工具注册')
  assert.equal(getCalls.filter((key) => key === 'timer').length, 1, '应通过 ctx.get 查询一次 timer')
  assert.equal(directTimerAccess, 0, '不得直接访问 ctx.timer 服务属性')
  assert.equal(
    warnings.some((message) => message.includes('跨会话触发接线失败')),
    false,
    'timer 缺席不应触发接线层兜底异常',
  )
})

// ───────────────────────────── 6. 5 分钟巡检 ─────────────────────────────

test('6. timer 可用时注册 5 分钟巡检 + 15 秒静默窗口收账', (t) => {
  const root = tempHome(t)
  const { timer, intervalCalls } = recordingTimer()
  const { ctx } = makeCtx({ root, timer })

  apply(ctx)

  assert.equal(intervalCalls.length, 2, '应注册两个定时器：巡检 + 静默窗口收账')
  assert.equal(intervalCalls[0].ms, WATCH_TICK_MS)
  assert.equal(intervalCalls[0].ms, 300000)
  assert.equal(typeof intervalCalls[0].fn, 'function')
  assert.equal(intervalCalls[1].ms, 15000, '静默窗口收账周期必须是 15 秒')
  assert.equal(typeof intervalCalls[1].fn, 'function')
})

// ───────────────────────────── 7. 静默段降级 ─────────────────────────────

test('7. 静默段降级：23:30 登记/命中只落盘，不调用 prompt', async (t) => {
  const root = tempHome(t)
  const { timer, intervalCalls } = recordingTimer()
  const { ctx, calls, registered, listeners } = makeCtx({ root, timer })
  apply(ctx)

  const watchTool = toolNamed(registered, 'session_watch')
  const listener = sessionEventListener(listeners)

  // 7a：23:30 登记 wake —— 登记闸门当场降级为 record（record 动作立即落账，不进静默窗口）。
  const quietWatch = await atTime(NIGHT, () =>
    watchTool.execute(
      { targetSessionId: 's-target', condition: 'completed', action: 'wake' },
      execFor('s-watcher'),
    ),
  )
  assert.equal(quietWatch.action, 'record', '静默段内登记的 wake 应降级为 record')
  assert.equal(quietWatch.degraded, 'quiet-hours')

  await atTime(NIGHT, () => listener({ id: 's-target' }, completedEvent(9, NIGHT)))
  await waitFor(
    () => readWatches(root).some((entry) => entry.id === quietWatch.watchId && entry.state === 'fired'),
    '静默段命中应落盘为 fired',
  )
  assert.equal(calls.prompt.length, 0, '静默段命中不得调用 prompt')

  const quietOnDisk = readWatches(root).find((entry) => entry.id === quietWatch.watchId)
  assert.equal(quietOnDisk.state, 'fired')
  assert.equal(quietOnDisk.effectiveAction, 'record')

  // 7b：白天登记真正的 wake，夜里命中 —— 证明「点火时」也会重新走闸门，
  // 而不是只在登记时判一次。这一条是从外部端到端覆盖 fireWatch 的降级分支。
  const wakeWatch = await atTime(DAYTIME, () =>
    watchTool.execute(
      { targetSessionId: 's-target', condition: 'completed', action: 'wake' },
      execFor('s-watcher'),
    ),
  )
  assert.equal(wakeWatch.action, 'wake', '白天登记 wake 应原样保留')
  assert.equal(wakeWatch.degraded, undefined)

  await atTime(NIGHT, () => listener({ id: 's-target' }, completedEvent(10, NIGHT)))
  // wake 命中要先过 60 秒静默窗口；窗口到期时已是夜里，闸门把它降级成 record。
  await atTime(NIGHT + 61_000, () => quietDrainOf(intervalCalls)())
  await waitFor(
    () => readWatches(root).some((entry) => entry.id === wakeWatch.watchId && entry.state === 'fired'),
    '夜间命中应落盘为 fired',
  )
  assert.equal(calls.prompt.length, 0, '夜间命中不得调用 prompt')

  const wakeOnDisk = readWatches(root).find((entry) => entry.id === wakeWatch.watchId)
  assert.equal(wakeOnDisk.action, 'wake', '落盘的登记动作仍应是 wake')
  assert.equal(wakeOnDisk.effectiveAction, 'record', '点火时静默闸门应把它降级成 record')
  assert.equal(wakeOnDisk.state, 'fired')
  assert.equal(wakeOnDisk.state === 'pending', false)
})

// ───────────────────── 8. 静默窗口：连续多轮只叫一次 ─────────────────────

test('8. 静默窗口内又来一轮：重置计时，只投递一次且用最后一轮的证据', async (t) => {
  const root = tempHome(t)
  const { timer, intervalCalls } = recordingTimer()
  const { ctx, calls, registered, listeners } = makeCtx({ root, timer })
  apply(ctx)

  const watchTool = toolNamed(registered, 'session_watch')
  const watch = await atTime(DAYTIME, () =>
    watchTool.execute(
      { targetSessionId: 's-target', condition: 'completed', action: 'notify' },
      execFor('s-watcher'),
    ),
  )

  const listener = sessionEventListener(listeners)
  await atTime(DAYTIME, () => listener({ id: 's-target' }, completedEvent(1)))
  // 30 秒后又收一轮：计时重置，到期时刻变成 20:01:30。
  await atTime(DAYTIME + 30_000, () => listener({ id: 's-target' }, completedEvent(2)))

  await atTime(DAYTIME + 61_000, () => quietDrainOf(intervalCalls)())
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls.prompt.length, 0, '计时被第二轮重置，61 秒时还不该投递')

  await atTime(DAYTIME + 91_000, () => quietDrainOf(intervalCalls)())
  await waitFor(() => calls.prompt.length === 1, '第二轮的窗口到期后应投递一次')

  const onDisk = readWatches(root).find((entry) => entry.id === watch.watchId)
  assert.equal(onDisk.state, 'fired')
  assert.equal(onDisk.evidence.seq, 2, '证据必须是最后一轮的 seq，不是第一轮的')
})

// ───────────────────────── 9. 目标 dispose → failed ─────────────────────────

test('9. 目标会话 dispose：挂着的守候落 failed，静默窗口里的待投递一并作废', async (t) => {
  const root = tempHome(t)
  const { timer, intervalCalls } = recordingTimer()
  const { ctx, calls, registered, listeners } = makeCtx({ root, timer })
  apply(ctx)

  const watchTool = toolNamed(registered, 'session_watch')
  const watch = await atTime(DAYTIME, () =>
    watchTool.execute(
      { targetSessionId: 's-target', condition: 'completed', action: 'notify' },
      execFor('s-watcher'),
    ),
  )

  const listener = sessionEventListener(listeners)
  const onDisposed = disposedListener(listeners)
  // 先让一次命中进入静默窗口，再销毁目标：这条待投递必须一起清掉。
  await atTime(DAYTIME, () => listener({ id: 's-target' }, completedEvent(11)))
  await atTime(DAYTIME + 10_000, () => onDisposed({ id: 's-target' }))

  const onDisk = readWatches(root).find((entry) => entry.id === watch.watchId)
  assert.equal(onDisk.state, 'failed', '目标 dispose 后守候必须落 failed，不能静默悬挂')
  assert.match(String(onDisk.lastError), /dispose/)

  await atTime(DAYTIME + 120_000, () => quietDrainOf(intervalCalls)())
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(calls.prompt.length, 0, '已作废的守候不得再投递')

  // 影响面必须收窄：别的目标不受牵连。
  const other = await atTime(DAYTIME, () =>
    watchTool.execute(
      { targetSessionId: 's-other', condition: 'completed', action: 'notify' },
      execFor('s-watcher'),
    ),
  )
  await atTime(DAYTIME + 10_000, () => onDisposed({ id: 's-target' }))
  const otherOnDisk = readWatches(root).find((entry) => entry.id === other.watchId)
  assert.equal(otherOnDisk.state, 'pending', '另一条守候不该被目标 dispose 牵连')
})

// ───────────────── 10. 目标连续缺席 2 次巡检 → failed ─────────────────

test('10. 目标连续 2 次不在会话列表 → 守候落 failed（事件通道失灵时的兜底）', async (t) => {
  const root = tempHome(t)
  const listItems = [{ sessionId: 's-target', updatedAt: Date.now(), running: false }]
  const { timer, intervalCalls } = recordingTimer()
  const { ctx, registered } = makeCtx({ root, timer, listItems })
  apply(ctx)

  const watchTool = toolNamed(registered, 'session_watch')
  const watch = await atTime(DAYTIME, () =>
    watchTool.execute(
      { targetSessionId: 's-target', condition: 'stalled', action: 'notify' },
      execFor('s-watcher'),
    ),
  )

  const tick = intervalCalls.find((entry) => entry.ms === 300000).fn
  listItems.length = 0

  tick()
  await new Promise((resolve) => setTimeout(resolve, 40))
  let onDisk = readWatches(root).find((entry) => entry.id === watch.watchId)
  assert.equal(onDisk.state, 'pending', '只缺席一次还可能是偶发读空，不得判死')

  tick()
  await new Promise((resolve) => setTimeout(resolve, 40))
  onDisk = readWatches(root).find((entry) => entry.id === watch.watchId)
  assert.equal(onDisk.state, 'failed', '连续 2 次缺席才判死')
  assert.match(String(onDisk.lastError), /缺席|列表/)
})

// ─────────────────────── 11. 观测：确认与误报 ───────────────────────

test('11. 观测：唤醒后守候方有事件 → confirmed；目标又收一轮 → premature', async (t) => {
  const root = tempHome(t)
  const { timer, intervalCalls } = recordingTimer()
  const { ctx, calls, registered, listeners } = makeCtx({ root, timer })
  apply(ctx)

  const watchTool = toolNamed(registered, 'session_watch')
  const listener = sessionEventListener(listeners)
  const watchesTool = toolNamed(registered, 'session_watches')

  // 11a：确认。守候方在投递后 2 分钟内发了一条事件。
  const confirmedWatch = await atTime(DAYTIME, () =>
    watchTool.execute(
      { targetSessionId: 's-target', condition: 'completed', action: 'notify' },
      execFor('s-watcher'),
    ),
  )
  await atTime(DAYTIME, () => listener({ id: 's-target' }, completedEvent(21)))
  await atTime(DAYTIME + 61_000, () => quietDrainOf(intervalCalls)())
  await waitFor(() => calls.prompt.length === 1, '确认用例应先投递一次')
  await atTime(DAYTIME + 122_000, () => listener({ id: 's-watcher' }, { type: 'step/start', time: DAYTIME + 122_000, data: {} }))

  let stats = await watchesTool.execute({ action: 'stats' })
  assert.equal(stats.stats.confirmed, 1, '守候方有事件应记为确认')
  const confirmedRow = (await watchesTool.execute({ action: 'list', includeSettled: true })).watches.find(
    (row) => row.watchId === confirmedWatch.watchId,
  )
  assert.equal(confirmedRow.outcome, 'confirmed', '结局要能在列表行的 outcome 字段查到')

  // 11b：误报。命中后 90 秒内目标自己又收了一轮 —— 判早了。
  const prematureWatch = await atTime(DAYTIME, () =>
    watchTool.execute(
      { targetSessionId: 's-target', condition: 'completed', action: 'notify' },
      execFor('s-watcher'),
    ),
  )
  await atTime(DAYTIME, () => listener({ id: 's-target' }, completedEvent(22)))
  await atTime(DAYTIME + 61_000, () => quietDrainOf(intervalCalls)())
  await waitFor(() => calls.prompt.length === 2, '误报用例应投递第二次')
  await atTime(DAYTIME + 91_000, () => listener({ id: 's-target' }, completedEvent(23)))

  stats = await watchesTool.execute({ action: 'stats' })
  assert.equal(stats.stats.premature, 2, '两条 completed 都被后续一轮推翻了「完成」判定')
  assert.equal(stats.stats.acknowledged, 1, '「叫起来过」是既成事实，不随结局改判而消失')
  const prematureRow = (await watchesTool.execute({ action: 'list', includeSettled: true })).watches.find(
    (row) => row.watchId === prematureWatch.watchId,
  )
  assert.equal(prematureRow.outcome, 'premature')

  // 渲染面也必须能读出来：统计不是只给测试看的。
  const rendered = watchesTool.output.render({ action: 'stats' }, stats)
  assert.match(rendered[0].text, /叫起 1/)
  assert.match(rendered[0].text, /误报 2/)
})

// ───────────── 12. 统计口径的两条反向校验（11-12 实测踩到的） ─────────────

test('12. record 动作与「本来就只要 record」都不进叫起/降级计数', async (t) => {
  const root = tempHome(t)
  const { timer, intervalCalls } = recordingTimer()
  const { ctx, registered, listeners } = makeCtx({ root, timer })
  apply(ctx)

  const watchTool = toolNamed(registered, 'session_watch')
  const listener = sessionEventListener(listeners)
  const watchesTool = toolNamed(registered, 'session_watches')

  await atTime(DAYTIME, () =>
    watchTool.execute(
      { targetSessionId: 's-target', condition: 'completed', action: 'record' },
      execFor('s-watcher'),
    ),
  )
  // record 动作不进静默窗口，事件一到就落账。
  await atTime(DAYTIME, () => listener({ id: 's-target' }, completedEvent(31)))
  // 守候方随后自己干活——这不代表「被叫起来了」，因为它压根没收到消息。
  await atTime(DAYTIME + 5_000, () => listener({ id: 's-watcher' }, { type: 'step/start', time: DAYTIME + 5_000, data: {} }))

  const stats = await watchesTool.execute({ action: 'stats' })
  assert.equal(stats.stats.recorded, 1, 'record 动作记 recorded')
  assert.equal(stats.stats.acknowledged, 0, 'record 动作没有投递，不得计入叫起')
  assert.equal(stats.stats.degraded, 0, '「本来就只要 record」不是降级')

  // 反面对照：同一个目标换成 notify，才该出现叫起。
  await atTime(DAYTIME + 10_000, () =>
    watchTool.execute(
      { targetSessionId: 's-target', condition: 'completed', action: 'notify' },
      execFor('s-watcher'),
    ),
  )
  await atTime(DAYTIME + 10_000, () => listener({ id: 's-target' }, completedEvent(32)))
  await atTime(DAYTIME + 71_000, () => quietDrainOf(intervalCalls)())
  await atTime(DAYTIME + 80_000, () => listener({ id: 's-watcher' }, { type: 'step/start', time: DAYTIME + 80_000, data: {} }))

  const after = await watchesTool.execute({ action: 'stats' })
  assert.equal(after.stats.acknowledged, 1, 'notify 投递后守候方有事件才算叫起')
})
