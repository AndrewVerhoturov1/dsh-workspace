import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createPostmanWorkerTools, buildPostmanWorkerStartRequest, postmanWorkerDeniedTools,
  POSTMAN_WORKER_AGENT_OPTIONS, POSTMAN_WORKER_PERSONA } from './postman-worker.js'
import { postmanBridgeRestrictionForAgent } from './postman-bridge-core.js'
import { apply as applyBridgePlugin } from './postman-bridge.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const signal = new AbortController().signal
const registeredTools = [
  'postman_bridge', 'postman_bridge_status', 'postman_task_prepare', 'postman_task_restore', 'postman_worker', 'postman_worker_interrupt', 'postman_worker_stop', 'postman_send', 'postman_reply',
  'postman_async_send', 'postman_runtime_get_request', 'postman_runtime_accept_request',
  'postman_runtime_list_ready', 'postman_runtime_deliver_ready', 'postman_runtime_synthetic_ready',
  'postman_send_current_turn', 'postman_current_turn_status', 'postman_ask_validate_reply',
  'postman_continue_last_request', 'postman_result_present',
  'postman_result_workspace_register', 'postman_result_workspace_unregister',
  'read', 'read_image', 'glob', 'grep', 'write', 'edit', 'pwsh', 'web_search', 'subagent', 'subagent_fork', 'report',
]
const registry = { schemas: () => registeredTools.map(name => ({ name })) }
const leader = id => ({ id, session: { header: { id, agentPreset: 'postman-leader', delegationDepth: 0 } } })
const exec = agent => ({ agent, signal })

function fixture(contexts) {
  const agents = new Map()
  const calls = { starts: [], followups: [], interrupts: [], drains: [] }
  let next = 0
  const ctx = {
    agents: { get: id => agents.get(id) },
    tools: registry,
    subagents: {
      async startContinuable(spec) {
        calls.starts.push(spec)
        return { childId: 'worker-' + ++next, messageId: 'message-' + next }
      },
      async followup(parent, id, content, options) {
        calls.followups.push({ parent, id, content, options })
        return 'followup-' + calls.followups.length
      },
      async interrupt(id, authority) { calls.interrupts.push({ id, authority }) },
      async drainContinuableChildren(parent, ids) {
        calls.drains.push({ parent, ids })
      },
    },
  }
  return { ctx, agents, calls, tools: createPostmanWorkerTools(ctx, undefined, contexts) }
}

function toolsFromPreset() {
  const preset = readFileSync(join(root, '.agent-presets', 'postman-leader', 'agent.cordis.yml'), 'utf8')
  const rows = [...preset.matchAll(/^\s*- id: ([\w-]+)\s*$/gm)].map(match => match[1])
  return { preset, rows }
}

test('Worker request pins Luna and denies only registered Postman tools', () => {
  const parent = leader('A')
  const denied = postmanWorkerDeniedTools(registry)
  const spec = buildPostmanWorkerStartRequest(parent, 'local work', signal, denied)
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.request.parent, parent)
  assert.equal(spec.signal, signal)
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: 'local work' }])
  assert.deepEqual(spec.request.agentOptions, { provider: 'codex', model: 'gpt-6-luna' })
  assert.deepEqual(POSTMAN_WORKER_AGENT_OPTIONS, spec.request.agentOptions)
  assert.deepEqual(spec.request.toolFilter, { deny: denied })
  assert.equal(Object.hasOwn(spec.request.toolFilter, 'allow'), false)
  assert.ok(denied.length > 3)
  assert.deepEqual(denied, registeredTools.filter(name => name.startsWith('postman_')))
  assert.equal(denied.includes('report'), false)
  assert.deepEqual(postmanWorkerDeniedTools({ schemas: () => [
    { name: 'postman_future_control' }, { name: 'write' }, { name: 'report' },
  ] }), ['postman_future_control'])
  assert.throws(() => buildPostmanWorkerStartRequest(parent, 'local work', signal, []),
    /POSTMAN_WORKER_TRANSPORT_BOUNDARY_REQUIRED/)
  assert.match(POSTMAN_WORKER_PERSONA, /report tool/)
  assert.match(POSTMAN_WORKER_PERSONA, /later tasks/)
})

