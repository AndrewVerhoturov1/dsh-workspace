import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createPostmanWorkerTools, buildPostmanWorkerStartRequest, postmanWorkerDeniedTools,
  POSTMAN_WORKER_AGENT_OPTIONS, POSTMAN_WORKER_PERSONA } from './postman-worker.js'
import { postmanBridgeRestrictionForAgent } from './postman-bridge-core.js'
import { apply as applyBridgePlugin, createPostmanChildNotifyTool } from './postman-bridge.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const signal = new AbortController().signal
const registeredTools = [
  'postman_bridge', 'postman_bridge_status', 'postman_task_prepare', 'postman_task_restore', 'postman_worker', 'postman_worker_interrupt', 'postman_worker_list', 'postman_worker_stop', 'postman_worker_list', 'postman_send', 'postman_reply',
  'postman_async_send', 'postman_runtime_get_request', 'postman_runtime_accept_request',
  'postman_runtime_list_ready', 'postman_runtime_deliver_ready', 'postman_runtime_synthetic_ready',
  'postman_send_current_turn', 'postman_current_turn_status', 'postman_ask_validate_reply',
  'postman_continue_last_request', 'postman_result_present',
  'postman_result_workspace_register', 'postman_result_workspace_unregister',
  'read', 'read_image', 'glob', 'grep', 'write', 'edit', 'pwsh', 'web_search', 'subagent', 'subagent_fork', 'report',
]
const registry = { schemas: () => registeredTools.map(name => ({ name })) }
const leader = (id, preset = 'postman-leader') => ({ id, session: { header: { id, agentPreset: preset, delegationDepth: 0 } } })
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
        next++
        return { childId: spec.childId, messageId: 'message-' + next }
      },
      async followup(parent, id, content, options) {
        calls.followups.push({ parent, id, content, options })
        return 'followup-' + calls.followups.length
      },
      async listChildren() { return calls.starts.map(spec => ({ id: spec.childId, kind: 'child', mode: 'continuable' })) },
      async listDescendants() { return [] },
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
  for (const name of ['postman_bridge', 'postman_worker', 'postman_worker_interrupt', 'postman_worker_list', 'postman_worker_stop']) {
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

test('production and pilot supervisors can use Worker, but unrelated and delegated callers cannot', async () => {
  const f = fixture()
  const production = leader('production')
  const pilot = leader('pilot', 'postman-leader-ptc')
  for (const parent of [production, pilot]) {
    f.agents.set(parent.id, parent)
    const result = await f.tools.taskTool.execute({ task: 'work' }, exec(parent))
    assert.equal(result.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
    assert.equal(f.calls.starts.at(-1).request.parent, parent)
  }
  for (const caller of [
    leader('standard', 'standard'), leader('unrelated', 'other-preset'),
    { ...pilot, session: { header: { agentPreset: 'postman-leader-ptc', delegationDepth: 1 } } },
    { ...pilot, session: { header: { agentPreset: 'postman-leader-ptc', origin: 'subagent', delegationDepth: 0 } } },
    { id: 'pilot-child', session: { header: { agentPreset: 'postman-leader-ptc', origin: 'subagent', delegationDepth: 1, parentSession: pilot.id } } },
  ]) {
    assert.equal((await f.tools.taskTool.execute({ task: 'no' }, exec(caller))).status, 'POSTMAN_WORKER_CALLER_REJECTED')
    assert.equal((await f.tools.interruptTool.execute({ task: 'no' }, exec(caller))).status, 'POSTMAN_WORKER_CALLER_REJECTED')
    assert.equal((await f.tools.stopTool.execute({}, exec(caller))).status, 'POSTMAN_WORKER_CALLER_REJECTED')
  }
  assert.equal(f.calls.starts.length, 2)
  f.tools.dispose()
})

test('first task creates a child; second task follows up in the same durable Session', async () => {
  const { agents, calls, tools } = fixture()
  const a = leader('A'); agents.set('A', a)
  const first = await tools.taskTool.execute({ task: 'first' }, exec(a))
  assert.equal(first.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(first.workerSessionId, calls.starts[0].childId)
  assert.equal(first.created, true)
  assert.equal(first.messageId, 'message-1')
  assert.equal(first.model, 'gpt-6-luna')
  assert.equal(first.provider, 'spawn')
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
  assert.equal(calls.followups[0].content[0].text, 'second')
  assert.equal(calls.followups[0].options.source.senderSessionId, 'A')
})

test('redirect promises a safe step boundary without cancellation', () => {
  assert.match(fixture().tools.interruptTool.description, /without interrupting its current model\/tool step/)
})

test('interrupt is a non-cancelling FIFO follow-up to an active Worker', async () => {
  const context = { branch: 'task/postman-bound', worktree: 'C:/worktrees/bound' }
  const contexts = { get: id => id === 'A' ? context : undefined, isRestoring: () => false, hasActiveOperation: () => false }
  const f = fixture(contexts); const a = leader('A'); f.agents.set('A', a)
  const first = await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  f.agents.set(first.workerSessionId, { whenIdle() { throw new Error('must not wait for idle') } })
  const [second, third] = await Promise.all([
    f.tools.interruptTool.execute({ task: 'B' }, exec(a)),
    f.tools.interruptTool.execute({ task: 'C' }, exec(a)),
  ])
  assert.equal(second.status, 'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED')
  assert.equal(third.status, 'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED')
  assert.equal(second.interruptRequested, false)
  assert.equal(second.workerSessionId, first.workerSessionId)
  assert.deepEqual(f.calls.followups.map(call => call.content[0].text.slice(-1)), ['B', 'C'])
  assert.ok(f.calls.followups[0].content[0].text.includes('C:/worktrees/bound'))
  assert.equal(f.calls.interrupts.length, 0)
  assert.equal(f.calls.starts.length, 1)
})

test('cold Worker receives next-round follow-up without cancellation', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set('A', a)
  const first = await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  const redirected = await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))
  assert.equal(redirected.workerSessionId, first.workerSessionId)
  assert.deepEqual(f.calls.interrupts, [])
  assert.equal(f.calls.followups[0].id, first.workerSessionId)
})

