import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createImplementationArtifactGrants, createImplementationArtifactApplyTool,
  runImplementationPackage, verifiedRepository, IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createPostmanBridgeTool, createPostmanBridgeStatusTool } from './postman-bridge.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'

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
  const grants = createImplementationArtifactGrants()
  for (const changed of [
    { status: 'POSTMAN_BRIDGE_NO_TRANSPORT' }, { terminalStatus: 'FAILED' }, { transportKind: 'text' },
    { requestId: 'REQ_20260925T112233Z_9876' }, { result: { ok: false } },
    { result: { code: 'ASSISTANT_COMPLETED_NO_ARTIFACT' } },
    { result: { state: 'ARTIFACT_REJECTED' } },
    { result: { repository: 'someone/else' } },
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
  assert.equal(await createImplementationArtifactGrants().resolve('A', REQ), null)
})

test('Bridge grant comes only from exact child-scoped status, not child prose', async t => {
  const { terminal } = await artifactFixture(t)
  const grants = createImplementationArtifactGrants()
  const parent = leader('A')
  const child = { id: 'bridge-child' }
  const ctx = {
    agents: { get: id => id === parent.id ? parent : undefined },
    subagents: { async start() { return { id: child.id, localAgent: child,
      result: Promise.resolve({ stopReason: 'end_turn', diagnostic: 'untrusted child text' }),
      async dispose() {} } } },
    tools: { get(_tool, agent) { assert.equal(agent, child)
      return { async execute() { return { status: 'COMPLETED', requestId: REQ, result: terminal.result } } }
    } },
  }
  let ready
  const notified = new Promise(resolve => { ready = resolve })
  parent.followup = () => ready()
  const jobs = createPostmanBridgeJobs(ctx, { run: (_signal, launch) => Promise.resolve().then(launch), dispose() {} }, grants)
  const bridge = createPostmanBridgeTool(ctx, jobs)
  const accepted = await bridge.execute({ message: '@Postman make package' }, { agent: parent, signal: SIGNAL })
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await notified // Grant registration is intentionally outside coordinator lifecycle.
  const handoff = await createPostmanBridgeStatusTool(ctx, jobs).execute({ bridge_job_id: accepted.bridgeJobId }, { agent: parent })
  assert.equal(handoff.childSessionId, child.id)
  assert.deepEqual(handoff.result, terminal.result)
  assert.equal((await grants.resolve('A', REQ)).resultZip, terminal.result.resultZip)
  await jobs.dispose()
  assert.equal(await grants.resolve(child.id, REQ), null)
})

