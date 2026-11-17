/**
 * 跨会话触发（watch）三模块的契约测试。
 *
 * 为什么用 node:test 而不是像 smoke.mjs 那样手搓计数器：本文件覆盖的是纯逻辑
 * （存储 / 判定 / 闸门），没有需要按顺序共享的调用桩，直接跑 `node --test` 就能拿到
 * 逐条用例名与失败位置；手搓计数器在用例一多之后，失败只剩一个行号。
 *
 * 三条约定：
 *   1. 每个用例都 `mkdtempSync` 一个临时 root，结束后 `rmSync` 删掉——绝不写入真实
 *      `~/.dsh/session-control`，否则跑一次测试就把主人的守候记录清空了。
 *   2. 时钟一律注入（`now: () => clock`），不碰真实时间：过期、静默段、预算都是
 *      时间相关判定，用真实时钟只能写成「大概」的断言。
 *   3. 断言只钉契约里写死的字段与顺序，不钉实现细节（比如内部用什么容器）。
 *
 * 运行：node --test-isolation=none --test test/watches.test.mjs
 * （本机沙箱下不加 --test-isolation=none 会因 spawn EPERM 失败。）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WATCH_STATES, createWatchStore, watchesPath } from '../src/watch-store.js'
import { CONDITION_KINDS, QUESTION_MS, STALLED_MS, createDetector } from '../src/watch-detector.js'
import { DAILY_WAKE_LIMIT, MAX_PENDING, evaluateGate, inQuietHours } from '../src/watch-gate.js'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 基准时刻：2026-11-12 20:00 +08:00。刻意落在静默段之外，好让「白天放行」的用例有共同起点。 */
const T0 = Date.parse('2026-11-12T20:00:00+08:00')

/**
 * 建一个用例独占的临时存储根，并登记用例结束后的清理。
 * @param {import('node:test').TestContext} t 用例上下文，用于注册 after 钩子
 * @returns {string} 临时目录绝对路径（当作 `<DSH_HOME>/session-control` 使用）
 */
function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'session-control-watch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** 契约里一条最小可登记 watch：只给业务字段，机械字段由 store 兜底。 */
function minimalWatch(overrides = {}) {
  return { target: 'session-target', watcher: 'session-watcher', condition: 'completed', ...overrides }
}

test('契约常量与模块导出一致', () => {
  assert.deepEqual(WATCH_STATES, ['pending', 'fired', 'expired', 'canceled', 'failed'])
  assert.deepEqual(CONDITION_KINDS, ['completed', 'failed', 'idle', 'question', 'stalled', 'truncated'])
  assert.equal(DAILY_WAKE_LIMIT, 10)
  assert.equal(MAX_PENDING, 20)
})

// ───────────────────────────── store ─────────────────────────────

test('store：add 落盘，id 与时间戳按契约派生', (t) => {
  const root = tempRoot(t)
  const store = createWatchStore({ root, now: () => T0 })

  const watch = store.add(minimalWatch({ action: 'notify', idleMs: 300000 }))

  assert.match(watch.id, /^watch-[0-9a-f]{8}$/)
  assert.equal(watch.state, 'pending')
  assert.equal(watch.createdAt, '2026-11-12T20:00:00+08:00')
  assert.equal(watch.expiresAt, '2026-11-19T20:00:00+08:00')
  assert.equal(watch.attempts, 0)
  assert.equal(watch.idleMs, 300000)

  // all() 与 pending() 都读得到；对外必须是副本，改返回值不能污染内存态。
  assert.equal(store.all().length, 1)
  assert.equal(store.pending().length, 1)
  watch.state = 'fired'
  assert.equal(store.all()[0].state, 'pending')

  // 落盘的是裸数组，可读可 diff。
  const onDisk = JSON.parse(readFileSync(watchesPath(root), 'utf8'))
  assert.equal(Array.isArray(onDisk), true)
  assert.equal(onDisk.length, 1)
  assert.equal(onDisk[0].id, watch.id)
  assert.equal(watchesPath(root), join(root, 'watches.json'))
})

