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
import { createPostmanYieldTool, installPostmanWorkerReportObserver } from './postman-bridge.js'
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

// Services and model run only inside this disposable Cordis tree; no provider or Web transport.
test('native manager auto-wakes yielding Leader on Worker report and releases Agent', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'postman-real-cycle-'))
  t.after(async () => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx, { tools: {} })
  new LlmRuntime(ctx); new JsonlSessionPersistence(ctx, { root: join(dir, 'sessions') })
  new SubagentRuntime(ctx); spawn(ctx, { providerName: 'spawn' }); nativeReport(ctx, { reportDelivery: 'next-step' })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  assert.ok(ctx.agents && ctx.subagents && ctx.sessionPersistence && ctx.tools && ctx.llm)
  const released = Promise.withResolvers(), closed = Promise.withResolvers(), peersMayFinish = Promise.withResolvers()
  const peerIds = new Set()
  ctx.on('session/event', (session, event) => {
    if (session.header.id === 'leader' && event.type === 'tool/result' &&
        event.data.message?.source?.callId === 'close') closed.resolve(event.data.message)
  })
  const calls = new Map()
  const statuses = []
  ctx.on('agent/disposed', ({ agent }) => { if (agent.id !== 'leader') released.resolve(agent.id) })
  class FakeAdapter extends LlmAdapter {
    async resolveModel(provider,model){return {provider,id:model,name:model,reasoning:{efforts:[{id:'low',name:'Low'}]}}}
    async *stream() {
      const agent = ctx.agents.currentInitiator()
      const count = (calls.get(agent.id) ?? 0) + 1
      calls.set(agent.id, count)
      let block
      if (['B', 'C'].includes(agent.session.events.find(e => e.type === 'subagent/descriptor')?.data?.label)) {
        await peersMayFinish.promise
        block = { type: 'text', text: 'peer still mapped' }
      } else if (agent.id === 'leader' && count === 1) block = { type: 'tool-call', id: 'assign',
        name: 'postman_worker', arguments: '{"task":"Inspect","createNew":true}' }
      else if (agent.id === 'leader' && count === 2) {
        assert.equal((await worker.taskTool.execute({ task: 'fourth', createNew: true },
          { agent, signal: new AbortController().signal })).status, 'POSTMAN_WORKER_LIMIT_REACHED')
        block = { type: 'tool-call', id: 'yield', name: 'postman_yield', arguments: '{}' }
      }
      else if (agent.id !== 'leader' && count === 1) {
        const readiness=Promise.withResolvers();ctx.on('session/event',(s,e)=>{if(s.id==='leader'&&e.type==='tool/result'&&e.data.message?.source.callId==='yield')readiness.resolve()})
        await readiness.promise
        block = { type: 'tool-call', id: 'report',
        name: 'report', arguments: '{"output":"done"}' }
      } else if (agent.id === 'leader' && count === 3) {
        await released.promise
        block = { type: 'tool-call', id: 'close', name: 'postman_worker_stop',
          arguments: JSON.stringify({ workerSessionId: await released.promise, mode: 'close' }) }
      } else block = { type: 'text', text: 'done' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['codex'], new FakeAdapter())
  const backend = new JsonStorageBackend(join(dir, 'registry'))
  const domain = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} },
    { backend: 'json', routes: {} })
  const registry = await openPostmanTaskRegistry(domain)
  const context = Object.freeze({ branch: 'task/isolate', worktree: dir, leaderSessionId: 'leader' })
  const contexts = { get: () => context, record: registry.get, changeRecord: registry.change,
    beginWorkerAdmission: () => true, endWorkerAdmission() {} }
  await registry.create('leader', { leaderSessionId: 'leader', repository: 'andrewverhoturov1/dsh-workspace',
    repositoryPath: dir, originUrl: 'https://github.com/AndrewVerhoturov1/dsh-workspace.git',
    branch: context.branch, worktree: dir, baseCommit: '0'.repeat(40), stage: 'ready',
    diagnostic: null, workers: {}, runner: { state: 'none', requestId: null }, bridge: null })
  const worker = createPostmanWorkerTools(ctx, undefined, contexts)
  ctx.on('agent/created',async({agent})=>{await worker.confirmActivation(agent)})
  const nativeStart=ctx.subagents.startContinuable.bind(ctx.subagents)
  ctx.subagents.startContinuable=async spec=>{const accepted=await nativeStart(spec);await ctx.sessionPersistence.append(accepted.childId,[]);return accepted}
  ctx.tools.register(worker.taskTool); ctx.tools.register(worker.stopTool)
  ctx.tools.register(createPostmanYieldTool(ctx))
  installPostmanWorkerReportObserver(ctx, worker)
  const leader = ctx.agentLoop.create('leader', { provider: 'codex', model: 'gpt-6-luna' },
    { cwd: dir, agentPreset: 'postman-leader' })
  assert.equal(ctx.agents.get('leader'), leader)
  for (const label of ['B']) {
    // Reserve one independent real child before the model issues A's task.
    const accepted = await worker.taskTool.execute({ task: label, createNew: true, label },
      { agent: leader, signal: new AbortController().signal })
    assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
    peerIds.add(accepted.workerSessionId)
  }
  leader.followup({ id: 'initial', role: 'user', source: { kind: 'user', form: 'direct' },
    content: [{ type: 'text', text: 'Begin' }] })
  await closed.promise
  await leader.whenIdle()
  statuses.push(...leader.session.events.filter(e => e.type === 'tool/result').map(e => e.data.message))
  assert.ok(statuses.some(x => x.source?.callId === 'yield'))
  assert.ok(statuses.some(x => x.source?.callId === 'close'))
  const childId = await released.promise
  const closeResult = statuses.find(x => x.source?.callId === 'close')
  const inspected = await ctx.sessionPersistence.inspect(childId)
  const value = JSON.parse(closeResult.content[0].content[0].text)
  assert.equal(value.status, 'POSTMAN_WORKER_STOPPED', JSON.stringify(value))
  assert.equal(inspected.events.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(inspected.events.filter(e => e.type === 'turn/end').length, 1)
  assert.equal(ctx.agents.get(childId), undefined)
  assert.deepEqual(new Set(Object.keys(registry.get('leader').workers)), peerIds)
  const peerBefore = Object.fromEntries([...peerIds].map(id => [id, structuredClone(registry.get('leader').workers[id])]))
  assert.ok(leader.session.events.some(e => e.type === 'user/message' &&
    e.data.source?.kind === 'subagent-report' && e.data.source.senderSessionId === childId))
  assert.equal(leader.session.events.filter(e => e.type === 'turn/start').length, 2)
  assert.equal(leader.session.events.some(e => e.type === 'assistant/message' &&
    !e.data.message.content.length), false)
  peersMayFinish.resolve()
  await ctx.fiber.dispose(); await registry.close(); await backend.close()
  const cold = new Context(); new SessionStore(cold)
  new JsonlSessionPersistence(cold, { root: join(dir, 'sessions') })
  const saved = await cold.sessionPersistence.inspect(childId)
  assert.equal(saved.meta.parentSession, 'leader')
  assert.equal(saved.events.filter(e => e.type === 'turn/end').length, 1)
  const reopenedBackend = new JsonStorageBackend(join(dir, 'registry'))
  const reopened = await openPostmanTaskRegistry(new DomainFacility({
    storage: { backend: { get: () => reopenedBackend } }, emit() {} }, { backend: 'json', routes: {} }))
  assert.deepEqual(Object.keys(reopened.get('leader').workers).sort(), [...peerIds].sort())
  for (const id of peerIds) assert.deepEqual(reopened.get('leader').workers[id], peerBefore[id])
  await reopened.close(); await cold.fiber.dispose(); await reopenedBackend.close()
})
