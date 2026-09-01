import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPostmanAsyncSendTool, POSTMAN_SESSION_ID } from './index.js'
import { PostmanRuntime } from './runtime.js'
import { WebWorkerBridge, markWebResultReady, WEB_WORKER_STATES } from './web-worker-bridge.js'

const REQUEST_ID = 'REQ_20260831T043820Z_0042'

function durableProof(requestId = REQUEST_ID, overrides = {}) {
  return {
    ok: true,
    code: WEB_WORKER_STATES.RESULT_DURABLE,
    details: {
      requestId,
      resultDirectory: `C:/results/${requestId}`,
      resultZip: `C:/results/${requestId}/result.zip`,
      manifest: `C:/results/${requestId}/manifest.json`,
      validation: `C:/results/${requestId}/validation.json`,
      metadata: `C:/results/${requestId}/metadata.json`,
      sha256: 'a'.repeat(64),
      ...overrides,
    },
  }
}

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-worker-bridge-'))
  const runtime = new PostmanRuntime({
    dbPath: join(root, 'postman.db'),
    journalPath: join(root, 'postman.jsonl'),
    ...options,
  })
  return { root, runtime }
}

test('Web Worker bridge returns an ACCEPTED result path before RESULT_DURABLE', () => {
  const { root, runtime } = fixture()
  try {
    const created = runtime.createRequest({ requestId: REQUEST_ID, originAgentId: 'agent-a', payload: 'task' })
    const bridge = new WebWorkerBridge({ runtime })
    const accepted = bridge.accept({ requestId: created.request_id, taskUrl: 'https://example.test/tasks/request.md' })

    assert.equal(accepted.status, 'WEB_WORKER_NOT_CONFIGURED')
    assert.equal(accepted.requestId, REQUEST_ID)
    assert.equal(accepted.state, WEB_WORKER_STATES.ACCEPTED)
    assert.equal(accepted.resultPath, created.result_path)
    assert.equal(runtime.getRequest(REQUEST_ID).status, 'ACCEPTED')
  } finally {
    runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('postman_async_send exposes the durable target path while handing the task to the bridge', async () => {
  const { root, runtime } = fixture()
  try {
    const calls = []
    const sender = { id: 'agent-a', followup() {} }
    const postman = { id: POSTMAN_SESSION_ID, followup() {} }
    const agents = new Map([[sender.id, sender], [postman.id, postman]])
    const bridge = { accept(input) { calls.push(input) } }
    const tool = createPostmanAsyncSendTool({ agents: { get: (id) => agents.get(id) } }, runtime, { bridge })
    const result = await tool.execute({
      request_id: REQUEST_ID,
      task: 'task payload',
      task_url: 'https://example.test/tasks/request.md',
    }, { agent: sender })

    assert.equal(result.status, 'ACCEPTED')
    assert.equal(result.state, 'WAITING')
    assert.equal(result.result_state, WEB_WORKER_STATES.RESULT_DURABLE)
    assert.equal(result.result_path, runtime.getRequest(REQUEST_ID).result_path)
    assert.deepEqual(calls, [{ requestId: REQUEST_ID, taskUrl: 'https://example.test/tasks/request.md' }])
  } finally {
    runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('markWebResultReady publishes only a compact RESULT_DURABLE handle and preserves REQ', () => {
  const { root, runtime } = fixture()
  try {
    runtime.createRequest({ requestId: REQUEST_ID, originAgentId: 'agent-a', payload: 'task' })
    const ready = markWebResultReady(runtime, { requestId: REQUEST_ID, durableResult: durableProof() })

    assert.equal(ready.status, 'READY')
    const request = runtime.getRequest(REQUEST_ID)
    assert.equal(request.status, 'READY')
    assert.equal(request.request_id, REQUEST_ID)
    assert.match(request.result_text, /RESULT_DURABLE/)
    assert.doesNotMatch(request.result_text, /assistant text|full zip/i)
    assert.equal(JSON.parse(request.result_text).requestId, REQUEST_ID)
  } finally {
    runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Web Worker bridge sends RESULT_DURABLE to Runtime only after the injected pipeline succeeds', async () => {
  const { root, runtime } = fixture()
  try {
    runtime.createRequest({ requestId: REQUEST_ID, originAgentId: 'agent-a', payload: 'task' })
    const bridge = new WebWorkerBridge({
      runtime,
      run: async ({ requestId, taskUrl }) => {
        assert.equal(requestId, REQUEST_ID)
        assert.equal(taskUrl, 'https://example.test/tasks/request.md')
        return durableProof(requestId)
      },
    })
    const result = await bridge.accept({ requestId: REQUEST_ID, taskUrl: 'https://example.test/tasks/request.md' })

    assert.equal(result.status, 'READY')
    const stored = runtime.getRequest(REQUEST_ID)
    assert.equal(JSON.parse(stored.result_text).sha256, 'a'.repeat(64))
    assert.equal(stored.status, 'READY')
  } finally {
    runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('markWebResultReady rejects a failed or cross-correlated durable proof', () => {
  const { root, runtime } = fixture()
  try {
    runtime.createRequest({ requestId: REQUEST_ID, originAgentId: 'agent-a', payload: 'task' })
    assert.throws(
      () => markWebResultReady(runtime, { requestId: REQUEST_ID, durableResult: { ok: false, code: WEB_WORKER_STATES.RESULT_DURABLE, details: {} } }),
      /successful RESULT_DURABLE/,
    )
    assert.throws(
      () => markWebResultReady(runtime, { requestId: REQUEST_ID, durableResult: durableProof('REQ_20260831T043821Z_0043') }),
      /requestId mismatch/,
    )
    assert.equal(runtime.getRequest(REQUEST_ID).status, 'ACCEPTED')
  } finally {
    runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Runtime suppresses a different result after READY instead of overwriting it', () => {
  const { root, runtime } = fixture()
  try {
    runtime.createRequest({ requestId: REQUEST_ID, originAgentId: 'agent-a', payload: 'task' })
    const first = markWebResultReady(runtime, { requestId: REQUEST_ID, durableResult: durableProof() })
    const second = markWebResultReady(runtime, { requestId: REQUEST_ID, durableResult: durableProof(REQUEST_ID, { sha256: 'b'.repeat(64) }) })

    assert.equal(first.status, 'READY')
    assert.equal(second.status, 'RESULT_CONFLICT')
    assert.equal(JSON.parse(runtime.getRequest(REQUEST_ID).result_text).sha256, 'a'.repeat(64))
  } finally {
    runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})
