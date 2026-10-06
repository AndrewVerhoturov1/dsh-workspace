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
    bridgeOperations: { cancelled: { state: 'pending', phase: 'reserved', cancellationRequested: true } } }))
  await assert.rejects(() => openPostmanTaskRegistry(domain), error => error.code === 'already-open')
  await first.close()
  const second = await openPostmanTaskRegistry(domain)
  assert.equal(second.get('leader').branch, record.branch)
  assert.equal(second.get('leader').workers['reserved-C'].id, 'reserved-C')
  assert.equal(second.get('leader').bridgeOperations.cancelled.cancellationRequested, true)
  await second.change('leader', row => ({ ...row, runner: { state: 'failed', requestId: 'REQ_1' } }))
  await second.close()
  const third = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json' }))
  assert.equal(third.get('leader').runner.state, 'failed')
  assert.deepEqual([...third.entries()].map(([id]) => id), ['leader'])
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
