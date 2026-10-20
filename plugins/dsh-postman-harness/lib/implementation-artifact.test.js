import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createImplementationArtifactGrants, createImplementationArtifactApplyTool,
  runImplementationPackage, IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createPostmanBridgeTool, createPostmanBridgeStatusTool } from './postman-bridge.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'

async function memoryGrants() {
  const registry = createMemoryTaskRegistry()
  for (const id of ['A', 'B']) await registry.create(id, { leaderSessionId: id })
  return createImplementationArtifactGrants(registry)
}

const REQ = 'REQ_20260925T112233Z_1234'
const SIGNAL = new AbortController().signal
const leader = id => ({ id, session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } })
const workerAgent = (id, parentSession) => ({ id, session: { header: {
  origin: 'subagent', parentSession, delegationDepth: 1,
} } })

async function artifactFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'grant-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const resultZip = join(dir, 'arbitrary-transport-location.zip')
  await writeFile(resultZip, 'test bytes')
  const sha256 = createHash('sha256').update('test bytes').digest('hex')
  const result = { ok: true, code: 'RESULT_DURABLE', state: 'RESULT_DURABLE',
    requestId: REQ, repository: IMPLEMENTATION_REPOSITORY,
    expectedFilename: `POSTMAN_${REQ}_RESULT.zip`, resultZip, sha256 }
  const terminal = { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', transportKind: 'artifact',
    requestId: REQ, result }
  return { dir, resultZip, sha256, result, terminal }
}

test('only exact trusted correlated artifact and intact exact ZIP register for owning Leader', async t => {
  const { terminal, resultZip } = await artifactFixture(t)
  const grants = await memoryGrants()
  for (const changed of [
    { status: 'POSTMAN_BRIDGE_NO_TRANSPORT' }, { terminalStatus: 'FAILED' }, { transportKind: 'text' },
    { requestId: 'REQ_20260925T112233Z_9876' }, { result: { ok: false } },
    { result: { code: 'ASSISTANT_COMPLETED_NO_ARTIFACT' } },
    { result: { state: 'ARTIFACT_REJECTED' } },
    { result: { expectedFilename: 'unexpected.zip' } },
    { result: { sha256: 'a'.repeat(64) } },
    { result: { resultZip: join(resultZip, '..', 'missing.zip') } },
  ]) {
    const malformed = { ...terminal, ...changed,
      result: { ...terminal.result, ...changed.result } }
    assert.equal(await grants.register('A', malformed), false)
  }
  assert.equal(await grants.resolve('A', REQ), null)
  assert.equal(await grants.register('A', terminal), true)
  assert.equal((await grants.resolve('A', REQ)).resultZip, resultZip)
  assert.equal(await grants.resolve('B', REQ), null)
  assert.equal(await grants.resolve('A', 'REQ_20260925T112233Z_9876'), null)
  assert.equal(await grants.register('A', { ...terminal, result: {
    ...terminal.result, sha256: 'b'.repeat(64) } }), false)
  await writeFile(resultZip, 'tampered')
  assert.equal(await grants.resolve('A', REQ), null)
  await rm(resultZip)
  assert.equal(await grants.resolve('A', REQ), null)
  assert.equal(await (await memoryGrants()).resolve('A', REQ), null)
})

test('durable grant storage failures and conflicting trusted registration fail closed', async t => {
  const { terminal } = await artifactFixture(t)
  assert.throws(() => createImplementationArtifactGrants(), /STORAGE_REQUIRED/)
  const registry = createMemoryTaskRegistry()
  await registry.create('A', { leaderSessionId: 'A' })
  const failed = createImplementationArtifactGrants({ get: registry.get, async change() { throw Error('disk unavailable') } })
  await assert.rejects(failed.register('A', terminal), /disk unavailable/)
  assert.equal(await failed.resolve('A', REQ), null)
  const grants = createImplementationArtifactGrants(registry)
  assert.equal(await grants.register('A', terminal), true)
  assert.equal(await grants.register('A', terminal), true, 'not one-shot')
  const before = structuredClone(registry.get('A'))
  const otherZip = join(terminal.result.resultZip, '..', 'other.zip')
  await writeFile(otherZip, 'test bytes')
  assert.equal(await grants.register('A', { ...terminal, result: { ...terminal.result, resultZip: otherZip } }), false)
  assert.deepEqual(registry.get('A'), before)
  assert.equal((await grants.resolve('A', REQ)).resultZip, terminal.result.resultZip)
})

test('runner invocation uses only trusted ZIP, argv-safe hidden launch and forwards PASS or FAIL', async t => {
  const { terminal } = await artifactFixture(t)
  const grants = await memoryGrants()
  await grants.register('A', terminal)
  const grant = await grants.resolve('A', REQ)
  const cases = [{ result: { ok: true, code: 'IMPLEMENTATION_PACKAGE_APPLIED',
    tests: [{ ok: true }], affectedPaths: ['src/a.js'], warnings: ['one'] }, exit: 0 },
  { result: { ok: false, code: 'PATCH_FAILED', stage: 'apply', diagnosticsZip: 'C:/diag.zip' }, exit: 1 }]
  for (const c of cases) {
    let call
    const spawnProcess = (program, args, options) => {
      call = { program, args, options }
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter()
      queueMicrotask(() => { proc.stdout.emit('data', JSON.stringify(c.result)); proc.emit('close', c.exit) })
      return proc
    }
    const response = await runImplementationPackage(grant, 'C:/clean worktree', { runner: 'C:/repo/runner.py', spawnProcess })
    assert.equal(response.status, 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT')
    assert.equal(response.exitCode, c.exit)
    assert.deepEqual(response.result, c.result)
    assert.equal(call.program, 'python')
    assert.deepEqual(call.args, ['-X', 'utf8', 'C:/repo/runner.py', 'apply', terminal.result.resultZip,
      '--repo', 'C:/clean worktree'])
    assert.equal(call.options.windowsHide, true)
  }
})

test('explicit Worker target reaches runner without Host Git checks; revoked REQ stays revoked',async t=>{
  const {terminal,dir}=await artifactFixture(t)
  const registry=createMemoryTaskRegistry(); await registry.create('A',{leaderSessionId:'A',workers:{},bridgeOperations:{job:{requestId:REQ}}})
  const grants=createImplementationArtifactGrants(registry); assert.equal(await grants.register('A',terminal),true)
  const caller=workerAgent('worker','A'); let invoked=false
  const tool=createImplementationArtifactApplyTool({agents:{get:id=>id===caller.id?caller:null}},grants,{ownerOf:(a,req)=>a===caller&&req===REQ?'A':null},{
    spawnProcess(_cmd,args){invoked=true; assert.ok(args.includes(dir));const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();queueMicrotask(()=>{child.stdout.emit('data',JSON.stringify({ok:true}));child.emit('close',0)});return child}
  })
  assert.equal((await tool.execute({requestId:REQ,worktree:dir},{agent:caller,signal:SIGNAL})).result.ok,true)
  assert.equal(invoked,true)
  await registry.change('A',row=>({...row,artifactGrants:{},bridgeOperations:{job:{requestId:REQ,terminal}}}))
  assert.ok(await grants.resolve('A',REQ),'explicit use repairs a grant write interrupted after durable terminal')
  await registry.change('A',row=>({...row,bridgeOperations:{job:{requestId:REQ,executionRevoked:true}}}))
  assert.equal((await tool.execute({requestId:REQ,worktree:dir},{agent:caller,signal:SIGNAL})).status,'IMPLEMENTATION_ARTIFACT_GRANT_REJECTED')
  assert.ok(registry.get('A').artifactGrants[REQ])
})
