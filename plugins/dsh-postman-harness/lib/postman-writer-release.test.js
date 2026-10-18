import test from 'node:test'
import assert from 'node:assert/strict'
import {createPostmanTaskContexts} from './postman-task-context.js'
import {createMemoryTaskRegistry,openPostmanTaskRegistry} from './postman-task-registry.js'
import {JsonStorageBackend} from '@deepseek-ai/dsh-storage-json'
import {DomainFacility} from '@deepseek-ai/dsh-storage-domain'
import {writerRuntimeFixture} from './fixtures/postman-writer-runtime.js'
import {readFile,writeFile,access,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createDevspaceChannel,devspaceRoot,revokeDevspaceChannel} from './postman-devspace.js'
import {createWriterRuntime,startWriterControl} from '../../../devspace/writer-runtime.mjs'
import {createPostmanBridgeJobs} from './postman-bridge-jobs.js'
import {devspaceWriterHoldRoot,readDevspaceWriterHold} from './postman-writer-proof.js'

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const until=async predicate=>{const deadline=Date.now()+15000;while(!await predicate()){if(Date.now()>deadline)throw Error('native test condition timed out');await sleep(25)}}
const exists=async file=>{try{await access(file);return true}catch{return false}}
async function registryFixture(f,{retired=false,registry=createMemoryTaskRegistry()}={}) {
  const old={leaderSessionId:f.binding.leaderSessionId,repository:'andrewverhoturov1/dsh-workspace',repositoryPath:f.worktree,
    originUrl:'https://github.com/andrewverhoturov1/dsh-workspace.git',baseCommit:'a'.repeat(40),branch:f.branch,worktree:f.worktree,
    stage:'closed',diagnostic:null,workers:{},runner:{state:'none',requestId:null},bridge:null,
    bridgeOperations:{[f.binding.jobId]:{state:'unknown',transportKind:'devspace',childSessionId:f.binding.lunaSessionId,
      requestId:f.binding.requestId,executionRevoked:true,archivedAt:new Date().toISOString(),residualWriteRoot:f.worktree,
      devspace:{mode:'WRITE_ISOLATED',channel:f.binding.channel},terminal:{oldOutcome:'UNKNOWN'}}}}
  await registry.create(f.binding.leaderSessionId,retired ? {...old,branch:'task/postman-'+'f'.repeat(32),worktree:join(f.directory,'new-worktree'),
    stage:'ready',bridgeOperations:{},retiredTasks:[old]} : old)
  const contexts=createPostmanTaskContexts({registry,writerControlFile:f.control.file})
  return {registry,contexts,old,operation:()=>{
    const row=registry.get(f.binding.leaderSessionId)
    return (retired?row.retiredTasks[0]:row).bridgeOperations[f.binding.jobId]
  }}
}

test('an archived own native writer has an addressed release route instead of an eternal conflict', async () => {
  const registry = createMemoryTaskRegistry()
  const contexts = createPostmanTaskContexts({registry})
  assert.equal(typeof contexts.reconcileWriter, 'function',
    'an UNKNOWN archived writer can never be reconciled after its physical process exits')
})

for(const retired of [false,true])test('a settled native writer is not held by a disjoint promoted Secretary '+retired,async t=>{
  const f=await writerRuntimeFixture(t),{contexts,registry}=await registryFixture(f)
  assert.equal((await f.operations('process.exit(0)')).exitCode,0)
  f.revoke()
  const secretary={id:'research-secretary',workerType:'secretary',state:'ready',delivery:'none',
    lifecycle:{version:1,admissions:[{id:'initial',state:'accepted',messageId:'native-message',worktree:join(f.directory,'original-research')}],reports:[]}}
  const save=entry=>registry.change(f.binding.leaderSessionId,row=>({...row,
    ...(retired?{retiredWorkers:[entry]}:{workers:{[entry.id]:entry}})}))
  await save({...secretary,lifecycle:{...secretary.lifecycle,admissions:[...secretary.lifecycle.admissions,
    {id:'later',state:'accepted',messageId:'later-message',worktree:f.worktree}]}})
  assert.equal((await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)).diagnostic.code,'OTHER_WRITER_ACTIVE',
    'a later admission into this root still retains it, even after retirement')
  await save(secretary)
  const result=await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  console.log(JSON.stringify({scenario:'disjoint-secretary',retired,result}))
  assert.equal(result.status,'POSTMAN_WRITER_RELEASED',JSON.stringify(result))
})

