import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DirectPostmanJobManager } from './direct-current-turn.js'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.off = child.removeListener.bind(child)
  return child
}

function makeManager(child) {
  return new DirectPostmanJobManager({
    exists: () => true,
    now: () => new Date('2026-09-22T20:00:00Z'),
    randomInt: () => 1234,
    spawn: () => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
    pwsh: 'pwsh.exe',
  })
}

async function completeTextJob(manager, child, sessionId, fields) {
  const started = await manager.start({
    sessionId,
    workspace: '/workspace',
    payload: 'probe',
    transportKind: 'text',
    proof: { parseMode: 'fresh' },
  })
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    ok: true,
    code: 'TEXT_RESULT_DURABLE',
    state: 'TEXT_RESULT_DURABLE',
    requestId: started.requestId,
    ...fields(started.requestId),
  }), 'utf8'))
  child.emit('close', 0, null)
  return { started, result: manager.view(sessionId).result }
}

test('file PostmanAsk result is verified from disk without exposing assistantText', async () => {
  const root = mkdtempSync(join(tmpdir(), 'postman-ask-file-'))
  try {
    const child = fakeChild()
    const manager = makeManager(child)
    const text = 'Большой ответ\n'.repeat(500)
    const bytes = Buffer.from(text, 'utf8')
    const sha = createHash('sha256').update(bytes).digest('hex')

    const { started, result } = await completeTextJob(manager, child, 'session-file', (requestId) => {
      const name = `POSTMAN_${requestId}_ANSWER.md`
      const path = join(root, name)
      writeFileSync(path, bytes)
      return {
        deliveryMode: 'file',
        resultFile: path,
        resultFileName: name,
        resultMimeType: 'text/markdown',
        resultEncoding: 'utf-8',
        resultFileSha256: sha,
        assistantTextLength: text.length,
        assistantTextByteLength: bytes.length,
        assistantTextSha256: sha,
      }
    })

    assert.equal(result.ok, true)
    assert.equal(result.deliveryMode, 'file')
    assert.equal(result.assistantText, undefined)
    assert.equal(result.assistantTextSha256, sha)
    assert.equal(manager.validateExactAskReply('session-file', started.requestId, text).status, 'EXACT_REPLY_UNAVAILABLE')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file PostmanAsk result rejects any inline assistantText duplication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'postman-ask-file-dup-'))
  try {
    const child = fakeChild()
    const manager = makeManager(child)
    const text = 'x'.repeat(5000)
    const bytes = Buffer.from(text, 'utf8')
    const sha = createHash('sha256').update(bytes).digest('hex')

    const { result } = await completeTextJob(manager, child, 'session-file-dup', (requestId) => {
      const name = `POSTMAN_${requestId}_ANSWER.md`
      const path = join(root, name)
      writeFileSync(path, bytes)
      return {
        deliveryMode: 'file',
        assistantText: text,
        resultFile: path,
        resultFileName: name,
        resultMimeType: 'text/markdown',
        resultEncoding: 'utf-8',
        resultFileSha256: sha,
        assistantTextLength: text.length,
        assistantTextByteLength: bytes.length,
        assistantTextSha256: sha,
      }
    })

    assert.equal(result.ok, false)
    assert.equal(result.code, 'POSTMAN_TEXT_RESULT_FILE_CONTAINS_INLINE_TEXT')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file PostmanAsk result rejects bytes that do not match descriptor SHA', async () => {
  const root = mkdtempSync(join(tmpdir(), 'postman-ask-file-sha-'))
  try {
    const child = fakeChild()
    const manager = makeManager(child)
    const expected = Buffer.from('expected', 'utf8')
    const actual = Buffer.from('tampered', 'utf8')
    const sha = createHash('sha256').update(expected).digest('hex')

    const { result } = await completeTextJob(manager, child, 'session-file-sha', (requestId) => {
      const name = `POSTMAN_${requestId}_ANSWER.md`
      const path = join(root, name)
      writeFileSync(path, actual)
      return {
        deliveryMode: 'file',
        resultFile: path,
        resultFileName: name,
        resultMimeType: 'text/markdown',
        resultEncoding: 'utf-8',
        resultFileSha256: sha,
        assistantTextLength: 8,
        assistantTextByteLength: actual.length,
        assistantTextSha256: sha,
      }
    })

    assert.equal(result.ok, false)
    assert.equal(result.code, 'POSTMAN_TEXT_RESULT_FILE_SHA_MISMATCH')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy inline PostmanAsk receipt remains exact-validator compatible', async () => {
  const child = fakeChild()
  const manager = makeManager(child)
  const text = 'Короткий exact ответ'
  const sha = createHash('sha256').update(text, 'utf8').digest('hex')

  const { started, result } = await completeTextJob(manager, child, 'session-inline', () => ({
    assistantText: text,
    assistantTextSha256: sha,
  }))

  assert.equal(result.ok, true)
  assert.equal(result.deliveryMode, 'inline')
  assert.equal(result.assistantText, text)
  assert.equal(manager.validateExactAskReply('session-inline', started.requestId, text).status, 'EXACT_REPLY_MATCH')
})
