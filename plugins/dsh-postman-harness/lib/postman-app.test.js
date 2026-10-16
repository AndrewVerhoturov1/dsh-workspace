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


test('explicit app replacement needs owned terminal process evidence and actually free TCP resource',{timeout:10000},async t=>{
  const {createPostmanAppTool}=await import('./postman-app.js'),{createServer}=await import('node:net')
  const {realpath}=await import('node:fs/promises')
  const dir=await mkdtemp(join(tmpdir(),'postman-app-restart-')),worktree=await realpath(dir)
  const owner={id:'app-leader',session:{header:{agentPreset:'postman-leader',delegationDepth:0}}}
  const caller={id:'app-worker'},context={leaderSessionId:owner.id,worktree},proof={owner,context,assignmentId:'explicit-assignment'}
  const jobs=new Map();let row={appJobs:{}},starts=0
  const resource=createServer();await new Promise(resolve=>resource.listen(0,resolve))
  const port=resource.address().port;await new Promise(resolve=>resource.close(resolve))
  const hooks=new Map(),ctx={on:(name,fn)=>hooks.set(name,fn),bail:()=>true,agents:{get:id=>id===owner.id?owner:caller},
    get:()=>({get(id){if(!jobs.has(id))throw Error('unknown job '+id);return jobs.get(id)}}),
    tools:{get:()=>true,async execute(exec){starts++;const id='native-job-'+starts
      const label=hooks.get('postman/app-job-label')({parent:exec.parent})
      jobs.set(id,{id,ownerSession:owner.id,kind:'pwsh',label,status:'running'})
      return {value:{kind:'background',jobId:id}}}}}
  const contexts={get:()=>context,record:()=>row,async changeRecord(_id,fn){row=fn(row)}}
  let tool=createPostmanAppTool(ctx,{appOwnerOf:agent=>agent===caller?proof:null},contexts)
  const run=args=>tool.execute(args,{agent:caller,signal:new AbortController().signal,token:Symbol(),callId:'explicit-start'})
  t.after(async()=>{if(resource.listening)await new Promise(resolve=>resource.close(resolve));await rm(dir,{recursive:true,force:true})})
  const initial=await run({action:'start',command:'inert-native-app',description:'isolated app',port})
  assert.equal(initial.status,'POSTMAN_APP_STARTED');assert.equal(initial.jobId,'native-job-1')
  const replacement={action:'start',command:'inert-native-app',description:'explicit replacement',jobId:initial.jobId,appId:initial.appId,port}
  assert.equal((await run(replacement)).status,'POSTMAN_APP_PROCESS_NOT_STOPPED');assert.equal(starts,1)
  jobs.delete(initial.jobId)
  assert.equal((await run(replacement)).status,'POSTMAN_APP_OUTCOME_UNKNOWN','lost record cannot prove process absence');assert.equal(starts,1)
  const receipt=row.appJobs[initial.appId]
  jobs.set(initial.jobId,{id:initial.jobId,ownerSession:owner.id,kind:'pwsh',
    label:JSON.stringify({postmanApp:1,appId:initial.appId,worktree,workerSessionId:caller.id}),status:'completed'})
  const jobController=ctx.get();jobController.read=()=>({text:''});ctx.get=()=>jobController
  assert.equal((await run({action:'status',jobId:initial.jobId,appId:initial.appId})).status,'POSTMAN_APP_STATUS')
  assert.equal(row.appJobs[initial.appId].terminal,'completed')
  jobs.delete(initial.jobId) // native completion fact persists through controller record loss
  tool=createPostmanAppTool(ctx,{appOwnerOf:agent=>agent===caller?proof:null},contexts)
  await new Promise(resolve=>resource.listen(port,resolve))
  assert.equal((await run(replacement)).status,'POSTMAN_APP_RESOURCE_BUSY');assert.equal(starts,1)
  await new Promise(resolve=>resource.close(resolve))
  const restarted=await run(replacement)
  assert.equal(restarted.status,'POSTMAN_APP_STARTED');assert.equal(restarted.jobId,'native-job-2')
  assert.notEqual(restarted.appId,initial.appId);assert.equal(starts,2)
  assert.equal((await run(replacement)).status,'POSTMAN_APP_RESTART_ALREADY_REQUESTED');assert.equal(starts,2)
  assert.equal(receipt.assignmentId,'explicit-assignment')
})


