import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectPostmanJobManager } from './direct-current-turn.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createImplementationArtifactGrants, IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'

const parent = { id: 'leader', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
const taskRow = () => ({ leaderSessionId: parent.id, repository: IMPLEMENTATION_REPOSITORY,
  repositoryPath: 'C:/repo', originUrl: 'https://github.com/AndrewVerhoturov1/dsh-workspace.git',
  baseCommit: 'a'.repeat(40), branch: BRANCH, worktree: 'C:/task', stage: 'ready', workers: {}, runner: null })

const REQ = 'REQ_20260925T112233Z_1234'
const BRANCH = 'task/postman-' + 'a'.repeat(32)
const bytes = Buffer.from('untrusted physical candidate bytes')
const sha = value => createHash('sha256').update(value).digest('hex')

async function candidateFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-candidate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'candidates', REQ)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'capture.bin')
  await writeFile(path, bytes)
  const descriptor = { path, byteLength: bytes.length, sha256: sha(bytes), originalFilename: '../untrusted.zip',
    completeness: 'complete', reasons: ['CURRENT_REQUEST_CORRELATION_UNVERIFIED'],
    provenance: { requestId: REQ, chatUrl: 'https://chatgpt.com/c/fixture', assistantTextSha256: 'b'.repeat(64) },
    verified: false, applyEligible: false }
  await writeFile(join(dir, 'candidate.json'), JSON.stringify(descriptor))
  return { root, dir, path, descriptor }
}

function manager(root) { return new DirectPostmanJobManager({ directRoot: root, exists: () => true,
  randomInt: () => 1234, now: () => new Date('2026-09-25T11:22:33Z') }) }


test("historical owned fixed ZIP stays observable without repairing branchless receipt", async t => {
  const f = await candidateFixture(t)
  const legacyRoot = join(f.root, "..", "results")
  const directory = join(legacyRoot, REQ)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "result.zip")
  await writeFile(path, bytes)
  await rm(join(f.root, "candidates"), { recursive: true, force: true })
  const observed = manager(f.root).observeArtifactCandidate(REQ)
  assert.equal(observed.path, path)
  assert.equal(observed.sha256, sha(bytes))
  assert.equal(observed.verified, false)
  assert.equal(observed.applyEligible, false)
  assert.ok(observed.reasons.includes("LEGACY_FILE_CORRELATION_UNVERIFIED"))
  assert.ok(observed.reasons.includes("LEGACY_FILE_COMPLETENESS_UNVERIFIED"))
  assert.equal(manager(f.root).inspectRequest(REQ, BRANCH, "artifact").state, "unknown")
})

test('candidate observer trusts only contained physical bytes and recomputes actual SHA', async t => {
  const f = await candidateFixture(t)
  const seen = manager(f.root).observeArtifactCandidate(REQ)
  assert.equal(seen.path, f.path)
  assert.equal(seen.sha256, sha(bytes))
  assert.equal(seen.verified, false)
  assert.equal(seen.applyEligible, false)
  assert.ok(seen.reasons.includes('OWNERSHIP_RECEIPT_NOT_VERIFIED'))
  const altered = Buffer.from('untrusted physical candidate byteX')
  assert.equal(altered.length, bytes.length)
  await writeFile(f.path, altered)
  const changed = manager(f.root).observeArtifactCandidate(REQ)
  assert.equal(changed.sha256, sha(altered))
  assert.ok(changed.reasons.includes('CANDIDATE_SHA_CHANGED'))
  assert.equal(changed.verified, false)
})

test('missing candidate metadata observes only fixed raw bytes as incomplete', async t => {
  const f = await candidateFixture(t)
  await rm(join(f.dir, 'candidate.json'))
  const observed = manager(f.root).observeArtifactCandidate(REQ)
  assert.equal(observed.path, f.path)
  assert.equal(observed.byteLength, bytes.length)
  assert.equal(observed.sha256, sha(bytes))
  assert.equal(observed.completeness, 'partial')
  assert.ok(observed.reasons.includes('CANDIDATE_METADATA_MISSING'))
  assert.ok(observed.reasons.includes('CANDIDATE_COMPLETENESS_UNVERIFIED'))
  assert.equal(observed.verified, false)
  assert.equal(observed.applyEligible, false)
  assert.equal(manager(f.root).inspectRequest(REQ, BRANCH, 'artifact').state, 'unknown')
})

