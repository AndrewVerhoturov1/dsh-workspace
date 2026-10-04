import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { DirectPostmanJobManager } from './direct-current-turn.js'
import { openPostmanTaskRegistry, createMemoryTaskRegistry } from './postman-task-registry.js'

const parent = { id: 'leader-bridge', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
const row = () => ({ leaderSessionId: parent.id, repository: 'andrewverhoturov1/dsh-workspace',
  repositoryPath: 'C:/repo', originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
  baseCommit: 'a'.repeat(40), branch: 'task/postman-' + 'a'.repeat(32), worktree: 'C:/task',
  stage: 'ready', diagnostic: null, workers: { 'child-C': { id: 'child-C', label: 'C', state: 'ready', delivery: 'none', artifactRequests: [] } },
  runner: { state: 'failed', requestId: 'REQ_FAIL' }, bridge: null })

function fixture(registry) {
  const taskContext = Object.freeze({ branch: registry.get(parent.id).branch })
  const contexts = { get: () => taskContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false }
  let started = 0
  const ctx = { agents: { get: () => parent }, subagents: { start() { started++; throw new Error('must not launch') } } }
  // Keep every intent pending, modeling an abrupt process exit while QUEUED.
  const coordinator = { run: () => new Promise(() => {}), dispose() {} }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, null, contexts)
  return { contexts, jobs, get started() { return started } }
}

async function exercise(registry) {
  const first = fixture(registry)
  const accepted = await Promise.all([0, 1, 2].map(i => first.jobs.accept(parent, '@PostmanAsk text ' + i, 'text')))
  assert.deepEqual(accepted.map(x => x.status), Array(3).fill('POSTMAN_BRIDGE_ACCEPTED'))
  assert.equal(new Set(accepted.map(x => x.bridgeJobId)).size, 3)
  assert.deepEqual(Object.keys(registry.get(parent.id).bridgeOperations), accepted.map(x => x.bridgeJobId))
  assert.equal((await first.jobs.accept(parent, '@PostmanAsk fourth', 'text')).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  const cold = fixture(registry)
  for (const job of accepted) {
    assert.equal((await cold.jobs.status(parent, job.bridgeJobId)).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  }
  assert.equal(cold.started, 0, 'no queued operation is replayed')
  assert.equal((await cold.jobs.accept(parent, '@PostmanAsk fourth', 'text')).status,
    'POSTMAN_BRIDGE_LIMIT_REACHED', 'unresolved jobs continue to count after restart')
  assert.equal(Object.values(registry.get(parent.id).workers)[0].id, 'child-C')
  assert.equal(registry.get(parent.id).runner.state, 'failed')
  return { accepted, cold }
}

test('three distinct durable Bridge intents survive runtime restart without replay', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, row())
  await exercise(registry)
})

test('read-only Bridge listing distinguishes durable and legacy occupied slots', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { ...row(), bridge: { id: 'legacy', state: 'pending' }, bridgeOperations: {
    reserved: { state: 'pending', phase: 'reserved', transportKind: 'text' },
    request: { state: 'unknown', phase: 'request-known', requestId: 'REQ_20261004T010101Z_0001' },
    completed: { state: 'received', phase: 'not-sent', synchronization: 'not-required', requestId: 'REQ_20261004T010104Z_0001' },
  } })
  const jobs = createPostmanBridgeJobs({}, { run() { throw Error('read launched child') }, dispose() {} }, null,
    { record: registry.get, changeRecord() { throw Error('read mutated registry') } })
  const before = structuredClone(registry.get(parent.id))
  const result = jobs.list(parent)
  assert.deepEqual({ limit: result.limit, used: result.used, status: result.status },
    { limit: 3, used: 3, status: 'POSTMAN_BRIDGE_LIST' })
  assert.deepEqual(result.operations.map(op => op.countsAgainstLimit), [true, true, false, true])
  assert.equal(result.operations[3].requestId, 'unknown')
  assert.deepEqual(registry.get(parent.id), before)
})