test('store：add 校验业务字段，缺 target 或 action 非法都抛错', (t) => {
  const root = tempRoot(t)
  const store = createWatchStore({ root, now: () => T0 })

  assert.throws(() => store.add({ watcher: 'session-w', condition: 'completed' }), /target/)
  assert.throws(() => store.add(minimalWatch({ action: 'shout' })), /action/)
  // add 抛错后不能留下半条记录。
  assert.equal(store.all().length, 0)
})

test('store：同 id 覆盖而不是新增', (t) => {
  const root = tempRoot(t)
  const store = createWatchStore({ root, now: () => T0 })
  const id = 'watch-deadbeef'

  store.add(minimalWatch({ id, condition: 'completed' }))
  store.add(minimalWatch({ id, condition: 'failed', action: 'record' }))

  const all = store.all()
  assert.equal(all.length, 1)
  assert.equal(all[0].condition, 'failed')
  assert.equal(all[0].action, 'record')
  assert.equal(JSON.parse(readFileSync(watchesPath(root), 'utf8')).length, 1)
})

test('store：cancel 只对 pending 生效，重复取消返回 false', (t) => {
  const root = tempRoot(t)
  const store = createWatchStore({ root, now: () => T0 })
  const watch = store.add(minimalWatch())

  assert.equal(store.cancel('watch-missing'), false)
  assert.equal(store.cancel(watch.id), true)

  const [canceled] = store.all()
  assert.equal(canceled.state, 'canceled')
  assert.equal(canceled.canceledAt, '2026-11-12T20:00:00+08:00')
  assert.equal(canceled.endedAt, '2026-11-12T20:00:00+08:00')
  // 已结束的不再参与命中。
  assert.equal(store.pending().length, 0)
  // 终态不可再次取消，否则「到底触发过没有」就查不出来了。
  assert.equal(store.cancel(watch.id), false)
})

test('store：pending() 把过期的 pending 就地标成 expired', (t) => {
  const root = tempRoot(t)
  let clock = T0
  const store = createWatchStore({ root, now: () => clock })
  const watch = store.add(minimalWatch({ expiresInHours: 1 }))

  assert.equal(watch.expiresAt, '2026-11-12T21:00:00+08:00')
  // 边界：恰好到过期时刻还不算过期（严格早于才过期）。
  clock = T0 + HOUR
  assert.equal(store.pending().length, 1)

  clock = T0 + HOUR + 1
  assert.equal(store.pending().length, 0)
  const [expired] = store.all()
  assert.equal(expired.state, 'expired')
  // 结束时间按注入时钟派生，固定 +08:00（毫秒不进字段，所以是整秒）。
  assert.equal(expired.endedAt, '2026-11-12T21:00:00+08:00')
  // 过期是终态，落盘后重新读回也还是 expired。
  const reopened = createWatchStore({ root, now: () => clock })
  assert.equal(reopened.load().loaded, 1)
  assert.equal(reopened.all()[0].state, 'expired')
})

test('store：坏 JSON 备份成 watches.corrupt-<ts>.json 且不抛', (t) => {
  const root = tempRoot(t)
  const bad = '{ "watches": [ {"id": "watch-1", '
  writeFileSync(watchesPath(root), bad, 'utf8')

  const store = createWatchStore({ root, now: () => T0 })
  let result
  assert.doesNotThrow(() => {
    result = store.load()
  })
  assert.deepEqual(result, { loaded: 0, corrupt: true })
  assert.equal(store.all().length, 0)

  // 备份是事后排查的唯一现场：必须存在，且内容与坏文件一致。
  const files = readdirSync(root)
  const backup = files.find((name) => /^watches\.corrupt-\d{8}-\d{6}\.json$/.test(name))
  assert.ok(backup, `没找到备份文件，目录里只有：${files.join(', ')}`)
  assert.equal(readFileSync(join(root, backup), 'utf8'), bad)
  // 原路径的坏文件保留，不被静默覆盖成空数组。
  assert.equal(readFileSync(watchesPath(root), 'utf8'), bad)
})

