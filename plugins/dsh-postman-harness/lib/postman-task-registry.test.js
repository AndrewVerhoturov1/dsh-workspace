import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { openPostmanTaskRegistry, sharedPostmanTaskRegistry, closeSharedPostmanTaskRegistry } from './postman-task-registry.js'

const record = { leaderSessionId: 'leader', repository: 'andrewverhoturov1/dsh-workspace', repositoryPath: 'C:/repo',
  originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git', baseCommit: 'a'.repeat(40),
  branch: 'task/postman-' + 'b'.repeat(32), worktree: 'C:/task', stage: 'intent', diagnostic: null,
  worker: null, runner: { state: 'none', requestId: null }, bridge: null }

test('resumed task replacement persists PR identity and revoked audit; stale replacement cannot overwrite it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-resume-registry-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const ctx = { storage: { backend: { get: () => backend } }, emit() {} }
  let registry = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json' }))
  await registry.create('leader', record)
  await registry.change('leader', row => ({ ...row, stage: 'closed', abandoned: true,
    bridgeOperations: { old: { state: 'unknown', executionRevoked: true } } }))
  const old = registry.get('leader'), { worker, ...current } = record
  const resumed = { ...current, workers: {}, stage: 'ready', bindingId: 'new-generation',
    pullRequest: { number: 477, url: 'https://github.com/AndrewVerhoturov1/dsh-workspace/pull/477', base: 'main' },
    resumedFrom: { leaderSessionId: 'leader' } }
  await registry.replace('leader', old, resumed)
  await assert.rejects(registry.replace('leader', old, resumed), /BINDING_CHANGED/)
  await registry.close()
  registry = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json' }))
  assert.equal(registry.get('leader').bindingId, resumed.bindingId)
  assert.deepEqual(registry.get('leader').pullRequest, resumed.pullRequest)
  assert.deepEqual(registry.get('leader').resumedFrom, resumed.resumedFrom)
  assert.equal(registry.get('leader').bridgeOperations, undefined)
  assert.equal(registry.get('leader').retiredTasks[0].bridgeOperations.old.executionRevoked, true)
  assert.equal(registry.get('leader').retiredTasks[0].bridgeOperations.old.state, 'unknown')
  await registry.close(); await backend.close()
})

test('JSON storage persists one Leader row across independent domain lifetimes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-registry-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const ctx = { storage: { backend: { get(name) { assert.equal(name, 'json'); return backend } } },
    emit() {} }
  const domain = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const first = await openPostmanTaskRegistry(domain)
  await first.create('leader', record)
  await first.change('leader', row => ({ ...row, stage: 'ready', workers: { 'reserved-C': { id: 'reserved-C',
    label: 'reserved-C', state: 'intent', delivery: 'pending', artifactRequests: [] } },
    appJobs: { app: { jobId: 'native-app-1', workerSessionId: 'reserved-C', assignmentId: 'assignment',
      worktree: record.worktree, port: 4173, terminal: 'completed' } },
    bridgeOperations: { cancelled: { state: 'pending', phase: 'reserved', cancellationRequested: true },
      preflight: { state: 'received', phase: 'not-sent', transportKind: 'devspace',
        synchronization: 'not-required', devspace: { mode: 'WRITE_ISOLATED', laneId: 'synthetic-no-send' },
        preSendFailure: 'POSTMAN_DEVSPACE_WORKTREE_NOT_READY' } } }))
  await assert.rejects(() => openPostmanTaskRegistry(domain), error => error.code === 'already-open')
  await first.close()
  const second = await openPostmanTaskRegistry(domain)
  assert.equal(second.get('leader').branch, record.branch)
  assert.equal(second.get('leader').workers['reserved-C'].id, 'reserved-C')
  assert.equal(second.get('leader').appJobs.app.terminal, 'completed', 'Host-observed native process terminal survives cold loss of job controller')
  assert.equal(second.get('leader').bridgeOperations.cancelled.cancellationRequested, true)
  assert.equal(second.get('leader').bridgeOperations.preflight.preSendFailure, 'POSTMAN_DEVSPACE_WORKTREE_NOT_READY',
    'exact trusted pre-Send reason survives first JsonStorage cold reopen')
  await second.change('leader', row => ({ ...row, runner: { state: 'failed', requestId: 'REQ_1' } }))
  await second.create('selected', { ...record, leaderSessionId: 'selected',
    selectedDshProject: true })
  await second.close()
  const third = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json' }))
  assert.equal(third.get('leader').runner.state, 'failed')
  assert.equal(third.get('leader').bridgeOperations.preflight.preSendFailure, 'POSTMAN_DEVSPACE_WORKTREE_NOT_READY',
    'exact native NOT_SENT evidence survives second independent JsonStorage open')
  assert.equal(third.get('selected').selectedDshProject, true,
    'new explicit DSH root flag survives strict durable reopen')
  assert.equal(third.get('leader').selectedDshProject, undefined,
    'historical DSH row remains unchanged')
  assert.deepEqual([...third.entries()].map(([id]) => id), ['leader', 'selected'])
  await third.close()
  await backend.close()
})

