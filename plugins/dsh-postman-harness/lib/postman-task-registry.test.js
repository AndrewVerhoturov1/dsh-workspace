import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
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
  await first.change('leader', row => ({ ...row, stage: 'ready', worker: { id: 'reserved-C',
    state: 'intent', delivery: 'pending', artifactRequests: [] } }))
  await assert.rejects(() => openPostmanTaskRegistry(domain), error => error.code === 'already-open')
  await first.close()
  const second = await openPostmanTaskRegistry(domain)
  assert.equal(second.get('leader').branch, record.branch)
  assert.equal(second.get('leader').worker.id, 'reserved-C')
  await second.change('leader', row => ({ ...row, runner: { state: 'failed', requestId: 'REQ_1' } }))
  await second.close()
  const third = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json' }))
  assert.equal(third.get('leader').runner.state, 'failed')
  assert.deepEqual([...third.entries()].map(([id]) => id), ['leader'])
  await third.close()
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
  const fake = { open: async () => ({ table: () => ({ get: () => undefined,
    async put() { throw new Error('disk unavailable') } }), close: async () => {} }) }
  const registry = await openPostmanTaskRegistry(fake)
  await assert.rejects(() => registry.create('leader', record), /disk unavailable/)
  await registry.close()
})
