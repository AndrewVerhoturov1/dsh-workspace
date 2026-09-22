import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  DirectPostmanJobManager,
  parsePostmanUserTurn,
} from './direct-current-turn.js'

const REQ = 'REQ_20260922T010203Z_1234'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

test('PostmanAsk parser preserves exact payload and selects text transport', () => {
  const parsed = parsePostmanUserTurn('  @PostmanAsk\nстрока 1\n  строка 2  ')
  assert.equal(parsed.mode, 'fresh')
  assert.equal(parsed.transportKind, 'text')
  assert.equal(parsed.payload, 'строка 1\n  строка 2  ')
  assert.equal(parsed.removedTransportPrefix, '  @PostmanAsk\n')
})

test('PostmanAsk --chat removes only transport metadata', () => {
  const parsed = parsePostmanUserTurn(`@PostmanAsk --chat ${REQ}\nуточни второй вариант`)
  assert.equal(parsed.mode, 'chat')
  assert.equal(parsed.transportKind, 'text')
  assert.equal(parsed.chatRequestId, REQ)
  assert.equal(parsed.payload, 'уточни второй вариант')
})

test('artifact Postman remains artifact transport', () => {
  const parsed = parsePostmanUserTurn('@Postman обычная задача')
  assert.equal(parsed.transportKind, 'artifact')
  assert.equal(parsed.payload, 'обычная задача')
})


test('default job remains artifact transport and routes to postman.ps1', async () => {
  let spawned
  const child = fakeChild()
  const manager = new DirectPostmanJobManager({
    exists: () => true,
    now: () => new Date('2026-09-22T01:02:03Z'),
    randomInt: () => 2468,
    spawn: (command, args, options) => {
      spawned = { command, args, options }
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
    pwsh: 'pwsh.exe',
  })

  const started = await manager.start({
    sessionId: 'session-artifact',
    workspace: 'C:\\workspace',
    payload: 'обычная ZIP-задача',
  })
  assert.equal(started.transportKind, 'artifact')
  assert.match(spawned.args.find((value) => String(value).endsWith('.ps1')), /postman\.ps1$/)

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    ok: true,
    code: 'RESULT_DURABLE',
    state: 'RESULT_DURABLE',
    requestId: started.requestId,
    resultZip: 'D:/result.zip',
  }), 'utf8'))
  child.emit('close', 0, null)

  const completed = manager.view('session-artifact')
  assert.equal(completed.status, 'COMPLETED')
  assert.equal(completed.result.code, 'RESULT_DURABLE')
})

test('text job routes to postman-ask.ps1 and accepts only TEXT_RESULT_DURABLE', async () => {
  let spawned
  const child = fakeChild()
  const manager = new DirectPostmanJobManager({
    exists: () => true,
    now: () => new Date('2026-09-22T01:02:03Z'),
    randomInt: () => 1234,
    spawn: (command, args, options) => {
      spawned = { command, args, options }
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
    pwsh: 'pwsh.exe',
  })

  const started = await manager.start({
    sessionId: 'session-1',
    workspace: 'C:\\workspace',
    payload: 'исследуй вопрос',
    transportKind: 'text',
    proof: { parseMode: 'fresh' },
  })
  assert.equal(started.transportKind, 'text')
  assert.match(spawned.args.find((value) => String(value).endsWith('.ps1')), /postman-ask\.ps1$/)
  assert.equal(spawned.options.windowsHide, true)

  const assistantText = 'Готовый ответ'
  const { createHash } = await import('node:crypto')
  const assistantTextSha256 = createHash('sha256').update(assistantText, 'utf8').digest('hex')
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    ok: true,
    code: 'TEXT_RESULT_DURABLE',
    state: 'TEXT_RESULT_DURABLE',
    requestId: started.requestId,
    assistantText,
    assistantTextSha256,
  }), 'utf8'))
  child.emit('close', 0, null)

  const completed = manager.view('session-1')
  assert.equal(completed.status, 'COMPLETED')
  assert.equal(completed.result.code, 'TEXT_RESULT_DURABLE')
  assert.equal(completed.result.assistantText, assistantText)
})

test('text job rejects artifact success terminal', async () => {
  const child = fakeChild()
  const manager = new DirectPostmanJobManager({
    exists: () => true,
    now: () => new Date('2026-09-22T01:02:03Z'),
    randomInt: () => 4321,
    spawn: () => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
    pwsh: 'pwsh.exe',
  })
  const started = await manager.start({
    sessionId: 'session-2',
    workspace: 'C:\\workspace',
    payload: 'текст',
    transportKind: 'text',
  })
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    ok: true,
    code: 'RESULT_DURABLE',
    state: 'RESULT_DURABLE',
    requestId: started.requestId,
    resultZip: 'x.zip',
  }), 'utf8'))
  child.emit('close', 0, null)
  assert.equal(manager.view('session-2').result.code, 'POSTMAN_RESULT_GATE_FAILED')
})
