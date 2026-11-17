/**
 * 观测层（M4）回归测试：命中的三个结局与统计口径。
 *
 * 为什么这层必须有测试：它是「这套守候值不值得留」的唯一依据。
 * 判据一旦写错，会给出方向相反的建议——比如把「判早了」记成「确认」，
 * 于是继续按错的判定唤醒别人，账上还全是好评。
 *
 * 时间全部用注入时钟伪造，不碰真机 `~/.dsh`。
 *
 * 运行：node --test-isolation=none --test test/telemetry.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { ACK_WINDOW_MS, PREMATURE_WINDOW_MS, createTelemetry } from '../src/watch-telemetry.js'

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

/** 白天基准：2026-11-12 20:00 +08:00，避开静默段与跨日分桶。 */
const T0 = Date.parse('2026-11-12T20:00:00+08:00')

/**
 * 建一个可控时钟的账本。
 * @param {number} [start] 初始时刻
 * @returns {{ telemetry: object, root: string, set: (ms: number) => void }}
 */
function makeTelemetry(start = T0) {
  const root = mkdtempSync(join(tmpdir(), 'session-control-telemetry-'))
  createdDirs.push(root)
  let clock = start
  const telemetry = createTelemetry({ root, now: () => clock })
  telemetry.load()
  return {
    telemetry,
    root,
    set(ms) {
      clock = ms
    },
  }
}

/** 记一条 wake 命中，返回入账记录。 */
function fireWake(telemetry, overrides = {}) {
  return telemetry.record({
    watchId: overrides.watchId ?? 'watch-aaaaaaaa',
    target: overrides.target ?? 's-target',
    watcher: overrides.watcher ?? 's-watcher',
    condition: overrides.condition ?? 'completed',
    requested: overrides.requested ?? 'wake',
    effective: overrides.effective ?? 'wake',
    degraded: overrides.degraded ?? '',
    eventAt: overrides.eventAt ?? T0 - 1000,
  })
}

test('record：wake 记 pending，record 动作直接记 recorded', () => {
  const { telemetry } = makeTelemetry()
  const wake = fireWake(telemetry)
  assert.equal(wake.outcome, 'pending', 'wake 要等应答判定，初值是 pending')
  assert.equal(wake.latencyMs, 1000, '延迟取「条件事件 → 投递」的差')

  const recordOnly = fireWake(telemetry, { watchId: 'watch-bbbbbbbb', effective: 'record', requested: 'record' })
  assert.equal(recordOnly.outcome, 'recorded', 'record 动作没打扰任何人，没有应答可言')
})

test('confirmed：守候方在 10 分钟内有事件', () => {
  const { telemetry, set } = makeTelemetry()
  fireWake(telemetry)
  set(T0 + 2 * 60 * 1000)
  const settled = telemetry.noteWatcherActivity('s-watcher', T0 + 2 * 60 * 1000)
  assert.equal(settled.length, 1, '窗口内应判为确认')
  assert.equal(settled[0].outcome, 'confirmed')
  assert.equal(settled[0].ackAfterMs, 2 * 60 * 1000)
})

test('confirmed 反例：超过 10 分钟才动，不算被叫起来', () => {
  const { telemetry } = makeTelemetry()
  fireWake(telemetry)
  const settled = telemetry.noteWatcherActivity('s-watcher', T0 + ACK_WINDOW_MS + 1000)
  assert.equal(settled.length, 0)
  assert.equal(telemetry.outcomeOf('watch-aaaaaaaa'), 'pending')
})

test('confirmed 反例：目标会话自己动不算守候方被叫起来', () => {
  const { telemetry } = makeTelemetry()
  fireWake(telemetry)
  const settled = telemetry.noteWatcherActivity('s-target', T0 + 1000)
  assert.equal(settled.length, 0, '只有守候方的事件才算确认')
})

test('confirmed 反例：record 动作没投递过，守候方干活不算「叫起」', () => {
  const { telemetry } = makeTelemetry()
  fireWake(telemetry, { watchId: 'watch-cccccccc', effective: 'record', requested: 'record' })
  telemetry.noteWatcherActivity('s-watcher', T0 + 1000)
  const stats = telemetry.stats(T0 + 1000)
  assert.equal(stats.acknowledged, 0, 'record 动作没有投递，不该出现「叫起」')
  assert.equal(stats.recorded, 1)
})

test('历史坏记录（record 账带 confirmedAt、degraded=record-requested）不进叫起与降级', () => {
  const { telemetry, root } = makeTelemetry()
  // 直接写一份旧版本留下的脏账：修复前 record 动作会被记上 confirmedAt 与 record-requested。
  writeFileSync(
    join(root, 'telemetry.json'),
    JSON.stringify({
      version: 1,
      records: [
        {
          watchId: 'watch-dddddddd',
          target: 's-target',
          watcher: 's-watcher',
          condition: 'idle',
          requested: 'record',
          effective: 'record',
          degraded: 'record-requested',
          firedAt: '2026-11-12T21:09:13+08:00',
          firedMs: T0,
          eventAt: T0,
          latencyMs: 0,
          outcome: 'recorded',
          confirmedAt: '2026-11-12T21:09:34+08:00',
          ackAfterMs: 20671,
        },
      ],
    }),
    'utf8',
  )
  telemetry.load()
  const stats = telemetry.stats(T0 + 1000)
  assert.equal(stats.recorded, 1)
  assert.equal(stats.acknowledged, 0, '历史脏账不得继续污染叫起')
  assert.equal(stats.degraded, 0, 'record-requested 不是降级')
})

