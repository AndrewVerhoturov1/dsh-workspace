import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capabilityRuntime } from './fixtures/postman-capability-runtime.js'
import { postmanInputGrants } from './postman-input-files.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
const call = async (f, name, args = {}) => {
  const r = await f.execute(f.leader, 'ptc_execute', { program: 'return await tools.' + name + '(' + JSON.stringify(args) + ')', boundary: 'semantic_decision', description: 'Verify registered exact Bridge lifecycle' })
  assert.equal(r.isError, false, JSON.stringify(r)); assert.equal(r.value.status, 'ok', JSON.stringify(r.value)); return r.value.value
}

test('production inherited PTC Bridge stop retains input pin through actual cleanup and persists cancellation in JsonStorage', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stage2-bridge-'))
  const f = await capabilityRuntime(dir, { plan: () => null })
  const end = Promise.withResolvers(), cleanup = Promise.withResolvers(), disposing = Promise.withResolvers()
  let child, signal, disposed = 0
  t.after(async () => { end.resolve({ stopReason: 'aborted' }); cleanup.resolve(); await f.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }) })
  await f.turn(f.leader, 'Load required instruction context before bounded local verification')
  const modelRounds = f.requests.length
  await f.prepare()
  const empty = await call(f, 'postman_team_status')
  assert.equal(empty.bridge.used, 0); assert.deepEqual(empty.bridge.operations, [])
  const root = join(dir, 'private-input'); await mkdir(root)
  const bytes = 'selected-private-bytes', sha256 = createHash('sha256').update(bytes).digest('hex')
  const descriptor = { name: 'reference.txt', repository: 'AndrewVerhoturov1/dsh-workspace', commit: 'a'.repeat(40), path: 'tmp/reference.txt', sha256, byte_length: Buffer.byteLength(bytes), raw_url: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'a'.repeat(40) + '/tmp/reference.txt' }
  await writeFile(join(root, '001.bin'), bytes)
  const context = f.contexts.get(f.leader.id)
  postmanInputGrants.record(f.leader, context, { snapshotRoot: root, descriptors: [descriptor], materializations: [{ snapshot_path: join(root, '001.bin'), sha256, byte_length: descriptor.byte_length }] })
  // Only the existing spawn seam is controlled; production tool definitions,
  // inherited preset, QuickJS dispatch, jobs, registry and pins are untouched.
  f.ctx.subagents.start = async (_provider, request) => {
    signal = request.signal
    const handle = await f.ctx.agents.create({ sessionId: 'bridge-controlled-' + randomUUID(), agentOptions: { provider: 'codex', model: 'gpt-6-luna' }, meta: { cwd: dir, origin: 'subagent', delegationDepth: 1 } })
    child = handle.agent
    signal.addEventListener('abort', () => end.resolve({ stopReason: 'aborted' }), { once: true })
    return { id: child.id, localAgent: child, result: end.promise, async dispose() { disposed++; disposing.resolve(); await cleanup.promise; await handle.dispose() } }
  }
  const direct = await f.execute(f.leader, 'postman_bridge', { message: '@PostmanAsk forbidden direct' })
  assert.equal(direct.isError, true); assert.match(direct.error.message, /POSTMAN_PTC_DIRECT_CALL_REJECTED/)
  const accepted = await call(f, 'postman_bridge', { message: '@PostmanAsk --input-files-json ' + JSON.stringify([descriptor]) + '\nRead selected file' })
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED', JSON.stringify(accepted))
  await tick()
  assert.ok(postmanInputGrants.child(child, context, [descriptor]))
  postmanInputGrants.release(f.leader)
  assert.equal(existsSync(root), true, 'opaque Bridge pin owns bytes after Leader grant release')
  const stopped = await call(f, 'postman_bridge_stop', { bridge_job_id: accepted.bridgeJobId })
  assert.equal(stopped.status, 'POSTMAN_BRIDGE_STOP_REQUESTED', JSON.stringify(stopped)); assert.equal(stopped.intentPersisted, true)
  assert.equal(signal.aborted, true)
  await disposing.promise
  assert.equal(disposed, 1); assert.equal(existsSync(root), true)
  assert.ok(postmanInputGrants.child(child, context, [descriptor]), 'pin remains while child cleanup pending')
  assert.equal(f.registry.get('leader').bridgeOperations[accepted.bridgeJobId].cancellationRequested, true)
  const files = async path => { const rows = await readdir(path, { withFileTypes: true }); return (await Promise.all(rows.map(r => r.isDirectory() ? files(join(path, r.name)) : join(path, r.name)))).flat() }
  const disk = (await Promise.all((await files(join(dir, 'tasks'))).map(p => readFile(p, 'utf8')))).join('\n')
  assert.match(disk, /"cancellationRequested"\s*:\s*true/, 'actual JsonStorage bytes retain cancellation intent')
  const maintenance = Promise.withResolvers(), maintenanceEntered = Promise.withResolvers()
  const paused = f.leader.runMaintenance(async () => { maintenanceEntered.resolve(); await maintenance.promise })
  await maintenanceEntered.promise
  cleanup.resolve(); await tick(); await tick()
  assert.equal(existsSync(root), false); assert.equal(postmanInputGrants.child(child, context, [descriptor]), null)
  assert.equal(disposed, 1)
  const status = await call(f, 'postman_bridge_status', { bridge_job_id: accepted.bridgeJobId })
  assert.equal(status.status, 'POSTMAN_BRIDGE_FAILED', JSON.stringify(status))
  assert.equal(f.requests.length, modelRounds, 'no mechanical or remote model round after initial instruction catalog')
  const closing = f.dispose(); maintenance.resolve(); await paused; await closing
  assert.equal(disposed, 1); assert.equal(existsSync(root), false)
})
