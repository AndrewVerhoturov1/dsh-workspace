import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openPostmanTaskRegistry } from '../postman-task-registry.js'
import { createImplementationArtifactGrants } from '../implementation-artifact.js'

const [phase, root] = process.argv.slice(2)
const req = 'REQ_20261004T120000Z_1234', jobId = 'artifact-cleanup', ownerId = 'leader'
const backend = new JsonStorageBackend(join(root, 'storage'))
const registry = await openPostmanTaskRegistry(new DomainFacility({
  storage: { backend: { get: () => backend } }, emit() {},
}, { backend: 'json' }))
const grants = createImplementationArtifactGrants(registry)
const zip = join(root, 'result.zip')
let sends = 0, syncs = 0
const unexpectedSend = () => { sends++; throw new Error('Direct must never run') }
let jobs
try {
  if (phase === 'cleanup') {
    await writeFile(zip, 'trusted artifact bytes')
    const terminal = { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED',
      transportKind: 'artifact', requestId: req, result: { ok: true, code: 'RESULT_DURABLE',
        state: 'RESULT_DURABLE', requestId: req, repository: 'AndrewVerhoturov1/dsh-workspace',
        expectedFilename: 'POSTMAN_' + req + '_RESULT.zip', resultZip: zip,
        sha256: createHash('sha256').update('trusted artifact bytes').digest('hex'),
        taskPublicationCommit: 'b'.repeat(40), baseCommit: 'a'.repeat(40) } }
    await registry.create(ownerId,{leaderSessionId:ownerId,cwd:root,workers:{}})
    assert.equal(await grants.register(ownerId,terminal),true)
    assert.ok(registry.get(ownerId).artifactGrants[req])
  } else {
    assert.equal(await grants.resolve('foreign-leader', req), null)
    if (phase === 'resolve') {
      assert.equal((await grants.resolve(ownerId, req)).resultZip, zip)
      assert.ok(await grants.resolve(ownerId, req), 'grant retains reusable semantics')
    } else if (phase === 'tamper') {
      await writeFile(zip, 'substituted ZIP after process restart')
      assert.equal(await grants.resolve(ownerId, req), null, 'SHA is rechecked, not cached')
    } else throw new Error('unknown phase')
    assert.equal(syncs, 0)
  }
  assert.equal(sends, 0)
  console.log(JSON.stringify({ phase, sends, syncs, durableGrant: true }))
} finally {
  await jobs?.dispose()
  await registry.close()
  await backend.close()
}
