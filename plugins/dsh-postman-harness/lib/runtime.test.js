import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostmanRuntime, REQUEST_STATUSES } from './runtime.js'

function runtimeFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-postman-runtime-'))
  const runtime = new PostmanRuntime({
    dbPath: join(root, 'postman.db'),
    journalPath: join(root, 'logs', 'postman.jsonl'),
    ...options,
  })
  return {
    root,
    runtime,
    close() {
      runtime.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('PostmanRuntime should atomically persist the exact initiator request id and derived message id', () => {
  const fixture = runtimeFixture()
  try {
    const firstId = 'REQ_20260831T043800Z_0001'
    const secondId = 'REQ_20260831T043801Z_0002'
    const first = fixture.runtime.createRequest({ requestId: firstId, originAgentId: 'agent-a', payload: 'ALPHA' })
    const second = fixture.runtime.createRequest({ requestId: secondId, originAgentId: 'agent-a', payload: 'BRAVO' })

    assert.equal(first.request_id, firstId)
    assert.equal(first.message_id, 'MSG_20260831T043800Z_0001')
    assert.equal(second.request_id, secondId)
    assert.equal(second.message_id, 'MSG_20260831T043801Z_0002')
    assert.equal(fixture.runtime.getRequest(firstId).origin_agent_id, 'agent-a')
    assert.equal(fixture.runtime.schemaVersion, 1)
    assert.match(readFileSync(join(fixture.root, 'logs', 'postman.jsonl'), 'utf8'), /"event":"REQUEST_CREATED"/)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should reject missing and legacy generated request ids without invoking a generator', () => {
  let generatorCalled = false
  const fixture = runtimeFixture({ uuid: () => { generatorCalled = true; return 'legacy' } })
  try {
    assert.throws(
      () => fixture.runtime.createRequest({ originAgentId: 'agent-a', payload: 'MISSING' }),
      /REQ_YYYYMMDDTHHMMSSZ_NNNN/,
    )
    assert.throws(
      () => fixture.runtime.createRequest({ requestId: 'REQ_550e8400-e29b-41d4-a716-446655440000', originAgentId: 'agent-a', payload: 'LEGACY' }),
      /REQ_YYYYMMDDTHHMMSSZ_NNNN/,
    )
    assert.equal(generatorCalled, false)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should register an initiator-supplied canonical request id unchanged', () => {
  const fixture = runtimeFixture()
  try {
    const requestId = 'REQ_20260831T043812Z_4827'
    const created = fixture.runtime.createRequest({ requestId, originAgentId: 'agent-a', payload: 'ALPHA' })

    assert.equal(created.request_id, requestId)
    assert.equal(created.message_id, 'MSG_20260831T043812Z_4827')
    assert.equal(created.origin_agent_id, 'agent-a')
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should fail closed on malformed or colliding canonical request ids', () => {
  const fixture = runtimeFixture()
  try {
    assert.throws(
      () => fixture.runtime.createRequest({ requestId: 'REQ_20261331T043812Z_4827', originAgentId: 'agent-a', payload: 'BAD' }),
      /REQ_YYYYMMDDTHHMMSSZ_NNNN/,
    )
    const requestId = 'REQ_20260831T043812Z_4827'
    fixture.runtime.createRequest({ requestId, originAgentId: 'agent-a', payload: 'FIRST' })
    assert.throws(
      () => fixture.runtime.createRequest({ requestId, originAgentId: 'agent-a', payload: 'SECOND' }),
      /already registered/,
    )
    assert.equal(fixture.runtime.db.prepare('SELECT COUNT(*) AS count FROM requests').get().count, 1)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should not return an accepted request when the durable commit fails', () => {
  const fixture = runtimeFixture({ beforeCommit: () => { throw new Error('commit failed') } })
  try {
    assert.throws(() => fixture.runtime.createRequest({ requestId: 'REQ_20260831T043802Z_0003', originAgentId: 'agent-a', payload: 'ALPHA' }), /commit failed/)
    assert.equal(fixture.runtime.db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0)
    assert.equal(fixture.runtime.db.prepare('SELECT COUNT(*) AS count FROM requests').get().count, 0)
    assert.equal(existsSync(join(fixture.root, 'logs', 'postman.jsonl')), false)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should transition an existing request to READY and wake POSTMAN after commit', async () => {
  const wakes = []
  const fixture = runtimeFixture({ onReady: (record) => { wakes.push(record.request_id) } })
  try {
    const created = fixture.runtime.createRequest({ requestId: 'REQ_20260831T043803Z_0004', originAgentId: 'agent-a', payload: 'ALPHA' })
    fixture.runtime.acceptRequest(created.request_id)
    const ready = await fixture.runtime.markSyntheticReady({ requestId: created.request_id, result: 'ASYNC_RESULT_ALPHA' })

    assert.equal(ready.status, 'READY')
    assert.equal(ready.wakeup, 'SUCCEEDED')
    assert.deepEqual(wakes, [created.request_id])
    assert.equal(fixture.runtime.getRequest(created.request_id).status, REQUEST_STATUSES.READY)
    assert.equal(fixture.runtime.getRequest(created.request_id).result_text, 'ASYNC_RESULT_ALPHA')
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should suppress the same READY event twice', async () => {
  let wakeCount = 0
  const fixture = runtimeFixture({ onReady: () => { wakeCount += 1 } })
  try {
    const created = fixture.runtime.createRequest({ requestId: 'REQ_20260831T043804Z_0005', originAgentId: 'agent-a', payload: 'ALPHA' })
    const first = await fixture.runtime.markSyntheticReady({ requestId: created.request_id, result: 'RESULT' })
    const second = await fixture.runtime.markSyntheticReady({ requestId: created.request_id, result: 'RESULT' })

    assert.equal(first.status, 'READY')
    assert.equal(second.status, 'DUPLICATE_SUPPRESSED')
    assert.equal(wakeCount, 1)
    assert.equal(fixture.runtime.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should reject an unknown READY without creating state', async () => {
  const fixture = runtimeFixture()
  try {
    const result = await fixture.runtime.markSyntheticReady({ requestId: 'REQ_20260831T043859Z_9999', result: 'UNKNOWN' })

    assert.equal(result.status, 'UNKNOWN_REQUEST')
    assert.equal(fixture.runtime.db.prepare('SELECT COUNT(*) AS count FROM requests').get().count, 0)
    assert.equal(fixture.runtime.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 0)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should enforce READY to DELIVERING to DELIVERED', () => {
  const fixture = runtimeFixture()
  try {
    const created = fixture.runtime.createRequest({ requestId: 'REQ_20260831T043805Z_0006', originAgentId: 'agent-a', payload: 'ALPHA' })
    const ready = fixture.runtime.markSyntheticReady({ requestId: created.request_id, result: 'RESULT' })
    assert.equal(ready.status, 'READY')
    const started = fixture.runtime.beginDelivery(created.request_id)
    assert.equal(started.status, REQUEST_STATUSES.DELIVERING)
    const completed = fixture.runtime.completeDelivery({ requestId: created.request_id, deliveryKey: started.delivery.delivery_key })
    assert.equal(completed.status, REQUEST_STATUSES.DELIVERED)
    assert.equal(fixture.runtime.getRequest(created.request_id).status, REQUEST_STATUSES.DELIVERED)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should keep a request retryable when delivery fails', () => {
  const fixture = runtimeFixture()
  try {
    const created = fixture.runtime.createRequest({ requestId: 'REQ_20260831T043806Z_0007', originAgentId: 'agent-a', payload: 'ALPHA' })
    const ready = fixture.runtime.markSyntheticReady({ requestId: created.request_id, result: 'RESULT' })
    const started = fixture.runtime.beginDelivery(created.request_id)
    const failed = fixture.runtime.failDelivery({ requestId: created.request_id, deliveryKey: started.delivery.delivery_key, error: 'origin busy' })

    assert.equal(failed.status, REQUEST_STATUSES.DELIVERY_RETRY)
    assert.equal(fixture.runtime.getRequest(created.request_id).result_text, 'RESULT')
    assert.equal(fixture.runtime.listActionable().length, 1)
    assert.equal(ready.record.origin_agent_id, 'agent-a')
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should preserve READY and origin across a restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-postman-restart-'))
  const options = { dbPath: join(root, 'postman.db'), journalPath: join(root, 'logs', 'postman.jsonl') }
  const first = new PostmanRuntime(options)
  const created = first.createRequest({ requestId: 'REQ_20260831T043807Z_0008', originAgentId: 'agent-a', payload: 'ALPHA' })
  first.markSyntheticReady({ requestId: created.request_id, result: 'RESTART_RESULT' })
  first.close()
  try {
    const second = new PostmanRuntime(options)
    try {
      const restored = second.getRequest(created.request_id)
      assert.equal(restored.origin_agent_id, 'agent-a')
      assert.equal(restored.status, REQUEST_STATUSES.READY)
      assert.equal(second.listActionable()[0].request_id, created.request_id)
    } finally {
      second.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PostmanRuntime should leave deferred READY actionable for startup recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-postman-ready-recovery-'))
  const options = { dbPath: join(root, 'postman.db'), journalPath: join(root, 'logs', 'postman.jsonl') }
  const first = new PostmanRuntime(options)
  const created = first.createRequest({ requestId: 'REQ_20260831T043808Z_0009', originAgentId: 'agent-a', payload: 'ALPHA' })
  const ready = first.markSyntheticReady({ requestId: created.request_id, result: 'RECOVER_ME', wake: false })
  first.close()
  try {
    const wakes = []
    const second = new PostmanRuntime({ ...options, onReady: (record) => { wakes.push(record.request_id) } })
    try {
      assert.equal(ready.wakeup, 'DEFERRED')
      assert.equal(second.listActionable()[0].request_id, created.request_id)
      second.listActionable().forEach((record) => second.onReady(record))
      assert.deepEqual(wakes, [created.request_id])
    } finally {
      second.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PostmanRuntime should route multiple same-agent requests by REQ, not by last sender', () => {
  const fixture = runtimeFixture()
  try {
    const first = fixture.runtime.createRequest({ requestId: 'REQ_20260831T043809Z_0010', originAgentId: 'agent-a', payload: 'A1' })
    const second = fixture.runtime.createRequest({ requestId: 'REQ_20260831T043810Z_0011', originAgentId: 'agent-a', payload: 'A2' })
    fixture.runtime.markSyntheticReady({ requestId: second.request_id, result: 'RESULT_A2' })
    fixture.runtime.markSyntheticReady({ requestId: first.request_id, result: 'RESULT_A1' })

    assert.equal(fixture.runtime.getRequest(first.request_id).result_text, 'RESULT_A1')
    assert.equal(fixture.runtime.getRequest(second.request_id).result_text, 'RESULT_A2')
    assert.deepEqual(fixture.runtime.listActionable().map((request) => request.request_id), [second.request_id, first.request_id])
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should block a missing origin without losing the result', () => {
  const fixture = runtimeFixture()
  try {
    const created = fixture.runtime.createRequest({ requestId: 'REQ_20260831T043811Z_0012', originAgentId: 'destroyed-agent', payload: 'ALPHA' })
    fixture.runtime.markSyntheticReady({ requestId: created.request_id, result: 'PRESERVE_ME' })
    const started = fixture.runtime.beginDelivery(created.request_id)
    const blocked = fixture.runtime.blockOriginMissing({ requestId: created.request_id, deliveryKey: started.delivery.delivery_key })

    assert.equal(blocked.status, REQUEST_STATUSES.DELIVERY_BLOCKED_ORIGIN_MISSING)
    assert.equal(fixture.runtime.getRequest(created.request_id).result_text, 'PRESERVE_ME')
  } finally {
    fixture.close()
  }
})
