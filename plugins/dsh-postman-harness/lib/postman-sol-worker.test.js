import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { obsoleteSolPermission } from './fixtures/postman-stage3-contract.js'
import { createPostmanWorkerTools, POSTMAN_SOL_WORKER_AGENT_OPTIONS } from './postman-worker.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { POSTMAN_LEADER_TOOL_ALLOWLIST, POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_PTC_ONLY_LEADER_TOOLS } from './postman-bridge-core.js'

const installed = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'npm/node_modules/@deepseek-ai/dsh')
const sdkRequire = createRequire(process.env.DSH_CAPABILITY_SDK ?? join(installed, 'package.json'))
const pkg = name => import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/' + name)).href)
const { Context } = await pkg('cordis')
const { Session } = await pkg('dsh-session')

async function fixture(t, { start } = {}) {
  const native = new Context()
  const parent = { id: 'sol-leader', ctx: native, session: Session.create('sol-leader', [], {
    version: 0, id: 'sol-leader', createdAt: Date.now(), agentPreset: 'postman-leader', delegationDepth: 0,
  }) }
  parent.session.append('turn/start', { turn: 1 })
  const agents = new Map([[parent.id, parent]]), children = new Set()
  let requestOptions
  const calls = { starts: [], follows: [], closes: [] }
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { workers: {} })
  const context = Object.freeze({ branch: 'task/sol', worktree: 'C:/task/sol' })
  const contexts = { get: () => context, record: registry.get, changeRecord: registry.change }
  const ctx = { get: name => native.get(name), agents: { get: id => agents.get(id) },
    tools: { schemas: () => [...POSTMAN_LEADER_TOOL_ALLOWLIST, 'report', 'write'].map(name => ({ name })) },
    on(name, handler) { if (name === 'agent/request') requestOptions = handler; return () => {} },
    subagents: {
      async startContinuable(spec) { calls.starts.push(spec); if (start) await start(spec); children.add(spec.childId)
        return { childId: spec.childId, messageId: 'initial-' + calls.starts.length } },
      async followup(parent, id, content) { calls.follows.push({ parent, id, content }); return 'next-' + calls.follows.length },
      async listChildren() { return [...children].map(id => ({ kind: 'child', mode: 'continuable', id })) },
      async listDescendants() { return [] },
      async closeContinuableChild(_parent, id, check) { if (!await check()) return false
        calls.closes.push(id); children.delete(id); agents.delete(id); return true },
      async drainContinuableChildren() {},
    },
  }
  const make = () => createPostmanWorkerTools(ctx, undefined, contexts, { localDevelopment: true })
  const tools = make()
  t.after(async () => { tools.dispose(); await native.fiber.dispose() })
  const run = (tool, args = {}, exec = {}) => tool.execute(args, {
    agent: parent, signal: new AbortController().signal, callId: 'call-' + (parent.session.seq + 1), ...exec,
  })
  return { tools, make, run, calls, parent, agents, children, registry, ctx, context,
    options: (agent, config) => requestOptions({ agent }, async () => config) }
}