test('legacy v1 JSON rows migrate durably after a single open, preserving unrelated fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-registry-migration-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const ctx = { storage: { backend: { get: () => backend } }, emit() {} }
  const facility = new DomainFacility(ctx, { backend: 'json' })
  const legacySpec = defineDomain({ name: 'postman_task_registry', version: 1,
    tables: { leaders: domainTable(z.object({}).passthrough()) } })
  const old = await facility.open(legacySpec)
  const worker = { id: 'worker-A', state: 'uncertain', delivery: 'unknown', artifactRequests: ['REQ_1'] }
  const legacy = { ...record, worker, bridgeOperations: { bridge1: { state: 'pending' } } }
  await old.table('leaders').put('leader', legacy)
  await old.close()
  let opens = 0
  const storage = { open(spec) { opens++; return facility.open(spec) } }
  const migrated = await openPostmanTaskRegistry(storage)
  assert.equal(opens, 1)
  assert.deepEqual(migrated.get('leader').workers, { 'worker-A': { ...worker, label: 'worker-A' } })
  assert.deepEqual(migrated.get('leader').bridgeOperations, legacy.bridgeOperations)
  await migrated.change('leader', () => ({ stage: 'ready', workers: { 'worker-A': { ...worker, label: 'worker-A' },
    'worker-B': { ...worker, id: 'worker-B', label: 'worker-B', artifactRequests: [] } } }))
  assert.equal(Object.hasOwn(migrated.get('leader'), 'worker'), false)
  assert.equal(migrated.get('leader').runner.state, 'none')
  await migrated.close()
  const again = await openPostmanTaskRegistry(storage)
  assert.equal(opens, 2)
  assert.deepEqual(Object.keys(again.get('leader').workers), ['worker-A', 'worker-B'])
  assert.equal(again.get('leader').stage, 'ready')
  await again.close()
  await backend.close()
})

test('two entrypoints share one open handle and close exactly once', async () => {
  let opens = 0, closes = 0
  const records = new Map()
  const storage = { async open() { opens++; return { table: () => ({ get: id => records.get(id),
    entries: () => records.entries(), async put(id, row) { records.set(id, row) },
    async update(id, fn) { const row = fn(records.get(id)); records.set(id, row); return row } }),
    async close() { closes++ } } } }
  const [a, b] = await Promise.all([sharedPostmanTaskRegistry(storage), sharedPostmanTaskRegistry(storage)])
  assert.equal(a, b)
  assert.equal(opens, 1)
  await closeSharedPostmanTaskRegistry()
  assert.equal(closes, 1)
})

test('missing production storage rejects rather than using volatile state', async () => {
  await assert.rejects(() => openPostmanTaskRegistry(undefined), /POSTMAN_TASK_STORAGE_REQUIRED/)
})

test('backend rejection never returns an accepted intent', async () => {
  const fake = { open: async () => ({ table: () => ({ get: () => undefined, entries: () => [][Symbol.iterator](),
    async put() { throw new Error('disk unavailable') } }), close: async () => {} }) }
  const registry = await openPostmanTaskRegistry(fake)
  await assert.rejects(() => registry.create('leader', record), /disk unavailable/)
  await registry.close()
})

