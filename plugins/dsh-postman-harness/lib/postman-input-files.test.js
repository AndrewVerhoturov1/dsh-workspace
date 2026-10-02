import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createPtcAdapter } from './ptc-adapter.js'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { CurrentAttachmentStore, PostmanInputGrants, createPostmanInputFilesTool, postmanInputGrants } from './postman-input-files.js'
import { createPostmanBridgeTool } from './postman-bridge.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { postmanBridgeRestrictionForAgent, postmanPtcDirectCallGuard,
  postmanBridgeCallerAllowed, POSTMAN_INPUT_FILES_TOOL_NAME, POSTMAN_PTC_ONLY_LEADER_TOOLS } from './postman-bridge-core.js'

const file = Object.freeze({ name: 'reference.png', repository: 'AndrewVerhoturov1/dsh-workspace',
  commit: 'a'.repeat(40), path: 'tmp/123/reference.png', sha256: createHash('sha256').update('PNG-bytes').digest('hex'), byte_length: 9,
  raw_url: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'a'.repeat(40) + '/tmp/123/reference.png' })
function privateResult(root = mkdtempSync(join(tmpdir(), 'postman-grant-test-'))) {
  const path = join(root, '001.bin')
  writeFileSync(path, 'PNG-bytes')
  return { snapshotRoot: root, descriptors: [file], materializations: [{ snapshot_path: path,
    sha256: file.sha256, byte_length: file.byte_length }] }
}
function fixture(preset = 'postman-leader') {
  const agent = { id: 'leader', session: { header: { agentPreset: preset, delegationDepth: 0 } } }
  const task = { leaderSessionId: agent.id }
  const agents = new Map([[agent.id, agent]])
  const ctx = { agents: { get: id => agents.get(id) } }
  const contexts = { get: id => id === agent.id ? task : null }
  const grants = new PostmanInputGrants()
  const calls = []
  const run = async (_root, args) => {
    calls.push(args)
    const root = args[args.indexOf('--snapshot-dir') + 1]
    if (args[0] === '--stage') return { ...privateResult(root), bundle_id: 'f'.repeat(32) }
    if (args[0] === '--existing') return privateResult(root)
    return { bundle_id: args[1], removed: 1 }
  }
  const tool = createPostmanInputFilesTool(ctx, contexts, { grants, run })
  const execute = (args, caller = agent, parent) => tool.execute(args, { agent: caller, parent, signal: new AbortController().signal })
  return { agent, task, grants, tool, calls, execute, agents }
}

const image = (data = 'PNG-bytes', name = 'reference.png') => ({
  attachmentId: 'sha256:' + createHash('sha256').update(data).digest('hex'),
  mediaType: 'image/png', bytes: Buffer.byteLength(data), width: 1, height: 1, name,
})
function currentFixture(t, { preset = 'postman-leader', resolveAttachment } = {}) {
  const f = fixture(preset), listeners = new Map(), reads = [], snapshots = []
  f.agent.session.id = f.agent.id
  const ctx = { agents: { get: id => f.agents.get(id) }, on(name, listener) {
    listeners.set(name, listener); return () => listeners.delete(name)
  } }
  const store = new CurrentAttachmentStore(ctx)
  const taskContexts = { get: id => id === f.agent.id ? f.task : null }
  const run = async (_root, args) => {
    f.calls.push(args)
    const marker = args.indexOf('--snapshot-dir'), root = args[marker + 1]
    const paths = args.slice(1, marker)
    const descriptors = [], materializations = []
    for (const [index, path] of paths.entries()) {
      const data = readFileSync(path), sha256 = createHash('sha256').update(data).digest('hex')
      const name = basename(path), snapshot_path = join(root, String(index + 1).padStart(3, '0') + '.bin')
      const descriptor = { source_kind: 'native', name, sha256, byte_length: data.length, media_type: 'image/png' }
      snapshots.push({ name, sha256, byte_length: data.length })
      writeFileSync(snapshot_path, data)
      descriptors.push(descriptor); materializations.push({ snapshot_path, sha256, byte_length: data.length })
    }
    return { descriptors, materializations, bundle_id: 'f'.repeat(32) }
  }
  const tool = createPostmanInputFilesTool(ctx, taskContexts, { grants: f.grants, run, currentAttachments: store,
    resolveAttachment: async (ref, signal) => { reads.push(ref); return resolveAttachment ? resolveAttachment(ref, signal)
      : { ref, data: Buffer.from(ref.name === 'second.png' ? 'second-image' : 'PNG-bytes') } } })
  const emit = (refs, session = f.agent.session, source = { kind: 'user' }, role = 'user') =>
    listeners.get('session/event')(session, { type: 'user/message', data: { role, source,
      content: [...refs.map(attachment => ({ type: 'image', attachment })), { type: 'text', text: 'Describe image' }] } })
  const execute = args => tool.execute(args, { agent: f.agent, signal: new AbortController().signal })
  t.after(() => { f.grants.dispose(); store.dispose() })
  return { ...f, ctx, store, tool, emit, execute, reads, snapshots, listeners }
}

