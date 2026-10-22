import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectPostmanJobManager } from './direct-current-turn.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createDevspaceChannel, readDevspaceImageAction } from './postman-devspace.js'

const REQ = 'REQ_20261020T100000Z_9999'
function fixture(t, { imageMode = true, terminal = true, revoked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'image-actions-')), previous = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = root
  t.after(() => { previous === undefined ? delete process.env.LOCALAPPDATA : process.env.LOCALAPPDATA = previous; rmSync(root, { recursive: true, force: true }) })
  const channelRoot = join(root, 'DSH', 'Postman', 'devspace'); mkdirSync(channelRoot, { recursive: true })
  const parent = { id: 'leader', session: { header: { cwd: root, agentPreset: 'postman-leader', delegationDepth: 0 } } }
  const other = { id: 'other', session: { header: { cwd: root, agentPreset: 'postman-leader', delegationDepth: 0 } } }
  const bridgeJobId = randomUUID(), childId = randomUUID()
  const binding = createDevspaceChannel({ root: channelRoot, bridgeJobId, requestId: REQ,
    leaderSessionId: parent.id, lunaSessionId: childId, worktree: root, branch: '', workspaceOnly: true,
    mode: 'READ_ONLY', sourceRoot: root, conversationUrl: 'https://chatgpt.com/c/original', imageMode })
  writeFileSync(join(binding.channel, 'result.json'), JSON.stringify({ requestId: REQ,
    source: 'transport_diagnostic', diagnostic: 'UNKNOWN', sendState: 'UNKNOWN',
    conversationRef: 'https://chatgpt.com/c/original', assistantText: 'original result' }))
  const op = { state: 'received', transportKind: 'devspace', requestId: REQ, childSessionId: childId,
    executionRevoked: revoked, ...(terminal ? { terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', requestId: REQ } } : {}),
    devspace: { channel: binding.channel, laneId: 'lane-1' } }
  const row = { bridgeOperations: { [bridgeJobId]: op }, devspaceLanes: { 'lane-1': { childId, activeBridgeJobId: null } } }
  const owner = { leaderSessionId: parent.id, worktree: root, workspaceOnly: true }
  const contexts = { get: id => id === parent.id ? owner : null, record: id => id === parent.id ? row : null,
    async changeRecord(id, change) { assert.equal(id, parent.id); Object.assign(row, change(row)) } }
  const children = new Map([[parent.id, parent], [other.id, other]])
  const ctx = { agents: { get: id => children.get(id) } }
  const coordinator = { run: (_signal, launch) => Promise.resolve().then(launch), dispose() {} }
  const actions = [], direct = { async imageAction(received, action) { actions.push({ received, action });
    const receipt = { jobId: received.jobId, requestId: received.requestId, leaderSessionId: received.leaderSessionId,
      lunaSessionId: received.lunaSessionId, action, conversationRef: 'https://chatgpt.com/c/original',
      ...(action === 'image_download' ? { ok: true, imageSource: 'NATIVE_GENERATED_IMAGE_DOWNLOAD',
        assistantIdentity: { role: 'assistant' }, resultImage: join(received.channel, 'POSTMAN_IMAGE_' + REQ + '.png'),
        imageFormat: 'png', imageMimeType: 'image/png', imageWidth: 64, imageHeight: 64,
        imageByteLength: 8, imageSha256: createHash('sha256').update('89504e470d0a1a0a', 'hex').digest('hex') } : {}) }
    if (receipt.resultImage) writeFileSync(receipt.resultImage, Buffer.from('89504e470d0a1a0a', 'hex'))
    writeFileSync(join(received.channel, action === 'image_inspect' ? 'image-inspect.json' : 'image-download.json'), JSON.stringify(receipt))
    return readDevspaceImageAction(received, action)
  }, dispose() {} }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, null, contexts, null, direct)
  return { root, parent, other, bridgeJobId, binding, row, op, actions, direct, jobs }
}

