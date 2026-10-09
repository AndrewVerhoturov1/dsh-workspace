import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {capabilityRuntime, native} from './fixtures/postman-capability-runtime.js'
import {assertManagementRequest} from './fixtures/postman-stage3-contract.js'

const ptc = program => ({program, description:'Verify exact settled runtime lifecycle', boundary:'semantic_decision'})
const nested = result => {
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.status, 'ok', JSON.stringify(result.value))
  return result.value.value
}
const report = {name:'report', args:{output:'Verified completed finite task and exact child retirement. '.repeat(1000)}}
const fixture = async (t, options) => {
  const dir = await mkdtemp(join(tmpdir(), 'postman-runtime-regression-'))
  const f = await capabilityRuntime(dir, options)
  t.after(async () => { await f.dispose(); await rm(dir, {recursive:true, force:true, maxRetries:5, retryDelay:100}) })
  await f.prepare(); await f.turn(f.leader)
  f.call = async (name, args={}) => nested(await f.execute(f.leader, 'ptc_execute', ptc('return await tools.'+name+'('+JSON.stringify(args)+')')))
  return f
}

for (const resident of [false, true]) test('installed native runtime compact settled '+(resident?'resident':'cold-continuable')+' Sol preserves Session and continuation', {timeout:30000}, async t => {
  let f, solId
  const dispatchEnd = Promise.withResolvers(), ownGate = Promise.withResolvers()
  t.after(() => ownGate.resolve())
  const steps = new WeakMap()
  f = await fixture(t, {plan:async a => {
    if (a.id === 'leader') return null
    if (a.options.model !== 'gpt-6.1-sol') { await ownGate.promise; return report }
    solId = a.id
    const n = steps.get(a) ?? 0; steps.set(a, n+1)
    if (n === 0) return {name:'ptc_execute',args:{...ptc('return await tools.postman_worker({task:"Finite exact lifecycle evidence"})'),boundary:'external_event'}}
    if (n === 1) {
      const own = f.results.findLast(r=>r.agent===a && r.name==='postman_worker').result.value.workerSessionId
      await f.childDone(own)
      return {name:'ptc_execute',args:ptc('return await tools.postman_worker_stop('+JSON.stringify({workerSessionId:own,mode:'close'})+')')}
    }
    return report
  }})
  f.ctx.on('session/event', (session, event) => {
    if (session.id === solId && event.type === 'turn/end' && event.data.turn === 1) dispatchEnd.resolve()
  })
  const first = await f.call('postman_sol_worker', {task:'Approved substantial runtime regression: bounded own Worker, retire, report'})
  assert.equal(first.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  await dispatchEnd.promise
  assert.equal((await f.call('postman_worker_compact',{workerSessionId:first.workerSessionId})).status,
    'POSTMAN_WORKER_COMPACT_BUSY', 'an idle event-waiting Sol with active owned work is not terminal')
  ownGate.resolve()
  const id = first.workerSessionId, original = await f.childDone(id)
  assert.deepEqual(original.session.events.filter(e=>e.type==='turn/start').map(e=>e.data.turn), [1,2])
  assert.equal(f.results.filter(r=>r.agent.id===id && r.name==='report').length, 1, 'one terminal report across native event-wait turns')
  await f.turn(f.leader, 'Consume exact Sol report after own Worker retirement')
  const state = (await f.call('postman_worker_list')).workers.find(w=>w.workerSessionId===id)
  assert.equal(state.binding,'ready'); assert.equal(state.delivery,'none')
  assert.equal(state.runtime,'cold-continuable'); assert.equal(state.turn,'settled'); assert.equal(state.report,'delivered')
  const binding = structuredClone(f.registry.get('leader').workers[id])
  const before = await f.ctx.sessionPersistence.inspect(id)
  let handle
  if (resident) {
    const {applyChildComposition} = await native('dsh-subagent')
    handle = await f.ctx.agents.resume({resumeSessionId:id, agentOptions:{provider:'codex',model:'gpt-6.1-sol'},
      setup:childCtx=>applyChildComposition(childCtx,f.leader,{persona:'Exact resident Sol maintenance',toolFilter:{deny:[]}})})
    assert.equal(handle.agent.ctx.get('compaction'), undefined, 'real preset isolates compaction')
    assert.ok(f.ctx.agentPresets.serviceFor(handle.agent,'compaction'))
  }
  try {
    const compact = await f.call('postman_worker_compact',{workerSessionId:id})
    assert.deepEqual(compact,{status:'POSTMAN_WORKER_COMPACTED',workerSessionId:id,compacted:true,sameSession:true})
    assert.deepEqual(f.registry.get('leader').workers[id], binding)
    const after = await f.ctx.sessionPersistence.inspect(id)
    assert.equal(after.meta.id, before.meta.id); assert.equal(after.meta.parentSession, before.meta.parentSession)
    assert.ok(after.events.some(e=>e.type==='compaction/summary'))
    assert.equal(after.events.filter(e=>e.type==='turn/start').length, before.events.filter(e=>e.type==='turn/start').length)
    assert.ok(f.requests.some(r=>r.compaction && r.request.sessionId===id), 'actual installed native summarizer executed')
  } finally { await handle?.dispose() }
  const next = await f.call('postman_sol_worker',{workerSessionId:id,task:'Continue same approved substantial assignment after compact'})
  assert.equal(next.status,'POSTMAN_WORKER_TASK_ACCEPTED'); assert.equal(next.workerSessionId,id)
  const continued = await f.childDone(id)
  assert.equal(continued.id,original.id)
  const request = f.requests.filter(r=>r.agent.id===id && !r.compaction).at(-1).request
  assertManagementRequest('sol',request)
  assert.match(JSON.stringify(request.messages),/retain same Session authority/)
})

test('installed compact primitive and Host reject active/pending Sol and stale parent authority', {timeout:30000}, async t => {
  const gate=Promise.withResolvers(), entered=Promise.withResolvers()
  t.after(()=>gate.resolve())
  const f=await fixture(t,{plan:async a=>{if(a.id==='leader')return null;entered.resolve(a);await gate.promise;return report}})
  const first=await f.call('postman_sol_worker',{task:'Active exact Sol fixture'})
  const sol=await entered.promise, id=first.workerSessionId
  const queued=await f.call('postman_sol_worker',{workerSessionId:id,task:'Queued exact subsequent assignment'})
  assert.equal(queued.status,'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal((await f.call('postman_worker_compact',{workerSessionId:id})).status,'POSTMAN_WORKER_COMPACT_BUSY')
  let checked=false
  assert.equal(await f.ctx.subagents.compactContinuableChild(f.leader,id,()=>{checked=true;return true},new AbortController().signal),false)
  assert.equal(checked,false)
  await assert.rejects(f.ctx.subagents.compactContinuableChild({...f.leader},id,()=>true,new AbortController().signal),e=>e.code==='UNAUTHORIZED')
  gate.resolve(); await f.childDone(id)
  for(const state of ['stopping','uncertain']) {
    await f.contexts.changeRecord('leader',row=>({...row,workers:{...row.workers,[id]:{...row.workers[id],state}}}))
    assert.equal((await f.call('postman_worker_compact',{workerSessionId:id})).status,'POSTMAN_WORKER_COMPACT_BUSY')
  }
})

test('initial and fresh actual Sol PTC pwsh retain Host environment, authority and clean visible history', {timeout:30000, skip:process.platform!=='win32'}, async t => {
  let f
  const seen=new WeakSet(), paths=[]
  f=await fixture(t,{plan:(a,request)=>{
    if(a.id==='leader')return null
    assertManagementRequest('sol',request)
    assert.match(request.system,/Windows paths inside program source are JavaScript strings/)
    if(seen.has(a))return report
    seen.add(a)
    const prompt=request.messages.flatMap(m=>m.content).find(b=>b.type==='text' && b.text.includes('Use the existing task branch'))?.text
    const workdir=prompt.match(/ and worktree (.+?) for repository changes/)[1]
    assert.ok(!workdir.includes('\\'));paths.push(workdir)
    // Exactly the model-shaped literal that failed live, now using the Host's portable path.
    return {name:'ptc_execute',args:ptc("return await tools.pwsh({command:'$PSVersionTable.PSVersion.ToString(); (Get-Process -Id $PID).Path; (Get-Location).Path',description:'Read PowerShell version and execution environment',workdir:'"+workdir+"'})")}
  }})
  const canary='SOL_OLD_VISIBLE_CANARY_7b93'
  const first=await f.call('postman_sol_worker',{task:'Initial shell acceptance '+canary})
  const a=await f.childDone(first.workerSessionId)
  await f.turn(f.leader,'Consume initial shell report')
  const oldAudit=await f.ctx.sessionPersistence.inspect(a.id)
  const fresh=await f.call('postman_worker_fresh',{workerSessionId:a.id,task:'Fresh same allowed shell acceptance'})
  assert.equal(fresh.status,'POSTMAN_WORKER_TASK_ACCEPTED');assert.equal(fresh.fresh,true)
  const b=await f.childDone(fresh.workerSessionId)
  assert.notEqual(a.id,b.id);assert.equal(b.session.header.parentSession,a.session.header.parentSession)
  assert.equal(b.session.header.cwd,a.session.header.cwd)
  assert.equal(paths.length,2);assert.equal(paths[0],paths[1])
  const oldRequest=f.requests.find(r=>r.agent.id===a.id).request, newRequest=f.requests.find(r=>r.agent.id===b.id).request
  assert.ok(JSON.stringify(oldRequest).includes(canary));assert.ok(!JSON.stringify(newRequest).includes(canary))
  assert.deepEqual(newRequest.tools.map(t=>t.name).sort(),oldRequest.tools.map(t=>t.name).sort())
  assert.equal(newRequest.model,oldRequest.model);assert.equal(newRequest.reasoningEffort,oldRequest.reasoningEffort)
  const executionOutputs=[]
  for(const id of [a.id,b.id]) {
    const runs=f.results.filter(r=>r.agent.id===id && r.name==='ptc_execute')
    assert.equal(runs.length,1)
    const shell=nested(runs[0].result)
    assert.equal(shell.exitCode,0);assert.match(shell.stdout.text,/^[0-9]+\.[0-9]+\.[0-9]+/)
    executionOutputs.push(shell.stdout.text)
  }
  assert.equal(executionOutputs[0],executionOutputs[1], "same actual PowerShell version/executable/cwd")
  const preserved=await f.ctx.sessionPersistence.inspect(a.id)
  assert.deepEqual(preserved.events.slice(0,oldAudit.events.length),oldAudit.events)
  assert.ok(preserved.events.some(e=>e.type==='subagent/closed'))
  const current=f.registry.get('leader').workers[b.id]
  assert.equal(current.workerType,'sol');assert.equal(current.ownerSessionId,'leader')
})
