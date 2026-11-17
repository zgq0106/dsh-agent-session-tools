/**
 * 巡检链路回归测试：真正触发 apply() 装上的 5 分钟定时器回调。
 *
 * 为什么单独一个文件：wiring.test.mjs 只验了「定时器注册了、间隔 300000」，
 * 没验「回调跑起来会不会命中」。而 question / stalled / idle 这三类条件
 * **只有巡检能发现**（事件流里根本没有它们），这段不带回归网就等于没做。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../index.js'

const createdDirs = []
after(() => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }
})

const OWNER = 'session-owner'
const TARGET = 'session-target'

/**
 * 假 Cordis 上下文：只给 apply 真正用到的那几样。
 * 用 ctx.get 而非 ctx.xxx，是与 index.js 修完 `cannot get property "home" without inject`
 * 之后的真实约定对齐——测试也得这么给，否则测的是不存在的路径。
 */
function makeCtx({ listItems = [], onEvent, promptCalls } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'session-control-tick-'))
  createdDirs.push(dir)

  const registered = []
  const intervals = []

  const ctx = {
    get(key) {
      if (key === 'home') return dir
      if (key === 'timer') {
        return {
          interval(fn, ms) {
            intervals.push({ fn, ms })
            return () => undefined
          },
        }
      }
      if (key === 'sessionController') {
        return {
          async list() {
            return { items: listItems }
          },
          async prompt(request) {
            promptCalls.push(request)
            return { accepted: true }
          },
          async resolveAgent() {
            return { agent: { id: TARGET } }
          },
          async inspect() {
            return { events: [], meta: {} }
          },
        }
      }
      return undefined
    },
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
    on(type, handler) {
      if (type === 'session/event' && onEvent) onEvent(handler)
      return () => undefined
    },
    effect(factory) {
      return factory()
    },
    logger: { warn() {} },
  }
  return { ctx, dir, registered, intervals }
}

