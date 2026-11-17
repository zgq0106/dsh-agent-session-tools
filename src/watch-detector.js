/**
 * 跨会话触发 · 判定层（detector）
 *
 * 职责刻意收窄：只回答「这条事件 / 这次巡检里，有没有出现值得守候的命中」。
 * 它不知道 watch 列表、不碰闸门与预算、不读盘不写盘——那三件事分属 store、gate
 * 与接线层；三个模块互不 import，既避免环形依赖，也让并行开发时没有共享状态。
 *
 * 三条约束都来自「它跑在事件总线上」这个事实：
 *   1. 异常就地吃掉。宿主的事件总线不会替监听器兜异常，抛出去会拖累整个
 *      session/event 分发，宁可少一次判定，也不能让插件影响宿主。
 *   2. 早退优先。只认 turn/end 与带 error 的 tool/result，其余事件在碰任何字符串
 *      之前就返回 null；事件流里绝大多数条目与本模块无关。
 *   3. 不做语义判定。文本正则、语汇权重归 cyber-butler，这里重复一遍只会让两处
 *      规则慢慢分叉；命中后由收到消息的会话自己用 session_segments 取全文再判断。
 */

/**
 * 六个守候条件。detector 只产出 completed / failed / truncated / question / stalled；
 * idle 由接线层按 watch.idleMs 与 lastEventAt 自己比（它需要 watch 字段，
 * 而本模块刻意不持有 watch）；settled 是接线层的匹配口径（终态任一），不是本模块的产出，
 * 三者列在这里是为了和存储层、工具枚举对齐。
 */
export const CONDITION_KINDS = ['completed', 'failed', 'idle', 'question', 'stalled', 'truncated']

/**
 * turn/end 的 reason.kind 落在这些值里算失败。
 * 契约只列了 error / aborted / interrupted；max-tokens 同样是「这轮没跑完就断了」，
 * 且它常常表现为没有 assistant 文本，当成 completed 会把残缺产出当成果报上去。
 */
const FAILED_REASON_KINDS = ['error', 'aborted', 'interrupted', 'max-tokens']

/** 尾部文本上限：契约要求「前 240 字」，超出只切不加省略号，长度必须守住。 */
const TEXT_LIMIT = 240

/**
 * 默认「悬着的提问」阈值：超过 20 分钟没人答才值得叫醒。语义是严格大于。
 * 导出是为了让测试与调用方拿到同一份默认值；实际判定用 createDetector 注入的副本。
 */
export const QUESTION_MS = 20 * 60 * 1000

/** 默认「疑似卡死」阈值：running 且超过 15 分钟没有事件。语义是严格大于。 */
export const STALLED_MS = 15 * 60 * 1000

/** tick 不是由具体事件触发的，没有事件序号；用 -1 明确表示「无 seq」。 */
const NO_SEQ = -1

/** 截断尾部文本。非字符串一律当空串——命中本身不依赖文本。 */
function clipText(value) {
  if (typeof value !== 'string') return ''
  return value.length <= TEXT_LIMIT ? value : value.slice(0, TEXT_LIMIT)
}

/**
 * 把可注入的时间阈值收敛成合法毫秒数。
 * 配置来自调用方（环境变量、配置项都可能为空串或 0），非法值一律回落默认值，
 * 而不是抛错——判定层跑在事件总线上，构造期抛异常会连累整个插件加载。
 *
 * @param {unknown} value 待校验的阈值。
 * @param {number} fallback 缺省阈值（毫秒）。
 * @returns {number} 有限正数，或 fallback。
 */
function positiveMsOf(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 把时间字段收敛成 epoch ms。
 * 契约里 at / lastEventAt / openQuestionSince 都是 epoch ms，但接线层很可能顺手传
 * inspect() 里的 ISO 串。这里统一收口：解析不出来就返回 fallback（缺省即 undefined），
 * 让时间单位不一致表现为「本次不判」，而不是悄悄变成一个荒谬的差值。
 *
 * @param {unknown} value 待解析的时间值。
 * @param {number | undefined} fallback 解析失败时的回落值。
 * @returns {number | undefined} epoch ms。
 */
function timeOf(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) {
    const stamp = value.getTime()
    return Number.isFinite(stamp) ? stamp : fallback
  }
  if (typeof value === 'string' && value !== '') {
    const stamp = Date.parse(value)
    if (Number.isFinite(stamp)) return stamp
  }
  return fallback
}