test('owned terminal image actions use exact channel and are reported separately from original result', async t => {
  const f = fixture(t)
  for (const action of ['image_inspect', 'image_download']) {
    const result = await f.jobs.devspaceControl(f.parent, f.bridgeJobId, action)
    assert.equal(result.status, 'POSTMAN_DEVSPACE_IMAGE_ACTION_RESULT')
    assert.equal(result.bridgeJobId, f.bridgeJobId); assert.equal(result.requestId, REQ)
    assert.equal(result.receipt.action, action)
    assert.equal(result.receipt.conversationRef, 'https://chatgpt.com/c/original')
    if (action === 'image_download') {
      assert.equal(result.receipt.resultImage, join(f.binding.channel, 'POSTMAN_IMAGE_' + REQ + '.png'))
      assert.equal(result.receipt.imageByteLength, 8)
      assert.equal(result.receipt.imageSha256, createHash('sha256').update('89504e470d0a1a0a', 'hex').digest('hex'))
    } else assert.equal(result.receipt.resultImage, undefined)
    assert.equal(f.actions.at(-1).received.channel, f.binding.channel)
    assert.equal(f.actions.at(-1).received.requestId, REQ)
  }
  const status = await f.jobs.status(f.parent, f.bridgeJobId)
  assert.equal(status.result.assistantText, 'original result')
  assert.equal(status.imageInspection.action, 'image_inspect')
  assert.equal(status.imageDownload.action, 'image_download')
  assert.equal(f.actions.length, 2, 'actions do not make a new Send')
  await f.jobs.dispose()
})

test('image controls reject foreign, non-image, nonterminal, busy, and revoked owners', async t => {
  const cases = [
    [{}, 'foreign', 'POSTMAN_DEVSPACE_CONTROL_JOB_NOT_FOUND'],
    [{ imageMode: false }, 'owner', 'POSTMAN_DEVSPACE_IMAGE_ACTION_REJECTED'],
    [{ terminal: false }, 'owner', 'POSTMAN_DEVSPACE_IMAGE_ACTION_REJECTED'],
    [{ revoked: true }, 'owner', 'POSTMAN_DEVSPACE_CONTROL_JOB_NOT_FOUND'],
  ]
  for (const [options, caller, expected] of cases) {
    const f=fixture(t, options)
    const result = await f.jobs.devspaceControl(caller === 'foreign' ? f.other : f.parent, f.bridgeJobId, 'image_inspect')
    assert.equal(result.status, expected); assert.equal(f.actions.length, 0)
    await f.jobs.dispose()
  }
  const f = fixture(t)
  f.row.devspaceLanes['lane-1'].activeBridgeJobId = 'different-job'
  assert.equal((await f.jobs.devspaceControl(f.parent, f.bridgeJobId, 'image_download')).status,
    'POSTMAN_DEVSPACE_IMAGE_ACTION_REJECTED')
  assert.equal(f.actions.length, 0)
  await f.jobs.dispose()
})