/** 等定时器回调里那条 Promise 链跑完。 */
async function drain() {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

/**
 * 取 5 分钟巡检回调。
 * 接线共注册两个 interval（巡检 300000 + 静默窗口收账 15000），按周期取，别按序号取。
 * @param {Array<{ fn: Function, ms: number }>} intervals 已注册的定时器
 * @returns {Function} 巡检回调
 */
function tickFn(intervals) {
  const found = intervals.find((entry) => entry.ms === 300000)
  assert.ok(found, '巡检定时器应已装上')
  return found.fn
}

function watchTool(registered) {
  const tool = registered.find((item) => item.name === 'session_watch')
  assert.ok(tool, 'session_watch 必须注册')
  return tool
}

test('stalled：running 且 20 分钟无事件 → 巡检命中并投递', async () => {
  const promptCalls = []
  const staleAt = Date.now() - 20 * 60 * 1000
  const { ctx, registered, intervals } = makeCtx({
    listItems: [{ sessionId: TARGET, running: true, updatedAt: staleAt }],
    promptCalls,
  })
  apply(ctx)

  await watchTool(registered).execute(
    { targetSessionId: TARGET, condition: 'stalled', action: 'notify' },
    { agent: { session: { id: OWNER }, id: OWNER } },
  )

  assert.equal(intervals.filter((entry) => entry.ms === 300000).length, 1, '巡检定时器应已装上')
  tickFn(intervals)()
  await drain()

  assert.equal(promptCalls.length, 1, '应投递一次')
  assert.equal(promptCalls[0].sessionId, OWNER)
  assert.equal(promptCalls[0].mode, 'queue')
  assert.ok(String(promptCalls[0].content[0].text).includes('[守候命中]'))
})

test('stalled 反例：running 但只安静 5 分钟 → 不命中', async () => {
  const promptCalls = []
  const { ctx, registered, intervals } = makeCtx({
    listItems: [{ sessionId: TARGET, running: true, updatedAt: Date.now() - 5 * 60 * 1000 }],
    promptCalls,
  })
  apply(ctx)
  await watchTool(registered).execute(
    { targetSessionId: TARGET, condition: 'stalled', action: 'notify' },
    { agent: { session: { id: OWNER }, id: OWNER } },
  )
  tickFn(intervals)()
  await drain()
  assert.equal(promptCalls.length, 0)
})

test('question：提问挂了 21 分钟 → 巡检命中', async () => {
  const promptCalls = []
  let handler
  const { ctx, registered, intervals } = makeCtx({
    listItems: [{ sessionId: TARGET, running: true, updatedAt: Date.now() }],
    promptCalls,
    onEvent: (fn) => {
      handler = fn
    },
  })
  apply(ctx)

  // 先登记，监听器才会为这个会话记账（早退逻辑要求存在 pending 守候）
  await watchTool(registered).execute(
    { targetSessionId: TARGET, condition: 'question', action: 'notify' },
    { agent: { session: { id: OWNER }, id: OWNER } },
  )

  handler(
    { id: TARGET },
    {
      type: 'tool/call',
      time: Date.now() - 21 * 60 * 1000,
      data: { name: 'ask_user_question', callId: 'call-1' },
    },
  )

  tickFn(intervals)()
  await drain()

  assert.equal(promptCalls.length, 1, '悬空 21 分钟应命中')
  assert.ok(String(promptCalls[0].content[0].text).includes('question'))
})

test('question 反例：提问只挂了 5 分钟 → 不命中', async () => {
  const promptCalls = []
  let handler
  const { ctx, registered, intervals } = makeCtx({
    listItems: [{ sessionId: TARGET, running: true, updatedAt: Date.now() }],
    promptCalls,
    onEvent: (fn) => {
      handler = fn
    },
  })
  apply(ctx)
  await watchTool(registered).execute(
    { targetSessionId: TARGET, condition: 'question', action: 'notify' },
    { agent: { session: { id: OWNER }, id: OWNER } },
  )
  handler(
    { id: TARGET },
    { type: 'tool/call', time: Date.now() - 5 * 60 * 1000, data: { name: 'ask_user_question', callId: 'call-2' } },
  )
  tickFn(intervals)()
  await drain()
  assert.equal(promptCalls.length, 0)
})

test('idle：安静超过 idleMs → 巡检命中', async () => {
  const promptCalls = []
  let handler
  const { ctx, registered, intervals } = makeCtx({
    listItems: [{ sessionId: TARGET, running: false, updatedAt: Date.now() }],
    promptCalls,
    onEvent: (fn) => {
      handler = fn
    },
  })
  apply(ctx)
  await watchTool(registered).execute(
    { targetSessionId: TARGET, condition: 'idle', action: 'notify', idleMs: 1000 },
    { agent: { session: { id: OWNER }, id: OWNER } },
  )

  // idle 的基线是「最后一次观测到的事件」，不是 list 里的 updatedAt：
  // 所以先投一条无关事件把观测时间推到 10 秒前，再跑巡检。
  handler({ id: TARGET }, { type: 'step/start', time: Date.now() - 10_000, data: {} })

  tickFn(intervals)()
  await drain()
  assert.equal(promptCalls.length, 1, '安静 10 秒超过 1 秒阈值应命中')
})

test('idle 反例：刚登记就巡检 → 以登记时刻为基线，不命中', async () => {
  const promptCalls = []
  const { ctx, registered, intervals } = makeCtx({
    listItems: [{ sessionId: TARGET, running: false, updatedAt: Date.now() - 60_000 }],
    promptCalls,
  })
  apply(ctx)
  await watchTool(registered).execute(
    { targetSessionId: TARGET, condition: 'idle', action: 'notify', idleMs: 1000 },
    { agent: { session: { id: OWNER }, id: OWNER } },
  )
  tickFn(intervals)()
  await drain()
  // 这是刻意的取舍：登记前就安静的会话要多等一个 idleMs，避免一登记就点燃陈旧守候。
  assert.equal(promptCalls.length, 0)
})

test('巡检异常不抛出：list 抛错时静默跳过', async () => {
  const promptCalls = []
  const { ctx, registered, intervals } = makeCtx({ listItems: [], promptCalls })
  // 覆盖成会抛错的 list
  const original = ctx.get
  ctx.get = (key) => {
    const value = original(key)
    if (key === 'sessionController') {
      return { ...value, list: async () => { throw new Error('boom') } }
    }
    return value
  }
  apply(ctx)
  await watchTool(registered).execute(
    { targetSessionId: TARGET, condition: 'stalled', action: 'notify' },
    { agent: { session: { id: OWNER }, id: OWNER } },
  )
  assert.doesNotThrow(() => intervals[0].fn())
  await drain()
  assert.equal(promptCalls.length, 0)
})
