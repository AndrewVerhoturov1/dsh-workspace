import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stage1Runtime, stage1Native } from './fixtures/postman-stage1-runtime.js'
const fixture=async(t,opts={})=>{
  const dir=await mkdtemp(join(tmpdir(),'postman-assignment-budget-'))
  const f=await stage1Runtime(dir,opts)
  t.after(async()=>{await f.dispose();await f.registry.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  return {...f,dir}
}
const accepted=r=>{assert.equal(r.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(r));return r.workerSessionId}

test('Worker hardBudget 8 stops at its own limit; FAST schemas expose only assignment budget',{timeout:20000},async t=>{
  const f=await fixture(t,{plan:()=>({name:'read',args:{}})})
  for(const tool of [f.worker.taskTool,f.worker.secretaryTool,f.worker.interruptTool,f.worker.freshTool]){
    assert.ok(tool.parameters.properties.hardBudget)
    assert.equal(Object.hasOwn(tool.parameters.properties,'rootObjectiveId'),false)
    assert.equal(Object.hasOwn(tool.parameters.properties,'newObjective'),false)
  }
  assert.equal(Object.hasOwn(f.worker.solTaskTool.parameters.properties,'hardBudget'),false)
  assert.equal((await f.run(f.worker.solTaskTool,{task:'Sol has no FAST budget',hardBudget:8})).status,'POSTMAN_WORKER_BUDGET_INVALID')
  for(const hardBudget of [7,61,8.5])
    assert.equal((await f.run(f.worker.taskTool,{task:'invalid budget',hardBudget})).status,'POSTMAN_WORKER_BUDGET_INVALID')
  assert.equal((await f.run(f.worker.taskTool,{task:'no parent soft limit',hardBudget:8,softLimit:1})).status,'POSTMAN_WORKER_BUDGET_INVALID')
  const id=accepted(await f.run(f.worker.taskTool,{task:'Exact bounded check',hardBudget:8}))
  const child=await f.settled(id),requests=f.requests.filter(r=>r.agent.id===id)
  assert.equal(requests.length,8)
  assert.ok(requests[5].request.system.includes('SOFT WARNING'))
  assert.ok(requests[7].request.system.includes('HARD CEILING'))
  const budget=f.registry.get('leader').workers[id].budget
  assert.equal(budget.hardLimit,8);assert.equal(budget.softLimit,6);assert.equal(budget.used,8)
  assert.equal(budget.exhausted,true);assert.equal(budget.notified,true);assert.equal(budget.reported,true)
  assert.ok(child.session.events.some(e=>e.type==='tool/result' && e.data.message.content[0].isError))
  await f.wake(f.leader)
  const text=JSON.stringify(f.leader.session.events)
  assert.ok(text.includes('FAST assignment budget exhausted (8/8)'))
  assert.doesNotMatch(text,/root exhausted|root cumulative/);assert.ok(!text.includes('/48'))
  const second=accepted(await f.run(f.worker.taskTool,{task:'Second Worker full allowance',createNew:true,hardBudget:24}))
  await f.settled(second)
  assert.notEqual(second,id)
  assert.equal(f.registry.get('leader').workers[second].budget.hardLimit,24)
  assert.equal(f.registry.get('leader').workers[second].budget.used,24)
  assert.deepEqual(f.registry.get('leader').workers[id].budget,budget)
})

test('Secretary, two Leader Workers and two Sol-owned Workers have independent normal 60-request budgets',{timeout:20000},async t=>{
  const solGate=Promise.withResolvers(),solEntered=Promise.withResolvers(),gates=new Map()
  t.after(()=>{solGate.resolve();for(const gate of gates.values())gate.release.resolve()})
  const f=await fixture(t,{plan:async(a,_r,n,w)=>{
    if(w.roleOf(a)==='sol'){solEntered.resolve(a);await solGate.promise;return {name:'report',args:{output:'Sol aggregated bounded evidence'}}}
    const budget=f.registry.get('leader').workers[a.id].budget
    if(n===1){const gate=gates.get(budget.task);gate.entered.resolve();await gate.release.promise}
    return budget.exhausted?{name:'report',args:{output:'NEEDS_PARENT_GUIDANCE: own assignment limit; verified reads; need parent decision, not success'}}:{name:'read',args:{}}
  }})
  const solId=accepted(await f.run(f.worker.solTaskTool,{task:'Approved Sol route'})),sol=await solEntered.promise
  const assignments=[['Secretary',f.worker.secretaryTool,f.leader],['Leader A',f.worker.taskTool,f.leader],['Leader B',f.worker.taskTool,f.leader],['Sol A',f.worker.taskTool,sol],['Sol B',f.worker.taskTool,sol]]
  const ids=[]
  for(const [task,tool,parent] of assignments){
    const gate={entered:Promise.withResolvers(),release:Promise.withResolvers()};gates.set(task,gate)
    ids.push(accepted(await f.run(tool,{task,createNew:true},parent)));await gate.entered.promise
  }
  for(let i=0;i<ids.length;i++){
    const peers=ids.filter(id=>id!==ids[i]).map(id=>[id,f.registry.get('leader').workers[id].budget])
    gates.get(assignments[i][0]).release.resolve();await f.settled(ids[i])
    const budget=f.registry.get('leader').workers[ids[i]].budget
    assert.equal(budget.hardLimit,60);assert.equal(budget.softLimit,48);assert.equal(budget.used,60);assert.equal(budget.exhausted,true)
    for(const [id,before] of peers)assert.deepEqual(f.registry.get('leader').workers[id].budget,before)
    assert.equal(f.requests.filter(r=>r.agent.id===ids[i]).length,60)
  }
  assert.equal(ids.reduce((sum,id)=>sum+f.registry.get('leader').workers[id].budget.used,0),300)
  assert.equal(Object.hasOwn(f.registry.get('leader'),'objectives'),false)
  const list=await f.run(f.worker.listTool)
  assert.equal(Object.hasOwn(list,'objectives'),false)
  for(const row of list.workers.filter(w=>w.workerType!=='sol'))assert.equal(Object.hasOwn(row.budget,'root'),false)
  assert.deepEqual(f.worker.teamSnapshot(f.leader).secretary.budget,{used:60,soft:48,hard:60,exhausted:true})
  solGate.resolve();await f.settled(solId)
})

test('existing storage drops obsolete team fields and preserves current and pending assignment budgets',{timeout:20000},async t=>{
  const f=await fixture(t)
  const id=accepted(await f.run(f.worker.taskTool,{task:'Bounded facts',hardBudget:15}));await f.settled(id);await f.wake(f.leader)
  const budget=f.registry.get('leader').workers[id].budget
  const obsolete={...budget,rootObjectiveId:'old',exhausted:true}
  await f.registry.change('leader',row=>({...row,objectives:{old:{id:'old',ownerSessionId:'leader',objective:'old',used:48,cap:48}},
    workers:{...row.workers,[id]:{...row.workers[id],budget:obsolete,pendingBudgets:{pending:obsolete}}},
    retiredWorkers:[{...row.workers[id],id:'retired',budget:obsolete}]}))
  await f.dispose();await f.registry.close()
  const { JsonStorageBackend }=await stage1Native('dsh-storage-json')
  const { DomainFacility }=await stage1Native('dsh-storage-domain')
  const { openPostmanTaskRegistry }=await import('./postman-task-registry.js')
  const backend=new JsonStorageBackend(join(f.dir,'tasks'))
  const registry=await openPostmanTaskRegistry(new DomainFacility({storage:{backend:{get:()=>backend}},emit(){}},{backend:'json'}))
  t.after(async()=>{await registry.close();await backend.close()})
  const row=registry.get('leader')
  assert.equal(Object.hasOwn(row,'objectives'),false)
  assert.deepEqual(row.workers[id].budget,budget)
  assert.deepEqual(row.workers[id].pendingBudgets.pending,budget)
  assert.deepEqual(row.retiredWorkers[0].budget,budget)
  assert.equal(row.runner.state,'none');assert.equal(row.workers[id].ownerSessionId,'leader')
})