test('candidate path, request, length, and symlink mismatches are rejected', async t => {
  const f = await candidateFixture(t)
  const descriptorPath = join(f.dir, 'candidate.json')
  for (const patch of [{ path: join(f.root, 'elsewhere.bin') }, { provenance: { requestId: 'REQ_20260925T112233Z_9999' } },
    { byteLength: 50 * 1024 * 1024 + 1 }]) {
    await writeFile(descriptorPath, JSON.stringify({ ...f.descriptor, ...patch }))
    assert.equal(manager(f.root).observeArtifactCandidate(REQ), null)
  }
  await writeFile(descriptorPath, JSON.stringify(f.descriptor))
  const outside = join(f.root, 'outside.bin')
  await writeFile(outside, bytes)
  await rm(f.path)
  try {
    await symlink(outside, f.path)
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('symlink creation is not permitted by this Windows environment')
    throw error
  }
  assert.equal(manager(f.root).observeArtifactCandidate(REQ), null)
})

test('branchless or mismatched publication checkpoint does not hide safe candidate', async t => {
  const f = await candidateFixture(t)
  const direct = manager(f.root)
  const seen = direct.observeArtifactCandidate(REQ)
  assert.ok(seen, 'physical candidate is visible without publication authority')
  const checkpoint = join(f.root, 'requests', REQ + '.json')
  await mkdir(join(f.root, 'requests'), { recursive: true })
  await writeFile(checkpoint, JSON.stringify({ requestId: REQ, repository: IMPLEMENTATION_REPOSITORY,
    branch: 'main', state: 'ARTIFACT_REJECTED' }))
  assert.equal(direct.inspectRequest(REQ, BRANCH, 'artifact').state, 'unknown')
  await writeFile(checkpoint, JSON.stringify({ requestId: REQ, repository: IMPLEMENTATION_REPOSITORY,
    branch: BRANCH, state: 'ARTIFACT_REJECTED', baseCommit: 'a'.repeat(40), taskPublicationCommit: 'c'.repeat(40) }))
  assert.equal(direct.inspectRequest(REQ, BRANCH, 'artifact').state, 'unknown')
  assert.equal(direct.observeArtifactCandidate(REQ).verified, false)
})

test('publication mismatches do not hide candidate; strict cold inspection fails closed', async t => {
  const f = await candidateFixture(t)
  const direct = manager(f.root)
  assert.ok(direct.observeArtifactCandidate(REQ))
  const checkpoint = join(f.root, 'requests', REQ + '.json')
  const result = join(f.root, 'results', REQ + '.json')
  await mkdir(join(f.root, 'requests'), { recursive: true }); await mkdir(join(f.root, 'results'), { recursive: true })
  for (const state of [
    { requestId: 'REQ_20260925T112233Z_9999', repository: IMPLEMENTATION_REPOSITORY, branch: BRANCH },
    { requestId: REQ, repository: IMPLEMENTATION_REPOSITORY, branch: 'main' },
    { requestId: REQ, repository: IMPLEMENTATION_REPOSITORY, branch: BRANCH, baseCommit: 'a'.repeat(40), taskPublicationCommit: 'c'.repeat(40) },
  ]) {
    await writeFile(checkpoint, JSON.stringify(state))
    assert.equal(direct.inspectRequest(REQ, BRANCH, 'artifact').state, 'unknown')
    assert.ok(direct.observeArtifactCandidate(REQ))
  }
  const publication = { requestId: REQ, repository: IMPLEMENTATION_REPOSITORY, branch: BRANCH,
    baseCommit: 'a'.repeat(40), taskPublicationCommit: 'c'.repeat(40), taskUrl: `https://raw.githubusercontent.com/${IMPLEMENTATION_REPOSITORY}/${"c".repeat(40)}/${REQ}.md` }
  await writeFile(checkpoint, JSON.stringify({ ...publication, state: 'FAILED', publicationStarted: true }))
  const terminal = { ok: true, code: 'RESULT_DURABLE', state: 'RESULT_DURABLE', ...publication,
    expectedFilename: `POSTMAN_${REQ}_RESULT.zip`, resultZip: f.path, sha256: '0'.repeat(64) }
  await writeFile(result, JSON.stringify(terminal))
  assert.equal(direct.inspectRequest(REQ, BRANCH, 'artifact').state, 'published')
  const durableState = { ...publication, state: 'ASK_WEB_RUNNING', publicationStarted: true }
  await writeFile(checkpoint, JSON.stringify(durableState))
  const validTerminal = { ...terminal, sha256: sha(bytes) }
  await writeFile(result, JSON.stringify(validTerminal))
  assert.equal(direct.inspectRequest(REQ, BRANCH, 'artifact').state, 'terminal')
  await writeFile(result, JSON.stringify({ ...validTerminal, sha256: '0'.repeat(64) }))
  assert.equal(direct.inspectRequest(REQ, BRANCH, 'artifact').state, 'published')
})

