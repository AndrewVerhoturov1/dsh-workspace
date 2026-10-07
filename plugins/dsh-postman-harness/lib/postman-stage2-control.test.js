import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { capabilityRuntime, native } from './fixtures/postman-capability-runtime.js'
import { POSTMAN_PTC_SUCCESS_STATUSES } from './postman-bridge-core.js'

const ptc = (program,boundary='semantic_decision') => ({program,boundary,description:'Execute complete deterministic supervisor step before genuine decision'})
const ok = r => { assert.equal(r.isError,false,JSON.stringify(r)); return r.value }
const nested = r => { const v=ok(r);assert.equal(v.status,'ok',JSON.stringify(v));return v.value }
const report = {name:'report',args:{output:'bounded verified exact stage2 evidence'}}
const fixture = async(t,opts={}) => {
 const dir=await mkdtemp(join(tmpdir(),'postman-stage2-control-'))
 const f=await capabilityRuntime(dir,{preset:'postman-leader',...opts})
 t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  const diagnostics=[];f.ctx.logger.exporter({export:m=>{if(m.args?.[0]==='postman/ptc-run')diagnostics.push(m.args[1])}})
 return {...f,dir,diagnostics}
}
const call = (f,name,args={})=>f.execute(f.leader,'ptc_execute',ptc('return await tools.'+name+'('+JSON.stringify(args)+')'))

for(const preset of ['postman-leader','postman-leader-ptc']) test(preset+': one real model decision runs team/Secretary/two Workers/Sol and safely auto-yields', {timeout:30000}, async t=>{
 const hold=Promise.withResolvers();t.after(()=>hold.resolve())
 const program=
  'const before=await tools.postman_team_status({});'+
  'ptc.expectStatus(await tools.postman_task_prepare({}),"postman_task_prepare");'+
  'const secretary=ptc.expectStatus(await tools.postman_secretary({task:"facts only"}),"postman_secretary");'+
  'const a=ptc.expectStatus(await tools.postman_worker({task:"bounded A",createNew:true}),"postman_worker");'+
  'const b=ptc.expectStatus(await tools.postman_worker({task:"bounded B",createNew:true}),"postman_worker");'+
  'const sol=ptc.expectStatus(await tools.postman_sol_worker({task:"User explicitly selected Sol Worker; bounded review"}),"postman_sol_worker");'+
  'const after=ptc.expectStatus(await tools.postman_team_status({}),"postman_team_status");'+
  'return {before,secretary,a,b,sol,after}'
 const f=await fixture(t,{preset,plan:async(a,_r,n)=>{if(a.id==='leader'){assert.equal(n,1,'no mechanical model-direct rounds');return {name:'ptc_execute',args:ptc(program,'external_event')}}await hold.promise;return report}})
 const request=await f.turn(f.leader,'User explicitly asks for Sol Worker with Secretary and two ordinary Workers')
 assert.equal(request.model,'gpt-6.1-sol');assert.equal(request.reasoningEffort,'xhigh')
 const outer=f.results.find(r=>r.agent===f.leader&&r.name==='ptc_execute');assert.ok(outer)
 const v=ok(outer.result);assert.equal(v.status,'ok',JSON.stringify(v));assert.equal(f.diagnostics.at(-1).yieldApplied,true,JSON.stringify(f.diagnostics.at(-1)))
 assert.equal(f.requests.filter(r=>r.agent.id==='leader').length,1)
 assert.deepEqual(f.results.filter(r=>r.parent&&r.agent===f.leader).map(r=>r.name),['postman_team_status','postman_task_prepare','postman_secretary','postman_worker','postman_worker','postman_sol_worker','postman_team_status'])
 assert.equal(v.value.before.workers.used,0);assert.equal(v.value.before.secretary.present,false);assert.equal(v.value.before.sol.present,false)
 for(const name of ['secretary','a','b','sol'])assert.equal(v.value[name].status,'POSTMAN_WORKER_TASK_ACCEPTED')
 assert.notEqual(v.value.a.workerSessionId,v.value.b.workerSessionId)
 const team=v.value.after;assert.equal(team.status,'POSTMAN_TEAM_STATUS');assert.equal(team.task.contextReady,true)
 assert.equal(team.workers.used,2);assert.equal(team.workers.limit,2);assert.equal(team.sol.present,true);assert.equal(team.sol.ownedWorkers.limit,2)
 assert.deepEqual(team.secretary.budget,{used:1,soft:48,hard:60,exhausted:false})
 assert.ok(Object.values(f.registry.get('leader').workers).every(b=>b.ownerSessionId==='leader'))
 hold.resolve();await Promise.all(['secretary','a','b','sol'].map(k=>f.childDone(v.value[k].workerSessionId)))
})

