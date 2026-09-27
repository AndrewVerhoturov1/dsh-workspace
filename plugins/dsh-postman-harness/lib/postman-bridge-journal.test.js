import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'

const parent = { id: 'leader-bridge', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }

test('Bridge intent is durable before launch and never automatically replayed after restart', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { leaderSessionId: parent.id, repository: 'andrewverhoturov1/dsh-workspace',
    repositoryPath: 'C:/repo', originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
    baseCommit: 'a'.repeat(40), branch: 'task/postman-' + 'a'.repeat(32), worktree: 'C:/task',
    stage: 'ready', diagnostic: null, worker: null, runner: { state: 'none', requestId: null }, bridge: null })
  const taskContext = Object.freeze({ branch: registry.get(parent.id).branch })
  const contexts = { get: () => taskContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false }
  let started = 0
  const ctx = { agents: { get: () => parent }, subagents: { start() { started++; throw new Error('must not launch') } } }
  const coordinator = { run: () => new Promise(() => {}), dispose() {} }
  const first = createPostmanBridgeJobs(ctx, coordinator, null, contexts)
  const accepted = await first.accept(parent, '@PostmanAsk text', 'text')
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal(registry.get(parent.id).bridge.id, accepted.bridgeJobId)
  const cold = createPostmanBridgeJobs(ctx, coordinator, null, contexts)
  assert.equal((await cold.accept(parent, '@PostmanAsk text', 'text')).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  assert.equal(started, 0)
  assert.equal(cold.status(parent, accepted.bridgeJobId).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  assert.equal(registry.get(parent.id).bridge.id, accepted.bridgeJobId)
})
