import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createImplementationArtifactGrants, IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeStatusTool } from './postman-bridge.js'
import { openPostmanTaskRegistry } from './postman-task-registry.js'

const REQ = 'REQ_20261002T085545Z_7698'
const JOB = '0534c191-a158-48c6-bf9d-272adfd28c7b'
const leader = id => ({ id, session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } })

async function fixture(t, { synchronization = 'synchronized', alter = terminal => terminal } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'postman-cold-grant-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const resultZip = join(root, `POSTMAN_${REQ}_RESULT.zip`)
  const bytes = Buffer.from('trusted transport ZIP fixture')
  await writeFile(resultZip, bytes)
  const terminal = alter({ status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED',
    transportKind: 'artifact', requestId: REQ, result: { ok: true, code: 'RESULT_DURABLE',
      state: 'RESULT_DURABLE', requestId: REQ, repository: IMPLEMENTATION_REPOSITORY,
      expectedFilename: `POSTMAN_${REQ}_RESULT.zip`, resultZip,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      taskPublicationCommit: 'b'.repeat(40), baseCommit: 'a'.repeat(40) } })
  const owner = leader('owning-leader'), foreign = leader('foreign-leader')
  const backend = new JsonStorageBackend(join(root, 'storage'))
  const domainContext = { storage: { backend: { get: () => backend } }, emit() {} }
  const first = await openPostmanTaskRegistry(new DomainFacility(domainContext, { backend: 'json', routes: {} }))
  await first.create(owner.id, { leaderSessionId: owner.id, repository: IMPLEMENTATION_REPOSITORY,
    repositoryPath: 'C:/repo', originUrl: 'https://github.com/AndrewVerhoturov1/dsh-workspace.git',
    baseCommit: 'a'.repeat(40), branch: 'task/postman-' + 'a'.repeat(32), worktree: 'C:/task',
    stage: 'ready', diagnostic: null, workers: {}, runner: { state: 'none', requestId: null },
    bridge: null, bridgeOperations: { [JOB]: { state: 'received', terminal, synchronization } } })
  await first.close()
  const registry = await openPostmanTaskRegistry(new DomainFacility(domainContext, { backend: 'json' }))
  const before = structuredClone(registry.get(owner.id))
  const grants = createImplementationArtifactGrants() // New process-local Map after restart.
  let registrations = 0, syncs = 0, sends = 0
  const agents = new Map([[owner.id, owner], [foreign.id, foreign]])
  const unexpectedSend = () => { sends++; throw Error('Direct send must not run') }
  const ctx = { agents: { get: id => agents.get(id) }, subagents: { start: unexpectedSend } }
  const jobs = createPostmanBridgeJobs(ctx, { run: unexpectedSend, dispose() {} },
    { async register(...args) { registrations++; return grants.register(...args) } },
    { record: registry.get, changeRecord: registry.change, async sync() { syncs++; throw Error('No Git synchronization needed') } })
  const tool = createPostmanBridgeStatusTool(ctx, jobs)
  t.after(async () => { await jobs.dispose(); await registry.close(); await backend.close() })
  return { owner, foreign, resultZip, terminal, grants, registry, before,
    status: (agent = owner, retrySync = false) => tool.execute({ bridge_job_id: JOB, retrySync }, { agent }),
    counts: () => ({ registrations, syncs, sends }) }
}

test('synchronized trusted artifact restores its lost grant after restart without sync or Direct replay', async t => {
  const f = await fixture(t)
  assert.equal(await f.grants.resolve(f.owner.id, REQ), null)
  const [first, overlapping] = await Promise.all([f.status(), f.status(f.owner, true)])
  for (const status of [first, overlapping, await f.status()]) {
    assert.equal(status.status, 'POSTMAN_BRIDGE_TERMINAL')
    assert.equal(status.synchronization, 'synchronized')
    assert.equal(status.grantDiagnostic, undefined)
    assert.deepEqual(status.result, f.terminal.result)
  }
  assert.equal((await f.grants.resolve(f.owner.id, REQ)).resultZip, f.resultZip)
  assert.equal(await f.grants.resolve(f.foreign.id, REQ), null)
  assert.deepEqual(f.counts(), { registrations: 1, syncs: 0, sends: 0 })
  assert.deepEqual(f.registry.get(f.owner.id), f.before, 'no registry rewriting')
})

test('foreign live Leader cannot restore or resolve another Leader artifact', async t => {
  const f = await fixture(t)
  assert.equal((await f.status(f.foreign)).status, 'POSTMAN_BRIDGE_JOB_NOT_FOUND')
  assert.deepEqual(f.counts(), { registrations: 0, syncs: 0, sends: 0 })
  assert.equal(await f.grants.resolve(f.foreign.id, REQ), null)
  assert.equal((await f.status()).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal((await f.status(f.foreign, true)).status, 'POSTMAN_BRIDGE_JOB_NOT_FOUND')
  const forgedOwner = leader(f.owner.id)
  assert.equal((await f.status(forgedOwner)).status, 'POSTMAN_BRIDGE_CALLER_REJECTED')
  assert.deepEqual(f.registry.get(f.owner.id), f.before)
})

test('substituted ZIP fails cold grant restoration despite synchronized receipt', async t => {
  const f = await fixture(t)
  await writeFile(f.resultZip, 'substituted bytes')
  const status = await f.status()
  assert.equal(status.status, 'POSTMAN_BRIDGE_FAILED')
  assert.equal(status.synchronization, 'synchronized', 'publication status is not fabricated')
  assert.match(status.grantDiagnostic, /registration rejected/)
  assert.equal(await f.grants.resolve(f.owner.id, REQ), null)
  assert.deepEqual(f.counts(), { registrations: 1, syncs: 0, sends: 0 })
  assert.deepEqual(f.registry.get(f.owner.id), f.before)
})

for (const [name, alter] of [
  ['mismatched REQ', terminal => ({ ...terminal, requestId: 'REQ_20261002T085545Z_9999' })],
  ['foreign repository', terminal => ({ ...terminal, result: { ...terminal.result, repository: 'someone/else' } })],
  ['model text instead of trusted terminal', terminal => ({ ...terminal, status: 'ASSISTANT_COMPLETED' })],
]) {
  test(name + ' never creates a recovered grant', async t => {
    const f = await fixture(t, { alter })
    await f.status()
    assert.equal(await f.grants.resolve(f.owner.id, REQ), null)
    assert.equal(f.counts().syncs, 0)
    assert.equal(f.counts().sends, 0)
    assert.deepEqual(f.registry.get(f.owner.id), f.before)
  })
}

for (const synchronization of ['pending', 'busy', 'failed', 'not-required']) {
  test('cold ' + synchronization + ' receipt cannot grant artifact before verified synchronization', async t => {
    const f = await fixture(t, { synchronization })
    await f.status()
    assert.equal(await f.grants.resolve(f.owner.id, REQ), null)
    assert.deepEqual(f.counts(), { registrations: 0, syncs: 0, sends: 0 })
    assert.deepEqual(f.registry.get(f.owner.id), f.before)
  })
}