test('other overlapping writers and uncertain Workers block release; independent roots and reads pass',async t=>{
  const f=await writerRuntimeFixture(t),{contexts,registry,operation,old}=await registryFixture(f)
  const actual=await f.operations('console.log("real native output")')
  assert.equal(actual.exitCode,0,JSON.stringify(actual)); assert.match(actual.output,/real native output/)
  assert.equal(devspaceWriterHoldRoot({leaderSessionId:f.binding.leaderSessionId,bridgeJobId:f.binding.jobId,
    task:old,op:operation()}),null,'a finite foreground tree releases its transient hold without an extra reconciliation')
  f.revoke()
  const lost=createPostmanTaskContexts({registry,
    writerControlFile:join(f.directory,'lost-runtime')})
  const noController=await lost.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  assert.equal(noController.status,'POSTMAN_WRITER_EXIT_UNPROVEN')
  assert.equal(noController.diagnostic.code,'DEVSPACE_NATIVE_PROOF_UNAVAILABLE')
  await registry.create('other',{...old,leaderSessionId:'other',bridgeOperations:{foreign:{...operation(),requestId:'REQ_20261017T123457Z_1234'}}})
  let result=await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  assert.equal(result.diagnostic.code,'OTHER_WRITER_ACTIVE')
  await registry.change('other',row=>({...row,worktree:join(f.directory,'independent'),bridgeOperations:{
    foreign:{...row.bridgeOperations.foreign,residualWriteRoot:join(f.directory,'independent')},
    reading:{state:'pending',transportKind:'devspace',devspace:{mode:'READ_ONLY',approvedRoot:f.worktree,approvedAccess:'read'}}}}))
  await registry.change(f.binding.leaderSessionId,row=>({...row,workers:{worker:{id:'worker',state:'uncertain',delivery:'unknown'}}}))
  result=await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  assert.equal(result.diagnostic.code,'OTHER_WRITER_ACTIVE')
  await registry.change(f.binding.leaderSessionId,row=>({...row,workers:{}}))
  await registry.change(f.binding.leaderSessionId,row=>({...row,retiredWorkers:[{id:'legacy-shell-worker',state:'ready',delivery:'none'}]}))
  assert.equal((await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)).diagnostic.code,'OTHER_WRITER_ACTIVE')
  await registry.change(f.binding.leaderSessionId,row=>({...row,retiredWorkers:[],appJobs:{app:{jobId:'native-app',worktree:f.worktree}}}))
  assert.equal((await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)).diagnostic.code,'OTHER_WRITER_ACTIVE')
  await registry.change(f.binding.leaderSessionId,row=>({...row,appJobs:{app:{jobId:'native-app',worktree:join(f.directory,'independent')}}}))
  result=await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  assert.equal(result.status,'POSTMAN_WRITER_RELEASED',JSON.stringify(result))
  let writes=0
  const ordinary=await f.runtime.runTool('write',{workspace_id:'native'},{_meta:{'openai/session':'new-independent-task'}},f.workspaces,async()=>{writes++;return {ok:true}})
  assert.equal(ordinary.ok,true,JSON.stringify(ordinary)); assert.equal(writes,1,'a released root does not keep an eternal runtime tombstone')
  const oldScope=await f.runtime.runTool('write',{workspace_id:'native'},f.meta,f.workspaces,async()=>{writes++;return {bad:true}})
  assert.equal(oldScope.isError,true); assert.equal(writes,1,'revoked original scope remains fenced')
})

test('actual native settlement persists through strict JSON registry close and reopen',async t=>{
  const f=await writerRuntimeFixture(t)
  const backend=new JsonStorageBackend(join(f.directory,'registry'))
  const facility=()=>new DomainFacility({storage:{backend:{get:()=>backend}},emit(){}},{backend:'json'})
  const registry=await openPostmanTaskRegistry(facility())
  const {contexts}=await registryFixture(f,{registry})
  const actual=await f.operations('process.exit(0)'); assert.equal(actual.exitCode,0)
  f.revoke()
  const result=await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  assert.equal(result.status,'POSTMAN_WRITER_RELEASED',JSON.stringify(result))
  await registry.close()
  const coldRegistry=await openPostmanTaskRegistry(facility())
  try {
    const cold=createPostmanTaskContexts({registry:coldRegistry,writerControlFile:join(f.directory,'missing-controller')})
    const again=await cold.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
    assert.equal(again.status,'POSTMAN_WRITER_ALREADY_RELEASED')
    assert.deepEqual(again.writerSettlement,result.writerSettlement)
    assert.equal(coldRegistry.get(f.binding.leaderSessionId).bridgeOperations[f.binding.jobId].residualWriteRoot,undefined)
  } finally {await coldRegistry.close();await backend.close()}
})

