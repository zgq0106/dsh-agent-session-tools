/**
 * Session Control — 守候（watch）的持久化与内存状态层。
 *
 * 为什么单独一层：`index.js` 的事件处理器每收到一条 `session/event` 都要问一句
 * 「有没有人在等这个会话」。这个判断必须是内存查表，不能读盘——事件是高频的，
 * 一次读盘就够拖慢整条总线；而「登记 / 取消 / 命中」是低频动作，才值得落盘一次。
 * 所以状态常驻内存，只在变更时原子写回。
 *
 * 四条设计底线：
 *   1. 只有 `load()` 批量读盘（启动一次）、变更方法各写一次；其余方法纯内存。
 *   2. `load()` 绝不抛异常——插件 `apply()` 紧跟着它跑，一个坏文件不能挡住整个插件
 *      加载，否则一条脏记录会让全部 8 个既有工具一起消失。
 *   3. `flush()` 先写 `.tmp` 再 rename：进程被杀也不会留下半截 watchers.json。
 *   4. 时间只用注入的 `now()` 派生，ISO 固定带 +08:00 由固定偏移自己算——
 *      测试要能把时钟拨到任何一天，本机时区一变也不该让持久化里的时间跟着漂。
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 守候状态全集；除 pending 外都是终态，写入后不再参与命中。 */
export const WATCH_STATES = ['pending', 'fired', 'expired', 'canceled', 'failed']

/** 动作枚举。store 只负责校验取值，动作的真实副作用由接线层执行。 */
const ACTIONS = ['wake', 'notify', 'record']

/** 进入这些状态即视为「已结束」：要补 `endedAt`，并在满 7 天后被 `prune()` 清掉。 */
const TERMINAL_STATES = new Set(['fired', 'expired', 'canceled', 'failed'])

const STATE_SET = new Set(WATCH_STATES)
const FILE_NAME = 'watches.json'
const TMP_SUFFIX = '.tmp'
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_TTL_MS = 7 * DAY_MS
const RETENTION_MS = 7 * DAY_MS
/** Asia/Shanghai 无夏令时，用固定偏移即可；不查系统时区是为了让输出与机器设置解耦。 */
const OFFSET_MS = 8 * 60 * 60 * 1000

function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * epoch 毫秒 → ISO 文本，固定 +08:00。
 * 用 UTC 取值再手工加偏移，而不是 `toLocaleString`：后者依赖运行环境的时区与
 * ICU 数据，换台机器输出就变，持久化文件没法比对。
 * @param {number} epochMs epoch 毫秒
 * @returns {string} 形如 2026-11-12T20:00:00+08:00
 */
