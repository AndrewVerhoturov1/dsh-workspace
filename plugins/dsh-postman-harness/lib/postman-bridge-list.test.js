import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeListTool } from './postman-bridge.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'

const leader = id => ({ id, session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } })
test('Bridge list exact live Leader boundary is read-only, including legacy ambiguity', async () => {
  const owner = leader('owner'), foreign = leader('foreign')
  const row = { leaderSessionId: owner.id, bridge: { id: 'legacy', state: 'pending' },
    bridgeOperations: { request: { state: 'unknown', transportKind: 'text', phase: 'request-known',
      childSessionId: 'bridge-child', requestId: 'REQ_20261004T120000Z_1234' },
      safe: { state: 'received', phase: 'not-sent', synchronization: 'not-required', requestId: 'REQ_20261004T120001Z_1234' } } }
  const before = structuredClone(row)
  const unexpected = () => { throw Error('list may not mutate or start an operation') }
  const ctx = { agents: { get: id => id === owner.id ? owner : id === foreign.id ? foreign : undefined },
    subagents: { start: unexpected } }
  const jobs = createPostmanBridgeJobs(ctx, { run: unexpected, dispose() {} }, { register: unexpected },
    { record: id => id === owner.id ? row : null, changeRecord: unexpected, sync: unexpected })
  const tool = createPostmanBridgeListTool(ctx, jobs)
  try {
    const value = await tool.execute({}, { agent: owner })
    assert.equal(value.status, 'POSTMAN_BRIDGE_LIST')
    assert.equal(value.limit, 3); assert.equal(value.used, 2)
    assert.equal(value.operations.length, 3)
    const legacy = value.operations.find(op => op.bridgeJobId === 'legacy')
    assert.equal(legacy.requestId, 'unknown'); assert.equal(legacy.publication, 'unknown')
    assert.equal(legacy.countsAgainstLimit, true)
    assert.match(legacy.slotReason, /legacy correlation unavailable/)
    assert.equal(value.operations.find(op => op.bridgeJobId === 'safe').countsAgainstLimit, false)
    assert.deepEqual(row, before)
    assert.deepEqual((await tool.execute({}, { agent: foreign })).operations, [])
    assert.equal((await tool.execute({}, { agent: leader(owner.id) })).status, 'POSTMAN_BRIDGE_CALLER_REJECTED')
    const child = { id: 'child', session: { header: { agentPreset: 'postman-leader', parentSession: owner.id,
      origin: 'subagent', delegationDepth: 1 } } }
    assert.equal((await tool.execute({}, { agent: child })).status, 'POSTMAN_BRIDGE_CALLER_REJECTED')
    assert.deepEqual(row, before)
  } finally { await jobs.dispose() }
})