test('premature：completed 命中后 5 分钟内目标又收一轮 → 判早了', () => {
  const { telemetry } = makeTelemetry()
  fireWake(telemetry)
  const settled = telemetry.noteTargetTurnEnd('s-target', T0 + 90 * 1000)
  assert.equal(settled.length, 1)
  assert.equal(settled[0].outcome, 'premature')
})

test('premature 反例：超过 5 分钟才收下一轮 → 不算判早（那是下一件事）', () => {
  const { telemetry } = makeTelemetry()
  fireWake(telemetry)
  const settled = telemetry.noteTargetTurnEnd('s-target', T0 + PREMATURE_WINDOW_MS + 1000)
  assert.equal(settled.length, 0)
})

test('premature 不被后到的 confirmed 覆盖：判早了才是真问题', () => {
  const { telemetry } = makeTelemetry()
  fireWake(telemetry)
  telemetry.noteTargetTurnEnd('s-target', T0 + 90 * 1000)
  const afterActivity = telemetry.noteWatcherActivity('s-watcher', T0 + 120 * 1000)
  assert.equal(afterActivity.length, 0, '已判 premature 的记录不再接受 confirmed')
  assert.equal(telemetry.outcomeOf('watch-aaaaaaaa'), 'premature')
})

test('unanswered：窗口到期仍无应答 → 空炮', () => {
  const { telemetry, set } = makeTelemetry()
  fireWake(telemetry)
  const window = Math.max(ACK_WINDOW_MS, PREMATURE_WINDOW_MS)
  set(T0 + window + 1000)
  telemetry.expireDue(T0 + window + 1000)
  assert.equal(telemetry.outcomeOf('watch-aaaaaaaa'), 'unanswered')
})

test('unanswered 反例：窗口内不提前收口', () => {
  const { telemetry } = makeTelemetry()
  fireWake(telemetry)
  telemetry.expireDue(T0 + 60 * 1000)
  assert.equal(telemetry.outcomeOf('watch-aaaaaaaa'), 'pending')
})

test('stats：按结局计数、降级次数、平均延迟、按天分桶', () => {
  const { telemetry, set } = makeTelemetry()
  fireWake(telemetry, { watchId: 'watch-1', eventAt: T0 - 3000 })
  fireWake(telemetry, { watchId: 'watch-2', eventAt: T0 - 1000 })
  fireWake(telemetry, { watchId: 'watch-3', effective: 'record', requested: 'record' })
  fireWake(telemetry, {
    watchId: 'watch-4',
    effective: 'record',
    requested: 'wake',
    degraded: 'quiet-hours',
  })

  set(T0 + 1000)
  telemetry.noteWatcherActivity('s-watcher', T0 + 1000) // 前两条一起判 confirmed
  const stats = telemetry.stats(T0 + 1000)

  assert.equal(stats.total, 4)
  assert.equal(stats.confirmed, 2, '两条 wake 在窗口内被确认')
  assert.equal(stats.recorded, 2, '两条 record 动作不计入应答口径')
  assert.equal(stats.degraded, 1, '被闸门降级的那条要单独计数')
  assert.equal(stats.avgLatencyMs, 2000, '只算真正投递的两条：(3000+1000)/2')
  assert.equal(stats.days.length, 1)
  assert.equal(stats.days[0].date, '2026-11-12')
  assert.equal(stats.days[0].fired, 4)
  assert.equal(stats.days[0].confirmed, 2)
})

test('持久化：落盘后重新载入，结局仍在；坏文件从空开始不抛', () => {
  const { telemetry, root } = makeTelemetry()
  fireWake(telemetry)
  telemetry.noteTargetTurnEnd('s-target', T0 + 60 * 1000)

  const reloaded = createTelemetry({ root, now: () => T0 })
  const loaded = reloaded.load()
  assert.equal(loaded.loaded, 1)
  assert.equal(reloaded.outcomeOf('watch-aaaaaaaa'), 'premature', '结局必须跨进程可读')

  writeFileSync(join(root, 'telemetry.json'), '{ 这不是 JSON', 'utf8')
  const broken = createTelemetry({ root, now: () => T0 })
  const result = broken.load()
  assert.equal(result.corrupt, true)
  assert.equal(broken.all().length, 0)
})

test('文件就是可读的 JSON：字段名不许漂', () => {
  const { telemetry, root } = makeTelemetry()
  fireWake(telemetry)
  const parsed = JSON.parse(readFileSync(join(root, 'telemetry.json'), 'utf8'))
  assert.equal(parsed.version, 1)
  assert.equal(Array.isArray(parsed.records), true)
  assert.equal(parsed.records[0].watchId, 'watch-aaaaaaaa')
  assert.equal(parsed.records[0].effective, 'wake')
})