test('Leader hides coding tools; Worker keeps coding and report but no Postman control tools', () => {
  const { preset, rows } = toolsFromPreset()
  for (const row of ['tool-fs', 'tool-fs-search', 'tool-pwsh', 'tool-bash',
    'tool-jobs', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-web']) {
    assert.ok(rows.includes(row), row)
  }
  assert.match(preset, /name: '@deepseek-ai\/dsh-tool-fs'/)
  assert.match(preset, /name: '@deepseek-ai\/dsh-tool-fs-search'/)
  assert.match(preset, /name: '@deepseek-ai\/dsh-tool-pwsh'/)
  assert.match(preset, /fetch: true[\s\S]*search: true/)
  const top = leader('A')
  const child = { id: 'worker-A', session: { header: {
    agentPreset: 'postman-leader', origin: 'subagent', parentSession: 'A', delegationDepth: 1,
  } } }
  const leaderRestriction = postmanBridgeRestrictionForAgent(top)
  const childRestriction = postmanBridgeRestrictionForAgent(child)
  assert.equal(leaderRestriction.allow.includes('glob'), false)
  assert.equal(leaderRestriction.allow.includes('web_search'), false)
  for (const name of ['write', 'edit', 'pwsh', 'bash', 'subagent', 'subagent_fork', 'workflow']) {
    assert.equal(leaderRestriction.allow.includes(name), false, name)
    assert.equal(childRestriction.deny.includes(name), false, name)
  }
  for (const name of ['postman_bridge', 'postman_worker', 'postman_worker_interrupt', 'postman_worker_stop']) {
    assert.equal(leaderRestriction.allow.includes(name), true)
    assert.equal(childRestriction.deny.includes(name), true)
  }
  const workerFilter = buildPostmanWorkerStartRequest(top, 'local work', signal,
    postmanWorkerDeniedTools(registry)).request.toolFilter
  // Ancestor restriction and per-child denial intersect; report is scoped to the child.
  const visibleToWorker = name => !childRestriction.deny.includes(name) &&
    !workerFilter.deny.includes(name)
  for (const name of ['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'pwsh', 'web_search', 'subagent',
    'subagent_fork', 'report']) assert.equal(visibleToWorker(name), true, name)
  for (const name of registeredTools.filter(name => name.startsWith('postman_'))) {
    assert.equal(visibleToWorker(name), false, name)
  }
  assert.equal(workerFilter.deny.includes('report'), false)
})

test('first task creates a child; second task follows up in the same durable Session', async () => {
  const { agents, calls, tools } = fixture()
  const a = leader('A'); agents.set('A', a)
  const first = await tools.taskTool.execute({ task: 'first' }, exec(a))
  assert.deepEqual(first, { status: 'POSTMAN_WORKER_TASK_ACCEPTED', workerSessionId: 'worker-1',
    created: true, messageId: 'message-1', model: 'gpt-6-luna', provider: 'spawn' })
  const second = await tools.taskTool.execute({ task: 'second' }, exec(a))
  assert.equal(second.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(second.created, false)
  assert.equal(second.workerSessionId, first.workerSessionId)
  assert.equal(second.messageId, 'followup-1')
  assert.equal(calls.starts.length, 1)
  assert.deepEqual(calls.starts[0].request.toolFilter,
    { deny: registeredTools.filter(name => name.startsWith('postman_')) })
  assert.equal(calls.followups.length, 1)
  assert.equal(calls.followups[0].parent, a)
  assert.deepEqual(calls.followups[0].content, [{ type: 'text', text: 'second' }])
  assert.equal(calls.followups[0].options.source.senderSessionId, 'A')
})

test('interrupt contract disclaims Harness processing-order guarantees', () => {
  const f = fixture()
  assert.match(f.tools.interruptTool.description, /no priority or processing-order guarantees relative to messages already accepted by the Harness runtime/)
})

test('interrupt waits for a resident Worker to become idle, then redirects the same session', async () => {
  const context = { branch: 'task/postman-bound', worktree: 'C:/worktrees/bound' }
  const contexts = { get: id => id === 'A' ? context : undefined, isRestoring: () => false, hasActiveOperation: () => false }
  const f = fixture(contexts); const a = leader('A'); f.agents.set('A', a)
  const first = await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  let markIdleStarted
  let releaseIdle
  const idleStarted = new Promise(resolve => { markIdleStarted = resolve })
  const idleGate = new Promise(resolve => { releaseIdle = resolve })
  const resident = { whenIdle() { markIdleStarted(); return idleGate } }
  f.agents.set(first.workerSessionId, resident)
  const interruptPromise = f.tools.interruptTool.execute({ task: 'replacement' }, exec(a))
  await idleStarted
  assert.deepEqual(f.calls.interrupts, [{ id: 'worker-1', authority: { kind: 'ancestor', agent: a } }])
  assert.equal(f.calls.followups.length, 0)
  assert.equal(f.calls.starts.length, 1)
  assert.equal(f.calls.drains.length, 0)
  releaseIdle()
  const redirected = await interruptPromise
  assert.equal(redirected.status, 'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED')
  assert.equal(redirected.created, false)
  assert.equal(redirected.workerSessionId, first.workerSessionId)
  assert.equal(redirected.messageId, 'followup-1')
  assert.equal(redirected.interruptRequested, true)
  assert.equal(redirected.mappingPreserved, true)
  assert.equal(f.calls.followups[0].id, first.workerSessionId)
  assert.match(f.calls.followups[0].content[0].text, /task\/postman-bound/)
  assert.ok(f.calls.followups[0].content[0].text.includes('C:/worktrees/bound'))
  assert.match(f.calls.followups[0].content[0].text, /previous turn may have been interrupted partway through/i)
  assert.equal(f.tools.contextOf('A'), context)
  const later = await f.tools.taskTool.execute({ task: 'later' }, exec(a))
  assert.equal(later.created, false)
  assert.equal(later.workerSessionId, first.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
  assert.equal(f.calls.drains.length, 0)
})

test('cold or non-resident Worker interrupts and wakes through the same durable child id', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set('A', a)
  const first = await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  assert.equal(f.agents.get(first.workerSessionId), undefined)
  const redirected = await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))
  assert.equal(redirected.status, 'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED')
  assert.equal(redirected.workerSessionId, first.workerSessionId)
  assert.equal(f.calls.interrupts[0].id, first.workerSessionId)
  assert.equal(f.calls.followups[0].id, first.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
})

test('interrupt without an active mapping never starts a Worker', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set('A', a)
  assert.equal((await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))).status,
    'POSTMAN_WORKER_INTERRUPT_NO_ACTIVE_WORKER')
  assert.equal(f.calls.starts.length, 0)
  assert.equal(f.calls.followups.length, 0)
  await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  await f.tools.stopTool.execute({}, exec(a))
  assert.equal((await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))).status,
    'POSTMAN_WORKER_INTERRUPT_NO_ACTIVE_WORKER')
  assert.equal(f.calls.starts.length, 1)
})