test('known Direct not-sent checkpoint frees slot after separate durable runtime lifetimes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-bridge-direct-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let backend = new JsonStorageBackend(join(root, 'storage'))
  const facility = () => new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} }, { backend: 'json', routes: {} })
  const directRoot = join(root, 'direct')
  await mkdir(join(directRoot, 'requests'), { recursive: true })
  const first = await openPostmanTaskRegistry(facility())
  const requestId = 'REQ_20261004T010101Z_0001'
  await first.create(parent.id, { ...row(), bridgeOperations: {
    safe: { state: 'unknown', phase: 'request-known', transportKind: 'text', childSessionId: 'child', requestId },
    published: { state: 'unknown', requestId: 'REQ_20261004T010102Z_0001' },
    legacy: { state: 'pending' },
    init: { state: 'unknown', requestId: 'REQ_20261004T010103Z_0001', transportKind: 'text' },
  } })
  await first.close()
  const publish = async (id, state) => writeFile(join(directRoot, 'requests', id + '.json'), JSON.stringify({
    requestId: id, repository: 'AndrewVerhoturov1/dsh-workspace', branch: row().branch, ...state }), 'utf8')
  await publish(requestId, { state: 'FAILED', publicationStarted: false })
  await publish('REQ_20261004T010102Z_0001', { state: 'WEB_RUNNING', publicationStarted: true })
  await publish('REQ_20261004T010103Z_0001', { state: 'ASK_INIT', publicationStarted: false })
  const cold = await openPostmanTaskRegistry(facility())
  let sends = 0
  const jobs = createPostmanBridgeJobs({ agents: { get: () => parent } },
    { run() { sends++; throw Error('duplicate Send') }, dispose() {} }, null,
    { record: cold.get, changeRecord: cold.change }, null,
    new DirectPostmanJobManager({ directRoot }))
  assert.equal(jobs.list(parent).used, 4)
  assert.equal((await jobs.status(parent, 'safe')).status, 'POSTMAN_BRIDGE_NOT_SENT')
  assert.equal((await jobs.status(parent, 'safe')).status, 'POSTMAN_BRIDGE_NOT_SENT')
  assert.equal(jobs.list(parent).used, 3)
  assert.equal((await jobs.status(parent, 'published')).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  assert.equal((await jobs.status(parent, 'legacy')).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  assert.equal((await jobs.status(parent, 'init')).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  assert.equal(jobs.list(parent).used, 3, 'false in INIT is not proof Direct cannot still publish')
  assert.equal(sends, 0)
  assert.deepEqual(cold.get(parent.id).bridgeOperations.safe, {
    state: 'received', phase: 'not-sent', transportKind: 'text', childSessionId: 'child', requestId,
    synchronization: 'not-required',
  })
  assert.equal(jobs.list(parent).operations.find(op => op.bridgeJobId === 'safe').countsAgainstLimit, false)
  await jobs.dispose(); await cold.close(); await backend.close()
  // Open the post-recovery bytes with a fresh backend and domain, not an in-memory handle.
  backend = new JsonStorageBackend(join(root, 'storage'))
  const reopened = await openPostmanTaskRegistry(facility())
  const afterRestart = createPostmanBridgeJobs({},
    { run() { sends++; throw Error('duplicate Send') }, dispose() {} }, null,
    { record: reopened.get, changeRecord: reopened.change }, null,
    new DirectPostmanJobManager({ directRoot }))
  assert.equal(reopened.get(parent.id).bridgeOperations.safe.phase, 'not-sent')
  assert.equal((await afterRestart.status(parent, 'safe')).status, 'POSTMAN_BRIDGE_NOT_SENT')
  assert.equal(afterRestart.list(parent).operations.find(op => op.bridgeJobId === 'safe').countsAgainstLimit, false)
  assert.equal(afterRestart.list(parent).used, 3)
  assert.equal(sends, 0)
  await afterRestart.dispose(); await reopened.close(); await backend.close()
})

test('Direct terminal receipt from text survives cold Bridge recovery without Send', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-direct-terminal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directRoot = join(root, 'direct')
  await mkdir(join(directRoot, 'requests'), { recursive: true })
  await mkdir(join(directRoot, 'results'), { recursive: true })
  const id = 'REQ_20261004T020202Z_0001'
  const sha = createHash('sha256').update('verified answer').digest('hex')
  const publication = { requestId: id, repository: 'AndrewVerhoturov1/dsh-workspace',
    branch: row().branch, baseCommit: 'a'.repeat(40), taskPublicationCommit: 'b'.repeat(40),
    taskUrl: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'b'.repeat(40) + '/' + id + '.md' }
  const terminal = { ...publication, ok: true, code: 'TEXT_RESULT_DURABLE', state: 'TEXT_RESULT_DURABLE',
    deliveryMode: 'inline', assistantText: 'verified answer', assistantTextSha256: sha }
  await writeFile(join(directRoot, 'requests', id + '.json'), JSON.stringify({ ...publication,
    state: 'ASK_WEB_RUNNING', publicationStarted: true }))
  await writeFile(join(directRoot, 'results', id + '.json'), JSON.stringify(terminal))
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { ...row(), bridgeOperations: { result: {
    state: 'unknown', transportKind: 'text', phase: 'request-known', requestId: id } } })
  let sends = 0, syncs = 0
  const jobs = createPostmanBridgeJobs({ agents: { get: () => parent } },
    { run() { sends++; throw Error('duplicate Send') }, dispose() {} }, null,
    { record: registry.get, changeRecord: registry.change,
      async sync() { syncs++; return false } }, null, new DirectPostmanJobManager({ directRoot }))
  const before = structuredClone(registry.get(parent.id))
  const observed = jobs.list(parent).operations[0]
  assert.equal(observed.publicationState, 'terminal')
  assert.equal(observed.publication.taskPublicationCommit, publication.taskPublicationCommit)
  assert.deepEqual(registry.get(parent.id), before, 'list does not persist recovery')
  const statuses = await Promise.all(Array.from({ length: 3 }, () => jobs.status(parent, 'result', true)))
  const status = statuses[0]
  assert.deepEqual(statuses.map(item => item.result?.assistantText), Array(3).fill('verified answer'))
  assert.equal(status.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(status.result.assistantText, 'verified answer')
  assert.equal(registry.get(parent.id).bridgeOperations.result.phase, 'terminal')
  assert.deepEqual({ sends, syncs }, { sends: 0, syncs: 1 })
  await jobs.dispose()
  await writeFile(join(directRoot, 'results', id + '.json'), JSON.stringify({ ...terminal, assistantText: 'tampered' }))
  const another = createPostmanBridgeJobs({}, { run() { throw Error('duplicate Send') }, dispose() {} }, null,
    { record: () => ({ ...row(), bridgeOperations: { result: { state: 'unknown', transportKind: 'text', requestId: id } } }),
      changeRecord() { throw Error('cannot trust tampered result') } }, null,
    new DirectPostmanJobManager({ directRoot }))
  assert.equal((await another.status(parent, 'result')).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
})

test('published transport failure handoff survives missing final checkpoint without resend', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-failure-terminal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'requests')); await mkdir(join(root, 'results'))
  const id = 'REQ_20261004T040404Z_0001'
  const publication = { requestId: id, repository: 'AndrewVerhoturov1/dsh-workspace', branch: row().branch,
    baseCommit: 'a'.repeat(40), taskPublicationCommit: 'b'.repeat(40),
    taskUrl: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'b'.repeat(40) + '/' + id + '.md' }
  await writeFile(join(root, 'requests', id + '.json'), JSON.stringify({ ...publication,
    state: 'ASK_WEB_RUNNING', publicationStarted: true }))
  await writeFile(join(root, 'results', id + '.json'), JSON.stringify({ ok: false,
    code: 'POSTMAN_TRANSPORT_FAILED', requestId: id, transportCode: 'WEB_ABORTED',
    transportMessage: 'web stopped', details: {}, publicationReceipt: publication }))
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { ...row(), bridgeOperations: { failed: {
    state: 'unknown', requestId: id, phase: 'request-known', transportKind: 'text' } } })
  let sends = 0, syncs = 0
  const jobs = createPostmanBridgeJobs({}, { run() { sends++; throw Error('duplicate Send') }, dispose() {} }, null,
    { record: registry.get, changeRecord: registry.change, async sync() { syncs++; return false } }, null,
    new DirectPostmanJobManager({ directRoot: root }))
  assert.equal(jobs.list(parent).operations[0].publicationState, 'terminal')
  const status = await jobs.status(parent, 'failed', true)
  assert.equal(status.result.code, 'POSTMAN_TRANSPORT_FAILED')
  assert.equal(status.result.publicationReceipt.requestId, id)
  assert.deepEqual({ sends, syncs }, { sends: 0, syncs: 1 })
})

