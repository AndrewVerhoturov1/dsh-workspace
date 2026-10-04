import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { createPostmanWorkerTools, POSTMAN_SOL_WORKER_AGENT_OPTIONS } from './postman-worker.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { POSTMAN_LEADER_TOOL_ALLOWLIST, POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_PTC_ONLY_LEADER_TOOLS } from './postman-bridge-core.js'

const installed = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'npm/node_modules/@deepseek-ai/dsh')
const pkg = name => import(pathToFileURL(join(installed, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
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
  assert.match(spec.request.persona, /continuable Sol subagent/)
  assert.match(spec.request.persona, /report tool.*later tasks/s)
  assert.ok(spec.request.toolFilter.deny.includes('postman_sol_worker'))
  assert.ok(!spec.request.toolFilter.deny.includes('report'))
  assert.ok(!spec.request.toolFilter.deny.includes('write'))
  await f.run(f.tools.taskTool, { task: 'ordinary', createNew: true, workerType: 'sol' })
  assert.deepEqual(f.calls.starts[1].request.agentOptions, { provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'max' })
})

test('one Sol plus three Luna have separate atomic reservations, including pending Sol', async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers()
  const f = await fixture(t, { start: async spec => { if (spec.request.agentOptions.model === 'gpt-6.1-sol') { entered.resolve(); await gate.promise } } })
  const sol = f.run(f.tools.solTaskTool, { task: 'complex', createNew: true })
  await entered.promise
  const others = await Promise.all([1, 2, 3, 4].map(n => f.run(f.tools.taskTool, { task: 'Luna ' + n, createNew: true })))
  assert.deepEqual(others.map(r => r.status), ['POSTMAN_WORKER_TASK_ACCEPTED', 'POSTMAN_WORKER_TASK_ACCEPTED', 'POSTMAN_WORKER_TASK_ACCEPTED', 'POSTMAN_WORKER_LIMIT_REACHED'])
  assert.equal((await f.run(f.tools.solTaskTool, { task: 'second Sol', createNew: true })).status, 'POSTMAN_SOL_WORKER_LIMIT_REACHED')
  assert.equal(f.calls.starts.length, 4)
  gate.resolve(); const accepted = await sol
  assert.equal(accepted.created, true)
  assert.equal(Object.values(f.registry.get(f.parent.id).workers).filter(r => r.workerType === 'sol').length, 1)
  assert.equal((await f.run(f.tools.solTaskTool, { task: 'reuse without ID' })).workerSessionId, accepted.workerSessionId)
  const list = await f.run(f.tools.listTool)
  assert.deepEqual(list.workers.map(r => [r.workerType, r.model]), [['sol', 'gpt-6.1-sol'], ...[1, 2, 3].map(() => ['luna', 'gpt-6-luna'])])
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

test('only top-level Leaders receive direct Sol tool; both personas explicitly disallow automatic escalation', async t => {
  assert.ok(POSTMAN_LEADER_TOOL_ALLOWLIST.includes('postman_sol_worker'))
  assert.ok(POSTMAN_LEADER_ONLY_TOOL_NAMES.includes('postman_sol_worker'))
  assert.ok(!POSTMAN_PTC_ONLY_LEADER_TOOLS.includes('postman_sol_worker'))
  const f = await fixture(t)
  for (const agent of [{ ...f.parent, id: 'foreign' }, { ...f.parent, session: { header: { agentPreset: 'standard' } } },
    { ...f.parent, session: { header: { agentPreset: 'postman-leader', origin: 'subagent', delegationDepth: 1 } } }]) {
    assert.equal((await f.run(f.tools.solTaskTool, { task: 'forbidden' }, { agent })).status, 'POSTMAN_WORKER_CALLER_REJECTED')
  }
  assert.equal(f.calls.starts.length, 0)
  for (const preset of ['postman-leader', 'postman-leader-ptc']) {
    const text = readFileSync(new URL('../../../.agent-presets/' + preset + '/agent.cordis.yml', import.meta.url), 'utf8')
    assert.match(text, /only when the user explicitly asks to use Sol Worker/)
    assert.match(text, /no automatic Luna-to-Sol escalation/)
    assert.match(text, /Before the first Sol assignment and every new separate task.*ask_user_question/)
    assert.match(text, /Wait for a positive answer before calling postman_sol_worker/)
    assert.match(text, /refusal, cancellation or no answer means do not assign the task/)
    assert.match(text, /do not request a second system Allow once/)
  }
  const skill = readFileSync(new URL('../../../.agents/skills/postman-leader/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /Перед первым назначением и каждым новым отдельным заданием.*ask_user_question/)
  assert.match(skill, /Положительного ответа достаточно.*второго системного `Allow once` нет/)
})