test('store：文件不存在时 load 返回 {loaded:0} 且不建文件', (t) => {
  const root = tempRoot(t)
  const store = createWatchStore({ root, now: () => T0 })
  assert.deepEqual(store.load(), { loaded: 0 })
  assert.equal(store.all().length, 0)
})

test('store：原子写之后同一 root 重新 load 能读回，且不留 .tmp', (t) => {
  const root = tempRoot(t)
  const writer = createWatchStore({ root, now: () => T0 })
  const saved = writer.add(minimalWatch({ condition: 'question', action: 'notify', idleMs: 60000 }))

  const leftovers = readdirSync(root).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])

  const reader = createWatchStore({ root, now: () => T0 })
  assert.deepEqual(reader.load(), { loaded: 1 })
  const [restored] = reader.all()
  assert.equal(restored.id, saved.id)
  assert.equal(restored.target, 'session-target')
  assert.equal(restored.watcher, 'session-watcher')
  assert.equal(restored.condition, 'question')
  assert.equal(restored.action, 'notify')
  assert.equal(restored.state, 'pending')
  assert.equal(restored.idleMs, 60000)
  assert.equal(restored.createdAt, saved.createdAt)
  assert.equal(restored.expiresAt, saved.expiresAt)
})

test('store：update 合并字段并补 endedAt，prune 只清 7 天前的终态', (t) => {
  const root = tempRoot(t)
  let clock = T0
  const store = createWatchStore({ root, now: () => clock })
  const fired = store.add(minimalWatch({ target: 'session-a' }))
  const canceled = store.add(minimalWatch({ target: 'session-b', condition: 'failed' }))

  assert.equal(store.update('watch-missing', { state: 'fired' }), undefined)

  const updated = store.update(fired.id, { state: 'fired', firedAt: '2026-11-12T20:00:05+08:00' })
  assert.equal(updated.state, 'fired')
  assert.equal(updated.firedAt, '2026-11-12T20:00:05+08:00')
  // 转终态没给 endedAt 时按注入时钟补，不能留空（prune 依赖它）。
  assert.equal(updated.endedAt, '2026-11-12T20:00:00+08:00')
  // id 不允许被 patch 掉。
  assert.equal(store.update(fired.id, { id: 'watch-other' }).id, fired.id)

  clock = T0 + 8 * DAY
  assert.equal(store.cancel(canceled.id), true)
  // 只有 8 天前结束的那条该走；刚取消的留下。
  assert.equal(store.prune(), 1)
  assert.deepEqual(
    store.all().map((watch) => watch.id),
    [canceled.id],
  )
  // prune 之后落盘的是清理过的版本。
  assert.equal(JSON.parse(readFileSync(watchesPath(root), 'utf8')).length, 1)
})

// ──────────────────────────── detector ────────────────────────────

test('detector：turn/end completed 产出 completed 命中', () => {
  const detector = createDetector({ now: () => T0 })
  const hit = detector.observe({
    sessionId: 'session-target',
    event: { type: 'turn/end', seq: 42, data: { reason: { kind: 'completed' } } },
    session: { lastAssistantText: '已补完第三章' },
    at: T0,
  })

  assert.equal(hit.kind, 'completed')
  assert.equal(hit.sessionId, 'session-target')
  assert.equal(hit.seq, 42)
  assert.equal(hit.text, '已补完第三章')
  assert.equal(hit.reason, 'completed')
  assert.equal(hit.at, T0)
})

test('detector：turn/end 缺 reason 视为 completed，缺 session 时 text 为空串', () => {
  const detector = createDetector({ now: () => T0 })
  const hit = detector.observe({
    sessionId: 'session-target',
    event: { type: 'turn/end', seq: 7, data: {} },
  })

  assert.equal(hit.kind, 'completed')
  assert.equal(hit.text, '')
  // 没传 at 时用注入时钟，不能是墙钟。
  assert.equal(hit.at, T0)
})

