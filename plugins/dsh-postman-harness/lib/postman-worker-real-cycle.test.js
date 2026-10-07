import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
