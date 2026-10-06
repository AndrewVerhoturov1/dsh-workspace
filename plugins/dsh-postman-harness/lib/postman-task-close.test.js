import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openPostmanTaskRegistry, createMemoryTaskRegistry } from './postman-task-registry.js'
import { createPostmanTaskContexts } from './postman-task-context.js'
import { createPostmanTaskCloseTool } from './postman-bridge.js'
const exec = promisify(execFile)
const row = { leaderSessionId:'leader', repository:'andrewverhoturov1/dsh-workspace',
  repositoryPath:'C:/repo',originUrl:'https://github.com/AndrewVerhoturov1/dsh-workspace.git',
  branch:'task/postman-'+'a'.repeat(32), worktree:'C:/absent-task',baseCommit:'a'.repeat(40),
  stage:'ready',diagnostic:null,workers:{},runner:{state:'none',requestId:null},bridge:null }
const leader = { id:'leader', session:{header:{cwd:'C:/repo',agentPreset:'postman-leader',origin:'root'}} }
const fixture = async patch => {
  const registry=createMemoryTaskRegistry(); await registry.create('leader',{...row,...patch})
  const contexts=createPostmanTaskContexts({registry,gitCommand:async()=>{throw Error('close must not access Git')}})
  return {registry,contexts}
}
for (const [name,patch] of Object.entries({
  uncertain:{stage:'uncertain'}, intent:{stage:'intent'},
  worker:{workers:{child:{id:'child',state:'ready',delivery:'none',artifactRequests:[]}}},
  runner:{runner:{state:'running',requestId:'REQ'}}, failedRunner:{runner:{state:'failed',requestId:'REQ'}},
  unknownRunner:{runner:{state:'unknown',requestId:'REQ'}},
  bridge:{bridge:{id:'job',state:'pending'}}, queued:{bridgeOperations:{job:{state:'pending'}}},
  unknown:{bridgeOperations:{job:{state:'unknown'}}}, uncertainGrant:{bridgeOperations:{job:{state:'received',synchronization:'synchronized',grantDiagnostic:'disk unavailable'}}}, unsynced:{bridgeOperations:{job:{state:'received',synchronization:'pending'}}}
})) test('task close rejects '+name+' without retiring authority',async()=>{
  const f=await fixture(patch),before=f.registry.get('leader')
  assert.equal((await f.contexts.close(leader)).status,'POSTMAN_TASK_CLOSE_REJECTED')
  assert.equal(f.registry.get('leader'),before)
})
test('task close authorization, settled receipt and durable write failure',async()=>{
  const f=await fixture({bridgeOperations:{job:{state:'received',synchronization:'synchronized'}}})
  const tool=createPostmanTaskCloseTool({agents:{get:id=>id==='leader'?leader:null},subagents:{listDescendants:async()=>[]}},f.contexts)
  assert.equal((await tool.execute({}, {agent:{...leader}})).status,'POSTMAN_TASK_CALLER_REJECTED')
  assert.equal((await f.contexts.close(leader,{isBusy:()=>true})).diagnostic.code,'TASK_OPERATION_BUSY')
  const change=f.registry.change; f.registry.change=async()=>{throw Error('disk unavailable')}
  assert.equal((await tool.execute({}, {agent:leader})).status,'POSTMAN_TASK_CLOSE_REJECTED')
  assert.equal(f.registry.get('leader').stage,'ready');f.registry.change=change
  assert.equal((await tool.execute({}, {agent:leader})).status,'POSTMAN_TASK_CLOSED')
  assert.equal(f.contexts.get('leader'),null)
  assert.equal((await f.contexts.recover(leader)).status,'POSTMAN_TASK_CONTEXT_REQUIRED')
  assert.equal((await tool.execute({}, {agent:leader})).status,'POSTMAN_TASK_CLOSED')
})
test('real Git merged Task A deleted worktree restart prepare UNCERTAIN close CLOSED then Task B READY in same Leader', {timeout:60000},async t=>{
  const temp=await mkdtemp(join(tmpdir(),'postman-task-close-'))
  t.after(()=>rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
  const root=join(temp,'repo'),bare=join(temp,'origin.git')
  const git=async(cwd,...args)=>(await exec('git',['-C',cwd,...args],{windowsHide:true})).stdout.trim()
  await exec('git',['init','--bare',bare]);await exec('git',['init','-b','preview',root])
  await git(root,'config','user.email','test@example.invalid');await git(root,'config','user.name','Task close test')
  await writeFile(join(root,'base.txt'),'base');await git(root,'add','base.txt');await git(root,'commit','-m','base')
  await git(root,'remote','add','origin',bare);await git(root,'push','-u','origin','preview')
  const backend=new JsonStorageBackend(join(temp,'storage'))
  const open=()=>openPostmanTaskRegistry(new DomainFacility({storage:{backend:{get:()=>backend}},emit(){}},{backend:'json'}))
  let registry=await open()
  const gitCommand=(cwd,...args)=>args.join(' ')==='remote get-url origin'?Promise.resolve(row.originUrl):git(cwd,...args)
  const make=()=>createPostmanTaskContexts({registry,gitCommand,temporaryDirectory:()=>temp})
  const sameLeader={id:'leader',session:{header:{cwd:root}}}
  let contexts=make();const a=await contexts.prepare(sameLeader);assert.equal(a.status,'TASK_CONTEXT_READY')
  const token=Symbol('admission');assert.equal(contexts.beginWorkerAdmission('leader',token),true)
  assert.equal((await contexts.close(sameLeader)).diagnostic.code,'TASK_OPERATION_BUSY');contexts.endWorkerAdmission('leader',token)
  assert.equal(contexts.beginOperation('leader'),true)
  assert.equal((await contexts.close(sameLeader)).diagnostic.code,'TASK_OPERATION_BUSY');await contexts.endOperation('leader')
  assert.equal(contexts.beginSync('leader'),true)
  assert.equal((await contexts.close(sameLeader)).diagnostic.code,'TASK_OPERATION_BUSY');contexts.endSync('leader')
  await writeFile(join(a.worktree,'task-a.txt'),'Task A done');await git(a.worktree,'add','task-a.txt');await git(a.worktree,'commit','-m','Task A')
  await git(a.worktree,'push','origin',a.branch)
  await git(root,'merge','--squash',a.branch);await git(root,'commit','-m','merge Task A');await git(root,'push','origin','preview')
  await git(root,'worktree','remove',a.worktree);await git(root,'branch','-D',a.branch);await git(root,'push','origin','--delete',a.branch)
  await assert.rejects(stat(a.worktree),{code:'ENOENT'})
  assert.equal(registry.get('leader').stage,'ready');assert.equal(registry.get('leader').branch,a.branch)
  contexts.dispose();await registry.close();registry=await open();contexts=make()
  assert.deepEqual(await contexts.prepare(sameLeader),{status:'POSTMAN_TASK_PREPARE_UNCERTAIN',diagnostic:'task worktree missing'})
  assert.equal(registry.get('leader').stage,'uncertain');assert.equal(contexts.get('leader'),null)
  contexts.dispose();await registry.close();registry=await open();contexts=make() // diagnostic itself survives restart
  const stale={...registry.get('leader'),bridgeOperations:{}}
  const closeLeader={...sameLeader,session:{header:{...sameLeader.session.header,agentPreset:'postman-leader',origin:'root'}}}
  let descendants=[]
  const closeTool=createPostmanTaskCloseTool({agents:{get:id=>id==='leader'?closeLeader:null},
    subagents:{listDescendants:async()=>descendants}},contexts)
  for(const patch of [{diagnostic:'task branch history uncertain'}, {repositoryPath:join(temp,'foreign')},
    {worktree:root}, {runner:{state:'unknown',requestId:'REQ'}},
    {workers:{child:{id:'child',label:'child',state:'uncertain',delivery:'unknown',artifactRequests:[]}}},
    {bridgeOperations:{job:{state:'unknown'}}}, {bridgeOperations:{job:{state:'received',synchronization:'pending'}}}]){
    await registry.change('leader',()=>({...stale,...patch}))
    const before=JSON.stringify(registry.get('leader'))
    assert.equal((await closeTool.execute({}, {agent:closeLeader})).status,'POSTMAN_TASK_CLOSE_REJECTED')
    assert.equal(JSON.stringify(registry.get('leader')),before)
  }
  await registry.change('leader',()=>stale)
  for(const child of [{kind:'child',id:'queued',activity:'running',mode:'continuable'}, {kind:'diagnostic',id:'uncertain'},
    {kind:'child',id:'unclosed',activity:'inactive',mode:'continuable'}]){
    descendants=[child]
    assert.equal((await closeTool.execute({}, {agent:closeLeader})).diagnostic.code,'CHILD_CLOSURE_UNPROVEN')
    assert.equal(registry.get('leader').stage,'uncertain')
  }
  descendants=[]
  await git(root,'worktree','add','-b',a.branch,a.worktree,a.baseCommit)
  await rm(a.worktree,{recursive:true,force:true}) // leftover Git registration is not settled cleanup
  assert.equal((await closeTool.execute({}, {agent:closeLeader})).status,'POSTMAN_TASK_CLOSE_REJECTED')
  await git(root,'worktree','prune');await git(root,'branch','-D',a.branch)
  await writeFile(a.worktree,'replacement path is not the old tree')
  assert.equal((await closeTool.execute({}, {agent:closeLeader})).status,'POSTMAN_TASK_CLOSE_REJECTED')
  await rm(a.worktree)
  const marker=join(root,await git(root,'rev-parse','--git-path','MERGE_HEAD'))
  await writeFile(marker,a.baseCommit)
  assert.equal((await closeTool.execute({}, {agent:closeLeader})).diagnostic.code,'TASK_OPERATION_BUSY')
  await rm(marker)
  assert.equal((await closeTool.execute({}, {agent:closeLeader})).status,'POSTMAN_TASK_CLOSED')
  await registry.close();registry=await open();contexts=make()
  assert.equal(registry.get('leader').stage,'closed')
  const b=await contexts.prepare(sameLeader);assert.equal(b.status,'TASK_CONTEXT_READY',JSON.stringify(b))
  assert.notEqual(b.branch,a.branch);assert.notEqual(b.worktree,a.worktree)
  assert.equal(b.baseCommit,await git(root,'rev-parse','HEAD'))
  assert.equal(registry.get('leader').retiredTasks[0].branch,a.branch)
  assert.equal(registry.get('leader').retiredTasks[0].stage,'closed')
  contexts.dispose();await registry.close();await backend.close()
})
test('same production Leader PTC close and reprepare return exact statuses/catalog', {timeout:15000},async t=>{
  const { capabilityRuntime }=await import('./fixtures/postman-capability-runtime.js')
  const dir=await mkdtemp(join(tmpdir(),'postman-close-catalog-'))
  const program='const a=ptc.expectStatus(await tools.postman_task_prepare({}),"postman_task_prepare");'+
    'const closed=ptc.expectStatus(await tools.postman_task_close({}),"postman_task_close");'+
    'const status=await tools.postman_team_status({});'+
    'const b=ptc.expectStatus(await tools.postman_task_prepare({}),"postman_task_prepare");return {a,closed,status,b}'
  const f=await capabilityRuntime(dir,{plan:(_a,_r,n)=>n===1?({name:'ptc_execute',args:{program,boundary:'semantic_decision',description:'Close settled task and prepare independent task'}}):({text:'Binding closed and independent task prepared'})})
  t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  assert.equal((await f.prepare()).status,'TASK_CONTEXT_READY')
  await rm(f.worktree,{recursive:true,force:true}) // Task A external cleanup before explicit retirement
  const request=await f.turn(f.leader)
  assert.ok(request.tools.some(tool=>tool.name==='ptc_execute'))
  const result=f.results.find(r=>r.name==='ptc_execute' && r.agent===f.leader).result
  assert.equal(result.isError,false,JSON.stringify(result))
  const value=result.value
  assert.equal(value.status,'ok',JSON.stringify(value))
  assert.equal(value.value.closed.status,'POSTMAN_TASK_CLOSED')
  assert.equal(value.value.status.task.contextReady,false)
  assert.equal(value.value.status.task.stage,'closed')
  assert.ok(value.value.status.task.closedAt)
  assert.equal(value.value.b.status,'TASK_CONTEXT_READY',JSON.stringify(value.value.b))
  assert.notEqual(value.value.a.branch,value.value.b.branch)
  assert.equal(f.registry.get('leader').retiredTasks[0].stage,'closed')
})

test('close refuses removed mapping with live/queued or unclosed/unreadable descendant',async()=>{
  const f=await fixture({})
  let entries=[],events=[]
  const ctx={agents:{get:id=>id==='leader'?leader:null},subagents:{listDescendants:async()=>entries},
    get:()=>({inspect:async()=>({events})})}
  const tool=createPostmanTaskCloseTool(ctx,f.contexts)
  for(const child of [{kind:'child',id:'orphan',activity:'running',mode:'continuable'},
    {kind:'diagnostic',id:'unreadable'}, {kind:'child',id:'parked',activity:'inactive',mode:'continuable'}]){
    entries=[child]
    assert.equal((await tool.execute({}, {agent:leader})).diagnostic.code,'CHILD_CLOSURE_UNPROVEN')
    assert.equal(f.registry.get('leader').stage,'ready')
  }
  events=[{type:'subagent/closed'}]
  assert.equal((await tool.execute({}, {agent:leader})).status,'POSTMAN_TASK_CLOSED')
})