test('detector：turn/end 的 error / aborted / interrupted 都判 failed', () => {
  const detector = createDetector({ now: () => T0 })
  for (const reasonKind of ['error', 'aborted', 'interrupted']) {
    const hit = detector.observe({
      sessionId: 'session-target',
      event: { type: 'turn/end', seq: 9, data: { reason: { kind: reasonKind } } },
      at: T0,
    })
    assert.equal(hit.kind, 'failed', `reason.kind=${reasonKind} 应判 failed`)
    // 具体原因透传，至少不能是空的（不能压成一句模糊的「失败」）。
    assert.equal(typeof hit.reason, 'string')
    assert.ok(hit.reason.length > 0)
  }
})

test('detector：turn/end 正常结束但最后一条 assistant 无文本 → completed + reason=no-output', () => {
  const detector = createDetector({ now: () => T0 })
  const hit = detector.observe({
    sessionId: 'session-target',
    // 2026-11-13 派活中断的形态：轮次结束了，最后一步只发了工具调用。
    event: { type: 'turn/end', seq: 60, data: { reason: { kind: 'completed' } } },
    session: { lastAssistantText: '' },
    at: T0,
  })

  // kind 必须是 completed：订阅 completed 的一方不能因为「没文本」而漏收这一轮。
  assert.equal(hit.kind, 'completed')
  assert.equal(hit.reason, 'no-output')
  assert.equal(hit.text, '')
  assert.equal(hit.seq, 60)
})

test('detector：既失败又无文本时判 failed，不被 truncated 覆盖', () => {
  const detector = createDetector({ now: () => T0 })
  const hit = detector.observe({
    sessionId: 'session-target',
    event: { type: 'turn/end', seq: 462, data: { reason: { kind: 'error' } } },
    session: { lastAssistantText: '' },
    at: T0,
  })

  assert.equal(hit.kind, 'failed')
  assert.equal(hit.reason, 'error')
})

test('detector：没给 session 快照时不判 truncated（分不清没产出还是看不到产出）', () => {
  const detector = createDetector({ now: () => T0 })
  const hit = detector.observe({
    sessionId: 'session-target',
    event: { type: 'turn/end', seq: 8, data: { reason: { kind: 'completed' } } },
    at: T0,
  })

  assert.equal(hit.kind, 'completed')
  assert.equal(hit.reason, 'completed')
})

test('detector：tool/result 带 error 判 failed / tool-error', () => {
  const detector = createDetector({ now: () => T0 })
  const hit = detector.observe({
    sessionId: 'session-target',
    event: { type: 'tool/result', seq: 11, data: { error: { message: 'read boom' } } },
    at: T0,
  })

  assert.equal(hit.kind, 'failed')
  assert.equal(hit.reason, 'tool-error')
  assert.equal(hit.seq, 11)
  assert.equal(hit.text, 'read boom')
})

test('detector：无关事件与坏入参一律返回 null 且不抛', () => {
  const detector = createDetector({ now: () => T0 })
  const unrelated = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'turn/start', seq: 2, data: {} },
    // tool/result 没有 error：成功结果不该被当成命中。
    { type: 'tool/result', seq: 3, data: { result: 'ok' } },
    { type: 'tool/result', seq: 4, data: {} },
  ]
  for (const event of unrelated) {
    assert.equal(detector.observe({ sessionId: 'session-target', event, at: T0 }), null, event.type)
  }

  // 事件总线上什么都可能来：缺字段、缺 event 都不能把异常抛进宿主。
  assert.doesNotThrow(() => {
    assert.equal(detector.observe(undefined), null)
    assert.equal(detector.observe({}), null)
    assert.equal(detector.observe({ sessionId: 'session-target', event: null }), null)
    assert.equal(detector.observe({ event: { type: 'turn/end', seq: 1 }, at: T0 }), null)
  })
})

test('detector：尾部文本截到 240 字', () => {
  const detector = createDetector({ now: () => T0 })
  const hit = detector.observe({
    sessionId: 'session-target',
    event: { type: 'turn/end', seq: 5, data: { reason: { kind: 'completed' } } },
    session: { lastAssistantText: '字'.repeat(300) },
    at: T0,
  })
  assert.equal(hit.text.length, 240)
})