test('native Direct terminal gate exposes candidate bytes but cannot make them successful', async t => {
  const f = await candidateFixture(t)
  const children = []
  const direct = new DirectPostmanJobManager({ directRoot: f.root, exists: () => true,
    randomInt: () => 1234, now: () => new Date('2026-09-25T11:22:33Z'),
    spawn(_cmd, _args) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      child.off = child.removeListener.bind(child); children.push(child)
      queueMicrotask(() => child.emit('spawn')); return child
    } })
  const started = await direct.start({ sessionId: 'candidate', workspace: 'C:/repo', branch: BRANCH,
    payload: 'intent', transportKind: 'artifact' })
  children[0].stdout.emit('data', JSON.stringify({ ok: false, code: 'ARTIFACT_CANDIDATE_SAVED', requestId: started.requestId }))
  children[0].emit('close', 1)
  const terminal = direct.view('candidate').result
  assert.equal(terminal.ok, false)
  assert.equal(terminal.code, 'ARTIFACT_CANDIDATE_SAVED')
  assert.equal(terminal.candidate.path, f.path)
  assert.equal(terminal.candidate.sha256, sha(bytes))
  assert.equal(terminal.verified, false)
  assert.equal(terminal.applyEligible, false)
  const forgedChildren = []
  const forged = new DirectPostmanJobManager({ directRoot: f.root, exists: () => true,
    randomInt: () => 1235, now: () => new Date('2026-09-25T11:22:34Z'),
    spawn() {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      child.off = child.removeListener.bind(child); forgedChildren.push(child)
      queueMicrotask(() => child.emit('spawn')); return child
    } })
  const second = await forged.start({ sessionId: 'forged', workspace: 'C:/repo', branch: BRANCH,
    payload: 'intent', transportKind: 'artifact' })
  forgedChildren[0].stdout.emit('data', JSON.stringify({ ok: true, code: 'RESULT_DURABLE', state: 'RESULT_DURABLE',
    requestId: second.requestId, resultZip: f.path, sha256: sha(bytes), verified: false,
    applyEligible: false, candidate: { path: f.path, sha256: sha(bytes) } }))
  forgedChildren[0].emit('close', 0)
  const rejected = forged.view('forged').result
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'POSTMAN_DURABLE_RESULT_ZIP_MISSING')
})

