import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { capabilityRuntime } from './fixtures/postman-capability-runtime.js'

// Real production Host, QuickJS, native continuable children, report and inbox.
// Only model responses and their independent completion gates are controlled.
for (const queued of [false, true]) test('Leader re-enters external_event for existing Worker B after A report, queued=' + queued, { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'postman-existing-workers-'))
  const gates = [Promise.withResolvers(), Promise.withResolvers()]
  const ids = [], endings = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()]
  let f
  t.after(async () => { gates.forEach(g => g.resolve()); await f?.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }) })
  const ptc = program => ({ name: 'ptc_execute', args: { program, description: 'Handle known facts then wait for exact Worker event', boundary: 'external_event' } })
  f = await capabilityRuntime(dir, { preset: 'postman-leader', plan: async (a, r, n) => {
    assert.ok(!r.tools.some(t => t.name === 'postman_yield'))
    if (a.id === 'leader') {
      if (n === 1) return ptc('const a=await tools.postman_worker({task:"A",createNew:true});const b=await tools.postman_worker({task:"B",createNew:true});return {a,b}')
      await f.childDone(ids[n - 2]) // Exact native settlement before known processing, not polling.
      if (n === 2) return ptc('await tools.read({file_path:' + JSON.stringify(join(f.worktree, 'known.txt')) + '});return {handled:"A"}')
      assert.equal(n, 3, 'only dispatch + A event + B event model requests')
      return { text: 'Both real reports processed' }
    }
    const index = ids.indexOf(a.id)
    // IDs are captured at native admission before child model execution.
    await gates[index].promise
    return { name: 'report', args: { output: 'PASS exact Worker ' + index } }
  } })
  f.ctx.on('session/event', (s, e) => { if (s.id === 'leader' && e.type === 'turn/end') endings[e.data.turn - 1]?.resolve() })
  const start = f.ctx.subagents.startContinuable.bind(f.ctx.subagents)
  f.ctx.subagents.startContinuable = async spec => { ids.push(spec.childId); return start(spec) }
  f.ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    // B arrives after Host proved it active, but before the outer result reaches
    // AgentLoop: exercise the existing queued-event boundary, not a fake source.
    if (queued && exec.agent.id === 'leader' && exec.name === 'ptc_execute' && result.value?.value?.handled === 'A') {
      assert.equal(result.concludesTurn, true); gates[1].resolve(); await f.childDone(ids[1])
    }
    return decision
  })
  await f.prepare(); await writeFile(join(f.worktree, 'known.txt'), 'known processing')
  await f.turn(f.leader, 'Approved bounded two independent Worker event regression')
  assert.equal(ids.length, 2); assert.equal(f.requests.filter(r => r.agent.id === 'leader').length, 1)
  gates[0].resolve(); await endings[1].promise
  if (!queued) {
    await f.leader.whenIdle()
    assert.equal(f.ctx.agents.get(ids[1]).status, 'running')
    assert.equal(f.requests.filter(r => r.agent.id === 'leader').length, 2, 'no yield-only round')
    gates[1].resolve()
  }
  await endings[2].promise; await f.leader.whenIdle(); await Promise.all(ids.map(id => f.childDone(id)))
  assert.equal(f.requests.filter(r => r.agent.id === 'leader').length, 3)
  const outer = f.results.filter(r => r.agent.id === 'leader' && r.name === 'ptc_execute')
  assert.equal(outer.length, 2); assert.ok(outer.every(r => r.result.concludesTurn === true))
  assert.deepEqual(outer[1].result.value.effects.calls.map(c => c.name), ['read'], 'no dispatch or status polling on re-wait')
  assert.deepEqual(f.leader.session.events.filter(e => e.type === 'tool/call').map(e => e.data.name), ['ptc_execute', 'ptc_execute'])
  assert.deepEqual(f.leader.session.events.filter(e => e.type === 'turn/start').map(e => e.data.turn), [1, 2, 3])
  for (const id of ids) assert.equal(f.leader.session.events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'subagent-report' && e.data.source.senderSessionId === id).length, 1, 'no lost or duplicate report')
  assert.equal(f.leader.inbox.hasPending, false)
  // Preserve the old real-cycle close/cold-Session and independent-peer coverage
  // while replacing its explicit manual-wait tool with the event boundary above.
  const peerBefore=structuredClone(f.registry.get('leader').workers[ids[1]])
  const close=await f.execute(f.leader,'ptc_execute',{program:'return await tools.postman_worker_stop('+JSON.stringify({workerSessionId:ids[0],mode:'close'})+')',description:'Close only exact settled Worker; preserve independent peer',boundary:'semantic_decision'})
  assert.equal(close.value.value.status,'POSTMAN_WORKER_STOPPED',JSON.stringify(close))
  assert.deepEqual(Object.keys(f.registry.get('leader').workers),[ids[1]])
  assert.deepEqual(f.registry.get('leader').workers[ids[1]],peerBefore)
  const saved=await f.ctx.sessionPersistence.inspect(ids[0])
  assert.equal(saved.meta.parentSession,'leader')
  assert.equal(saved.events.filter(e=>e.type==='turn/start').length,1)
  assert.equal(saved.events.filter(e=>e.type==='turn/end').length,1)
  assert.equal(f.ctx.agents.get(ids[0]),undefined)
  assert.equal(f.leader.session.events.some(e=>e.type==='assistant/message'&&!e.data.message.content.length),false)
})
// Delayed authoritative native settlement after an already consumed terminal
// report. No fake notice, timer, polling, new scheduler or live provider.
for (const scenario of ['baseline','defer','conflicting-output','sol-defer']) test('real report then delayed settlement while B active, ' + scenario, {timeout:45000}, async t => {
  const deferSettlements=scenario!=='baseline', redundant=scenario==='defer'||scenario==='sol-defer', solParent=scenario==='sol-defer'
  const dir = await mkdtemp(join(tmpdir(),'postman-report-settled-'))
  const reports = [Promise.withResolvers(), Promise.withResolvers()]
  const releaseSettlement = Promise.withResolvers(), reportDelivered = Promise.withResolvers()
  const ends = Array.from({length:5},()=>Promise.withResolvers()), ids=[]
  let f,supervisor,solId
  const ptc = (program,boundary='external_event') => ({name:'ptc_execute',args:{program,boundary,description:'Process exact report, retain other active work, then safe cleanup'}})
  t.after(async()=>{reports.forEach(g=>g.resolve());releaseSettlement.resolve();await f?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
  f=await capabilityRuntime(dir,{preset:'postman-leader',reportDelivery:'next-step',deferSettlements,plan:async(a,r,n)=>{
    if(solParent && a.id==='leader') return null
    if(a.id==='leader' || a.id===solId) {
      supervisor=a
      if(n===1) return ptc('const a=await tools.postman_worker({task:"A",createNew:true});const b=await tools.postman_worker({task:"B",createNew:true});return {a,b}')
      if(solParent && f.registry.get('leader').workers[solId]?.lifecycle?.reports.length) return null
      if(solParent && n===4) return {name:'report',args:{output:'PASS owned child settlement/cleanup verified'}}
      if(f.registry.get('leader').stage==='closed') return {text:'Exact settlement facts and cleanup verified'}
      const bReport=a.session.events.some(e=>e.type==='user/message'&&e.data.source?.kind==='subagent-report'&&e.data.source.senderSessionId===ids[1])
      if(!bReport) return ptc('return {handled:"A",stillWaiting:"B"}')
      await Promise.all(ids.map(id=>f.childDone(id)))
      return ptc('const c=await tools.postman_worker_compact({workerSessionId:'+JSON.stringify(ids[0])+'});if(c.status!=="POSTMAN_WORKER_COMPACTED")return {status:"cleanup_blocked",c};const a=await tools.postman_worker_stop({workerSessionId:'+JSON.stringify(ids[0])+',mode:"close"});if(a.status!=="POSTMAN_WORKER_STOPPED")return {status:"cleanup_blocked",a};const b=await tools.postman_worker_stop({workerSessionId:'+JSON.stringify(ids[1])+',mode:"close"});if(b.status!=="POSTMAN_WORKER_STOPPED")return {status:"cleanup_blocked",b};const refused=await tools.postman_worker_compact({workerSessionId:'+JSON.stringify(ids[0])+'});if(refused.status!=="POSTMAN_WORKER_TARGET_UNKNOWN")return {status:"cleanup_blocked",refused};const q=await tools.postman_worker_list({});if(q.quota.luna.used!==0||q.workers.length)return {status:"cleanup_blocked",q};'+(solParent?'return {c,a,b,refused,q}':'const closed=await tools.postman_task_close({});return {c,a,b,refused,q,closed}'), 'task_complete')
    }
    await reports[ids.indexOf(a.id)].promise
    return {name:'report',args:{output:'PASS exact bounded report '+ids.indexOf(a.id)}}
  }})
  f.ctx.on('session/event',(s,e)=>{if(s.id===(solParent?solId:'leader')&&e.type==='turn/end')ends[e.data.turn-1]?.resolve()})
  const start=f.ctx.subagents.startContinuable.bind(f.ctx.subagents)
  f.ctx.subagents.startContinuable=async spec=>{if(solParent && !solId)solId=spec.childId;else ids.push(spec.childId);return start(spec)}
  f.ctx.on('tools/execute',async(exec,next)=>{
    const result=await next()
    if(exec.name==='report'&&exec.agent.id===ids[0]){reportDelivered.resolve();await releaseSettlement.promise}
    return result
  })
  await f.prepare();await f.turn(f.leader,'Approved bounded duplicate-settlement smoke')
  if(solParent) {await f.execute(f.leader,'ptc_execute',{program:'return await tools.postman_sol_worker({task:"Approved managed Sol smoke"})',boundary:'external_event',description:'Create exact managed Sol for owned child smoke'});await ends[0].promise}
  reports[0].resolve();await reportDelivered.promise;await ends[1].promise;await supervisor.whenIdle()
  assert.equal(f.requests.filter(r=>r.agent===supervisor).length,2)
  const child=f.ctx.agents.get(ids[0])
  assert.ok(child,'report does not certify native settlement')
  assert.ok(!child.session.events.some(e=>e.type==='turn/end'))
  if(scenario==='conflicting-output') child.session.append('assistant/message',{turn:1,step:1,message:{role:'assistant',content:[{type:'text',text:'A conflicting closing result after report'}],id:randomUUID(),source:{kind:'model',provider:'codex',model:'gpt-6-luna'}}},{surfaceOp:'append'})
  releaseSettlement.resolve();await f.childDone(ids[0]);await supervisor.whenIdle()
  assert.equal(f.requests.filter(r=>r.agent===supervisor).length,redundant?2:3,'only redundant A settlement judgement disappears')
  if(redundant) assert.equal(supervisor.inbox.nextStep.filter(m=>m.source?.kind==='subagent-settled').length,1,'durable fact retained without wake')
  reports[1].resolve();await f.childDone(ids[1]);await ends[redundant?2:3].promise;await supervisor.whenIdle()
  // task_complete has one normal result review, unrelated to settlement suppression.
  const requests=f.requests.filter(r=>r.agent===supervisor)
  const cleanup=f.results.find(r=>r.agent===supervisor&&r.name==='postman_task_close')
  if(solParent){await f.childDone(solId);assert.deepEqual(Object.keys(f.registry.get('leader').workers),[solId])}
  else {assert.equal(cleanup.result.value.status,'POSTMAN_TASK_CLOSED',JSON.stringify(cleanup.result));assert.deepEqual(Object.keys(f.registry.get('leader').workers),[])}
  for(const id of ids){
    assert.equal(supervisor.session.events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='subagent-report'&&e.data.source.senderSessionId===id).length,1)
    assert.equal(supervisor.session.events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='subagent-settled'&&e.data.source.senderSessionId===id).length,1)
  }
  console.log(JSON.stringify({scenario:'A-report/A-settled/B-active',case:scenario,deferSettlements,modelRequests:requests.length,trace:supervisor.session.events.filter(e=>e.type==='user/message'&&['subagent-report','subagent-settled'].includes(e.data.source?.kind)).map(e=>e.data.source.kind+':'+ids.indexOf(e.data.source.senderSessionId)),cleanup:solParent?'owned-children-retired':cleanup.result.value.status}))
})