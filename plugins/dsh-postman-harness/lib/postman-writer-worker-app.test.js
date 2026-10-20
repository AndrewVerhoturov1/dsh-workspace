import assert from 'node:assert/strict'
import test from 'node:test'
import { writerRuntimeFixture } from './fixtures/postman-writer-runtime.js'
import { capabilityRuntime } from './fixtures/postman-capability-runtime.js'

// Actual native writer and SDK-owned app run together; there is no synthetic
// writer-exit proof or prepared Git branch between these operations.
test('live native writer permits a branchless Worker app and a peer cannot stop that app', { timeout: 60000 }, async t => {
  const originalLocalAppData = process.env.LOCALAPPDATA
  const native = await writerRuntimeFixture(t, { leaderSessionId: 'leader' })
  // Keep loaded SDK/QuickJS Windows DLLs outside the disposable writer folder.
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = originalLocalAppData
  let app
  const ids = []
  const f = await capabilityRuntime(native.directory, { reportDelivery: 'next-step', plan: (agent, _request, n) => {
    if (agent.id === 'leader') return { text: 'Observed app or executor facts.' }
    if (n > 1) return { name: 'report', args: { output: 'Executor observations; Leader decides acceptance.' } }
    return ids.indexOf(agent.id) === 0
      ? { name: 'postman_app', args: { action: 'start', command: 'node -e "setInterval(()=>{},1000)"', description: 'Owned isolated test app' } }
      : { name: 'postman_app', args: { action: 'stop', jobId: app.jobId, appId: app.appId } }
  } })
  const start = f.ctx.subagents.startContinuable.bind(f.ctx.subagents)
  f.ctx.subagents.startContinuable = spec => { ids.push(spec.childId); return start(spec) }
  const phase = async program => {
    const result = await f.execute(f.leader, 'ptc_execute', { program })
    assert.equal(result.isError, false, JSON.stringify(result))
    return result.value.value
  }
  try {
    await f.turn(f.leader, 'Run a bounded app test in the current folder')
    assert.equal(f.contexts.get('leader').worktree, native.directory)
    assert.equal(f.contexts.get('leader').branch, undefined)
    const op = { state: 'unknown', transportKind: 'devspace', requestId: native.binding.requestId,
      childSessionId: native.binding.lunaSessionId, devspace: { mode: 'WRITE_ISOLATED', channel: native.binding.channel } }
    await f.registry.change('leader', row => ({ ...row, bridgeOperations: { [native.binding.jobId]: op } }))
    const running = await native.background({ execution: 'background', command: 'setInterval(()=>{},1000)', timeout: 2 })
    const nativeId = running.structuredContent.native_job_id
    assert.equal(running.structuredContent.treeSettled, false)

    const accepted = await phase('return await tools.postman_worker({task:"Start an owned app",createNew:true})')
    assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
    await f.childDone(accepted.workerSessionId); await f.leader.whenIdle()
    app = f.results.find(result => result.agent.id === accepted.workerSessionId && result.name === 'postman_app')?.result.value
    assert.equal(app?.status, 'POSTMAN_APP_STARTED', JSON.stringify(app))
    assert.equal(f.ctx.jobs.get(app.jobId, f.leader).status, 'running')
    const stillRunning = await native.background({ execution: 'status', job_id: nativeId })
    assert.equal(stillRunning.structuredContent.treeSettled, false, 'Worker app started while the native writer remained alive')

    const peer = await phase('return await tools.postman_worker({task:"Inspect app ownership",createNew:true})')
    await f.childDone(peer.workerSessionId); await f.leader.whenIdle()
    const rejected = f.results.find(result => result.agent.id === peer.workerSessionId && result.name === 'postman_app')?.result.value
    assert.equal(rejected?.status, 'POSTMAN_APP_CALLER_REJECTED', JSON.stringify(rejected))
    assert.equal(f.ctx.jobs.get(app.jobId, f.leader).status, 'running', 'peer cannot stop another Worker app')

    const stopped = await phase('return await tools.postman_app(' + JSON.stringify({ action: 'stop', jobId: app.jobId, appId: app.appId }) + ')')
    assert.notEqual(stopped.jobStatus, 'running')
    app = null
    const nativeStop = await native.background({ execution: 'stop', job_id: nativeId })
    assert.equal(nativeStop.structuredContent.treeSettled, true, JSON.stringify(nativeStop))
    for (const workerSessionId of ids) {
      const closed = await phase('return await tools.postman_worker_stop(' + JSON.stringify({ mode: 'close', workerSessionId }) + ')')
      assert.equal(closed.status, 'POSTMAN_WORKER_STOPPED')
    }
  } finally {
    // Stop exact apps before disposing the SDK and before the writer fixture's
    // teardown removes its folder, including when an assertion fails.
    const started = f.results.filter(result => result.name === 'postman_app' && result.result.value?.status === 'POSTMAN_APP_STARTED')
    for (const result of started) {
      const owned = result.result.value
      try { await phase('return await tools.postman_app(' + JSON.stringify({ action: 'stop', jobId: owned.jobId, appId: owned.appId }) + ')') } catch {}
    }
    await f.dispose()
  }
})
