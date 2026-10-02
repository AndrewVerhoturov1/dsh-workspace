import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CurrentUserTurnStore, DirectPostmanJobManager, createDirectCurrentTurnToolConfigs, parsePostmanUserTurn } from './direct-current-turn.js'

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


test('input descriptors are transport metadata, not semantic Luna payload', () => {
  const file = { name: 'reference.png', repository: 'AndrewVerhoturov1/dsh-workspace',
    commit: 'a'.repeat(40), path: 'img/reference.png', sha256: 'b'.repeat(64), byte_length: 12 }
  const metadata = '--input-files-json ' + JSON.stringify([file]) + '\n'
  const fresh = parsePostmanUserTurn('@PostmanImage ' + metadata + 'Draw exactly')
  assert.equal(fresh.payload, 'Draw exactly')
  assert.deepEqual(fresh.inputFiles, [file])
  const chat = parsePostmanUserTurn('@PostmanAsk --chat REQ_20260921T193936Z_3678 ' + metadata + 'Describe')
  assert.equal(chat.payload, 'Describe')
  assert.deepEqual(chat.inputFiles, [file])
  assert.equal(parsePostmanUserTurn('@PostmanAsk --chat REQ_20260921T193936Z_3678 Describe').inputFiles, undefined)
  assert.throws(() => parsePostmanUserTurn('@Postman --input-files-json nope\nintent'), /POSTMAN_INPUT_METADATA_INVALID/)
})

test('Direct job forwards only descriptor JSON and keeps text intent separate', async () => {
  const file = { name: 'note.md', repository: 'AndrewVerhoturov1/dsh-workspace', commit: 'a'.repeat(40),
    path: 'docs/note.md', sha256: 'b'.repeat(64), byte_length: 12 }
  let argv
  const binding = Object.freeze({})
  let cleaned = false
  const manager = new DirectPostmanJobManager({ exists: () => true,
    inputGrants: { async build(record, sessionId, requestId, descriptors) {
      assert.equal(record, binding); assert.equal(sessionId, 'input-test'); assert.deepEqual(descriptors, [file])
      return { handoffPath: '/host-private/input-handoff.json', cleanup() { cleaned = true } }
    } },
    spawn(_command, args) { argv = args; const child = fakeChild(); queueMicrotask(() => child.emit('spawn')); return child } })
  await manager.start({ sessionId: 'input-test', workspace: '/repo', branch: 'task/postman-1234567890abcdef1234567890abcdef',
    payload: 'Exact intent', inputFiles: [file], inputBinding: binding, transportKind: 'text' })
  assert.deepEqual(JSON.parse(Buffer.from(argv[argv.indexOf('-InputFilesBase64') + 1], 'base64').toString('utf8')), [file])
  assert.equal(Buffer.from(argv[argv.indexOf('-TaskBase64') + 1], 'base64').toString('utf8'), 'Exact intent')
  assert.equal(argv[argv.indexOf('-InputBundleManifest') + 1], '/host-private/input-handoff.json')
  assert.equal(cleaned, false)
  manager.latest('input-test').child.emit('close', 0)
  assert.equal(cleaned, true)
})

test('Host bundle rejection occurs before spawn and remains correlated proven-unsent status', async () => {
  const manager = new DirectPostmanJobManager({ exists: () => true,
    spawn() { assert.fail('must not spawn') } })
  await assert.rejects(manager.start({ sessionId: 'forged-input', workspace: '/repo', payload: 'intent', branch: 'main',
    inputFiles: [{ name: 'file.txt' }] }), /POSTMAN_INPUT_PROVENANCE_REJECTED/)
  const current = manager.view('forged-input')
  assert.equal(current.status, 'COMPLETED')
  assert.equal(current.result.transportCode, 'POSTMAN_INPUT_PROVENANCE_REJECTED')
  assert.equal(current.result.details.sendState, 'PROVEN_NOT_SENT')
  assert.equal(current.result.details.inputBundlePhase, 'host-build')
  assert.equal(current.result.requestId, current.requestId)
})

