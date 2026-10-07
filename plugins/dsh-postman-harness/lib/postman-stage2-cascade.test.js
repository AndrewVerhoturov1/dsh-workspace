import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { capabilityRuntime } = await import('./fixtures/postman-capability-runtime.js')

const report = { name: 'report', args: { output: 'Verified bounded native cascade evidence' } }
const call = async (f, name, args) => {
  const result = await f.execute(f.leader, 'ptc_execute', { program: 'return await tools.' + name + '(' + JSON.stringify(args) + ')', description: 'Verify exact subtree lifecycle', boundary: 'semantic_decision' })
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.value.status, 'ok', JSON.stringify(result.value))
  return result.value.value
}
async function fixture(t, { active = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'stage2-cascade-'))
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(); let f, sol, step = 0
  const plan = async a => {
    if (a.id === 'leader') return null
    if (a.options.model !== 'gpt-6.1-sol') return report
    sol = a
    if (step++ < 2) return {name:'ptc_execute',args:{program:'return await tools.postman_worker({task:"bounded native child",createNew:true})',description:'Dispatch exact owned child before subtree reconciliation',boundary:'semantic_decision'}}
    const ids = Object.values(f.registry.get('leader').workers).filter(b => b.ownerSessionId === a.id).map(b => b.id)
    for (const id of ids) await f.childDone(id)
    if (active) { entered.resolve(a); await gate.promise }
    return report
  }
  f = await capabilityRuntime(dir, { preset: 'postman-leader', plan })
  t.after(async () => { gate.resolve(); await f.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }) })
  await f.prepare(); await f.turn(f.leader)
  const accepted = await call(f, 'postman_sol_worker', { task: 'Explicit user authorized Sol subtree' })
  assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED', JSON.stringify(accepted))
  if (active) await entered.promise
  else { await f.childDone(accepted.workerSessionId); await f.turn(f.leader, 'Consume exact native final subtree report') }
  assert.equal(Object.values(f.registry.get('leader').workers).filter(b => b.ownerSessionId === accepted.workerSessionId).length, 2)
  assert.equal(f.results.filter(r => r.name === 'postman_worker' && r.agent.id === accepted.workerSessionId && r.result.value?.status === 'POSTMAN_WORKER_TASK_ACCEPTED').length, 2)
  return { ...f, sol, gate, id: accepted.workerSessionId }
}

test('actual PTC cascade close settled cold Sol plus two ordinary children, no mechanical model turn', { timeout: 30000 }, async t => {
  const f = await fixture(t), before = f.requests.length
  assert.equal(f.ctx.agents.get(f.id), undefined)
  const result = await call(f, 'postman_worker_stop', { workerSessionId: f.id, mode: 'close', cascade: true })
  assert.equal(result.status, 'POSTMAN_WORKER_STOPPED', JSON.stringify(result))
  assert.equal(f.requests.length, before)
  assert.equal(f.registry.get('leader').retiredWorkers.length, 3)
  for (const b of f.registry.get('leader').retiredWorkers) {
    assert.ok(b.lifecycle.reports.length > 0)
    assert.equal((await f.ctx.sessionPersistence.inspect(b.id)).meta.delegationDepth, b.id === f.id ? 1 : 2)
  }
  assert.deepEqual(f.registry.get('leader').workers, {})
})

test('actual PTC active Sol cascade close rejects before binding mutation', { timeout: 30000 }, async t => {
  const f = await fixture(t, { active: true }), before = JSON.stringify(f.registry.get('leader').workers)
  const result = await call(f, 'postman_worker_stop', { workerSessionId: f.id, mode: 'close', cascade: true })
  assert.equal(result.status, 'POSTMAN_WORKER_CASCADE_BLOCKED', JSON.stringify(result))
  assert.equal(JSON.stringify(f.registry.get('leader').workers), before)
  f.gate.resolve(); await f.childDone(f.id)
})

