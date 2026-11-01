/**
 * dsh-agent-session-tools — Host half.
 *
 * Agent tools that let the model:
 *   1. create a brand-new Harness session,
 *   2. inject one message into any existing session (queued, or steering),
 *   3. list visible sessions (to find an id), and
 *   4. cancel the running turn of one session.
 *
 * All four are thin, faithful wrappers over the already-composed
 * `ctx.sessionController` Host service:
 *   - `create(request)`  -> { sessionId, agentPreset? }
 *   - `prompt(request)`  -> { accepted: true }
 *   - `list(request)`    -> { items: [...] }
 *   - `cancel(request)`  -> { accepted: boolean }
 *
 * `prompt` is the same admission path the Web composer uses, so an injected
 * message lands in the target Session log as a durable user message. Called
 * from the Host plugin (no Remote principal) it is attributed to the owner.
 * `requestId` makes retries idempotent: the service returns the original
 * acceptance instead of appending a second message.
 *
 * Nothing here re-implements DSH internals: if `sessionController` is missing
 * from the composed profile, the tools stay registered and fail with a message
 * that says exactly what is missing.
 */

import { isAbsolute } from 'node:path'

export const name = 'dsh-agent-session-tools'

/** Wait for the tool registry; `sessionController` is resolved lazily per call. */
export const inject = ['tools']

/** Resolve the session controller or fail with an actionable message. */
function controllerOf(ctx) {
  const service = ctx.get('sessionController')
  if (!service) {
    throw new Error(
      `${name}: sessionController 不可用。当前 profile 没有组合 @deepseek-ai/dsh-api-session-controller，无法创建、列出或注入会话。`,
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
  if (uuid) return `${name}-${uuid}`
  return `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/* ─────────────────────────────── tools ─────────────────────────────── */

function createSessionTool(ctx) {
  return {
    name: 'session_create',
    description:
      '发起一个新的 Harness 会话（新对话窗口）。可指定工作目录与 agent 预设，返回新会话的 sessionId——该 id 可直接交给 session_inject 使用。',
    parameters: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: '新会话的工作目录绝对路径（如 E:\\proj 或 /home/me/proj）。省略时使用 Harness 默认工作目录。',
        },
        agentPreset: {
          type: 'string',
          description: '新会话使用的 agent 预设 id（例如预设名）。省略时使用配置的默认预设。',
        },
        title: {
          type: 'string',
          description: '可选：创建后立即设置的会话标题。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          agentPreset: { type: 'string' },
          title: { type: 'string' },
          warning: { type: 'string' },
        },
        required: ['sessionId'],
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
      if (cwd) {
        // A relative path would be resolved against the Host process's cwd,
        // which the caller never sees — reject it instead of creating a
        // Session in an unexpected place.
        if (!isAbsolute(cwd)) {
          throw new Error(`cwd 必须是绝对路径，收到的是相对路径：${cwd}`)
        }
        request.cwd = cwd
      }

      const agentPreset = nonEmptyString(args.agentPreset)
      if (agentPreset) request.agentPreset = agentPreset

      const controller = controllerOf(ctx)
      const created = await controller.create(request)
      const sessionId = created?.sessionId
      if (!sessionId) {
        throw new Error('session.create 未返回 sessionId，创建未生效。')
      }

      const result = { sessionId: String(sessionId) }
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
      '向指定的已有会话投递一条消息（注入）。mode=queue 排队等待该会话下一轮处理；mode=steer 立即引导、在该会话最近一步边界生效。返回 accepted 表示会话已接收该消息。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '目标会话 id（可用 session_list 查询，或 session_create 的返回值）。',
        },
        message: {
          type: 'string',
          description: '要注入的文本内容，不能为空。',
        },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: 'queue＝排队到下一轮（默认）；steer＝立即引导当前轮。',
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
          mode: { type: 'string' },
          accepted: { type: 'boolean' },
          requestId: { type: 'string' },
        },
        required: ['sessionId', 'mode', 'accepted'],
        additionalProperties: false,
      },
      render: (args, value) => [
        {
          type: 'text',
          text: `已注入会话 ${value.sessionId}（mode=${value.mode}，accepted=${value.accepted}）。`,
        },
      ],
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = nonEmptyString(args.sessionId)
      if (!sessionId) throw new Error('sessionId 不能为空，请先用 session_list 确认目标会话。')

      const message = typeof args.message === 'string' ? args.message : ''
      if (message.trim() === '') throw new Error('message 不能为空。')

      const mode = args.mode === 'steer' ? 'steer' : 'queue'
      const requestId = newRequestId()

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

      return {
        sessionId,
        mode,
        accepted: admitted?.accepted === true,
        requestId,
      }
    },
  }
}

function createListTool(ctx) {
  return {
    name: 'session_list',
    description:
      '列出当前可见的 Harness 会话（按活跃度排序），用于找到 session_inject 需要的 sessionId。只读存储，不会唤醒冷会话。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '最多返回多少条，默认 20，范围 1-100。',
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
      '取消某个会话当前正在执行的轮次（不丢弃已排队的消息）。用于解救卡在未结算工具调用上的会话：取消后该轮结束，先前排队的注入消息才有机会被消费。',
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

/* ─────────────────────────────── entry ─────────────────────────────── */

/**
 * Register the four session tools.
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
  ]) {
    effect(() => ctx.tools.register(tool), `${name}.tool.${tool.name}()`)
  }
}
