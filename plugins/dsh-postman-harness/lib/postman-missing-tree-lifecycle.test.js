import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, rm, writeFile, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {capabilityRuntime} from './fixtures/postman-capability-runtime.js'

const exec=promisify(execFile)
const git=async(cwd,...args)=>(await exec('git',['-C',cwd,...args],{windowsHide:true})).stdout.trim()
const report={name:'report',args:{output:'Finite task completed; actual native report and turn settlement retained.'}}
const unwrap=result=>{assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.value.status,'ok',JSON.stringify(result.value));return result.value.value}
const call=(f,name,args={})=>f.execute(f.leader,'ptc_execute',{program:'return await tools.'+name+'('+JSON.stringify(args)+')',description:'Verify exact missing-tree retirement boundary',boundary:'semantic_decision'}).then(unwrap)

async function realFixture(t,options={}) {
  const temp=await mkdtemp(join(tmpdir(),'postman-missing-tree-'))
  const root=join(temp,'repo'),bare=join(temp,'origin.git')
  await exec('git',['init','--bare',bare]);await exec('git',['init','-b','main',root])
  await git(root,'config','user.email','postman-test@example.invalid');await git(root,'config','user.name','Postman lifecycle test')
  await writeFile(join(root,'base.txt'),'base');await git(root,'add','base.txt');await git(root,'commit','-m','base')
  await git(root,'remote','add','origin',bare);await git(root,'push','-u','origin','main')
  const initial=await git(root,'rev-parse','HEAD')
  const gitCommand=async(cwd,...args)=>args.join(' ')==='remote get-url origin'?'https://github.com/AndrewVerhoturov1/dsh-workspace.git':git(cwd,...args)
  const setup={taskContextOptions:{gitCommand,temporaryDirectory:()=>temp},plan:a=>a.id==='leader'?null:report,...options}
  let f=await capabilityRuntime(root,setup)
  t.after(async()=>{await f.dispose();await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  return {root,bare,initial,get f(){return f},restart:async()=>{await f.dispose();f=await capabilityRuntime(root,{...setup,resume:true});return f}}
}

for(const cold of [false,true]) test('real Git/native settled retirement after external cleanup '+(cold?'and cold resume':'in same process')+' prepares exact new main',{timeout:60000},async t=>{
  const fixture=await realFixture(t)
  let f=fixture.f
  const a=await f.prepare();assert.equal(a.status,'TASK_CONTEXT_READY');assert.equal(a.baseCommit,fixture.initial)
  await f.turn(f.leader)
  const worker=await call(f,'postman_worker',{task:'Finite native lifecycle regression'})
  assert.equal(worker.status,'POSTMAN_WORKER_TASK_ACCEPTED');const id=worker.workerSessionId
  await f.childDone(id);await f.turn(f.leader,'Consume exact completed report')
  const before=(await call(f,'postman_worker_list')).workers.find(w=>w.workerSessionId===id)
  assert.equal(before.turn,'settled');assert.equal(before.report,'delivered');assert.equal(before.delivery,'none')
  await writeFile(join(a.worktree,'done.txt'),'completed Task A');await git(a.worktree,'add','done.txt');await git(a.worktree,'commit','-m','Task A')
  await git(a.worktree,'push','origin',a.branch)
  await git(fixture.root,'merge','--squash',a.branch);await git(fixture.root,'commit','-m','external squash Task A');await git(fixture.root,'push','origin','main')
  await git(fixture.root,'worktree','remove',a.worktree)
  await assert.rejects(stat(a.worktree),{code:'ENOENT'})
  if(cold) {f=await fixture.restart();await f.turn(f.leader,'Resume same approved task after external finalize')}
  if(cold){
    assert.equal((await f.contexts.recover(f.leader)).diagnostic,'task worktree missing')
    assert.equal(f.contexts.get('leader'),null)
    assert.equal((await call(f,'postman_task_prepare')).status,'POSTMAN_TASK_PREPARE_UNCERTAIN')
  }
  assert.equal(f.contexts.hasActiveOperation('leader'),false)
  assert.equal((await call(f,'postman_task_close')).diagnostic.code,'WORKER_BINDINGS_NOT_RETIRED')
  if(cold){
    assert.equal((await call(f,'postman_worker',{workerSessionId:id,task:'must not create or continue'})).status,'POSTMAN_TASK_CONTEXT_REQUIRED')
    assert.equal((await call(f,'postman_worker_interrupt',{workerSessionId:id,task:'must not queue'})).status,'POSTMAN_TASK_CONTEXT_REQUIRED')
  }
  const stopped=await call(f,'postman_worker_stop',{workerSessionId:id,mode:'close'})
  assert.equal(stopped.status,'POSTMAN_WORKER_STOPPED',JSON.stringify(stopped));assert.equal(stopped.taskCompleted,false);assert.equal(stopped.resultReported,true)
  assert.equal(await f.ctx.subagents.inspectClosedContinuableChild(f.leader,id),true)
  await assert.rejects(f.ctx.subagents.followup(f.leader,id,[{type:'text',text:'late'}],{source:{kind:'user'},signal:new AbortController().signal}),/closed/)
  assert.equal((await call(f,'postman_task_close')).status,'POSTMAN_TASK_CLOSED')
  await writeFile(join(fixture.root,'new-main.txt'),'new current main after Task A');await git(fixture.root,'add','new-main.txt');await git(fixture.root,'commit','-m','advance main');await git(fixture.root,'push','origin','main')
  const current=await git(fixture.bare,'rev-parse','refs/heads/main')
  const b=await call(f,'postman_task_prepare')
  assert.equal(b.status,'TASK_CONTEXT_READY',JSON.stringify(b));assert.equal(b.baseCommit,current);assert.notEqual(current,a.baseCommit)
  assert.notEqual(b.branch,a.branch);assert.notEqual(b.worktree,a.worktree)
  assert.equal(await git(b.worktree,'rev-parse','HEAD'),current);assert.equal(await git(b.worktree,'status','--porcelain=v1','--untracked-files=all'),'')
  assert.equal(await git(fixture.bare,'rev-parse','refs/heads/'+b.branch),current)
  assert.equal(f.registry.get('leader').retiredTasks[0].branch,a.branch)
})

test('missing tree and delivered report never prove active/queued/unknown work settled',{timeout:60000},async t=>{
  const gate=Promise.withResolvers(),entered=Promise.withResolvers()
  const fixture=await realFixture(t,{plan:async(a,_request,n)=>{if(a.id==='leader')return null;if(n%2===0)return {text:'Native request ended without claiming task success'};entered.resolve(a);await gate.promise;return report}})
  const f=fixture.f;t.after(()=>gate.resolve())
  const a=await f.prepare();await f.turn(f.leader)
  const worker=await call(f,'postman_worker',{task:'active real native work'}),id=worker.workerSessionId
  await entered.promise
  const queued=await call(f,'postman_worker',{workerSessionId:id,task:'queued real work'});assert.equal(queued.status,'POSTMAN_WORKER_TASK_ACCEPTED')
  await git(fixture.root,'worktree','remove',a.worktree)
  await f.contexts.recover(f.leader)
  assert.equal((await call(f,'postman_worker_stop',{workerSessionId:id,mode:'close'})).status,'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.equal((await call(f,'postman_task_close')).status,'POSTMAN_TASK_CLOSE_REJECTED')
  assert.equal((await call(f,'postman_task_prepare')).status,'POSTMAN_TASK_PREPARE_UNCERTAIN')
  gate.resolve();await f.childDone(id);await f.turn(f.leader,'Consume real completed queued reports')
  assert.equal((await call(f,'postman_worker_stop',{workerSessionId:id,mode:'cancel'})).status,'POSTMAN_WORKER_CANCELLED')
  assert.equal((await call(f,'postman_task_close')).status,'POSTMAN_TASK_CLOSED')
})
test('delivered settled report with unknown admission still blocks missing-tree close',{timeout:60000},async t=>{
  const fixture=await realFixture(t),f=fixture.f
  const a=await f.prepare();await f.turn(f.leader)
  const worker=await call(f,'postman_worker',{task:'finite task with later unavailable admission evidence'}),id=worker.workerSessionId
  await f.childDone(id);await f.turn(f.leader,'Consume exact settled report')
  const before=(await call(f,'postman_worker_list')).workers.find(w=>w.workerSessionId===id)
  assert.equal(before.turn,'settled');assert.equal(before.report,'delivered')
  await git(fixture.root,'worktree','remove',a.worktree);await f.contexts.recover(f.leader)
  // Fault-injection exercises unavailable admission evidence, not fabricated settlement.
  await f.contexts.changeRecord('leader',row=>({...row,workers:{...row.workers,[id]:{...row.workers[id],delivery:'unknown'}}}))
  assert.equal((await call(f,'postman_worker_stop',{workerSessionId:id,mode:'close'})).status,'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.equal((await call(f,'postman_task_close')).status,'POSTMAN_TASK_CLOSE_REJECTED')
  assert.equal((await call(f,'postman_task_prepare')).status,'POSTMAN_TASK_PREPARE_UNCERTAIN')
  assert.equal((await call(f,'postman_worker_stop',{workerSessionId:id,mode:'cancel'})).status,'POSTMAN_WORKER_CANCELLED')
  assert.equal((await call(f,'postman_task_close')).status,'POSTMAN_TASK_CLOSED')
})
test('missing-tree cold Sol cascade retires exact settled owned child before Sol',{timeout:60000},async t=>{
  const gate=Promise.withResolvers(),dispatch=Promise.withResolvers(),steps=new WeakMap()
  let f,solId
  const fixture=await realFixture(t,{plan:async a=>{
    if(a.id==='leader')return null
    if(a.options.model!=='gpt-6.1-sol'){await gate.promise;return report}
    solId=a.id;const n=steps.get(a)??0;steps.set(a,n+1)
    if(n===0)return {name:'ptc_execute',args:{program:'return await tools.postman_worker({task:"Finite exact owned child"})',description:'Dispatch finite owned lifecycle evidence',boundary:'external_event'}}
    const own=f.results.findLast(r=>r.agent===a&&r.name==='postman_worker').result.value.workerSessionId
    await f.childDone(own);return report
  }})
  f=fixture.f;t.after(()=>gate.resolve())
  const a=await f.prepare();await f.turn(f.leader)
  const off=f.ctx.on('session/event',(session,event)=>{if(session.id===solId&&event.type==='turn/end'&&event.data.turn===1)dispatch.resolve()});t.after(off)
  const sol=await call(f,'postman_sol_worker',{task:'Finite approved Sol cascade regression'})
  assert.equal(sol.status,'POSTMAN_WORKER_TASK_ACCEPTED');await dispatch.promise
  gate.resolve();await f.childDone(sol.workerSessionId);await f.turn(f.leader,'Consume settled Sol and owned child reports')
  const owned=Object.values(f.registry.get('leader').workers).filter(w=>w.ownerSessionId===sol.workerSessionId)
  assert.equal(owned.length,1)
  await git(fixture.root,'worktree','remove',a.worktree);await f.contexts.recover(f.leader)
  // Runtime quiescence and exact ownership permit retirement even when the
  // prior event-wait turn has no narrative retirement report.
  const closed=await call(f,'postman_worker_stop',{workerSessionId:sol.workerSessionId,mode:'close',cascade:true})
  assert.equal(closed.status,'POSTMAN_WORKER_STOPPED',JSON.stringify(closed));assert.equal(closed.cascade,true)
  assert.equal(closed.results.length,1);assert.equal(closed.results[0].status,'POSTMAN_WORKER_STOPPED')
  assert.equal(closed.taskCompleted,false);assert.equal(closed.resultReported,false)
  assert.deepEqual(f.registry.get('leader').workers,{})
  assert.equal(await f.ctx.subagents.inspectClosedContinuableChild(f.leader,sol.workerSessionId),true)
  assert.equal((await call(f,'postman_task_close')).status,'POSTMAN_TASK_CLOSED')
})
