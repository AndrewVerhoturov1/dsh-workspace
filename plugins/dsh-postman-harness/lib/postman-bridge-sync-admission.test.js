import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeTool } from './postman-bridge.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const parent = { id: 'sync-admission-leader', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }

test('terminal sync blocks runner/restore but admits next same-Leader Bridge', async () => {
  const entered = deferred(), release = deferred(), children = []
  const context = Object.freeze({ leaderSessionId: parent.id, repository: 'andrewverhoturov1/dsh-workspace',
    worktree: 'C:/temp/task', branch: 'task/postman-' + 'a'.repeat(32), baseCommit: 'a'.repeat(40) })
  let syncCount = 0, runnerActive = false, restoring = false, bridgeActive = 0
  const actualContextOps = {
    get: id => id === parent.id ? context : null,
    hasActiveOperation: id => id === parent.id && runnerActive,
    isRestoring: id => id === parent.id && restoring,
    beginSync: id => { if (id !== parent.id) return false; syncCount++; return true },
    endSync: id => { if (id === parent.id) syncCount-- },
    beginOperation: id => { if (id !== parent.id || runnerActive || restoring || syncCount || bridgeActive) return false; runnerActive = true; return true },
    reserveRestore: id => { if (id !== parent.id || runnerActive || restoring || syncCount || bridgeActive) return false; restoring = true; return true },
    releaseRestore: id => { if (id === parent.id) restoring = false },
    bindChild: () => true, releaseChild() {},
    async sync() { entered.resolve(); await release.promise; return true },
  }
  const coordinator = createPostmanBridgeLaunchCoordinator({ random: () => 0 })
  const ctx = { agents: { get: id => id === parent.id ? parent : null }, subagents: { async start(_provider, request) {
    const child = { id: 'child-' + (children.length + 1), request, completion: deferred() }; children.push(child); bridgeActive++
    return { id: child.id, localAgent: child, result: child.completion.promise, async dispose() { bridgeActive-- } }
  } }, tools: { get() { return { async execute() { const i = children.length; return { status: 'COMPLETED', requestId: `REQ_${String(i).padStart(4, '0')}`, result: { requestId: `REQ_${String(i).padStart(4, '0')}`, ok: true, code: 'TEXT_RESULT_DURABLE' } } } } } } }
  parent.followup = () => {}
  const manager = createPostmanBridgeJobs(ctx, coordinator, null, actualContextOps)
  const bridge = createPostmanBridgeTool(ctx, manager, actualContextOps)
  const exec = { agent: parent, signal: new AbortController().signal }
  const first = await bridge.execute({ message: '@PostmanAsk first' }, exec)
  await tick(); children[0].completion.resolve({ stopReason: 'end_turn' }); await entered.promise
  assert.equal(actualContextOps.hasActiveOperation(parent.id), false)
  assert.equal(syncCount, 1)
  assert.equal(actualContextOps.beginOperation(parent.id), false, 'runner must remain locked during terminal sync')
  assert.equal(actualContextOps.reserveRestore(parent.id), false, 'restore must remain locked during terminal sync')
  const second = await bridge.execute({ message: '@PostmanAsk independent' }, exec)
  assert.equal(second.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await tick()
  assert.equal((await manager.status(parent, second.bridgeJobId)).status, 'POSTMAN_BRIDGE_RUNNING')
  release.resolve(); await tick(); await tick(); await tick()
  assert.equal(children.length, 2)
  assert.equal((await manager.status(parent, first.bridgeJobId)).status, 'POSTMAN_BRIDGE_TERMINAL')
  children[1].completion.resolve({ stopReason: 'end_turn' }); await tick(); await tick(); await tick()
  assert.equal((await manager.status(parent, second.bridgeJobId)).status, 'POSTMAN_BRIDGE_TERMINAL')
  await manager.dispose(); coordinator.dispose()
})
