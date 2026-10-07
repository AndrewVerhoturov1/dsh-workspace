import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import {apply as filesystemTools} from '@deepseek-ai/dsh-tool-fs'
import {apply as observationPolicy} from '@deepseek-ai/dsh-fs-observation-policy'
import {stage1Runtime} from './fixtures/postman-stage1-runtime.js'
import {SOL_WORKER_PROFILE} from './ptc-adapter.js'
import {WORKER_CONTROL_TOOLS,POSTMAN_SOL_PTC_TOOL_NAMES} from './postman-bridge-core.js'
import {postmanRoleInstruction} from './postman-worker.js'

const fixture=async(t,opts)=>{
  const dir=await mkdtemp(join(tmpdir(),'postman-stage1-review-'))
  const f=await stage1Runtime(dir,opts?.(dir)??{})
  t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  return {...f,dir}
}
const accepted=r=>{assert.equal(r.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(r));return r.workerSessionId}
const ptcArgs=program=>({program,description:'Execute known local batch before engineering review',boundary:'semantic_decision'})
const results=child=>{
  const ids=new Set(child.session.events.filter(e=>e.type==='tool/call'&&e.data.name==='ptc_execute').map(e=>e.data.callId))
  return child.session.events.filter(e=>e.type==='tool/result').flatMap(e=>e.data.message.content).filter(b=>ids.has(b.toolCallId)).map(b=>JSON.parse(b.content[0].text))
}

test('Sol PTC real read/edit/reread is usable at initial continuation cold and fresh; stock observation applies',{timeout:20000},async t=>{
  const f=await fixture(t,dir=>({
    setupTools:async ctx=>{await writeFile(join(dir,'facts.txt'),'old fact');new LocalFileSystem(ctx,{cwd:dir,diffBasisMaxBytes:1048576});filesystemTools(ctx,{readLimit:2000,readMaxLineLength:2000,readMaxBytes:51200,readStreamMinSize:10485760});observationPolicy(ctx)},
    plan:(_a,_r,n)=>n%2===1?{name:'ptc_execute',args:ptcArgs('let rejected=false;try{await tools.edit({file_path:"facts.txt",old_string:"old fact",new_string:"new fact"})}catch(e){rejected=true}const before=await tools.read({file_path:"facts.txt"});if(before.lines[0].text==="old fact")await tools.edit({file_path:"facts.txt",old_string:"old fact",new_string:"new fact"});const after=await tools.read({file_path:"facts.txt"});return {rejected,before:before.lines[0].text,after:after.lines[0].text}')}: {name:'report',args:{output:'Exact local mutation evidence; done'}}
  }))
  const id=accepted(await f.run(f.worker.solTaskTool,{task:'Scope: known facts.txt. Done: old to new. Check: stock observation and reread. Stop: report.'}))
  let child=await f.settled(id)
  assert.deepEqual(results(child)[0].value,{rejected:true,before:'old fact',after:'new fact'})
  assert.equal(results(child)[0].effects.failed,1) // Caught refusal remains visible; no false all-effects PASS.
  accepted(await f.run(f.worker.solTaskTool,{workerSessionId:id,task:'Already verified: mutation. Remaining: exact reread; stop report.'}));child=await f.settled(id)
  assert.equal(results(child).at(-1).status,'ok');assert.equal(results(child).at(-1).value.after,'new fact')
  await f.wake(f.leader)
  const next=accepted(await f.run(f.worker.freshTool,{workerSessionId:id,task:'Fresh exact known read and mutation evidence; stop report.'}))
  child=await f.settled(next);assert.notEqual(next,id);assert.equal(results(child)[0].status,'ok')
  assert.equal(await readFile(join(f.dir,'facts.txt'),'utf8'),'new fact')
  for(const {request} of f.requests){assert.ok(request.system.includes(postmanRoleInstruction('sol')));assert.ok(request.system.includes('# Postman PTC programming discipline'));assert.ok(request.tools.some(s=>s.name==='ptc_execute'))}
  assert.ok(child.session.events.some(e=>e.type==='tool/code-dispatch-start'&&e.data.arguments.file_path===join(f.dir,'facts.txt')))
})

test('Secretary artifactRequestId rejects before resolution, new or existing assignment and child delivery',{timeout:15000},async t=>{
  let resolutions=0
  const f=await fixture(t,()=>({grants:{async resolve(){resolutions++;throw Error('must not resolve Secretary grant')}}}))
  assert.ok(!Object.hasOwn(f.worker.secretaryTool.parameters,'artifactRequestId'))
  const row=structuredClone(f.registry.get('leader'))
  for(const artifactRequestId of ['REQ_trusted','',null]){
    const refused=await f.run(f.worker.secretaryTool,{task:'Secretary facts',artifactRequestId})
    assert.equal(refused.status,'POSTMAN_WORKER_ARGUMENTS_INVALID')
    assert.deepEqual(f.registry.get('leader'),row);assert.equal(f.specs.length,0);assert.equal(f.requests.length,0)
  }
  const id=accepted(await f.run(f.worker.secretaryTool,{task:'bounded Secretary facts'}));await f.settled(id)
  const before=structuredClone(f.registry.get('leader')),count=f.requests.length
  assert.equal((await f.run(f.worker.secretaryTool,{task:'forbidden next grant',workerSessionId:id,artifactRequestId:'REQ_trusted'})).status,'POSTMAN_WORKER_ARGUMENTS_INVALID')
  assert.deepEqual(f.registry.get('leader'),before);assert.equal(f.requests.length,count);assert.equal(f.specs.length,1);assert.equal(resolutions,0)
  const runtime=await f.ctx.tools.execute({name:'postman_secretary',arguments:{task:'forbidden schema',artifactRequestId:'REQ_trusted'},callId:'secretary-invalid',agent:f.leader,signal:new AbortController().signal})
  assert.equal(runtime.isError||runtime.value?.status==='POSTMAN_WORKER_ARGUMENTS_INVALID',true)
  assert.deepEqual(f.registry.get('leader'),before);assert.equal(resolutions,0)
})

