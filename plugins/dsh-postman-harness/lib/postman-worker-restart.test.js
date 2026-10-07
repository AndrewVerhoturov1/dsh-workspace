import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createPostmanWorkerTools } from './postman-worker.js'
import { installPostmanWorkerReportObserver } from './postman-bridge.js'
import { IMPLEMENTATION_REPOSITORY, createImplementationArtifactApplyTool } from './implementation-artifact.js'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createMemoryTaskRegistry, openPostmanTaskRegistry } from './postman-task-registry.js'

const nativeRoot = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'npm/node_modules/@deepseek-ai/dsh')
const nativePkg = async name => import(pathToFileURL(join(nativeRoot, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)

const signal = new AbortController().signal
const leader = { id: 'leader-restart', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
const context = Object.freeze({ leaderSessionId: leader.id, repository: 'andrewverhoturov1/dsh-workspace',
  branch: 'task/postman-' + 'a'.repeat(32), worktree: 'C:/task', baseCommit: 'a'.repeat(40) })

async function fixture(parent = leader) {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { ...context, leaderSessionId: parent.id, repositoryPath: 'C:/repo', originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
    stage: 'ready', diagnostic: null, workers: {}, runner: { state: 'none', requestId: null }, bridge: null })
  const taskContext = Object.freeze({ ...context, leaderSessionId: parent.id })
  const contexts = { get: () => taskContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false }
  const calls = { starts: [], followups: [], children: new Set() }
  const ctx = { agents: { get: id => id === parent.id ? parent : undefined },
    tools: { schemas: () => [{ name: 'postman_bridge' }, { name: 'postman_send_current_turn' }] },
    subagents: {
      async listChildren() { return [...calls.children].map(id => ({ kind: 'child', mode: 'continuable', id })) },
      async startContinuable(spec) { calls.starts.push(spec); calls.children.add(spec.childId)
        return { childId: spec.childId, messageId: 'initial' } },
      async followup(_parent, id) { calls.followups.push(id); return 'followup-' + calls.followups.length },
      async drainContinuableChildren() {},
    },
  }
  return { contexts, registry, calls, ctx, tool: () => createPostmanWorkerTools(ctx, undefined, contexts) }
}

const task = (worker, text = 'new task', parent = leader) => worker.taskTool.execute({ task: text }, { agent: parent, signal })

test('reserved exact Worker id survives a new runtime without duplicate creation', async () => {
  const f = await fixture()
  const a = f.tool()
  const first = await task(a, 'first')
  assert.equal(first.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(first.workerSessionId, f.calls.starts[0].childId)
  assert.equal(f.registry.get(leader.id).workers[first.workerSessionId].id, first.workerSessionId)
  a.dispose()
  const b = f.tool()
  const next = await task(b)
  assert.equal(next.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(next.created, false)
  assert.equal(next.workerSessionId, first.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
  assert.deepEqual(f.calls.followups, [first.workerSessionId])
})

test('pilot supervisor reuses exact durable Worker binding after runtime restart', async () => {
  const pilot = { id: 'pilot-restart', session: { header: { agentPreset: 'postman-leader-ptc', delegationDepth: 0 } } }
  const f = await fixture(pilot)
  const before = f.tool()
  const first = await task(before, 'pilot initial', pilot)
  assert.equal(first.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(first.created, true)
  assert.equal(f.calls.starts[0].request.parent, pilot)
  assert.equal(first.workerSessionId, f.registry.get(pilot.id).workers[first.workerSessionId].id)
  before.dispose()
  const restarted = f.tool()
  const next = await task(restarted, 'pilot follow-up', pilot)
  assert.equal(next.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(next.created, false)
  assert.equal(next.workerSessionId, first.workerSessionId)
  assert.deepEqual(f.calls.followups, [first.workerSessionId])
  assert.equal(f.calls.starts.length, 1)
  restarted.dispose()
})

test('pilot Worker binding survives reopening the JSON storage domain', async t => {
  const pilot = { id: 'pilot-json', session: { header: { agentPreset: 'postman-leader-ptc', delegationDepth: 0 } } }
  const root = await mkdtemp(join(tmpdir(), 'postman-pilot-worker-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const domainCtx = { storage: { backend: { get: () => backend } }, emit() {} }
  const domain = () => new DomainFacility(domainCtx, { backend: 'json', routes: {} })
  const firstRegistry = await openPostmanTaskRegistry(domain())
  const pilotContext = Object.freeze({ ...context, leaderSessionId: pilot.id })
  await firstRegistry.create(pilot.id, { ...pilotContext,
    repositoryPath: 'C:/repo', originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
    stage: 'ready', diagnostic: null, workers: {}, runner: { state: 'none', requestId: null }, bridge: null })
  const f = await fixture(pilot)
  const contexts = registry => ({ get: () => pilotContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false })
  const before = createPostmanWorkerTools(f.ctx, undefined, contexts(firstRegistry))
  const first = await task(before, 'pilot initial', pilot)
  assert.equal(first.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(first.workerSessionId, firstRegistry.get(pilot.id).workers[first.workerSessionId].id)
  before.dispose()
  await firstRegistry.close()
  const secondRegistry = await openPostmanTaskRegistry(domain())
  const restarted = createPostmanWorkerTools(f.ctx, undefined, contexts(secondRegistry))
  const next = await task(restarted, 'pilot follow-up', pilot)
  assert.equal(next.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(next.created, false)
  assert.equal(next.workerSessionId, first.workerSessionId)
  assert.equal(secondRegistry.get(pilot.id).workers[first.workerSessionId].id, first.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
  assert.deepEqual(f.calls.followups, [first.workerSessionId])
  restarted.dispose()
  await secondRegistry.close()
  await backend.close()
})

test('fresh replacement closes old ID, revokes its REQ assignment, and reassigns same Leader grant', async () => {
  const f = await fixture()
  const requestId = 'REQ_20261004T112233Z_5678'
  const grants = { resolve: async (id, requested) => id === leader.id && requested === requestId
    ? { repository: IMPLEMENTATION_REPOSITORY, requestId } : null }
  const childAgents = new Map()
  f.ctx.agents.get = id => id === leader.id ? leader : childAgents.get(id)
  const worker = createPostmanWorkerTools(f.ctx, grants, f.contexts)
  const first = await worker.taskTool.execute({ task: 'apply', artifactRequestId: requestId }, { agent: leader, signal })
  const old = first.workerSessionId
  const child = id => ({ id, session: { header: { id, origin: 'subagent', parentSession: leader.id, delegationDepth: 1 } } })
  childAgents.set(old, child(old))
  // A real native close is tested in the isolated cutoff fixture. Simulate only its Host handoff here.
  f.ctx.subagents.closeContinuableChild = async (_parent, id, check) => {
    assert.equal(id, old); if (!await check()) return false
    childAgents.delete(id); return true
  }
  f.ctx.subagents.listChildren = async () => [...f.calls.children].map(id => ({ id, kind: 'child', mode: 'continuable' }))
  const stopped = await worker.stopTool.execute({ mode: 'cancel', workerSessionId: old }, { agent: leader, signal })
  assert.equal(stopped.status, 'POSTMAN_WORKER_CANCELLED')
  assert.equal(worker.ownerOf(child(old), requestId), null)
  assert.equal(f.registry.get(leader.id).workers[old], undefined)
  const fresh = await worker.taskTool.execute({ task: 'new assignment', createNew: true, artifactRequestId: requestId }, { agent: leader, signal })
  assert.equal(fresh.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.notEqual(fresh.workerSessionId, old)
  childAgents.set(fresh.workerSessionId, child(fresh.workerSessionId))
  assert.equal(worker.ownerOf(childAgents.get(fresh.workerSessionId), requestId), leader.id)
  assert.equal(f.registry.get(leader.id).workers[fresh.workerSessionId].artifactRequests.includes(requestId), true)
  assert.equal((await grants.resolve(leader.id, requestId)).requestId, requestId)
  let runnerCalls = 0
  const apply = createImplementationArtifactApplyTool(f.ctx, grants, worker, {
    verifiedRepository: async worktree => worktree === 'C:/task',
    spawnProcess: () => {
      runnerCalls++
      const proc = new EventEmitter()
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough()
      queueMicrotask(() => { proc.stdout.end(JSON.stringify({ ok: true })); proc.emit('close', 0) })
      return proc
    },
  })
  assert.equal((await apply.execute({ requestId, worktree: 'C:/task' }, { agent: child(old), signal })).status,
    'IMPLEMENTATION_ARTIFACT_CALLER_REJECTED')
  assert.equal((await apply.execute({ requestId, worktree: 'C:/task' },
    { agent: childAgents.get(fresh.workerSessionId), signal })).status, 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT')
  assert.equal(runnerCalls, 1)
})

test('compact admits only the exact resident idle Worker without changing binding or quota', async () => {
  const f = await fixture()
  const active = new Map()
  f.ctx.agents.get = id => id === leader.id ? leader : active.get(id)
  const worker = f.tool()
  const accepted = await task(worker)
  const id = accepted.workerSessionId
  const child = { id, status: 'idle', inbox: { hasPending: false }, session: {
    header: { id, origin: 'subagent', parentSession: leader.id, delegationDepth: 1 }, events: [] } }
  active.set(id, child)
  let calls = 0
  f.ctx.compaction = { compactNow: async (agent, receivedSignal) => {
    assert.equal(agent, child); assert.equal(receivedSignal, signal); calls++; return { summary: true }
  } }
  child.ctx = { get: name => name === 'compaction' ? f.ctx.compaction : undefined }
  const snapshot = f.registry.get(leader.id).workers[id]
  const compact = args => worker.compactTool.execute(args, { agent: leader, signal })
  assert.equal((await compact({ workerSessionId: id })).status, 'POSTMAN_WORKER_COMPACTED')
  assert.equal(calls, 1)
  assert.equal(f.registry.get(leader.id).workers[id], snapshot)
  assert.equal((await worker.listTool.execute({}, { agent: leader, signal })).quota.luna.used, 1)
  child.status = 'running'
  assert.equal((await compact({ workerSessionId: id })).status, 'POSTMAN_WORKER_COMPACT_BUSY')
  child.status = 'idle'; child.inbox.hasPending = true
  assert.equal((await compact({ workerSessionId: id })).status, 'POSTMAN_WORKER_COMPACT_BUSY')
  active.delete(id)
  assert.equal((await compact({ workerSessionId: id })).status, 'POSTMAN_WORKER_COMPACT_NOT_RESIDENT')
  assert.equal(calls, 1)
  assert.equal((await task(worker)).workerSessionId, id)
})

test('native delivered report admits strict close without approval or synthetic turn markers',
  { timeout: 10000 }, async t => {
  const { Context } = await nativePkg('cordis')
  const { AgentRegistry } = await nativePkg('dsh-agent')
  const { SessionStore } = await nativePkg('dsh-session')
  const { JsonlSessionPersistence } = await nativePkg('dsh-session-persistence-jsonl')
  const { SessionProjectionRegistry } = await nativePkg('dsh-session-projection')
  const { SystemPrompt } = await nativePkg('dsh-system-prompt')
  const { ToolRuntime } = await nativePkg('dsh-tools')
  const { LlmRuntime, LlmAdapter } = await nativePkg('dsh-llm')
  const { AgentLoop } = await nativePkg('dsh-agent-loop')
  const { SubagentRuntime } = await nativePkg('dsh-subagent')
  const { apply: spawn } = await nativePkg('dsh-subagent-spawn-in-process')
  const { apply: nativeReport } = await nativePkg('dsh-tool-subagent-report')
  const dir = await mkdtemp(join(tmpdir(), 'postman-native-strict-report-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  new LlmRuntime(ctx); new JsonlSessionPersistence(ctx, { root: join(dir, 'sessions') })
  new SubagentRuntime(ctx); spawn(ctx, { providerName: 'spawn' })
  nativeReport(ctx, { reportDelivery: 'quiet' })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  t.after(() => ctx.fiber.dispose())
  ctx.tools.register({ name: 'postman_bridge', description: 'fixture deny boundary', parameters: {},
    output: { schema: { type: 'object', properties: {} }, render: () => [] }, execute: () => ({}) })
  const childCalls = new Map()
  class FakeAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }] } }
    }
    async *stream() {
      const agent = ctx.agents.currentInitiator()
      const count = (childCalls.get(agent.id) ?? 0) + 1
      childCalls.set(agent.id, count)
      const block = agent.id === 'leader' || count > 1 ? { type: 'text', text: 'done' } :
        { type: 'tool-call', id: 'report-native', name: 'report', arguments: '{"output":"complete"}' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['codex'], new FakeAdapter())
  const registry = createMemoryTaskRegistry()
  await registry.create('leader', { ...context, leaderSessionId: 'leader', workers: {},
    stage: 'ready', runner: { state: 'none' } })
  const taskContext = Object.freeze({ ...context, leaderSessionId: 'leader' })
  const contexts = { get: () => taskContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false }
  const worker = createPostmanWorkerTools(ctx, undefined, contexts)
  installPostmanWorkerReportObserver(ctx, worker)
  ctx.on('agent/created', ({agent}) => worker.confirmActivation(agent))
  const parent = ctx.agentLoop.create('leader', { provider: 'codex', model: 'test' },
    { cwd: dir, agentPreset: 'postman-leader' })
  const accepted = await worker.taskTool.execute({ task: 'report and finish' }, { agent: parent, signal })
  assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  const childId = accepted.workerSessionId
  await ctx.agents.get(childId).whenIdle()
  await ctx.sessionPersistence.append(childId, [])
  const saved = await ctx.sessionPersistence.inspect(childId)
  assert.ok(saved.events.some(event => event.type === 'turn/end'))
  parent.followup({ id: 'parent-wake', role: 'user', source: { kind: 'user', form: 'direct' },
    content: [{ type: 'text', text: 'Review delivered report' }] })
  await parent.whenIdle()
  assert.ok(parent.session.events.some(event => event.type === 'user/message' &&
    event.data.source?.kind === 'subagent-report' && event.data.source.senderSessionId === childId))
  const closed = await worker.stopTool.execute({ mode: 'close', workerSessionId: childId }, { agent: parent, signal })
  assert.equal(closed.status, 'POSTMAN_WORKER_STOPPED')
  assert.equal(closed.resultReported, true)
  assert.equal(registry.get('leader').workers[childId], undefined)
})

test('terminal report rechecks exact child authority after delivery and flush', async () => {
  for (const phase of ['delivery', 'flush']) for (const changed of ['child', 'binding', 'context', 'parent', 'assignment']) {
    const f = await fixture()
    let taskContext = context, reportHook, flushes = 0, concluded = 0
    const agents = new Map([[leader.id, leader]])
    f.ctx.agents.get = id => agents.get(id)
    f.ctx.on = (name, handler) => {
      if (name === 'tools/execute') reportHook = handler
      return () => {}
    }
    const worker = createPostmanWorkerTools(f.ctx, undefined, { ...f.contexts, get: () => taskContext })
    const id = (await task(worker)).workerSessionId
    const child = { id, session: { header: { id, origin: 'subagent', parentSession: leader.id, delegationDepth: 1 } } }
    agents.set(id, child)
    await worker.confirmActivation(child)
    assert.equal(worker.roleOf(child), 'luna')
    assert.ok(f.registry.get(leader.id).workers[id].budget.assignmentId)
    const mutate = async () => {
      if (changed === 'child') agents.set(id, { ...child })
      else if (changed === 'parent') agents.set(leader.id, { ...leader })
      else if (changed === 'context') taskContext = { ...taskContext }
      else if (changed === 'assignment') await f.registry.change(leader.id, row => ({
        ...row, workers: { ...row.workers, [id]: { ...row.workers[id],
          budget: { ...row.workers[id].budget, assignmentId: 'new-assignment' } } }
      }))
      else await f.registry.change(leader.id, row => {
        const workers = { ...row.workers }; delete workers[id]
        return { ...row, workers }
      })
    }
    f.ctx.get = name => name === 'sessions' ? { flush: async () => {
      flushes++
      if (phase === 'flush') await mutate()
    } } : undefined
    const exec = { agent: child, name: 'report', concludeTurn() { concluded++ } }
    await assert.rejects(reportHook(exec, async () => {
      if (phase === 'delivery') await mutate()
      return { value: { messageId: 'native-report' } }
    }), /POSTMAN_WORKER_REPORT_AUTHORITY_CHANGED/, phase + ':' + changed)
    assert.equal(concluded, 0)
    assert.equal(flushes, Number(phase === 'flush'))
    worker.dispose()
  }
})

for (const failure of [false, true]) test('native report waits for exact parent persistence; failure=' + failure,
  { timeout: 15000 }, async t => {
  const { Context } = await nativePkg('cordis')
  const { AgentRegistry } = await nativePkg('dsh-agent')
  const { SessionStore } = await nativePkg('dsh-session')
  const { JsonlSessionPersistence } = await nativePkg('dsh-session-persistence-jsonl')
  const { SessionProjectionRegistry } = await nativePkg('dsh-session-projection')
  const { SystemPrompt } = await nativePkg('dsh-system-prompt')
  const { ToolRuntime } = await nativePkg('dsh-tools')
  const { LlmRuntime, LlmAdapter } = await nativePkg('dsh-llm')
  const { AgentLoop } = await nativePkg('dsh-agent-loop')
  const { SubagentRuntime } = await nativePkg('dsh-subagent')
  const { apply: spawn } = await nativePkg('dsh-subagent-spawn-in-process')
  const { apply: nativeReport } = await nativePkg('dsh-tool-subagent-report')
 const dir=await mkdtemp(join(tmpdir(),'postman-report-restart-probe-'))
 t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
 const original=join(dir,'original'), snapshot=join(dir,'snapshot')
 const taskContext={leaderSessionId:'leader',repository:'andrewverhoturov1/dsh-workspace',branch:'task/postman-'+'a'.repeat(32),worktree:'C:/task',baseCommit:'a'.repeat(40)}
 async function runtime(root,resume){
  const backend=new JsonStorageBackend(join(root,'registry'))
  const domainCtx={storage:{backend:{get:()=>backend}},emit(){}}
  const registry=await openPostmanTaskRegistry(new DomainFacility(domainCtx,{backend:'json',routes:{}}))
  if(!resume) await registry.create('leader',{...taskContext,repositoryPath:'C:/repo',originUrl:'https://github.com/andrewverhoturov1/dsh-workspace.git',stage:'ready',diagnostic:null,workers:{},runner:{state:'none',requestId:null},bridge:null})
  const ctx=new Context()
  new AgentRegistry(ctx);new SessionStore(ctx);new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx,{});new ToolRuntime(ctx);new LlmRuntime(ctx)
  new JsonlSessionPersistence(ctx,{root:join(root,'sessions')})
  new SubagentRuntime(ctx);spawn(ctx,{providerName:'spawn'});nativeReport(ctx,{reportDelivery:'next-step'})
  new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
  ctx.tools.register({name:'postman_bridge',description:'fixture boundary',parameters:{},output:{schema:{type:'object',properties:{}},render:()=>[]},execute:()=>({})})
  const requests=new Map()
  class FakeAdapter extends LlmAdapter{
   async resolveModel(provider,model){return{provider,id:model,name:model,reasoning:{efforts:[{id:'low',name:'Low'}]}}}
   async *stream(){const agent=ctx.agents.currentInitiator();const count=(requests.get(agent.id)??0)+1;requests.set(agent.id,count)
    const block=agent.id==='leader'||count>1?{type:'text',text:'done'}:{type:'tool-call',id:'report-native',name:'report',arguments:'{"output":"complete"}'}
    yield{type:'block-end',index:0,block};yield{type:'finish',reason:{kind:'stop'}}
   }
  }
  ctx.llm.registerAdapter(['codex'],new FakeAdapter())
  const contexts={get:()=>taskContext,record:registry.get,changeRecord:registry.change,isRestoring:()=>false,hasActiveOperation:()=>false}
  const tools=createPostmanWorkerTools(ctx,undefined,contexts)
  installPostmanWorkerReportObserver(ctx,tools);ctx.on('agent/created',({agent})=>tools.confirmActivation(agent))
  const parent=resume?(await ctx.agents.resume({resumeSessionId:'leader',agentOptions:{provider:'codex',model:'test'},signal})).agent:ctx.agentLoop.create('leader',{provider:'codex',model:'test'},{cwd:dir,agentPreset:'postman-leader'})
  return{ctx,parent,tools,registry,backend,requests,async dispose(){tools.dispose();await ctx.fiber.dispose();await registry.close();await backend.close()}}
 }
 const a=await runtime(original,false)
 a.parent.followup({id:'initial-wake',role:'user',source:{kind:'user',form:'direct'},content:[{type:'text',text:'start'}]})
 await a.parent.whenIdle()
 await a.ctx.sessions.flush(a.parent.session)
 const gate=Promise.withResolvers(),entered=Promise.withResolvers()
 let failed=false, reportResult
 a.ctx.on('tools/result',(exec,result)=>{if(exec.name==='report')reportResult=result})
 const sink=a.ctx.sessionPersistence.appendBatch.bind(a.ctx.sessionPersistence)
 a.ctx.sessionPersistence.appendBatch=async (meta,events,materialized)=>{
  if(meta.id==='leader'&&events.some(e=>e.type==='agent/inbox/spliced'&&e.data.inserted.some(m=>m.source?.kind==='subagent-report'))){entered.resolve();await gate.promise;if(failure&&!failed){failed=true;throw Error('injected parent durability failure')}}
  return sink(meta,events,materialized)
 }
 const disposed=Promise.withResolvers();a.ctx.on('agent/disposed',({agent})=>{if(agent.id!=='leader')disposed.resolve(agent.id)})
 const accepted=await a.tools.taskTool.execute({task:'report and finish'},{agent:a.parent,signal})
 assert.equal(accepted.status,'POSTMAN_WORKER_TASK_ACCEPTED')
 const id=accepted.workerSessionId
 await entered.promise
 const blocked=a.registry.get('leader').workers[id]
 const child=a.ctx.agents.get(id)
 const premature=blocked.budget.reported || blocked.lifecycle.reports.length>0 || !child || child.session.events.some(e=>e.type==='turn/end')
 // Release after taking the observation so a RED failure cannot deadlock teardown.
 gate.resolve();assert.equal(await disposed.promise,id);await a.parent.whenIdle()
 if(failure){
  assert.equal(reportResult.isError,true)
  assert.match(reportResult.error.message,/injected parent durability failure/)
  assert.equal(a.registry.get('leader').workers[id].budget.reported,false)
  assert.deepEqual(a.registry.get('leader').workers[id].lifecycle.reports,[])
  const closed=await a.tools.stopTool.execute({mode:'close',workerSessionId:id},{agent:a.parent,signal})
  assert.equal(closed.status,'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  await a.dispose();return
 }
 const report=a.registry.get('leader').workers[id].lifecycle.reports[0]
 const saved=(await a.ctx.sessionPersistence.inspect(id));assert.equal(saved.events.findLast(e=>e.type==='turn/end').data.reason.kind,'completed')
 assert.ok(report);assert.equal(a.registry.get('leader').workers[id].budget.reported,true)
 // No added parent flush or registry close: the report tool must have made delivery durable itself.
 await cp(original,snapshot,{recursive:true})
 await a.dispose()
 assert.equal(premature,false,'child report/terminal completion outran exact parent durability')
 const b=await runtime(snapshot,true)
 const wake={id:'restart-wake',role:'user',source:{kind:'user',form:'direct'},content:[{type:'text',text:'review'}]}
 b.parent.followup(wake);await b.parent.whenIdle()
 const list=await b.tools.listTool.execute({},{agent:b.parent,signal})
 const row=list.workers.find(w=>w.workerSessionId===id)
 assert.equal(row.runtime,'cold-continuable');assert.equal(row.turn,'settled');assert.equal(row.report,'delivered')
 assert.equal(b.parent.session.events.filter(e=>e.type==='user/message'&&e.data.id===report.messageId).length,1)
 assert.equal(b.requests.has(id),false);assert.equal(b.parent.inbox.hasPending,false)
 const closed=await b.tools.stopTool.execute({mode:'close',workerSessionId:id},{agent:b.parent,signal})
 await b.dispose()
 assert.equal(closed.status,'POSTMAN_WORKER_STOPPED');assert.equal(closed.resultReported,true)
})

test('native close crash-window reconciles exact Luna and Sol slots after actual runtime recreation',
  { timeout: 20000 }, async t => {
  const { Context } = await nativePkg('cordis')
  const { AgentRegistry } = await nativePkg('dsh-agent')
  const { SessionStore } = await nativePkg('dsh-session')
  const { JsonlSessionPersistence } = await nativePkg('dsh-session-persistence-jsonl')
  const { SessionProjectionRegistry } = await nativePkg('dsh-session-projection')
  const { SystemPrompt } = await nativePkg('dsh-system-prompt')
  const { ToolRuntime } = await nativePkg('dsh-tools')
  const { LlmRuntime, LlmAdapter } = await nativePkg('dsh-llm')
  const { AgentLoop } = await nativePkg('dsh-agent-loop')
  const { SubagentRuntime } = await nativePkg('dsh-subagent')
  const { apply: spawn } = await nativePkg('dsh-subagent-spawn-in-process')
  if (typeof SubagentRuntime.prototype.inspectClosedContinuableChild !== 'function') {
    t.skip('isolated native overlay unavailable'); return
  }
  for (const type of ['luna', 'sol']) {
    const dir = await mkdtemp(join(tmpdir(), 'postman-native-worker-crash-'))
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    const backend = new JsonStorageBackend(join(dir, 'registry'))
    const domainCtx = { storage: { backend: { get: () => backend } }, emit() {} }
    const domain = () => new DomainFacility(domainCtx, { backend: 'json', routes: {} })
    const registryA = await openPostmanTaskRegistry(domain())
    const leaderId = 'leader-' + type
    const taskContext = { ...context, leaderSessionId: leaderId }
    await registryA.create(leaderId, { ...taskContext, repositoryPath: 'C:/repo',
      originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
      stage: 'ready', diagnostic: null, workers: {}, runner: { state: 'none', requestId: null }, bridge: null })
    async function runtime(registry) {
      const ctx = new Context()
      new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
      new SystemPrompt(ctx, {}); new ToolRuntime(ctx); new LlmRuntime(ctx)
      ctx.tools.register({ name: 'postman_bridge', description: 'fixture boundary', parameters: {},
        output: { schema: { type: 'object', properties: {} }, render: () => [] }, execute: () => ({}) })
      new JsonlSessionPersistence(ctx, { root: join(dir, 'sessions') })
      new SubagentRuntime(ctx); spawn(ctx, { providerName: 'spawn' })
      new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
      class FakeAdapter extends LlmAdapter {
        async *stream() {
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      ctx.llm.registerAdapter(['codex'], new FakeAdapter())
      const parent = ctx.agentLoop.create(leaderId, { provider: 'codex', model: 'test' },
        { cwd: dir, agentPreset: 'postman-leader' })
      const contexts = { get: () => taskContext, record: registry.get, changeRecord: registry.change,
        isRestoring: () => false, hasActiveOperation: () => false }
      const tools = createPostmanWorkerTools(ctx, undefined, contexts)
      return { ctx, parent, tools }
    }
    const a = await runtime(registryA)
    const native = await a.ctx.subagents.startContinuable({ provider: 'spawn', label: type, signal,
      request: { parent: a.parent, prompt: [{ type: 'text', text: 'old task' }],
        agentOptions: { provider: 'codex', model: 'test' } } })
    await a.ctx.agents.get(native.childId).whenIdle()
    const marker = { id: native.childId, workerType: type, label: type,
      state: 'stopping', delivery: 'unknown', lifecycle: { version: 1, admissions: [], reports: [] }, artifactRequests: [] }
    await registryA.change(leaderId, row => ({ ...row, workers: { ...row.workers, [native.childId]: marker } }))
    const strict = await a.tools.stopTool.execute({ mode: 'close', workerSessionId: native.childId },
      { agent: a.parent, signal })
    assert.equal(strict.status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
    assert.equal(registryA.get(leaderId).workers[native.childId].id, native.childId)
    assert.equal(await a.ctx.subagents.closeContinuableChild(a.parent, native.childId, async () => true), true)
    // No Postman removeBinding: an abrupt Host shutdown here leaves the durable binding.
    a.tools.dispose(); await a.ctx.fiber.dispose(); await registryA.close()
    const registryB = await openPostmanTaskRegistry(domain())
    const b = await runtime(registryB)
    assert.equal(registryB.get(leaderId).workers[native.childId].state, 'stopping')
    assert.equal(await b.ctx.subagents.inspectClosedContinuableChild(b.parent, native.childId), true)
    const create = type === 'sol' ? b.tools.solTaskTool : b.tools.taskTool
    const next = await create.execute({ task: 'new task', createNew: true }, { agent: b.parent, signal })
    assert.equal(next.status, 'POSTMAN_WORKER_TASK_ACCEPTED', JSON.stringify({ next, workers: registryB.get(leaderId).workers }))
    assert.notEqual(next.workerSessionId, native.childId)
    const oldHistory = (await b.ctx.sessionPersistence.inspect(native.childId)).events
    const newHistory = (await b.ctx.sessionPersistence.inspect(next.workerSessionId)).events
    assert.ok(oldHistory.some(event => JSON.stringify(event).includes('old task')))
    assert.equal(newHistory.some(event => JSON.stringify(event).includes('old task')), false)
    assert.ok(newHistory.some(event => JSON.stringify(event).includes('new task')))
    assert.equal(registryB.get(leaderId).workers[native.childId], undefined)
    assert.equal((await b.tools.listTool.execute({}, { agent: b.parent, signal })).quota[type].used, 1)
    await assert.rejects(b.ctx.subagents.followup(b.parent, native.childId, [{ type: 'text', text: 'late' }],
      { source: { kind: 'user' }, signal }), /closed/)
    b.tools.dispose(); await b.ctx.fiber.dispose(); await registryB.close(); await backend.close()
  }
})

test('closed marker reconciliation frees only proven exact binding after registry reopen', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-worker-crash-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const domainCtx = { storage: { backend: { get: () => backend } }, emit() {} }
  const domain = () => new DomainFacility(domainCtx, { backend: 'json', routes: {} })
  const first = await openPostmanTaskRegistry(domain())
  await first.create(leader.id, { ...context, repositoryPath: 'C:/repo',
    originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
    stage: 'ready', diagnostic: null, workers: {}, runner: { state: 'none', requestId: null }, bridge: null })
  const f = await fixture()
  const contexts = registry => ({ get: () => context, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false })
  const a = createPostmanWorkerTools(f.ctx, undefined, contexts(first))
  const ids = []
  for (let i = 0; i < 2; i++) ids.push((await a.taskTool.execute({ task: 'work', createNew: true }, { agent: leader, signal })).workerSessionId)
  assert.equal((await a.taskTool.execute({ task: 'full', createNew: true }, { agent: leader, signal })).status, 'POSTMAN_WORKER_LIMIT_REACHED')
  const closed = ids[0]
  await first.change(leader.id, row => ({ ...row, workers: { ...row.workers,
    [closed]: { ...row.workers[closed], state: 'stopping' },
    [ids[1]]: { ...row.workers[ids[1]], state: 'uncertain' } } }))
  a.dispose(); await first.close()
  const second = await openPostmanTaskRegistry(domain())
  const restarted = createPostmanWorkerTools(f.ctx, undefined, contexts(second))
  f.ctx.subagents.inspectClosedContinuableChild = async (_parent, id) => id === closed
  const replacement = await restarted.taskTool.execute({ task: 'fresh', createNew: true }, { agent: leader, signal })
  assert.equal(replacement.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.notEqual(replacement.workerSessionId, closed)
  assert.equal(second.get(leader.id).workers[closed], undefined)
  assert.equal(second.get(leader.id).workers[ids[1]].state, 'uncertain')
  assert.equal(Object.keys(second.get(leader.id).workers).length, 2)
  const listed = await restarted.listTool.execute({}, { agent: leader, signal })
  assert.equal(listed.quota.luna.used, 2)
  restarted.dispose(); await second.close(); await backend.close()
})

test('deferred closure proof cannot remove binding after parent or context changes', async () => {
  for (const changed of ['parent', 'context']) {
    const f = await fixture()
    const old = f.tool()
    const id = (await old.taskTool.execute({ task: 'old task' }, { agent: leader, signal })).workerSessionId
    await f.registry.change(leader.id, row => ({ ...row, workers: { ...row.workers,
      [id]: { ...row.workers[id], state: 'stopping' } } }))
    old.dispose()
    const gate = Promise.withResolvers(), entered = Promise.withResolvers()
    f.ctx.subagents.inspectClosedContinuableChild = async () => {
      entered.resolve(); await gate.promise; return true
    }
    let taskContext = context
    const contexts = { get: () => taskContext, record: f.registry.get, changeRecord: f.registry.change,
      isRestoring: () => false, hasActiveOperation: () => false }
    const worker = createPostmanWorkerTools(f.ctx, undefined, contexts)
    const pending = worker.taskTool.execute({ task: 'replacement', createNew: true }, { agent: leader, signal })
    await entered.promise
    if (changed === 'parent') f.ctx.agents.get = () => ({ ...leader })
    else taskContext = { ...context }
    gate.resolve()
    await pending
    assert.equal(f.registry.get(leader.id).workers[id].state, 'stopping', changed)
    worker.dispose()
  }
})

test('Worker list is observational and separates live, cold, closed and diagnostic residency', async () => {
  const f = await fixture()
  const worker = f.tool()
  const a = await worker.taskTool.execute({ task: 'one', createNew: true }, { agent: leader, signal })
  const b = await worker.taskTool.execute({ task: 'two', createNew: true }, { agent: leader, signal })
  const c = await worker.secretaryTool.execute({ task: 'facts', createNew: true }, { agent: leader, signal })
  const active = { id: a.workerSessionId, status: 'running', session: { header: {
    id: a.workerSessionId, origin: 'subagent', delegationDepth: 1, parentSession: leader.id },
    events: [{ type: 'turn/start', data: { turn: 7 } }] } }
  f.ctx.agents.get = id => id === leader.id ? leader : id === active.id ? active : undefined
  f.ctx.subagents.listChildren = async () => [
    { id: a.workerSessionId, kind: 'child', mode: 'continuable', activity: 'running' },
    { id: b.workerSessionId, kind: 'child', mode: 'continuable', activity: 'inactive' },
    { id: c.workerSessionId, kind: 'diagnostic', reason: 'corrupt' },
  ]
  const read = async () => worker.listTool.execute({}, { agent: leader, signal })
  const before = JSON.stringify(f.registry.get(leader.id).workers)
  const list = await read()
  assert.equal(list.quota.luna.used, 2)
  assert.deepEqual(list.workers.map(x => x.runtime), ['resident-running', 'cold-continuable', 'corrupt/diagnostic'])
  assert.equal(list.workers[0].turn, 'open')
  assert.equal(list.workers[0].report, 'unknown')
  assert.equal(JSON.stringify(f.registry.get(leader.id).workers), before)
  assert.equal(f.calls.starts.length, 3)
  assert.equal(f.calls.followups.length, 0)
  active.status = 'idle'
  assert.equal((await read()).workers[0].runtime, 'resident-idle')
  f.ctx.get = name => name === 'sessionPersistence' ? { inspect: async id => ({ meta: {
    id, origin: 'subagent', delegationDepth: 1, parentSession: leader.id },
    events: id === b.workerSessionId ? [{ type: 'subagent/closed' }] : [] }) } : undefined
  assert.equal((await read()).workers[1].runtime, 'durable-closed')
  f.ctx.get = name => name === 'sessionPersistence' ? { inspect: async id => ({ meta: {
    id, origin: 'subagent', delegationDepth: 1, parentSession: 'foreign' },
    events: [{ type: 'subagent/closed' }, { type: 'turn/start', data: { turn: 9 } }] }) } : undefined
  const mismatch = await read()
  assert.equal(mismatch.workers[1].runtime, 'cold-continuable')
  assert.equal(mismatch.workers[1].turn, 'unknown')
  f.ctx.get = name => name === 'sessionPersistence' ? { inspect: async () => { throw Error('unavailable') } } : undefined
  assert.equal((await read()).workers[1].runtime, 'cold-continuable')
  f.ctx.subagents.listChildren = async () => []
  assert.equal((await read()).workers[2].runtime, 'unavailable')
  assert.equal(JSON.stringify(f.registry.get(leader.id).workers), before)
})

test('new trusted artifact REQ follows up existing Worker and persists authorization', async () => {
  const f = await fixture()
  const requestId = 'REQ_20260925T112233Z_5678'
  const grants = { async resolve(id, request) {
    assert.equal(id, leader.id)
    assert.equal(request, requestId)
    return { repository: IMPLEMENTATION_REPOSITORY, requestId }
  } }
  const worker = createPostmanWorkerTools(f.ctx, grants, f.contexts)
  const first = await task(worker, 'ordinary')
  const next = await worker.taskTool.execute({ task: 'apply artifact', artifactRequestId: requestId }, { agent: leader, signal })
  assert.equal(next.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(next.created, false)
  assert.equal(next.workerSessionId, first.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
  assert.deepEqual(f.calls.followups, [first.workerSessionId])
  assert.deepEqual(f.registry.get(leader.id).workers[first.workerSessionId].artifactRequests, [requestId])
})

test('crash between child acceptance and ready write never creates a second Worker', async () => {
  const f = await fixture()
  const a = f.tool()
  const first = await task(a)
  await f.registry.change(leader.id, row => ({ ...row, workers: { ...row.workers, [first.workerSessionId]: { ...row.workers[first.workerSessionId], state: 'intent', delivery: 'pending' } } }))
  a.dispose()
  const b = f.tool()
  const next = await task(b)
  assert.equal(next.status, 'POSTMAN_WORKER_DELIVERY_UNKNOWN')
  assert.equal(next.workerSessionId, first.workerSessionId)
  assert.equal(f.registry.get(leader.id).workers[first.workerSessionId].state, 'ready')
  assert.equal(f.calls.starts.length, 1)
  assert.equal(f.calls.followups.length, 0)
})

test('missing reserved child fails closed without guessing by label', async () => {
  const f = await fixture()
  await f.registry.change(leader.id, row => ({ ...row, workers: { 'reserved-id': { id: 'reserved-id', label: 'reserved-id', state: 'intent',
    delivery: 'pending', artifactRequests: [] } } }))
  f.calls.children.add('another-child')
  const result = await task(f.tool())
  assert.equal(result.status, 'POSTMAN_WORKER_BINDING_UNCERTAIN')
  assert.equal(f.calls.starts.length, 0)
})

test('followup uncertainty is persisted before delivery and cannot replay', async () => {
  const f = await fixture()
  const a = f.tool()
  const first = await task(a)
  f.ctx.subagents.followup = async () => { throw new Error('inbox uncertain') }
  assert.equal((await task(a)).status, 'POSTMAN_WORKER_FOLLOWUP_FAILED')
  assert.equal(f.registry.get(leader.id).workers[first.workerSessionId].delivery, 'unknown')
  a.dispose()
  assert.equal((await task(f.tool())).status, 'POSTMAN_WORKER_DELIVERY_UNKNOWN')
  assert.equal(f.calls.starts.length, 1)
  assert.equal(f.calls.followups.length, 0)
  assert.equal(first.workerSessionId, f.registry.get(leader.id).workers[first.workerSessionId].id)
})
