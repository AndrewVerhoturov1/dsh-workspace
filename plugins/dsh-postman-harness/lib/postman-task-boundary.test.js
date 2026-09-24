import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPostmanTaskContexts } from './postman-task-context.js'
import { createPostmanTaskPrepareTool, createPostmanBridgeTool } from './postman-bridge.js'
import { createDirectCurrentTurnToolConfigs, DirectPostmanJobManager } from './direct-current-turn.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createImplementationArtifactApplyTool, createImplementationArtifactGrants, IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'

const BASE = 'a'.repeat(40)
const BRANCH = 'task/postman-' + 'b'.repeat(32)
const REQ = 'REQ_20260927T120000Z_1234'
const leader = (id = 'leader') => ({ id, session: { header: { cwd: 'C:/repo', agentPreset: 'postman-leader', delegationDepth: 0 } } })
const signal = new AbortController().signal
const child = id => ({ id, session: { header: { cwd: 'C:/repo', origin: 'subagent', parentSession: 'leader', delegationDepth: 1 } } })
const event = (text, seq = 1) => ({ type: 'user/message', seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

function preparedContexts() {
  const calls = []
  const contexts = createPostmanTaskContexts({
    temporaryDirectory: () => 'C:/temporary',
    makeDirectory: async () => 'C:/temporary/dsh-postman-task-test',
    async gitCommand(cwd, ...args) {
      calls.push([cwd, ...args])
      const command = args.join(' ')
      if (command === 'rev-parse --show-toplevel') return cwd === 'C:/repo' ? 'C:/repo' : cwd
      if (command === 'remote get-url origin') return 'https://github.com/andrewverhoturov1/dsh-workspace.git'
      if (command === 'rev-parse --verify refs/remotes/origin/preview^{commit}' || command === 'rev-parse HEAD') return BASE
      if (command === 'worktree list --porcelain') return 'worktree C:/repo\nHEAD ' + BASE
      if (command === 'status --porcelain=v1 --untracked-files=all') return ''
      if (command.startsWith('ls-remote --heads origin ')) return calls.some(([, verb]) => verb === 'push')
        ? BASE + '\trefs/heads/' + args.at(-1) : ''
      if (['fetch --prune origin'].includes(command) || command.startsWith('worktree add -b ') || command.startsWith('push origin ')) return ''
      throw new Error('unexpected git command: ' + command)
    },
  })
  return { contexts, calls }
}

function directFixture(contexts) {
  const listeners = new Map(), invocations = [], processes = []
  const manager = new DirectPostmanJobManager({
    exists: () => true, pwsh: 'pwsh-test',
    now: () => new Date('2026-09-27T12:00:00Z'),
    randomInt: (() => { let n = 0; return () => ++n })(),
    spawn(command, args, options) {
      const process = new EventEmitter()
      process.stdout = new EventEmitter(); process.stderr = new EventEmitter()
      processes.push(process); invocations.push({ command, args, options })
      queueMicrotask(() => process.emit('spawn'))
      return process
    },
  })
  const config = createDirectCurrentTurnToolConfigs({ on(name, cb) { listeners.set(name, cb); return () => listeners.delete(name) } },
    { jobs: manager, taskContexts: contexts })
  return { config, manager, listeners, invocations, processes }
}

function argument(args, name) { return args[args.indexOf(name) + 1] }

test('prepare is Leader-only, binds exact repository and publishes branch from origin/preview', async () => {
  const { contexts, calls } = preparedContexts()
  const a = leader(), impersonator = { ...a }, ordinary = leader('ordinary')
  ordinary.session.header.agentPreset = 'standard'
  const ctx = { agents: { get: id => id === a.id ? a : ordinary } }
  const tool = createPostmanTaskPrepareTool(ctx, contexts)
  assert.equal((await tool.execute({}, { agent: ordinary })).status, 'POSTMAN_TASK_CALLER_REJECTED')
  assert.equal((await tool.execute({}, { agent: impersonator })).status, 'POSTMAN_TASK_CALLER_REJECTED')
  assert.equal(calls.length, 0)
  const prepared = await tool.execute({}, { agent: a })
  assert.equal(prepared.status, 'TASK_CONTEXT_READY')
  assert.match(prepared.branch, /^task\/postman-[0-9a-f]{32}$/)
  assert.equal(prepared.baseCommit, BASE)
  assert.equal(prepared.worktree, 'C:/temporary/dsh-postman-task-test')
  assert.deepEqual(contexts.get(a.id).branch, prepared.branch)
  assert.ok(calls.some(([, ...args]) => args.join(' ') === 'rev-parse --verify refs/remotes/origin/preview^{commit}'))
  assert.ok(calls.some(([, ...args]) => args.join(' ') === 'worktree add -b ' + prepared.branch + ' ' + prepared.worktree + ' ' + BASE))
  assert.ok(calls.some(([, ...args]) => args.join(' ') === 'push origin ' + BASE + ':refs/heads/' + prepared.branch))
  assert.equal((await tool.execute({}, { agent: a })).status, 'POSTMAN_TASK_CONTEXT_ALREADY_READY')
  contexts.dispose()
})

test('Bridge rejects missing prepared context before job admission', async () => {
  const a = leader(), { contexts } = preparedContexts()
  let admissions = 0
  const tool = createPostmanBridgeTool({ agents: { get: () => a } },
    { accept() { admissions++; return { status: 'POSTMAN_BRIDGE_ACCEPTED' } } }, contexts)
  assert.deepEqual(await tool.execute({ message: '@Postman deliver' }, { agent: a, signal }), { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' })
  assert.equal(admissions, 0)
  contexts.dispose()
})

test('Bridge child sends exact prepared branch via Direct -Branch, ignoring model main', async () => {
  const { contexts } = preparedContexts(), a = leader()
  const prepared = await contexts.prepare(a)
  assert.equal(prepared.status, 'TASK_CONTEXT_READY')
  const luna = child('bridge-child')
  assert.equal(contexts.bindChild(a.id, luna.id), true)
  const d = directFixture(contexts)
  const exact = '@PostmanAsk задача о main, но не менять ветку'
  d.listeners.get('session/event')({ id: luna.id }, event(exact))
  const result = await d.config.tools[0].execute({ branch: 'main', task: 'model-selected main' }, { agent: luna })
  assert.equal(result.status, 'STARTED')
  const args = d.invocations[0].args
  assert.equal(argument(args, '-Branch'), prepared.branch)
  assert.equal(Buffer.from(argument(args, '-TaskBase64'), 'base64').toString('utf8'), 'задача о main, но не менять ветку')
  assert.match(argument(args, '-File'), /postman-ask\.ps1$/)
  assert.equal(args.includes('main'), false)
  assert.equal(d.manager.latest(luna.id).branch, prepared.branch)
  d.processes[0].emit('close', 1)
  d.config.dispose(); contexts.dispose()
})

test('unbound Bridge child fails closed before spawning even with model branch', async () => {
  const { contexts } = preparedContexts(), d = directFixture(contexts), luna = child('unbound')
  d.listeners.get('session/event')({ id: luna.id }, event('@Postman action'))
  await assert.rejects(d.config.tools[0].execute({ branch: BRANCH }, { agent: luna }), /POSTMAN_TASK_CONTEXT_REQUIRED/)
  assert.equal(d.invocations.length, 0)
  d.config.dispose(); contexts.dispose()
})

test('automatic continuation preserves exact bound branch and prior REQ', async () => {
  const d = directFixture(createPostmanTaskContexts())
  const first = await d.manager.start({ sessionId: 'bridge', workspace: 'C:/repo', payload: 'первое', branch: BRANCH })
  d.processes[0].stdout.emit('data', JSON.stringify({ ok: true, code: 'ASSISTANT_COMPLETED_NO_ARTIFACT',
    state: 'ASSISTANT_COMPLETED_NO_ARTIFACT', requestId: first.requestId, assistantText: 'ещё не всё' }))
  d.processes[0].emit('close', 0)
  const second = await d.manager.continueLast('bridge', 'C:/repo')
  assert.equal(second.chatRequestId, first.requestId)
  assert.equal(argument(d.invocations[1].args, '-Branch'), BRANCH)
  assert.equal(argument(d.invocations[1].args, '-ChatRequestId'), first.requestId)
  assert.ok(d.invocations[1].args.includes('-AutomaticContinuation'))
  d.processes[1].emit('close', 1)
  d.config.dispose()
})

test('Worker receives exact context and REQ; apply rejects another worktree before runner', async t => {
  const { contexts } = preparedContexts(), a = leader()
  const prepared = await contexts.prepare(a)
  assert.equal(prepared.status, 'TASK_CONTEXT_READY')
  const zipdir = await mkdtemp(join(tmpdir(), 'task-boundary-'))
  t.after(() => rm(zipdir, { recursive: true, force: true }))
  const zip = join(zipdir, 'result.zip'), bytes = Buffer.from('fixture ZIP bytes')
  await writeFile(zip, bytes)
  const grants = createImplementationArtifactGrants()
  assert.equal(await grants.register(a.id, { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED',
    transportKind: 'artifact', requestId: REQ, result: { ok: true, code: 'RESULT_DURABLE',
      state: 'RESULT_DURABLE', requestId: REQ, repository: IMPLEMENTATION_REPOSITORY,
      expectedFilename: 'POSTMAN_' + REQ + '_RESULT.zip', resultZip: zip,
      sha256: createHash('sha256').update(bytes).digest('hex') } }), true)
  const agents = new Map([[a.id, a]]), starts = []
  const ctx = { agents: { get: id => agents.get(id) }, tools: { schemas: () => [{ name: 'postman_send_current_turn' }] },
    subagents: { async startContinuable(spec) { starts.push(spec); return { childId: 'worker-1', messageId: 'first' } } } }
  const worker = createPostmanWorkerTools(ctx, grants, contexts)
  const accepted = await worker.taskTool.execute({ task: 'Применить пакет', artifactRequestId: REQ }, { agent: a, signal })
  assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  const prompt = starts[0].request.prompt[0].text
  assert.ok(prompt.includes('Trusted Host artifact REQ: ' + REQ + '.'))
  assert.ok(prompt.includes('Leader task branch ' + prepared.branch + ' and worktree ' + prepared.worktree))
  assert.ok(prompt.includes('implementation_artifact_apply({requestId: ' + JSON.stringify(REQ) + ', worktree: ' + JSON.stringify(prepared.worktree) + '});'))
  assert.equal(prompt.includes(zip), false)
  const w = child('worker-1'); agents.set(w.id, w)
  assert.equal(worker.ownerOf(w, REQ), a.id)
  let verified = 0, spawned = 0
  const apply = createImplementationArtifactApplyTool(ctx, grants, worker, { taskContexts: contexts,
    verifiedRepository: async () => { verified++; return true },
    spawnProcess() { spawned++; throw new Error('runner should not start') } })
  assert.equal((await apply.execute({ requestId: REQ, worktree: 'C:/other-worktree' }, { agent: w })).status,
    'IMPLEMENTATION_ARTIFACT_WORKTREE_REJECTED')
  assert.equal((await apply.execute({ requestId: REQ, worktree: prepared.worktree }, { agent: w })).status,
    'IMPLEMENTATION_ARTIFACT_WORKTREE_REJECTED') // no verified publication HEAD yet
  assert.equal((await apply.execute({ requestId: 'REQ_20260927T120000Z_9999', worktree: prepared.worktree }, { agent: w })).status,
    'IMPLEMENTATION_ARTIFACT_CALLER_REJECTED')
  assert.equal(verified, 0)
  assert.equal(spawned, 0)
  worker.dispose(); contexts.dispose()
})