test('native Direct terminal reports raw candidate when metadata is missing', async t => {
  const f = await candidateFixture(t)
  await rm(join(f.dir, 'candidate.json'))
  const children = []
  const direct = new DirectPostmanJobManager({ directRoot: f.root, exists: () => true,
    randomInt: () => 1234, now: () => new Date('2026-09-25T11:22:33Z'),
    spawn(_cmd, _args) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      child.off = child.removeListener.bind(child); children.push(child)
      queueMicrotask(() => child.emit('spawn')); return child
    } })
  const started = await direct.start({ sessionId: 'missing-metadata', workspace: 'C:/repo', branch: BRANCH,
    payload: 'intent', transportKind: 'artifact' })
  const expected = { path: f.path, byteLength: bytes.length, sha256: sha(bytes), completeness: 'partial',
    reasons: ['CANDIDATE_METADATA_MISSING', 'CANDIDATE_COMPLETENESS_UNVERIFIED', 'OWNERSHIP_RECEIPT_NOT_VERIFIED'],
    verified: false, applyEligible: false }
  children[0].stdout.emit('data', JSON.stringify({ ok: false, code: 'ARTIFACT_CANDIDATE_SAVED', requestId: started.requestId,
    candidate: expected }))
  children[0].emit('close', 1)
  const terminal = direct.view('missing-metadata').result
  assert.equal(terminal.ok, false)
  assert.equal(terminal.code, 'ARTIFACT_CANDIDATE_SAVED')
  assert.equal(terminal.candidate.path, f.path)
  assert.equal(terminal.candidate.sha256, sha(bytes))
  assert.equal(terminal.candidate.byteLength, bytes.length)
  assert.equal(terminal.candidate.completeness, 'partial')
  assert.ok(terminal.candidate.reasons.includes('CANDIDATE_METADATA_MISSING'))
  assert.equal(terminal.verified, false)
  assert.equal(terminal.applyEligible, false)
})

test('candidate-shaped terminal cannot create implementation grant or invoke runner', async t => {
  const f = await candidateFixture(t)
  const registry = createMemoryTaskRegistry()
  await registry.create('leader', { leaderSessionId: 'leader', stage: 'ready' })
  const grants = createImplementationArtifactGrants(registry)
  const terminal = { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', transportKind: 'artifact', requestId: REQ,
    result: { ok: true, code: 'RESULT_DURABLE', state: 'RESULT_DURABLE', requestId: REQ,
      repository: IMPLEMENTATION_REPOSITORY, expectedFilename: `POSTMAN_${REQ}_RESULT.zip`,
      resultZip: f.path, sha256: sha(bytes), verified: false, applyEligible: false } }
  assert.equal(await grants.register('leader', terminal), false)
  assert.equal(await grants.resolve('leader', REQ), null)
  assert.equal(registry.get('leader').artifactGrants?.[REQ], undefined)
})

test('strict verified durable result sync failure stays visible and grants only after sync', async t => {
  const f = await candidateFixture(t)
  const results = join(f.root, 'results'), requests = join(f.root, 'requests')
  await mkdir(results, { recursive: true }); await mkdir(requests, { recursive: true })
  const taskUrl = `https://raw.githubusercontent.com/${IMPLEMENTATION_REPOSITORY}/${'c'.repeat(40)}/${REQ}.md`
  const publication = { requestId: REQ, repository: IMPLEMENTATION_REPOSITORY, branch: BRANCH,
    baseCommit: 'a'.repeat(40), taskPublicationCommit: 'c'.repeat(40), taskUrl }
  const result = { ok: true, code: 'RESULT_DURABLE', state: 'RESULT_DURABLE', ...publication,
    expectedFilename: `POSTMAN_${REQ}_RESULT.zip`, resultZip: f.path, sha256: sha(bytes) }
  const terminal = { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', transportKind: 'artifact',
    requestId: REQ, result }
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { ...taskRow(), bridgeOperations: { strict: { state: 'received', phase: 'terminal',
    transportKind: 'artifact', requestId: REQ, synchronization: 'pending', terminal } } })
  let syncs = 0, sends = 0, grantCalls = 0
  const grants = createImplementationArtifactGrants(registry)
  const wrappedGrants = { async register(...args) { grantCalls++; return grants.register(...args) }, resolve: grants.resolve }
  const jobs = createPostmanBridgeJobs({ agents: { get: () => parent } },
    { run() { sends++; throw Error('Direct replay forbidden') }, dispose() {} }, wrappedGrants,
    { record: registry.get, changeRecord: registry.change, isRestoring: () => false, hasActiveOperation: () => false,
      async sync() { syncs++; return syncs > 1 } })
  const first = await jobs.status(parent, 'strict', true)
  assert.equal(first.result.resultZip, f.path)
  assert.equal(first.result.sha256, sha(bytes))
  assert.equal(first.synchronization, 'busy')
  assert.equal(await grants.resolve(parent.id, REQ), null)
  assert.deepEqual({ syncs, sends, grantCalls }, { syncs: 1, sends: 0, grantCalls: 0 })
  const retried = await jobs.status(parent, 'strict', true)
  assert.equal(retried.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(await grants.resolve(parent.id, REQ).then(Boolean), true)
  assert.deepEqual({ syncs, sends, grantCalls }, { syncs: 2, sends: 0, grantCalls: 1 })
  await jobs.dispose()
})

