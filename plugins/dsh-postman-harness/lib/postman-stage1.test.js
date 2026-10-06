import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {stage1Runtime} from './fixtures/postman-stage1-runtime.js'
import {postmanRoleInstruction,POSTMAN_WORKER_AGENT_OPTIONS,FAST_WORKER_BUDGET} from './postman-worker.js'
const fixture=async(t,opts)=>{const dir=await mkdtemp(join(tmpdir(),'postman-stage1-'));const f=await stage1Runtime(dir,opts);t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})});return {...f,dir}}
const accepted=r=>{assert.equal(r.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(r));return r.workerSessionId}
for(const type of ['luna','secretary','sol']) test(type+' actual model instructions at initial, continuation, replacement and cold activation',{timeout:15000},async t=>{
  const f=await fixture(t,{plan:(a,_r,n)=>{
    if(n===2){const e=a.session.events.find(e=>e.surfaceOp && e.type!=='tool/result');assert.ok(e);a.session.append('user/message',{id:'compact-summary',role:'user',source:{kind:'user',form:'direct'},content:[{type:'text',text:'Compacted facts'}]}, {surfaceOp:{op:'replace',start:e.seq,end:e.seq},sourceEventSeqs:[e.seq]})}
    return {name:'report',args:{output:'bounded facts checked'}}
  }}),tool=type==='luna'?f.worker.taskTool:type==='sol'?f.worker.solTaskTool:f.worker.secretaryTool
  const id=accepted(await f.run(tool,{task:'Scope: exact fixture. Done: report facts. Check: routine fixture. Stop: report or blocker.'}))
  const original=await f.settled(id)
  for(let round=0;round<3;round++){

    accepted(await f.run(tool,{task:'Already verified: fixture. Remaining: bounded facts; stop report.',workerSessionId:id}));await f.settled(id)
  }
  const requests=f.requests.filter(x=>x.agent.id===id)
  assert.ok(requests.length>=4)
  for(const {request} of requests){
    assert.ok(request.system.includes(postmanRoleInstruction(type)), 'full canonical role text in actual system request')
    assert.equal(request.system.includes('# Postman PTC programming discipline'),false)
    assert.equal(request.tools.some(x=>x.name==='ptc_execute'),false)
    assert.equal(request.model,type==='sol'?'gpt-6.1-sol':POSTMAN_WORKER_AGENT_OPTIONS.model)
    assert.equal(request.reasoningEffort,type==='sol'?'xhigh':'low')
    const names=request.tools.map(x=>x.name)
    for(const name of ['subagent','subagent_fork','workflow','ralph','postman_bridge','postman_sol_worker'])assert.ok(!names.includes(name),name)
    assert.equal(names.includes('postman_worker'),type==='sol')
    assert.equal(names.includes('postman_secretary_ledger'),type==='secretary')
    if(type==='secretary'){assert.ok(!names.includes('mcp__playwright__browser_snapshot'));assert.ok(!names.includes('implementation_artifact_apply'))}
  }
  assert.ok(f.specs[0].request.persona.includes('Host-injected canonical role skill'))
  assert.ok(original.session.events.length,'audit remains')
})
test('one Worker entity: parallel owner quotas, exact reports, no cross-parent control',{timeout:15000},async t=>{
  const solGate=Promise.withResolvers(),entered=Promise.withResolvers()
  const f=await fixture(t,{plan:async(agent,_r,n,w)=>{if(w.roleOf(agent)==='sol'){entered.resolve();await solGate.promise;return null}return {name:'report',args:{output:'Worker evidence'}}}})
  const solId=accepted(await f.run(f.worker.solTaskTool,{task:'approved Sol route'}));await entered.promise
  const parent=f.ctx.agents.get(solId)
  t.after(()=>solGate.resolve())
  const left=await Promise.all([1,2].map(n=>f.run(f.worker.taskTool,{task:'Leader mechanical '+n,createNew:true})))
  const right=await Promise.all([1,2].map(n=>f.run(f.worker.taskTool,{task:'Sol mechanical '+n,createNew:true},parent)))
  for(const r of [...left,...right]){accepted(r);await f.settled(r.workerSessionId)}
  assert.equal((await f.run(f.worker.taskTool,{task:'third',createNew:true})).status,'POSTMAN_WORKER_LIMIT_REACHED')
  assert.equal((await f.run(f.worker.taskTool,{task:'third',createNew:true},parent)).status,'POSTMAN_WORKER_LIMIT_REACHED')
  assert.equal((await f.run(f.worker.secretaryTool,{task:'illegal'},parent)).status,'POSTMAN_WORKER_CALLER_REJECTED')
  for(const [actor,id] of [[f.leader,right[0].workerSessionId],[parent,left[0].workerSessionId]])for(const tool of [f.worker.taskTool,f.worker.interruptTool,f.worker.stopTool,f.worker.compactTool,f.worker.freshTool])
    assert.equal((await f.run(tool,{task:'foreign',workerSessionId:id},actor)).status,'POSTMAN_WORKER_TARGET_UNKNOWN')
  for(const r of right){const request=f.requests.find(x=>x.agent.id===r.workerSessionId).request;const l=f.requests.find(x=>x.agent.id===left[0].workerSessionId).request
    assert.equal(request.system,l.system);assert.deepEqual(request.tools.map(x=>x.name),l.tools.map(x=>x.name));assert.equal(request.reasoningEffort,l.reasoningEffort)
    assert.equal(f.registry.get('leader').workers[r.workerSessionId].ownerSessionId,parent.id)
    assert.ok(parent.inbox.nextStep.some(e=>e.source?.senderSessionId===r.workerSessionId))
    assert.ok(!f.leader.session.events.some(e=>e.type==='user/message'&&e.data.source?.senderSessionId===r.workerSessionId))
  }
  assert.equal((await f.run(f.worker.listTool,{},parent)).workers.length,2)
  assert.equal((await f.run(f.worker.listTool)).workers.length,3)
  solGate.resolve();await f.settled(solId)
})
test('Secretary singleton private ledger clean worktree and fresh durable survival',{timeout:15000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'postman-ledger-')), repo=join(dir,'repo')
  execFileSync('git',['init',repo])
  const {mkdir}=await import('node:fs/promises');await mkdir(join(dir,'sessions'),{recursive:true})
  const f=await stage1Runtime(dir,{plan:(a,_r,n,w)=>w.roleOf(a)==='secretary' && n===1?{name:'postman_secretary_ledger',args:{content:'Goal exact facts; PASS fixture inputs A; next report',revision:0}}:{name:'report',args:{output:'Ledger facts updated; no repository write'}}})
  t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  const before=execFileSync('git',['-C',repo,'status','--porcelain']).toString()
  const id=accepted(await f.run(f.worker.secretaryTool,{task:'Facts and ledger only'}));await f.settled(id)
  assert.equal((await f.run(f.worker.secretaryTool,{task:'second',createNew:true})).status,'POSTMAN_SECRETARY_LIMIT_REACHED')
  const ledger=await f.run(f.worker.ledgerTool);assert.equal(ledger.ledger.revision,1)
  assert.equal(execFileSync('git',['-C',repo,'status','--porcelain']).toString(),before)
  assert.ok(!f.calls.some(x=>['write','edit','pwsh'].includes(x.name)))
  await f.wake(f.leader)
  const fresh=await f.run(f.worker.freshTool,{task:'new bounded facts',workerSessionId:id})
  const next=accepted(fresh);assert.notEqual(next,id);await f.settled(next)
  assert.equal((await f.run(f.worker.ledgerTool)).ledger.content,ledger.ledger.content)
  assert.ok(f.registry.get('leader').retiredWorkers.some(x=>x.id===id))
  const old=await f.ctx.sessionPersistence.inspect(id);assert.ok(old.events.some(e=>e.type==='tool/call'))
  const spec=f.specs.find(s=>s.childId===next);assert.equal(spec.request.seed,undefined)
  const request=f.requests.find(x=>x.agent.id===next).request
  assert.ok(request.system.includes(ledger.ledger.content))
  assert.ok(!request.messages.some(m=>JSON.stringify(m).includes('Facts and ledger only')))
})

