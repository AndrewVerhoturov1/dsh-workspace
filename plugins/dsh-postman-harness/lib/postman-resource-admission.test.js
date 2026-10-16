import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeTool } from './postman-bridge.js'
import { POSTMAN_PTC_SUCCESS_STATUSES } from './postman-bridge-core.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
const tick=()=>new Promise(r=>setImmediate(r))
async function flush(){for(let i=0;i<18;i++)await tick()}
async function fixture(t,{readOnly=true}={}){
  const parent={id:'resource-leader',session:{header:{origin:'root',agentPreset:'postman-leader',cwd:tmpdir()}},followup(){}}
  const root=join(tmpdir(),'synthetic-task-root'), context=Object.freeze({worktree:root,branch:'task/synthetic',devspaceReadOnly:readOnly})
  const registry=createMemoryTaskRegistry()
  await registry.create(parent.id,{leaderSessionId:parent.id,repository:'x',repositoryPath:root,originUrl:'x',branch:'task/synthetic',worktree:root,baseCommit:'a'.repeat(40),stage:'ready',diagnostic:null,workers:{},runner:{state:'none',requestId:null},bridge:null})
  const listeners=new Set(), children=new Map(), launches=[], completed=new Map()
  const contexts={get:()=>context,record:registry.get,records:registry.entries,verifyWorktree:async()=>false,
    async changeRecord(id,fn){const v=await registry.change(id,fn);for(const f of listeners)f(id);return v},
    onContextChange(f){listeners.add(f);return()=>listeners.delete(f)}}
  let workerBusy=false,stamp=0
  const coordinator=createPostmanBridgeLaunchCoordinator({now:()=>++stamp*20000,random:()=>0});coordinator.fork=()=>coordinator
  const ctx={on(){},agents:{get:id=>id===parent.id?parent:children.get(id)},subagents:{
    async startContinuable(spec){const child={id:spec.childId};children.set(child.id,child);return {childId:child.id}},
    async inspectOpenContinuableChild(){return true},async followup(){return 'relay'},async closeContinuableChild(_p,id,ok){if(ok&&!await ok())return false;children.delete(id);return true}}}
  const direct={async start(spec){const requestId='REQ_20261013T000000Z_'+String(launches.length+1).padStart(4,'0');await spec.onRequestAllocated(requestId,'C:/private/synthetic');launches.push(spec);return{requestId}},
    wait(id){return new Promise(resolve=>completed.set(id,resolve))},dispose(){for(const [id,done]of completed)done({status:'COMPLETED',requestId:'REQ_20261013T000000Z_0001',result:{ok:false,code:'POSTMAN_TRANSPORT_FAILED'}})}}
  const jobs=createPostmanBridgeJobs(ctx,coordinator,null,contexts,{hasActiveWork:()=>workerBusy},direct)
  t.after(()=>jobs.dispose())
  const accept=(root=join(tmpdir(),'synthetic-approved-A'))=>jobs.accept(parent,'@PostmanDevspace synthetic resource test','devspace',undefined,undefined,'WRITE_APPROVED_TARGET',undefined,{root,access:'write'})
  const finish=(n)=>completed.get(launches[n-1].sessionId)({status:'COMPLETED',requestId:'REQ_20261013T000000Z_'+String(n).padStart(4,'0'),result:{ok:true,requestId:'REQ_20261013T000000Z_'+String(n).padStart(4,'0'),source:'bell',reportedOutcome:'DONE',evidenceState:'REPORTED_NOT_VERIFIED',conversationRef:'https://chatgpt.com/c/synthetic-'+n}})
  return {parent,ctx,registry,contexts,jobs,accept,acceptIsolated:()=>jobs.accept(parent,'@PostmanDevspace inert dirty task', 'devspace',undefined,undefined,'WRITE_ISOLATED'),launches,finish,coordinator,setBusy:v=>{workerBusy=v;coordinator.refresh()},root}
}
test('racing overlapping reservations launch once in FIFO after terminal release',async t=>{
  const f=await fixture(t), [a,b]=await Promise.all([f.accept(),f.accept()]);await flush()
  assert.equal(a.status,'POSTMAN_BRIDGE_ACCEPTED');assert.equal(b.status,'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal(f.launches.length,1,JSON.stringify(await f.jobs.status(f.parent,a.bridgeJobId)));assert.equal((await f.jobs.status(f.parent,b.bridgeJobId)).state,'QUEUED')
  f.finish(1);await flush();assert.equal(f.launches.length,2)
  f.coordinator.refresh();f.coordinator.refresh();assert.equal(f.launches.length,2)
  f.finish(2);await flush()
})
test('disjoint approved output roots launch independently',async t=>{
  const f=await fixture(t);await Promise.all([f.accept(),f.accept(join(tmpdir(),'synthetic-approved-B'))]);await flush()
  assert.equal(f.launches.length,2);f.finish(1);f.finish(2);await flush()
})
test('cancel queued reservation never sends and releases exactly once',async t=>{
  const f=await fixture(t),a=await f.accept(),b=await f.accept();await flush()
  const stopped=await f.jobs.stop(f.parent,b.bridgeJobId)
  assert.equal(stopped.status,'POSTMAN_BRIDGE_STOP_REQUESTED');assert.equal(f.launches.length,1)
  f.finish(1);await flush();f.coordinator.refresh();assert.equal(f.launches.length,1)
})
test('cold UNKNOWN root reservation holds while disjoint root proceeds',async t=>{
  const f=await fixture(t), cold='synthetic-cold-reservation'
  await f.contexts.changeRecord(f.parent.id,row=>({...row,bridgeOperations:{[cold]:{state:'unknown',phase:'reserved',transportKind:'devspace',createdAt:'2026-01-01',devspace:{mode:'WRITE_APPROVED_TARGET',approvedRoot:join(tmpdir(),'synthetic-approved-A'),approvedAccess:'write'}}}}))
  await f.accept();await f.accept(join(tmpdir(),'synthetic-approved-B'));await flush();assert.equal(f.launches.length,1)
  assert.equal(f.registry.get(f.parent.id).bridgeOperations[cold].state,'unknown')
  f.finish(1);await flush()
})
test('Worker with shell/write rights conflicts even with read-only prompt',async t=>{
  const f=await fixture(t);f.setBusy(true);await f.accept(f.root);await flush();assert.equal(f.launches.length,0)
  f.setBusy(false);await flush();assert.equal(f.launches.length,1);f.finish(1);await flush()
})

test('dirty isolated worktree preflight fails before REQ and automatically releases its reservation',async t=>{
  const f=await fixture(t,{readOnly:false})
  const a=await f.acceptIsolated();assert.equal(a.status,'POSTMAN_BRIDGE_ACCEPTED');await flush()
  const row=f.registry.get(f.parent.id), op=row.bridgeOperations[a.bridgeJobId]
  assert.equal(op.state,'received');assert.equal(op.phase,'not-sent')
  assert.equal(op.preSendFailure,'POSTMAN_DEVSPACE_WORKTREE_NOT_READY')
  assert.equal(op.synchronization,'not-required');assert.equal(op.requestId,undefined)
  assert.equal(op.childSessionId,undefined)
  assert.equal(row.devspaceLanes[op.devspace.laneId],undefined)
  assert.equal(f.jobs.list(f.parent).used,0,'proven not-sent operation must not consume admission capacity')
  assert.equal(f.launches.length,0,'no browser Send or REQ allocated')
  // Repeat past the three-slot limit: rejected requests must never accrue
  // capacity or count as a successful prior isolated run that waives dirty-tree checks.
  for(let i=0;i<4;i++){
    const next=await f.acceptIsolated();assert.equal(next.status,'POSTMAN_BRIDGE_ACCEPTED')
    await flush();const op=f.registry.get(f.parent.id).bridgeOperations[next.bridgeJobId]
    assert.equal(op.state,'received');assert.equal(op.phase,'not-sent')
    assert.equal(op.preSendFailure,'POSTMAN_DEVSPACE_WORKTREE_NOT_READY')
    assert.equal(f.jobs.list(f.parent).used,0,'no permanently occupied slots after denied sends')
    assert.equal(f.launches.length,0,'dirty worktree never reaches Browser Send')
  }
})

test('cold exact owner stop retires only a Host-proven failed pre-REQ worktree reservation',async t=>{
  const f=await fixture(t,{readOnly:false})
  const jobId='11111111-2222-4333-8444-555555555555',laneId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',createdAt='2026-01-01T00:00:00.000Z'
  const operation={state:'unknown',phase:'reserved',transportKind:'devspace',createdAt,devspace:{mode:'WRITE_ISOLATED',laneId}}
  const lane={state:'reserved',activeBridgeJobId:jobId,requestIds:[],conversationRef:null}
  await f.contexts.changeRecord(f.parent.id,row=>({...row,bridgeOperations:{...row.bridgeOperations,[jobId]:operation},devspaceLanes:{[laneId]:lane}}))
  const evidence={bridgeJobId:jobId,createdAt,laneId,state:'FAILED',status:'POSTMAN_BRIDGE_FAILED',
    trustedStatus:'POSTMAN_DEVSPACE_WORKTREE_NOT_READY',requestId:null,childSessionId:null,recoveryEligible:false}
  f.parent.session.events=[{type:'tool/result',data:{name:'postman_bridge_status',content:[{type:'text',text:JSON.stringify(evidence)}]}}]
  assert.equal((await f.jobs.stop(f.parent,jobId)).status,'POSTMAN_BRIDGE_STOP_NOT_LIVE','model/tool-result is not evidence')
  f.parent.session.events.push({type:'tool/code-dispatch',data:{name:'postman_bridge_status',isError:false,
    arguments:{bridge_job_id:jobId},content:[{type:'text',text:JSON.stringify({...evidence,requestId:'REQ_20261015T090000Z_0001'})}]}})
  assert.equal((await f.jobs.stop(f.parent,jobId)).status,'POSTMAN_BRIDGE_STOP_NOT_LIVE','any recorded REQ forbids release')
  f.parent.session.events.push({type:'tool/code-dispatch',data:{name:'postman_bridge_status',isError:false,
    arguments:{bridge_job_id:jobId},content:[{type:'text',text:JSON.stringify(evidence)}]}})
  const response=await f.jobs.stop(f.parent,jobId)
  assert.equal(response.status,'POSTMAN_BRIDGE_NOT_SENT',JSON.stringify(response))
  assert.ok(POSTMAN_PTC_SUCCESS_STATUSES.postman_bridge_stop.includes(response.status))
  const row=f.registry.get(f.parent.id);assert.equal(row.bridgeOperations[jobId].state,'received')
  assert.equal(row.bridgeOperations[jobId].preSendFailure,'POSTMAN_DEVSPACE_WORKTREE_NOT_READY')
  assert.equal(row.devspaceLanes[laneId],undefined)
  assert.equal(f.jobs.list(f.parent).used,0,'cold stop releases capacity as well as lane ownership')
  assert.equal(f.launches.length,0)
  assert.equal((await f.jobs.status(f.parent,jobId)).status,'POSTMAN_BRIDGE_NOT_SENT')
  assert.equal((await f.jobs.stop(f.parent,jobId)).status,'POSTMAN_BRIDGE_STOP_NOT_LIVE','not a repeatable release')
})

test('unproven received/not-sent is still capacity held without verified pre-send refusal',async t=>{
  const f=await fixture(t,{readOnly:false}),id='22222222-3333-4444-8555-666666666666'
  await f.contexts.changeRecord(f.parent.id,row=>({...row,bridgeOperations:{...row.bridgeOperations,
    [id]:{state:'received',phase:'not-sent',transportKind:'devspace',
      synchronization:'not-required',devspace:{mode:'WRITE_ISOLATED'}}}}))
  assert.equal(f.jobs.list(f.parent).used,1,'absence of REQ without trusted preflight evidence remains reserved')
})

test('verified received DevSpace terminal may continue in existing dirty implementation task',async t=>{
  const f=await fixture(t,{readOnly:false}),requestId='REQ_20260101T000000Z_0001'
  await f.contexts.changeRecord(f.parent.id,row=>({...row,bridgeOperations:{...row.bridgeOperations,
    'prior-verifiable':{state:'received',phase:'synchronized',transportKind:'devspace',requestId,
      synchronization:'not-required',devspace:{mode:'WRITE_ISOLATED'},
      terminal:{status:'POSTMAN_BRIDGE_TERMINAL',requestId,transportKind:'devspace',
        terminalStatus:'COMPLETED',result:{requestId,ok:true,code:'DEVSPACE_DIAGNOSTIC'}}}}}))
  const next=await f.acceptIsolated();assert.equal(next.status,'POSTMAN_BRIDGE_ACCEPTED')
  await flush();assert.equal(f.launches.length,1,'only a previously verified terminal may waive clean worktree on continuation')
  f.finish(1);await flush()
})
test('real Host-approved disjoint directories run independently; nested overlapping directory queues', async t => {
  const f = await fixture(t)
  const parentRoot = mkdtempSync(join(tmpdir(), 'postman-real-host-scopes-'))
  t.after(() => rmSync(parentRoot, { recursive: true, force: true }))
  const a = join(parentRoot, 'scope-A'), b = join(parentRoot, 'scope-B'), nested = join(a, 'nested')
  for (const dir of [a, b, nested]) mkdirSync(dir, { recursive: true })
  const tool = createPostmanBridgeTool(f.ctx, f.jobs, f.contexts)
  const accept = root => tool.execute({ message: '@PostmanDevspace exact real Host scope',
    workspace_root: root, workspace_access: 'write' }, { agent: f.parent, signal: new AbortController().signal })
  const [one, two] = await Promise.all([accept(a), accept(b)])
  assert.equal(one.status, 'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal(two.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await flush()
  assert.equal(f.launches.length, 2, 'two independent real directories do not serialize')
  const queued = await accept(nested)
  assert.equal(queued.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await flush()
  assert.equal(f.launches.length, 2, 'nested writer must not race its parent writer')
  f.finish(1); await flush()
  assert.equal(f.launches.length, 3, 'nested writer may start after overlapping writer settles')
  f.finish(2); f.finish(3); await flush()
})
