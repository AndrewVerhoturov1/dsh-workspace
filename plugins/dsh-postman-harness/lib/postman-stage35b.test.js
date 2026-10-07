import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {capabilityRuntime} from './fixtures/postman-capability-runtime.js'
import {assertManagementRequest} from './fixtures/postman-stage3-contract.js'
import {WORKER_CONTROL_TOOLS} from './postman-bridge-core.js'
import {SOL_WORKER_PROFILE, LEADER_SUPERVISOR_PROFILE} from './ptc-adapter.js'

const ptc=(program,boundary='semantic_decision')=>({program,boundary,description:'Complete owned control and engineering mechanics; stop at actual event or judgement'})
const report={name:'report',args:{output:'PASS terminal assignment result; exact controlled evidence'}}
const value=r=>{assert.equal(r.isError,false,JSON.stringify(r));return r.value}
const nested=r=>{const v=value(r);assert.equal(v.status,'ok',JSON.stringify(v));return v.value}
const call=(f,agent,name,args={})=>f.execute(agent,'ptc_execute',ptc('return await tools.'+name+'('+JSON.stringify(args)+')')).then(nested)
const fixture=async(t,plan)=>{
  const dir=await mkdtemp(join(tmpdir(),'postman-stage35b-'))
  const f=await capabilityRuntime(dir,{preset:'postman-leader',plan})
  t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  const diagnostics=[];f.ctx.logger.exporter({export:m=>{if(m.name==='postman-ptc')diagnostics.push(m.args[1])}})
  await f.prepare();await writeFile(join(f.worktree,'known.txt'),'PRIVATE_FILE');await f.turn(f.leader)
  return {...f,diagnostics}
}
const selectSol=async f=>{const r=await call(f,f.leader,'postman_sol_worker',{task:'User explicitly selected Sol. Finite Stage 3.5B owned controls proof, no live model.'});assert.equal(r.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(r));return r}
const turnEnd=(f,id)=>{
  const done=Promise.withResolvers()
  const stop=f.ctx.on('session/event',(session,event)=>{if(session.id===id&&event.type==='turn/end'){stop();done.resolve(event)}})
  return done.promise
}

test('Stage 3.5B exact Sol re-waits for existing owned B after A, never for active foreign Worker', {timeout:45000},async t=>{
  const gates=[Promise.withResolvers(),Promise.withResolvers()],foreignGate=Promise.withResolvers(),endings=[Promise.withResolvers(),Promise.withResolvers(),Promise.withResolvers()]
  const owned=[];let f,solId,foreignId
  t.after(()=>{gates.forEach(g=>g.resolve());foreignGate.resolve()})
  f=await fixture(t,async(a,r,n)=>{
    if(a.id==='leader')return null
    if(a.options.model==='gpt-6.1-sol'){
      solId=a.id;assertManagementRequest('sol',r)
      if(n===1)return {name:'ptc_execute',args:ptc('const a=await tools.postman_worker({task:"A",createNew:true});const b=await tools.postman_worker({task:"B",createNew:true});return {a,b}','external_event')}
      await f.childDone(owned[n-2])
      if(n===2)return {name:'ptc_execute',args:ptc('await tools.read({file_path:"known.txt"});return {handled:"A"}','external_event')}
      assert.equal(n,3,'only dispatch and two real owned events')
      assert.equal(f.ctx.agents.get(foreignId).status,'running')
      const noWake=await f.execute(a,'ptc_execute',ptc('return {}','external_event'))
      assert.notEqual(noWake.concludesTurn,true,'foreign active Worker and settled own bindings do not justify waiting')
      return report
    }
    if(a.session.header.delegationDepth===1){await foreignGate.promise;return report}
    await gates[owned.indexOf(a.id)].promise;return report
  })
  f.ctx.on('session/event',(s,e)=>{if(s.id===solId&&e.type==='turn/end')endings[e.data.turn-1]?.resolve()})
  const start=f.ctx.subagents.startContinuable.bind(f.ctx.subagents)
  f.ctx.subagents.startContinuable=async spec=>{if(spec.request.parent.id===solId)owned.push(spec.childId);return start(spec)}
  const accepted=await selectSol(f);await endings[0].promise
  const sol=f.ctx.agents.get(accepted.workerSessionId);await sol.whenIdle()
  assert.equal(owned.length,2);assert.equal(f.requests.filter(r=>r.agent.id===sol.id).length,1)
  assert.equal(sol.phase.kind,'idle')
  const leaderWait=await f.execute(f.leader,'ptc_execute',ptc('return {}','external_event'))
  assert.equal(leaderWait.concludesTurn,true,'event-waiting exact Sol with own active Workers remains a Leader wake source')
  foreignId=(await call(f,f.leader,'postman_worker',{task:'unrelated Leader-owned active work'})).workerSessionId
  gates[0].resolve();await endings[1].promise;await sol.whenIdle()
  assert.equal(f.requests.filter(r=>r.agent.id===sol.id).length,2,'no yield-only round')
  const rewait=f.results.filter(r=>r.agent.id===sol.id&&r.name==='ptc_execute')[1]
  assert.equal(rewait.result.concludesTurn,true)
  assert.deepEqual(rewait.result.value.effects.calls.map(c=>c.name),['read'],'no dispatch/status polling')
  gates[1].resolve();await endings[2].promise;await f.childDone(sol.id)
  assert.equal(f.requests.filter(r=>r.agent.id===sol.id).length,3)
  assert.deepEqual(sol.session.events.filter(e=>e.type==='turn/start').map(e=>e.data.turn),[1,2,3])
  for(const id of owned)assert.equal(sol.session.events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='subagent-report'&&e.data.source.senderSessionId===id).length,1)
  assert.equal(sol.inbox.hasPending,false)
  foreignGate.resolve();await f.childDone(foreignId)
})

