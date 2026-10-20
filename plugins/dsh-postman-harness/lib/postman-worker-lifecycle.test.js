import assert from 'node:assert/strict'
import test from 'node:test'

const cutoffUnavailable = 'BLOCKED: runtime has no exact-child admission cutoff'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { createPostmanWorkerTools } from './postman-worker.js'
function fixture({ localDevelopment = false } = {}) {
  const registry = createMemoryTaskRegistry()
  const leader = { id: 'leader', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 }, events: [] } }
  const agents = new Map([[leader.id, leader]])
  const calls = { drains: [], starts: [], follows: [], approvals: [] }
  const context = { branch: 'task/a', worktree: 'C:/temp' }
  const contexts = { get: () => context, record: registry.get,
    changeRecord: registry.change }
  let approve = 'unavailable'
  const ctx = { agents: { get: id => agents.get(id) },
    tools: { schemas: () => ['postman_worker','postman_worker_interrupt','postman_worker_stop','report'].map(name => ({name})) },
    get: name => name === 'approval' ? { request: async request => { calls.approvals.push(request); return approve } } : null,
    subagents: {
      async startContinuable(spec) { calls.starts.push(spec); const id = spec.childId;
        agents.set(id, { id, status: 'idle', inbox: { hasPending: true }, session: {
          header: { id, origin: 'subagent', parentSession: leader.id, delegationDepth: 1 }, events: [] } });
        return { childId: id, messageId: 'initial' } },
      async followup(...args) { calls.follows.push(args); return 'followup-' + calls.follows.length },
      async listChildren() { return [...agents.keys()].filter(id => id !== leader.id).map(id => ({ id, kind: 'child', mode: 'continuable', activity: agents.has(id) ? 'running' : 'inactive' })) },
      async listDescendants() { return [] },
      async drainContinuableChildren(_parent, ids) { calls.drains.push(ids) },
    } }
  const tools = createPostmanWorkerTools(ctx, undefined, contexts, { localDevelopment })
  const exec = { agent: leader, signal: new AbortController().signal, callId: 'stop-1' }
  return { registry, leader, agents, calls, tools, ctx, contexts, exec, setApproval: value => { approve = value } }
}
async function start(f) {
  await f.registry.create(f.leader.id, { workers: {} })
  const accepted = await f.tools.taskTool.execute({ task: 'work' }, f.exec)
  assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  return accepted.workerSessionId
}
test('local close still rejects running, queued, descendants, wrong caller and unknown target', async () => {
  for (const scenario of ['queued', 'running']) {
    const f = fixture({ localDevelopment: true }), id = await start(f)
    if (scenario !== 'queued') f.agents.get(id).inbox.hasPending = false
    if (scenario === 'running') f.agents.get(id).status = 'running'
    if (scenario === 'descendants') f.ctx.subagents.listDescendants = async () =>
      [{ kind: 'child', mode: 'continuable', activity: 'running' }]
    assert.equal((await f.tools.stopTool.execute({ mode: 'close', workerSessionId: id }, f.exec)).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
    assert.deepEqual(f.calls.drains, [])
  }
  const f = fixture({ localDevelopment: true }), id = await start(f)
  assert.equal((await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: id }, { ...f.exec, agent: { ...f.leader } })).status, 'POSTMAN_WORKER_CALLER_REJECTED')
  await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: 'other' }, f.exec)
  assert.deepEqual(f.calls.drains, [])
})
test('native report before TASK_ACCEPTED remains linked to reserved Worker', async () => {
  const f = fixture()
  await f.registry.create(f.leader.id, { workers: {} })
  f.ctx.subagents.startContinuable = async spec => {
    const child = { id: spec.childId, status: 'idle', inbox: { hasPending: false }, session: {
      header: { id: spec.childId, origin: 'subagent', parentSession: f.leader.id, delegationDepth: 1 },
      events: [{ type: 'tool/call', data: { turn: 1, callId: 'early', name: 'report', arguments: { output: 'early' } } }] } }
    f.agents.set(child.id, child)
    await f.tools.observeReport({ agent: child, name: 'report', callId: 'early', arguments: { output: 'early' } },
      { value: { messageId: 'report-before-return' } })
    return { childId: spec.childId, messageId: 'initial' }
  }
  const accepted = await f.tools.taskTool.execute({ task: 'work' }, f.exec)
  assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.deepEqual(f.registry.get(f.leader.id).workers[accepted.workerSessionId].lifecycle.reports.map(x => x.messageId), ['report-before-return'])
})
function cutoff(f) {
  const closed = new Set()
  f.ctx.subagents.closeContinuableChild = async (parent, id, check) => {
    assert.equal(parent, f.leader)
    if (!await check()) return false
    closed.add(id); f.agents.delete(id)
    return true
  }
  f.ctx.subagents.inspectClosedContinuableChild = async (parent, id) => parent === f.leader && closed.has(id) && !f.agents.has(id)
  return closed
}


