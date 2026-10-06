import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stage1Runtime } from './fixtures/postman-stage1-runtime.js'
const fixture=async(t,opts={})=>{
  const dir=await mkdtemp(join(tmpdir(),'postman-objective-'))
  const f=await stage1Runtime(dir,opts)
  t.after(async()=>{await f.dispose();await f.registry.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  return {...f,dir}
}
const accepted=r=>{assert.equal(r.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(r));return r.workerSessionId}
for(const role of ['secretary','leader-worker','sol-worker'])test(role+' FAST bounds, Host soft warning, inherited cumulative cap 48',{timeout:20000},async t=>{
  const gate=Promise.withResolvers(),entered=Promise.withResolvers()
  t.after(()=>gate.resolve())
  const f=await fixture(t,{plan:async(a,_r,_n,w)=>{
    if(w.roleOf(a)==='sol'){entered.resolve();await gate.promise;return {name:'report',args:{output:'Sol aggregated evidence'}}}
    const budget=w.roleOf(a)!=='sol' && f.registry.get('leader').workers[a.id]?.budget
    if(role==='sol-worker' && budget?.exhausted) return {name:'report',args:{output:'NEEDS_PARENT_GUIDANCE: exact hard boundary; verified reads; need parent decision, not task success'}}
    return {name:'read',args:{}}
  }})
  let parent=f.leader,solId
  const review=async()=>{if(parent===f.leader) await f.wake(parent)}
  if(role==='sol-worker'){
    solId=accepted(await f.run(f.worker.solTaskTool,{task:'explicit approved Sol route'}));await entered.promise
    parent=f.ctx.agents.get(solId)
  }
  const tool=role==='secretary'?f.worker.secretaryTool:f.worker.taskTool
  for(const hardBudget of [7,25,8.5,NaN])if(!Number.isNaN(hardBudget)){
    assert.equal((await f.run(tool,{task:'invalid budget',hardBudget},parent)).status,'POSTMAN_WORKER_BUDGET_INVALID')
  }
  assert.equal((await f.run(tool,{task:'parent cannot choose soft',hardBudget:8,softLimit:1},parent)).status,'POSTMAN_WORKER_BUDGET_INVALID')
  assert.equal(Object.keys(f.registry.get('leader').workers).length,solId?1:0)
  const id=accepted(await f.run(tool,{task:'Unresolved exact objective',newObjective:'Exact unresolved '+role,hardBudget:24},parent))
  await f.settled(id)
  let b=f.registry.get('leader').workers[id].budget,root=b.rootObjectiveId
  assert.equal(b.hardLimit,24);assert.equal(b.softLimit,19);assert.equal(b.used,24)
  const req=f.requests.filter(r=>r.agent.id===id)
  assert.ok(req[18].request.system.includes('SOFT WARNING'));assert.ok(req[23].request.system.includes('HARD CEILING'))
  await review()
  accepted(await f.run(tool,{task:'Precise follow-up, not a new objective',workerSessionId:id,hardBudget:16},parent));await f.settled(id)
  b=f.registry.get('leader').workers[id].budget
  assert.equal(b.rootObjectiveId,root);assert.equal(b.used,16);assert.equal(f.registry.get('leader').objectives[root].used,40)
  await review()
  accepted(await f.run(tool,{task:'Same objective final allowance',workerSessionId:id,hardBudget:24},parent));await f.settled(id)
  b=f.registry.get('leader').workers[id].budget
  assert.equal(b.hardLimit,24);assert.equal(b.used,8);assert.equal(b.exhausted,true)
  assert.equal(f.registry.get('leader').objectives[root].used,48)
  const before=f.requests.length
  assert.equal((await f.run(tool,{task:'Cannot refinance',workerSessionId:id,hardBudget:24},parent)).status,'POSTMAN_ROOT_BUDGET_EXHAUSTED')
  assert.equal((await f.run(tool,{task:'Cannot relabel same objective',workerSessionId:id,newObjective:'Exact unresolved '+role},parent)).status,'POSTMAN_ROOT_BUDGET_EXHAUSTED')
  assert.equal(f.requests.length,before)
  const list=await f.run(f.worker.listTool,{},parent),entry=list.workers.find(w=>w.workerSessionId===id)
  assert.equal(entry.budget.root.used,48);assert.equal(entry.budget.root.cap,48);assert.equal(list.objectives.find(r=>r.id===root).used,48)
  if(parent===f.leader){const team=f.worker.teamSnapshot(parent);const row=role==='secretary'?team.secretary:team.workers.rows[0];assert.equal(row.budget.rootUsed,48)}
  await review()
  const fresh=await f.run(f.worker.freshTool,{workerSessionId:id,task:'Same objective fresh Session',hardBudget:8},parent)
  assert.equal(fresh.status,'POSTMAN_ROOT_BUDGET_EXHAUSTED')
  const next=accepted(await f.run(tool,{task:'Actually independent objective',newObjective:'Independent '+role,hardBudget:8,workerSessionId:id},parent))
  await f.settled(next)
  const newBudget=f.registry.get('leader').workers[next].budget
  assert.notEqual(newBudget.rootObjectiveId,root);assert.equal(newBudget.softLimit,6);assert.equal(newBudget.hardLimit,8)
  assert.equal(f.registry.get('leader').objectives[root].used,48)
  assert.equal(f.registry.get('leader').objectives[newBudget.rootObjectiveId].used,8)
  if(solId){gate.resolve();await f.settled(solId)}
})
test('root cost survives cold registry reopen and fresh child; independent objective requires explicit declaration',{timeout:20000},async t=>{
  const f=await fixture(t)
  const id=accepted(await f.run(f.worker.taskTool,{task:'bounded exact facts',newObjective:'Root A'}));await f.settled(id);await f.wake(f.leader)
  const root=f.registry.get('leader').workers[id].budget.rootObjectiveId
  await f.dispose();await f.registry.close()
  const resumed=await stage1Runtime(f.dir,{resume:true})
  t.after(async()=>{await resumed.dispose();await resumed.registry.close()})
  assert.equal(resumed.registry.get('leader').objectives[root].used,1)
  accepted(await resumed.run(resumed.worker.taskTool,{workerSessionId:id,task:'Same root after cold resume'}));await resumed.settled(id);await resumed.wake(resumed.leader)
  assert.equal(resumed.registry.get('leader').objectives[root].used,2)
  const next=accepted(await resumed.run(resumed.worker.freshTool,{workerSessionId:id,task:'Same root fresh',hardBudget:8}));await resumed.settled(next)
  assert.equal(resumed.registry.get('leader').workers[next].budget.rootObjectiveId,root)
  assert.equal(resumed.registry.get('leader').objectives[root].used,3)
  accepted(await resumed.run(resumed.worker.secretaryTool,{task:'Independent facts',newObjective:'Root B'}))
  const before=resumed.specs.length
  assert.equal((await resumed.run(resumed.worker.taskTool,{task:'ambiguous new child',createNew:true})).status,'POSTMAN_ROOT_OBJECTIVE_REQUIRED')
  assert.equal(resumed.specs.length,before)
  assert.equal((await resumed.run(resumed.worker.taskTool,{task:'foreign root',workerSessionId:next,rootObjectiveId:'foreign'})).status,'POSTMAN_ROOT_OBJECTIVE_REJECTED')
})
test('concurrent Secretary and Worker share one root without lost costs or exceeding cap',{timeout:15000},async t=>{
  const f=await fixture(t,{plan:()=>({name:'read',args:{}})})
  const ids=await Promise.all([f.worker.secretaryTool,f.worker.taskTool].map(tool=>f.run(tool,{task:'same unresolved objective',newObjective:'Shared root',hardBudget:24}).then(accepted)))
  await Promise.all(ids.map(id=>f.settled(id)))
  const roots=Object.values(f.registry.get('leader').objectives)
  assert.equal(roots.length,1);assert.equal(roots[0].used,48)
  assert.equal(ids.reduce((sum,id)=>sum+f.registry.get('leader').workers[id].budget.used,0),48)
  assert.equal(f.requests.length,48)
})
test('shared root remaining allowance beats assignment hard limits across concurrent children',{timeout:15000},async t=>{
  const f=await fixture(t,{plan:()=>({name:'read',args:{}})})
  await f.registry.change('leader',row=>({...row,objectives:{shared:{id:'shared',ownerSessionId:'leader',objective:'Unresolved near cap',used:46,cap:48}}}))
  const ids=await Promise.all([f.worker.taskTool,f.worker.secretaryTool].map(tool=>f.run(tool,{task:'same root limited remainder',rootObjectiveId:'shared',hardBudget:24}).then(accepted)))
  await Promise.all(ids.map(id=>f.settled(id)))
  assert.equal(f.registry.get('leader').objectives.shared.used,48)
  assert.equal(f.requests.length,2)
  assert.equal(ids.reduce((sum,id)=>sum+f.registry.get('leader').workers[id].budget.used,0),2)
  const before=JSON.stringify(f.registry.get('leader'))
  assert.equal((await f.run(f.worker.taskTool,{task:'no new child refinancing',createNew:true})).status,'POSTMAN_ROOT_BUDGET_EXHAUSTED')
  assert.equal(JSON.stringify(f.registry.get('leader')),before)
})