for(const retired of [false,true]) test('real native descendant exit releases '+(retired?'retired':'closed')+' writer, durable and idempotent without changing files', {timeout:30000},async t=>{
  const f=await writerRuntimeFixture(t)
  const {registry,contexts,operation}=await registryFixture(f,{retired})
  const kept=join(f.worktree,'kept.txt'), rootExit=join(f.worktree,'root-exited'), childExit=join(f.worktree,'release-child'), started=join(f.worktree,'child-started')
  await writeFile(kept,'user staged and ignored content: unchanged\n')
  const child=`const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(childExit)})){clearInterval(timer)}},25)`
  const parent=`const {spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync(${JSON.stringify(rootExit)},String(process.pid))`
  let settled=false
  const running=f.operations(parent).finally(()=>{settled=true})
  await until(async()=>await exists(rootExit)&&await exists(started))
  const rootPid=Number(await readFile(rootExit,'utf8'))
  await until(()=>{try{process.kill(rootPid,0);return false}catch{return true}})
  assert.equal(settled,false,'root exited, but its detached descendant is still a writer')
  f.revoke()
  const pending=await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  assert.equal(pending.status,'POSTMAN_WRITER_EXIT_UNPROVEN',JSON.stringify(pending))
  assert.equal(pending.diagnostic.code,'WRITER_STILL_RUNNING')
  assert.equal(operation().residualWriteRoot,f.worktree)
  const forbidden=await f.runtime.runTool('write',{workspace_id:'native'},f.meta,f.workspaces,async()=>{throw Error('revoked writer ran')})
  assert.equal(forbidden.isError,true)
  await writeFile(childExit,'exit')
  const native=await running
  assert.equal(native.exitCode,0,JSON.stringify(native))
  const released=await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  assert.equal(released.status,'POSTMAN_WRITER_RELEASED',JSON.stringify(released))
  assert.equal(operation().residualWriteRoot,undefined)
  assert.deepEqual(operation().terminal,{oldOutcome:'UNKNOWN'})
  assert.equal(await readFile(kept,'utf8'),'user staged and ignored content: unchanged\n')
  const saved=JSON.parse(JSON.stringify(registry.get(f.binding.leaderSessionId)))
  const coldRegistry=createMemoryTaskRegistry(); await coldRegistry.create(f.binding.leaderSessionId,saved)
  const cold=createPostmanTaskContexts({registry:coldRegistry,writerControlFile:join(f.directory,'missing-controller')})
  const again=await cold.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  assert.equal(again.status,'POSTMAN_WRITER_ALREADY_RELEASED')
  assert.deepEqual(again.writerSettlement,released.writerSettlement)
})

test('missing native observation, foreign owner and model prose cannot release a writer',async t=>{
  const f=await writerRuntimeFixture(t),{contexts,operation}=await registryFixture(f)
  const foreign=await contexts.reconcileWriter('other-leader',f.binding.jobId)
  assert.equal(foreign.status,'POSTMAN_WRITER_OWNER_MISMATCH')
  const invented=await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId,{receipt:{jobSettled:true,exitCode:0}})
  assert.equal(invented.status,'POSTMAN_WRITER_EXIT_UNPROVEN')
  assert.equal(operation().residualWriteRoot,f.worktree)
  const response=await fetch('http://127.0.0.1:'+f.control.port+'/reconcile',{method:'POST',body:JSON.stringify({jobSettled:true})})
  assert.equal(response.status,403)
  f.revoke()
  const otherScope=await f.runtime.runTool('write',{workspace_id:'native'},{_meta:{'openai/session':'shifted'}},f.workspaces,async()=>({bad:true}))
  assert.equal(otherScope.isError,true)
  const missingMeta=await f.runtime.runTool('write',{workspace_id:'native'},{},f.workspaces,async()=>({bad:true}))
  assert.equal(missingMeta.isError,true)
})