test('Host helper infrastructure errors retain allocated REQ as proven-unsent without spawning Direct', async (t) => {
  for (const [name, error] of [
    ['helper spawn failure', Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' })],
    ['malformed helper output', new SyntaxError('Unexpected token in helper JSON')],
  ]) await t.test(name, async () => {
    const manager = new DirectPostmanJobManager({ exists: () => true,
      inputGrants: { async build() { throw error } },
      spawn() { assert.fail('must not spawn Direct') } })
    await assert.rejects(manager.start({ sessionId: name, workspace: '/repo', payload: 'intent', branch: 'main',
      inputFiles: [{ name: 'file.txt' }] }), /POSTMAN_INPUT_BUNDLE_BUILD_FAILED/)
    const current = manager.view(name)
    assert.equal(current.status, 'COMPLETED')
    assert.equal(current.result.code, 'POSTMAN_TRANSPORT_FAILED')
    assert.equal(current.result.requestId, manager.latest(name).requestId)
    assert.equal(current.result.transportCode, 'POSTMAN_INPUT_BUNDLE_BUILD_FAILED')
    assert.deepEqual(current.result.details, { sendState: 'PROVEN_NOT_SENT', inputBundlePhase: 'host-build' })
    assert.equal(JSON.stringify(current.result).includes(error.message), false)
  })
})

test('native descriptors parse in all three modes without GitHub coordinates', () => {
  const file = { source_kind: 'native', name: 'reference.png', sha256: 'b'.repeat(64), byte_length: 12, media_type: 'image/png' }
  for (const mode of ['Postman', 'PostmanAsk', 'PostmanImage']) {
    const turn = parsePostmanUserTurn('@' + mode + ' --input-files-json ' + JSON.stringify([file]) + '\nExact intent')
    assert.deepEqual(turn.inputFiles, [file]); assert.equal(turn.payload, 'Exact intent')
    assert.throws(() => parsePostmanUserTurn('@' + mode + ' --input-files-json ' + JSON.stringify([{...file,path:'C:/secret'}]) + '\nintent'), /METADATA_INVALID/)
  }
})

test('image Direct start uses Host image builder before spawn and forwards private handoff', async () => {
  const file = { source_kind: 'native', name: 'reference.png', sha256: 'b'.repeat(64), byte_length: 12, media_type: 'image/png' }
  let argv, built = false
  const manager = new DirectPostmanJobManager({ exists: () => true,
    inputGrants: { async build(record, session, req, descriptors, kind) {
      assert.equal(kind, 'image'); assert.deepEqual(descriptors, [file]); built = true
      return { handoffPath: '/private/image-handoff.json', cleanup() {} }
    } }, spawn(_cmd,args) { assert.equal(built,true); argv=args; const child=fakeChild(); queueMicrotask(()=>child.emit('spawn')); return child } })
  await manager.start({ sessionId:'native-image', workspace:'/repo', branch:'task/postman-1234567890abcdef1234567890abcdef', payload:'Exact intent', inputFiles:[file], inputBinding:{}, transportKind:'image' })
  assert.equal(argv.includes('-ImageMode'),true)
  assert.equal(argv[argv.indexOf('-InputBundleManifest')+1],'/private/image-handoff.json')
  manager.latest('native-image').child.emit('close',0)
})

test('image parser preserves exact payload and rejects manual chat', () => {
  const raw = '  @PostmanImage\nDraw a cat  '
  assert.deepEqual(parsePostmanUserTurn(raw), { mode: 'fresh', transportKind: 'image',
    chatRequestId: undefined, payload: 'Draw a cat  ', removedTransportPrefix: '  @PostmanImage\n' })
  assert.throws(() => parsePostmanUserTurn('@PostmanImage --chat REQ_20260921T193936Z_3678 draw'), /POSTMAN_IMAGE_CHAT_NOT_ALLOWED/)
  assert.throws(() => parsePostmanUserTurn('@PostmanImage --chat BAD draw'), /POSTMAN_IMAGE_CHAT_NOT_ALLOWED/)
})

test('image transport requires exact durable descriptor and bytes, never grants artifact continuation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-image-gate-'))
  try {
    const image = join(directory, 'result.JPEG')
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    writeFileSync(image, bytes)
    const children = []
    const args = []
    const manager = new DirectPostmanJobManager({ exists: () => true, randomInt: (() => { let n = 0; return () => ++n })(),
      spawn(_command, argv) { const child = fakeChild(); children.push(child); args.push(argv); queueMicrotask(() => child.emit('spawn')); return child } })
    const descriptor = { ok: true, code: 'IMAGE_RESULT_DURABLE', state: 'IMAGE_RESULT_DURABLE', resultImage: image,
      imageFormat: 'jpg', imageSha256: createHash('sha256').update(bytes).digest('hex'), imageByteLength: bytes.length,
      imageWidth: 20, imageHeight: 30, imageMimeType: 'image/jpeg' }
    assert.equal(Object.hasOwn(descriptor, 'secondRequestId'), false)
    const cases = [
      [descriptor, 'IMAGE_RESULT_DURABLE'],
      [{ ...descriptor, resultZip: 'bad.zip' }, 'POSTMAN_IMAGE_RESULT_DESCRIPTOR_INVALID'],
      [{ ...descriptor, imageSha256: '0'.repeat(64) }, 'POSTMAN_IMAGE_RESULT_SHA_MISMATCH'],
      [{ ...descriptor, imageByteLength: bytes.length + 1 }, 'POSTMAN_IMAGE_RESULT_SHA_MISMATCH'],
      [{ ...descriptor, resultImage: join(directory, 'missing.jpeg') }, 'POSTMAN_IMAGE_RESULT_UNREADABLE'],
      [{ ...descriptor, resultImage: join(directory, 'invalid.gif') }, 'POSTMAN_IMAGE_RESULT_DESCRIPTOR_INVALID'],
      [{ ...descriptor, imageFormat: 'png' }, 'POSTMAN_IMAGE_RESULT_DESCRIPTOR_INVALID'],
      [{ ...descriptor, code: 'RESULT_DURABLE', state: 'RESULT_DURABLE' }, 'POSTMAN_RESULT_GATE_FAILED'],
    ]
    for (const [terminal, expected] of cases) {
      const started = await manager.start({ sessionId: 'image', workspace: '/repo', payload: 'draw', branch: 'main', transportKind: 'image' })
      assert.equal(started.transportKind, 'image')
      assert.equal(args.at(-1).includes('-ImageMode'), true)
      assert.equal(args.at(-1).includes('-AutomaticContinuation'), false)
      assert.match(args.at(-1)[args.at(-1).indexOf('-File') + 1], /postman[\\/]direct[\\/]postman\.ps1$/)
      children.at(-1).stdout.emit('data', JSON.stringify({ ...terminal, requestId: started.requestId }))
      children.at(-1).emit('close', 0)
      assert.equal(manager.view('image').result.code, expected)
      await assert.rejects(manager.continueLast('image', '/repo'), /POSTMAN_AUTOMATIC_CONTINUATION_NOT_ALLOWED/)
    }
    await assert.rejects(manager.start({ sessionId: 'image', workspace: '/repo', payload: 'draw', branch: 'main', transportKind: 'image', chatRequestId: 'REQ_20260921T193936Z_3678' }), /POSTMAN_IMAGE_CHAT_NOT_ALLOWED/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

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

test('current-turn store preserves one exact text beside attachments; ambiguous text stays unsupported', () => {
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
  assert.equal(store.get('s1').text, '@Postman x')
  assert.equal(store.get('s1').attachmentCount, 1)
  for (const content of [[{ type: 'text', text: '@Postman' }, { type: 'text', text: 'x' }],
    [{ type: 'image', data: 'ignored' }], [null, { type: 'text', text: '@Postman x' }]]) {
    store.capture({ id: 's1' }, { type: 'user/message', data: { source: { kind: 'user' }, content } })
    assert.equal(store.get('s1').error, 'POSTMAN_CURRENT_TURN_UNSUPPORTED_CONTENT')
  }
  store.dispose()
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
  const started = await manager.start({ sessionId: 's1', workspace: '/repo', payload, proof: {}, branch: 'main' })
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


test('failure publication receipt must match exact task branch, REQ and pinned URL', async () => {
  for (const mutate of [null, receipt => { receipt.taskUrl += '?wrong=1' },
    receipt => { receipt.branch = 'main' }, receipt => { receipt.requestId = 'REQ_20260922T123456Z_9999' }]) {
    const child = fakeChild()
    let checkpoint
    const manager = new DirectPostmanJobManager({ exists: () => true,
      directRoot: '/trusted', readPublicationState: path => {
        assert.ok(path.replaceAll('\\', '/').endsWith('/trusted/requests/REQ_20260922T123456Z_0042.json'))
        return JSON.stringify(checkpoint)
      },
      now: () => new Date('2026-09-22T12:34:56.000Z'), randomInt: () => 42,
      spawn() { queueMicrotask(() => child.emit('spawn')); return child } })
    const branch = 'task/postman-' + 'c'.repeat(32)
    const started = await manager.start({ sessionId: 'failure', workspace: '/repo', payload: 'intent', branch })
    const receipt = { requestId: started.requestId, repository: 'AndrewVerhoturov1/dsh-workspace', branch,
      taskUrl: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'b'.repeat(40) + '/' + started.requestId + '.md',
      baseCommit: 'a'.repeat(40), taskPublicationCommit: 'b'.repeat(40) }
    checkpoint = { ...receipt, state: 'FAILED' }
    mutate?.(receipt)
    child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, code: 'POSTMAN_TRANSPORT_FAILED',
      requestId: started.requestId, transportCode: 'WEB_FAILED', transportMessage: 'lost', details: {},
      publicationReceipt: receipt })))
    child.emit('close', 2, null)
    const result = manager.view('failure').result
    assert.equal(result.ok, false)
    assert.equal(result.code, mutate ? 'POSTMAN_PUBLICATION_RECEIPT_INVALID' : 'POSTMAN_TRANSPORT_FAILED')
    if (!mutate) assert.deepEqual(result.publicationReceipt, receipt)
  }
})