test('interrupt without an active mapping never starts a Worker', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set('A', a)
  assert.equal((await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))).status,
    'POSTMAN_WORKER_INTERRUPT_NO_ACTIVE_WORKER')
  assert.equal(f.calls.starts.length, 0)
  assert.equal(f.calls.followups.length, 0)
  await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  assert.equal((await f.tools.stopTool.execute({}, exec(a))).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.equal((await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))).status,
    'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED')
})

test('redirect delivery failure preserves the same Worker mapping', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set('A', a)
  const first = await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  f.ctx.subagents.followup = async () => { throw new Error('delivery denied') }
  const failed = await f.tools.interruptTool.execute({ task: 'redirect' }, exec(a))
  assert.equal(failed.status, 'POSTMAN_WORKER_INTERRUPT_DELIVERY_FAILED')
  assert.equal(failed.workerSessionId, first.workerSessionId)
  assert.equal(f.calls.interrupts.length, 0)
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

test('ordinary stop immediately after acceptance rejects without drain or new Worker', async () => {
  const { agents, calls, tools } = fixture()
  const a = leader('A'); agents.set(a.id, a)
  const first = await tools.taskTool.execute({ task: 'first' }, exec(a))
  const stopped = await tools.stopTool.execute({}, exec(a))
  assert.equal(stopped.status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.deepEqual(calls.drains, [])
  assert.equal((await tools.stopTool.execute({}, exec(a))).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  const next = await tools.taskTool.execute({ task: 'next' }, exec(a))
  assert.equal(next.created, false)
  assert.equal(next.workerSessionId, first.workerSessionId)
})

test('admission failures do not corrupt mapping or create a second active child', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set(a.id, a)
  const originalStart = f.ctx.subagents.startContinuable
  f.ctx.subagents.startContinuable = async () => { throw new Error('cannot create') }
  const failedStart = await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  assert.equal(failedStart.status, 'POSTMAN_WORKER_START_FAILED')
  assert.equal((await f.tools.taskTool.execute({ task: 'first' }, exec(a))).status, 'POSTMAN_WORKER_BINDING_UNCERTAIN')
  f.ctx.subagents.startContinuable = originalStart
  // An ambiguous start keeps its slot until an explicit, verified release.
  assert.equal((await f.tools.stopTool.execute({ workerSessionId: failedStart.workerSessionId }, exec(a))).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  const f2 = fixture(); f2.agents.set(a.id, a)
  const accepted = await f2.tools.taskTool.execute({ task: 'first' }, exec(a))
  f2.ctx.subagents.followup = async () => { throw new Error('not admitted') }
  const failed = await f2.tools.taskTool.execute({ task: 'second' }, exec(a))
  assert.equal(failed.status, 'POSTMAN_WORKER_FOLLOWUP_FAILED')
  assert.equal(failed.workerSessionId, accepted.workerSessionId)
  assert.equal(f2.calls.starts.length, 1)
  f2.ctx.subagents.drainContinuableChildren = async () => { throw new Error('release failed') }
  const stop = await f2.tools.stopTool.execute({}, exec(a))
  assert.equal(stop.status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.equal(stop.workerSessionId, accepted.workerSessionId)
  assert.deepEqual(f2.calls.drains, [])
  f2.ctx.subagents.drainContinuableChildren = async () => undefined
  assert.equal((await f2.tools.stopTool.execute({}, exec(a))).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
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
test('stop queued behind admission cannot drain the accepted child', async () => {
  const f = fixture(); const a = leader('A'); f.agents.set(a.id, a)
  let accept
  const originalStart = f.ctx.subagents.startContinuable
  f.ctx.subagents.startContinuable = async spec => {
    f.calls.starts.push(spec)
    return new Promise(resolve => { accept = resolve })
  }
  const firstPromise = f.tools.taskTool.execute({ task: 'first' }, exec(a))
  while (!accept) await new Promise(resolve => setImmediate(resolve))
  const stopPromise = f.tools.stopTool.execute({}, exec(a))
  accept({ childId: f.calls.starts[0].childId, messageId: 'message-race' })
  const [first, stop] = await Promise.all([firstPromise, stopPromise])
  assert.equal(first.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(stop.status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.deepEqual(f.calls.drains, [])
  f.ctx.subagents.startContinuable = originalStart
  const next = await f.tools.taskTool.execute({ task: 'next' }, exec(a))
  assert.equal(next.created, false)
})

test('Bridge and Worker steer notices only to their live direct Leader', async () => {
  const binding = { branch: 'task/a', worktree: 'C:/a' }
  const contexts = { get: id => id === 'A' ? binding : undefined,
    child: id => id === 'bridge-1' ? binding : null }
  const f = fixture(contexts)
  const a = leader('A'); const b = leader('B')
  const received = []
  const followups = []
  a.steer = message => received.push(message)
  a.followup = message => followups.push(message)
  f.agents.set('A', a); f.agents.set('B', b)
  const first = await f.tools.taskTool.execute({ task: 'first' }, exec(a))
  const child = id => ({ id, session: { header: { origin: 'subagent', delegationDepth: 1, parentSession: 'A' } } })
  const worker = child(first.workerSessionId), bridge = child('bridge-1'), stranger = child('stranger')
  for (const item of [worker, bridge, stranger]) f.agents.set(item.id, item)
  const tool = createPostmanChildNotifyTool(f.ctx, contexts, f.tools)
  for (const [caller, text] of [[bridge, 'READY one'], [worker, 'progress'], [bridge, 'READY two']]) {
    const result = await tool.execute({ message: text }, exec(caller))
    assert.equal(result.status, 'PARENT_NOTIFICATION_ACCEPTED')
    assert.equal(result.messageId, received.at(-1).id)
  }
  assert.deepEqual(received.map(m => m.content[0].text.split(':\n').at(-1)),
    ['READY one', 'progress', 'READY two'])
  assert.ok(received.every(m => m.source.kind === 'subagent-report' && m.source.senderSessionId))
  assert.deepEqual(followups, [])
  assert.equal((await tool.execute({ message: 'intrusion' }, exec(stranger))).status, 'PARENT_NOTIFICATION_CALLER_REJECTED')
  f.agents.delete(bridge.id)
  assert.equal((await tool.execute({ message: 'stale' }, exec(bridge))).status, 'PARENT_NOTIFICATION_CALLER_REJECTED')
  assert.equal((await tool.execute({ message: '   ' }, exec(worker))).status, 'PARENT_NOTIFICATION_INVALID')
  a.steer = undefined
  assert.equal((await tool.execute({ message: 'no steering API' }, exec(worker))).status, 'PARENT_NOTIFICATION_CALLER_REJECTED')
  assert.equal(received.length, 3)
  assert.deepEqual(followups, [])
})

test('notify_parent isolates pilot and production Worker/Bridge children by live parent and task ownership', async () => {
  const production = leader('production'), pilot = leader('pilot', 'postman-leader-ptc')
  const bindings = new Map([[production.id, { branch: 'task/production' }],
    [pilot.id, { branch: 'task/pilot' }]])
  const bridgeBindings = new Map([['bridge-production', bindings.get(production.id)],
    ['bridge-pilot', bindings.get(pilot.id)]])
  const contexts = { get: id => bindings.get(id), child: id => bridgeBindings.get(id) ?? null }
  const f = fixture(contexts)
  const received = { production: [], pilot: [] }
  production.steer = message => received.production.push(message)
  pilot.steer = message => received.pilot.push(message)
  f.agents.set(production.id, production); f.agents.set(pilot.id, pilot)
  const workerProduction = await f.tools.taskTool.execute({ task: 'production' }, exec(production))
  const workerPilot = await f.tools.taskTool.execute({ task: 'pilot' }, exec(pilot))
  const child = (id, parentSession) => ({ id, session: { header: {
    origin: 'subagent', delegationDepth: 1, parentSession, agentPreset: parentSession === pilot.id
      ? 'postman-leader-ptc' : 'postman-leader',
  } } })
  const children = [child(workerProduction.workerSessionId, production.id),
    child('bridge-production', production.id), child(workerPilot.workerSessionId, pilot.id),
    child('bridge-pilot', pilot.id)]
  for (const item of children) f.agents.set(item.id, item)
  const notify = createPostmanChildNotifyTool(f.ctx, contexts, f.tools)
  for (const item of children) {
    const result = await notify.execute({ message: item.id }, exec(item))
    assert.equal(result.status, 'PARENT_NOTIFICATION_ACCEPTED')
    const inbox = received[item.session.header.parentSession]
    assert.equal(inbox.at(-1).source.senderSessionId, item.id)
  }
  assert.equal(received.production.length, 2)
  assert.equal(received.pilot.length, 2)
  for (const item of children) {
    const other = item.session.header.parentSession === production.id ? pilot.id : production.id
    const forged = { ...item, session: { header: { ...item.session.header, parentSession: other } } }
    f.agents.set(item.id, forged)
    assert.equal((await notify.execute({ message: 'cross-leader' }, exec(forged))).status,
      'PARENT_NOTIFICATION_CALLER_REJECTED')
    f.agents.set(item.id, item)
  }
  const wrongContext = bindings.get(production.id)
  bridgeBindings.set('bridge-pilot', wrongContext)
  assert.equal((await notify.execute({ message: 'wrong task' }, exec(children[3]))).status,
    'PARENT_NOTIFICATION_CALLER_REJECTED')
  assert.equal((await notify.execute({ message: 'arbitrary' }, exec(child('arbitrary', pilot.id)))).status,
    'PARENT_NOTIFICATION_CALLER_REJECTED')
  f.agents.set(children[2].id, { ...children[2] })
  assert.equal((await notify.execute({ message: 'stale live identity' }, exec(children[2]))).status,
    'PARENT_NOTIFICATION_CALLER_REJECTED')
  assert.deepEqual([received.production.length, received.pilot.length], [2, 2])
  f.tools.dispose()
})

test('bridge plugin registers all Worker tools and preserves boundary on creation', async () => {
  const registrations = new Map()
  const listeners = new Map()
  const a = leader('A')
  let restriction
  a.ctx = { tools: { restrict(value) { restriction = value; return () => undefined } } }
  const ctx = {
    agents: { get: id => id === a.id ? a : undefined, list: () => [a] },
    tools: { register(tool) { registrations.set(tool.name, tool) } },
    subagents: {},
    storageDomain: { async open() { const memory = createMemoryTaskRegistry(); return {
      table: () => ({ get: memory.get, entries: memory.entries, put: memory.create, update: memory.change }),
      close: memory.close,
    } } },
    effect: () => undefined,
    on(name, handler) { listeners.set(name, handler) },
  }
  await applyBridgePlugin(ctx)
  assert.deepEqual([...registrations.keys()].sort(), ['implementation_artifact_apply', 'notify_parent', 'postman_bridge', 'postman_bridge_status', 'postman_task_prepare', 'postman_task_restore', 'postman_worker', 'postman_worker_interrupt', 'postman_worker_list', 'postman_worker_stop', 'postman_yield'])
  assert.deepEqual(restriction.allow, postmanBridgeRestrictionForAgent(a).allow)
  assert.ok(listeners.has('agent-preset/selected'))
  assert.ok(listeners.has('agent/disposed'))
})