test('Sol create/continuation accepted in PTC, direct rejected and exact success is external producer', {timeout:30000},async t=>{
 const f=await fixture(t,{plan:a=>a.id==='leader'?null:report});await f.turn(f.leader);await f.prepare()
 const exec=async(program,boundary='external_event')=>{let concluded=0;const r=await f.ctx.tools.execute({agent:f.leader,name:'ptc_execute',arguments:ptc(program,boundary),callId:randomUUID(),signal:new AbortController().signal,concludeTurn(){concluded++}});return {v:ok(r),concluded:r.concludesTurn?1:0}}
 const first=await exec('return ptc.expectStatus(await tools.postman_sol_worker({task:"User explicitly selected Sol Worker"}),"postman_sol_worker")')
 assert.equal(first.v.status,'ok',JSON.stringify(first.v));assert.equal(f.diagnostics.at(-1).yieldApplied,true,JSON.stringify(f.diagnostics.at(-1)));assert.equal(first.concluded,1)
 await f.childDone(first.v.value.workerSessionId)
 const second=await exec('return await tools.postman_sol_worker({workerSessionId:'+JSON.stringify(first.v.value.workerSessionId)+',task:"next exact authorized assignment"})')
 assert.equal(second.v.value.status,'POSTMAN_WORKER_TASK_ACCEPTED');assert.equal(second.v.value.workerSessionId,first.v.value.workerSessionId);assert.equal(second.concluded,1)
 await f.childDone(second.v.value.workerSessionId)
 const direct=await f.execute(f.leader,'postman_sol_worker',{task:'reject direct'});assert.equal(direct.isError,true);assert.match(direct.error.message,/POSTMAN_PTC_DIRECT_CALL_REJECTED/)
 assert.deepEqual(POSTMAN_PTC_SUCCESS_STATUSES.postman_sol_worker,['POSTMAN_WORKER_TASK_ACCEPTED'])
})

test('explicit nested yield is applied once only after safe complete outer settlement', {timeout:30000},async t=>{
 const f=await fixture(t,{plan:a=>a.id==='leader'?null:report});await f.turn(f.leader)
 const exec=async(program,boundary='semantic_decision')=>{let count=0;const r=await f.ctx.tools.execute({agent:f.leader,name:'ptc_execute',arguments:ptc(program,boundary),callId:randomUUID(),signal:new AbortController().signal,concludeTurn(){count++}});return {v:ok(r),count:r.concludesTurn?1:0}}
 const happy=await exec('const t=await tools.postman_team_status({});const y=ptc.expectStatus(await tools.postman_yield({}),"postman_yield");return {t,y}')
 assert.equal(happy.v.status,'ok');assert.equal(happy.v.value.y.status,'POSTMAN_YIELDED');assert.equal(happy.count,1,JSON.stringify(f.diagnostics.at(-1)));assert.equal(f.diagnostics.at(-1).yieldApplied,true,JSON.stringify(f.diagnostics.at(-1)))
 const missing=await exec('await tools.postman_yield({});try{await tools.read({file_path:"absent"})}catch(e){}return {}')
 assert.equal(missing.count,0);assert.notEqual(missing.v.yieldApplied,true)
 const refused=await exec('await tools.postman_yield({});return await tools.postman_bridge_stop({bridge_job_id:"foreign"})')
 assert.equal(refused.v.status,'ok');assert.equal(refused.count,0);assert.match(f.diagnostics.at(-1).yieldBlockedReason,/acceptance-not-confirmed/)
 const pending=await exec('await tools.postman_yield({});tools.read({file_path:"absent"});return {}')
 assert.equal(pending.count,0);assert.notEqual(pending.v.yieldApplied,true)
 await f.prepare()
 const both=await exec('const a=await tools.postman_worker({task:"bounded work"});await tools.postman_yield({});return a','external_event')
 assert.equal(both.v.status,'ok');assert.equal(both.count,1);assert.equal(f.diagnostics.at(-1).yieldApplied,true,JSON.stringify(f.diagnostics.at(-1)));await f.childDone(both.v.value.workerSessionId)
 const direct=await f.execute(f.leader,'postman_yield',{});assert.equal(direct.isError,true);assert.match(direct.error.message,/POSTMAN_PTC_DIRECT_CALL_REJECTED/)
})