test('standalone main failure receipt requires the same trusted checkpoint', async () => {
  const child = fakeChild()
  let checkpoint
  const manager = new DirectPostmanJobManager({ exists: () => true, directRoot: '/trusted',
    now: () => new Date('2026-09-22T12:34:56.000Z'), randomInt: () => 42,
    readPublicationState: () => JSON.stringify(checkpoint),
    spawn() { queueMicrotask(() => child.emit('spawn')); return child } })
  const started = await manager.start({ sessionId: 'standalone', workspace: '/repo', payload: 'intent', branch: 'main' })
  const receipt = { requestId: started.requestId, repository: 'AndrewVerhoturov1/dsh-workspace', branch: 'main',
    taskUrl: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'b'.repeat(40) + '/' + started.requestId + '.md',
    baseCommit: 'a'.repeat(40), taskPublicationCommit: 'b'.repeat(40) }
  checkpoint = { ...receipt, state: 'FAILED' }
  child.stdout.emit('data', JSON.stringify({ ok: false, code: 'POSTMAN_TRANSPORT_FAILED', requestId: started.requestId,
    transportCode: 'WEB_FAILED', transportMessage: 'lost', details: {}, publicationReceipt: receipt }))
  child.emit('close', 2)
  assert.deepEqual(manager.view('standalone').result.publicationReceipt, receipt)
})