test('interrupt admission failure preserves mapping and ordinary follow-up can reuse it', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set('A', a)
  const first = await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  f.ctx.subagents.interrupt = async () => { throw new Error('interrupt denied') }
  const failed = await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))
  assert.equal(failed.status, 'POSTMAN_WORKER_INTERRUPT_FAILED')
  assert.equal(failed.workerSessionId, first.workerSessionId)
  assert.equal(failed.mappingPreserved, true)
  assert.equal(f.calls.followups.length, 0)
  f.ctx.subagents.interrupt = async (id, authority) => { f.calls.interrupts.push({ id, authority }) }
  const later = await f.tools.taskTool.execute({ task: 'later' }, exec(a))
  assert.equal(later.created, false)
  assert.equal(later.workerSessionId, first.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
})

test('redirect delivery failure after interrupt preserves mapping and does not create another Worker', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set('A', a)
  const first = await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  f.ctx.subagents.followup = async () => { throw new Error('delivery denied') }
  const failed = await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))
  assert.equal(failed.status, 'POSTMAN_WORKER_INTERRUPT_DELIVERY_FAILED')
  assert.equal(failed.workerSessionId, first.workerSessionId)
  assert.equal(failed.interruptRequested, true)
  assert.equal(failed.mappingPreserved, true)
  assert.equal(f.calls.starts.length, 1)
  f.ctx.subagents.followup = async (parent, id, content, options) => {
    f.calls.followups.push({ parent, id, content, options })
    return 'retry-followup'
  }
  const later = await f.tools.taskTool.execute({ task: 'later' }, exec(a))
  assert.equal(later.created, false)
  assert.equal(later.workerSessionId, first.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
})

