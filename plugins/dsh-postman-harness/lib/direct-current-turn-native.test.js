import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDirectCurrentTurnToolConfigs } from './direct-current-turn.js'
import { PostmanInputGrants } from './postman-input-files.js'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const ref = { attachmentId: 'sha256:' + createHash('sha256').update(png).digest('hex'), mediaType: 'image/png',
  bytes: png.length, width: 1, height: 1, name: 'reference.png' }

function fixture(t, readImage = async () => ({ data: png }), jobs) {
  const agent = { id: 'standalone', session: { id: 'standalone', header: { cwd: root, agentPreset: 'standard', delegationDepth: 0 } } }
  const listeners = new Map(), reads = [], grants = new PostmanInputGrants()
  const ctx = { agents: { get: id => id === agent.id ? agent : undefined },
    attachments: { async readImage(exact, signal) { reads.push(exact); assert.equal(exact.mediaType, 'image/png'); return readImage(exact, signal) } },
    on(name, fn) { const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(fn); return () => set.delete(fn) } }
  const bridge = createDirectCurrentTurnToolConfigs(ctx, { jobs, inputGrants: grants,
    taskContexts: { child: () => null } })
  const attachments = bridge.currentAttachments
  const emit = (text, extra = [{ type: 'image', attachment: ref }], seq = 1, session = agent.session, source = { kind: 'user' }) => {
    const event = { type: 'user/message', seq, data: { role: 'user', source, content: [{ type: 'text', text }, ...extra] } }
    for (const fn of listeners.get('session/event')) fn(session, event)
  }
  const send = () => bridge.tools[0].execute({}, { agent, signal: new AbortController().signal })
  t.after(() => { bridge.dispose(); grants.dispose() })
  return { agent, ctx, attachments, grants, bridge, emit, send, reads }
}

