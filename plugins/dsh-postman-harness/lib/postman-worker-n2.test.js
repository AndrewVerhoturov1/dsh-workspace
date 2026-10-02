import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { createPostmanWorkerTools } from './postman-worker.js'
import { installPostmanWorkerReportObserver } from './postman-bridge.js'
import { openPostmanTaskRegistry } from './postman-task-registry.js'

const installed = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'),
  'npm/node_modules/@deepseek-ai/dsh')
const pkg = async name => import(pathToFileURL(join(installed, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
const { AgentRegistry } = await pkg('dsh-agent')
const { SessionStore } = await pkg('dsh-session')
const { JsonlSessionPersistence } = await pkg('dsh-session-persistence-jsonl')
const { SystemPrompt } = await pkg('dsh-system-prompt')
const { LlmRuntime, LlmAdapter } = await pkg('dsh-llm')
const { AgentLoop } = await pkg('dsh-agent-loop')
const { SubagentRuntime } = await pkg('dsh-subagent')
const { SessionProjectionRegistry } = await pkg('dsh-session-projection')
const { apply: spawn } = await pkg('dsh-subagent-spawn-in-process')
const { apply: nativeReport } = await pkg('dsh-tool-subagent-report')

const wait = () => Promise.withResolvers()
const signal = () => new AbortController().signal
const content = text => [{ type: 'text', text }]
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'postman-n2-'))

  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx, { tools: {} })
  new LlmRuntime(ctx); new JsonlSessionPersistence(ctx, { root: join(dir, 'sessions') })
  new SubagentRuntime(ctx); spawn(ctx, { providerName: 'spawn' }); nativeReport(ctx, { reportDelivery: 'next-step' })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const calls = new Map(), disposed = new Map(), startA = wait(), releasePeers = wait()
  ctx.on('agent/disposed', ({ agent }) => disposed.get(agent.id)?.resolve())
  class FakeAdapter extends LlmAdapter {
    async *stream() {
      const agent = ctx.agents.currentInitiator()
      const count = (calls.get(agent.id) ?? 0) + 1
      calls.set(agent.id, count)
      const label = agent.session.events.find(e => e.type === 'subagent/descriptor')?.data?.label
      if (label === 'A' && count === 1) await startA.promise
      if (['B', 'C'].includes(label)) await releasePeers.promise
      const block = count % 2 === 1 ? { type: 'tool-call', id: 'report-' + count, name: 'report',
        arguments: '{"output":"done"}' } : { type: 'text', text: 'later' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['codex'], new FakeAdapter())
  const backend = new JsonStorageBackend(join(dir, 'registry'))
  const registry = await openPostmanTaskRegistry(new DomainFacility({
    storage: { backend: { get: () => backend } }, emit() {} }, { backend: 'json', routes: {} }))
  const context = Object.freeze({ branch: 'task/isolate', worktree: dir, leaderSessionId: 'leader' })
  const contexts = { get: () => context, record: registry.get, changeRecord: registry.change,
    beginWorkerAdmission: () => true, endWorkerAdmission() {} }
  await registry.create('leader', { leaderSessionId: 'leader', repository: 'andrewverhoturov1/dsh-workspace',
    repositoryPath: dir, originUrl: 'https://github.com/AndrewVerhoturov1/dsh-workspace.git',
    branch: context.branch, worktree: dir, baseCommit: '0'.repeat(40), stage: 'ready',
    diagnostic: null, workers: {}, runner: { state: 'none', requestId: null }, bridge: null })
  const worker = createPostmanWorkerTools(ctx, undefined, contexts, options)
  ctx.tools.register(worker.taskTool); ctx.tools.register(worker.stopTool)
  installPostmanWorkerReportObserver(ctx, worker)
  const leader = ctx.agentLoop.create('leader', { provider: 'codex', model: 'gpt-6-luna' },
    { cwd: dir, agentPreset: 'postman-leader' })
  const exec = { agent: leader, signal: signal() }
  t.after(async () => { startA.resolve(); releasePeers.resolve(); await ctx.fiber.dispose();
    await registry.close(); await backend.close(); await rm(dir, { recursive: true, force: true }) })
  const start = async label => {
    const result = await worker.taskTool.execute({ task: label, label, createNew: true }, exec)
    assert.equal(result.status, 'POSTMAN_WORKER_TASK_ACCEPTED', JSON.stringify(result))
    return result.workerSessionId
  }
  const settled = async id => { if (ctx.agents.get(id)) {
    const gate = wait(); disposed.set(id, gate); await gate.promise
  }
    assert.equal(ctx.agents.get(id), undefined) }
  return { ctx, contexts, registry, worker, leader, exec, start, settled, calls, startA, releasePeers, disposed }
}

test('local cancellation uses native exact-child cutoff without approval or invented success', { timeout: 10000 }, async t => {
  const f = await fixture(t, { localDevelopment: true })
  const a = await f.start('A'), b = await f.start('B'), c = await f.start('C')
  f.startA.resolve(); await f.settled(a)
  const peers = [b, c].map(id => structuredClone(f.registry.get('leader').workers[id]))
  const before = f.calls.get(a)
  const result = await f.worker.stopTool.execute({ mode: 'cancel', workerSessionId: a }, f.exec)
  assert.equal(result.status, 'POSTMAN_WORKER_CANCELLED', JSON.stringify(result))
  assert.equal(result.taskCompleted, false); assert.equal(result.resultReported, false)
  assert.equal(result.durableSessionDeleted, false)
  assert.equal(f.registry.get('leader').workers[a], undefined)
  await assert.rejects(f.ctx.subagents.followup(f.leader, a, content('too late'),
    { source: { kind: 'user' }, signal: signal() }), /closed/)
  assert.equal(f.calls.get(a), before)
  assert.deepEqual([b, c].map(id => f.registry.get('leader').workers[id]), peers)
})

// Cold native send wins the child lock while close is inspecting descendants.
test('cold followup admitted before close keeps binding; subsequent reported work can close', { timeout: 10000 }, async t => {
  const f = await fixture(t), a = await f.start('A'), b = await f.start('B'), c = await f.start('C')
  f.startA.resolve()
  await f.settled(a)
  const peers = [b, c].map(id => structuredClone(f.registry.get('leader').workers[id]))
  const inspected = wait(), release = wait()
  const list = f.ctx.subagents.listDescendants.bind(f.ctx.subagents)
  f.ctx.subagents.listDescendants = async (...args) => {
    const value = await list(...args)
    if (args[0] === a) { inspected.resolve(); await release.promise }
    return value
  }
  const closing = f.worker.stopTool.execute({ workerSessionId: a }, f.exec)
  await inspected.promise
  const admitted = await f.ctx.subagents.followup(f.leader, a, content('native followup'),
    { source: { kind: 'user' }, signal: signal() })
  assert.ok(admitted)
  release.resolve()
  const result = await closing
  assert.equal(result.status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.ok(f.registry.get('leader').workers[a])
  await f.settled(a)
  assert.ok(f.calls.get(a) >= 3)
  assert.deepEqual([b, c].map(id => f.registry.get('leader').workers[id]), peers)
  f.ctx.subagents.listDescendants = list
  const after = await f.worker.stopTool.execute({ workerSessionId: a }, f.exec)
  assert.equal(after.status, 'POSTMAN_WORKER_STOPPED', JSON.stringify(after))
})

test('cold close wins cutoff: later native followup cannot resume exact A; B/C remain live', { timeout: 10000 }, async t => {
  const f = await fixture(t), a = await f.start('A'), b = await f.start('B'), c = await f.start('C')
  f.startA.resolve()
  await f.settled(a)
  const peers = [b, c].map(id => structuredClone(f.registry.get('leader').workers[id]))
  const before = f.calls.get(a)
  const result = await f.worker.stopTool.execute({ workerSessionId: a }, f.exec)
  assert.equal(result.status, 'POSTMAN_WORKER_STOPPED', JSON.stringify(result))
  assert.equal(result.durableSessionDeleted, false)
  await assert.rejects(f.ctx.subagents.followup(f.leader, a, content('too late'),
    { source: { kind: 'user' }, signal: signal() }), /closed/)
  assert.equal(f.ctx.agents.get(a), undefined)
  assert.equal(f.calls.get(a), before)
  assert.equal((await f.ctx.sessionPersistence.inspect(a)).meta.parentSession, 'leader')
  assert.deepEqual([b, c].map(id => f.registry.get('leader').workers[id]), peers)
  assert.ok(await f.ctx.subagents.followup(f.leader, b, content('B native'),
    { source: { kind: 'user' }, signal: signal() }))
})


test('queued native followup at stopping boundary loses exact-child cutoff', { timeout: 10000 }, async t => {
  const f = await fixture(t), a = await f.start('A'), b = await f.start('B'), c = await f.start('C')
  f.startA.resolve()
  await f.settled(a)
  const peers = [b, c].map(id => structuredClone(f.registry.get('leader').workers[id]))
  const reached = wait(), release = wait()
  const closeChild = f.ctx.subagents.closeContinuableChild.bind(f.ctx.subagents)
  f.ctx.subagents.closeContinuableChild = (parent, id, verify) => closeChild(parent, id, async () => {
    const ready = await verify()
    assert.equal(ready, true)
    assert.equal(f.registry.get('leader').workers[a].state, 'stopping')
    reached.resolve()
    await release.promise
    return ready
  })
  const closing = f.worker.stopTool.execute({ workerSessionId: a }, f.exec)
  await reached.promise
  const following = f.ctx.subagents.followup(f.leader, a, content('queued at stopping'),
    { source: { kind: 'user' }, signal: signal() })
  release.resolve()
  await assert.rejects(following, /closed/)
  assert.equal((await closing).status, 'POSTMAN_WORKER_STOPPED')
  assert.deepEqual([b, c].map(id => f.registry.get('leader').workers[id]), peers)
})

test('resident exact child closes through normal disposal without stopping B/C', { timeout: 10000 }, async t => {
  const f = await fixture(t), a = await f.start('A'), b = await f.start('B'), c = await f.start('C')
  f.startA.resolve()
  await f.settled(a)
  const sent = await f.ctx.subagents.followup(f.leader, a, content('resident native'),
    { source: { kind: 'user' }, signal: signal() })
  assert.ok(sent)
  const child = f.ctx.agents.get(a)
  assert.ok(child)
  await child.whenIdle()
  assert.equal(child.status, 'idle')
  const done = await f.worker.stopTool.execute({ workerSessionId: a }, f.exec)
  assert.equal(done.status, 'POSTMAN_WORKER_STOPPED', JSON.stringify(done))
  assert.equal(f.ctx.agents.get(a), undefined)
  assert.ok(f.registry.get('leader').workers[b] && f.registry.get('leader').workers[c])
})