test('non-Leader cannot interrupt another Leader Worker', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set('A', a)
  await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  const child = { id: 'worker-child', session: { header: { agentPreset: 'postman-leader', origin: 'subagent', delegationDepth: 1 } } }
  assert.equal((await f.tools.interruptTool.execute({ task: 'unauthorized' }, exec(child))).status,
    'POSTMAN_WORKER_CALLER_REJECTED')
  assert.equal(f.calls.interrupts.length, 0)
  assert.equal(f.calls.followups.length, 0)
})

test('interrupt enforces required, busy and exact task context identity', async () => {
  let context = { branch: 'task/one', worktree: 'C:/one' }
  let restoring = false
  let operation = false
  const contexts = { get: () => context, isRestoring: () => restoring, hasActiveOperation: () => operation }
  const f = fixture(contexts); const a = leader('A'); f.agents.set('A', a)
  await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  context = undefined
  assert.equal((await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))).status,
    'POSTMAN_TASK_CONTEXT_REQUIRED')
  context = { branch: 'task/one', worktree: 'C:/one' }
  restoring = true
  assert.equal((await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))).status,
    'POSTMAN_TASK_CONTEXT_BUSY')
  restoring = false; operation = true
  assert.equal((await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))).status,
    'POSTMAN_TASK_CONTEXT_BUSY')
  operation = false; context = { branch: 'task/two', worktree: 'C:/two' }
  assert.equal((await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))).status,
    'POSTMAN_TASK_CONTEXT_MISMATCH')
  assert.equal(f.calls.interrupts.length, 0)
})

