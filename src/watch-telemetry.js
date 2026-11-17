/**
 * watch-telemetry — 守候命中的**效果账**（M4）。
 *
 * 为什么必须有这一层：守候会拉起别的会话，一次 wake 约 2.8 万字符。没有账，
 * 只能凭印象说「挺准的」或「好像乱叫」——这两种说法都不能拿来做取舍。
 *
 * ## 三个判据（都不靠模型自评，全部由事件与时间算出来）
 *
 * - **确认（confirmed）**：wake / notify 投递后 `ACK_WINDOW_MS` 内，**守候方**出现任意
 *   `session/event`。含义是「这条通知确实把人叫起来了」。
 * - **空炮（unanswered）**：窗口到期而守候方毫无动静。含义是「白叫一次」——
 *   可能是守候方自己还在跑（消息排进队列没被消费），也可能是这条通知根本没用。
 * - **误报（premature）**：`completed` / `idle` 命中后 `PREMATURE_WINDOW_MS` 内，
 *   **目标会话**又冒出一个 `turn/end`。含义是「判早了」——活还没干完就报了完成。
 *
 * 判据的边界刻意写死在这里而不是留给调用方：三个窗口是同一套口径，改一处就该改一份文档。
 *
 * ## 为什么确认用「守候方有事件」当代理
 *
 * 真判据是「守候方读完通知后做出了正确决定」，那要读它下一轮的内容再做语义判断——
 * 那属于 cyber-butler 的活，放这里会变成第二套价值判定（计划 §7 明确只在一处判级）。
 * 「有没有动」是能自动算出来的最强信号，也够回答「这套守候值不值得留」。
 *
 * ## 存储
 *
 * `<root>/telemetry.json`，全量重写、原子替换。记录上限 `MAX_RECORDS`，
 * 超出丢最旧的：这是账本不是审计日志，留着上个月的每一次命中也算不出新结论。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 投递后多久内守候方有动静，算「叫起来了」。 */
export const ACK_WINDOW_MS = 10 * 60 * 1000

/** `completed` / `idle` 命中后多久内目标又收一轮，算判早了。 */
export const PREMATURE_WINDOW_MS = 5 * 60 * 1000

/** 结局全集。`pending` 只存在于窗口内，窗口一过就会被 expireDue 收口。 */
export const OUTCOMES = ['pending', 'confirmed', 'unanswered', 'premature', 'recorded', 'failed']

/**
 * 真正算「降级」的闸门原因。
 * `record-requested`（调用方本来就只要 record）与 `allowed`（原样放行）都不算——
 * 把它们记进降级，统计里会凭空长出不存在的问题。旧版本写坏的历史记录也靠这道过滤兜住。
 */
const DEGRADE_REASONS = new Set(['quiet-hours', 'wake-budget'])

/** 账本上限：超过就丢最旧的，避免一个失控循环把文件撑大。 */
const MAX_RECORDS = 500

const FILE_NAME = 'telemetry.json'
const TMP_SUFFIX = '.tmp'
/** 精确到秒的日期分桶只用于「连续几天」的对比，7 天足够看出趋势。 */
const DAYS_KEPT = 7
const OFFSET_MS = 8 * 60 * 60 * 1000

function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * epoch 毫秒 → ISO（固定 +08:00）。与 watch-store 同口径：不查系统时区，换机器输出一致。
 * @param {number} epochMs epoch 毫秒
 * @returns {string}
 */
function isoFromEpoch(epochMs) {
  const shifted = new Date(epochMs + OFFSET_MS)
  return (
    `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}` +
    `T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}+08:00`
  )
}

/** epoch 毫秒 → 东八区日期（YYYY-MM-DD），用于按天分桶。 */
function dateOf(epochMs) {
  return isoFromEpoch(epochMs).slice(0, 10)
}

