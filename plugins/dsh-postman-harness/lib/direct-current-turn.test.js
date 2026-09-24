import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  CurrentUserTurnStore,
  DirectPostmanJobManager,
  createDirectCurrentTurnToolConfigs,
  parsePostmanUserTurn,
} from './direct-current-turn.js'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.off = child.removeListener.bind(child)
  return child
}

function userEvent(text, seq = 1) {
  return {
    type: 'user/message',
    seq,
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  }
}

test('fresh parser preserves long Markdown, backticks, quotes, slashes and trailing file list exactly', () => {
  const payload = [
    'Большой prompt.',
    '',
    'Inline `sources.md` and ${value} and "quotes" and \\ slash.',
    '',
    '```text',
    'внутренний fenced block',
    '```',
    '',
    'README.md',
    '01-plan.md',
    'sources.md',
  ].join('\n')
  const raw = `@Postman\n${payload}`
  const parsed = parsePostmanUserTurn(raw)
  assert.equal(parsed.mode, 'fresh')
  assert.equal(parsed.payload, payload)
  assert.equal(parsed.removedTransportPrefix, '@Postman\n')
  assert.equal(raw, parsed.removedTransportPrefix + parsed.payload)
})

test('parser preserves exactly one remaining separator after the transport separator', () => {
  const parsed = parsePostmanUserTurn('@Postman\n\nsecond newline remains')
  assert.equal(parsed.payload, '\nsecond newline remains')
})

test('manual --chat parser removes only transport metadata and preserves intent exactly', () => {
  const req = 'REQ_20260921T193936Z_3678'
  const payload = 'исправь баланс кавалерии\n```json\n{"x":"`"}\n```'
  const raw = `  @Postman --chat ${req} ${payload}`
  const parsed = parsePostmanUserTurn(raw)
  assert.equal(parsed.mode, 'chat')
  assert.equal(parsed.chatRequestId, req)
  assert.equal(parsed.payload, payload)
  assert.equal(raw, parsed.removedTransportPrefix + parsed.payload)
})

test('reserved malformed --chat syntax fails closed', () => {
  assert.throws(() => parsePostmanUserTurn('@Postman --chat BAD x'), /POSTMAN_CHAT_TRIGGER_PARSE_FAILED/)
  assert.throws(() => parsePostmanUserTurn('@Postman --chat REQ_20260921T193936Z_3678 '), /POSTMAN_EMPTY_PAYLOAD/)
})

test('current-turn store records only exact single-text user messages and tracks consumption', () => {
  const listeners = new Map()
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
  }
  const store = new CurrentUserTurnStore(ctx)
  listeners.get('session/event')({ id: 's1' }, userEvent('@Postman x', 7))
  const record = store.get('s1')
  assert.equal(record.text, '@Postman x')
  assert.equal(record.consumed, false)
  assert.equal(store.consume('s1', 7), true)
  assert.equal(store.get('s1').consumed, true)
  store.dispose()
})

test('current-turn store fails closed for mixed/attachment content instead of reconstructing text', () => {
  const listeners = new Map()
  const store = new CurrentUserTurnStore({ on(name, listener) { listeners.set(name, listener); return () => {} } })
  listeners.get('session/event')({ id: 's1' }, {
    type: 'user/message',
    seq: 8,
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '@Postman x' }, { type: 'image', data: 'ignored' }],
    },
  })
  assert.equal(store.get('s1').error, 'POSTMAN_CURRENT_TURN_UNSUPPORTED_CONTENT')
})