test('actual team snapshot is private bounded read-only and hides control tools from FAST/Sol roles', {timeout:30000},async t=>{
 const hold=Promise.withResolvers(), ownGate=Promise.withResolvers(), solEntered=Promise.withResolvers();let solAgent;t.after(()=>{hold.resolve();ownGate.resolve()})
 const f=await fixture(t,{plan:async a=>{if(a.id==='leader')return null;if(a.options.model==='gpt-6.1-sol'){solAgent=a;solEntered.resolve(a);await hold.promise}else if(a.session.header.delegationDepth===2)await ownGate.promise;return report}})
 await f.turn(f.leader);await f.prepare()
 const secretary=nested(await call(f,'postman_secretary',{task:'private secretary task'})),worker=nested(await call(f,'postman_worker',{task:'private worker task'}))
 await f.childDone(secretary.workerSessionId);await f.childDone(worker.workerSessionId)
 const sol=nested(await call(f,'postman_sol_worker',{task:'User explicitly selected Sol Worker private task'}))
 await solEntered.promise
 const a=nested(await f.execute(solAgent,'ptc_execute',ptc("return await tools.postman_worker({task:'private owned A',createNew:true})"))),b=nested(await f.execute(solAgent,'ptc_execute',ptc("return await tools.postman_worker({task:'private owned B',createNew:true})")))
 assert.equal(a.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(a));assert.equal(b.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(b));ownGate.resolve()
 await f.childDone(a.workerSessionId);await f.childDone(b.workerSessionId)
 await f.registry.change('leader',r=>({...r,secretaryLedger:{revision:9,content:'do not expose private ledger'},bridgeOperations:Object.fromEntries(Array.from({length:80},(_,i)=>['job-'+i,{state:'unknown',phase:'request-known',transportKind:'text',requestId:'REQ_20261006T000000Z_'+String(i).padStart(4,'0'),cancellationRequested:i===0,terminal:{status:'FAKE',hugeJournal:'NEVER EXPOSE'},publication:{huge:'NEVER EXPOSE'}}]))}))
 const before=JSON.stringify(f.registry.get('leader'));const snapshot=nested(await call(f,'postman_team_status'))
 assert.equal(snapshot.secretary.ledgerRevision,9);assert.equal(snapshot.sol.ownedWorkers.used,2);assert.equal(snapshot.bridge.used,80);assert.equal(snapshot.bridge.operations.length,30);assert.equal(snapshot.bridge.truncated,true)
 const json=JSON.stringify(snapshot);assert.ok(json.length<16000);for(const secret of ['NEVER EXPOSE','private task','private ledger',a.workerSessionId,b.workerSessionId])assert.ok(!json.includes(secret),secret)
 assert.equal(JSON.stringify(f.registry.get('leader')),before)
 for(const agent of [solAgent,await f.childDone(a.workerSessionId),await f.childDone(worker.workerSessionId),await f.childDone(secretary.workerSessionId)]){
  const request=f.requests.filter(r=>r.agent.id===agent.id).at(-1).request
  assert.ok(!request.tools.some(t=>['postman_team_status','postman_bridge_stop'].includes(t.name)))
  for(const name of ['postman_team_status','postman_bridge_stop']){const r=await f.execute(agent,name,name==='postman_bridge_stop'?{bridge_job_id:'job-0'}:{});assert.ok(r.isError||r.value?.status.endsWith('CALLER_REJECTED'),JSON.stringify(r))}
 }
 const forbidden=nested(await call(f,'postman_worker_interrupt',{workerSessionId:a.workerSessionId,task:'no ownership transfer'}));assert.notEqual(forbidden.status,'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED')
 hold.resolve();await f.childDone(sol.workerSessionId)
})