test('Sol PTC includes owned controls; model-direct rejected and foreign ownership rechecked',{timeout:20000},async t=>{
  const entered=Promise.withResolvers(),gate=Promise.withResolvers()
  const f=await fixture(t,()=>({plan:async(a,_r,_n,w)=>{if(w.roleOf(a)==='sol'){entered.resolve();await gate.promise}return {name:'report',args:{output:'bounded owned evidence'}}}}))
  try {
  const solId=accepted(await f.run(f.worker.solTaskTool,{task:'explicit Sol local route'}));await entered.promise
  const sol=f.ctx.agents.get(solId)
  const foreign=accepted(await f.run(f.worker.taskTool,{task:'Leader-owned evidence'}));await f.settled(foreign)
  const secretary=accepted(await f.run(f.worker.secretaryTool,{task:'Secretary evidence'}));await f.settled(secretary)
  const own=accepted(await f.run(f.worker.taskTool,{task:'Sol-owned evidence'},sol));await f.settled(own)
  const execute=(name,args,agent=sol,parent)=>f.ctx.tools.execute({name,arguments:args,agent,parent,callId:'review-'+Math.random(),signal:new AbortController().signal})
  const batch=await execute('ptc_execute',ptcArgs('const r=await tools.read({file_path:"known.txt"});const g=await tools.grep({pattern:"known"});const p=await tools.pwsh({});return {r,g,p,names:Object.keys(tools).sort()}'))
  assert.equal(batch.isError,false);assert.equal(batch.value.status,'ok',JSON.stringify(batch.value))
  assert.deepEqual(batch.value.value.names,[...POSTMAN_SOL_PTC_TOOL_NAMES].sort());assert.equal(batch.value.effects.completed,3)
  assert.deepEqual(SOL_WORKER_PROFILE.tools,[...POSTMAN_SOL_PTC_TOOL_NAMES])
  const absent=['postman_bridge','postman_secretary','postman_sol_worker','postman_task_prepare','postman_task_restore','postman_input_files','ask_user_question','exit_plan_mode','create_goal','update_goal','subagent','workflow','report','notify_parent']
  const rejected=await execute('ptc_execute',ptcArgs('const names='+JSON.stringify(absent)+';return names.map(name=>({name,present:typeof tools[name]!=="undefined"}))'))
  assert.equal(rejected.value.status,'ok');assert.ok(rejected.value.value.every(x=>!x.present))
  for(const name of WORKER_CONTROL_TOOLS){
    const direct=await execute(name,{task:'use PTC',workerSessionId:own})
    assert.equal(direct.isError,true);assert.match(direct.error.message,/POSTMAN_PTC_DIRECT_CALL_REJECTED/)
  }
  const direct=await execute('read',{file_path:'known.txt'});assert.equal(direct.isError,true);assert.match(direct.error.message,/POSTMAN_PTC_DIRECT_CALL_REJECTED/)
  for(const id of [foreign,secretary,solId,'foreign-sol-child'])for(const tool of [f.worker.taskTool,f.worker.interruptTool,f.worker.stopTool,f.worker.compactTool,f.worker.freshTool]){
    const args={workerSessionId:id,task:'foreign'}
    assert.equal((await f.run(tool,args,sol)).status,'POSTMAN_WORKER_TARGET_UNKNOWN')
    const nested=await execute('ptc_execute',ptcArgs('return await tools.'+tool.name+'('+JSON.stringify(args)+')'))
    assert.equal(nested.isError,false,nested.error?.message);assert.equal(nested.value.status,'ok');assert.equal(nested.value.value.status,'POSTMAN_WORKER_TARGET_UNKNOWN')
  }
  accepted(await f.run(f.worker.taskTool,{workerSessionId:own,task:'next exact owned task'},sol));await f.settled(own)
  for(const tool of [f.worker.secretaryTool,f.worker.solTaskTool])assert.equal((await f.run(tool,{task:'not supervisor'},sol)).status,'POSTMAN_WORKER_CALLER_REJECTED')
  assert.equal((await execute('ask_user_question',{})).isError,true)
  assert.ok(f.requests.filter(x=>x.agent.id===own).every(x=>!x.request.tools.some(s=>s.name==='ptc_execute'||WORKER_CONTROL_TOOLS.includes(s.name)||s.name==='subagent')))
  const before=f.registry.get('leader').workers[solId]
  await f.registry.change('leader',row=>({...row,workers:{...row.workers,[solId]:{...before,workerType:'luna'}}}))
  assert.equal((await execute('ptc_execute',ptcArgs('return 1'))).value.status,'PTC_CALLER_REJECTED') // Model remains Sol; binding is authority.
  await f.registry.change('leader',row=>({...row,workers:{...row.workers,[solId]:before}}))
  gate.resolve();await f.settled(solId)
  } finally {gate.resolve()}
})
