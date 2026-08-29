import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

test('PostmanRuntime should atomically persist a message, unique REQ and trusted origin', () => {
  const fixture = runtimeFixture()
  try {
    const first = fixture.runtime.createRequest({ messageId: 'MSG_A_001', originAgentId: 'agent-a', payload: 'ALPHA' })
    const second = fixture.runtime.createRequest({ messageId: 'MSG_A_002', originAgentId: 'agent-a', payload: 'BRAVO' })

    assert.match(first.request_id, /^REQ_[A-F0-9]{32}$/)
    assert.notEqual(first.request_id, second.request_id)
    assert.equal(fixture.runtime.getRequest(first.request_id).origin_agent_id, 'agent-a')
    assert.equal(fixture.runtime.schemaVersion, 2)
    assert.match(readFileSync(join(fixture.root, 'logs', 'postman.jsonl'), 'utf8'), /"event":"REQUEST_CREATED"/)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should not return an accepted request when the durable commit fails', () => {
  const fixture = runtimeFixture({ beforeCommit: () => { throw new Error('commit failed') } })
  try {
    assert.throws(() => fixture.runtime.createRequest({ messageId: 'MSG_COMMIT_FAIL', originAgentId: 'agent-a', payload: 'ALPHA' }), /commit failed/)
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
    const created = fixture.runtime.createRequest({ messageId: 'MSG_READY_001', originAgentId: 'agent-a', payload: 'ALPHA' })
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
    const created = fixture.runtime.createRequest({ messageId: 'MSG_DUP_001', originAgentId: 'agent-a', payload: 'ALPHA' })
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
    const result = await fixture.runtime.markSyntheticReady({ requestId: 'REQ_DOES_NOT_EXIST', result: 'UNKNOWN' })

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
    const created = fixture.runtime.createRequest({ messageId: 'MSG_STATE_001', originAgentId: 'agent-a', payload: 'ALPHA' })
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
    const created = fixture.runtime.createRequest({ messageId: 'MSG_FAIL_001', originAgentId: 'agent-a', payload: 'ALPHA' })
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
  const created = first.createRequest({ messageId: 'MSG_RESTART_001', originAgentId: 'agent-a', payload: 'ALPHA' })
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
  const created = first.createRequest({ messageId: 'MSG_READY_RECOVERY', originAgentId: 'agent-a', payload: 'ALPHA' })
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
    const first = fixture.runtime.createRequest({ messageId: 'MSG_MULTI_001', originAgentId: 'agent-a', payload: 'A1' })
    const second = fixture.runtime.createRequest({ messageId: 'MSG_MULTI_002', originAgentId: 'agent-a', payload: 'A2' })
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
    const created = fixture.runtime.createRequest({ messageId: 'MSG_MISSING_001', originAgentId: 'destroyed-agent', payload: 'ALPHA' })
    fixture.runtime.markSyntheticReady({ requestId: created.request_id, result: 'PRESERVE_ME' })
    const started = fixture.runtime.beginDelivery(created.request_id)
    const blocked = fixture.runtime.blockOriginMissing({ requestId: created.request_id, deliveryKey: started.delivery.delivery_key })

    assert.equal(blocked.status, REQUEST_STATUSES.DELIVERY_BLOCKED_ORIGIN_MISSING)
    assert.equal(fixture.runtime.getRequest(created.request_id).result_text, 'PRESERVE_ME')
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should persist and validate an external GitHub READY result', () => {
  const fixture = runtimeFixture()
  try {
    const created = fixture.runtime.createRequest({ messageId: 'MSG_EXT_001', originAgentId: 'agent-a', payload: 'TASK' })
    fixture.runtime.registerExternalIssue({ requestId: created.request_id, repository: 'AndrewVerhoturov1/dsh-workspace', issueNumber: 42 })
    fixture.runtime.confirmExternalSubmission({ requestId: created.request_id })
    const resultText = 'FULL EXTERNAL RESULT'
    const resultSha256 = createHash('sha256').update(resultText).digest('hex')
    const ready = fixture.runtime.markExternalReady({
      requestId: created.request_id,
      source: 'github-web-chatgpt',
      resultText,
      resultSha256,
      deliveryKey: 'REQ_EXT_001|42|body-1',
      externalDeliveryId: 'run-42/1',
      metadata: { repository: 'AndrewVerhoturov1/dsh-workspace', issueNumber: 42, bodySha256: 'a'.repeat(64) },
      wake: false,
    })

    assert.equal(ready.status, 'READY')
    assert.equal(ready.wakeup, 'DEFERRED')
    assert.equal(ready.record.external_source, 'github-web-chatgpt')
    assert.equal(ready.record.external_delivery_id, 'run-42/1')
    assert.equal(ready.record.body_sha256, 'a'.repeat(64))
    assert.equal(ready.record.result_sha256, resultSha256)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should reject an external result with an incorrect hash', () => {
  const fixture = runtimeFixture()
  try {
    const created = fixture.runtime.createRequest({ messageId: 'MSG_EXT_HASH', originAgentId: 'agent-a', payload: 'TASK' })
    fixture.runtime.confirmExternalSubmission({ requestId: created.request_id })
    assert.throws(() => fixture.runtime.markExternalReady({
      requestId: created.request_id,
      source: 'github-web-chatgpt',
      resultText: 'RESULT',
      resultSha256: 'b'.repeat(64),
      deliveryKey: 'key-hash',
      externalDeliveryId: 'run-hash',
      wake: false,
    }), /does not match resultText/)
    assert.equal(fixture.runtime.getRequest(created.request_id).status, REQUEST_STATUSES.WAITING)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should reject an unknown external READY without creating a request', () => {
  const fixture = runtimeFixture()
  try {
    const result = fixture.runtime.markExternalReady({
      requestId: 'REQ_DOES_NOT_EXIST',
      source: 'github-web-chatgpt',
      resultText: 'UNKNOWN',
      resultSha256: createHash('sha256').update('UNKNOWN').digest('hex'),
      deliveryKey: 'unknown-key',
      externalDeliveryId: 'unknown-run',
      wake: false,
    })
    assert.equal(result.status, 'EXTERNAL_READY_UNKNOWN_REQUEST')
    assert.equal(fixture.runtime.db.prepare('SELECT COUNT(*) AS count FROM requests').get().count, 0)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should suppress duplicate external delivery and wake only once', () => {
  let wakeCount = 0
  const fixture = runtimeFixture({ onReady: () => { wakeCount += 1 } })
  try {
    const created = fixture.runtime.createRequest({ messageId: 'MSG_EXT_DUP', originAgentId: 'agent-a', payload: 'TASK' })
    fixture.runtime.confirmExternalSubmission({ requestId: created.request_id })
    const resultText = 'DUPLICATE RESULT'
    const input = {
      requestId: created.request_id,
      source: 'github-web-chatgpt',
      resultText,
      resultSha256: createHash('sha256').update(resultText).digest('hex'),
      deliveryKey: 'stable-delivery-key',
      externalDeliveryId: 'run-dup/1',
    }
    assert.equal(fixture.runtime.markExternalReady(input).status, 'READY')
    assert.equal(fixture.runtime.markExternalReady(input).status, 'DUPLICATE_SUPPRESSED')
    assert.equal(wakeCount, 1)
    assert.equal(fixture.runtime.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should suppress the same external result when only delivery metadata changes', () => {
  let wakeCount = 0
  const fixture = runtimeFixture({ onReady: () => { wakeCount += 1 } })
  try {
    const created = fixture.runtime.createRequest({ messageId: 'MSG_EXT_SAME_BODY', originAgentId: 'agent-a', payload: 'TASK' })
    fixture.runtime.confirmExternalSubmission({ requestId: created.request_id })
    const resultText = 'STABLE RESULT'
    const resultSha256 = createHash('sha256').update(resultText).digest('hex')
    const first = fixture.runtime.markExternalReady({
      requestId: created.request_id,
      source: 'github-web-chatgpt',
      resultText,
      resultSha256,
      deliveryKey: 'old-key-with-timestamp',
      externalDeliveryId: 'run-1/1',
      metadata: { issueNumber: 77, repository: 'AndrewVerhoturov1/dsh-workspace', bodySha256: 'd'.repeat(64) },
      wake: true,
    })
    const replay = fixture.runtime.markExternalReady({
      requestId: created.request_id,
      source: 'github-web-chatgpt',
      resultText,
      resultSha256,
      deliveryKey: 'new-key-with-timestamp',
      externalDeliveryId: 'run-2/1',
      metadata: { issueNumber: 77, repository: 'AndrewVerhoturov1/dsh-workspace', bodySha256: 'd'.repeat(64) },
      wake: true,
    })

    assert.equal(first.status, 'READY')
    assert.equal(replay.status, 'DUPLICATE_SUPPRESSED')
    assert.equal(wakeCount, 1)
    assert.equal(fixture.runtime.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should ingest the same durable signal twice without a second READY', () => {
  const fixture = runtimeFixture()
  try {
    const created = fixture.runtime.createRequest({ messageId: 'MSG_SIGNAL_001', originAgentId: 'agent-a', payload: 'TASK' })
    fixture.runtime.confirmExternalSubmission({ requestId: created.request_id })
    const signalPath = join(fixture.root, 'REQ_SIGNAL_001.json')
    writeFileSync(signalPath, JSON.stringify({
      requestId: created.request_id,
      status: 'READY',
      response: 'SIGNAL RESULT',
      issueNumber: 77,
      repository: 'AndrewVerhoturov1/dsh-workspace',
      bodySha256: 'c'.repeat(64),
      deliveryKey: 'signal-key',
      deliveryId: 'run-signal/1',
    }), 'utf8')
    const first = fixture.runtime.ingestSignalFile(signalPath, { wake: false })
    const second = fixture.runtime.ingestSignalFile(signalPath, { wake: false })
    assert.equal(first.status, 'READY')
    assert.equal(second.status, 'DUPLICATE_SUPPRESSED')
    assert.equal(fixture.runtime.getRequest(created.request_id).result_text, 'SIGNAL RESULT')
    assert.equal(fixture.runtime.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1)
  } finally {
    fixture.close()
  }
})

test('PostmanRuntime should migrate an existing M4 database without losing requests', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-postman-migration-'))
  const dbPath = join(root, 'postman.db')
  const journalPath = join(root, 'postman.jsonl')
  const oldDb = new DatabaseSync(dbPath)
  oldDb.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata VALUES ('schema_version', '1');
    CREATE TABLE messages (message_id TEXT PRIMARY KEY, origin_agent_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT, status TEXT NOT NULL);
    CREATE TABLE requests (request_id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(message_id), origin_agent_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, ready_at TEXT, delivered_at TEXT, result_text TEXT, result_sha256 TEXT, delivery_key TEXT, error TEXT);
    CREATE TABLE deliveries (delivery_key TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(request_id), target_agent_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, harness_event_id TEXT, error TEXT);
  `)
  oldDb.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run('MSG_OLD_001', 'agent-old', '2026-08-29T00:00:00.000Z', 'OLD', 'WAITING')
  oldDb.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('REQ_OLD_001', 'MSG_OLD_001', 'agent-old', 'WAITING', '2026-08-29T00:00:00.000Z', null, null, null, null, null, null)
  oldDb.close()
  try {
    const runtime = new PostmanRuntime({ dbPath, journalPath })
    try {
      assert.equal(runtime.schemaVersion, 2)
      assert.equal(runtime.getRequest('REQ_OLD_001').origin_agent_id, 'agent-old')
      assert.ok(runtime.db.prepare('PRAGMA table_info(requests)').all().some((column) => column.name === 'issue_number'))
    } finally { runtime.close() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
