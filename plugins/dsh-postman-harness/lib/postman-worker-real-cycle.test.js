import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capabilityRuntime } from './fixtures/postman-capability-runtime.js'

const ptc = (program, wait = false) => ({ name: 'ptc_execute', args: { program, ...(wait ? { wait_for_event: true } : {}) } })
const value = result => { assert.equal(result.isError, false, JSON.stringify(result)); return result.value.value }
const exists = async file => { try { await access(file); return true } catch { return false } }
async function until(check, message) {
  const deadline = Date.now() + 15000
  while (!await check()) {
    assert.ok(Date.now() < deadline, message)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

// Real production Host, QuickJS, native continuable children, report and disk
// sessions. Only model output and the two independent report times are controlled.
test('branchless Leader dispatches two native Workers through PTC and closes only the selected peer', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'postman-native-workers-'))
  const gates = [Promise.withResolvers(), Promise.withResolvers()], ids = []
  let f
  t.after(async () => { gates.forEach(g => g.resolve()); await f?.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }) })
  f = await capabilityRuntime(dir, { preset: 'postman-leader', reportDelivery: 'next-step', plan: async (agent, request, n) => {
    if (agent.id === 'leader') return n === 1
      ? ptc('const a=await tools.postman_worker({task:"Read A",createNew:true});const b=await tools.postman_worker({task:"Read B",createNew:true});return {a,b}', true)
      : { text: 'Received executor facts; acceptance remains a Leader decision.' }
    assert.equal(request.tools.some(tool => tool.name === 'ptc_execute'), false, 'ordinary Worker uses its direct tools')
    assert.equal(request.tools.some(tool => tool.name === 'postman_worker'), false, 'ordinary Worker does not delegate')
    if (n === 1) return { name: 'read', args: { file_path: join(dir, 'known.txt') } }
    await gates[ids.indexOf(agent.id)].promise
    return { name: 'report', args: { output: 'Unverified notes from Worker ' + ids.indexOf(agent.id) } }
  } })
  const start = f.ctx.subagents.startContinuable.bind(f.ctx.subagents)
  f.ctx.subagents.startContinuable = spec => { ids.push(spec.childId); return start(spec) }
  await writeFile(join(dir, 'known.txt'), 'Local folder facts without a Git repository')
  await f.turn(f.leader, 'Dispatch two bounded folder inspections')
  assert.equal(await exists(join(dir, '.git')), false)
  assert.equal(f.contexts.get('leader').worktree, dir)
  assert.equal(ids.length, 2)
  const outer = f.results.find(result => result.agent === f.leader && result.name === 'ptc_execute')
  assert.equal(outer.result.concludesTurn, true)
  assert.equal(value(outer.result).a.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(value(outer.result).b.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  const denied = await f.execute(f.leader, 'postman_worker', { task: 'Direct bypass' })
  assert.equal(denied.isError, true, 'Leader keeps mandatory PTC')

  gates[0].resolve(); await f.childDone(ids[0]); await f.leader.whenIdle()
  const peerBefore = structuredClone(f.registry.get('leader').workers[ids[1]])
  const closed = value(await f.execute(f.leader, 'ptc_execute', {
    program: 'return await tools.postman_worker_stop(' + JSON.stringify({ workerSessionId: ids[0], mode: 'close' }) + ')',
  }))
  assert.equal(closed.status, 'POSTMAN_WORKER_STOPPED')
  assert.equal(closed.taskCompleted, false, 'closing does not certify the unverified report')
  assert.deepEqual(f.registry.get('leader').workers[ids[1]], peerBefore)
  assert.ok(f.ctx.agents.get(ids[1]), 'the independent peer remains active')
  assert.equal(f.ctx.agents.get(ids[0]), undefined)
  await assert.rejects(f.ctx.subagents.followup(f.leader, ids[0], [{ type: 'text', text: 'Must not resurrect a closed Worker' }], { signal: new AbortController().signal }), /closed|not open|unknown|admission/i)
  const saved = await f.ctx.sessionPersistence.inspect(ids[0])
  assert.equal(saved.meta.parentSession, 'leader')
  assert.equal(saved.events.filter(event => event.type === 'tool/call' && event.data.name === 'report').length, 1)

  gates[1].resolve(); await f.childDone(ids[1]); await f.leader.whenIdle()
  for (const id of ids) assert.equal(f.leader.session.events.filter(event => event.type === 'user/message' &&
    event.data.source?.kind === 'subagent-report' && event.data.source.senderSessionId === id).length, 1)
  const final = value(await f.execute(f.leader, 'ptc_execute', { program: 'return await tools.postman_worker_stop(' +
    JSON.stringify({ workerSessionId: ids[1], mode: 'close' }) + ')' }))
  assert.equal(final.status, 'POSTMAN_WORKER_STOPPED')
  assert.deepEqual(Object.keys(f.registry.get('leader').workers), [])
  assert.ok(f.results.filter(result => ids.includes(result.agent.id) && result.name === 'read').every(result => result.result.isError === false))
})

test('addressed cancel cuts off an active native Worker and preserves its peer and files', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'postman-active-cutoff-')), marker = join(dir, 'started.txt'), kept = join(dir, 'kept.txt')
  let f, activeId
  const peerGate = Promise.withResolvers(), ids = []
  t.after(async () => { peerGate.resolve(); await f?.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }) })
  f = await capabilityRuntime(dir, { preset: 'postman-leader', reportDelivery: 'next-step', plan: async (agent, _request, n) => {
    if (agent.id === 'leader') return n === 1
      ? ptc('const a=await tools.postman_worker({task:"Run owned bounded shell",createNew:true});const b=await tools.postman_worker({task:"Keep independent peer",createNew:true});return {a,b}', true)
      : { text: 'Observed native executor event.' }
    if (agent.id === ids[0]) return n === 1 ? { name: 'pwsh', args: {
      command: "Set-Content -LiteralPath '" + marker.replaceAll("'", "''") + "' -Value active; Start-Sleep -Seconds 20",
      description: 'Bounded native cancellation fixture',
    } } : { text: 'Native command ended.' }
    await peerGate.promise
    return { name: 'report', args: { output: 'Peer observations' } }
  } })
  const start = f.ctx.subagents.startContinuable.bind(f.ctx.subagents)
  f.ctx.subagents.startContinuable = spec => { ids.push(spec.childId); return start(spec) }
  await writeFile(kept, 'preserved user bytes')
  await f.turn(f.leader, 'Start two explicitly bounded native Workers')
  activeId = ids[0]
  await until(() => exists(marker), 'the owned native foreground process must actually start')
  const peer = structuredClone(f.registry.get('leader').workers[ids[1]])
  const cancelled = value(await f.execute(f.leader, 'ptc_execute', { program: 'return await tools.postman_worker_stop(' +
    JSON.stringify({ workerSessionId: activeId, mode: 'cancel' }) + ')' }))
  assert.equal(cancelled.status, 'POSTMAN_WORKER_CANCELLED', JSON.stringify(cancelled))
  assert.equal(cancelled.taskCompleted, false)
  assert.equal(f.ctx.agents.get(activeId), undefined)
  assert.deepEqual(f.registry.get('leader').workers[ids[1]], peer)
  await assert.rejects(f.ctx.subagents.followup(f.leader, activeId, [{ type: 'text', text: 'Revoked assignment cannot resume' }], { signal: new AbortController().signal }), /closed|not open|unknown|admission/i)
  assert.equal(await readFile(kept, 'utf8'), 'preserved user bytes')
  peerGate.resolve(); await f.childDone(ids[1]); await f.leader.whenIdle()
})