test('Stage 3.5B actual Sol batches two exact children and own mechanics in ONE PTC, auto-concludes', {timeout:45000},async t=>{
  const hold=Promise.withResolvers(),end=Promise.withResolvers();t.after(()=>hold.resolve())
  let solId
  const f=await fixture(t,async(a,r,n)=>{
    if(a.id==='leader')return null
    if(a.options.model==='gpt-6.1-sol'){
      assertManagementRequest('sol',r);solId=a.id
      return n===1?{name:'ptc_execute',args:ptc(
        'const a=ptc.expectStatus(await tools.postman_worker({task:"bounded A",createNew:true}),"postman_worker");'+
        'const b=ptc.expectStatus(await tools.postman_worker({task:"bounded B",createNew:true}),"postman_worker");'+
        'const own=await tools.read({file_path:"known.txt"});return {a,b,own:own.lines.length}', 'external_event')}:null
    }
    assertManagementRequest('luna',r);await hold.promise;return report
  })
  f.ctx.on('session/event',(s,e)=>{if(s.id===solId&&e.type==='turn/end')end.resolve()})
  const accepted=await selectSol(f);await end.promise
  const sol=f.ctx.agents.get(accepted.workerSessionId);assert.ok(sol)
  assert.equal(f.requests.filter(r=>r.agent.id===sol.id).length,1,'one Sol judgement before dispatch, no waiting round')
  const outer=f.results.find(r=>r.agent.id===sol.id&&r.name==='ptc_execute')
  const v=value(outer.result);assert.equal(v.status,'ok');assert.equal(outer.result.concludesTurn,true)
  const ids=[v.value.a.workerSessionId,v.value.b.workerSessionId];assert.notEqual(...ids)
  for(const id of ids){assert.equal(f.registry.get('leader').workers[id].ownerSessionId,sol.id);assert.equal(f.registry.get('leader').workers[id].workerType,'luna')}
  const effects=sol.session.events.filter(e=>e.type==='tool/code-dispatch-start')
  assert.deepEqual(effects.map(e=>e.data.name),['postman_worker','postman_worker','read'])
  const outerCall=sol.session.events.find(e=>e.type==='tool/call'&&e.data.name==='ptc_execute').data.callId
  assert.ok(effects.every(e=>e.data.parentCallId===outerCall),'all effects correlated to same actual outer PTC')
  assert.equal(v.effects.completed,3);assert.equal(f.diagnostics.find(d=>d.sessionId===sol.id).yieldApplied,true)
  assert.equal(SOL_WORKER_PROFILE.revision,2);assert.equal(LEADER_SUPERVISOR_PROFILE.revision,9)
  hold.resolve();await Promise.all(ids.map(id=>f.childDone(id)));await sol.whenIdle()
})