test('actual PTC two RUNNING ordinary children reject close and fresh then strict cascade cancel settles children before Sol', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stage2-running-cascade-'))
  const started = Promise.withResolvers(), childrenStarted = Promise.withResolvers(), cleanup = new AbortController()
  const running = new Map(), aborted = []; let step = 0, sol, f
  const waitAbort = (id, signal) => new Promise(resolve => {
    const finish = () => { aborted.push(id); resolve(null) }
    if (signal.aborted) finish()
    else signal.addEventListener('abort', finish, { once: true })
    cleanup.signal.addEventListener('abort', () => resolve(null), { once: true })
  })
  const plan = async (a, request) => {
    if (a.id === 'leader') return null
    if (a.options.model !== 'gpt-6.1-sol') {
      assert.ok(request.signal instanceof AbortSignal)
      running.set(a.id, a)
      if (running.size === 2) childrenStarted.resolve()
      return waitAbort(a.id, request.signal)
    }
    sol = a
    if (step++ < 2) return {name:'ptc_execute',args:{program:'return await tools.postman_worker({task:"running bounded native child",createNew:true})',description:'Dispatch exact active owned child before event',boundary:'semantic_decision'}}
    await childrenStarted.promise
    assert.equal(running.size, 2)
    started.resolve()
    return waitAbort(a.id, request.signal)
  }
  f = await capabilityRuntime(dir, { preset: 'postman-leader', plan })
  t.after(async () => { cleanup.abort(); await f.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }) })
  await f.prepare(); await f.turn(f.leader)
  const accepted = await call(f, 'postman_sol_worker', { task: 'Explicit user authorized active subtree' })
  assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED', JSON.stringify(accepted))
  await started.promise
  const ids = [...running.keys()]
  for (const a of [sol, ...running.values()]) assert.equal(a.status, 'running')
  const before = JSON.stringify(f.registry.get('leader').workers), requests = f.requests.filter(r => r.agent.id !== f.leader.id).length
  const closed = await call(f, 'postman_worker_stop', { workerSessionId: sol.id, mode: 'close', cascade: true })
  assert.equal(closed.status, 'POSTMAN_WORKER_CASCADE_BLOCKED', JSON.stringify(closed))
  for (const id of ids) assert.ok(closed.blockers.some(b => b.workerSessionId === id))
  assert.equal(JSON.stringify(f.registry.get('leader').workers), before)
  const fresh = await call(f, 'postman_worker_fresh', { workerSessionId: sol.id, task: 'fresh rejects active children', retireOwnedWorkers: true })
  assert.equal(fresh.status, 'POSTMAN_WORKER_CASCADE_BLOCKED', JSON.stringify(fresh))
  for (const id of ids) assert.ok(fresh.blockers.some(b => b.workerSessionId === id))
  assert.equal(JSON.stringify(f.registry.get('leader').workers), before)
  assert.deepEqual(aborted, [])
  const cancelled = await call(f, 'postman_worker_stop', { workerSessionId: sol.id, mode: 'cancel', cascade: true })
  assert.equal(cancelled.status, 'POSTMAN_WORKER_CANCELLED', JSON.stringify(cancelled))
  assert.equal(cancelled.taskCompleted, false); assert.equal(cancelled.resultReported, false)
  assert.deepEqual(aborted, [...ids, sol.id])
  // Native cancellation notifications may wake the Leader; no child mechanical turn is permitted.
  assert.equal(f.requests.filter(r => r.agent.id !== f.leader.id).length, requests)
  const row = f.registry.get('leader')
  assert.deepEqual(row.workers, {})
  assert.deepEqual(row.retiredWorkers.map(b => b.id), [...ids, sol.id])
  for (const id of [...ids, sol.id]) {
    assert.equal(f.ctx.agents.get(id), undefined)
    const saved = await f.ctx.sessionPersistence.inspect(id)
    assert.ok(saved.events.some(e => e.type === 'subagent/closed'))
    assert.equal(saved.meta.parentSession, id === sol.id ? f.leader.id : sol.id)
  }
})