test('failure fields never authorize publication without a matching checkpoint', async () => {
  const branch = 'task/postman-' + 'c'.repeat(32)
  for (const state of [null, { state: 'INIT' }, { state: 'FAILED', branch: 'task/postman-' + 'f'.repeat(32) }]) {
    const child = fakeChild()
    const manager = new DirectPostmanJobManager({ exists: () => true, directRoot: '/trusted',
      now: () => new Date('2026-09-22T12:34:56.000Z'), randomInt: () => 42,
      readPublicationState: () => { if (state === null) throw Error('missing'); return JSON.stringify(state) },
      spawn() { queueMicrotask(() => child.emit('spawn')); return child } })
    const started = await manager.start({ sessionId: 'no-checkpoint', workspace: '/repo', payload: 'intent', branch })
    const receipt = { requestId: started.requestId, repository: 'AndrewVerhoturov1/dsh-workspace', branch,
      taskUrl: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'b'.repeat(40) + '/' + started.requestId + '.md',
      baseCommit: 'a'.repeat(40), taskPublicationCommit: 'b'.repeat(40) }
    if (state) Object.assign(state, receipt, state.branch ? { branch: state.branch } : {})
    child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, code: 'POSTMAN_TRANSPORT_FAILED',
      requestId: started.requestId, transportCode: 'WEB_FAILED', transportMessage: 'lost', details: {},
      publicationReceipt: receipt })))
    child.emit('close', 2, null)
    assert.equal(manager.view('no-checkpoint').result.code, 'POSTMAN_PUBLICATION_RECEIPT_INVALID')
    assert.equal(manager.view('no-checkpoint').result.publicationReceipt, undefined)
  }
})