/** ISO 或 epoch → epoch；解析不出来返 undefined，绝不拿坏值算窗口。 */
function epochOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value === '') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * 创建账本实例。
 *
 * 全部方法同步：调用点是事件处理器与工具执行体，异步会引入竞态。
 * 任何落盘失败都只影响统计，不影响守候本身——所以 flush 返回布尔而不抛。
 *
 * @param {{ root: string, now?: () => number }} options `root` 为存储根目录；
 *   `now` 为注入时钟（epoch 毫秒），默认 `Date.now`
 * @returns {{
 *   load: () => { loaded: number, corrupt?: boolean },
 *   record: (entry: object) => object | undefined,
 *   settle: (watchId: string, outcome: string, extra?: object) => object | undefined,
 *   noteWatcherActivity: (sessionId: string, at: number) => object[],
 *   noteTargetTurnEnd: (sessionId: string, at: number) => object[],
 *   expireDue: (at: number) => number,
 *   outcomeOf: (watchId: string) => string | undefined,
 *   all: () => object[],
 *   stats: (at?: number) => object,
 *   flush: () => boolean,
 * }}
 */
export function createTelemetry(options) {
  const root = options === null || typeof options !== 'object' ? undefined : options.root
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('createTelemetry 需要 { root }（存储根目录）。')
  }
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const file = join(root, FILE_NAME)

  /** @type {object[]} 按发生顺序；末尾最新。 */
  let records = []

  function nowMs() {
    let value
    try {
      value = Number(clock())
    } catch {
      return Date.now()
    }
    return Number.isFinite(value) ? value : Date.now()
  }

  /** 深拷贝：对外只给副本，避免调用方改到内存态却不落盘。 */
  function clone(entry) {
    return typeof structuredClone === 'function' ? structuredClone(entry) : JSON.parse(JSON.stringify(entry))
  }

  /**
   * 读盘恢复。文件不存在或损坏都从空开始：账本丢了不该影响守候，
   * 更不该让插件起不来。返回 `{ loaded, corrupt }` 只为让接线层打一行日志。
   * @returns {{ loaded: number, corrupt?: boolean }}
   */
  function load() {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      records = []
      return { loaded: 0 }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      records = []
      return { loaded: 0, corrupt: true }
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : null
    if (list === null) {
      records = []
      return { loaded: 0, corrupt: true }
    }
    records = list.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.watchId === 'string')
    if (records.length > MAX_RECORDS) records = records.slice(records.length - MAX_RECORDS)
    return { loaded: records.length }
  }

  /**
   * 原子落盘。写失败只返回 false：统计不是关键路径，磁盘满也不该让命中失败。
   * @returns {boolean}
   */
  function flush() {
    const tmp = `${file}${TMP_SUFFIX}`
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(tmp, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
      return true
    } catch {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* 临时文件删不掉只是脏一个文件 */
      }
      return false
    }
  }

  /**
   * 记一次命中。
   *
   * `outcome` 的初值：`record` 动作不打扰任何人，直接记成 recorded（没有应答可言）；
   * wake / notify 记成 pending，等 window 内的事件或 expireDue 收口。
   *
   * @param {object} entry 至少含 watchId / target / watcher / condition / effective
   * @returns {object | undefined} 已入账的记录副本
   */
  function record(entry) {
    if (entry === null || typeof entry !== 'object') return undefined
    if (typeof entry.watchId !== 'string' || entry.watchId === '') return undefined
    const at = nowMs()
    const effective = typeof entry.effective === 'string' ? entry.effective : 'record'
    const firesDeliverable = effective === 'wake' || effective === 'notify'
    const row = {
      watchId: entry.watchId,
      target: typeof entry.target === 'string' ? entry.target : '',
      watcher: typeof entry.watcher === 'string' ? entry.watcher : '',
      condition: typeof entry.condition === 'string' ? entry.condition : '',
      requested: typeof entry.requested === 'string' ? entry.requested : effective,
      effective,
      degraded: typeof entry.degraded === 'string' ? entry.degraded : '',
      firedAt: isoFromEpoch(at),
      firedMs: at,
      // 延迟取「条件事件的真实时刻 → 投递时刻」：completed 里含静默窗口，
      // 用 hit.at（判定时刻）会让延迟永远接近 0，量不出真东西。
      eventAt: typeof entry.eventAt === 'number' && Number.isFinite(entry.eventAt) ? entry.eventAt : at,
      latencyMs: 0,
      outcome: firesDeliverable ? 'pending' : 'recorded',
      settledAt: firesDeliverable ? '' : isoFromEpoch(at),
    }
    row.latencyMs = Math.max(0, at - row.eventAt)
    records.push(row)
    if (records.length > MAX_RECORDS) records = records.slice(records.length - MAX_RECORDS)
    flush()
    return clone(row)
  }

  /** 找某条 watch 最近一条尚未收口的账（一条 watch 命中一次是常态，取最后一条即可）。 */
  function latestOf(watchId) {
    for (let i = records.length - 1; i >= 0; i -= 1) {
      if (records[i].watchId === watchId) return records[i]
    }
    return undefined
  }

  /**
   * 定结局。已判为 `premature` 的记录不会被后到的 `confirmed` 覆盖：
   * 判早了才是真问题，「守候方动了」只是次要信息。
   * @param {string} watchId watch id
   * @param {string} outcome 目标结局
   * @param {object} [extra] 附带字段（如 ackAt / note）
   * @returns {object | undefined}
   */
  function settle(watchId, outcome, extra) {
    const row = latestOf(String(watchId))
    if (row === undefined) return undefined
    if (!OUTCOMES.includes(outcome)) return clone(row)
    if (row.outcome === 'premature' && outcome !== 'premature') return clone(row)
    row.outcome = outcome
    row.settledAt = isoFromEpoch(nowMs())
    if (extra !== null && typeof extra === 'object') {
      for (const [key, value] of Object.entries(extra)) {
        if (key === 'outcome' || key === 'watchId') continue
        row[key] = value
      }
    }
    flush()
    return clone(row)
  }

  /**
   * 守候方有事件 → 把窗口内为它挂着的 pending 账判成 confirmed。
   * @param {string} sessionId 出现事件的那个会话
   * @param {number} at 事件时刻
   * @returns {object[]} 被改判的记录
   */
  function noteWatcherActivity(sessionId, at) {
    const settled = []
    let changed = false
    for (const row of records) {
      // `record` 动作没有投递过任何消息，「守候方有事件」与它无关。
      // 不排掉它，单是守候方自己正常干活就会被记成「叫起成功」——2026-11-12 实测踩到。
      if (row.effective === 'record') continue
      if (row.watcher !== sessionId) continue
      if (at - row.firedMs > ACK_WINDOW_MS) continue
      // `confirmedAt` 一旦写上就保留：后来目标又收一轮会把结局改成 premature，
      // 但「这次唤醒确实把人叫起来了」是既成事实，不能跟着一起消失。
      if (typeof row.confirmedAt !== 'string' || row.confirmedAt === '') {
        row.confirmedAt = isoFromEpoch(at)
        row.ackAfterMs = Math.max(0, at - row.firedMs)
        changed = true
      }
      if (row.outcome !== 'pending') continue
      row.outcome = 'confirmed'
      row.settledAt = isoFromEpoch(at)
      settled.push(row)
      changed = true
    }
    if (changed) flush()
    return settled.map(clone)
  }

  /**
   * 目标又收一轮 → 窗口内的 completed / idle 命中改判 premature。
   * @param {string} sessionId 目标会话
   * @param {number} at 事件时刻
   * @returns {object[]} 被改判的记录
   */
  function noteTargetTurnEnd(sessionId, at) {
    const settled = []
    for (const row of records) {
      if (row.outcome === 'premature') continue
      if (row.target !== sessionId) continue
      if (row.condition !== 'completed' && row.condition !== 'idle') continue
      if (row.effective === 'record') continue
      if (at - row.firedMs > PREMATURE_WINDOW_MS) continue
      row.outcome = 'premature'
      row.settledAt = isoFromEpoch(at)
      settled.push(row)
    }
    if (settled.length > 0) flush()
    return settled.map(clone)
  }

  /**
   * 收口到期未应答的账。窗口取两个窗口的较大者：
   * 误报窗口还没过就判「空炮」，会让一条后来被证明是误报的记录先被记成空炮。
   * @param {number} at 当前时刻
   * @returns {number} 改判条数
   */
  function expireDue(at) {
    const window = Math.max(ACK_WINDOW_MS, PREMATURE_WINDOW_MS)
    let changed = 0
    for (const row of records) {
      if (row.outcome !== 'pending') continue
      if (at - row.firedMs <= window) continue
      row.outcome = 'unanswered'
      row.settledAt = isoFromEpoch(at)
      changed += 1
    }
    if (changed > 0) flush()
    return changed
  }

  /** 某条 watch 最近一次的结局；没有账返回 undefined。 */
  function outcomeOf(watchId) {
    return latestOf(String(watchId))?.outcome
  }

  function all() {
    return records.map(clone)
  }

  /**
   * 汇总。`days` 只保留最近 `DAYS_KEPT` 天，按日期升序——「连续 3 天」的比较要靠它。
   * 平均延迟只算真正投递过的（record 动作没投递，混进去会把它压低）。
   *
   * @param {number} [at] 参考时刻，默认 `now()`
   * @returns {{
   *   total: number, pending: number, confirmed: number, unanswered: number,
   *   premature: number, recorded: number, failed: number, degraded: number,
   *   avgLatencyMs: number,
   *   days: Array<{ date: string, fired: number, confirmed: number, unanswered: number, premature: number, recorded: number }>,
   * }}
   */
  function stats(at) {
    const now = Number.isFinite(at) ? at : nowMs()
    const out = {
      total: records.length,
      pending: 0,
      confirmed: 0,
      acknowledged: 0,
      unanswered: 0,
      premature: 0,
      recorded: 0,
      failed: 0,
      degraded: 0,
      avgLatencyMs: 0,
      days: [],
    }
    const today = dateOf(now)
    const floor = dateOf(now - (DAYS_KEPT - 1) * 24 * 60 * 60 * 1000)
    const byDay = new Map()
    let latencySum = 0
    let latencyCount = 0
    for (const row of records) {
      if (typeof out[row.outcome] === 'number') out[row.outcome] += 1
      // 两条口径都带 `effective !== 'record'`：record 动作没有投递，既无「叫起」也无「降级」。
      // 这一层是双保险——写入时已经不再给 record 账打 confirmedAt，但历史坏记录仍存在。
      if (row.effective !== 'record' && typeof row.confirmedAt === 'string' && row.confirmedAt !== '') {
        out.acknowledged += 1
      }
      if (DEGRADE_REASONS.has(row.degraded)) out.degraded += 1
      if (row.effective === 'wake' || row.effective === 'notify') {
        latencySum += Number.isFinite(row.latencyMs) ? row.latencyMs : 0
        latencyCount += 1
      }
      const date = typeof row.firedAt === 'string' ? row.firedAt.slice(0, 10) : ''
      if (date === '' || date < floor || date > today) continue
      if (!byDay.has(date)) {
        byDay.set(date, { date, fired: 0, confirmed: 0, unanswered: 0, premature: 0, recorded: 0 })
      }
      const day = byDay.get(date)
      day.fired += 1
      if (row.outcome === 'confirmed' || row.outcome === 'unanswered' || row.outcome === 'premature' || row.outcome === 'recorded') {
        day[row.outcome] += 1
      }
    }
    out.avgLatencyMs = latencyCount === 0 ? 0 : Math.round(latencySum / latencyCount)
    out.days = Array.from(byDay.values()).sort((left, right) => (left.date < right.date ? -1 : 1))
    return out
  }

  return { load, record, settle, noteWatcherActivity, noteTargetTurnEnd, expireDue, outcomeOf, all, stats, flush }
}