async function subtree(t) {
  const f = await fixture(t)
  const accepted = await f.run(f.tools.solTaskTool, { task: 'Sol subtree' })
  const sol = { id: accepted.workerSessionId, status: 'idle', inbox: { hasPending: false }, session: {
    header: { id: accepted.workerSessionId, origin: 'subagent', parentSession: f.parent.id, delegationDepth: 1 }, events: [] } }
  f.agents.set(sol.id, sol); await f.tools.confirmActivation(sol)
  const ids = []
  for (let n = 0; n < 2; n++) {
    const r = await f.run(f.tools.taskTool, { task: 'child ' + n, createNew: true }, { agent: sol })
    assert.equal(r.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
    const child = { id: r.workerSessionId, status: 'idle', inbox: { hasPending: false }, session: {
      header: { id: r.workerSessionId, origin: 'subagent', parentSession: sol.id, delegationDepth: 2 }, events: [] } }
    f.agents.set(child.id, child); ids.push(child.id)
  }
  f.ctx.subagents.inspectClosedContinuableChild = async (_parent, id) => f.calls.closes.includes(id) && !f.agents.has(id)
  return { ...f, sol, ids }
}

test('cascade close preflights every exact child before mutations and never cancels blockers', async t => {
  for (const state of ['running', 'pending', 'unknown', 'uncertain']) {
    const f = await subtree(t), id = f.ids[1]
    if (state === 'running') f.agents.get(id).status = 'running'
    if (state === 'pending') f.agents.get(id).inbox.hasPending = true
    if (state === 'unknown') f.agents.delete(id)
    if (state === 'uncertain') await f.registry.change(f.parent.id, row => ({ ...row, workers: { ...row.workers, [id]: { ...row.workers[id], delivery: 'unknown' } } }))
    const result = await f.run(f.tools.stopTool, { mode: 'close', workerSessionId: f.sol.id, cascade: true })
    assert.equal(result.status, 'POSTMAN_WORKER_CASCADE_BLOCKED')
    assert.ok(result.blockers.some(b => b.workerSessionId === id))
    assert.deepEqual(f.calls.closes, [])
    assert.equal(Object.keys(f.registry.get(f.parent.id).workers).length, 3)
  }
})

test('cascade close retires children then Sol; retains audit and Leader cannot interrupt grandchild', async t => {
  const f = await subtree(t)
  assert.equal((await f.run(f.tools.interruptTool, { workerSessionId: f.ids[0], task: 'foreign' })).status, 'POSTMAN_WORKER_TARGET_UNKNOWN')
  const result = await f.run(f.tools.stopTool, { mode: 'close', workerSessionId: f.sol.id, cascade: true })
  assert.equal(result.status, 'POSTMAN_WORKER_STOPPED')
  assert.equal(result.taskCompleted, false)
  assert.deepEqual(f.calls.closes, [...f.ids, f.sol.id])
  const row = f.registry.get(f.parent.id)
  assert.deepEqual(row.workers, {})
  assert.equal(row.retiredWorkers.length, 3)
  assert.ok(row.retiredWorkers.slice(0, 2).every(b => b.ownerSessionId === f.sol.id))
})

test('cascade cancel active subtree settles fully; partial release retains truthful uncertain bindings', async t => {
  const f = await subtree(t)
  f.sol.status = 'running'; f.agents.get(f.ids[0]).status = 'running'
  const close = f.ctx.subagents.closeContinuableChild
  f.ctx.subagents.closeContinuableChild = async (parent, id, check) => {
    if (id === f.ids[1]) throw new Error('settlement failed')
    return close(parent, id, check)
  }
  const partial = await f.run(f.tools.stopTool, { mode: 'cancel', workerSessionId: f.sol.id, cascade: true })
  assert.equal(partial.status, 'POSTMAN_WORKER_CASCADE_PARTIAL')
  assert.deepEqual(f.calls.closes, [f.ids[0]])
  assert.equal(f.registry.get(f.parent.id).workers[f.sol.id].state, 'uncertain')
  f.ctx.subagents.closeContinuableChild = close
  const result = await f.run(f.tools.stopTool, { mode: 'cancel', workerSessionId: f.sol.id, cascade: true })
  assert.equal(result.status, 'POSTMAN_WORKER_CANCELLED')
  assert.deepEqual(f.calls.closes, [...f.ids, f.sol.id])
  const fresh = await f.run(f.tools.freshTool, { workerSessionId: f.sol.id, task: 'new authorized Sol' })
  assert.equal(fresh.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.notEqual(fresh.workerSessionId, f.sol.id)
  assert.equal(fresh.workerType, 'sol')
})

test('fresh retires settled owned workers only, replaces Sol ID and retains Secretary ledger', async t => {
  const f = await subtree(t)
  await f.registry.change(f.parent.id, row => ({ ...row, secretaryLedger: { revision: 7, content: 'private ledger' } }))
  const result = await f.run(f.tools.freshTool, { workerSessionId: f.sol.id, task: 'new task', retireOwnedWorkers: true })
  assert.equal(result.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(result.fresh, true); assert.notEqual(result.workerSessionId, f.sol.id)
  assert.deepEqual(f.calls.closes, [...f.ids, f.sol.id])
  assert.equal(f.registry.get(f.parent.id).secretaryLedger.content, 'private ledger')
  assert.ok(!JSON.stringify(f.calls.starts.at(-1).request.prompt).includes(f.sol.id))
})

test('cascade cancel never claims full settlement for a resident child or unsupported cutoff', async t => {
  const f = await subtree(t)
  const close = f.ctx.subagents.closeContinuableChild
  delete f.ctx.subagents.closeContinuableChild
  const unsupported = await f.run(f.tools.stopTool, { mode: 'cancel', workerSessionId: f.sol.id, cascade: true })
  assert.equal(unsupported.status, 'POSTMAN_WORKER_LIFECYCLE_UNSUPPORTED')
  assert.equal(f.registry.get(f.parent.id).workers[f.sol.id].state, 'ready')
  f.ctx.subagents.closeContinuableChild = async (parent, id, check) => {
    const resident = f.agents.get(id)
    const result = await close(parent, id, check)
    f.agents.set(id, resident)
    return result
  }
  const partial = await f.run(f.tools.stopTool, { mode: 'cancel', workerSessionId: f.sol.id, cascade: true })
  assert.equal(partial.status, 'POSTMAN_WORKER_CASCADE_PARTIAL')
  assert.equal(f.registry.get(f.parent.id).workers[f.ids[0]].state, 'uncertain')
  assert.ok(f.registry.get(f.parent.id).workers[f.sol.id])
})

test('fresh active subtree rejects before retirement, cascade only accepts exact Leader Sol', async t => {
  const f = await subtree(t)
  f.agents.get(f.ids[0]).status = 'running'
  const fresh = await f.run(f.tools.freshTool, { workerSessionId: f.sol.id, task: 'fresh', retireOwnedWorkers: true })
  assert.equal(fresh.status, 'POSTMAN_WORKER_CASCADE_BLOCKED')
  assert.deepEqual(f.calls.closes, [])
  const wrong = await f.run(f.tools.stopTool, { workerSessionId: f.ids[0], cascade: true }, { agent: f.sol })
  assert.equal(wrong.status, 'POSTMAN_WORKER_CASCADE_TARGET_REJECTED')
})

test('teamSnapshot reads bounded durable/live rows without recovery or private contents', async t => {
  const f = await subtree(t)
  await f.run(f.tools.secretaryTool, { task: 'secret facts' })
  await f.run(f.tools.taskTool, { task: 'secret task', createNew: true })
  await f.registry.change(f.parent.id, row => ({ ...row, secretaryLedger: { revision: 4, content: 'private ledger' } }))
  const before = JSON.stringify(f.registry.get(f.parent.id))
  f.ctx.subagents.listChildren = () => { throw new Error('snapshot cannot enumerate') }
  const result = f.tools.teamSnapshot(f.parent)
  assert.equal(result.status, 'POSTMAN_TEAM_STATUS')
  assert.equal(result.secretary.ledgerRevision, 4)
  assert.equal(result.workers.used, 1); assert.equal(result.sol.ownedWorkers.used, 2)
  assert.equal(result.sol.ownedWorkers.states.idle, 2)
  assert.deepEqual(result.workers.rows[0].budget, { used: 0, soft: 12, hard: 16, exhausted: false })
  assert.ok(!JSON.stringify(result).includes('secret task'))
  assert.ok(!JSON.stringify(result).includes('private ledger'))
  assert.equal(JSON.stringify(f.registry.get(f.parent.id)), before)
})

test('Sol pins model/xhigh, shared worktree, persona and transport-only deny; Luna remains unchanged', async t => {
  const f = await fixture(t)
  const receipt = await f.run(f.tools.solTaskTool, { task: 'Complex task' }, { callId: 'exact-sol-call' })
  assert.equal(receipt.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(receipt.workerType, 'sol'); assert.equal(receipt.model, 'gpt-6.1-sol')
  const spec = f.calls.starts[0]
  assert.equal(spec.provider, 'spawn'); assert.equal(spec.childId, receipt.workerSessionId)
  assert.deepEqual(spec.request.agentOptions, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' })
  assert.deepEqual(spec.request.agentOptions, POSTMAN_SOL_WORKER_AGENT_OPTIONS)
  assert.ok(spec.request.prompt[0].text.includes('task/sol') && spec.request.prompt[0].text.includes('C:/task/sol'))
  assert.match(spec.request.persona, /Postman Sol Worker/)
  assert.match(spec.request.persona, /Host-injected canonical role skill/)
  assert.ok(spec.request.toolFilter.deny.includes('postman_sol_worker'))
  assert.ok(!spec.request.toolFilter.deny.includes('report'))
  assert.ok(!spec.request.toolFilter.deny.includes('write'))
  await f.run(f.tools.taskTool, { task: 'ordinary', createNew: true, workerType: 'sol' })
  assert.deepEqual(f.calls.starts[1].request.agentOptions, { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'low' })
})

test('one Sol plus two Luna have separate atomic reservations, including pending Sol', async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers()
  const f = await fixture(t, { start: async spec => { if (spec.request.agentOptions.model === 'gpt-6.1-sol') { entered.resolve(); await gate.promise } } })
  const sol = f.run(f.tools.solTaskTool, { task: 'complex', createNew: true })
  await entered.promise
  const others = await Promise.all([1, 2, 3].map(n => f.run(f.tools.taskTool, { task: 'Luna ' + n, createNew: true })))
  assert.deepEqual(others.map(r => r.status), ['POSTMAN_WORKER_TASK_ACCEPTED', 'POSTMAN_WORKER_TASK_ACCEPTED', 'POSTMAN_WORKER_LIMIT_REACHED'])
  assert.equal((await f.run(f.tools.solTaskTool, { task: 'second Sol', createNew: true })).status, 'POSTMAN_SOL_WORKER_LIMIT_REACHED')
  assert.equal(f.calls.starts.length, 3)
  gate.resolve(); const accepted = await sol
  assert.equal(accepted.created, true)
  assert.equal(Object.values(f.registry.get(f.parent.id).workers).filter(r => r.workerType === 'sol').length, 1)
  assert.equal((await f.run(f.tools.solTaskTool, { task: 'reuse without ID' })).workerSessionId, accepted.workerSessionId)
  const list = await f.run(f.tools.listTool)
  assert.deepEqual(list.workers.map(r => [r.workerType, r.model]), [['sol', 'gpt-6.1-sol'], ...[1, 2].map(() => ['luna', 'gpt-6-luna'])])
})

test('Sol creation and follow-up do not access the Harness approval service', async t => {
  const f = await fixture(t)
  assert.equal(f.ctx.get('approval'), undefined)
  const get = f.ctx.get
  f.ctx.get = name => {
    assert.notEqual(name, 'approval', 'Sol assignments must not look up ApprovalService')
    return get(name)
  }
  const first = await f.run(f.tools.solTaskTool, { task: 'first' })
  assert.equal(first.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  const next = await f.run(f.tools.solTaskTool, { task: 'next', workerSessionId: first.workerSessionId })
  assert.equal(next.status, 'POSTMAN_WORKER_TASK_ACCEPTED'); assert.equal(next.created, false)
  assert.equal(f.calls.starts.length, 1); assert.equal(f.calls.follows.length, 1)
  assert.equal(f.calls.follows[0].id, first.workerSessionId)
})

test('ordinary task/interrupt cannot deliver to Sol, before or after runtime restart; legacy Luna remains Luna', async t => {
  const f = await fixture(t)
  const sol = await f.run(f.tools.solTaskTool, { task: 'first' })
  for (const worker of [f.tools, f.make()]) {
    for (const tool of [worker.taskTool, worker.interruptTool]) {
      assert.equal((await f.run(tool, { task: 'bypass', workerSessionId: sol.workerSessionId })).status, 'POSTMAN_SOL_WORKER_TOOL_REQUIRED')
    }
    assert.equal((await f.run(worker.interruptTool, { task: 'unaddressed bypass' })).status, 'POSTMAN_SOL_WORKER_TOOL_REQUIRED')
  }
  assert.equal(f.calls.follows.length, 0)
  const luna = await f.run(f.tools.taskTool, { task: 'Luna without ID' })
  assert.equal(luna.workerType, 'luna'); assert.equal(luna.created, true)
  await f.registry.change(f.parent.id, row => { const binding = { ...row.workers[luna.workerSessionId] }; delete binding.workerType
    return { ...row, workers: { ...row.workers, [luna.workerSessionId]: binding } } })
  const restarted = f.make()
  assert.equal((await f.run(restarted.taskTool, { task: 'legacy next' })).workerSessionId, luna.workerSessionId)
  assert.equal((await f.run(restarted.solTaskTool, { task: 'wrong type', workerSessionId: luna.workerSessionId })).status, 'POSTMAN_WORKER_TYPE_MISMATCH')
  assert.equal(f.calls.follows.length, 1)
  restarted.dispose()
})

test('shared list/stop operate on Sol without approval and keep peer/durable sessions; cold request forces xhigh', async t => {
  const f = await fixture(t)
  const sol = await f.run(f.tools.solTaskTool, { task: 'first' })
  f.tools.dispose(); const restarted = f.make()
  const next = await f.run(restarted.solTaskTool, { task: 'cold next', workerSessionId: sol.workerSessionId })
  assert.equal(next.workerSessionId, sol.workerSessionId); assert.equal(next.created, false)
  assert.equal(f.calls.starts.length, 1)
  const child = { id: sol.workerSessionId, status: 'idle', inbox: { hasPending: false }, session: {
    header: { id: sol.workerSessionId, origin: 'subagent', delegationDepth: 1, parentSession: f.parent.id }, events: [],
  } }
  f.agents.set(child.id, child); await restarted.confirmActivation(child)
  const request = await f.options(child, { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' })
  assert.equal(request.reasoningEffort, 'xhigh')
  const luna = await f.run(restarted.taskTool, { task: 'peer', createNew: true })
  assert.equal((await f.run(restarted.listTool)).workers.length, 2)
  const stop = await f.run(restarted.stopTool, { mode: 'close', workerSessionId: sol.workerSessionId })
  assert.equal(stop.status, 'POSTMAN_WORKER_STOPPED'); assert.equal(stop.durableSessionDeleted, false)
  assert.deepEqual(f.calls.closes, [sol.workerSessionId])
  assert.deepEqual((await f.run(restarted.listTool)).workers.map(r => r.workerSessionId), [luna.workerSessionId])
  restarted.dispose()
})

test('only top-level Leaders receive direct Sol tool outside PTC', async t => {
  assert.ok(POSTMAN_LEADER_TOOL_ALLOWLIST.includes('postman_sol_worker'))
  assert.ok(POSTMAN_LEADER_ONLY_TOOL_NAMES.includes('postman_sol_worker'))
  assert.ok(POSTMAN_PTC_ONLY_LEADER_TOOLS.includes('postman_sol_worker'))
  const f = await fixture(t)
  for (const agent of [{ ...f.parent, id: 'foreign' }, { ...f.parent, session: { header: { agentPreset: 'standard' } } },
    { ...f.parent, session: { header: { agentPreset: 'postman-leader', origin: 'subagent', delegationDepth: 1 } } }]) {
    assert.equal((await f.run(f.tools.solTaskTool, { task: 'forbidden' }, { agent })).status, 'POSTMAN_WORKER_CALLER_REJECTED')
  }
  assert.equal(f.calls.starts.length, 0)
})

for (const preset of ['postman-leader', 'postman-leader-ptc']) {
  test(preset + ' selects expensive Sol only within an approved execution plan, not a role permission gate', () => {
    const text = readFileSync(new URL('../../../.agent-presets/' + preset + '/agent.cordis.yml', import.meta.url), 'utf8')
    assert.match(text, /Every new non-trivial task: Leader routing decision -> compact execution plan -> explicit user approval -> execution/)
    assert.match(text, /Before approval only minimal necessary Leader read-only understanding/)
    assert.match(text, /no Worker\/Secretary\/Sol creation or plan delegation/)
    assert.match(text, /Sol is an expensive Leader-selectable route within the approved execution plan/)
    assert.match(text, /no separate role permission/i)
    assert.match(text, /cheapest reliable route/)
    assert.match(text, /unknown != complex/)
    assert.match(text, /Direct Sol is allowed for obviously difficult local engineering\/review/)
    assert.match(text, /Preapproved conditional Sol escalation and same-scope continuation need no repeated approval/)
    assert.match(text, /STOP -> revised plan -> approval/)
    assert.doesNotMatch(text, obsoleteSolPermission)
  })
}

test('Leader skill preserves plan approval across continuation and fresh without blanket future-task permission', () => {
  const skill = readFileSync(new URL('../../../.agents/skills/postman-leader/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /Leader routing decision → компактный execution plan → явное user approval → execution/)
  assert.match(skill, /отдельное разрешение на роль не требуется/)
  assert.match(skill, /Preapproved conditional Sol escalation не требует отдельного разрешения/)
  assert.match(skill, /postman_sol_worker[^.]*не обращается[^.]*ApprovalService/)
  assert.match(skill, /не меняй permission preset[^.]*approval: ask\/never[^.]*глобальную permission-систему/i)
  assert.match(skill, /Не используй обычные[^.]*postman_worker[^.]*postman_worker_interrupt[^.]*для Sol/)
  const freshContext = skill.slice(skill.indexOf('## 9. Lifecycle'), skill.indexOf('## 10. Bridge'))
  assert.match(freshContext, /Approved plan сохраняется при compact\/fresh/)
  assert.match(freshContext, /fresh не даёт blanket approval для новой независимой задачи или material change/)
  assert.doesNotMatch(skill, obsoleteSolPermission)
})

test('Sol tool description and localDevelopment preserve initial plan approval, not obsolete role permission', async t => {
  const f = await fixture(t)
  const description = f.tools.solTaskTool.description
  assert.match(description, /expensive Sol Worker/)
  assert.match(description, /selected by Leader within an approved execution plan/)
  assert.match(description, /No separate Sol role permission/)
  assert.match(description, /preapproved conditional escalation and same-scope continuation need no repeated approval/)
  assert.match(description, /unknown != complex/)
  const bridge = readFileSync(new URL('./postman-bridge.js', import.meta.url), 'utf8')
  assert.match(bridge, /does not bypass initial execution-plan approval/)
  assert.match(bridge, /Before approval: minimal necessary Leader read-only understanding only/)
  assert.match(bridge, /material cost\/scope\/access\/destructive-operation\/transport changes: STOP -> revised plan -> approval/)
  for (const text of [description, bridge]) assert.doesNotMatch(text, obsoleteSolPermission)
})