test('latest exact user image stages verified bytes without model paths or private output', async t => {
  const f = currentFixture(t), ref = image()
  f.emit([ref])
  const result = await f.execute({ action: 'stage_current_attachments' })
  assert.equal(result.status, 'POSTMAN_INPUT_READY')
  assert.equal(result.bundleId, 'f'.repeat(32))
  assert.deepEqual(f.reads, [ref])
  assert.deepEqual(f.snapshots, [{ name: ref.name, sha256: ref.attachmentId.slice(7), byte_length: ref.bytes }])
  assert.equal(f.grants.owns(f.agent, f.task, result.descriptors), true)
  const source = f.calls[0][1], root = f.calls[0].at(-1)
  assert.equal(existsSync(dirname(dirname(source))), false, 'private source root removed after stage')
  assert.equal(existsSync(root), true, 'existing snapshot retained by grant')
  for (const secret of [source, root, 'snapshot_path', 'PNG-bytes']) assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(result.descriptors[0].sha256, ref.attachmentId.slice(7))
  assert.equal(result.descriptors[0].byte_length, ref.bytes)
})

test('approved selection keeps its existing grant when a later user message replaces attachment authority', async t => {
  const f = currentFixture(t)
  f.emit([image()])
  const selected = await f.execute({ action: 'stage_current_attachments' })
  f.emit([])
  assert.equal((await f.execute({ action: 'stage_current_attachments' })).status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_UNAVAILABLE')
  assert.equal(f.grants.owns(f.agent, f.task, selected.descriptors), true, 'current store is not grant revocation')
})

test('new exact user message with no attachments clears authority; synthetic inputs are ignored', async t => {
  const f = currentFixture(t), ref = image()
  f.emit([ref])
  const current = f.store.get(f.agent)
  for (const source of [{ kind: 'plugin', plugin: 'reminder' }, { kind: 'subagent' }, { kind: 'model' }]) {
    f.emit([image('foreign')], f.agent.session, source)
    assert.equal(f.store.get(f.agent), current)
  }
  f.emit([image('system')], f.agent.session, { kind: 'user' }, 'system')
  assert.equal(f.store.get(f.agent), current)
  f.emit([])
  assert.equal((await f.execute({ action: 'stage_current_attachments' })).status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_UNAVAILABLE')
  f.emit([ref], f.agent.session, { kind: 'plugin', plugin: 'synthetic' })
  assert.equal((await f.execute({ action: 'stage_current_attachments' })).status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_UNAVAILABLE')
  assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0)
})

test('another Leader/session handle and same-ID foreign session object confer no authority', async t => {
  const f = currentFixture(t), ref = image(), other = { id: 'other-leader',
    session: { id: 'other-leader', header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
  f.agents.set(other.id, other)
  f.emit([ref], f.agent.session)
  const current = f.store.get(f.agent)
  f.emit([image('foreign')], other.session)
  const foreignId = f.store.get(other).attachments[0].selectionId
  assert.equal((await f.execute({ action: 'stage_current_attachments', selectionIds: [foreignId] })).status,
    'POSTMAN_INPUT_CURRENT_ATTACHMENT_MISMATCH')
  f.emit([image('foreign')], { ...f.agent.session })
  assert.equal(f.store.get(f.agent), current)
  assert.equal(current.attachments[0].ref, ref)
  assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0)
})

test('multiple current attachments require selection without reads; exact occurrence selectors stage only selected bytes', async t => {
  const f = currentFixture(t), refs = [image(), image('second-image', 'second.png')]
  f.emit(refs)
  const selection = await f.execute({ action: 'stage_current_attachments' })
  assert.equal(selection.status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_SELECTION_REQUIRED')
  assert.deepEqual(selection.attachments, refs.map((ref, index) => ({ selectionId: String(index + 1), ...ref })))
  assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0)
  const result = await f.execute({ action: 'stage_current_attachments', selectionIds: [selection.attachments[1].selectionId] })
  assert.equal(result.status, 'POSTMAN_INPUT_READY')
  assert.deepEqual(f.reads, [refs[1]])
  assert.equal(f.reads[0], refs[1], 'resolver receives exact captured ref, not metadata copy')
  assert.deepEqual(f.snapshots, [{ name: refs[1].name, sha256: refs[1].attachmentId.slice(7), byte_length: refs[1].bytes }])
})

test('same-SHA occurrences select first, second or both exact captured refs and names', async t => {
  for (const indexes of [[0], [1], [0, 1]]) {
    const f = currentFixture(t), refs = [image('PNG-bytes', 'before.png'), image('PNG-bytes', 'after.png')]
    f.emit(refs)
    const selection = await f.execute({ action: 'stage_current_attachments' })
    assert.equal(selection.status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_SELECTION_REQUIRED')
    assert.deepEqual(selection.attachments, refs.map((ref, index) => ({ selectionId: String(index + 1), ...ref })))
    assert.deepEqual(selection.attachments.map(item => item.selectionId), ['1', '2'])
    assert.equal(selection.attachments[0].attachmentId, selection.attachments[1].attachmentId)
    assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.snapshots.length, 0)
    const result = await f.execute({ action: 'stage_current_attachments',
      selectionIds: indexes.map(index => selection.attachments[index].selectionId) })
    assert.equal(result.status, 'POSTMAN_INPUT_READY')
    assert.equal(f.reads.length, indexes.length)
    indexes.forEach((index, n) => assert.equal(f.reads[n], refs[index], 'exact occurrence ref'))
    assert.deepEqual(result.descriptors.map(item => item.name), indexes.map(index => refs[index].name))
    assert.deepEqual(f.snapshots, indexes.map(index => ({ name: refs[index].name,
      sha256: refs[index].attachmentId.slice(7), byte_length: refs[index].bytes })))
  }
})

test('duplicate, unknown and stale occurrence selectors reject before resolver and publication', async t => {
  const f = currentFixture(t), refs = [image('PNG-bytes', 'before.png'), image('PNG-bytes', 'after.png')]
  f.emit(refs)
  const stale = (await f.execute({ action: 'stage_current_attachments' })).attachments.map(item => item.selectionId)
  // The new message has the same SHA/names/count; old selectors still confer no authority.
  f.emit(refs.map(ref => ({ ...ref })))
  const current = (await f.execute({ action: 'stage_current_attachments' })).attachments.map(item => item.selectionId)
  assert.equal(current.some(id => stale.includes(id)), false)
  for (const ids of [[stale[0]], [stale[1]], stale, ['unknown'], [current[0], stale[1]], [current[0], 'unknown']])
    assert.equal((await f.execute({ action: 'stage_current_attachments', selectionIds: ids })).status,
      'POSTMAN_INPUT_CURRENT_ATTACHMENT_MISMATCH')
  for (const ids of [[], [current[0], current[0]], Array.from({ length: 21 }, (_, n) => String(n + 1))])
    assert.equal((await f.execute({ action: 'stage_current_attachments', selectionIds: ids })).status, 'POSTMAN_INPUT_ARGUMENTS_INVALID')
  assert.equal((await f.execute({ action: 'stage_current_attachments', attachmentIds: [refs[0].attachmentId] })).status,
    'POSTMAN_INPUT_ARGUMENTS_INVALID', 'no parallel content-addressed selector API')
  assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.snapshots.length, 0)
})

test('resolved byte hash or length mismatch rejects the entire selection before publication', async t => {
  for (const data of ['WRONG!!!!', 'short']) {
    const f = currentFixture(t, { resolveAttachment: async ref => ({ ref, data: Buffer.from(data) }) })
    f.emit([image()])
    assert.equal((await f.execute({ action: 'stage_current_attachments' })).status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_MISMATCH')
    assert.equal(f.calls.length, 0)
  }
})

test('message replacement during resolution rejects before stage; store disposal drops authority', async t => {
  let f
  f = currentFixture(t, { resolveAttachment: async ref => { f.emit([]); return { ref, data: Buffer.from('PNG-bytes') } } })
  f.emit([image()])
  assert.equal((await f.execute({ action: 'stage_current_attachments' })).status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_MISMATCH')
  assert.equal(f.calls.length, 0)
  f.store.dispose()
  assert.equal(f.store.get(f.agent), undefined)
  assert.equal(f.listeners.has('session/event'), false)
})

test('current attachment limits are applied before resolution and publication', async t => {
  const f = currentFixture(t)
  for (const refs of [[{ ...image(), bytes: 16 * 1024 * 1024 + 1 }],
    Array.from({ length: 4 }, (_, n) => ({ ...image(String(n)), bytes: 16 * 1024 * 1024 }))]) {
    f.emit(refs)
    assert.equal((await f.execute({ action: 'stage_current_attachments', selectionIds: f.store.get(f.agent).attachments.map(item => item.selectionId) })).status,
      'POSTMAN_INPUT_BUNDLE_LIMIT_EXCEEDED')
  }
  assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0)
})

test('new action dispatches through actual QuickJS PTC and Host ToolRuntime; model-direct remains denied', async t => {
  const f = currentFixture(t, { preset: 'postman-leader-ptc' }), ctx = new Context()
  ctx.systemPrompt = { tools() {}, section() { return () => {} } }
  new ToolRuntime(ctx)
  ctx.agents = { get: id => f.agents.get(id) }
  f.agent.session.events = [{ type: 'turn/start' }]
  f.agent.session.append = () => {}
  f.agent.ctx = createScope(ctx, f.agent).ctx
  const emptyOutput = { schema: { type: 'object', additionalProperties: true }, render: () => [] }
  for (const name of postmanBridgeRestrictionForAgent(f.agent).allow) {
    if (name === 'ptc_execute') continue
    ctx.tools.register(name === POSTMAN_INPUT_FILES_TOOL_NAME ? f.tool : defineTool({ name, description: name,
      parameters: {}, output: emptyOutput, async execute() { return {} } }))
  }
  ctx.tools.guard(exec => postmanPtcDirectCallGuard(exec, id => f.agents.get(id)))
  const dispatches = []
  ctx.on('tools/pre-execute', (exec, next) => { if (exec.name === POSTMAN_INPUT_FILES_TOOL_NAME) dispatches.push(exec); return next() })
  const adapter = createPtcAdapter(ctx, { authorize: postmanBridgeCallerAllowed })
  ctx.tools.register(adapter.tool)
  f.agent.ctx.tools.restrict(postmanBridgeRestrictionForAgent(f.agent))
  adapter.refresh(f.agent)
  try {
    f.emit([image()])
    const direct = await ctx.tools.execute({ callId: 'direct-current', name: POSTMAN_INPUT_FILES_TOOL_NAME,
      arguments: { action: 'stage_current_attachments' }, agent: f.agent, signal: new AbortController().signal })
    assert.equal(direct.isError, true)
    assert.match(direct.error.message, /PTC_DIRECT_CALL_REJECTED/)
    assert.equal(f.calls.length, 0)
    const nested = await ctx.tools.execute({ callId: 'ptc-current', name: 'ptc_execute', agent: f.agent,
      signal: new AbortController().signal, arguments: { description: 'Stage current exact user attachment', boundary: 'semantic_decision',
        program: 'return await tools.postman_input_files({action:"stage_current_attachments"})' } })
    assert.equal(nested.isError, false, nested.error?.message)
    assert.equal(nested.value.status, 'ok', JSON.stringify(nested.value))
    assert.equal(nested.value.value.status, 'POSTMAN_INPUT_READY')
    assert.equal(f.calls.length, 1)
    const dispatch = dispatches.find(exec => exec.parent)
    assert.equal(dispatch.agent, f.agent)
    assert.equal(dispatch.rootCallId, 'ptc-current')
    assert.deepEqual(dispatch.arguments, { action: 'stage_current_attachments' })
  } finally { await adapter.dispose() }
})

test('exact production Leader receives Host descriptors, own cleanup and deterministic repeat', async () => {
  const f = fixture()
  assert.equal(f.tool.name, POSTMAN_INPUT_FILES_TOOL_NAME)
  assert.equal(postmanBridgeRestrictionForAgent(f.agent).allow.includes(POSTMAN_INPUT_FILES_TOOL_NAME), true)
  const existing = await f.execute({ action: 'describe_existing', repository: file.repository, commit: file.commit, path: file.path })
  assert.deepEqual(existing, { status: 'POSTMAN_INPUT_READY', descriptors: [file] })
  assert.equal(f.grants.owns(f.agent, f.task, [file]), true)
  const staged = await f.execute({ action: 'stage', paths: ['C:/temp/attachments/reference.png'] })
  assert.equal(staged.bundleId, 'f'.repeat(32))
  assert.equal(f.grants.owns(f.agent, f.task, staged.descriptors), true)
  assert.equal((await f.execute({ action: 'cleanup', bundleId: 'e'.repeat(32) })).status, 'POSTMAN_INPUT_BUNDLE_NOT_OWNED')
  assert.equal((await f.execute({ action: 'cleanup', bundleId: staged.bundleId })).status, 'POSTMAN_INPUT_CLEANED')
  assert.equal((await f.execute({ action: 'cleanup', bundleId: staged.bundleId })).status, 'POSTMAN_INPUT_ALREADY_CLEANED')
  assert.equal(f.grants.owns(f.agent, f.task, [file]), false)
  assert.deepEqual(f.calls.map(call => call[0]), ['--existing', '--stage'])
})

test('fabrication or any altered descriptor fails exact session/task provenance', async () => {
  const f = fixture()
  assert.equal(f.grants.owns(f.agent, f.task, [file]), false)
  await f.execute({ action: 'describe_existing', repository: file.repository, commit: file.commit, path: file.path })
  for (const field of ['sha256', 'path', 'commit', 'byte_length']) {
    const altered = { ...file, [field]: field === 'byte_length' ? 10 : 'c'.repeat(40) }
    assert.equal(f.grants.owns(f.agent, f.task, [altered]), false, field)
  }
  assert.equal(f.grants.owns(f.agent, {}, [file]), false)
  assert.equal(f.grants.owns({ ...f.agent }, f.task, [file]), false)
  f.grants.release(f.agent)
})

test('Bridge admission rejects fabricated and changed descriptors', async () => {
  const f = fixture()
  let accepted = 0, binding
  const bridge = createPostmanBridgeTool({ agents: { get: id => f.agents.get(id) } },
    { accept(_agent, _message, _kind, pinned) { accepted++; binding = pinned; return { status: 'POSTMAN_BRIDGE_ACCEPTED' } } }, { get: () => f.task })
  const send = descriptor => bridge.execute({ message: '@PostmanAsk --input-files-json ' + JSON.stringify([descriptor]) + '\nUse file' },
    { agent: f.agent, signal: new AbortController().signal })
  assert.equal((await send(file)).status, 'POSTMAN_INPUT_PROVENANCE_REJECTED')
  postmanInputGrants.record(f.agent, f.task, privateResult())
  try {
    assert.equal((await send({ ...file, sha256: 'c'.repeat(64) })).status, 'POSTMAN_INPUT_PROVENANCE_REJECTED')
    assert.equal((await send(file)).status, 'POSTMAN_BRIDGE_ACCEPTED')
    assert.equal(accepted, 1)
  } finally { postmanInputGrants.unpin(binding); postmanInputGrants.release(f.agent) }
})

test('PTC Leader direct call rejected; nested dispatch allowed, others denied', async () => {
  const f = fixture('postman-leader-ptc')
  assert.equal(POSTMAN_PTC_ONLY_LEADER_TOOLS.includes(POSTMAN_INPUT_FILES_TOOL_NAME), true)
  assert.match(postmanPtcDirectCallGuard({ agent: f.agent, name: POSTMAN_INPUT_FILES_TOOL_NAME }, id => f.agents.get(id)), /PTC_DIRECT_CALL_REJECTED/)
  assert.equal(postmanPtcDirectCallGuard({ agent: f.agent, name: POSTMAN_INPUT_FILES_TOOL_NAME, parent: {} }, id => f.agents.get(id)), undefined)
  assert.equal((await f.execute({ action: 'stage', paths: ['C:/temp/reference.png'] }, f.agent, {})).status, 'POSTMAN_INPUT_READY')
  f.grants.release(f.agent)
  for (const kind of ['standard', 'postman-bridge', 'postman-worker']) {
    const caller = { id: kind, session: { header: { agentPreset: kind, delegationDepth: kind === 'standard' ? 0 : 1, origin: kind === 'standard' ? undefined : 'subagent' } } }
    f.agents.set(kind, caller)
    assert.equal(postmanBridgeRestrictionForAgent(caller).deny.includes(POSTMAN_INPUT_FILES_TOOL_NAME), true)
    assert.equal((await f.execute({ action: 'stage', paths: ['C:/temp/reference.png'] }, caller)).status, 'POSTMAN_INPUT_CALLER_REJECTED')
  }
})

test('private tool output never includes Host paths and release removes exact materialization', async () => {
  const f = fixture()
  const result = await f.execute({ action: 'stage', paths: ['C:/source/selected.txt'] })
  const call = f.calls[0], root = call[call.indexOf('--snapshot-dir') + 1]
  assert.equal(existsSync(join(root, '001.bin')), true)
  assert.equal(JSON.stringify(result).includes(root), false)
  assert.equal(JSON.stringify(result).includes('snapshot'), false)
  assert.equal(JSON.stringify(result).includes('C:/source'), false)
  f.grants.release(f.agent)
  assert.equal(existsSync(root), false)
})

test('opaque pin survives grant cleanup; only exact child/context/descriptor can build', async () => {
  const grants = new PostmanInputGrants(), agent = { id: 'pin-leader' }, context = {}
  const result = privateResult()
  grants.record(agent, context, result)
  const binding = grants.pin(agent, context, [file]), child = { id: 'pin-child' }
  assert.deepEqual(binding, {})
  assert.equal(grants.bindChild(binding, { ...agent }, context, child), false)
  assert.equal(grants.bindChild(binding, agent, {}, child), false)
  assert.equal(grants.bindChild(binding, agent, context, child), true)
  assert.equal(grants.child({ ...child }, context, [file]), null)
  assert.equal(grants.child(child, {}, [file]), null)
  assert.equal(grants.child(child, context, [{ ...file, byte_length: 10 }]), null)
  grants.release(agent)
  assert.equal(existsSync(result.snapshotRoot), true)
  const req = 'REQ_20261001T000000Z_0987'
  const bundle = await grants.build(binding, child.id, req, [file])
  assert.equal(bundle.displayName, 'POSTMAN_INPUT_' + req + '.zip')
  const handoff = JSON.parse(readFileSync(bundle.handoffPath, 'utf8'))
  const zip = readFileSync(handoff.attachment.path)
  assert.equal(createHash('sha256').update(zip).digest('hex'), bundle.bundleSha256)
  assert.equal(zip.length, bundle.bundleByteLength)
  bundle.cleanup()
  assert.equal(existsSync(bundle.handoffPath), false)
  await assert.rejects(grants.build({}, child.id, req, [file]), /PROVENANCE_REJECTED/)
  await assert.rejects(grants.build(binding, 'wrong-child', req, [file]), /PROVENANCE_REJECTED/)
  grants.unpin(binding)
  assert.equal(existsSync(result.snapshotRoot), false)
  assert.equal(grants.child(child, context, [file]), null)
})

test('actual Bridge job pins exact child and releases binding at child disposal', async () => {
  const f = fixture(), result = privateResult(), child = { id: 'actual-input-child' }
  let finish, releaseFinish, disposed = false
  const completed = new Promise(resolve => { finish = resolve })
  const disposal = new Promise(resolve => { releaseFinish = resolve })
  postmanInputGrants.record(f.agent, f.task, result)
  const contexts = { get: id => id === f.agent.id ? f.task : null,
    bindChild: () => true, releaseChild() {} }
  const ctx = { agents: { get: id => id === f.agent.id ? f.agent : undefined },
    subagents: { async start() { return { id: child.id, localAgent: child, result: completed,
      async dispose() { disposed = true; await disposal } } } },
    tools: { get() { return { async execute() { return { status: 'COMPLETED',
      requestId: 'REQ_20261001T000000Z_0111', result: { assistantText: 'trusted' } } } } } } }
  const jobs = createPostmanBridgeJobs(ctx, { run: (_signal, launch) => launch(), dispose() {} }, null, contexts)
  const bridge = createPostmanBridgeTool(ctx, jobs, contexts)
  const accepted = await bridge.execute({ message: '@PostmanAsk --input-files-json ' + JSON.stringify([file]) + '\nUse file' },
    { agent: f.agent, signal: new AbortController().signal })
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(postmanInputGrants.child(child, f.task, [file]))
  postmanInputGrants.release(f.agent)
  assert.equal(existsSync(result.snapshotRoot), true)
  finish({ stopReason: 'end_turn' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, true)
  assert.ok(postmanInputGrants.child(child, f.task, [file]))
  releaseFinish()
  await jobs.dispose()
  assert.equal(postmanInputGrants.child(child, f.task, [file]), null)
  assert.equal(existsSync(result.snapshotRoot), false)
})

test('snapshot hash is checked once at build after exact grant admission', async () => {
  const grants = new PostmanInputGrants(), agent = { id: 'mismatch-leader' }, context = {}
  const result = privateResult()
  grants.record(agent, context, result)
  const binding = grants.pin(agent, context, [file]), child = { id: 'mismatch-child' }
  grants.bindChild(binding, agent, context, child)
  writeFileSync(result.materializations[0].snapshot_path, 'WRONG!!!!')
  await assert.rejects(grants.build(binding, child.id, 'REQ_20261001T000000Z_0988', [file]), /MATERIALIZATION_MISMATCH/)
  grants.dispose()
  assert.equal(existsSync(result.snapshotRoot), false)
})


test('real private current/local stages build ZIP or image handoffs, zero GitHub transport and real cleanup', async t => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
  const ref = { ...image(), attachmentId: 'sha256:' + createHash('sha256').update(png).digest('hex'), bytes: png.length }
  const f = fixture(), listeners = new Map()
  f.agent.session.id = f.agent.id
  const ctx = { agents: { get: id => f.agents.get(id) }, attachments: { async readImage(exact) { assert.equal(exact, ref); return { data: png } } },
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const current = new CurrentAttachmentStore(ctx), calls = []
  const { pythonInputCommand } = await import('./postman-input-files.js')
  const tool = createPostmanInputFilesTool(ctx, { get: () => f.task }, { grants: f.grants, currentAttachments: current,
    run(root, args) { calls.push(args); return pythonInputCommand(root, args) } })
  const execute = args => tool.execute(args, { agent: f.agent, signal: new AbortController().signal })
  const source = mkdtempSync(join(tmpdir(), 'postman-local-native-'))
  t.after(() => { f.grants.dispose(); current.dispose(); rmSync(source, { recursive: true, force: true }) })
  listeners.get('session/event')(f.agent.session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' },
    content: [{ type: 'image', attachment: ref }] } })
  const staged = await execute({ action: 'stage_current_attachments' })
  assert.equal(staged.status, 'POSTMAN_INPUT_READY')
  assert.deepEqual(staged.descriptors, [{ name: 'reference.png', sha256: ref.attachmentId.slice(7), byte_length: png.length,
    source_kind: 'native', media_type: 'image/png' }])
  let ordinal = 1
  for (const kind of ['artifact', 'text', 'image']) {
    const binding = f.grants.pin(f.agent, f.task, staged.descriptors), child = { id: 'native-' + kind }
    assert.equal(f.grants.bindChild(binding, f.agent, f.task, child), true)
    const req = 'REQ_20261001T000000Z_0' + String(ordinal++).padStart(3, '0')
    const made = await f.grants.build(binding, child.id, req, staged.descriptors, kind)
    const handoff = JSON.parse(readFileSync(made.handoffPath, 'utf8'))
    const data = readFileSync(handoff.attachment.path)
    assert.equal(createHash('sha256').update(data).digest('hex'), handoff.attachment.sha256)
    if (kind === 'image') { assert.deepEqual(data, png); assert.equal(made.mediaType, 'image/png') }
    else { assert.equal(data.subarray(0, 2).toString(), 'PK'); assert.equal(made.displayName, 'POSTMAN_INPUT_' + req + '.zip') }
    made.cleanup(); f.grants.unpin(binding)
    assert.equal(existsSync(dirname(made.handoffPath)), false)
  }
  const snapshotRoot = calls[0].at(-1)
  assert.equal((await execute({ action: 'cleanup', bundleId: staged.bundleId })).status, 'POSTMAN_INPUT_CLEANED')
  assert.equal(existsSync(snapshotRoot), false)
  const path = join(source, 'selected.txt'); writeFileSync(path, 'exact-local')
  const local = await execute({ action: 'stage', paths: [path] })
  assert.equal(local.status, 'POSTMAN_INPUT_READY')
  assert.equal(local.descriptors[0].source_kind, 'native')
  assert.equal(local.descriptors[0].sha256, createHash('sha256').update('exact-local').digest('hex'))
  assert.equal(JSON.stringify(local).includes(source), false)
  assert.equal(calls.every(args => args[0] === '--stage'), true)
  assert.equal(calls.length, 2)
})

test('mixed image + PDF counts unsupported occurrence; only explicit image selection stages', async t => {
  const f = currentFixture(t), ref = image()
  f.listeners.get('session/event')(f.agent.session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' },
    content: [{ type: 'image', attachment: ref }, { type: 'file', attachment: { name: 'document.pdf', mediaType: 'application/pdf', path: 'C:/private/document.pdf' } }] } })
  const selection = await f.execute({ action: 'stage_current_attachments' })
  assert.equal(selection.status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_SELECTION_REQUIRED')
  assert.equal(selection.attachments.length, 2)
  assert.deepEqual(selection.attachments[1], { selectionId: '2', supported: false,
    capabilityStatus: 'POSTMAN_INPUT_CURRENT_ATTACHMENT_UNAVAILABLE', name: 'document.pdf', mediaType: 'application/pdf' })
  assert.equal(JSON.stringify(selection).includes('C:/private'), false)
  assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0)
  for (const selectionIds of [['2'], ['1', '2']]) {
    const result = await f.execute({ action: 'stage_current_attachments', selectionIds })
    assert.equal(result.status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_UNAVAILABLE')
    assert.match(result.reason, /readImage only/)
    assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0)
  }
  const selected = await f.execute({ action: 'stage_current_attachments', selectionIds: ['1'] })
  assert.equal(selected.status, 'POSTMAN_INPUT_READY')
  assert.deepEqual(f.reads, [ref]); assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0][0], '--stage'); assert.deepEqual(selected.descriptors.map(d => d.name), ['reference.png'])
})

test('unsupported current file API is explicit capability-unavailable, never searches or stages', async t => {
  const f = currentFixture(t)
  f.listeners.get('session/event')(f.agent.session, { type: 'user/message', data: { role: 'user', source: { kind: 'user' },
    content: [{ type: 'file', attachment: { name: 'document.pdf' } }] } })
  const result = await f.execute({ action: 'stage_current_attachments' })
  assert.equal(result.status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_UNAVAILABLE')
  assert.match(result.reason, /supports current images.*readImage only/)
  assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0)
})