/**
 * 规整会话 id：没有 id 的命中无法定位目标，宁可返回 null。
 *
 * @param {unknown} value 候选会话 id。
 * @returns {string | undefined} 去空白后的 id，空则 undefined。
 */
function sessionIdOf(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 从 tool/result 的 error 字段里取一行可读原因当尾部文本。
 * 形状不固定（true / 字符串 / { message }），取不到就空串，命中判定不受影响。
 *
 * @param {unknown} error 事件里的 error 字段。
 * @returns {string} 截断后的原因文本，可能为空串。
 */
function errorTextOf(error) {
  if (typeof error === 'string') return clipText(error)
  if (error !== null && typeof error === 'object') {
    const message = error.message ?? error.error ?? error.reason
    if (typeof message === 'string') return clipText(message)
    if (typeof error.name === 'string') return clipText(error.name)
  }
  return ''
}

/**
 * 取该轮最后一条 assistant 文本。
 * detector 不折叠历史（那要读会话日志），由调用方折叠好后经 session.lastAssistantText
 * 传入；同时兼容给一个取值函数，让接线层能把折叠推迟到真正命中时再做。
 *
 * @param {unknown} session 调用方提供的会话快照，可含 lastAssistantText。
 * @returns {string} 截断后的尾部文本，缺省为空串。
 */
function lastAssistantTextOf(session) {
  if (session === null || typeof session !== 'object') return ''
  const value = session.lastAssistantText
  if (typeof value === 'function') {
    try {
      return clipText(value())
    } catch {
      return ''
    }
  }
  return clipText(value)
}

/**
 * 创建判定器。
 *
 * 纯函数式：同样的输入得到同样的输出（唯一的外部依赖是注入的 now()，用于 at 缺省）。
 * 实例方法都不做 IO、不持有跨调用状态，便于在事件总线上被高频调用。
 *
 * @param {{
 *   now?: () => number,
 *   questionMs?: number,
 *   stalledMs?: number,
 * }} [options] now 注入时钟，便于测试；缺省 Date.now。
 *   questionMs / stalledMs 覆盖 question 与 stalled 的阈值（毫秒），
 *   缺省或非法（非数字、<=0）时用 QUESTION_MS / STALLED_MS。
 * @returns {{
 *   observe: (input: { sessionId: string, event: object, session?: object, at?: number }) => object | null,
 *   tick: (input: { inspections: Array<object>, at?: number }) => object[],
 * }} 判定器实例。
 */
export function createDetector(options = {}) {
  const now = typeof options?.now === 'function' ? options.now : () => Date.now()
  const questionMs = positiveMsOf(options?.questionMs, QUESTION_MS)
  const stalledMs = positiveMsOf(options?.stalledMs, STALLED_MS)

  /**
   * 处理一条 session/event，产出命中或 null。
   * 所有分支都在 try/catch 内：这个方法直接挂在事件总线上，抛出会拖累宿主分发。
   *
   * @param {{
   *   sessionId: string,
   *   event: { type?: string, seq?: number, data?: object },
   *   session?: { lastAssistantText?: string | (() => string) },
   *   at?: number,
   * }} input session/event 的载荷。
   * @returns {{
   *   kind: string, sessionId: string, seq: number, text: string, reason: string, at: number,
   * } | null} 判定结果，无命中返回 null。
   */
  function observe(input) {
    try {
      const event = input?.event
      if (event === null || typeof event !== 'object') return null

      // 早退放在最前面：先按事件类型筛掉绝大多数条目，再碰任何字段与字符串。
      const type = event.type
      if (type !== 'turn/end' && type !== 'tool/result') return null

      const sessionId = sessionIdOf(input.sessionId)
      if (sessionId === undefined) return null

      const at = timeOf(input.at, now())
      const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : NO_SEQ
      // 事件自身的时刻。`at` 是判定时刻（约等于「现在」），用它算延迟永远是 0；
      // 观测层要的是「条件真实发生 → 投递」的差，含静默窗口，所以两者分开留。
      const eventAt = timeOf(event.time, at)
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {}

      if (type === 'turn/end') {
        // reason 缺失（undefined）视为正常收尾；只有明确落在失败集合里才改判 failed。
        const reasonKind = typeof data.reason?.kind === 'string' ? data.reason.kind : undefined
        const failed = reasonKind !== undefined && FAILED_REASON_KINDS.includes(reasonKind)
        const text = lastAssistantTextOf(input.session)
        // 「收尾了却没有产出」：reason 正常，但这轮最后一条 assistant 消息里没有一个
        // text 块。2026-11-13 那次派活中断就是这个形状——最后一步只发了工具调用、
        // 轮次随即结束，订阅 completed 的一方收到的却是「完成」，实际半句结论都没有。
        //
        // 它仍是 completed（kind 不变、订阅 completed 的人照收，绝不因此漏掉正常轮次），
        // 只是把 reason 标成 `no-output`：想专抓「空收尾」的，订 truncated 即可，
        // 接线层按 `kind==='completed' && reason==='no-output'` 匹配。
        // 只在调用方给了会话快照时才判：拿不到快照，就分不清「确实没产出」与
        // 「看不到产出」，那种情况 reason 仍是 completed。
        const hasSession = input.session !== null && typeof input.session === 'object'
        const silent = !failed && hasSession && text === ''
        return {
          // 契约的 reason 枚举只覆盖 error / aborted，interrupted 与 max-tokens 直接
          // 透传原始 kind：把具体原因压成笼统的 error，命中消息里就只剩「炸了」。
          kind: failed ? 'failed' : 'completed',
          sessionId,
          seq,
          text,
          reason: failed ? reasonKind : silent ? 'no-output' : 'completed',
          at,
          eventAt,
        }
      }

      // tool/result：error 存在即失败。这里用「非 nullish」判存在，宁可多报一次
      // 工具失败，也不漏掉工具已经炸掉却还在等下一轮的情况。
      const error = data.error
      if (error === undefined || error === null) return null
      return {
        kind: 'failed',
        sessionId,
        seq,
        text: errorTextOf(error),
        reason: 'tool-error',
        at,
        eventAt,
      }
    } catch {
      return null
    }
  }

  /**
   * 判一条巡检记录。question 与 stalled 互斥、question 优先：
   * 悬着的提问本身就会让 lastEventAt 一起变旧，两条都报等于对同一会话发两次
   * 互相矛盾的通知，而「在等人答」是更具体、更可行动的那个结论。
   *
   * @param {unknown} inspection 单条巡检记录。
   * @param {number} at 本轮时间戳（epoch ms）。
   * @returns {object | null} 命中或 null。
   */
  function tickOne(inspection, at) {
    if (inspection === null || typeof inspection !== 'object') return null
    const sessionId = sessionIdOf(inspection.sessionId)
    if (sessionId === undefined) return null

    const questionSince = timeOf(inspection.openQuestionSince, undefined)
    if (questionSince !== undefined && at - questionSince > questionMs) {
      return { kind: 'question', sessionId, seq: NO_SEQ, text: '', reason: 'question', at }
    }

    // 只有 running 的会话可能卡住；idle 会话没有事件是正常状态。
    if (inspection.running !== true) return null
    const lastEventAt = timeOf(inspection.lastEventAt, undefined)
    if (lastEventAt === undefined) return null
    if (at - lastEventAt > stalledMs) {
      return { kind: 'stalled', sessionId, seq: NO_SEQ, text: '', reason: 'stalled', at }
    }
    return null
  }

  /**
   * 定时兜底：处理 question 与 stalled，不看事件。
   * 单条记录出错只跳过它——一轮巡检覆盖多个会话，不能因为其中一条数据脏就全军覆没。
   *
   * @param {{ inspections: Array<{
   *   sessionId: string, running?: boolean, lastEventAt?: number, openQuestionSince?: number,
   * }>, at?: number }} input 本轮巡检载荷。
   * @returns {Array<object>} 命中列表，按 inspections 顺序，无命中为空数组。
   */
  function tick(input) {
    try {
      const at = timeOf(input?.at, now())
      const inspections = Array.isArray(input?.inspections) ? input.inspections : []
      const hits = []
      for (const inspection of inspections) {
        try {
          const hit = tickOne(inspection, at)
          if (hit !== null) hits.push(hit)
        } catch {
          /* 跳过这一条，继续判后面的会话 */
        }
      }
      return hits
    } catch {
      return []
    }
  }

  return { observe, tick }
}