test('trusted failure checkpoint binds the second parent and three sequential requests', async () => {
  const branch = 'task/postman-' + 'c'.repeat(32)
  const parentA = 'a'.repeat(40)
  const parentB = 'b'.repeat(40)
  const commits = ['c', 'd', 'e'].map(ch => ch.repeat(40))
  const parents = [parentA, parentB, commits[1]]
  const children = []
  const checkpoints = new Map()
  let suffix = 0
  const manager = new DirectPostmanJobManager({ exists: () => true, directRoot: '/trusted',
    now: () => new Date('2026-09-22T12:34:56.000Z'), randomInt: () => ++suffix,
    readPublicationState: path => checkpoints.get(path.replaceAll('\\', '/')),
    spawn() { const child = fakeChild(); children.push(child); queueMicrotask(() => child.emit('spawn')); return child } })
  for (let i = 0; i < 3; i++) {
    const started = await manager.start({ sessionId: 'serial', workspace: '/repo', payload: 'question ' + i,
      transportKind: i === 2 ? 'text' : 'artifact', branch })
    const receipt = { requestId: started.requestId, repository: 'AndrewVerhoturov1/dsh-workspace', branch,
      taskUrl: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + commits[i] + '/' + started.requestId + '.md',
      baseCommit: parents[i], taskPublicationCommit: commits[i] }
    checkpoints.set('/trusted/requests/' + started.requestId + '.json', JSON.stringify({ ...receipt,
      state: i === 2 ? 'ASK_FAILED' : 'FAILED' }))
    children[i].stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, code: 'POSTMAN_TRANSPORT_FAILED',
      requestId: started.requestId, transportCode: 'WEB_FAILED', transportMessage: 'lost', details: {},
      publicationReceipt: receipt })))
    children[i].emit('close', 2, null)
    assert.deepEqual(manager.view('serial').result.publicationReceipt, receipt)
  }
  assert.equal(children.length, 3)
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
    manager.start({ sessionId: 'child-a', workspace: '/repo', payload: 'A', branch: 'main' }),
    manager.start({ sessionId: 'child-b', workspace: '/repo', payload: 'B', branch: 'main' }),
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
  const bridge = createDirectCurrentTurnToolConfigs(ctx, { jobs, taskContexts: { child: () => null } })
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
  const first = await manager.start({ sessionId: 's1', workspace: '/repo', payload: 'x', proof: {}, branch: 'main' })
  children[0].stdout.emit('data', Buffer.from(JSON.stringify({
    ok: true,
    code: 'ASSISTANT_COMPLETED_NO_ARTIFACT',
    state: 'ASSISTANT_COMPLETED_NO_ARTIFACT',
    requestId: first.requestId,
    rootRequestId: first.requestId,
    continuationIndex: 0,
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

test('Host permits two automatic continuations but blocks the third before child spawn', async () => {
  const children = []
  const manager = new DirectPostmanJobManager({
    exists: () => true,
    now: (() => { let n = 0; return () => new Date(Date.UTC(2026, 8, 22, 12, 34, ++n)) })(),
    randomInt: () => 7,
    spawn() {
      const child = fakeChild()
      children.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  })
  const terminal = (index, code = 'ASSISTANT_COMPLETED_NO_ARTIFACT') => {
    const job = manager.latest('chain')
    children[index].stdout.emit('data', JSON.stringify({ ok: true, code, state: code,
      requestId: job.requestId, rootRequestId: root.requestId, continuationIndex: index }))
    children[index].emit('close', 0, null)
  }
  const root = await manager.start({ sessionId: 'chain', workspace: '/repo', payload: 'intent', branch: 'main' })
  terminal(0)
  const first = await manager.continueLast('chain', '/repo')
  assert.equal(first.chatRequestId, root.requestId)
  terminal(1, 'ARTIFACT_REJECTED')
  const second = await manager.continueLast('chain', '/repo')
  assert.equal(second.chatRequestId, first.requestId)
  terminal(2)
  await assert.rejects(manager.continueLast('chain', '/repo'), /POSTMAN_AUTOMATIC_CONTINUATION_LIMIT_REACHED/)
  assert.equal(children.length, 3)
  assert.equal(manager.latest('chain').requestId, second.requestId)
})

test('Host refuses durable, text, and transport-failed terminals without retry', async () => {
  const manager = new DirectPostmanJobManager({ spawn() { throw Error('must not spawn') } })
  for (const code of ['RESULT_DURABLE', 'TEXT_RESULT_DURABLE', 'POSTMAN_TRANSPORT_FAILED']) {
    manager.jobs.set('terminal', { state: 'completed', requestId: 'REQ_20260922T123456Z_0001',
      result: { code, continuationIndex: 0 } })
    await assert.rejects(manager.continueLast('terminal', '/repo'), /POSTMAN_AUTOMATIC_CONTINUATION_NOT_ALLOWED/)
  }
  manager.jobs.set('terminal', { state: 'completed', requestId: 'REQ_20260922T123456Z_0001',
    result: { code: 'ASSISTANT_COMPLETED_NO_ARTIFACT', continuationIndex: 0 } })
  await assert.rejects(manager.start({ sessionId: 'terminal', workspace: '/repo', payload: 'intent',
    transportKind: 'text', automaticContinuation: true, branch: 'main' }),
  /POSTMAN_AUTOMATIC_CONTINUATION_NOT_ALLOWED/)
})