for(const type of ['luna','secretary']) test(type+' Host budget warning hard denial and new assignment reset',{timeout:15000},async t=>{
  const f=await fixture(t,{fastBudget:{softLimit:2,hardLimit:3},plan:()=>({name:'read',args:{}})})
  const tool=type==='luna'?f.worker.taskTool:f.worker.secretaryTool
  const id=accepted(await f.run(tool,{task:'Exact task; stop blocker if budget exhausted'}));const child=await f.settled(id)
  const req=f.requests.filter(x=>x.agent.id===id)
  assert.equal(req.length,3)
  assert.ok(req[1].request.system.includes('SOFT WARNING'))
  assert.ok(req[2].request.system.includes('HARD CEILING'))
  const budget=f.registry.get('leader').workers[id].budget
  assert.equal(budget.used,3);assert.equal(budget.exhausted,true)
  assert.equal(budget.notified,true);assert.equal(budget.reported,true)
  assert.ok(child.session.events.some(e=>e.type==='tool/result' && e.data.message.content[0].isError))
  await f.wake(f.leader)
  const delivered=f.leader.session.events.filter(e=>e.type==='user/message'&&e.data.source?.senderSessionId===id)
  assert.equal(delivered.filter(e=>e.data.content[0].text.startsWith('Background subagent '+id+':')).length,1)
  assert.equal(delivered.filter(e=>e.data.content[0].text.startsWith('Background subagent '+id+' reported:')).length,1)
  const next=await f.run(tool,{task:'New precise bounded assignment',workerSessionId:id});accepted(next);await f.settled(id)
  const b=f.registry.get('leader').workers[id].budget
  assert.notEqual(b.assignmentId,budget.assignmentId);assert.equal(b.used,3)
  await f.wake(f.leader)
  const fresh=await f.run(f.worker.freshTool,{workerSessionId:id,task:'Precise facts after settled exhaustion'})
  const freshId=accepted(fresh);assert.notEqual(freshId,id);await f.settled(freshId)
  assert.equal(f.registry.get('leader').retiredWorkers.at(-1).budget.exhausted,true)
})
test('all child roles force native tools even when Host default is code',{timeout:15000},async t=>{
  const f=await fixture(t,{toolMode:'code'})
  for(const tool of [f.worker.taskTool,f.worker.secretaryTool,f.worker.solTaskTool]){
    const id=accepted(await f.run(tool,{task:'direct finite facts'}));await f.settled(id)
    accepted(await f.run(tool,{workerSessionId:id,task:'next finite cold direct facts'}));await f.settled(id)
    for(const {request} of f.requests.filter(x=>x.agent.id===id)){
      assert.ok(request.tools.some(x=>x.name==='read'))
      assert.ok(!request.tools.some(x=>['run_code','ptc_execute'].includes(x.name)))
    }
  }
})
test('queued followup does not reset a running assignment budget before FIFO claim',{timeout:15000},async t=>{
  const gate=Promise.withResolvers(),entered=Promise.withResolvers()
  const f=await fixture(t,{fastBudget:{softLimit:2,hardLimit:3},plan:async(_a,_r,n)=>{if(n===1){entered.resolve();await gate.promise}return {name:'report',args:{output:'exact finite facts'}}}})
  const id=accepted(await f.run(f.worker.taskTool,{task:'initial bounded facts'}));await entered.promise
  const old=f.registry.get('leader').workers[id].budget
  accepted(await f.run(f.worker.taskTool,{task:'bounded next FIFO task',workerSessionId:id}))
  assert.deepEqual(f.registry.get('leader').workers[id].budget,old)
  assert.equal(Object.keys(f.registry.get('leader').workers[id].pendingBudgets).length,1)
  gate.resolve();await f.settled(id)
  const budget=f.registry.get('leader').workers[id].budget
  assert.notEqual(budget.assignmentId,old.assignmentId);assert.equal(budget.used,1);assert.equal(budget.reported,true)
  assert.equal(Object.keys(f.registry.get('leader').workers[id].pendingBudgets).length,0)
})
test('default FAST 12/15 budget cannot silently finish without escalation report',{timeout:15000},async t=>{
  const f=await fixture(t,{plan:(_a,_r,n)=>n<15?{name:'read',args:{}}:{text:'ignored hard report instruction'}})
  const id=accepted(await f.run(f.worker.taskTool,{task:'Exact default-budget finite check'}));const child=await f.settled(id)
  assert.equal(f.requests.length,15)
  assert.ok(f.requests[11].request.system.includes('SOFT WARNING'))
  assert.ok(f.requests[14].request.system.includes('HARD CEILING'))
  const b=f.registry.get('leader').workers[id].budget;assert.equal(b.used,15);assert.equal(b.notified,true);assert.equal(b.reported,true)
  assert.equal(child.session.events.filter(e=>e.type==='tool/call'&&e.data.name==='report').length,0)
  await f.wake(f.leader)
  const reports=f.leader.session.events.filter(e=>e.type==='user/message'&&e.data.source?.senderSessionId===id)
  assert.equal(reports.filter(e=>e.data.content[0].text.includes(' reported:')).length,1)
})
test('stock manual compact retains exact role Session budget quota and audit',{timeout:15000},async t=>{
  const native=async name=>import(pathToFileURL(join(process.env.DSH_ROOT??join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh'),'node_modules/@deepseek-ai',name,'lib/index.js')).href)
  const {BasicCompactionEngine}=await native('dsh-compaction-basic'),{TokenMeter}=await native('dsh-token-meter')
  const f=await fixture(t,{plan:()=>({name:'report',args:{output:'verified evidence '.repeat(1000)}}),setupTools:ctx=>{new TokenMeter(ctx);const Summarizer=class extends BasicCompactionEngine{async summarize(){return {summary:[{type:'text',text:'summary of exact finite facts; next bounded assignment'}],provider:'codex',model:'gpt-6-luna'}}};new Summarizer(ctx,{auto:false})}})
  for(const tool of [f.worker.taskTool,f.worker.secretaryTool,f.worker.solTaskTool]){
    const id=accepted(await f.run(tool,{task:'bounded facts '+('verified evidence '.repeat(1000))}));await f.settled(id)
    const handle=await f.ctx.agents.resume({resumeSessionId:id,agentOptions:{provider:'codex',model:tool===f.worker.solTaskTool?'gpt-6.1-sol':'gpt-6-luna'}}),resident=handle.agent
    const binding=f.registry.get('leader').workers[id],events=resident.session.events.length
    const compacted=await f.run(f.worker.compactTool,{workerSessionId:id})
    assert.equal(compacted.status,'POSTMAN_WORKER_COMPACTED',JSON.stringify(compacted));assert.equal(compacted.sameSession,true)
    assert.equal(f.ctx.agents.get(id),resident);assert.deepEqual(f.registry.get('leader').workers[id],binding)
    assert.ok(resident.session.events.length>events);assert.ok(resident.session.surface.replaceGeneration>0)
    await handle.dispose()
    accepted(await f.run(tool,{workerSessionId:id,task:'bounded next facts'}));await f.settled(id)
    assert.ok(f.requests.findLast(x=>x.agent.id===id).request.system.includes(postmanRoleInstruction(binding.workerType)))
  }
})
test('canonical TASK_CONTRACT and Sol mandatory delegation instructions',()=>{
  for(const type of ['luna','secretary','sol']){const s=postmanRoleInstruction(type);for(const word of ['TASK_CONTRACT','scope','done conditions','verification','stop condition','blocker'])assert.ok(s.includes(word),type+' '+word)}
  const sol=postmanRoleInstruction('sol');for(const word of ['двух','ОБЯЗАН','параллельно','engineering decisions','агрегированный report'])assert.ok(sol.includes(word),word)
  assert.deepEqual(FAST_WORKER_BUDGET,{softLimit:12,hardLimit:15})
})