for (const [trigger, kind, terminal] of [['Postman', 'artifact', 'ASSISTANT_COMPLETED_NO_ARTIFACT'],
  ['PostmanAsk', 'text', 'TEXT_RESULT_DURABLE'], ['PostmanImage', 'image', 'IMAGE_RESULT_DURABLE']]) {
  test('standalone @' + trigger + ' exact current image -> real native upload and terminal gate', async t => {
    const f = fixture(t), invocations = [], privatePaths = []
    const manager = f.bridge.jobs
    // Replace external PowerShell/browser/GitHub IO only; real manager, store, grants,
    // Python snapshot/builder/Direct and Send/observer/extraction helpers run unchanged.
    manager.spawn = (_command, args, options) => {
      invocations.push(args)
      privatePaths.push(args[args.indexOf('-InputBundleManifest') + 1])
      return spawn(process.platform === 'win32' ? 'python' : 'python3',
        [join(root, 'postman/web/tests/standalone_native_fixture.py'), ...args], { ...options,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    }
    const intent = 'Точное намерение\nбез переписывания  '
    f.emit('@' + trigger + '\n' + intent)
    const started = await f.send()
    assert.equal(started.status, 'STARTED'); assert.equal(started.transportKind, kind)
    assert.deepEqual(f.reads, [ref]); assert.equal(invocations.length, 1)
    const argv = invocations[0]
    assert.equal(argv[argv.indexOf('-Branch') + 1], 'main')
    assert.equal(Buffer.from(argv[argv.indexOf('-TaskBase64') + 1], 'base64').toString('utf8'), intent)
    const descriptors = JSON.parse(Buffer.from(argv[argv.indexOf('-InputFilesBase64') + 1], 'base64').toString('utf8'))
    assert.deepEqual(descriptors, [{ name: ref.name, sha256: ref.attachmentId.slice(7), byte_length: png.length,
      source_kind: 'native', media_type: 'image/png' }])
    assert.equal(f.grants.owners.size, 0); assert.equal(f.grants.pins.size, 0); assert.equal(f.grants.children.size, 0)
    await assert.rejects(f.send(), /POSTMAN_CURRENT_TURN_ALREADY_USED/)
    const completed = await manager.wait(f.agent.id, 30000)
    const job = manager.latest(f.agent.id)
    assert.equal(completed.status, 'COMPLETED', job.stderr)
    assert.equal(completed.result.code, terminal, job.stderr + '\n' + job.stdout)
    assert.deepEqual(completed.result.standaloneEvidence, { generationSends: 1, packagingSends: kind === 'image' ? 1 : 0,
      sendStates: kind === 'image' ? ['PROVEN_SENT', 'PROVEN_SENT'] : ['PROVEN_SENT'],
      mimeType: kind === 'image' ? 'image/png' : 'application/zip' })
    assert.equal(existsSync(dirname(privatePaths[0])), false, 'independent request root cleaned at terminal')
  })
}

test('standalone mixed image/PDF returns explicit selection without reads, grants or Direct spawn', async t => {
  for (const trigger of ['Postman', 'PostmanAsk', 'PostmanImage']) {
    const f = fixture(t, undefined, { start() { assert.fail('must not start') }, dispose() {} })
    f.emit('@' + trigger + ' intent', [{ type: 'image', attachment: ref },
      { type: 'file', attachment: { name: 'document.pdf', mediaType: 'application/pdf' } }])
    const result = await f.send()
    assert.equal(result.status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_SELECTION_REQUIRED')
    assert.equal(result.attachments.length, 2)
    assert.equal(result.attachments[1].capabilityStatus, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_UNAVAILABLE')
    assert.equal(f.reads.length, 0); assert.equal(f.grants.owners.size, 0)
    assert.equal(f.bridge.store.get(f.agent.id).consumed, false)
    const context = {}, owner = { agent: f.agent, context, descriptors: new Map(), bundles: new Map() }
    f.grants.owners.set(f.agent.id, owner)
    assert.equal((await f.send()).status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_SELECTION_REQUIRED')
    assert.equal(f.grants.owners.get(f.agent.id), owner, 'selection failure must not revoke earlier Leader grants')
  }
})

test('standalone generic current attachment returns capability unavailable, never starts Direct', async t => {
  const f = fixture(t, undefined, { start() { assert.fail('must not start') }, dispose() {} })
  f.emit('@PostmanAsk intent', [{ type: 'file', attachment: { name: 'document.pdf' } }])
  assert.equal((await f.send()).status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_UNAVAILABLE')
  assert.equal(f.reads.length, 0)
})

test('standalone fabricated descriptor metadata and foreign session cannot grant input authority', async t => {
  const f = fixture(t, undefined, { start() { assert.fail('must not start') }, dispose() {} })
  const fake = { source_kind: 'native', name: 'reference.png', sha256: 'b'.repeat(64), byte_length: 12, media_type: 'image/png' }
  f.emit('@Postman --input-files-json ' + JSON.stringify([fake]) + '\nintent')
  await assert.rejects(f.send(), /POSTMAN_INPUT_METADATA_LEADER_REQUIRED/)
  f.emit('@Postman intent', [{ type: 'image', attachment: ref }], 2, { ...f.agent.session })
  await assert.rejects(f.send(), /POSTMAN_INPUT_CURRENT_ATTACHMENT_MISMATCH/)
  assert.equal(f.reads.length, 0)
})

test('standalone reservation blocks concurrent send; message replacement during read fails closed', async t => {
  let release, entered
  const reading = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const f = fixture(t, async () => { entered(); await pending; return { data: png } },
    { start() { assert.fail('must not start') }, dispose() {} })
  f.emit('@Postman intent')
  const first = f.send()
  await reading
  await assert.rejects(f.send(), /POSTMAN_CURRENT_TURN_ALREADY_USED/)
  f.emit('@Postman new intent', [], 2)
  release()
  assert.equal((await first).status, 'POSTMAN_INPUT_CURRENT_ATTACHMENT_MISMATCH')
  assert.equal(f.reads.length, 1); assert.equal(f.grants.owners.size, 0)
  assert.equal(f.bridge.store.get(f.agent.id).text, '@Postman new intent')
})
test('standalone Image stages and builds the exact two or seven current references', async t => {
  for (const count of [2,7]) {
    let f, started=0
    const jobs={async start(options) {
      started++
      assert.equal(options.transportKind,'image')
      assert.equal(options.inputFiles.length,count)
      const req='REQ_20261003T010203Z_1234'
      const bundle=await f.grants.build(options.inputBinding,f.agent.id,req,options.inputFiles,'image')
      try {assert.deepEqual(bundle.names,Array.from({length:count},(_,i)=>'POSTMAN_REFERENCE_'+req+'_'+(i+1)+'.png'))}
      finally {bundle.cleanup()}
      return {status:'STARTED'}
    },dispose(){}}
    f=fixture(t,undefined,jobs)
    const refs=Array.from({length:count},(_,i)=>({...ref,name:'reference-'+i+'.png'}))
    f.emit('@PostmanImage exact intent',refs.map(attachment=>({type:'image',attachment})))
    assert.equal((await f.send()).status,'STARTED')
    assert.equal(started,1)
    assert.deepEqual(f.reads,refs)
  }
})