test('settled non-resident Worker compact keeps Session/binding/budget/audit and continues the same Worker without a compact turn', {timeout:30000}, async t => {
 const f = await fixture(t, {plan:a=>a.id==='leader'?null:report})
 const { BasicCompactionEngine } = await native('dsh-compaction-basic')
 let summaries = 0
 const Summarizer=class extends BasicCompactionEngine {
  async summarize(){summaries++;return {summary:[{type:'text',text:'exact settled Worker regression facts'}],provider:'codex',model:'gpt-6-luna'}}
 }
 f.ctx.on('agent/created', async ({agent}) => {
  if(agent.session.header.origin==='subagent') await agent.ctx.plugin(Summarizer,{auto:false}).await()
 })
 await f.prepare();await f.turn(f.leader)
 const first=nested(await call(f,'postman_worker',{task:'bounded related assignment'})),id=first.workerSessionId
 assert.equal(first.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(first))
 await f.childDone(id);await f.turn(f.leader,'Consume final report before related continuation')
 assert.equal(f.ctx.agents.get(id),undefined)
 const before=await f.ctx.sessionPersistence.inspect(id),binding=structuredClone(f.registry.get('leader').workers[id]),requests=f.requests.length
 const compact=nested(await call(f,'postman_worker_compact',{workerSessionId:id}))
 assert.deepEqual(compact,{status:'POSTMAN_WORKER_COMPACTED',workerSessionId:id,compacted:true,sameSession:true})
 assert.equal(summaries,1);assert.equal(f.requests.length,requests,'no Worker model turn for compact')
 assert.equal(f.ctx.agents.get(id),undefined,'maintenance handle released')
 assert.equal(f.ctx.subagents.continuations.activations.has(id),false)
 assert.deepEqual(f.registry.get('leader').workers[id],binding,'binding, admissions, reports and budget unchanged')
 const after=await f.ctx.sessionPersistence.inspect(id)
 assert.equal(after.meta.id,before.meta.id);assert.equal(after.meta.parentSession,before.meta.parentSession)
 assert.deepEqual(after.events.slice(0,before.events.length),before.events,'raw audit history retained')
 assert.equal(after.events.filter(e=>e.type==='turn/start').length,before.events.filter(e=>e.type==='turn/start').length)
 assert.ok(after.events.some(e=>e.type==='compaction/end'))
 const next=nested(await call(f,'postman_worker',{workerSessionId:id,task:'continue the same related assignment'}))
 assert.equal(next.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(next));assert.equal(next.workerSessionId,id)
 await f.childDone(id)
 assert.equal(f.ctx.agents.get(id),undefined)
 assert.ok(f.requests.filter(r=>r.agent.id===id).length>before.events.filter(e=>e.type==='turn/start').length)
 const continued=f.registry.get('leader').workers[id]
 assert.equal(continued.lifecycle.admissions.length,binding.lifecycle.admissions.length+1)
 assert.deepEqual(continued.lifecycle.reports.slice(0,binding.lifecycle.reports.length),binding.lifecycle.reports)
})

test('compact rejects active, pending, unknown-delivery and wrong-lineage Workers without maintenance', {timeout:30000}, async t => {
 const gate=Promise.withResolvers(),entered=Promise.withResolvers();t.after(()=>gate.resolve())
 const f=await fixture(t,{plan:async a=>{if(a.id==='leader')return null;entered.resolve();await gate.promise;return report}})
 await f.prepare();await f.turn(f.leader)
 const first=nested(await call(f,'postman_worker',{task:'hold active Worker'})),id=first.workerSessionId
 await entered.promise
 const reject=async()=>{const requests=f.requests.length,before=structuredClone(f.registry.get('leader').workers[id]);
  const result=nested(await call(f,'postman_worker_compact',{workerSessionId:id}));assert.equal(result.status,'POSTMAN_WORKER_COMPACT_BUSY',JSON.stringify(result));
  assert.equal(f.requests.length,requests);assert.deepEqual(f.registry.get('leader').workers[id],before)}
 await reject();gate.resolve();await f.childDone(id);await f.turn(f.leader,'Consume final active Worker report')
 const inspect=f.ctx.sessionPersistence.inspect.bind(f.ctx.sessionPersistence)
 for(const delivery of ['pending','unknown']) {
  await f.registry.change('leader',r=>({...r,workers:{...r.workers,[id]:{...r.workers[id],delivery}}}))
  await reject()
 }
 await f.registry.change('leader',r=>({...r,workers:{...r.workers,[id]:{...r.workers[id],delivery:'none'}}}))
 for(const mismatch of ['pending','parent','depth','open-turn']) {
  f.ctx.sessionPersistence.inspect=async(target,...args)=>{
   const saved=await inspect(target,...args);if(target!==id)return saved
   if(mismatch==='parent')return {...saved,meta:{...saved.meta,parentSession:'foreign-parent'}}
   if(mismatch==='depth')return {...saved,meta:{...saved.meta,delegationDepth:99}}
   const extra=mismatch==='pending'?{type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'parked',role:'user',source:{kind:'user'},content:[{type:'text',text:'not settled'}]}]}}:{type:'turn/start',data:{turn:999}}
   return {...saved,events:[...saved.events,{...extra,seq:saved.events.length,time:Date.now()}]}
  }
  await reject();assert.equal(f.ctx.agents.get(id),undefined)
 }
 f.ctx.sessionPersistence.inspect=inspect
 const saved=await inspect(id);assert.equal(saved.events.some(e=>e.type==='compaction/start'),false)
})