test('failed durable artifact grant write preserves terminal as last authority', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { ...row(), bridgeOperations: { artifact: {
    state: 'received', phase: 'terminal', transportKind: 'artifact', requestId: 'REQ_20261004T030303Z_0001',
    terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED',
      requestId: 'REQ_20261004T030303Z_0001', transportKind: 'artifact', result: {
        ok: true, code: 'RESULT_DURABLE', requestId: 'REQ_20261004T030303Z_0001',
        taskPublicationCommit: 'b'.repeat(40), baseCommit: 'a'.repeat(40) } }, synchronization: 'pending' } } })
  let syncs = 0, grants = 0
  const jobs = createPostmanBridgeJobs({}, { run() { throw Error('no Direct send') }, dispose() {} },
    { async register() { grants++; throw Error('durable storage unavailable') } },
    { record: registry.get, changeRecord: registry.change, async sync() { syncs++; return true } })
  const status = await jobs.status(parent, 'artifact', true)
  assert.equal(status.status, 'POSTMAN_BRIDGE_FAILED')
  assert.equal(status.grantDiagnostic, 'durable storage unavailable')
  assert.equal(registry.get(parent.id).bridgeOperations.artifact.state, 'received')
  assert.equal(registry.get(parent.id).bridgeOperations.artifact.synchronization, 'synchronized')
  assert.equal(jobs.list(parent).used, 0)
  await jobs.status(parent, 'artifact', true)
  assert.deepEqual({ syncs, grants }, { syncs: 1, grants: 2 }, 'grant-only retry never replays Git sync')
  await jobs.dispose()
})