test('an explicit new private generation in the same conversation fences the old workspace and permits independent reads',async t=>{
  const f=await writerRuntimeFixture(t)
  const ancestor=await f.runtime.runTool('write',{workspace_id:'ancestor'},f.meta,{getWorkspace:async()=>({root:f.directory})},async()=>({bad:true}))
  assert.equal(ancestor.isError,true,'an ancestor is outside the granted write root')
  f.revoke()
  const next=createDevspaceChannel({bridgeJobId:randomUUID(),leaderSessionId:f.binding.leaderSessionId,lunaSessionId:'new-luna',
    requestId:'REQ_20261017T123458Z_1234',worktree:f.worktree,branch:f.branch,mode:'WRITE_TEST',sourceRoot:f.directory})
  const claim=await f.runtime.runTool('open_workspace',{path:'postman-writer:'+next.jobId},f.meta,f.workspaces,async()=>({ok:true}),true)
  assert.equal(claim.ok,true,JSON.stringify(claim))
  const oldWrite=await f.runtime.runTool('write',{workspace_id:'old'},f.meta,f.workspaces,async()=>({bad:true}))
  assert.equal(oldWrite.isError,true)
  const ownWrite=await f.runtime.runTool('write',{workspace_id:'new'},f.meta,{getWorkspace:async()=>({root:next.writeRoot})},async()=>({ok:true}))
  assert.equal(ownWrite.ok,true)
  const read=await f.runtime.runTool('read',{workspace_id:'old'},{_meta:{'openai/session':'independent-reader'}},f.workspaces,async()=>({read:true}),true)
  assert.equal(read.read,true)
})

test('shifted metadata cannot create a Git worktree through the upstream readOnlyHint annotation',async t=>{
  const f=await writerRuntimeFixture(t)
  let mutations=0
  const result=await f.runtime.runTool('open_workspace',{path:f.worktree,mode:'worktree'},
    {_meta:{'openai/session':'shifted-worktree'}},f.workspaces,async()=>{mutations++;return {created:true}},true)
  assert.equal(mutations,0,'mode worktree mutates Git even though upstream annotates open_workspace as read only')
  assert.equal(result.isError,true)
  const reading=await f.runtime.runTool('open_workspace',{path:f.worktree,mode:'checkout'},
    {_meta:{'openai/session':'independent-reading'}},f.workspaces,async()=>({reading:true}),true)
  assert.equal(reading.reading,true)
  const fresh=createWriterRuntime({root:devspaceRoot()})
  const native=await fresh.runTool('open_workspace',{path:f.worktree,mode:'worktree'},
    {_meta:{'openai/session':'earlier-native-git'}},f.workspaces,async()=>({created:true}),true)
  assert.equal(native.created,true)
  const freshBinding=createDevspaceChannel({bridgeJobId:randomUUID(),leaderSessionId:f.binding.leaderSessionId,lunaSessionId:'fresh-git-luna',
    requestId:'REQ_20261017T123501Z_1234',worktree:f.worktree,branch:f.branch,mode:'WRITE_ISOLATED',sourceRoot:f.directory})
  const claim=await fresh.runTool('open_workspace',{path:'postman-writer:'+freshBinding.jobId},f.meta,f.workspaces,async()=>({ok:true}),true)
  assert.equal(claim.ok,true)
  revokeDevspaceChannel(freshBinding)
  assert.equal(fresh.reconcile(freshBinding).code,'OTHER_WRITER_ACTIVE',
    'settling an uninstrumented Git worktree Promise does not prove that its native descendants exited')
})