test('Leader decision admits REQ to same Worker; stop keeps grant but rejects old Worker', async t => {
  const { terminal } = await artifactFixture(t)
  const grants = createImplementationArtifactGrants()
  await grants.register('A', terminal)
  const agents = new Map()
  const a = leader('A'), b = leader('B'); agents.set('A', a); agents.set('B', b)
  const starts = [], followups = []
  const ctx = { agents: { get: id => agents.get(id) },
    tools: { schemas: () => [{ name: 'postman_send_current_turn' }] },
    subagents: {
      async startContinuable(spec) { starts.push(spec); return { childId: 'worker-' + starts.length, messageId: 'first' } },
      async followup(...args) { followups.push(args); return 'second' },
      async drainContinuableChildren() {},
    } }
  const worker = createPostmanWorkerTools(ctx, grants)
  assert.equal((await worker.taskTool.execute({ task: 'x', artifactRequestId: REQ }, { agent: b, signal: SIGNAL })).status,
    'POSTMAN_WORKER_ARTIFACT_REJECTED')
  assert.equal(starts.length, 0)
  const old = await worker.taskTool.execute({ task: 'ordinary' }, { agent: a, signal: SIGNAL })
  assert.equal(old.workerSessionId, 'worker-1')
  const child = workerAgent(old.workerSessionId, 'A'); agents.set(child.id, child)
  assert.equal(worker.ownerOf(child, REQ), null)
  const accepted = await worker.taskTool.execute({ task: 'apply artifact', artifactRequestId: REQ }, { agent: a, signal: SIGNAL })
  assert.equal(accepted.created, false)
  assert.equal(accepted.workerSessionId, old.workerSessionId)
  assert.match(followups[0][2][0].text, /implementation_artifact_apply/)
  assert.equal(followups[0][2][0].text.includes(terminal.result.resultZip), false)
  assert.equal(worker.ownerOf(child, REQ), 'A')
  const repeated = await worker.taskTool.execute({ task: 'second clean worktree', artifactRequestId: REQ }, { agent: a, signal: SIGNAL })
  assert.equal(repeated.workerSessionId, accepted.workerSessionId)
  assert.equal(repeated.created, false)
  assert.equal(followups.length, 2)
  assert.equal(worker.ownerOf(workerAgent('worker-2', 'A'), REQ), null)
  const stale = workerAgent(child.id, 'A')
  assert.equal(worker.ownerOf(stale, REQ), 'A') // Identity also checks the registered Agent object in apply.
  const mocked = { ...ctx, agents: ctx.agents }
  let launches = 0
  const tool = createImplementationArtifactApplyTool(mocked, grants, worker, {
    verifiedRepository: async () => true,
    spawnProcess() {
      launches++
      const proc = new EventEmitter()
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter()
      queueMicrotask(() => { proc.stdout.emit('data', JSON.stringify({ ok: true, code: 'IMPLEMENTATION_PACKAGE_APPLIED' })); proc.emit('close', 0) })
      return proc
    },
  })
  assert.equal((await tool.execute({ requestId: REQ, worktree: 'C:/clean' }, { agent: workerAgent('worker-2', 'A') })).status,
    'IMPLEMENTATION_ARTIFACT_CALLER_REJECTED')
  assert.equal((await tool.execute({ requestId: 'REQ_20260925T112233Z_9876', worktree: 'C:/clean' }, { agent: child })).status,
    'IMPLEMENTATION_ARTIFACT_CALLER_REJECTED')
  const applied = await tool.execute({ requestId: REQ, worktree: 'C:/clean' }, { agent: child })
  assert.equal(applied.result.code, 'IMPLEMENTATION_PACKAGE_APPLIED')
  assert.equal(launches, 1)
  await writeFile(terminal.result.resultZip, 'tampered after admission')
  assert.equal((await tool.execute({ requestId: REQ, worktree: 'C:/clean' }, { agent: child })).status,
    'IMPLEMENTATION_ARTIFACT_GRANT_REJECTED')
  assert.equal(launches, 1)
  await writeFile(terminal.result.resultZip, 'test bytes')
  assert.equal((await worker.stopTool.execute({}, { agent: a })).status, 'POSTMAN_WORKER_STOPPED')
  assert.ok(await grants.resolve('A', REQ))
  assert.equal(worker.ownerOf(child, REQ), null)
  const next = await worker.taskTool.execute({ task: 'retry', artifactRequestId: REQ }, { agent: a, signal: SIGNAL })
  assert.equal(next.created, true)
  assert.equal(worker.ownerOf(child, REQ), null)
  const newChild = workerAgent(next.workerSessionId, 'A'); agents.set(newChild.id, newChild)
  assert.equal(worker.ownerOf(newChild, REQ), 'A')
  worker.dispose()
  assert.equal(worker.ownerOf(child, REQ), null)
})

test('repository boundary requires exact root with expected origin', async () => {
  const root = new URL('../../../', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  const repository = join(fileURLToPath(root), '.')
  assert.equal(await verifiedRepository(repository), true)
  assert.equal(await verifiedRepository(join(repository, 'system')), false)
  assert.equal(await verifiedRepository(tmpdir()), false)
})

test('runner invocation uses only trusted ZIP, argv-safe hidden launch and forwards PASS or FAIL', async t => {
  const { terminal } = await artifactFixture(t)
  const grants = createImplementationArtifactGrants()
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