test('Bridge candidate stays visible after sync failure; retry never resends or grants', async t => {
  const f = await candidateFixture(t)
  const requests = join(f.root, 'requests'), results = join(f.root, 'results')
  await mkdir(requests, { recursive: true }); await mkdir(results, { recursive: true })
  const publication = { requestId: REQ, repository: IMPLEMENTATION_REPOSITORY, branch: BRANCH,
    baseCommit: 'a'.repeat(40), taskPublicationCommit: 'c'.repeat(40), taskUrl: `https://raw.githubusercontent.com/${IMPLEMENTATION_REPOSITORY}/${"c".repeat(40)}/${REQ}.md` }
  await writeFile(join(requests, REQ + '.json'), JSON.stringify({ ...publication, state: 'ARTIFACT_REJECTED', publicationStarted: true }))
  await writeFile(join(results, REQ + '.json'), JSON.stringify({ ok: false, code: 'ARTIFACT_CANDIDATE_SAVED',
    ...publication, requestId: REQ, publicationReceipt: publication, candidate: { path: f.path, sha256: sha(bytes), byteLength: bytes.length,
      completeness: 'complete', verified: false, applyEligible: false } }))
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { ...taskRow(), bridgeOperations: { candidate: { state: 'received', phase: 'terminal',
    transportKind: 'artifact', requestId: REQ, childSessionId: 'child', synchronization: 'pending',
    terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', transportKind: 'artifact', requestId: REQ,
      result: { ok: false, code: 'ARTIFACT_CANDIDATE_SAVED', requestId: REQ, candidate: { path: f.path, sha256: sha(bytes),
        byteLength: bytes.length, completeness: 'complete', verified: false, applyEligible: false }, publicationReceipt: publication } } } } })
  let syncs = 0, sends = 0, grants = 0
  const jobs = createPostmanBridgeJobs({ agents: { get: () => parent } },
    { run() { sends++; throw Error('Direct replay forbidden') }, dispose() {} },
    { async register() { grants++; return false } },
    { record: registry.get, changeRecord: registry.change, isRestoring: () => false,
      hasActiveOperation: () => false, async sync() { syncs++; return syncs > 1 } }, null,
    new DirectPostmanJobManager({ directRoot: f.root }))
  const status = await jobs.status(parent, 'candidate', true)
  assert.ok(status.result.candidate)
  assert.equal(status.result.candidate.path, f.path)
  assert.equal(status.result.candidate.sha256, sha(bytes))
  assert.equal(status.result.candidate.verified, false)
  assert.equal(status.result.candidate.applyEligible, false)
  assert.deepEqual({ syncs, sends, grants }, { syncs: 1, sends: 0, grants: 0 })
  await jobs.status(parent, 'candidate', true)
  assert.deepEqual({ syncs, sends, grants }, { syncs: 2, sends: 0, grants: 0 })
  assert.ok(manager(f.root).observeArtifactCandidate(REQ))
  await jobs.dispose()
})