test('detector：tick 的 question 以 20 分钟为界（严格大于）', () => {
  const detector = createDetector({ now: () => T0 })

  const exactly = detector.tick({
    inspections: [{ sessionId: 'session-q', running: false, openQuestionSince: T0 - 20 * MINUTE }],
    at: T0,
  })
  assert.deepEqual(exactly, [])

  const over = detector.tick({
    inspections: [{ sessionId: 'session-q', running: false, openQuestionSince: T0 - 20 * MINUTE - 1 }],
    at: T0,
  })
  assert.equal(over.length, 1)
  assert.equal(over[0].kind, 'question')
  assert.equal(over[0].sessionId, 'session-q')
  assert.equal(over[0].at, T0)

  // 没有悬着的提问时不能凭空报 question。
  const none = detector.tick({ inspections: [{ sessionId: 'session-q', running: true }], at: T0 })
  assert.deepEqual(none, [])
})

test('detector：tick 的 stalled 以 15 分钟为界，且只判 running', () => {
  const detector = createDetector({ now: () => T0 })

  const exactly = detector.tick({
    inspections: [{ sessionId: 'session-s', running: true, lastEventAt: T0 - 15 * MINUTE }],
    at: T0,
  })
  assert.deepEqual(exactly, [])

  const over = detector.tick({
    inspections: [{ sessionId: 'session-s', running: true, lastEventAt: T0 - 15 * MINUTE - 1 }],
    at: T0,
  })
  assert.equal(over.length, 1)
  assert.equal(over[0].kind, 'stalled')
  assert.equal(over[0].sessionId, 'session-s')

  // idle 会话长时间没事件是正常状态，不是卡死。
  const idle = detector.tick({
    inspections: [{ sessionId: 'session-s', running: false, lastEventAt: T0 - DAY }],
    at: T0,
  })
  assert.deepEqual(idle, [])
})

test('detector：默认阈值仍是 20 / 15 分钟（不传 options 构造）', () => {
  assert.equal(QUESTION_MS, 20 * MINUTE)
  assert.equal(STALLED_MS, 15 * MINUTE)

  // 真正不传参：now 用墙钟，但 tick 一律显式传 at，判定不依赖真实时间。
  const detector = createDetector()
  const questionTick = (ago) =>
    detector.tick({
      inspections: [{ sessionId: 'session-q', running: false, openQuestionSince: T0 - ago }],
      at: T0,
    })
  // 边界语义是严格大于：恰好 20 分钟不命中，多 1ms 才命中。
  assert.deepEqual(questionTick(20 * MINUTE), [])
  assert.equal(questionTick(20 * MINUTE + 1).length, 1)
  assert.equal(questionTick(20 * MINUTE + 1)[0].kind, 'question')

  const stalledTick = (ago) =>
    detector.tick({
      inspections: [{ sessionId: 'session-s', running: true, lastEventAt: T0 - ago }],
      at: T0,
    })
  assert.deepEqual(stalledTick(15 * MINUTE), [])
  assert.equal(stalledTick(15 * MINUTE + 1).length, 1)
  assert.equal(stalledTick(15 * MINUTE + 1)[0].kind, 'stalled')
})

test('detector：自定义 questionMs 生效（19 分钟不命中、21 分钟命中）', () => {
  const detector = createDetector({ now: () => T0, questionMs: 20 * MINUTE })
  const questionTick = (ago) =>
    detector.tick({
      inspections: [{ sessionId: 'session-q', running: false, openQuestionSince: T0 - ago }],
      at: T0,
    })

  assert.deepEqual(questionTick(19 * MINUTE), [])
  const over = questionTick(21 * MINUTE)
  assert.equal(over.length, 1)
  assert.equal(over[0].kind, 'question')

  // 注入值不能是摆设：阈值调到 5 分钟后，19 分钟的提问必须命中。
  const tight = createDetector({ now: () => T0, questionMs: 5 * MINUTE })
  assert.equal(
    tight.tick({
      inspections: [{ sessionId: 'session-q', running: false, openQuestionSince: T0 - 19 * MINUTE }],
      at: T0,
    }).length,
    1,
  )
})