for(const queued of [false,true]) test('Stage 3.5B owned report wakes Sol exactly once, queued='+queued,{timeout:45000},async t=>{
  const hold=Promise.withResolvers(),dispatchEnd=Promise.withResolvers();t.after(()=>hold.resolve())
  let f,solId,workerId
  f=await fixture(t,async(a,r,n)=>{
    if(a.id==='leader')return null
    if(a.options.model==='gpt-6.1-sol'){
      solId=a.id;assertManagementRequest('sol',r)
      if(n===1)return {name:'ptc_execute',args:ptc('const w=await tools.postman_worker({task:"one owned external completion"});await tools.read({file_path:"known.txt"});return w','external_event')}
      // Event delivery may precede producer turn settlement; deterministic test barrier, not polling.
      await f.childDone(workerId);return n===2?report:null
    }
    await hold.promise;return n===1?report:null
  })
  f.ctx.on('session/event',(s,e)=>{if(s.id===solId&&e.type==='turn/end'&&e.data.turn===1)dispatchEnd.resolve()})
  f.ctx.on('tools/execute',async(exec,next)=>{
    const r=await next()
    if(exec.agent.id===solId&&exec.parent&&exec.name==='postman_worker')workerId=r.value.workerSessionId
    if(queued&&exec.agent.id===solId&&exec.parent&&exec.name==='read'){hold.resolve();await f.childDone(workerId)}
    return r
  })
    try {
    const accepted=await selectSol(f)

    await dispatchEnd.promise
    const sol=f.ctx.agents.get(accepted.workerSessionId)??f.requests.find(r=>r.agent.id===accepted.workerSessionId).agent
    if(!queued){assert.equal(f.requests.filter(r=>r.agent.id===sol.id).length,1);const end=turnEnd(f,sol.id);hold.resolve();await end;}
    await f.childDone(workerId);await sol.whenIdle()
    const requests=f.requests.filter(r=>r.agent.id===sol.id)
    assert.equal(requests.length,2,'no lost or duplicated event / no yield-only model round')
    const turns=sol.session.events.filter(e=>e.type==='turn/start');assert.deepEqual(turns.map(e=>e.data.turn),[1,2])
    const delivered=sol.session.events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='subagent-report'&&e.data.source.senderSessionId===workerId)
    assert.equal(delivered.length,1)
    assert.equal(sol.inbox.hasPending,false)
    assert.equal(f.registry.get('leader').workers[workerId].state,'ready','settled binding retained, no forced close')
    assert.equal(f.results.filter(r=>r.agent.id===sol.id&&r.name==='report').length,1)
    assert.equal(value(f.results.findLast(r=>r.agent.id===sol.id&&r.name==='report').result).messageId.length>0,true)
  } finally {hold.resolve()}
})

test('Stage 3.5B Sol terminal report rejects owned unsettled lifecycle, allows settled/cold/no children; FAST unchanged',{timeout:60000},async t=>{
  const solGate=Promise.withResolvers(),ownGate=Promise.withResolvers(),reviewGate=Promise.withResolvers(),entered=Promise.withResolvers(),review=Promise.withResolvers();t.after(()=>{solGate.resolve();ownGate.resolve();reviewGate.resolve()})
  const f=await fixture(t,async(a,r,n)=>{
    if(a.id==='leader')return null
    if(a.options.model==='gpt-6.1-sol'){assertManagementRequest('sol',r);if(n===1){entered.resolve(a);await solGate.promise;return null}if(n===2){review.resolve(a);await reviewGate.promise;return null}return n===3?report:null}
    else if(a.session.header.delegationDepth===2)await ownGate.promise
    return n===1?report:null
  })
  try {
    const accepted=await selectSol(f),sol=await entered.promise

    const foreign=await call(f,f.leader,'postman_worker',{task:'Leader-owned unrelated work'});await f.childDone(foreign.workerSessionId)
    const secretary=await call(f,f.leader,'postman_secretary',{task:'Secretary unchanged report'});await f.childDone(secretary.workerSessionId)
    const child=await call(f,sol,'postman_worker',{task:'Exact owned active work'})
    for(const name of WORKER_CONTROL_TOOLS){const r=await f.execute(sol,name,{task:'direct forbidden',workerSessionId:child.workerSessionId});assert.equal(r.isError,true);assert.match(r.error.message,/POSTMAN_PTC_DIRECT_CALL_REJECTED/)}
    for(const id of [foreign.workerSessionId,secretary.workerSessionId,sol.id,'foreign-subtree-child'])for(const name of WORKER_CONTROL_TOOLS.filter(n=>n!=='postman_worker_list')){
      const r=await call(f,sol,name,{task:'foreign rejected',workerSessionId:id});assert.equal(r.status,'POSTMAN_WORKER_TARGET_UNKNOWN')
    }
    const rejected=async()=>{const delivered=()=>f.leader.session.events.filter(e=>e.type==='user/message'&&e.data.source?.senderSessionId===sol.id&&JSON.stringify(e.data).includes('not allowed progress')).length;const before=delivered();const r=await f.execute(sol,'report',{output:'not allowed progress'});assert.equal(r.isError,true);assert.match(r.error.message,/POSTMAN_SOL_REPORT_REJECTED/);assert.equal(delivered(),before)}
    await rejected() // actual running child
    ownGate.resolve();await f.childDone(child.workerSessionId)
    const childReport=f.results.find(r=>r.agent.id===child.workerSessionId&&r.name==='report');assert.equal(childReport?.result.isError,false,JSON.stringify(childReport?.result))
    solGate.resolve();await review.promise // actual next model request has claimed the owned report
    const binding=f.registry.get('leader').workers[child.workerSessionId]
    const alter=b=>f.registry.change('leader',row=>({...row,workers:{...row.workers,[child.workerSessionId]:b}}))
    for(const b of [{...binding,delivery:'pending'},{...binding,delivery:'unknown'},{...binding,state:'intent'},{...binding,state:'uncertain'},{...binding,state:'stopping'},
      {...binding,lifecycle:{...binding.lifecycle,admissions:[...binding.lifecycle.admissions,{id:'accepted-unclaimed',state:'accepted',messageId:'not-consumed'}]}},
      {...binding,lifecycle:{...binding.lifecycle,admissions:[...binding.lifecycle.admissions,{id:'pending',state:'pending',messageId:null}]}}]){
      await alter(b);await rejected()
    }
    await alter(binding)

    assert.equal((await f.execute(sol,'notify_parent',{message:'FYI Workers launched'})).value.status,'POSTMAN_WORKER_NOTIFICATION_REJECTED')
    const escalation=value(await f.execute(sol,'notify_parent',{message:'NEEDS_PARENT_GUIDANCE: exact decision outside finite assignment'}));assert.equal(escalation.status,'PARENT_NOTIFICATION_ACCEPTED')

    const acceptedReport=await f.execute(sol,'report',report.args);assert.equal(acceptedReport.isError,false,JSON.stringify(acceptedReport))
    reviewGate.resolve();await f.childDone(accepted.workerSessionId)
    const final=f.results.findLast(r=>r.agent.id===sol.id&&r.name==='report');assert.equal(final.result.isError,false,JSON.stringify(final.result))
    assert.ok(f.registry.get('leader').workers[child.workerSessionId],'settled binding does not block final report')
    for(const id of [foreign.workerSessionId,secretary.workerSessionId])assert.equal(f.results.findLast(r=>r.agent.id===id&&r.name==='report').result.isError,false)
    const next=await call(f,f.leader,'postman_sol_worker',{workerSessionId:sol.id,task:'Related final report after settled owned work'})
    await f.childDone(next.workerSessionId)
    assert.equal(f.results.findLast(r=>r.agent.id===sol.id&&r.name==='report').result.isError,false)
    } finally {solGate.resolve();ownGate.resolve();reviewGate.resolve()}
})

