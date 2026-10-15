import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp,rm,cp,readFile,writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capabilityRuntime } from './fixtures/postman-capability-runtime.js'
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const workerPtc=program=>({program,description:'Exact owned app lifecycle',boundary:'semantic_decision'})
test('native Worker starts/checks app; Host owner survives Worker close; explicit stop and Leader cleanup',{timeout:180000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'postman-owned-app-')), gate=Promise.withResolvers(),ready=Promise.withResolvers()
  const readyPath=join(dir,'ready.json');let f,receipt,url
  const watcher=watch(dir,async(_e,name)=>{if(String(name)!=='ready.json')return;try{ready.resolve(JSON.parse(await readFile(readyPath,'utf8')))}catch{}})
  t.after(async()=>{gate.resolve();watcher.close();await f?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
  f=await capabilityRuntime(dir,{preset:'postman-leader',reportDelivery:'next-step',plan:async(a,r,n)=>{
    if(a.id==='leader')return {text:'Exact Worker runtime result reviewed'}
    if(n===1){await gate.promise;assert.ok(r.tools.some(t=>t.name==='postman_app'),'ordinary exact Worker sees scoped app tool');return {name:'postman_app',args:{action:'start',command:'node app.mjs '+JSON.stringify(readyPath),description:'Start tiny isolated HTTP test app'}}}
    if(n===2){const started=f.results.find(r=>r.agent.id===a.id&&r.name==='postman_app')?.result;assert.equal(started?.value?.status,'POSTMAN_APP_STARTED',JSON.stringify(started));({url}=await ready.promise);return {name:'pwsh',args:{command:'$r=Invoke-WebRequest -Uri '+JSON.stringify(url)+' -UseBasicParsing; if($r.StatusCode -ne 200){throw "HTTP check failed"}; $r.StatusCode',description:'Check exact local test app HTTP',workdir:f.worktree}}}
    return {name:'report',args:{output:'PASS exact local app HTTP checked; render not yet browser verified'}}
  }})
  await f.prepare();await f.turn(f.leader,'Approved bounded app ownership scenario; load required workspace instructions');await cp(new URL('./fixtures/postman-test-app.mjs',import.meta.url),join(f.worktree,'app.mjs'))
  const accepted=await f.execute(f.leader,'ptc_execute',workerPtc('return await tools.postman_worker({task:"Start/check approved tiny HTTP app",createNew:true})'))
  assert.equal(accepted.value.status,'ok',JSON.stringify(accepted));const id=accepted.value.value.workerSessionId
  gate.resolve();await f.childDone(id);await f.leader.whenIdle()
  const result=f.results.find(r=>r.agent.id===id&&r.name==='postman_app')?.result
  assert.equal(result?.value?.status,'POSTMAN_APP_STARTED',JSON.stringify(result));receipt=result.value
  assert.equal(f.ctx.jobs.get(receipt.jobId,f.leader).ownerSession,f.leader.id)
  assert.ok(f.results.some(r=>r.agent.id===id&&r.name==='pwsh'&&!r.parent&&!r.result.isError&&r.result.value.exitCode===0))
  const closed=await f.execute(f.leader,'ptc_execute',workerPtc('return await tools.postman_worker_stop({mode:"close",workerSessionId:'+JSON.stringify(id)+'})'))
  assert.equal(closed.value.value.status,'POSTMAN_WORKER_STOPPED',JSON.stringify(closed))
  assert.equal(f.registry.get('leader').workers[id],undefined,'native close removes exact mapping')
  assert.equal((await fetch(url)).status,200,'same URL HTTP200 after native Worker close')
  assert.equal(f.ctx.jobs.get(receipt.jobId,f.leader).status,'running')
  const status=await f.execute(f.leader,'ptc_execute',workerPtc('return await tools.postman_app('+JSON.stringify({action:'status',jobId:receipt.jobId,appId:receipt.appId})+')'))
  assert.equal(status.value.value.status,'POSTMAN_APP_STATUS')
  const foreign={id:f.leader.id,session:f.leader.session}
  const denied=await f.ctx.tools.execute({agent:foreign,name:'postman_app',arguments:{action:'stop',jobId:receipt.jobId,appId:receipt.appId},callId:'impostor',signal:new AbortController().signal})
  assert.ok(denied.isError||denied.value?.status==='POSTMAN_APP_CALLER_REJECTED')
  console.log(JSON.stringify({scenario:'owned-app-after-Worker-close',url,httpStatus:200,jobStatus:'running',workerClosed:true}))
  if(process.env.POSTMAN_APP_UI_RECEIPT){await writeFile(process.env.POSTMAN_APP_UI_RECEIPT,JSON.stringify({url,httpStatus:200,workerClosed:true,jobStatus:'running'}));await pause(90000)}
  const stopped=await f.execute(f.leader,'ptc_execute',workerPtc('return await tools.postman_app('+JSON.stringify({action:'stop',jobId:receipt.jobId,appId:receipt.appId})+')'))
  assert.equal(stopped.value.value.status,'POSTMAN_APP_STOP_REQUESTED');assert.notEqual(stopped.value.value.jobStatus,'running')
  await assert.rejects(fetch(url))
  const cold=await f.execute(f.leader,'ptc_execute',workerPtc('return await tools.postman_app('+JSON.stringify({action:'status',jobId:'absent-owned-job',appId:receipt.appId})+')'))
  assert.equal(cold.value.value?.status,'POSTMAN_APP_OUTCOME_UNKNOWN',JSON.stringify(cold));assert.equal(cold.value.value.restartAllowed,false)
  // The exact native owner lifecycle, not a rewritten ledger, cleans a second
  // existing controller job on Leader disposal; no cold autostart exists.
  let cancelled=0;const done=Promise.withResolvers()
  const cleanupId=f.ctx.jobs.start({kind:'fixture-cleanup',label:'synthetic owner cleanup',owner:f.leader,run:()=>({cancel(){cancelled++;done.resolve({status:'killed'})},done:done.promise})})
  await f.leaderHandle.dispose()
  assert.equal(cancelled,1);assert.throws(()=>f.ctx.jobs.get(cleanupId),{message:'unknown job '+cleanupId})
  console.log(JSON.stringify({scenario:'owned-app-stopped',explicitStop:true,leaderCleanup:true,coldRestart:false}))
})