test('detector：自定义 stalledMs 生效（14 分钟不命中、16 分钟命中）', () => {
  const detector = createDetector({ now: () => T0, stalledMs: 15 * MINUTE })
  const stalledTick = (ago) =>
    detector.tick({
      inspections: [{ sessionId: 'session-s', running: true, lastEventAt: T0 - ago }],
      at: T0,
    })

  assert.deepEqual(stalledTick(14 * MINUTE), [])
  const over = stalledTick(16 * MINUTE)
  assert.equal(over.length, 1)
  assert.equal(over[0].kind, 'stalled')

  // 注入值不能是摆设：阈值调到 5 分钟后，14 分钟的静默必须命中。
  const tight = createDetector({ now: () => T0, stalledMs: 5 * MINUTE })
  assert.equal(
    tight.tick({
      inspections: [{ sessionId: 'session-s', running: true, lastEventAt: T0 - 14 * MINUTE }],
      at: T0,
    }).length,
    1,
  )
})

test('detector：非法 questionMs（0 / -1 / "abc"）回落默认 20 分钟', () => {
  for (const bad of [0, -1, 'abc']) {
    const detector = createDetector({ now: () => T0, questionMs: bad })
    const questionTick = (ago) =>
      detector.tick({
        inspections: [{ sessionId: 'session-q', running: false, openQuestionSince: T0 - ago }],
        at: T0,
      })
    const label = `questionMs=${String(bad)}`
    assert.deepEqual(questionTick(20 * MINUTE), [], `${label} 应回落 20 分钟：恰好 20 分钟不命中`)
    assert.equal(questionTick(20 * MINUTE + 1).length, 1, `${label} 应回落 20 分钟：越过 1ms 命中`)
  }
})

test('detector：tick 中 question 优先于 stalled，空列表返回空数组', () => {
  const detector = createDetector({ now: () => T0 })
  const hits = detector.tick({
    inspections: [
      { sessionId: 'session-both', running: true, lastEventAt: T0 - DAY, openQuestionSince: T0 - HOUR },
      { sessionId: 'session-quiet', running: false, lastEventAt: T0 },
    ],
    at: T0,
  })

  // 两条都成立时只报更具体、更可行动的那条，避免对同一会话发两条矛盾通知。
  assert.equal(hits.length, 1)
  assert.equal(hits[0].kind, 'question')

  assert.deepEqual(detector.tick({ inspections: [] }), [])
  assert.doesNotThrow(() => {
    assert.deepEqual(detector.tick(undefined), [])
    assert.deepEqual(detector.tick({ inspections: [null, { sessionId: '' }] }), [])
  })
})

// ────────────────────────────── gate ──────────────────────────────

test('gate：静默段 23:00–07:30 的毫秒边界', () => {
  const at = (iso) => Date.parse(iso)

  assert.equal(inQuietHours(at('2026-11-12T22:59:59.999+08:00')), false)
  assert.equal(inQuietHours(at('2026-11-12T23:00:00.000+08:00')), true)
  assert.equal(inQuietHours(at('2026-11-13T00:00:00.000+08:00')), true)
  assert.equal(inQuietHours(at('2026-11-13T03:00:00.000+08:00')), true)
  assert.equal(inQuietHours(at('2026-11-13T07:29:59.999+08:00')), true)
  assert.equal(inQuietHours(at('2026-11-13T07:30:00.000+08:00')), true)
  assert.equal(inQuietHours(at('2026-11-13T07:30:00.001+08:00')), false)
  assert.equal(inQuietHours(at('2026-11-13T12:00:00.000+08:00')), false)

  // 脏入参 fail-open：不能因为一次坏值把所有通知永久判成静默。
  assert.equal(inQuietHours(NaN), false)
  assert.equal(inQuietHours(undefined), false)
})