test('job manager sends exact payload only as UTF-8 Base64 to the existing Direct bridge', async () => {
  const child = fakeChild()
  let invocation
  const manager = new DirectPostmanJobManager({
    exists: () => true,
    now: () => new Date('2026-09-22T12:34:56.000Z'),
    randomInt: () => 42,
    pwsh: 'pwsh-test',
    spawn(command, args, options) {
      invocation = { command, args, options }
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  })
  const payload = 'строка `x`\n```text\n${value}\\\n```\nREADME.md'
  const started = await manager.start({ sessionId: 's1', workspace: '/repo', payload, proof: {} })
  assert.equal(started.requestId, 'REQ_20260922T123456Z_0042')
  assert.equal(invocation.command, 'pwsh-test')
  const b64Index = invocation.args.indexOf('-TaskBase64')
  assert.notEqual(b64Index, -1)
  assert.equal(Buffer.from(invocation.args[b64Index + 1], 'base64').toString('utf8'), payload)
  assert.equal(invocation.args.includes('-Task'), false)
  assert.match(invocation.args[invocation.args.indexOf('-File') + 1], /postman[\\/]direct[\\/]postman\.ps1$/)

  child.stdout.emit('data', Buffer.from(JSON.stringify({
    ok: true,
    code: 'RESULT_DURABLE',
    state: 'RESULT_DURABLE',
    requestId: started.requestId,
    resultZip: 'D:/result.zip',
  })))
  child.emit('close', 0, null)
  const terminal = await manager.wait('s1', 1)
  assert.equal(terminal.status, 'COMPLETED')
  assert.equal(terminal.result.code, 'RESULT_DURABLE')
})


test('parallel sessions retry a colliding REQ without mixing jobs', async () => {
  const ids = [11, 11, 12]
  const children = []
  const manager = new DirectPostmanJobManager({
    exists: () => true,
    now: () => new Date('2026-09-24T12:34:56.000Z'),
    randomInt: () => ids.shift(),
    spawn() {
      const child = fakeChild()
      children.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  })
  const [first, second] = await Promise.all([
    manager.start({ sessionId: 'child-a', workspace: '/repo', payload: 'A' }),
    manager.start({ sessionId: 'child-b', workspace: '/repo', payload: 'B' }),
  ])
  assert.equal(children.length, 2)
  assert.notEqual(first.requestId, second.requestId)
  assert.equal(manager.latest('child-a').requestId, first.requestId)
  assert.equal(manager.latest('child-b').requestId, second.requestId)
  children.forEach(child => child.emit('close', 2, null))
})

test('tool surface has no task/payload/prompt arguments', () => {
  const listeners = new Map()
  const bridge = createDirectCurrentTurnToolConfigs({ on(name, listener) { listeners.set(name, listener); return () => {} } }, {
    jobs: { dispose() {} },
  })
  assert.deepEqual(bridge.tools.map(tool => tool.name), [
    'postman_send_current_turn',
    'postman_current_turn_status',
    'postman_ask_validate_reply',
    'postman_continue_last_request',
  ])
  for (const tool of bridge.tools.filter(tool => tool.name !== 'postman_ask_validate_reply')) {
    assert.deepEqual(tool.parameters, {})
  }
  bridge.dispose()
})

test('send_current_turn reads captured runtime text, not model arguments, and consumes it only after spawn', async () => {
  const listeners = new Map()
  const child = fakeChild()
  let invocation
  const ctx = { on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) } }
  const jobs = new DirectPostmanJobManager({
    exists: () => true,
    now: () => new Date('2026-09-22T12:34:56.000Z'),
    randomInt: () => 7,
    spawn(command, args, options) {
      invocation = { command, args, options }
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  })
  const bridge = createDirectCurrentTurnToolConfigs(ctx, { jobs })
  const raw = '@Postman\nполный prompt\n`README.md`'
  listeners.get('session/event')({ id: 's1' }, userEvent(raw, 11))
  const agent = { id: 's1', session: { header: { cwd: '/repo' } } }
  const result = await bridge.tools[0].execute({}, { agent })
  assert.equal(result.status, 'STARTED')
  assert.equal(bridge.store.get('s1').consumed, true)
  const b64 = invocation.args[invocation.args.indexOf('-TaskBase64') + 1]
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'полный prompt\n`README.md`')
  await assert.rejects(bridge.tools[0].execute({}, { agent }), /POSTMAN_CURRENT_TURN_ALREADY_USED/)
  bridge.dispose()
})

test('automatic continuation is deterministic and does not accept model-written text', async () => {
  const children = []
  const invocations = []
  const manager = new DirectPostmanJobManager({
    exists: () => true,
    now: (() => {
      const values = [new Date('2026-09-22T12:34:56.000Z'), new Date('2026-09-22T12:35:56.000Z')]
      return () => values.shift()
    })(),
    randomInt: (() => { const xs = [1, 2]; return () => xs.shift() })(),
    spawn(command, args, options) {
      const child = fakeChild()
      children.push(child)
      invocations.push({ command, args, options })
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  })
  const first = await manager.start({ sessionId: 's1', workspace: '/repo', payload: 'x', proof: {} })
  children[0].stdout.emit('data', Buffer.from(JSON.stringify({
    ok: true,
    code: 'ASSISTANT_COMPLETED_NO_ARTIFACT',
    state: 'ASSISTANT_COMPLETED_NO_ARTIFACT',
    requestId: first.requestId,
    assistantText: 'progress',
  })))
  children[0].emit('close', 0, null)

  const second = await manager.continueLast('s1', '/repo')
  assert.equal(second.chatRequestId, first.requestId)
  const args = invocations[1].args
  assert.equal(args.includes('-AutomaticContinuation'), true)
  assert.equal(args[args.indexOf('-ChatRequestId') + 1], first.requestId)
  const payload = Buffer.from(args[args.indexOf('-TaskBase64') + 1], 'base64').toString('utf8')
  assert.match(payload, /^Продолжи выполнение предыдущей задачи/)
})
