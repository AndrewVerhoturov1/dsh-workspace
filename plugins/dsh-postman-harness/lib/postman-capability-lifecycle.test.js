import assert from 'node:assert/strict'
import {assertManagementRequest} from './fixtures/postman-stage3-contract.js'
import test from 'node:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capabilityRuntime, native } from './fixtures/postman-capability-runtime.js'
import { POSTMAN_LEADER_TOOL_ALLOWLIST, SECRETARY_TOOLS, DELEGATION_TOOLS, POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_BRIDGE_TOOL_ALLOWLIST, WORKER_CONTROL_TOOLS, POSTMAN_SOL_PTC_TOOL_NAMES, buildPostmanBridgeStartRequest } from './postman-bridge-core.js'
import { postmanRoleInstruction } from './postman-worker.js'
import { createDirectCurrentTurnToolConfigs } from './direct-current-turn.js'

const sorted = xs => [...new Set(xs)].sort()
export function toolMatrix(role, expected, request) {
  const actual = sorted(request.tools.map(t => t.name)); expected = sorted(expected)
  const missing = expected.filter(n => !actual.includes(n)), unexpected = actual.filter(n => !expected.includes(n))
  const diagnostic = 'ROLE: ' + role + '\nEXPECTED:\n' + JSON.stringify(expected) + '\nACTUAL:\n' + JSON.stringify(actual) + '\nMISSING:\n' + JSON.stringify(missing) + '\nUNEXPECTED:\n' + JSON.stringify(unexpected)
  assert.deepEqual(actual, expected, diagnostic)
  return actual
}
const ptc = program => ({ program, description: 'Execute bounded fixture evidence before review', boundary: 'semantic_decision' })
const fixture = async (t, options) => {
  const dir = await mkdtemp(join(tmpdir(), 'postman-capability-'))
  const f = await capabilityRuntime(dir, options)
  t.after(async () => { await f.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return { ...f, dir }
}
const leaderExpected = [...POSTMAN_LEADER_TOOL_ALLOWLIST, 'ptc_execute']
const ok = r => { assert.equal(r.isError, false, JSON.stringify(r)); return r.value }
const nested = r => { const v = ok(r); assert.equal(v.status, 'ok', JSON.stringify(v)); return v.value }
const role = agent => agent.id === 'leader' ? 'leader' : agent.options.model === 'gpt-6.1-sol' ? 'sol' : agent.session.events.some(e=>e.type==='subagent/descriptor'&&e.data.label==='Secretary') ? 'secretary' : 'luna'
const report = { name: 'report', args: { output: 'bounded verified fixture evidence '.repeat(1000) } }

for (const preset of ['postman-leader-ptc', 'code', 'postman-leader']) test('actual model request: ' + preset + ' creation/switch -> full PTC Leader', { timeout: 30000 }, async t => {
  const f = await fixture(t, { preset })
  if (preset === 'code') await f.switchPreset('postman-leader-ptc')
  const r = await f.turn(f.leader)
  toolMatrix('postman-leader-ptc', leaderExpected, r)
  assertManagementRequest('leader', r)
  assertManagementRequest('leader', await f.turn(f.leader, 'Related management follow-up'))
  assert.ok(r.tools.some(t=>t.name==='ask_user_question'),preset+': Leader retains user questions')
  assert.equal(r.model,'gpt-6.1-sol'); assert.equal(r.reasoningEffort,'xhigh'); assert.match(r.system,/canonical programming discipline/); assert.match(r.system, /postman-leader/);assert.match(JSON.stringify(r),/POSTMAN_LEADER_SKILL_VERSION: 30/)
  await writeFile(join(f.dir, 'facts.txt'), 'old fact')
  const result = nested(await f.execute(f.leader, 'ptc_execute', ptc('const r=await tools.read({file_path:"facts.txt"});const g=await tools.grep({pattern:"old fact",path:"facts.txt"});return {r,g}')))
  assert.equal(result.r.lines[0].text, 'old fact'); assert.ok(result.g.matches.length)
  for (const name of ['read','grep','postman_worker','postman_secretary','postman_bridge','postman_sol_worker','postman_yield','postman_team_status','postman_bridge_stop']) {
    const args = name === 'read' ? {file_path:'facts.txt'} : name === 'grep' ? {pattern:'fact'} : name === 'postman_bridge' ? {message:'@PostmanAsk bounded fixture'} : name==='postman_bridge_stop' ? {bridge_job_id:'foreign'} : ['postman_yield','postman_team_status'].includes(name) ? {} : {task:'bounded fixture'}
    const denied = await f.execute(f.leader, name, args)
    assert.equal(denied.isError, true, name); assert.match(denied.error.message, /POSTMAN_PTC_DIRECT_CALL_REJECTED/)
  }
})

test('late registration: allowed Leader and forbidden Worker/Secretary tools affect actual requests', { timeout: 30000 }, async t => {
  const f = await fixture(t, { lateFs:true, plan: a => a.id === 'leader' ? null : report })
  const { defineTool } = await native('dsh-tools'), { scopeParentOf, createScope } = await native('dsh-scope')
  toolMatrix('Leader before fs registration',leaderExpected.filter(n=>!['read','read_image'].includes(n)),await f.turn(f.leader))
  await f.registerLateFs()
  toolMatrix('Leader after late fs registration',leaderExpected,await f.turn(f.leader))
  await f.prepare()
  const worker = nested(await f.execute(f.leader,'ptc_execute',ptc('return await tools.postman_worker({task:"bounded fixture"})')))
  const secretary = nested(await f.execute(f.leader,'ptc_execute',ptc('return await tools.postman_secretary({task:"bounded fixture"})')))
  await f.childDone(worker.workerSessionId); await f.childDone(secretary.workerSessionId)
  const temporary=createScope(f.ctx,scopeParentOf(f.leader));t.after(()=>temporary.dispose())
  temporary.ctx.tools.register(defineTool({ name:'late_forbidden_fixture',description:'forbidden fixture',parameters:{},output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:()=>({}) }))
  temporary.ctx.tools.register(f.ctx.tools.get('ptc_execute'))
  for (const id of [worker.workerSessionId,secretary.workerSessionId]) {
    const accepted = nested(await f.execute(f.leader,'ptc_execute',ptc('return await tools.'+(id===worker.workerSessionId?'postman_worker':'postman_secretary')+'({workerSessionId:'+JSON.stringify(id)+',task:"next bounded fixture"})')))
    assert.equal(accepted.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(accepted))
    await f.childDone(accepted.workerSessionId)
    const last=f.requests.filter(x=>x.agent.id===id).at(-1).request
    assert.ok(!last.tools.some(t=>t.name==='ptc_execute'))
    if(id===secretary.workerSessionId)assert.ok(!last.tools.some(t=>t.name==='late_forbidden_fixture'))
  }
})

test('all real child requests: Secretary/Worker/Sol functional smoke, ownership, lifecycle and cold resume', { timeout: 120000 }, async t => {
  const queues = new Map(), solGate=Promise.withResolvers(), solEntered=Promise.withResolvers(), ownGate=Promise.withResolvers()
  let holdSol=true
  const plan = async a => { if(role(a)==='sol'&&holdSol){solEntered.resolve(a);await solGate.promise} if(a.options.model==='gpt-6-luna'&&a.session.header.parentSession&&a.session.header.parentSession!=='leader')await ownGate.promise;return queues.get(a.id)?.shift() ?? (a.id==='leader' ? null : report) }
  t.after(()=>{solGate.resolve();ownGate.resolve()})
  const f = await fixture(t, { plan })
  await f.prepare(); await writeFile(join(f.worktree,'facts.txt'),'old fact')
  const leaderCall = async (name,args) => nested(await f.execute(f.leader,'ptc_execute',ptc('return await tools.'+name+'('+JSON.stringify(args)+')')))
  const start = async (name,parent=f.leader) => {
    const r = parent===f.leader ? await leaderCall(name,{task:'Explicit user-selected Sol Worker route; bounded fixture evidence'}) : ok(await f.execute(parent,name,{task:'bounded owned fixture evidence'}))
    assert.equal(r.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(r));const a=name==='postman_sol_worker'?await solEntered.promise:await f.childDone(r.workerSessionId);assert.ok(a);return a
  }
  const secretary=await start('postman_secretary'), worker=await start('postman_worker'), settledSol=await start('postman_sol_worker')
  const sol=f.ctx.agents.get(settledSol.id)
  assert.ok(sol, 'native continuable Sol activation remains resident')
  const owned=[]
  for(let i=0;i<2;i++){const r=ok(await f.execute(sol,'postman_worker',{task:'bounded concurrent owned Worker '+i,createNew:true}));assert.equal(r.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(r));owned.push(r.workerSessionId)}
  assert.notEqual(owned[0],owned[1])
  const third=ok(await f.execute(sol,'postman_worker',{task:'third disallowed owned Worker',createNew:true}));assert.equal(third.status,'POSTMAN_WORKER_LIMIT_REACHED',JSON.stringify(third))
  ownGate.resolve();const [own,own2]=await Promise.all(owned.map(id=>f.childDone(id)))
  const { scopeParentOf }=await native('dsh-scope')
  const ordinary=f.ctx.tools.schemas(scopeParentOf(f.leader)).map(t=>t.name).filter(n=>!POSTMAN_LEADER_ONLY_TOOL_NAMES.includes(n)&&n!=='ptc_execute'&&!DELEGATION_TOOLS.includes(n))
  for(const name of ['ask_user_question','list_agents','exit_plan_mode'])assert.ok(ordinary.includes(name),'native inherited catalog contains '+name)
  const expected={secretary:SECRETARY_TOOLS.filter(n=>n!=='bash'),luna:sorted([...ordinary.filter(n=>!['ask_user_question','list_agents','exit_plan_mode'].includes(n)),'report']),sol:sorted([...ordinary.filter(n=>!['ask_user_question','exit_plan_mode'].includes(n)),...WORKER_CONTROL_TOOLS,'ptc_execute','report'])}
  const check=(a,label=role(a))=>{
    const entries=f.requests.filter(x=>x.agent.id===a.id)
    for(const {request} of entries){assertManagementRequest(role(a),request);toolMatrix(label,expected[role(a)],request);assert.ok(request.system.includes(postmanRoleInstruction(role(a))));assert.equal(request.model,role(a)==='sol'?'gpt-6.1-sol':'gpt-6-luna');assert.equal(request.reasoningEffort,role(a)==='sol'?'xhigh':'low')}
    if(role(a)==='luna')for(const {request} of entries){
      const names=request.tools.map(t=>t.name)
      for(const name of ['ask_user_question','list_agents','exit_plan_mode'])assert.ok(!names.includes(name),label+': forbidden '+name)
      for(const name of ['notify_parent','report'])assert.ok(names.includes(name),label+': escalation '+name)
    }
    return entries.at(-1).request
  }
  const wr=check(worker,'Worker under Leader')
  for(const a of [own,own2]){const ow=check(a,'Worker under Sol');assert.deepEqual(sorted(wr.tools.map(t=>t.name)),sorted(ow.tools.map(t=>t.name)))}
  const sr=check(secretary), solr=check(sol)
  for(const name of ['ask_user_question','list_agents'])assert.ok(!sr.tools.some(t=>t.name===name),'Secretary: forbidden '+name)
  assert.ok(!solr.tools.some(t=>t.name==='ask_user_question'),'Sol: no user questions')
  const admission=async(a)=>a.session.header.parentSession==='leader'?leaderCall(role(a)==='sol'?'postman_sol_worker':role(a)==='secretary'?'postman_secretary':'postman_worker',{workerSessionId:a.id,task:'next exact bounded fixture'}) : ok(await f.execute(sol,'postman_worker',{workerSessionId:a.id,task:'next exact bounded fixture'}))
  for(const a of [secretary,worker,own]) {
    const batch=role(a)==='secretary'?[{name:'read',args:{file_path:'facts.txt'}},{name:'glob',args:{pattern:'*.txt'}},{name:'grep',args:{pattern:'fact',path:'facts.txt'}},{name:'postman_secretary_ledger',args:{content:'verified fact ledger',revision:0}},{name:'postman_secretary_ledger',args:{}}]:role(a)==='sol'?[{name:'ptc_execute',args:ptc('const r=await tools.read({file_path:"facts.txt"});const g=await tools.grep({pattern:"fact",path:"facts.txt"});await tools.edit({file_path:"facts.txt",old_string:"old fact",new_string:"new fact"});const after=await tools.read({file_path:"facts.txt"});return {r,g,after,names:Object.keys(tools)}')}]:[{name:'read',args:{file_path:'facts.txt'}},{name:'glob',args:{pattern:'*.txt'}},{name:'write',args:{file_path:a.id+'.txt',content:'smoke old'}},{name:'read',args:{file_path:a.id+'.txt'}},{name:'edit',args:{file_path:a.id+'.txt',old_string:'smoke old',new_string:'smoke new'}},{name:'read',args:{file_path:a.id+'.txt'}},{name:'pwsh',args:{command:'Write-Output safe-fixture-smoke',description:'Print safe fixture smoke evidence'}}]
    for(const action of batch){if(action.args.file_path)action.args.file_path=join(f.worktree,action.args.file_path);if(action.name==='glob')action.args.path=f.worktree;if(action.name==='grep')action.args.path=join(f.worktree,'facts.txt')}
    if(role(a)==='luna')batch.push({name:'notify_parent',args:{message:'NEEDS_PARENT_GUIDANCE: bounded fixture needs an immediate parent decision'}})
    queues.set(a.id,[...batch,report]);const startIndex=f.results.length
    assert.equal((await admission(a)).status,'POSTMAN_WORKER_TASK_ACCEPTED');await f.childDone(a.id);check(a)
    const results=f.results.slice(startIndex).filter(x=>x.agent.id===a.id)
    for(const r of results)assert.equal(r.result.isError,false,JSON.stringify({name:r.name,result:r.result}))
    assert.ok(results.some(r=>r.name==='report'))
    if(role(a)==='luna'){assert.equal(results.find(r=>r.name==='notify_parent').result.value.status,'PARENT_NOTIFICATION_ACCEPTED');assert.ok(results.find(r=>r.name==='report').result.value.messageId)}
    if(role(a)==='secretary'){assert.equal(f.registry.get('leader').secretaryLedger.content,'verified fact ledger');assert.equal(results.findLast(r=>r.name==='postman_secretary_ledger').result.value.ledger.content,'verified fact ledger')}
    else if(role(a)==='sol'){const v=results.find(r=>r.name==='ptc_execute').result.value;assert.equal(v.status,'ok',JSON.stringify(v));assert.equal(v.value.after.lines[0].text,'new fact');assert.ok(v.value.names.includes('read')&&v.value.names.includes('grep'));}
    else assert.equal(await readFile(join(f.worktree,a.id+'.txt'),'utf8'),'smoke new')
  }
  await writeFile(join(f.worktree,'facts.txt'),'old fact')
  // Guards checked during a live Sol turn; controls remain direct-only and owned.
  queues.set(sol.id,[{text:'gate'}])
  const liveSol=sol
  for(const name of ['read','glob','grep','write','edit']){
    const args=name==='read'?{file_path:'facts.txt'}:name==='glob'?{pattern:'*.txt'}:name==='grep'?{pattern:'fact'}:name==='write'?{file_path:'unused',content:'x'}:{file_path:'facts.txt',old_string:'old',new_string:'new'}
    const r=await f.execute(liveSol,name,args);assert.equal(r.isError,true);assert.match(r.error.message,/POSTMAN_PTC_DIRECT_CALL_REJECTED/)
  }
  const list=ok(await f.execute(liveSol,'postman_worker_list'));assert.equal(list.quota.luna.limit,2);assert.deepEqual(list.workers.map(w=>w.workerSessionId).sort(),[own.id,own2.id].sort())
  for(const id of [worker.id,secretary.id,sol.id,'foreign-id'])for(const name of WORKER_CONTROL_TOOLS.filter(n=>n!=='postman_worker_list')){
    const r=ok(await f.execute(liveSol,name,{workerSessionId:id,task:'bounded foreign fixture'}));assert.equal(r.status,'POSTMAN_WORKER_TARGET_UNKNOWN',JSON.stringify({name,id,r}))
  }
  for(const a of [secretary,worker,own,own2]){
    const before=Object.keys(f.registry.get('leader').workers).length
    const h=await f.ctx.agents.resume({resumeSessionId:a.id,agentOptions:{provider:'codex',model:'gpt-6-luna'}})
    for(const name of ['postman_worker','postman_secretary','postman_sol_worker','ptc_execute','subagent','workflow'])assert.equal((await f.execute(h.agent,name,{task:'forbidden child',program:'return 1',description:'forbidden',boundary:'semantic_decision'})).isError,true,name)
    assert.equal(Object.keys(f.registry.get('leader').workers).length,before);await h.dispose()
  }
  const redirect=ok(await f.execute(sol,'postman_worker_interrupt',{workerSessionId:own2.id,task:'bounded owned redirect'}));assert.equal(redirect.status,'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED',JSON.stringify(redirect));await f.childDone(own2.id);check(own2)
  for(const name of WORKER_CONTROL_TOOLS)assert.ok(!POSTMAN_SOL_PTC_TOOL_NAMES.includes(name))
  const smoke=nested(await f.execute(liveSol,'ptc_execute',ptc('const r=await tools.read({file_path:"facts.txt"});const g=await tools.grep({pattern:"fact",path:"facts.txt"});await tools.edit({file_path:"facts.txt",old_string:"old fact",new_string:"new fact"});const after=await tools.read({file_path:"facts.txt"});return {r,g,after}'.replaceAll('\"facts.txt\"',JSON.stringify(join(f.worktree,'facts.txt'))))))
  assert.equal(smoke.after.lines[0].text,'new fact')
  holdSol=false;solGate.resolve();await f.childDone(sol.id)
  // Real native compact with controlled summarizer (no live model/network).
  const { BasicCompactionEngine }=await native('dsh-compaction-basic')
  const Summarizer=class extends BasicCompactionEngine {async summarize(){return {summary:[{type:'text',text:'exact finite verified fixture facts'}],provider:'codex',model:'gpt-6-luna'}}}
  for(const a of [secretary,worker,sol]){
    const ownerHandle=a.session.header.parentSession==='leader'?null:await f.ctx.agents.resume({resumeSessionId:sol.id,agentOptions:{provider:'codex',model:'gpt-6.1-sol'}})
    const owner=ownerHandle?.agent ?? f.leader
    const h=f.ctx.agents.get(a.id)?null:await f.ctx.agents.resume({resumeSessionId:a.id,agentOptions:{provider:'codex',model:a.options.model}})
    const resident=h?.agent ?? f.ctx.agents.get(a.id)
    const c=resident.ctx.plugin(Summarizer,{auto:false});await c.await()
    const compact=owner===f.leader?await leaderCall('postman_worker_compact',{workerSessionId:a.id}):ok(await f.execute(owner,'postman_worker_compact',{workerSessionId:a.id}))
    assert.equal(compact.status,'POSTMAN_WORKER_COMPACTED',JSON.stringify(compact));await h?.dispose()
    const next=owner===f.leader?await admission(a):ok(await f.execute(owner,'postman_worker',{workerSessionId:a.id,task:'bounded post-compact assignment'}))
    assert.equal(next.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify({role:role(a),next}));await f.childDone(a.id);check(a);await ownerHandle?.dispose()
  }
})

test('fresh real Secretary Worker Sol preserve exact catalog and ledger', {timeout:30000}, async t=>{
 let ledgerWritten=false
 const f=await fixture(t,{plan:a=>{if(role(a)==='secretary'&&!ledgerWritten){ledgerWritten=true;return {name:'postman_secretary_ledger',args:{content:'fresh preserves verified private ledger',revision:0}}}return a.id==='leader'?null:report}});await f.prepare()
 if(typeof f.ctx.subagents.closeContinuableChild!=='function'){t.skip('published SDK: EXACT_CHILD_ADMISSION_CUTOFF_UNAVAILABLE; installed Host is checked separately');return}
 const call=async(name,args)=>nested(await f.execute(f.leader,'ptc_execute',ptc('return await tools.'+name+'('+JSON.stringify(args)+')')))
 for(const name of ['postman_secretary','postman_worker','postman_sol_worker']){
  const first=await call(name,{task:'User-authorized explicit Sol Worker bounded route'});assert.equal(first.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(first));const a=await f.childDone(first.workerSessionId)
  const expected=f.requests.find(x=>x.agent.id===a.id).request
  await f.turn(f.leader,'Review exact native role report')
  const fresh=await call('postman_worker_fresh',{workerSessionId:a.id,task:'fresh exact role assignment'})
  assert.equal(fresh.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(fresh));assert.notEqual(fresh.workerSessionId,a.id)
  const b=await f.childDone(fresh.workerSessionId),actual=f.requests.find(x=>x.agent.id===b.id).request
  assertManagementRequest(role(a),actual);toolMatrix('fresh '+name,expected.tools.map(t=>t.name),actual);assert.ok(actual.system.includes(postmanRoleInstruction(role(a))));assert.equal(actual.model,expected.model);assert.equal(actual.reasoningEffort,expected.reasoningEffort)
  if(name==='postman_secretary')assert.ok(actual.system.includes('fresh preserves verified private ledger'))
 }
})

test('Sol actual model direct controls manage only its own Worker lifecycle', {timeout:30000},async t=>{
 const gate=Promise.withResolvers(),entered=Promise.withResolvers();let step=0,sol,own,second,f
 t.after(()=>gate.resolve())
 const plan=async a=>{
  if(a.id==='leader')return null
  if(a.options.model!=='gpt-6.1-sol')return report
  if(step++===0){entered.resolve(a);await gate.promise;return {name:'postman_worker_list',args:{}}}
  if(step===2)return {name:'postman_worker_stop',args:{workerSessionId:second,mode:'close'}}
  if(step===3)return {name:'postman_worker_fresh',args:{workerSessionId:own,task:'fresh owned finite assignment'}}
  const fresh=f.results.findLast(r=>r.agent.id===a.id&&r.name==='postman_worker_fresh')?.result.value
  if(fresh?.workerSessionId&&fresh.status==='POSTMAN_WORKER_TASK_ACCEPTED')await f.childDone(fresh.workerSessionId)
  return report
 }
 f=await fixture(t,{plan});await f.prepare()
 if(typeof f.ctx.subagents.closeContinuableChild!=='function'){t.skip('published SDK exact-child close API unavailable');return}
 await f.turn(f.leader)
 const accepted=nested(await f.execute(f.leader,'ptc_execute',ptc('return await tools.postman_sol_worker({task:"User selects explicit Sol route for owned lifecycle"})')));assert.equal(accepted.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(accepted));sol=await entered.promise
 const ids=[];for(let i=0;i<2;i++){const r=ok(await f.execute(sol,'postman_worker',{task:'owned finite evidence '+i,createNew:true}));assert.equal(r.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(r));ids.push(r.workerSessionId);await f.childDone(r.workerSessionId)}
 ;[own,second]=ids
 const {BasicCompactionEngine}=await native('dsh-compaction-basic'),h=await f.ctx.agents.resume({resumeSessionId:own,agentOptions:{provider:'codex',model:'gpt-6-luna'}})
 const Summarizer=class extends BasicCompactionEngine{async summarize(){return {summary:[{type:'text',text:'owned exact facts'}],provider:'codex',model:'gpt-6-luna'}}};await h.agent.ctx.plugin(Summarizer,{auto:false}).await()
 const compact=ok(await f.execute(sol,'postman_worker_compact',{workerSessionId:own}));assert.equal(compact.status,'POSTMAN_WORKER_COMPACTED',JSON.stringify(compact));await h.dispose()
  const continuation=ok(await f.execute(sol,'postman_worker',{workerSessionId:own,task:'Related precise post-compact owned check'}));assert.equal(continuation.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(continuation));await f.childDone(own)
  assertManagementRequest('luna',f.requests.filter(r=>r.agent.id===own).at(-1).request)
 gate.resolve();await f.childDone(sol.id)
 for(const [name,status]of [['postman_worker_list','POSTMAN_WORKER_LIST'],['postman_worker_stop','POSTMAN_WORKER_STOPPED'],['postman_worker_fresh','POSTMAN_WORKER_TASK_ACCEPTED']]){const r=f.results.findLast(r=>r.agent.id===sol.id&&r.name===name)?.result;assert.ok(r,name);assert.equal(r.isError,false,JSON.stringify(r));assert.equal(r.value.status,status,JSON.stringify(r.value))}
 const fresh=f.results.findLast(r=>r.agent.id===sol.id&&r.name==='postman_worker_fresh').result.value
 const old=f.requests.find(r=>r.agent.id===own).request,next=f.requests.find(r=>r.agent.id===fresh.workerSessionId).request;assertManagementRequest('luna',next);toolMatrix('fresh owned Worker',old.tools.map(t=>t.name),next)
})

test('Bridge actual first request exact transport allowlist including skill; no Web Send', { timeout:30000 },async t=>{
  const f=await fixture(t)
  const {defineTool}=await native('dsh-tools')
  const direct=createDirectCurrentTurnToolConfigs(f.ctx,{taskContexts:f.contexts})
  for(const tool of direct.tools)f.ctx.tools.register(defineTool(tool))
  t.after(()=>direct.dispose())
  const run=await f.ctx.subagents.start('spawn',buildPostmanBridgeStartRequest({parent:f.leader,message:'@PostmanAsk controlled catalog capture; do not send',signal:new AbortController().signal,transportKind:'text'}))
  await run.result
  const request=f.requests.find(x=>x.agent.session.header.parentSession===f.leader.id&&x.agent.id!==f.leader.id).request
  toolMatrix('Bridge',POSTMAN_BRIDGE_TOOL_ALLOWLIST,request);assert.match(request.system,/Postman Bridge/)
  await run.dispose()
})
