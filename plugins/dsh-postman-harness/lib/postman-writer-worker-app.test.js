import assert from 'node:assert/strict'
import test from 'node:test'
import {writerRuntimeFixture} from './fixtures/postman-writer-runtime.js'
import {capabilityRuntime} from './fixtures/postman-capability-runtime.js'

test('live native writer does not block actual SDK Worker and owned app admission',{timeout:60000},async t=>{
  const previous=process.env.LOCALAPPDATA
  const native=await writerRuntimeFixture(t,{leaderSessionId:'leader'})
  // The writer has captured its private root. Do not load SDK Windows DLLs
  // under the disposable LOCALAPPDATA: loaded DLLs cannot be deleted.
  if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous
  const f=await capabilityRuntime(native.directory,{reportDelivery:'next-step',taskContextOptions:{writerControlFile:native.control.file},plan:(agent,_request,n)=>
    agent.id==='leader'?null:n>1?
      {name:'report',args:{output:'Owned app started in released root'}}:
      {name:'postman_app',args:{action:'start',command:'node -e "setInterval(()=>{},1000)"',description:'Isolated app after native release'}}})
  let app
  t.after(async()=>{
    if(app)await f.execute(f.leader,'ptc_execute',{program:'return await tools.postman_app('+JSON.stringify({action:'stop',jobId:app.jobId,appId:app.appId})+')',description:'Stop exact isolated app',boundary:'semantic_decision'})
    await f.dispose()
  })
  await f.prepare();await f.turn(f.leader)
  await f.execute(f.leader,'ptc_execute',{program:'return true',description:'Initialize isolated SDK sandbox',boundary:'semantic_decision'})
  process.env.LOCALAPPDATA=native.directory
  const op={state:'received',synchronization:'not-required',transportKind:'devspace',requestId:native.binding.requestId,
    childSessionId:native.binding.lunaSessionId,devspace:{mode:'WRITE_ISOLATED',channel:native.binding.channel}}
  await f.registry.change('leader',row=>({...row,branch:native.branch,bridgeOperations:{[native.binding.jobId]:op}}))
  assert.equal((await f.contexts.recover(f.leader)).status,'POSTMAN_TASK_CONTEXT_ALREADY_READY')
  const started=await native.background({execution:'background',command:'setInterval(()=>{},1000)',timeout:2})
  const jobId=started.structuredContent.native_job_id
  assert.equal(started.structuredContent.treeSettled,false)
  const phase=program=>f.execute(f.leader,'ptc_execute',{program,description:'Exact native release to SDK admission',boundary:'semantic_decision'})
  const program='return await tools.postman_worker({task:"Start isolated owned app",createNew:true})'
  const accepted=await phase(program)
  assert.equal(accepted.value.value.status,'POSTMAN_WORKER_TASK_ACCEPTED')
  const stopped=await native.background({execution:'stop',job_id:jobId})
  assert.equal(stopped.structuredContent.treeSettled,true,JSON.stringify(stopped))
  const childId=accepted.value.value.workerSessionId
  await f.childDone(childId)
  await f.leader.whenIdle()
  app=f.results.find(r=>r.agent.id===childId&&r.name==='postman_app')?.result.value
  assert.equal(app?.status,'POSTMAN_APP_STARTED',JSON.stringify(app))
  assert.equal(f.ctx.jobs.get(app.jobId,f.leader).status,'running')
  const result=await phase('return await tools.postman_app('+JSON.stringify({action:'stop',jobId:app.jobId,appId:app.appId})+')')
  assert.notEqual(result.value.value.jobStatus,'running')
  app=null
  const closed=await phase('return await tools.postman_worker_stop('+JSON.stringify({mode:'close',workerSessionId:childId})+')')
  assert.equal(closed.value.value.status,'POSTMAN_WORKER_STOPPED',JSON.stringify(closed))
  console.log(JSON.stringify({scenario:'released-native-root-to-Worker-app',nativeJobId:jobId,bridgeJobId:native.binding.jobId,
    requestId:native.binding.requestId,modelRequests:f.requests.length,workerAdmitted:true,appStarted:true,appStopped:true}))
  await f.dispose()
})