test('background writer remains held after foreground exit and UI stop; actual addressed tree stop releases it through strict JSON cold reopen', {
  skip:process.platform!=='win32',timeout:30000,
},async t=>{
  const f=await writerRuntimeFixture(t)
  const backend=new JsonStorageBackend(join(f.directory,'background-registry'))
  const facility=()=>new DomainFacility({storage:{backend:{get:()=>backend}},emit(){}},{backend:'json'})
  let registry=await openPostmanTaskRegistry(facility())
  t.after(async()=>{await registry.close();await backend.close()})
  const {contexts,operation}=await registryFixture(f,{registry})
  await registry.change(f.binding.leaderSessionId,row=>{
    const {archivedAt,executionRevoked,residualWriteRoot,...saved}=operation()
    return {...row,stage:'ready',bridgeOperations:{[f.binding.jobId]:{...saved,state:'received',synchronization:'not-required',
      terminal:{status:'POSTMAN_BRIDGE_TERMINAL',terminalStatus:'COMPLETED',transportKind:'devspace',requestId:f.binding.requestId,
        result:{source:'bell',requestId:f.binding.requestId,reportedOutcome:'DONE',message:'Background application started'}}}}}
  })
  const kept=join(f.worktree,'kept.txt'),portFile=join(f.worktree,'owned-port'),parentFile=join(f.worktree,'foreground-finished')
  await writeFile(kept,'preserved old user file\n')
  const app=`const fs=require('fs');const server=require('http').createServer((q,r)=>r.end('owned background'));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(portFile)},String(server.address().port)))`
  const parent=`const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(app)}],{detached:true,stdio:'ignore'});child.unref();require('fs').writeFileSync(${JSON.stringify(parentFile)},String(process.pid))`
  const started=await f.background({execution:'background',command:parent,timeout:1})
  assert.notEqual(started.isError,true,JSON.stringify(started))
  const job_id=started.structuredContent?.native_job_id
  assert.match(job_id??'',/^[0-9a-f-]{36}$/)
  assert.equal(started.structuredContent.treeSettled,false)
  await until(async()=>await exists(portFile)&&await exists(parentFile))
  const url='http://127.0.0.1:'+await readFile(portFile,'utf8')
  const health=async()=>{try{return await (await fetch(url,{signal:AbortSignal.timeout(1000)})).text()==='owned background'}catch{return false}}
  let waiting
  try {await until(async()=>{
    waiting=await f.background({execution:'status',job_id})
    return waiting.structuredContent?.foregroundFinished===true && await health()
  })} catch(error) {throw Error('Background foreground observation: '+JSON.stringify({status:waiting,alive:await health()}),{cause:error})}
  // The shortened command wait has elapsed; a deliberate background app stays alive.
  await sleep(1200)
  assert.equal(await health(),true)
  const running=await f.background({execution:'status',job_id})
  assert.equal(running.structuredContent.state,'BACKGROUND_RUNNING')
  assert.equal(running.structuredContent.foregroundFinished,true)
  assert.equal(running.structuredContent.treeSettled,false)
  assert.equal(contexts.hasConflictingRetiredWriter(f.binding.leaderSessionId),true,
    'ordinary Worker admission sees the native hold even after a received DONE')
  const separate=join(f.directory,'independent');await mkdir(separate)
  const leader={id:f.binding.leaderSessionId,session:{header:{agentPreset:'postman-leader',delegationDepth:0}},followup(){}}
  const gates=[]
  const coordinator={run(signal,_fn,ready){gates.push(ready);return new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(Error('owned test queue disposed')),{once:true})})},refresh(){},dispose(){}}
  const guardedContexts={get:()=>({worktree:f.worktree,branch:f.branch,repository:'andrewverhoturov1/dsh-workspace'}),
    record:id=>registry.get(id),records:()=>registry.entries(),changeRecord:(id,fn)=>registry.change(id,fn)}
  const jobs=createPostmanBridgeJobs({agents:{get:id=>id===leader.id?leader:null}},coordinator,null,guardedContexts,null,{dispose(){}})
  try {
    const conflict=await jobs.accept(leader,'@PostmanDevspace conflicting write','devspace',undefined,undefined,
      'WRITE_APPROVED_TARGET',undefined,{root:f.worktree,access:'write'})
    assert.equal(conflict.status,'POSTMAN_BRIDGE_ACCEPTED')
    assert.equal(gates.at(-1)(),false,'DONE from the web does not allow a second writer over a running native background job')
    const reading=await jobs.accept(leader,'@PostmanDevspace read while app runs','devspace',undefined,undefined,'READ_ONLY')
    assert.equal(reading.status,'POSTMAN_BRIDGE_ACCEPTED');assert.equal(gates.at(-1)(),true)
    const separateWrite=await jobs.accept(leader,'@PostmanDevspace independent write','devspace',undefined,undefined,
      'WRITE_APPROVED_TARGET',undefined,{root:separate,access:'write'})
    assert.equal(separateWrite.status,'POSTMAN_BRIDGE_ACCEPTED')
    assert.equal(gates.at(-1)(),true)
  } finally {await jobs.dispose()}
  await registry.change(f.binding.leaderSessionId,row=>({...row,bridgeOperations:{[f.binding.jobId]:operation()}}))
  const leaseFile=join(f.binding.channel,'writer-hold.json'),lease=await readFile(leaseFile,'utf8')
  await writeFile(leaseFile,JSON.stringify({...JSON.parse(lease),generation:randomUUID()}))
  const mixed=readDevspaceWriterHold({leaderSessionId:f.binding.leaderSessionId,bridgeJobId:f.binding.jobId,
    task:registry.get(f.binding.leaderSessionId),op:operation()})
  assert.deepEqual(mixed,{root:f.worktree,verified:false})
  assert.equal((await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)).status,'POSTMAN_WRITER_EXIT_UNPROVEN')
  assert.equal(await exists(join(f.binding.channel,'revoked.json')),false,'mixed generation is not authority to revoke the delivered operation')
  await writeFile(leaseFile,lease)
  const delivered=await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  assert.equal(delivered.status,'POSTMAN_WRITER_EXIT_UNPROVEN',JSON.stringify(delivered))
  assert.equal(operation().archivedAt,undefined,'native reconciliation does not archive the delivered web result')
  assert.equal(devspaceWriterHoldRoot({leaderSessionId:f.binding.leaderSessionId,bridgeJobId:f.binding.jobId,
    task:registry.get(f.binding.leaderSessionId),op:operation()}),f.worktree)
  await registry.change(f.binding.leaderSessionId,row=>({...row,stage:'closed',bridgeOperations:{[f.binding.jobId]:{
    ...operation(),executionRevoked:true,archivedAt:new Date().toISOString(),residualWriteRoot:f.worktree}}}))
  f.revoke()
  const oldTerminal=JSON.parse(JSON.stringify(operation().terminal))
  const pending=await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId,
    {receipt:{jobSettled:true,uiStop:true,exitCode:0}})
  assert.equal(pending.status,'POSTMAN_WRITER_EXIT_UNPROVEN',JSON.stringify(pending))
  assert.equal(pending.diagnostic.code,'WRITER_STILL_RUNNING')
  assert.equal(operation().residualWriteRoot,f.worktree)
  assert.equal(operation().writerSettlement,undefined)
  assert.equal((await contexts.reconcileWriter('foreign-leader',f.binding.jobId)).status,'POSTMAN_WRITER_OWNER_MISMATCH')
  const noController=createPostmanTaskContexts({registry,writerControlFile:join(f.directory,'missing-controller')})
  assert.equal((await noController.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)).status,'POSTMAN_WRITER_EXIT_UNPROVEN')
  const conflicting=await f.runtime.runTool('write',{workspace_id:'native'},
    {_meta:{'openai/session':'foreign-writer'}},f.workspaces,()=>{throw Error('conflicting writer started')})
  assert.equal(conflicting.isError,true)
  const read=await f.runtime.runTool('read',{workspace_id:'native'},
    {_meta:{'openai/session':'independent-reader'}},f.workspaces,async()=>({read:await readFile(kept,'utf8')}),true)
  assert.equal(read.read,'preserved old user file\n')
  let independent=false
  const other=await f.runtime.runTool('write',{workspace_id:'independent'},
    {_meta:{'openai/session':'independent-writer'}},{getWorkspace:async()=>({root:separate})},async()=>{independent=true;return {ok:true}})
  assert.equal(other.ok,true);assert.equal(independent,true)
  const foreignStop=await f.background({execution:'stop',job_id},{meta:{_meta:{'openai/session':'foreign-chat'}}})
  assert.equal(foreignStop.isError,true)
  assert.equal((await f.background({execution:'status',job_id},{meta:{}})).isError,true)
  const next=createDevspaceChannel({bridgeJobId:randomUUID(),leaderSessionId:f.binding.leaderSessionId,lunaSessionId:'next-luna',
    requestId:'REQ_20261017T123459Z_1234',worktree:f.worktree,branch:f.branch,mode:'WRITE_TEST',sourceRoot:f.directory})
  const nextMeta={_meta:{'openai/session':'different-generation'}}
  const nextClaim=await f.runtime.runTool('open_workspace',{path:'postman-writer:'+next.jobId},nextMeta,
    f.workspaces,async()=>({ok:true}),true)
  assert.equal(nextClaim.ok,true,JSON.stringify(nextClaim))
  const mixedStop=await f.background({execution:'stop',job_id},{meta:nextMeta,cwd:next.writeRoot})
  assert.equal(mixedStop.isError,true,'another owned generation cannot stop this native job')
  assert.equal(await health(),true)
  await registry.change(f.binding.leaderSessionId,row=>({...row,bridgeOperations:{...row.bridgeOperations,
    [f.binding.jobId]:{...operation(),requestId:'REQ_20261017T123500Z_1234'}}}))
  assert.equal((await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)).status,'POSTMAN_WRITER_EXIT_UNPROVEN')
  await registry.change(f.binding.leaderSessionId,row=>({...row,bridgeOperations:{...row.bridgeOperations,
    [f.binding.jobId]:{...operation(),requestId:f.binding.requestId}}}))
  const lost=createWriterRuntime({root:devspaceRoot()})
  const rejectedClaim=await lost.runTool('open_workspace',{path:'postman-writer:'+f.binding.jobId},f.meta,f.workspaces,async()=>({bad:true}),true)
  assert.equal(rejectedClaim.isError,true)
  const lostControl=await startWriterControl(lost,{file:join(f.directory,'lost-controller.json')})
  try {
    const lostContexts=createPostmanTaskContexts({registry,writerControlFile:lostControl.file})
    assert.equal((await lostContexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)).status,'POSTMAN_WRITER_EXIT_UNPROVEN',
      'a rejected cold claim cannot invent knowledge of the previous native generation')
  } finally {await lostControl.close()}
  assert.equal(operation().residualWriteRoot,f.worktree)
  const stopped=await f.background({execution:'stop',job_id})
  assert.notEqual(stopped.isError,true,JSON.stringify(stopped))
  await until(async()=>(await f.background({execution:'status',job_id})).structuredContent?.treeSettled===true)
  const settled=await f.background({execution:'status',job_id})
  assert.equal(settled.structuredContent.state,'TREE_SETTLED')
  assert.equal(await health(),false)
  const released=await contexts.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  assert.equal(released.status,'POSTMAN_WRITER_RELEASED',JSON.stringify(released))
  assert.equal(released.writerSettlement.source,'devspace_native_tree')
  assert.equal(operation().residualWriteRoot,undefined)
  assert.equal(contexts.hasConflictingRetiredWriter(f.binding.leaderSessionId),false)
  assert.equal(await exists(leaseFile),false,'a native hold is cleared only after its exact settlement was durably saved')
  const restarted=createWriterRuntime({root:devspaceRoot()})
  const staleWrite=await restarted.runTool('write',{workspace_id:'native'},f.meta,f.workspaces,
    async()=>{throw Error('revoked generation was resurrected after its native hold was cleared')})
  assert.equal(staleWrite.isError,true)
  const newWrite=await restarted.runTool('write',{workspace_id:'native'},{_meta:{'openai/session':'new-independent-after-release'}},
    f.workspaces,async()=>{await writeFile(join(f.worktree,'new-independent-file'),'new task');return {ok:true}})
  assert.equal(newWrite.ok,true,JSON.stringify(newWrite))
  assert.deepEqual(operation().terminal,oldTerminal)
  assert.equal(await readFile(kept,'utf8'),'preserved old user file\n')
  await registry.close()
  registry=await openPostmanTaskRegistry(facility())
  const cold=createPostmanTaskContexts({registry,writerControlFile:join(f.directory,'no-live-controller')})
  const again=await cold.reconcileWriter(f.binding.leaderSessionId,f.binding.jobId)
  assert.equal(again.status,'POSTMAN_WRITER_ALREADY_RELEASED')
  assert.deepEqual(again.writerSettlement,released.writerSettlement)
  assert.equal(registry.get(f.binding.leaderSessionId).bridgeOperations[f.binding.jobId].residualWriteRoot,undefined)
  assert.deepEqual(registry.get(f.binding.leaderSessionId).bridgeOperations[f.binding.jobId].terminal,oldTerminal)
  assert.equal(await readFile(kept,'utf8'),'preserved old user file\n')
})