function isoFromEpoch(epochMs) {
  const shifted = new Date(epochMs + OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = pad2(shifted.getUTCMonth() + 1)
  const day = pad2(shifted.getUTCDate())
  const hour = pad2(shifted.getUTCHours())
  const minute = pad2(shifted.getUTCMinutes())
  const second = pad2(shifted.getUTCSeconds())
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`
}

/**
 * epoch 毫秒 → 文件名安全的时间戳（YYYYMMDD-HHmmss）。
 * Windows 文件名不能带冒号，所以不能直接拿 ISO 当备份名；按 +08:00 算，
 * 换时区机器上得到的备份名也一致，好按时间排序。
 * @param {number} epochMs epoch 毫秒
 * @returns {string}
 */
function stampOf(epochMs) {
  const shifted = new Date(epochMs + OFFSET_MS)
  const date = `${shifted.getUTCFullYear()}${pad2(shifted.getUTCMonth() + 1)}${pad2(shifted.getUTCDate())}`
  const time = `${pad2(shifted.getUTCHours())}${pad2(shifted.getUTCMinutes())}${pad2(shifted.getUTCSeconds())}`
  return `${date}-${time}`
}

/**
 * ISO 文本或 epoch 毫秒 → epoch 毫秒。
 * 解析不了返回 undefined，调用方按「时间未知」处理：宁可多留一条，也不能凭坏字段删记录。
 * @param {unknown} value ISO 字符串或数字时间戳
 * @returns {number | undefined}
 */
function parseEpoch(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * 生成 watch id：`watch-` + 8 位十六进制。
 * 用 crypto 而不是 Math.random：同一毫秒里批量登记时，`add()` 对同 id 是静默覆盖的，
 * 撞号会无声吃掉一条守候，比报错难查得多。
 * @returns {string}
 */
function newWatchId() {
  return `watch-${randomBytes(4).toString('hex')}`
}

/**
 * 深拷贝一条 watch。
 * 对外一律返回副本：调用方改了返回值却不落盘，会让「内存态」和「文件」悄悄分叉，
 * 重启后守候消失且查不出原因。
 * @param {object} watch 内部状态条目
 * @returns {object} 副本
 */
function cloneWatch(watch) {
  if (typeof structuredClone === 'function') return structuredClone(watch)
  return JSON.parse(JSON.stringify(watch))
}

/**
 * 必填字符串字段的校验与归一（去首尾空白）。
 * @param {unknown} value 原始值
 * @param {string} field 字段名，进错误消息
 * @returns {string}
 */
function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`watch.${field} 必须是非空字符串。`)
  }
  return value.trim()
}

/**
 * 从盘上 JSON 取出 watch 数组。
 * 写出的是裸数组（可读、diff 友好），读回时也认 `{ watches: [...] }` 与
 * `{ items: [...] }` 两种包壳：文件格式没进契约，多认几种形状，少一次「版本对不上就全丢」。
 * @param {unknown} parsed JSON.parse 的结果
 * @returns {unknown[] | null} 无法识别的形状返回 null（按损坏处理）
 */
function listOf(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed !== null && typeof parsed === 'object') {
    if (Array.isArray(parsed.watches)) return parsed.watches
    if (Array.isArray(parsed.items)) return parsed.items
  }
  return null
}

/**
 * 存储文件名：`<root>/watches.json`。
 * @param {string} root 存储根目录（`<DSH_HOME>/session-control`，测试可注入临时目录）
 * @returns {string} 绝对路径形式的文件路径
 */
export function watchesPath(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('watchesPath 需要一个非空的存储根目录。')
  }
  return join(root, FILE_NAME)
}

/**
 * 创建守候存储实例。全部方法同步：调用点是事件处理器与工具执行体，异步会引入竞态。
 * @param {{ root: string, now?: () => number }} options
 *   `root` 为存储根目录；`now` 为注入时钟（返回 epoch 毫秒），默认 `Date.now`
 * @returns {{
 *   load: () => { loaded: number, corrupt?: boolean },
 *   all: () => object[],
 *   pending: () => object[],
 *   add: (watch: object) => object,
 *   update: (id: string, patch: object) => object | undefined,
 *   cancel: (id: string) => boolean,
 *   flush: () => boolean,
 *   prune: () => number,
 * }}
 */
export function createWatchStore(options) {
  const root = options === null || typeof options !== 'object' ? undefined : options.root
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('createWatchStore 需要 { root }（存储根目录）。')
  }
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const file = watchesPath(root)

  /** @type {Map<string, object>} id → watch；Map 保插入顺序，落盘顺序即登记顺序。 */
  const watches = new Map()

  /**
   * 注入时钟的取值入口。注入物抛异常或返回非数字时退回 `Date.now()`，
   * 绝不让 NaN 流进 ISO 格式化——时间一旦坏了，过期判定会集体失灵。
   * @returns {number} epoch 毫秒
   */
  function nowMs() {
    let value
    try {
      value = Number(clock())
    } catch {
      return Date.now()
    }
    return Number.isFinite(value) ? value : Date.now()
  }

  /**
   * 有效期：优先 `expiresInHours`，缺省 7 天。
   * 让接线层传小时而不是自己拼 ISO，是为了让「时间格式只有一处」。
   * @param {object} raw 原始入参
   * @returns {number} 毫秒
   */
  function ttlMsOf(raw) {
    const hours = Number(raw.expiresInHours)
    if (Number.isFinite(hours) && hours > 0) return Math.trunc(hours * 60 * 60 * 1000)
    return DEFAULT_TTL_MS
  }

  /**
   * 校验并补全一条新 watch。
   * 机械字段（id / createdAt / expiresAt / state / attempts）由 store 兜底，
   * 接线层只关心业务字段（target / condition / action）：少一处手写就少一处格式写错。
   * 校验失败抛错——这是模型显式调用的登记路径，报错能让它当场改正。
   * @param {object} raw 原始入参
   * @returns {object} 完整 watch
   */
  function normalizeForAdd(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('watch 必须是一个对象。')
    }
    const target = requiredString(raw.target, 'target')
    const watcher = requiredString(raw.watcher, 'watcher')
    const condition = requiredString(raw.condition, 'condition')
    const action = raw.action === undefined ? 'wake' : String(raw.action)
    if (!ACTIONS.includes(action)) {
      throw new Error(`watch.action 只能是 ${ACTIONS.join(' / ')}，收到：${action}`)
    }
    const state = raw.state === undefined ? 'pending' : String(raw.state)
    if (!STATE_SET.has(state)) {
      throw new Error(`watch.state 只能是 ${WATCH_STATES.join(' / ')}，收到：${state}`)
    }
    const at = nowMs()
    const createdAt = typeof raw.createdAt === 'string' && raw.createdAt !== '' ? raw.createdAt : isoFromEpoch(at)
    const base = parseEpoch(createdAt) ?? at
    const expiresAt =
      typeof raw.expiresAt === 'string' && raw.expiresAt !== '' ? raw.expiresAt : isoFromEpoch(base + ttlMsOf(raw))
    const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : newWatchId()
    const attempts = Number.isFinite(Number(raw.attempts)) ? Number(raw.attempts) : 0
    // 先摊平原字段再覆盖机械字段：将来加字段（比如命中锚点）不必回头改 store，
    // 但也只有这里相信入参，其余对外出口一律深拷贝。
    const watch = {
      ...raw,
      id,
      target,
      watcher,
      condition,
      action,
      createdAt,
      expiresAt,
      state,
      attempts,
    }
    // expiresInHours 是登记入参而非 Watch 字段，不写进持久化，免得下次读盘时被当成脏数据。
    delete watch.expiresInHours
    if (TERMINAL_STATES.has(state) && typeof watch.endedAt !== 'string') watch.endedAt = isoFromEpoch(at)
    return watch
  }

  /**
   * 把盘上的一条记录装回内存态：要求 id / target / watcher / condition 可用，其余缺什么补什么。
   * 这里刻意宽容——旧版本写下的、手工编辑过的记录都不该让插件起不来；
   * 但缺了业务字段的记录直接丢弃：它永远命中不了，留着只会占并发名额。
   * @param {unknown} entry 盘上的一条记录
   * @returns {object | undefined} 装不回来的返回 undefined
   */
  function adopt(entry) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
    const id = text(entry.id)
    const target = text(entry.target)
    const watcher = text(entry.watcher)
    const condition = text(entry.condition)
    if (id === undefined || target === undefined || watcher === undefined || condition === undefined) {
      return undefined
    }
    const at = nowMs()
    const createdAt = text(entry.createdAt) ?? isoFromEpoch(at)
    const watch = {
      ...entry,
      id,
      target,
      watcher,
      condition,
      action: ACTIONS.includes(entry.action) ? entry.action : 'record',
      createdAt,
      expiresAt: text(entry.expiresAt) ?? isoFromEpoch((parseEpoch(createdAt) ?? at) + DEFAULT_TTL_MS),
      state: STATE_SET.has(entry.state) ? entry.state : 'pending',
      attempts: Number.isFinite(Number(entry.attempts)) ? Number(entry.attempts) : 0,
    }
    return watch
  }

  /**
   * 把坏文件复制一份到 `watches.corrupt-<ts>.json`。备份失败就算了：
   * 备份是「事后能查」的便利，不是「能从空开始」的前置条件，坏文件原样留在原路径。
   * @returns {void}
   */
  function backupCorrupt() {
    try {
      copyFileSync(file, join(root, `watches.corrupt-${stampOf(nowMs())}.json`))
    } catch {
      // 只读目录、磁盘满都走到这里：加载照常继续，不抛。
    }
  }

  /**
   * 读盘恢复。文件不存在返回 `{ loaded: 0 }`；JSON 坏（或形状不可识别）则备份后
   * 从空开始返回 `{ loaded: 0, corrupt: true }`，任何情况都不抛。
   * 选择备份而不是直接覆盖：坏文件里往往留着上一版的字段名，是唯一的现场。
   * @returns {{ loaded: number, corrupt?: boolean }}
   */
  function load() {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      watchersOrEmpty()
      return { loaded: 0 }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    const list = listOf(parsed)
    if (list === null) {
      backupCorrupt()
      watchersOrEmpty()
      return { loaded: 0, corrupt: true }
    }
    watchersOrEmpty()
    for (const entry of list) {
      const watch = adopt(entry)
      if (watch !== undefined) watches.set(watch.id, watch)
    }
    return { loaded: watches.size }
  }

  /** 清空内存态；抽出来只是让 load() 各分支读起来对称。 @returns {void} */
  function watchersOrEmpty() {
    watches.clear()
  }

  /**
   * 全量快照，含已结束的。
   * 返回副本，调用方可以随便排序、改写。
   * @returns {object[]}
   */
  function all() {
    return Array.from(watches.values(), (watch) => cloneWatch(watch))
  }

  /**
   * 当前可被命中的守候。
   * 顺手把「已过期却还挂着 pending」的条目就地转 `expired` 并落盘一次：
   * 过期判定放在这里而不是只等定时器，任何读 list 的调用方都不会看到一个
   * 早已失效的守候被当成有效登记。
   * @returns {object[]} state 为 pending 且未过期的副本
   */
  function pending() {
    const at = nowMs()
    const alive = []
    let changed = false
    for (const watch of watches.values()) {
      if (watch.state !== 'pending') continue
      const expires = parseEpoch(watch.expiresAt)
      if (expires !== undefined && expires < at) {
        watch.state = 'expired'
        watch.endedAt = isoFromEpoch(at)
        changed = true
        continue
      }
      alive.push(cloneWatch(watch))
    }
    if (changed) flush()
    return alive
  }

  /**
   * 登记一条守候：校验 → 入内存 → 落盘。同 id 覆盖（Map.set 保留原插入位置）。
   * 校验失败抛错而不返回 undefined：这是模型显式调用的路径，它需要看到哪里填错了。
   * @param {object} watch 至少含 target / watcher / condition；其余字段可省
   * @returns {object} 已入册的 watch 副本
   */
  function add(watch) {
    const normalized = normalizeForAdd(watch)
    watches.set(normalized.id, normalized)
    flush()
    return cloneWatch(normalized)
  }

  /**
   * 合并字段并落盘。找不到 id 返回 undefined。
   * `state` / `action` 收到不认识的取值时保留旧值而不是抛错：本函数会被事件处理器调用，
   * 一条脏数据不该把守候总线打断。转入终态却没给 `endedAt` 时按当前时钟补上。
   * @param {string} id watch id
   * @param {object} patch 要合并的字段（id 不允许改）
   * @returns {object | undefined} 合并后的副本；id 不存在时 undefined
   */
  function update(id, patch) {
    const watch = watches.get(String(id))
    if (watch === undefined) return undefined
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return cloneWatch(watch)
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id') continue
      if (key === 'state' && !STATE_SET.has(value)) continue
      if (key === 'action' && !ACTIONS.includes(value)) continue
      watch[key] = value
    }
    if (TERMINAL_STATES.has(watch.state) && typeof watch.endedAt !== 'string') {
      watch.endedAt = isoFromEpoch(nowMs())
    }
    flush()
    return cloneWatch(watch)
  }

  /**
   * 取消一条守候。只有 pending 能被取消：已 fired / expired 的记录是既成事实，
   * 改写成 canceled 之后「它到底触发过没有」就查不出来了。
   * @param {string} id watch id
   * @returns {boolean} 真的从 pending 转成 canceled 才返回 true
   */
  function cancel(id) {
    const watch = watches.get(String(id))
    if (watch === undefined || watch.state !== 'pending') return false
    const iso = isoFromEpoch(nowMs())
    watch.state = 'canceled'
    watch.canceledAt = iso
    watch.endedAt = iso
    flush()
    return true
  }

  /**
   * 原子落盘：写 `watches.json.tmp` 再 rename 覆盖正式文件。
   * 直接写正式文件时若进程被杀，留下的是半截 JSON，下次 load() 只能当损坏处理；
   * 同一分区内 rename 是原子的，读到的永远是完整的一版。
   * @returns {boolean} 成功 true；权限、磁盘满、目录不可写等失败一律 false，不抛
   */
  function flush() {
    const tmp = `${file}${TMP_SUFFIX}`
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(Array.from(watches.values()), null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
      return true
    } catch {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 临时文件删不掉只是脏一个文件，不能盖掉「落盘失败」这个返回值。
      }
      return false
    }
  }

  /**
   * 清掉结束超过 7 天的终态记录。
   * 只认终态：pending 再老也可能是主人在等的长任务，按时间删等于静默丢单。
   * 结束时间取 `endedAt`，缺了退 `firedAt` / `createdAt`——历史记录字段不全也别永久占位；
   * 三者都解析不出来时保留，删不删得掉不如「不误删」重要。
   * @returns {number} 清除条数（0 表示无需写盘）
   */
  function prune() {
    const cutoff = nowMs() - RETENTION_MS
    let removed = 0
    for (const [id, watch] of watches) {
      if (!TERMINAL_STATES.has(watch.state)) continue
      const ended = parseEpoch(watch.endedAt) ?? parseEpoch(watch.firedAt) ?? parseEpoch(watch.createdAt)
      if (ended === undefined || ended >= cutoff) continue
      watches.delete(id)
      removed += 1
    }
    if (removed > 0) flush()
    return removed
  }

  return { load, all, pending, add, update, cancel, flush, prune }
}
