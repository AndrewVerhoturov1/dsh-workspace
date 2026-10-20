import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeTool } from './postman-bridge.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { createDevspaceChannel } from './postman-devspace.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
const tick=()=>new Promise(r=>setImmediate(r))
async function flush(){for(let i=0;i<18;i++)await tick()}
async function fixture(t,{readOnly=true,launchDelay=false}={}){
  const parent={id:'resource-leader',session:{header:{origin:'root',agentPreset:'postman-leader',cwd:tmpdir()}},followup(){}}
  const root=join(tmpdir(),'synthetic-task-root'), context=Object.freeze({worktree:root,branch:'task/synthetic',devspaceReadOnly:readOnly})
  const registry=createMemoryTaskRegistry()
  await registry.create(parent.id,{leaderSessionId:parent.id,repository:'x',repositoryPath:root,originUrl:'x',branch:'task/synthetic',worktree:root,baseCommit:'a'.repeat(40),stage:'ready',diagnostic:null,workers:{},runner:{state:'none',requestId:null},bridge:null})
  const listeners=new Set(), children=new Map(), launches=[], completed=new Map()
  const contexts={get:()=>context,record:registry.get,records:registry.entries,verifyWorktree:async()=>false,
    async changeRecord(id,fn){const v=await registry.change(id,fn);for(const f of listeners)f(id);return v},
    onContextChange(f){listeners.add(f);return()=>listeners.delete(f)}}
  let workerBusy=false,stamp=0
  const coordinator=createPostmanBridgeLaunchCoordinator({now:()=>launchDelay?0:++stamp*20000,random:()=>0});coordinator.fork=()=>coordinator
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

for (const mode of [undefined, 'WRITE_TEST', 'READ_ONLY'])
test('external source read scope preserves private output: ' + (mode ?? 'default'), async t => {
  const f=await fixture(t)
  const root=mkdtempSync(join(tmpdir(),'devspace-read-output-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const project=join(root,'project');mkdirSync(project)
  const tool=createPostmanBridgeTool(f.ctx,f.jobs,f.contexts)
  const accepted=await tool.execute({message:'@PostmanDevspace inspect the game and save a screenshot',
    workspace_root:project,workspace_access:'read',...(mode?{devspace_mode:mode}:{})},{agent:f.parent})
  assert.equal(accepted.status,'POSTMAN_BRIDGE_ACCEPTED')
  await flush()
  assert.equal(f.launches.length,1)
  const grant=f.launches[0].devspaceBinding
  assert.equal(grant.mode,mode==='READ_ONLY'?'READ_ONLY':'WRITE_TEST')
  assert.equal(grant.computerUse,'allow')
  const binding=createDevspaceChannel({...grant,root:join(root,'private'),sourceRoot:root,
    requestId:'REQ_20261019T090000Z_0001'})
  assert.equal(binding.workspaceRef,project)
  assert.equal(binding.writeRoot,mode==='READ_ONLY'?null:join(binding.channel,'workspace'))
  assert.notEqual(binding.writeRoot,project)
  assert.equal(f.registry.get(f.parent.id).bridgeOperations[accepted.bridgeJobId].devspace.computerUse,'allow')
  f.finish(1);await flush()
})
test('Leader may launch overlapping writers without waiting for terminal release',async t=>{
  const f=await fixture(t), [a,b]=await Promise.all([f.accept(),f.accept()]);await flush()
  assert.equal(a.status,'POSTMAN_BRIDGE_ACCEPTED');assert.equal(b.status,'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal(f.launches.length,2);assert.equal((await f.jobs.status(f.parent,b.bridgeJobId)).state,'RUNNING')
  f.finish(1);await flush();assert.equal(f.launches.length,2)
  f.coordinator.refresh();f.coordinator.refresh();assert.equal(f.launches.length,2)
  f.finish(2);await flush()
})
test('disjoint approved output roots launch independently',async t=>{
  const f=await fixture(t);await Promise.all([f.accept(),f.accept(join(tmpdir(),'synthetic-approved-B'))]);await flush()
  assert.equal(f.launches.length,2);f.finish(1);f.finish(2);await flush()
})
test('cancel queued reservation never sends and releases exactly once',async t=>{
  const f=await fixture(t,{launchDelay:true}),a=await f.accept(),b=await f.accept();await flush()
  const stopped=await f.jobs.stop(f.parent,b.bridgeJobId)
  assert.equal(stopped.status,'POSTMAN_BRIDGE_STOP_REQUESTED');assert.equal(f.launches.length,1)
  f.finish(1);await flush();f.coordinator.refresh();assert.equal(f.launches.length,1)
})
test('cold UNKNOWN root is evidence for Leader and does not gate new writers',async t=>{
  const f=await fixture(t), cold='synthetic-cold-reservation'
  await f.contexts.changeRecord(f.parent.id,row=>({...row,bridgeOperations:{[cold]:{state:'unknown',phase:'reserved',transportKind:'devspace',createdAt:'2026-01-01',devspace:{mode:'WRITE_APPROVED_TARGET',approvedRoot:join(tmpdir(),'synthetic-approved-A'),approvedAccess:'write'}}}}))
  await f.accept();await f.accept(join(tmpdir(),'synthetic-approved-B'));await flush();assert.equal(f.launches.length,2)
  assert.equal(f.registry.get(f.parent.id).bridgeOperations[cold].state,'unknown')
  f.finish(1);f.finish(2);await flush()
})
test('active Worker does not gate a Leader-authorized Bridge in the same root',async t=>{
  const f=await fixture(t);f.setBusy(true);await f.accept(f.root);await flush();assert.equal(f.launches.length,1)
  f.finish(1);await flush()
})

test('real Host-approved nested directories run concurrently when Leader dispatches them', async t => {
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
  assert.equal(f.launches.length, 3, 'overlapping directories do not impose a Host scheduling policy')
  f.finish(1); await flush()
  assert.equal(f.launches.length, 3, 'settlement does not launch a duplicate')
  f.finish(2); f.finish(3); await flush()
})


test('Git cleanliness and historical not-sent records do not gate current DevSpace execution',async t=>{
 const f=await fixture(t,{readOnly:false})
 await f.contexts.changeRecord(f.parent.id,row=>({...row,bridgeOperations:{history:{state:'received',phase:'not-sent',transportKind:'devspace',devspace:{mode:'WRITE_ISOLATED'}}}}))
 assert.equal(f.jobs.list(f.parent).used,0)
 const first=await f.acceptIsolated();assert.equal(first.status,'POSTMAN_BRIDGE_ACCEPTED')
 await flush();assert.equal(f.launches.length,1)
 f.finish(1);await flush()
 assert.equal(f.jobs.list(f.parent).used,0)
})