test('Stage 3.5B Sol with no children can report terminal assignment', {timeout:20000},async t=>{
  const f=await fixture(t,(a)=>a.id==='leader'?null:report)
  const sol=await selectSol(f);await f.childDone(sol.workerSessionId)
  const final=f.results.find(r=>r.agent.id===sol.workerSessionId&&r.name==='report')
  assert.equal(final.result.isError,false,JSON.stringify(final.result))
  assert.ok(final.result.value.messageId)
})

test('Stage 3.5B logger sees semantic shape even with needsModelDecision, without leaking payload',{timeout:45000},async t=>{
  const f=await fixture(t,()=>null)
  const programs=[
    ['await tools.read({file_path:"known.txt"});return {ordinary:true}',true,true,true],
    ['await tools.read({file_path:"known.txt"});return {needsModelDecision:true,decisionQuestion:"PRIVATE_QUESTION",evidence:"PRIVATE_EVIDENCE"}',true,true,false],
    ['await tools.read({file_path:"known.txt"});await tools.read({file_path:"known.txt"});return {}',false,true,false],
    ['await tools.read({file_path:"known.txt"});await tools.read({file_path:"known.txt"});await tools.read({file_path:"known.txt"});return {}',false,false,false],
  ]
  for(const [program,small,thin,candidate] of programs){
    nested(await f.execute(f.leader,'ptc_execute',ptc(program.replaceAll('"known.txt"',JSON.stringify(join(f.worktree,'known.txt'))))))
    const d=f.diagnostics.at(-1);assert.equal(d.smallSemanticPhase,small);assert.equal(d.thinSemanticPhase,thin);assert.equal(d.underbatchedCandidate,candidate)
    if(program.includes('needsModelDecision')){assert.equal(d.needsModelDecision,true);assert.equal(d.decisionQuestionPresent,true)}
  }
  for(const boundary of ['semantic_decision','external_event']){
    const r=await f.execute(f.leader,'ptc_execute',ptc('return await tools.postman_worker({task:"bounded shape evidence"})',boundary))
    const worker=nested(r);await f.childDone(worker.workerSessionId)
    const d=f.diagnostics.at(-1);assert.equal(d.smallSemanticPhase,boundary==='semantic_decision');assert.equal(d.thinSemanticPhase,boundary==='semantic_decision');assert.equal(d.underbatchedCandidate,false)
  }
  assert.doesNotMatch(JSON.stringify(f.diagnostics),/PRIVATE_QUESTION|PRIVATE_EVIDENCE|PRIVATE_FILE|program|arguments|file_path|ordinary/)
})