test('ordinary Worker tasks retain FIFO follow-up admission without interrupting', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set('A', a)
  await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  const second = await f.tools.taskTool.execute({ task: 'queued second' }, exec(a))
  const third = await f.tools.taskTool.execute({ task: 'queued third' }, exec(a))
  assert.equal(second.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(third.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(second.workerSessionId, third.workerSessionId)
  assert.deepEqual(f.calls.followups.map(call => call.content[0].text), ['queued second', 'queued third'])
  assert.equal(f.calls.interrupts.length, 0)
  assert.equal(f.calls.starts.length, 1)
})

test('distinct Leader sessions have distinct Worker identities; unauthorized caller cannot reuse them', async () => {
  const { agents, calls, tools } = fixture()
  const a = leader('A'), b = leader('B'); agents.set(a.id, a); agents.set(b.id, b)
  const first = await tools.taskTool.execute({ task: 'A' }, exec(a))
  const second = await tools.taskTool.execute({ task: 'B' }, exec(b))
  assert.notEqual(first.workerSessionId, second.workerSessionId)
  assert.equal((await tools.stopTool.execute({}, exec(a))).workerSessionId, first.workerSessionId)
  const bNext = await tools.taskTool.execute({ task: 'B again' }, exec(b))
  assert.equal(bNext.workerSessionId, second.workerSessionId)
  assert.equal(bNext.created, false)
  const child = { id: 'C', session: { header: { agentPreset: 'postman-leader', origin: 'subagent', delegationDepth: 1 } } }
  assert.equal((await tools.taskTool.execute({ task: 'X' }, exec(child))).status, 'POSTMAN_WORKER_CALLER_REJECTED')
  assert.equal((await tools.stopTool.execute({}, exec(child))).status, 'POSTMAN_WORKER_CALLER_REJECTED')
  assert.equal(calls.starts.length, 2)
})

test('stop drains exact resident child, removes mapping, is idempotent and permits new Worker', async () => {
  const { agents, calls, tools } = fixture()
  const a = leader('A'); agents.set(a.id, a)
  const first = await tools.taskTool.execute({ task: 'first' }, exec(a))
  const stopped = await tools.stopTool.execute({}, exec(a))
  assert.deepEqual(stopped, { status: 'POSTMAN_WORKER_STOPPED', workerSessionId: first.workerSessionId,
    residentReleased: true, mappingRemoved: true, durableSessionDeleted: false })
  assert.deepEqual(calls.drains[0], { parent: a, ids: ['worker-1'] })
  assert.equal((await tools.stopTool.execute({}, exec(a))).status, 'POSTMAN_WORKER_ALREADY_STOPPED')
  const next = await tools.taskTool.execute({ task: 'next' }, exec(a))
  assert.equal(next.created, true)
  assert.equal(next.workerSessionId, 'worker-2')
})

test('admission failures do not corrupt mapping or create a second active child', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set(a.id, a)
  const originalStart = f.ctx.subagents.startContinuable
  f.ctx.subagents.startContinuable = async () => { throw new Error('cannot create') }
  assert.equal((await f.tools.taskTool.execute({ task: 'first' }, exec(a))).status, 'POSTMAN_WORKER_START_FAILED')
  f.ctx.subagents.startContinuable = originalStart
  const accepted = await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  assert.equal(accepted.created, true)
  f.ctx.subagents.followup = async () => { throw new Error('not admitted') }
  const failed = await f.tools.taskTool.execute({ task: 'second' }, exec(a))
  assert.equal(failed.status, 'POSTMAN_WORKER_FOLLOWUP_FAILED')
  assert.equal(failed.workerSessionId, accepted.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
  f.ctx.subagents.drainContinuableChildren = async () => { throw new Error('release failed') }
  const stop = await f.tools.stopTool.execute({}, exec(a))
  assert.equal(stop.status, 'POSTMAN_WORKER_STOP_FAILED')
  assert.equal(stop.workerSessionId, accepted.workerSessionId)
  f.ctx.subagents.drainContinuableChildren = async () => undefined
  assert.equal((await f.tools.stopTool.execute({}, exec(a))).status, 'POSTMAN_WORKER_STOPPED')
})

test('concurrent admissions serialize and the durable Leader session retains its Worker', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set(a.id, a)
  const both = await Promise.all([
    f.tools.taskTool.execute({ task: 'one' }, exec(a)),
    f.tools.taskTool.execute({ task: 'two' }, exec(a)),
  ])
  assert.equal(f.calls.starts.length, 1)
  assert.equal(f.calls.followups.length, 1)
  assert.equal(both[0].workerSessionId, both[1].workerSessionId)
  const newAgent = leader('A'); f.agents.set('A', newAgent)
  const resumed = await f.tools.taskTool.execute({ task: 'new' }, exec(newAgent))
  assert.equal(resumed.created, false)
  assert.equal(resumed.workerSessionId, both[0].workerSessionId)
  assert.equal(f.calls.followups.at(-1).parent, newAgent)
  assert.equal((await f.tools.taskTool.execute({ task: 'stale' }, exec(a))).status, 'POSTMAN_WORKER_CALLER_REJECTED')
  f.tools.dispose()
})
test('stop queued behind admission drains the accepted child before a later task starts anew', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set(a.id, a)
  let accept
  const originalStart = f.ctx.subagents.startContinuable
  f.ctx.subagents.startContinuable = async spec => {
    f.calls.starts.push(spec)
    return new Promise(resolve => { accept = resolve })
  }
  const firstPromise = f.tools.taskTool.execute({ task: 'first' }, exec(a))
  const stopPromise = f.tools.stopTool.execute({}, exec(a))
  await Promise.resolve()
  accept({ childId: 'worker-race', messageId: 'message-race' })
  const [first, stop] = await Promise.all([firstPromise, stopPromise])
  assert.equal(first.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(stop.status, 'POSTMAN_WORKER_STOPPED')
  assert.deepEqual(f.calls.drains[0].ids, ['worker-race'])
  f.ctx.subagents.startContinuable = originalStart
  const next = await f.tools.taskTool.execute({ task: 'next' }, exec(a))
  assert.equal(next.created, true)
})

test('bridge plugin registers all Worker tools and preserves boundary on creation', () => {
  const registrations = new Map()
  const listeners = new Map()
  const a = leader('A')
  let restriction
  a.ctx = { tools: { restrict(value) { restriction = value; return () => undefined } } }
  const ctx = {
    agents: { get: id => id === a.id ? a : undefined, list: () => [a] },
    tools: { register(tool) { registrations.set(tool.name, tool) } },
    subagents: {},
    effect: () => undefined,
    on(name, handler) { listeners.set(name, handler) },
  }
  applyBridgePlugin(ctx)
  assert.deepEqual([...registrations.keys()].sort(), ['implementation_artifact_apply', 'postman_bridge', 'postman_bridge_status', 'postman_task_prepare', 'postman_task_restore', 'postman_worker', 'postman_worker_interrupt', 'postman_worker_stop'])
  assert.deepEqual(restriction.allow, postmanBridgeRestrictionForAgent(a).allow)
  assert.ok(listeners.has('agent-preset/selected'))
  assert.ok(listeners.has('agent/disposed'))
})

