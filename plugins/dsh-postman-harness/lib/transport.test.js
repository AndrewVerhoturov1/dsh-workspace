import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { PostmanRuntime } from './runtime.js'
import { buildChatGptTransportPrompt, createAndSubmitExternal, createGitHubIssue, startPostSubmitGuard, stopPostSubmitGuard } from './transport.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-postman-transport-'))
  const runtime = new PostmanRuntime({ dbPath: join(root, 'postman.db'), journalPath: join(root, 'postman.jsonl') })
  const request = runtime.createRequest({ messageId: 'MSG_TRANSPORT_001', originAgentId: 'agent-a', payload: 'Ответь ровно: M6_OK' })
  return { root, runtime, request, close: () => { runtime.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('buildChatGptTransportPrompt should preserve the request and GitHub delivery contract', () => {
  const prompt = buildChatGptTransportPrompt({ requestId: 'REQ_M6_001', issueNumber: 9, task: 'M6_OK' })
  assert.match(prompt, /REQUEST_ID:\nREQ_M6_001/)
  assert.match(prompt, /Update GitHub Issue #9 body exactly as:/)
  assert.match(prompt, /status: READY/)
  assert.match(prompt, /POSTMAN_SIGNAL_SENT/)
  assert.match(prompt, /Do not create another Issue\./)
})

test('createAndSubmitExternal should persist issue metadata and WAITING only after submit confirmation', async () => {
  const f = fixture()
  try {
    const calls = []
    const result = await createAndSubmitExternal({
      runtime: f.runtime,
      request: f.request,
      issueCreator: async (input) => { calls.push(['issue', input]); return { repository: input.repository, issueNumber: 123 } },
      submitter: async (input) => { calls.push(['submit', input]); return { ok: true, submitted: true, userMessageConfirmed: true, runId: 'test-run' } },
    })
    const stored = f.runtime.getRequest(f.request.request_id)
    assert.equal(result.status, 'WAITING')
    assert.equal(stored.status, 'WAITING')
    assert.equal(stored.issue_number, 123)
    assert.equal(stored.repository, 'AndrewVerhoturov1/dsh-workspace')
    assert.equal(calls.length, 2)
    assert.equal(calls[0][0], 'issue')
    assert.equal(calls[1][0], 'submit')
  } finally { f.close() }
})

test('createAndSubmitExternal should start the optional post-submit guard after confirmation', async () => {
  const f = fixture()
  try {
    const calls = []
    const result = await createAndSubmitExternal({
      runtime: f.runtime,
      request: f.request,
      issueCreator: async () => ({ repository: 'AndrewVerhoturov1/dsh-workspace', issueNumber: 126 }),
      submitter: async () => ({ ok: true, submitted: true, userMessageConfirmed: true, runId: 'guard-test', hostPid: 34728, hostHwnd: '0x280788' }),
      postSubmitGuard: (input) => { calls.push(input); return { requestId: input.requestId } },
    })
    assert.equal(result.status, 'WAITING')
    assert.equal(result.postSubmitGuardStarted, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].requestId, f.request.request_id)
    assert.equal(calls[0].issueNumber, 126)
  } finally { f.close() }
})

test('startPostSubmitGuard should pass the confirmed host identity and journal child events', async () => {
  class FakeChild extends EventEmitter {
    constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough() }
    kill() { this.emit('close', null) }
  }
  const child = new FakeChild()
  const calls = []
  const runtime = {
    getRequest: () => ({ status: 'WAITING' }),
    journal: (event, payload) => calls.push({ event, payload }),
  }
  let spawnInput
  const handle = startPostSubmitGuard({
    runtime,
    requestId: 'REQ_GUARD_TEST',
    issueNumber: 127,
    confirmation: { hostPid: 34728, hostHwnd: '0x280788' },
    spawn: (...args) => { spawnInput = args; return child },
    guardPath: 'guard.ps1',
    deadlineSeconds: 9,
  })
  try {
    assert.ok(handle)
    assert.equal(spawnInput[0], process.env.DSH_POSTMAN_PWSH || 'pwsh.exe')
    assert.deepEqual(spawnInput[1].slice(-8), ['-HostPid', '34728', '-HostHwnd', '0x280788', '-RequestId', 'REQ_GUARD_TEST', '-DeadlineSeconds', '9'])
    child.stdout.write(JSON.stringify({ event: 'WORK_PROMPT_DETECTED', requestId: 'REQ_GUARD_TEST', hostPid: 34728 }) + '\n')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls.find((entry) => entry.event === 'WORK_PROMPT_DETECTED'), {
      event: 'WORK_PROMPT_DETECTED',
      payload: { issueNumber: 127, requestId: 'REQ_GUARD_TEST', hostPid: 34728 },
    })
  } finally { stopPostSubmitGuard(handle) }
})