test('image action receipt reader enforces owner, action, and chat identity', t => {
  const f = fixture(t)
  const receiptPath = join(f.binding.channel, 'image-inspect.json')
  const base = { jobId: f.binding.jobId, requestId: REQ, leaderSessionId: f.parent.id,
    lunaSessionId: f.binding.lunaSessionId, action: 'image_inspect', conversationRef: 'https://chatgpt.com/c/original' }
  writeFileSync(receiptPath, JSON.stringify(base))
  assert.equal(readDevspaceImageAction(f.binding, 'image_inspect').action, 'image_inspect')
  writeFileSync(receiptPath, JSON.stringify({ ...base, leaderSessionId: 'attacker' }))
  assert.throws(() => readDevspaceImageAction(f.binding, 'image_inspect'), /OWNER_MISMATCH/)
  writeFileSync(receiptPath, JSON.stringify({ ...base, action: 'image_download' }))
  assert.throws(() => readDevspaceImageAction(f.binding, 'image_inspect'), /RECEIPT_INVALID/)
  writeFileSync(receiptPath, JSON.stringify({ ...base, conversationRef: 'https://chatgpt.com/c/other' }))
  assert.throws(() => readDevspaceImageAction(f.binding, 'image_inspect'), /RECEIPT_INVALID/)
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex')
  const downloadedPath = join(f.binding.channel, 'image-download.json')
  const downloaded = { ...base, action: 'image_download', ok: true,
    imageSource: 'NATIVE_GENERATED_IMAGE_DOWNLOAD', assistantIdentity: { role: 'assistant' },
    resultImage: join(f.binding.channel, 'POSTMAN_IMAGE_' + REQ + '.png'), imageFormat: 'png',
    imageMimeType:'image/png', imageWidth:64, imageHeight:64,
    imageByteLength: bytes.length, imageSha256: createHash('sha256').update(bytes).digest('hex') }
  writeFileSync(downloaded.resultImage, bytes)
  writeFileSync(downloadedPath, JSON.stringify(downloaded))
  assert.equal(readDevspaceImageAction(f.binding, 'image_download').imageSha256, downloaded.imageSha256)
  writeFileSync(downloadedPath, JSON.stringify({ ...downloaded, imageSha256: '0'.repeat(64) }))
  assert.throws(() => readDevspaceImageAction(f.binding, 'image_download'), /IMAGE_PROOF_INVALID/)
  const claim = { jobId: f.binding.jobId, requestId: REQ, leaderSessionId: f.parent.id,
    lunaSessionId: f.binding.lunaSessionId, action: 'image_download', state: 'UNKNOWN',
    conversationRef: 'https://chatgpt.com/c/original', diagnostic: 'POSTMAN_DEVSPACE_IMAGE_ACTION_UNKNOWN' }
  rmSync(downloadedPath)
  writeFileSync(join(f.binding.channel, 'image-download-attempt.json'), JSON.stringify(claim))
  assert.deepEqual(readDevspaceImageAction(f.binding, 'image_download'), claim)
  f.jobs.dispose()
})

test('Direct image action reuses only REQ and channel and reads its durable receipt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'direct-image-action-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const channel = join(root, 'channel'); mkdirSync(channel)
  const binding = { jobId: randomUUID(), requestId: REQ, leaderSessionId: 'leader', lunaSessionId: 'luna',
    channel, imageMode: true }
  writeFileSync(join(channel, 'result.json'), JSON.stringify({ requestId: REQ,
    source: 'transport_diagnostic', diagnostic: 'UNKNOWN', conversationRef: 'https://chatgpt.com/c/original' }))
  const calls = []
  const expected = { jobId: binding.jobId, requestId: REQ, leaderSessionId: binding.leaderSessionId,
    lunaSessionId: binding.lunaSessionId, action: 'image_inspect', conversationRef: 'https://chatgpt.com/c/original' }
  let repeat = false
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    process.nextTick(() => {
      if (repeat) child.stdout.write(JSON.stringify({ diagnostic: 'POSTMAN_DEVSPACE_IMAGE_ACTION_ALREADY_ATTEMPTED' }))
      else writeFileSync(join(channel, 'image-inspect.json'), JSON.stringify(expected))
      child.emit('close', 0)
    })
    return child
  }
  const manager = new DirectPostmanJobManager({ spawn, pwsh: 'pwsh-test' })
  const result = await manager.imageAction(binding, 'image_inspect')
  assert.deepEqual(result, expected)
  assert.equal(calls.length, 1)
  const args = calls[0].args
  assert.equal(args[args.indexOf('-RequestId') + 1], REQ)
  assert.equal(args[args.indexOf('-Channel') + 1], channel)
  assert.equal(args[args.indexOf('-ImageAction') + 1], 'image_inspect')
  assert.equal(args.includes('-TaskBase64'), false)
  assert.equal(args.includes('-ChatRequestId'), false)
  assert.equal(args.includes('-Send'), false)
  repeat = true
  await assert.rejects(manager.imageAction(binding, 'image_inspect'), /POSTMAN_DEVSPACE_IMAGE_ACTION_ALREADY_ATTEMPTED/)
  assert.equal(calls.length, 2)
  manager.dispose()
})
