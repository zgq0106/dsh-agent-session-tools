/**
 * watch-gate — 跨会话守候的「闸门」：决定一次命中之后到底能做什么。
 *
 * 为什么要单独一层闸门：守候命中会拉起别的会话（wake 是最贵的动作），而命中
 * 恰恰是自动化最容易失控的地方——一个循环里的会话可能一秒命中几十次。所以把
 * 「要不要真的动手」从「判定命中了没有」里剥出来，单独纯函数化：
 *   - 纯函数不碰盘、不碰 ctx，测试可以直接喂时间戳与计数；
 *   - 三个模块互不 import（见契约 §0），本文件只依赖自身常量；
 *   - 时间判定固定按 +08:00 换算，不依赖宿主时区——插件跑在任何机器上，
 *     静默时段都必须以主人所在时区为准，否则换个时区的机器就整晚乱叫。
 */

/** 每天允许 wake 的次数上限。超出后降级为 notify：仍然通知，但不再拉新轮次（wake 贵）。 */
export const DAILY_WAKE_LIMIT = 10

/** 同时挂着的 pending 守候上限。超过就拒绝登记：防止一个出错的循环把 watches.json 撑爆。 */
export const MAX_PENDING = 20

/** Asia/Shanghai 固定偏移（毫秒）。不用 Intl/时区库：+08:00 无夏令时，固定值最稳。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

const MS_PER_MINUTE = 60 * 1000

/** 静默段起点 23:00.000（含），终点 07:30.000（含）。用「当日毫秒偏移」表示，便于比较。 */
const QUIET_START_MS = 23 * 60 * MS_PER_MINUTE
const QUIET_END_MS = 7 * 60 * MS_PER_MINUTE + 30 * MS_PER_MINUTE

/** 合法动作集合。用于把调用方传进来的脏值收敛回三选一（见 normalizeRequested）。 */
const ACTIONS = ['wake', 'notify', 'record']

/**
 * 判断某个时间点是否落在静默时段（23:00–07:30，Asia/Shanghai，起止两端都算在内）。
 *
 * 为什么用「把时间往前拨 8 小时再读 UTC 字段」：这样得到的时分秒就是东八区的墙上时间，
 * 与宿主时区、DST 配置完全无关，也不需要 Intl 的时区数据库。
 *
 * 边界处理：精确到毫秒，起止两端都含——23:00:00.000 判真，07:30:00.000 判真，
 * 07:30:00.001 起判假。宁可多压一瞬，也不要在一分钟内两可。
 *
 * @param {number} epochMs 目标时间点，epoch 毫秒（如 Date.now() 的返回值）。
 * @returns {boolean} 落在静默时段返回 true；非法入参按「非静默」处理（见下）。
 */
export function inQuietHours(epochMs) {
  const value = Number(epochMs)
  // 入参不可用时选择 fail-open：静默判定只该压掉打扰，不该因为一次脏入参把
  // 所有通知永久判成静默。真正的「要不要打扰」还有预算与目标存活两道闸。
  if (!Number.isFinite(value)) return false

  const shifted = new Date(value + SHANGHAI_OFFSET_MS)
  const msOfDay =
    shifted.getUTCHours() * 60 * MS_PER_MINUTE +
    shifted.getUTCMinutes() * MS_PER_MINUTE +
    shifted.getUTCSeconds() * 1000 +
    shifted.getUTCMilliseconds()
  // 静默段跨零点：一段在当天尾部 [23:00, 24:00)，一段在当天头部 [00:00, 07:30]。
  return msOfDay >= QUIET_START_MS || msOfDay <= QUIET_END_MS
}

/**
 * 把请求动作收敛到合法集合。
 * 非法值回落 notify 而不是 wake：脏输入下宁可少花钱，也不让闸门自己去拉起会话。
 *
 * @param {unknown} requested 调用方请求的动作。
 * @returns {'wake'|'notify'|'record'} 合法动作之一。
 */
function normalizeRequested(requested) {
  return ACTIONS.includes(requested) ? requested : 'notify'
}