test('all Bridge phases remain distinguishable across isolated durable lifetimes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-phase-matrix-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = new JsonStorageBackend(root)
  const facility = () => new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} }, { backend: 'json', routes: {} })
  const phases = [
    ['reserved', { state: 'pending', phase: 'reserved', transportKind: 'text' }, true],
    ['child', { state: 'pending', phase: 'child-known', childSessionId: 'child-real', transportKind: 'text' }, true],
    ['request', { state: 'unknown', phase: 'request-known', requestId: 'REQ_20261004T050501Z_0001', transportKind: 'text' }, true],
    ['publication', { state: 'unknown', phase: 'publication-known', requestId: 'REQ_20261004T050502Z_0001',
      transportKind: 'text', publication: { requestId: 'REQ_20261004T050502Z_0001', taskPublicationCommit: 'b'.repeat(40) } }, true],
    ['terminal', { state: 'received', phase: 'terminal', transportKind: 'text', synchronization: 'pending',
      terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', transportKind: 'text',
        requestId: 'REQ_20261004T050503Z_0001', result: { ok: true, code: 'TEXT_RESULT_DURABLE', assistantText: 'durable' } } }, true],
    ['synced', { state: 'received', phase: 'synchronized', transportKind: 'text', synchronization: 'synchronized',
      terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', transportKind: 'text',
        requestId: 'REQ_20261004T050504Z_0001', result: { ok: true, code: 'TEXT_RESULT_DURABLE' } } }, false],
  ]
  const first = await openPostmanTaskRegistry(facility())
  await first.create(parent.id, { ...row(), bridgeOperations: Object.fromEntries(phases.map(([id, op]) => [id, op])) })
  await first.close()
  const second = await openPostmanTaskRegistry(facility())
  let sends = 0
  const cold = createPostmanBridgeJobs({}, { run() { sends++; throw Error('no duplicate Send') }, dispose() {} }, null,
    { record: second.get, changeRecord: second.change })
  const listed = cold.list(parent)
  assert.deepEqual(listed.operations.map(op => [op.bridgeJobId, op.phase, op.countsAgainstLimit]),
    phases.map(([id, op, busy]) => [id, op.phase, busy]))
  assert.equal(listed.used, 5)
  assert.deepEqual(await Promise.all(['reserved', 'child', 'request', 'publication'].map(async id =>
    (await cold.status(parent, id)).status)), Array(4).fill('POSTMAN_BRIDGE_OUTCOME_UNKNOWN'))
  assert.equal((await cold.status(parent, 'terminal')).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal((await cold.status(parent, 'synced')).synchronization, 'synchronized')
  assert.equal(sends, 0)
  await cold.dispose(); await second.close(); await backend.close()
})

test('three Bridge intents survive independent JSON domain lifetimes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-bridge-journal-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const ctx = { storage: { backend: { get: () => backend } }, emit() {} }
  const domain = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const first = await openPostmanTaskRegistry(domain)
  await first.create(parent.id, row())
  const { accepted } = await exercise(first)
  await first.close()
  const reopened = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json' }))
  const cold = fixture(reopened)
  assert.deepEqual(await Promise.all(accepted.map(async job => (await cold.jobs.status(parent, job.bridgeJobId)).status)),
    Array(3).fill('POSTMAN_BRIDGE_OUTCOME_UNKNOWN'))
  assert.equal(cold.started, 0)
  assert.equal(Object.values(reopened.get(parent.id).workers)[0].id, 'child-C')
  await reopened.close()
  await backend.close()
})


test('verified terminal persists through independent JSON-domain lifetimes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-terminal-journal-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const ctx = { storage: { backend: { get: () => backend } }, emit() {} }
  const first = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json', routes: {} }))
  await first.create(parent.id, row())
  const result = { ok: true, code: 'TEXT_RESULT_DURABLE', assistantText: 'persisted',
    taskPublicationCommit: 'b'.repeat(40), baseCommit: 'a'.repeat(40) }
  await first.change(parent.id, current => ({ ...current, bridgeOperations: { job: {
    state: 'received', terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', requestId: 'REQ_ONE',
      terminalStatus: 'COMPLETED', transportKind: 'text', result }, synchronization: 'busy' } } }))
  await first.close()
  const reopened = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json' }))
  const cold = fixture(reopened)
  const status = await cold.jobs.status(parent, 'job')
  assert.equal(status.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.deepEqual(status.result, result)
  assert.equal(status.synchronization, 'busy')
  assert.equal(cold.started, 0)
  assert.equal(Object.values(reopened.get(parent.id).workers)[0].id, 'child-C')
  await reopened.close()
  await backend.close()
})

test('failed artifact grant diagnostic survives independent JSON-domain lifetime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-grant-journal-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const ctx = { storage: { backend: { get: () => backend } }, emit() {} }
  const first = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json', routes: {} }))
  await first.create(parent.id, row())
  await first.change(parent.id, current => ({ ...current, bridgeOperations: { artifact: {
    state: 'received', terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', requestId: 'REQ_ONE',
      terminalStatus: 'COMPLETED', transportKind: 'artifact', result: { ok: true, code: 'RESULT_DURABLE' } },
    synchronization: 'synchronized', grantDiagnostic: 'Artifact grant registration rejected.' } } }))
  await first.close()
  const reopened = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json' }))
  const cold = fixture(reopened)
  const status = await cold.jobs.status(parent, 'artifact')
  assert.equal(status.status, 'POSTMAN_BRIDGE_FAILED')
  assert.equal(status.trustedStatus, 'POSTMAN_BRIDGE_TERMINAL')
  assert.match(status.grantDiagnostic, /registration rejected/)
  await reopened.close()
  await backend.close()
})