test('startPostSubmitGuard should block only the request on an unknown modal event', async () => {
  class FakeChild extends EventEmitter {
    constructor() { super(); this.stdout = new PassThrough(); this.stderr = new PassThrough() }
    kill() { this.emit('close', null) }
  }
  const child = new FakeChild()
  const calls = []
  const runtime = {
    getRequest: () => ({ status: 'WAITING' }),
    journal: (event, payload) => calls.push({ event, payload }),
    markExternalFailure: (input) => calls.push({ event: 'MARK_EXTERNAL_FAILURE', payload: input }),
  }
  const handle = startPostSubmitGuard({
    runtime,
    requestId: 'REQ_GUARD_BLOCK_TEST',
    issueNumber: 128,
    confirmation: { hostPid: 34728, hostHwnd: '0x280788' },
    spawn: () => child,
    guardPath: 'guard.ps1',
  })
  try {
    child.stdout.write(JSON.stringify({ event: 'UNKNOWN_POST_SUBMIT_MODAL', requestId: 'REQ_GUARD_BLOCK_TEST', modalName: 'Other dialog' }) + '\n')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls.find((entry) => entry.event === 'MARK_EXTERNAL_FAILURE'), {
      event: 'MARK_EXTERNAL_FAILURE',
      payload: { requestId: 'REQ_GUARD_BLOCK_TEST', status: 'POST_SUBMIT_GUARD_BLOCKED', error: 'UNKNOWN_POST_SUBMIT_MODAL: Other dialog' },
    })
  } finally { stopPostSubmitGuard(handle) }
})

test('createGitHubIssue should parse the URL emitted by installed gh CLI', async () => {
  const result = await createGitHubIssue({
    requestId: 'REQ_TRANSPORT_001',
    runner: async () => ({ stdout: 'https://github.com/AndrewVerhoturov1/dsh-workspace/issues/321\n', stderr: '' }),
  })
  assert.deepEqual(result, {
    repository: 'AndrewVerhoturov1/dsh-workspace',
    issueNumber: 321,
    url: 'https://github.com/AndrewVerhoturov1/dsh-workspace/issues/321',
  })
})

test('createAndSubmitExternal should leave a recoverable explicit failure when submit is not confirmed', async () => {
  const f = fixture()
  try {
    const result = await createAndSubmitExternal({
      runtime: f.runtime,
      request: f.request,
      issueCreator: async (input) => ({ repository: input.repository, issueNumber: 124 }),
      submitter: async () => { throw new Error('SUBMIT_NOT_CONFIRMED') },
    })
    assert.equal(result.status, 'CHAT_SUBMIT_FAILED')
    assert.equal(f.runtime.getRequest(f.request.request_id).status, 'CHAT_SUBMIT_FAILED')
    assert.match(f.runtime.getRequest(f.request.request_id).error, /SUBMIT_NOT_CONFIRMED/)
  } finally { f.close() }
})

test('createAndSubmitExternal should reuse the persisted Issue when retrying a failed submission', async () => {
  const f = fixture()
  try {
    f.runtime.registerExternalIssue({ requestId: f.request.request_id, repository: 'AndrewVerhoturov1/dsh-workspace', issueNumber: 125 })
    f.runtime.markExternalFailure({ requestId: f.request.request_id, status: 'CHAT_SUBMIT_FAILED', error: 'temporary bridge failure' })
    let issueCreateCalls = 0
    const result = await createAndSubmitExternal({
      runtime: f.runtime,
      request: f.runtime.getRequest(f.request.request_id),
      issueCreator: async () => { issueCreateCalls += 1; throw new Error('must reuse existing Issue') },
      submitter: async ({ prompt }) => ({ ok: true, submitted: true, userMessageConfirmed: true, prompt }),
    })

    assert.equal(result.status, 'WAITING')
    assert.equal(issueCreateCalls, 0)
    assert.equal(f.runtime.getRequest(f.request.request_id).issue_number, 125)
  } finally { f.close() }
})

test('createAndSubmitExternal should not move a request to WAITING when Issue creation fails', async () => {
  const f = fixture()
  try {
    const result = await createAndSubmitExternal({
      runtime: f.runtime,
      request: f.request,
      issueCreator: async () => { throw new Error('gh unavailable') },
      submitter: async () => { throw new Error('must not run') },
    })
    assert.equal(result.status, 'ISSUE_CREATE_FAILED')
    assert.equal(f.runtime.getRequest(f.request.request_id).status, 'ISSUE_CREATE_FAILED')
  } finally { f.close() }
})

test('transport hashes used by the runtime are stable UTF-8 SHA-256 values', () => {
  assert.equal(createHash('sha256').update('M6_OK', 'utf8').digest('hex').length, 64)
})