test('partial cascade failure retains intent, reconciles live Sol, retries exact remaining work', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const children = Object.values(f.registry.get('leader').workers).filter(b=>b.ownerSessionId===f.id)
  const close = f.ctx.subagents.closeContinuableChild.bind(f.ctx.subagents)
  let failed = false
  f.ctx.subagents.closeContinuableChild = async (parent,id,check) => {
    if (id === children[1].id && !failed) { failed = true; throw new Error('Injected failure after first child stop') }
    return close(parent,id,check)
  }
  const partial = await call(f,'postman_worker_stop',{workerSessionId:f.id,mode:'cancel',cascade:true})
  assert.equal(partial.status,'POSTMAN_WORKER_CASCADE_PARTIAL',JSON.stringify(partial))
  const binding = f.registry.get('leader').workers[f.id]
  assert.equal(binding.state,'uncertain'); assert.equal(binding.lifecycle.stop.mode,'cancel')
  assert.deepEqual(binding.lifecycle.stop.childIds,children.map(b=>b.id))
  assert.equal(Object.hasOwn(f.registry.get('leader').workers,children[0].id),false)
  const list = await call(f,'postman_worker_list',{})
  assert.equal(list.quota.sol.used,1); assert.equal(list.workers.find(b=>b.workerSessionId===f.id).binding,'ready')
  const stopped = await call(f,'postman_worker_stop',{workerSessionId:f.id,mode:'cancel',cascade:true})
  assert.equal(stopped.status,'POSTMAN_WORKER_CANCELLED',JSON.stringify(stopped))
  assert.equal((await call(f,'postman_worker_list',{})).quota.sol.used,0)
})

test('failed bookkeeping after native Sol closure reconciles on cold Host restart and frees slot', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const close = f.ctx.subagents.closeContinuableChild.bind(f.ctx.subagents)
  f.ctx.subagents.closeContinuableChild = async (parent,id,check) => {
    const closed = await close(parent,id,check)
    if (id===f.id) throw new Error('Interrupted after durable native closure')
    return closed
  }
  const partial = await call(f,'postman_worker_stop',{workerSessionId:f.id,mode:'cancel',cascade:true})
  assert.equal(partial.status,'POSTMAN_WORKER_CASCADE_PARTIAL',JSON.stringify(partial))
  assert.equal(f.registry.get('leader').workers[f.id].state,'uncertain')
  assert.equal(await f.ctx.subagents.inspectClosedContinuableChild(f.leader,f.id),true)
  await f.dispose()
  const g = await capabilityRuntime(f.leader.session.header.cwd,{preset:'postman-leader',resume:true})
  t.after(()=>g.dispose())
  assert.ok(['TASK_CONTEXT_READY','POSTMAN_TASK_CONTEXT_ALREADY_READY'].includes((await g.prepare()).status)); await g.turn(g.leader)
  const list = await call(g,'postman_worker_list',{})
  assert.equal(list.quota.sol.used,0); assert.deepEqual(g.registry.get('leader').workers,{})
  assert.ok(g.registry.get('leader').retiredWorkers.some(b=>b.id===f.id))
})

test('insufficient native reconciliation evidence never frees uncertain Sol slot', { timeout: 30000 }, async t => {
  const f=await fixture(t)
  await f.contexts.changeRecord('leader',row=>({...row,workers:{...row.workers,[f.id]:{...row.workers[f.id],state:'uncertain'}}}))
  f.ctx.subagents.inspectClosedContinuableChild=async()=>false
  f.ctx.subagents.inspectOpenContinuableChild=async()=>false
  const list=await call(f,'postman_worker_list',{})
  assert.equal(list.quota.sol.used,1); assert.equal(list.workers.find(b=>b.workerSessionId===f.id).binding,'uncertain')
  assert.equal((await call(f,'postman_sol_worker',{task:'New substantial Sol',createNew:true})).status,'POSTMAN_SOL_WORKER_LIMIT_REACHED')
})

test('actual PTC fresh retires settled subtree and fresh after explicit cascade cancel retains role', { timeout: 30000 }, async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(t)
    if (cancel) { const r = await call(f, 'postman_worker_stop', { workerSessionId: f.id, mode: 'cancel', cascade: true }); assert.equal(r.status, 'POSTMAN_WORKER_CANCELLED', JSON.stringify(r)); assert.equal(r.taskCompleted, false); assert.equal(r.durableSessionDeleted, false) }
    const r = await call(f, 'postman_worker_fresh', { workerSessionId: f.id, task: 'Fresh explicit authorized Sol', retireOwnedWorkers: true })
    assert.equal(r.status, 'POSTMAN_WORKER_TASK_ACCEPTED', JSON.stringify(r)); assert.notEqual(r.workerSessionId, f.id)
    assert.equal(r.workerType, 'sol'); await f.childDone(r.workerSessionId)
    await f.dispose()
  }
})