test('local lifecycle failures reopen without terminal promotion or Direct resend', async t => {
  for (const outcome of ['before-request', 'terminal', 'proven-not-sent', 'published', 'unknown']) await t.test(outcome, async t => {
    const root = await mkdtemp(join(tmpdir(), 'postman-local-failure-'))
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    const storageRoot = join(root, 'storage'), directRoot = join(root, 'direct')
    await mkdir(join(directRoot, 'requests'), { recursive: true })
    await mkdir(join(directRoot, 'results'), { recursive: true })
    const requestId = 'REQ_20261004T060606Z_0001'
    const publication = { requestId, repository: 'AndrewVerhoturov1/dsh-workspace', branch: row().branch,
      baseCommit: 'a'.repeat(40), taskPublicationCommit: 'b'.repeat(40),
      taskUrl: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'b'.repeat(40) + '/' + requestId + '.md' }
    if (outcome === 'proven-not-sent') await writeFile(join(directRoot, 'requests', requestId + '.json'),
      JSON.stringify({ requestId, repository: publication.repository, branch: publication.branch,
        state: 'ASK_FAILED', publicationStarted: false }))
    if (['terminal', 'published'].includes(outcome)) await writeFile(join(directRoot, 'requests', requestId + '.json'),
      JSON.stringify({ ...publication, state: 'ASK_WEB_RUNNING', publicationStarted: true }))
    if (outcome === 'terminal') await writeFile(join(directRoot, 'results', requestId + '.json'),
      JSON.stringify({ ...publication, ok: true, code: 'TEXT_RESULT_DURABLE', state: 'TEXT_RESULT_DURABLE',
        deliveryMode: 'inline', assistantText: 'authoritative answer',
        assistantTextSha256: createHash('sha256').update('authoritative answer').digest('hex') }))
    const open = async () => {
      const backend = new JsonStorageBackend(storageRoot)
      const registry = await openPostmanTaskRegistry(new DomainFacility({
        storage: { backend: { get: () => backend } }, emit() {} }, { backend: 'json', routes: {} }))
      return { backend, registry }
    }
    const first = await open()
    await first.registry.create(parent.id, row())
    const taskContext = Object.freeze({ branch: row().branch })
    let bridgeJobId, sends = 0, syncs = 0, grants = 0
    const ready = new Promise(resolve => { parent.followup = resolve })
    const direct = new DirectPostmanJobManager({ directRoot })
    direct.start = () => { sends++; throw Error('Direct Send forbidden') }
    const jobs = createPostmanBridgeJobs({ agents: { get: () => parent }, subagents: { async start() {
      if (outcome === 'before-request') throw Error('controlled local startup failure')
      return { id: 'local-child', localAgent: { id: 'local-child' },
        result: Promise.resolve({ stopReason: 'error' }), async dispose() {} }
    } }, tools: { get: () => ({ async execute() {
      // The exact request allocation is persisted before the child loses its status.
      await first.registry.change(parent.id, current => ({ ...current, bridgeOperations: {
        ...current.bridgeOperations, [bridgeJobId]: { ...current.bridgeOperations[bridgeJobId], requestId, phase: 'request-known' } } }))
      return { status: 'NO_JOB' }
    } }) } }, { run: (_signal, launch) => Promise.resolve().then(launch), dispose() {} },
    { register() { grants++; throw Error('local failure cannot authorize grants') } },
    { get: () => taskContext, record: first.registry.get, changeRecord: first.registry.change,
      bindChild: () => true, releaseChild() {}, sync() { syncs++; throw Error('no local failure sync') } }, null, direct)
    const receipt = await jobs.accept(parent, '@PostmanAsk controlled local failure', 'text')
    bridgeJobId = receipt.bridgeJobId
    assert.equal(receipt.status, 'POSTMAN_BRIDGE_ACCEPTED')
    await ready
    const operation = first.registry.get(parent.id).bridgeOperations[bridgeJobId]
    assert.equal(operation.state, 'unknown')
    assert.equal(operation.terminal, undefined)
    assert.equal(operation.synchronization, undefined)
    assert.equal(operation.phase, outcome === 'before-request' ? 'reserved' : 'request-known')
    assert.equal(operation.requestId, outcome === 'before-request' ? undefined : requestId)
    assert.equal(jobs.list(parent).used, 1)
    assert.equal((await jobs.status(parent, bridgeJobId)).status, 'POSTMAN_BRIDGE_FAILED')
    await jobs.dispose(); await first.registry.close(); await first.backend.close()
    const second = await open()
    let inspections = 0
    const inspect = direct.inspectRequest.bind(direct)
    direct.inspectRequest = (...args) => { inspections++; assert.deepEqual(args, [requestId, row().branch, 'text']); return inspect(...args) }
    const cold = createPostmanBridgeJobs({}, { run() { sends++; throw Error('no replay') }, dispose() {} },
      { register() { grants++; throw Error('unexpected grant') } },
      { record: second.registry.get, changeRecord: second.registry.change,
        sync() { syncs++; throw Error('unexpected sync') } }, null, direct)
    const status = await cold.status(parent, bridgeJobId)
    assert.equal(inspections, outcome === 'before-request' ? 0 : 1)
    assert.equal(status.status, outcome === 'terminal' ? 'POSTMAN_BRIDGE_TERMINAL' :
      outcome === 'proven-not-sent' ? 'POSTMAN_BRIDGE_NOT_SENT' : 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
    if (outcome === 'terminal') {
      assert.equal(status.result.assistantText, 'authoritative answer')
      assert.equal(second.registry.get(parent.id).bridgeOperations[bridgeJobId].terminal.status, 'POSTMAN_BRIDGE_TERMINAL')
    } else assert.equal(second.registry.get(parent.id).bridgeOperations[bridgeJobId].terminal, undefined)
    assert.equal(cold.list(parent).used, outcome === 'proven-not-sent' ? 0 : 1)
    assert.deepEqual({ sends, syncs, grants }, { sends: 0, syncs: 0, grants: 0 })
    await cold.dispose(); await second.registry.close(); await second.backend.close()
  })
})

test('invalid received terminals reopen fail-closed without synchronization, grants or slot release', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-invalid-terminal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const open = async () => {
    const backend = new JsonStorageBackend(root)
    const registry = await openPostmanTaskRegistry(new DomainFacility({
      storage: { backend: { get: () => backend } }, emit() {} }, { backend: 'json', routes: {} }))
    return { backend, registry }
  }
  const terminal = { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED',
    requestId: 'REQ_20261004T070707Z_0001', transportKind: 'artifact', result: { ok: true, code: 'RESULT_DURABLE' } }
  const operations = {
    local: { state: 'received', phase: 'terminal', synchronization: 'pending', terminal: { status: 'POSTMAN_BRIDGE_START_FAILED' } },
    falseSync: { state: 'received', phase: 'synchronized', synchronization: 'synchronized', terminal: { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' } },
    falseNotRequired: { state: 'received', phase: 'terminal', synchronization: 'not-required', terminal: { status: 'POSTMAN_BRIDGE_CHILD_UNAVAILABLE' } },
    mismatchedRequest: { state: 'received', phase: 'terminal', synchronization: 'pending', requestId: 'REQ_20261004T070707Z_0002', terminal },
    mismatchedTransport: { state: 'received', phase: 'terminal', synchronization: 'pending', transportKind: 'text', terminal },
  }
  const first = await open()
  await first.registry.create(parent.id, { ...row(), bridgeOperations: operations })
  await first.registry.close(); await first.backend.close()
  const second = await open()
  const unexpected = () => { throw Error('untrusted terminal must not authorize side effects') }
  const cold = createPostmanBridgeJobs({}, { run: unexpected, dispose() {} }, { register: unexpected },
    { get: () => ({ branch: row().branch }), record: second.registry.get, changeRecord: unexpected, sync: unexpected }, null,
    { inspectRequest: () => ({ state: 'unknown' }) })
  for (const id of Object.keys(operations)) {
    assert.equal((await cold.status(parent, id, true)).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  }
  assert.deepEqual(second.registry.get(parent.id).bridgeOperations, operations)
  assert.equal(cold.list(parent).used, 5)
  assert.equal((await cold.accept(parent, '@PostmanAsk blocked', 'text')).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  await cold.dispose(); await second.registry.close(); await second.backend.close()
})

const tick = () => new Promise(resolve => setImmediate(resolve))
test('three same-Leader jobs run independently, fourth waits for a settled slot', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, row())
  const taskContext = Object.freeze({ branch: registry.get(parent.id).branch })
  const contexts = { get: () => taskContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false,
    beginSync: () => true, endSync() {}, bindChild: () => true, releaseChild() {}, async sync() { return true } }
  const completions = []
  let starts = 0
  const ctx = { agents: { get: () => parent }, subagents: { async start() {
    const id = 'child-' + ++starts
    let finish
    const result = new Promise(resolve => { finish = resolve })
    completions.push(finish)
    return { id, localAgent: { id }, result, async dispose() {} }
  } }, tools: { get: () => ({ async execute(_args, exec) {
    const id = exec.agent.id
    return { status: 'COMPLETED', requestId: id, result: { requestId: id, ok: true, code: 'TEXT_RESULT_DURABLE' } }
  } }) } }
  parent.followup = () => {}
  const coordinator = { run: (_signal, launch) => launch(), dispose() {} }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, null, contexts)
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(i => jobs.accept(parent, '@PostmanAsk ' + i, 'text')))
  await tick()
  assert.deepEqual([a.status, b.status, c.status], Array(3).fill('POSTMAN_BRIDGE_ACCEPTED'))
  assert.equal(starts, 3)
  assert.equal(new Set([a, b, c].map(x => x.bridgeJobId)).size, 3)
  assert.deepEqual(await Promise.all([a, b, c].map(async x => (await jobs.status(parent, x.bridgeJobId)).status)),
    Array(3).fill('POSTMAN_BRIDGE_RUNNING'))
  assert.equal((await jobs.accept(parent, '@PostmanAsk D', 'text')).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  completions[1]({ stopReason: 'end_turn' })
  await tick(); await tick(); await tick()
  assert.equal((await jobs.status(parent, b.bridgeJobId)).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(registry.get(parent.id).bridgeOperations[b.bridgeJobId], undefined)
  assert.equal((await jobs.status(parent, a.bridgeJobId)).status, 'POSTMAN_BRIDGE_RUNNING')
  const d = await jobs.accept(parent, '@PostmanAsk D', 'text')
  assert.equal(d.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await tick()
  assert.equal(starts, 4)
  completions[0]({ stopReason: 'end_turn' }); completions[2]({ stopReason: 'end_turn' }); completions[3]({ stopReason: 'end_turn' })
  await tick(); await tick(); await tick()
  assert.deepEqual(await Promise.all([a, c, d].map(async x => (await jobs.status(parent, x.bridgeJobId)).status)),
    Array(3).fill('POSTMAN_BRIDGE_TERMINAL'))
  assert.deepEqual(registry.get(parent.id).bridgeOperations, {})
  await jobs.dispose()
})


test('proven pre-publication failure persists not-required across restarts and admission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-early-terminal-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const storage = { storage: { backend: { get: () => backend } }, emit() {} }
  const registry = await openPostmanTaskRegistry(new DomainFacility(storage, { backend: 'json', routes: {} }))
  await registry.create(parent.id, row())
  const taskContext = Object.freeze({ branch: row().branch })
  let sends = 0, syncs = 0
  const contexts = { get: () => taskContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false, bindChild: () => true, releaseChild() {},
    async sync() { syncs++; throw Error('no publication exists') } }
  const ctx = { agents: { get: () => parent }, subagents: { async start() {
    sends++
    const id = 'child-' + sends
    return { id, localAgent: { id }, result: Promise.resolve({ stopReason: 'end_turn' }), async dispose() {} }
  } }, tools: { get: () => ({ async execute() {
    const requestId = 'REQ_20260929T01010' + sends + 'Z_0001'
    return { status: 'FAILED', requestId, result: { ok: false, code: 'POSTMAN_TRANSPORT_FAILED',
      requestId, transportCode: sends % 2 ? 'IMAGE_GENERATION_ABORTED' : 'POSTMAN_INPUT_BUNDLE_HANDOFF_INVALID',
      transportMessage: 'rejected before publication', publicationStarted: false,
      details: sends % 2 ? {} : { sendState: 'PROVEN_NOT_SENT', inputBundlePhase: 'direct-handoff' } } }
  } }) } }
  const jobs = createPostmanBridgeJobs(ctx, { run: (_signal, launch) => launch(), dispose() {} }, null, contexts)
  const receipts = []
  for (let i = 0; i < 5; i++) {
    const receipt = await jobs.accept(parent, '@PostmanAsk early failure ' + i, 'text')
    assert.equal(receipt.status, 'POSTMAN_BRIDGE_ACCEPTED')
    receipts.push(receipt)
    for (let attempt = 0; attempt < 40 &&
      !['not-required', 'busy'].includes(registry.get(parent.id).bridgeOperations[receipt.bridgeJobId]?.synchronization); attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    const status = await jobs.status(parent, receipt.bridgeJobId)
    assert.equal(status.synchronization, 'not-required', JSON.stringify({ status, op: registry.get(parent.id).bridgeOperations[receipt.bridgeJobId] }))
    assert.equal(status.state, 'TERMINAL')
    const op = registry.get(parent.id).bridgeOperations[receipt.bridgeJobId]
    assert.equal(op.state, 'received')
    assert.equal(op.synchronization, 'not-required')
  }
  assert.deepEqual({ sends, syncs }, { sends: 5, syncs: 0 })
  await jobs.dispose(); await registry.close()
  const reopened = await openPostmanTaskRegistry(new DomainFacility(storage, { backend: 'json' }))
  for (const receipt of receipts) {
    assert.equal(reopened.get(parent.id).bridgeOperations[receipt.bridgeJobId].synchronization, 'not-required')
  }
  const cold = createPostmanBridgeJobs({ agents: { get: () => parent } },
    { run() { throw Error('must not resend') }, dispose() {} }, null,
    { record: reopened.get, changeRecord: reopened.change, async sync() { throw Error('must not sync') } })
  for (const receipt of receipts) {
    const status = await cold.status(parent, receipt.bridgeJobId)
    assert.equal(status.synchronization, 'not-required')
    assert.equal((await cold.status(parent, receipt.bridgeJobId, true)).synchronization, 'not-required')
  }
  await cold.dispose(); await reopened.close(); await backend.close()
})

test('absence of publication proof alone retains busy received terminal and unknown intent cap', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, row())
  const context = Object.freeze({ branch: row().branch })
  let sends = 0
  const jobs = createPostmanBridgeJobs({ agents: { get: () => parent }, subagents: { async start() {
    sends++
    return { id: 'mock-child', localAgent: { id: 'mock-child' }, result: Promise.resolve({ stopReason: 'end_turn' }), async dispose() {} }
  } }, tools: { get: () => ({ async execute() { return { status: 'FAILED', requestId: 'REQ_UNKNOWN',
    result: { ok: false, code: 'POSTMAN_TRANSPORT_FAILED', requestId: 'REQ_UNKNOWN',
      transportCode: 'WEB_FAILED', transportMessage: 'publication unknown', details: {} } } } }) } },
  { run: (_signal, launch) => launch(), dispose() {} }, null,
  { get: () => context, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false, bindChild: () => true, releaseChild() {},
    async sync() { throw Error('must not sync') } })
  const receipt = await jobs.accept(parent, '@PostmanAsk unknown', 'text')
  await tick(); await tick(); await tick()
  assert.equal((await jobs.status(parent, receipt.bridgeJobId)).synchronization, 'busy')
  assert.equal(registry.get(parent.id).bridgeOperations[receipt.bridgeJobId].synchronization, 'pending')
  assert.equal((await jobs.status(parent, receipt.bridgeJobId, true)).synchronization, 'busy')
  assert.equal(sends, 1)
  await registry.change(parent.id, row => ({ ...row, bridgeOperations: { ...row.bridgeOperations,
    oldA: { state: 'unknown' }, oldB: { state: 'unknown' }, oldC: { state: 'unknown' } } }))
  assert.equal((await jobs.accept(parent, '@PostmanAsk blocked', 'text')).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  assert.equal(sends, 1)
  await jobs.dispose()
})

test('one interrupted job does not block an independent new Bridge', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { ...row(), bridgeOperations: { oldA: { state: 'unknown' } } })
  const f = fixture(registry)
  const accepted = await f.jobs.accept(parent, '@PostmanAsk new B', 'text')
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal((await f.jobs.status(parent, 'oldA')).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  assert.equal((await f.jobs.status(parent, accepted.bridgeJobId)).status, 'POSTMAN_BRIDGE_QUEUED')
  assert.equal(registry.get(parent.id).bridgeOperations.oldA.state, 'unknown')
  assert.equal(registry.get(parent.id).bridgeOperations[accepted.bridgeJobId].state, 'pending')
  assert.equal(f.started, 0)
})

test('backend refusal cannot create or launch an unjournaled Bridge', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, row())
  const f = fixture({ get: registry.get, async change() { throw Error('disk unavailable') } })
  const result = await f.jobs.accept(parent, '@PostmanAsk unsafe', 'text')
  assert.equal(result.status, 'POSTMAN_BRIDGE_ADMISSION_FAILED')
  assert.match(result.diagnostic, /disk unavailable/)
  assert.equal(f.started, 0)
  assert.equal(registry.get(parent.id).bridgeOperations, undefined)
})

