import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const tick=()=>new Promise(r=>setImmediate(r))
async function flush(){for(let i=0;i<18;i++)await tick()}
async function fixture(t){
  const parent={id:'resource-leader',session:{header:{origin:'root',agentPreset:'postman-leader',cwd:tmpdir()}},followup(){}}
  const root=join(tmpdir(),'synthetic-task-root'), context=Object.freeze({worktree:root,branch:'task/synthetic',devspaceReadOnly:true})
  const registry=createMemoryTaskRegistry()
  await registry.create(parent.id,{leaderSessionId:parent.id,repository:'x',repositoryPath:root,originUrl:'x',branch:'task/synthetic',worktree:root,baseCommit:'a'.repeat(40),stage:'ready',diagnostic:null,workers:{},runner:{state:'none',requestId:null},bridge:null})
  const listeners=new Set(), children=new Map(), launches=[], completed=new Map()
  const contexts={get:()=>context,record:registry.get,records:registry.entries,
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
  return {parent,registry,contexts,jobs,accept,launches,finish,coordinator,setBusy:v=>{workerBusy=v;coordinator.refresh()},root}
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
