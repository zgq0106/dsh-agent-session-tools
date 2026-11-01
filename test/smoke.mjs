/**
 * Smoke test for dsh-agent-session-tools, runnable without installing it.
 *
 * It imports the real plugin module and drives `apply()` with a fake Cordis
 * context and a stubbed `sessionController`, so registration shape and every
 * execute() path are exercised before anything touches a live profile.
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
  return { create: [], prompt: [], list: [], rename: [], cancel: [] }
}

function makeCtx(calls, overrides = {}) {
  const registered = []
  const controller = {
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
    get: (key) => (key === 'sessionController' ? controller : undefined),
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
check('exports name', name === 'dsh-agent-session-tools')
check('inject waits for tools', Array.isArray(inject) && inject.includes('tools'))
check('apply is a function', typeof apply === 'function')

console.log('— registration —')
apply(ctx)
check('registers four tools', registered.length === 4, `got ${registered.length}`)

const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]))
check('session_create registered', Boolean(byName.session_create))
check('session_inject registered', Boolean(byName.session_inject))
check('session_list registered', Boolean(byName.session_list))
check('session_cancel registered', Boolean(byName.session_cancel))

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

console.log('— session_create: rejects a relative cwd —')
{
  const before = calls.create.length
  let message = ''
  try {
    await byName.session_create.execute({ cwd: 'relative/dir' })
  } catch (error) {
    message = String(error.message)
  }
  check('rejects relative cwd', message.includes('绝对路径'), message || 'no error thrown')
  check('no create call on rejection', calls.create.length === before)
}

console.log('— session_create: accepts a POSIX absolute cwd —')
{
  await byName.session_create.execute({ cwd: '/home/me/proj' })
  check('passes POSIX absolute path', calls.create.at(-1)?.cwd === '/home/me/proj')
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
  check(
    'mints a requestId',
    typeof request.requestId === 'string' && request.requestId.startsWith('dsh-agent-session-tools-'),
  )
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

console.log('— session_cancel —')
{
  const result = await byName.session_cancel.execute({ sessionId: 's-target' })
  check('accepted', result.accepted === true)
  check('routes to the session', calls.cancel.at(-1)?.sessionId === 's-target')

  let missing = false
  try {
    await byName.session_cancel.execute({})
  } catch {
    missing = true
  }
  check('rejects missing sessionId', missing)
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
  check('fails with actionable error', message.includes('sessionController'), message)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