test('old presend failure with full proof releases slot locally; missing proof remains diagnostic', async () => {
  const registry = createMemoryTaskRegistry()
  const ids = ['1103ac1e-6e22-4168-998d-0eed73790cfc', 'ba8a3918-31b3-4a7a-b4ea-a388634e7d1e']
  const terminal = (requestId, extra) => ({ status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', requestId,
    result: { ok: false, code: 'POSTMAN_TRANSPORT_FAILED', directVersion: 5, requestId, transportMessage: 'failed before publication', ...extra } })
  await registry.create(parent.id, { ...row(), bridgeOperations: {
    [ids[0]]: { state: 'received', synchronization: 'pending', terminal: terminal('REQ_20261003T102744Z_5744', { transportCode: 'DIRECT_CHAT_REFERENCE_UNAVAILABLE', details: {} }) },
    [ids[1]]: { state: 'received', synchronization: 'pending', terminal: terminal('REQ_20261003T103121Z_0257', { transportCode: 'BRIDGE_PIPELINE_FAILED', publicationStarted: false, details: { value: null } }) },
  } })
  let sends = 0, syncs = 0
  const jobs = createPostmanBridgeJobs({ agents: { get: () => parent }, subagents: { start() { sends++; throw Error('no Send') } } },
    { run() { sends++; throw Error('no transport') }, dispose() {} }, null,
    { record: registry.get, changeRecord: registry.change, sync() { syncs++; throw Error('no Git publication') } })
  const unknown = await jobs.status(parent, ids[0], true)
  assert.equal(unknown.synchronization, 'busy')
  assert.deepEqual(unknown.syncDiagnostic, { code: 'PUBLICATION_PROOF_MISSING' })
  assert.equal((await jobs.status(parent, ids[1], true)).synchronization, 'not-required')
  assert.equal((await jobs.status(parent, ids[1], true)).synchronization, 'not-required')
  assert.deepEqual({ sends, syncs }, { sends: 0, syncs: 0 })
  await jobs.dispose()
})