/**
 * 把计数类入参收敛为非负整数；不可用时按 0 处理（fail-open，不因缺字段就拒绝一切）。
 *
 * @param {unknown} value 原始计数。
 * @returns {number} 非负整数。
 */
function normalizeCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.trunc(n)
}

/**
 * 闸门求值：给定「想做什么」+ 当前上下文，返回「实际允许做什么」。
 *
 * 规则严格按契约 §3 的顺序求值，先命中先返回——顺序本身是语义的一部分：
 *   1. 自守候（watcher 就是 target）→ 拒绝。自己等自己会成环，必然空转。
 *   2. 目标已不在（targetAlive === false）→ 拒绝登记。等一个不存在的会话永远等不到。
 *   3. 请求 record → 直接放行。只记录不打扰，没有任何理由拦。
 *   4. 静默时段 → 降级 record。夜里不叫醒任何人。
 *   5. wake 超日预算 → 降级 notify。仍让主人知道，只是不再拉新轮次。
 *   6. pending 已满 → 拒绝登记。队列保护。
 *   7. 其余 → 放行请求的动作。
 *
 * 语义要点：`allowed: false` 只表示「这次登记不接受」，用于规则 1/2/6；被降级的场景
 * （4/5）`allowed` 仍为 true——降级是「换个轻一点的动作照做」，不是拒绝。
 *
 * @param {{
 *   requested: 'wake'|'notify'|'record',
 *   now: number,
 *   firedToday: number,
 *   pendingCount: number,
 *   watcherIsTarget: boolean,
 *   targetAlive?: boolean,
 * }} input 闸门输入。
 *   - requested：调用方想做的动作；
 *   - now：判定时刻（epoch ms），静默段以它为准；
 *   - firedToday：今天已经 wake 过几次；
 *   - pendingCount：当前 pending 守候条数；
 *   - watcherIsTarget：守候方与被守候方是否同一个会话；
 *   - targetAlive：目标是否还在，缺省视为在（未观测不等于已消失）。
 * @returns {{ allowed: boolean, effective: 'wake'|'notify'|'record'|'reject', reason: string }}
 *   allowed 为是否接受本次登记；effective 为实际生效的动作（reject 表示不登记）；
 *   reason 为命中原因，便于写进日志与工具返回值。
 */
export function evaluateGate(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const requested = normalizeRequested(source.requested)
  const firedToday = normalizeCount(source.firedToday)
  const pendingCount = normalizeCount(source.pendingCount)

  // 规则 1：自守候成环，必拒。放在最前，因为后面任何降级都救不了一个环。
  if (source.watcherIsTarget === true) {
    return { allowed: false, effective: 'reject', reason: 'self-watch' }
  }

  // 规则 2：目标已消失。严格判 === false：缺省/未观测一律当作还活着，
  // 否则一次读不到状态就会把整批守候判死。
  if (source.targetAlive === false) {
    return { allowed: false, effective: 'record', reason: 'target-gone' }
  }

  // 规则 3：本来就只要 record，没有任何拦截理由。
  if (requested === 'record') {
    return { allowed: true, effective: 'record', reason: 'record-requested' }
  }

  // 规则 4：静默时段一律降级为 record。不做「wake 降 notify」的进一步区分：
  // 夜里连一条消息都不该插进去，只为事后留痕。
  if (inQuietHours(source.now)) {
    return { allowed: true, effective: 'record', reason: 'quiet-hours' }
  }

  // 规则 5：日预算用完。只对 wake 生效——notify 不拉新轮次，让它继续走。
  // 边界取 >=：第 DAILY_WAKE_LIMIT + 1 次就会被降级，恰好用完上限的那次仍放行。
  if (requested === 'wake' && firedToday >= DAILY_WAKE_LIMIT) {
    return { allowed: true, effective: 'notify', reason: 'wake-budget' }
  }

  // 规则 6：登记队列已满，拒收新守候。同样取 >=，满额即不再收。
  if (pendingCount >= MAX_PENDING) {
    return { allowed: false, effective: 'reject', reason: 'too-many-pending' }
  }

  // 规则 7：全部通过，按请求执行。
  return { allowed: true, effective: requested, reason: 'allowed' }
}