test('close idle child without historical report; explicit fresh cancels active child and preserves task status', async () => {
  const f=fixture(), id=await start(f); cutoff(f)
  f.agents.get(id).inbox.hasPending=false
  const closed=await f.tools.stopTool.execute({mode:'close',workerSessionId:id},f.exec)
  assert.equal(closed.status,'POSTMAN_WORKER_STOPPED')
  assert.equal(closed.taskCompleted,false);assert.equal(closed.resultReported,false)
  assert.equal(f.registry.get('leader').retiredWorkers.at(-1).lifecycle.reports.length,0)
  const next=await f.tools.taskTool.execute({task:'replacement',createNew:true},f.exec)
  const active=f.agents.get(next.workerSessionId); active.status='running'
  const fresh=await f.tools.freshTool.execute({workerSessionId:active.id,task:'new bounded assignment'},f.exec)
  assert.equal(fresh.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(fresh))
  assert.notEqual(fresh.workerSessionId,active.id)
  assert.equal(fresh.fresh,true);assert.equal(f.agents.has(active.id),false)
})

test('cancel failure retains quota until exact cold closure proof, then replacement can start',async()=>{
  const f=fixture(),id=await start(f)
  const closed=cutoff(f)
  f.ctx.subagents.closeContinuableChild=async(_parent,_id,check)=>{await check();throw Error('native stop outcome unknown')}
  const failed=await f.tools.stopTool.execute({mode:'cancel',workerSessionId:id},f.exec)
  assert.equal(failed.status,'POSTMAN_WORKER_STOP_FAILED')
  assert.equal(f.registry.get('leader').workers[id].state,'uncertain')
  assert.equal(f.agents.has(id),true,'live process has not been called stopped')
  f.tools.dispose();closed.add(id);f.agents.delete(id)
  const restarted=createPostmanWorkerTools(f.ctx,undefined,f.contexts)
  const listing=await restarted.listTool.execute({},f.exec)
  assert.equal(listing.workers.length,1,'historical cancelled entry stays visible as a fact')
  assert.equal(f.registry.get('leader').workers[id].state,'uncertain')
  assert.equal((await restarted.taskTool.execute({task:'independent replacement',createNew:true},f.exec)).status,'POSTMAN_WORKER_TASK_ACCEPTED')
})

test('cancel cannot release slot before native process release or address foreign session',async()=>{
  const f=fixture(),id=await start(f)
  const gate=Promise.withResolvers(),entered=Promise.withResolvers()
  f.ctx.subagents.closeContinuableChild=async(parent,target,check)=>{
    assert.equal(parent,f.leader);assert.equal(target,id)
    if(!await check())return false
    entered.resolve();await gate.promise;f.agents.delete(target);return true
  }
  const stopping=f.tools.stopTool.execute({mode:'cancel',workerSessionId:id},f.exec)
  await entered.promise
  assert.equal(f.registry.get('leader').workers[id].state,'stopping')
  assert.equal(f.agents.has(id),true)
  assert.equal((await f.tools.stopTool.execute({workerSessionId:id},{...f.exec,agent:{...f.leader}})).status,'POSTMAN_WORKER_CALLER_REJECTED')
  gate.resolve();assert.equal((await stopping).status,'POSTMAN_WORKER_CANCELLED')
  assert.equal(f.registry.get('leader').workers[id],undefined)
})


test('Secretary invokes registered web_search and web_fetch through actual native ToolRuntime', {timeout:15000}, async t=>{
  const {stage1Runtime,stage1Native}=await import('./fixtures/postman-stage1-runtime.js')
  const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
  const {defineTool}=await stage1Native('dsh-tools')
  const dir=await mkdtemp(join(tmpdir(),'postman-secretary-web-')),effects=[]
  const f=await stage1Runtime(dir,{setupTools(ctx){for(const name of ['web_search','web_fetch'])ctx.tools.register(defineTool({
    name,description:'Registered inert provider',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:()=>[]},
    execute(_args,exec){effects.push({name,session:exec.agent.id});return {source:'provider fixture'}}}))},
    plan:(_a,r,n)=>{if(n===1){assert.ok(r.tools.some(t=>t.name==='web_search'));return {name:'web_search'}}
      if(n===2){assert.ok(r.tools.some(t=>t.name==='web_fetch'));return {name:'web_fetch'}}
      return {name:'report',args:{output:'PARTIAL: registered provider fixture invoked; no live web claim'}}}})
  t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
  const accepted=await f.run(f.worker.secretaryTool,{task:'Bounded registered search provider check'})
  assert.equal(accepted.status,'POSTMAN_WORKER_TASK_ACCEPTED')
  await f.settled(accepted.workerSessionId)
  assert.deepEqual(effects,[{name:'web_search',session:accepted.workerSessionId},{name:'web_fetch',session:accepted.workerSessionId}])
})


test('cancel witness drift is an identity change, never a new approval request',async()=>{
  const f=fixture(),id=await start(f);cutoff(f)
  const list=f.ctx.subagents.listChildren;let reads=0
  f.ctx.subagents.listChildren=async(...args)=>{
    if(++reads===2)await f.registry.change('leader',row=>({...row,workers:{...row.workers,[id]:{...row.workers[id],
      lifecycle:{...row.workers[id].lifecycle,admissions:[...row.workers[id].lifecycle.admissions,
        {id:'new-assignment',state:'accepted',messageId:'new-message'}]}}}}))
    return list(...args)
  }
  const result=await f.tools.stopTool.execute({mode:'cancel',workerSessionId:id},f.exec)
  assert.equal(result.status,'POSTMAN_WORKER_BINDING_CHANGED')
  assert.equal(f.agents.has(id),true);assert.equal(f.registry.get('leader').workers[id].state,'ready')
  assert.deepEqual(f.calls.approvals,[])
})