test('gate：自环守候直接拒绝', () => {
  const result = evaluateGate({
    requested: 'wake',
    now: T0,
    firedToday: 0,
    pendingCount: 0,
    watcherIsTarget: true,
  })
  assert.deepEqual(result, { allowed: false, effective: 'reject', reason: 'self-watch' })

  // 自环优先于一切降级：哪怕请求只是 record 也不能放过。
  assert.deepEqual(
    evaluateGate({ requested: 'record', now: T0, firedToday: 0, pendingCount: 0, watcherIsTarget: true }),
    { allowed: false, effective: 'reject', reason: 'self-watch' },
  )
})

test('gate：目标已消失降级为 record 且不接受登记', () => {
  const result = evaluateGate({
    requested: 'wake',
    now: T0,
    firedToday: 0,
    pendingCount: 0,
    watcherIsTarget: false,
    targetAlive: false,
  })
  assert.deepEqual(result, { allowed: false, effective: 'record', reason: 'target-gone' })
})

test('gate：静默段把 wake 与 notify 都压成 record，allowed 仍为 true', () => {
  const quietAt = Date.parse('2026-11-12T23:00:00+08:00')
  for (const requested of ['wake', 'notify']) {
    const result = evaluateGate({
      requested,
      now: quietAt,
      firedToday: 0,
      pendingCount: 0,
      watcherIsTarget: false,
    })
    assert.deepEqual(result, { allowed: true, effective: 'record', reason: 'quiet-hours' })
  }

  // 白天同一请求照常放行，证明降级确实只由时间触发。
  assert.deepEqual(
    evaluateGate({ requested: 'wake', now: T0, firedToday: 0, pendingCount: 0, watcherIsTarget: false }),
    { allowed: true, effective: 'wake', reason: 'allowed' },
  )
})

test('gate：wake 日预算超限降级 notify，用完那一次仍放行', () => {
  const justBelow = evaluateGate({
    requested: 'wake',
    now: T0,
    firedToday: DAILY_WAKE_LIMIT - 1,
    pendingCount: 0,
    watcherIsTarget: false,
  })
  assert.deepEqual(justBelow, { allowed: true, effective: 'wake', reason: 'allowed' })

  const exhausted = evaluateGate({
    requested: 'wake',
    now: T0,
    firedToday: DAILY_WAKE_LIMIT,
    pendingCount: 0,
    watcherIsTarget: false,
  })
  assert.deepEqual(exhausted, { allowed: true, effective: 'notify', reason: 'wake-budget' })

  // 预算只压 wake：notify 本来就不拉新轮次，不应被降级。
  assert.deepEqual(
    evaluateGate({ requested: 'notify', now: T0, firedToday: DAILY_WAKE_LIMIT * 3, pendingCount: 0, watcherIsTarget: false }),
    { allowed: true, effective: 'notify', reason: 'allowed' },
  )
})

test('gate：pending 达到上限即拒收', () => {
  const full = evaluateGate({
    requested: 'notify',
    now: T0,
    firedToday: 0,
    pendingCount: MAX_PENDING,
    watcherIsTarget: false,
  })
  assert.deepEqual(full, { allowed: false, effective: 'reject', reason: 'too-many-pending' })

  const oneLeft = evaluateGate({
    requested: 'notify',
    now: T0,
    firedToday: 0,
    pendingCount: MAX_PENDING - 1,
    watcherIsTarget: false,
  })
  assert.deepEqual(oneLeft, { allowed: true, effective: 'notify', reason: 'allowed' })
})

test('gate：record 请求直接放行，越过队列与预算', () => {
  const result = evaluateGate({
    requested: 'record',
    now: Date.parse('2026-11-13T03:00:00+08:00'),
    firedToday: DAILY_WAKE_LIMIT * 5,
    pendingCount: MAX_PENDING * 2,
    watcherIsTarget: false,
  })
  assert.deepEqual(result, { allowed: true, effective: 'record', reason: 'record-requested' })
})
