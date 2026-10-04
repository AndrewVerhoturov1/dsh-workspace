import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
test('durable artifact grant survives full production Bridge cleanup and separate Node processes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-grant-process-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const fixture = fileURLToPath(new URL('./fixtures/artifact-grant-restart.mjs', import.meta.url))
  for (const [phase, syncs] of [['cleanup', 1], ['resolve', 0], ['tamper', 0]]) {
    const { stdout, stderr } = await run(process.execPath, [fixture, phase, root], { timeout: 30000 })
    assert.equal(stderr, '')
    assert.deepEqual(JSON.parse(stdout.trim()), { phase, sends: 0, syncs, durableGrant: true })
  }
})