test('JSON reopen retains independent Worker lifecycle and Bridge/runner fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-registry-lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = new JsonStorageBackend(root)
  const ctx = { storage: { backend: { get: () => backend } }, emit() {} }
  const open = () => openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json', routes: {} }))
  const registry = await open()
  const a = { id: 'A', label: 'A', state: 'ready', delivery: 'none', artifactRequests: [],
    lifecycle: { version: 1, admissions: [{ id: 'assignment', state: 'accepted', messageId: 'm' }],
      reports: [{ childId: 'A', turn: 1, callId: 'r', messageId: 'delivered' }] } }
  const b = { id: 'B', label: 'B', state: 'uncertain', delivery: 'unknown', artifactRequests: [] }
  const c = { id: 'C', label: 'C', state: 'ready', delivery: 'none', artifactRequests: [] }
  await registry.create('leader', { ...record, worker: undefined, workers: { A: a, B: b, C: c },
    bridgeOperations: { job: { state: 'received', synchronization: 'synchronized' } } })
  await registry.change('leader', row => ({ ...row, workers: { ...row.workers,
    A: { ...row.workers.A, state: 'stopping' } } }))
  await registry.close()
  const reopened = await open()
  assert.equal(reopened.get('leader').workers.A.lifecycle.reports[0].messageId, 'delivered')
  assert.equal(reopened.get('leader').workers.B.lifecycle, undefined)
  assert.equal(reopened.get('leader').workers.B.state, 'uncertain')
  assert.equal(reopened.get('leader').workers.C.id, 'C')
  assert.equal(reopened.get('leader').bridgeOperations.job.synchronization, 'synchronized')
  await reopened.change('leader', row => {
    const workers = { ...row.workers }; delete workers.A; return { workers }
  })
  assert.deepEqual(Object.keys(reopened.get('leader').workers), ['B', 'C'])
  assert.equal(reopened.get('leader').runner.state, 'none')
  await reopened.close(); await backend.close()
})


test('Secretary ledger exists before Git task, persists through cold reopen without branch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-ledger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = new JsonStorageBackend(root)
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} },
    { backend: 'json', routes: {} })
  const first = await openPostmanTaskRegistry(facility)
  assert.equal(first.get('leader'), null)
  assert.deepEqual(first.readLedger('leader'), { revision: 0, content: '', updatedBy: '' })
  await first.changeLedger('leader', old => ({
    revision: old.revision + 1, content: 'Goal: verify DevSpace', updatedBy: 'secretary'
  }))
  assert.equal(first.get('leader'), null)
  await first.close()
  const next = await openPostmanTaskRegistry(facility)
  assert.deepEqual(next.readLedger('leader'),
    { revision: 1, content: 'Goal: verify DevSpace', updatedBy: 'secretary' })
  assert.equal(next.get('leader'), null)
  await next.close()
  await backend.close()
})

test('Secretary ledger retains historical Leader-row revision on first update', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-legacy-ledger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = new JsonStorageBackend(root)
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} },
    { backend: 'json', routes: {} })
  const registry = await openPostmanTaskRegistry(facility)
  await registry.create('leader', { ...record, secretaryLedger: {
    revision: 6, content: 'Existing milestones', updatedBy: 'old-secretary' } })
  assert.equal(registry.readLedger('leader').revision, 6)
  await registry.changeLedger('leader', old => ({
    revision: old.revision + 1, content: old.content + '; new result', updatedBy: 'secretary' }))
  assert.equal(registry.readLedger('leader').revision, 7)
  assert.equal(registry.readLedger('leader').content, 'Existing milestones; new result')
  await registry.close()
  await backend.close()
})

test('universal project identity survives strict v1 JSON cold reopen without retargeting historical rows', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-registry-universal-'))
  t.after(() => rm(root, {recursive:true,force:true,maxRetries:5,retryDelay:100}))
  const backend = new JsonStorageBackend(root)
  const facility = new DomainFacility({storage:{backend:{get:()=>backend}},emit(){}}, {backend:'json'})
  const initial = await openPostmanTaskRegistry(facility)
  const universal = {...record,leaderSessionId:'owner-external',repository:'ExampleOrg/custom',
    repositoryPath:'C:/chosen/custom',originUrl:'https://github.com/ExampleOrg/custom.git',
    defaultBranch:'release/custom',baseSource:'cached',universalProject:true,
    worktree:'C:/isolated/custom-task',worker:null}
  await initial.create('owner-external',universal)
  await initial.close()
  const cold = await openPostmanTaskRegistry(facility)
  const reopened = cold.get('owner-external')
  assert.equal(reopened.repository,'ExampleOrg/custom')
  assert.equal(reopened.repositoryPath,'C:/chosen/custom')
  assert.equal(reopened.originUrl,'https://github.com/ExampleOrg/custom.git')
  assert.equal(reopened.defaultBranch,'release/custom')
  assert.equal(reopened.baseSource,'cached')
  assert.equal(reopened.universalProject,true)
  assert.equal(reopened.baseCommit,universal.baseCommit)
  await cold.close()
  await backend.close()
})