test('real native app stops and a newly assigned Worker explicitly starts a new job on the same free port',{timeout:30000},async t=>{
  const {createServer}=await import('node:net')
  const dir=await mkdtemp(join(tmpdir(),'postman-native-app-restart-')),ready=[Promise.withResolvers(),Promise.withResolvers()]
  const resource=createServer();await new Promise(resolve=>resource.listen(0,resolve))
  const port=resource.address().port;await new Promise(resolve=>resource.close(resolve))
  const paths=[join(dir,'first.json'),join(dir,'second.json')]
  const watcher=watch(dir,async(_e,name)=>{const index=['first.json','second.json'].indexOf(String(name));if(index<0)return
    try{ready[index].resolve(JSON.parse(await readFile(paths[index],'utf8')))}catch{}})
  let f,startArgs={action:'start',command:'node app.mjs '+JSON.stringify(paths[0])+' '+port,description:'Initial exact native app',port}
  f=await capabilityRuntime(dir,{preset:'postman-leader',reportDelivery:'next-step',plan:(a,_r,n)=>
    a.id==='leader'?{text:'Native app receipt reviewed'}:n===1?{name:'postman_app',args:startArgs}:
      {name:'report',args:{output:'PARTIAL native job started; HTTP checked separately by test'}}})
  t.after(async()=>{watcher.close();await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
  await f.prepare();await f.turn(f.leader,'Approved finite native app restart regression')
  await cp(new URL('./fixtures/postman-test-app.mjs',import.meta.url),join(f.worktree,'app.mjs'))
  const call=(name,args)=>f.execute(f.leader,'ptc_execute',workerPtc('return await tools.'+name+'('+JSON.stringify(args)+')')).then(r=>{
    assert.equal(r.isError,false,JSON.stringify(r));assert.equal(r.value.status,'ok',JSON.stringify(r));return r.value.value})
  const first=await call('postman_worker',{task:'Initial bounded native app',createNew:true});await f.childDone(first.workerSessionId)
  const original=f.results.find(r=>r.agent.id===first.workerSessionId&&r.name==='postman_app').result.value
  assert.equal(original.status,'POSTMAN_APP_STARTED')
  const initial=await ready[0].promise;assert.equal((await fetch(initial.url)).status,200)
  assert.equal((await call('postman_worker_stop',{mode:'close',workerSessionId:first.workerSessionId})).status,'POSTMAN_WORKER_STOPPED')
  const stopped=await call('postman_app',{action:'stop',jobId:original.jobId,appId:original.appId})
  assert.equal(stopped.jobStatus,'killed');await assert.rejects(fetch(initial.url))
  startArgs={...startArgs,jobId:original.jobId,appId:original.appId,command:'node app.mjs '+JSON.stringify(paths[1])+' '+port,
    description:'Explicit new native app after observed prior process stop'}
  const next=await call('postman_worker',{task:'Explicitly start the replacement native app',createNew:true});await f.childDone(next.workerSessionId)
  const restarted=f.results.find(r=>r.agent.id===next.workerSessionId&&r.name==='postman_app').result.value
  assert.equal(restarted.status,'POSTMAN_APP_STARTED');assert.notEqual(restarted.jobId,original.jobId)
  assert.notEqual(restarted.appId,original.appId);assert.notEqual(next.workerSessionId,first.workerSessionId)
  const live=await ready[1].promise;assert.equal(live.url,initial.url);assert.equal((await fetch(live.url)).status,200)
  assert.equal(f.ctx.jobs.get(original.jobId,f.leader).status,'killed')
  assert.equal(f.ctx.jobs.get(restarted.jobId,f.leader).status,'running')
  assert.equal((await call('postman_app',{action:'stop',jobId:restarted.jobId,appId:restarted.appId})).jobStatus,'killed')
})
