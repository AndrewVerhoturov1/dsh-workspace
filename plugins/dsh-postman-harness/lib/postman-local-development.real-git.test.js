import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { Config } from './postman-bridge.js'
import { createPostmanTaskContexts } from './postman-task-context.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { createPostmanWorkerTools } from './postman-worker.js'
const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args])).stdout.trim()

test('localDevelopment requires an explicit boolean Host configuration', () => {
  assert.equal(Config.parse({}).localDevelopment, false)
  assert.equal(Config.parse({ localDevelopment: true }).localDevelopment, true)
  assert.throws(() => Config.parse({ localDevelopment: 'true' }))
})

test('idle release -> private backup -> real restore -> pending receipt sync, without new Worker or model', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-local-development-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const repository = join(root, 'repo'), bare = join(root, 'origin.git')
  await exec('git', ['init', '--bare', bare])
  await exec('git', ['init', '-b', 'preview', repository])
  await git(repository, 'config', 'user.email', 'test@example.invalid')
  await git(repository, 'config', 'user.name', 'Local development test')
  await git(repository, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repository, '.gitignore'), 'secret.local\n')
  await writeFile(join(repository, 'payload.txt'), 'original\n')
  await git(repository, 'add', '.gitignore', 'payload.txt'); await git(repository, 'commit', '-m', 'base')
  await git(repository, 'remote', 'add', 'origin', 'https://github.com/AndrewVerhoturov1/dsh-workspace.git')
  await git(repository, 'remote', 'set-url', '--push', 'origin', bare)
  await git(repository, 'push', 'origin', 'preview')
  const registry = createMemoryTaskRegistry()
  const contexts = createPostmanTaskContexts({ registry, localDevelopment: true, temporaryDirectory: () => root,
    gitCommand: async (cwd, ...args) => {
      if (args[0] === 'fetch') return args[1] === '--prune'
        ? git(cwd, 'fetch', bare, '+refs/heads/*:refs/remotes/origin/*') : git(cwd, 'fetch', bare, ...args.slice(2))
      if (args[0] === 'ls-remote') return git(cwd, 'ls-remote', args[1], bare, ...args.slice(3))
      return git(cwd, ...args)
    } })
  t.after(() => contexts.dispose())
  const leader = { id: 'local-leader', session: { header: { cwd: repository, agentPreset: 'postman-leader', delegationDepth: 0 }, events: [] } }
  const prepared = await contexts.prepare(leader)
  assert.equal(prepared.status, 'TASK_CONTEXT_READY', JSON.stringify(prepared))
  const { branch, worktree, baseCommit } = prepared
  const id = 'saved-worker', child = { id, status: 'idle', inbox: { hasPending: false }, session: {
    header: { id, origin: 'subagent', parentSession: leader.id, delegationDepth: 1 }, events: [] } }
  let resident = child, drains = 0
  const worker = createPostmanWorkerTools({ agents: { get: key => key === leader.id ? leader : key === id ? resident : null },
    subagents: {
      async listChildren() { return [{ id, kind: 'child', mode: 'continuable', activity: resident ? 'running' : 'inactive' }] },
      async listDescendants() { return [] },
      async closeContinuableChild(parent, key, verify) { assert.equal(parent, leader); assert.equal(key, id)
        if (!await verify()) return false; drains++; resident = null; return true },
    } }, null, contexts, { localDevelopment: true })
  t.after(() => worker.dispose())
  await registry.change(leader.id, row => ({ ...row, workers: { [id]: { id, label: 'saved', state: 'ready', delivery: 'none', artifactRequests: [] } },
    runner: { state: 'failed', requestId: 'failed-package' }, bridgeOperations: { receipt: { state: 'received', synchronization: 'pending' } } }))
  await writeFile(join(worktree, 'payload.txt'), 'staged user changes\n'); await git(worktree, 'add', 'payload.txt')
  const index = await readFile(await git(worktree, 'rev-parse', '--git-path', 'index'))
  await writeFile(join(worktree, 'payload.txt'), 'unstaged user changes\n')
  await writeFile(join(worktree, 'private.bin'), Buffer.from([0, 1, 2, 255]))
  await writeFile(join(worktree, 'secret.local'), 'fixture-secret-not-for-output')
  assert.equal(contexts.reserveRestore(leader.id), true)
  const restored = await contexts.restore(leader, { beforeRestore: key => worker.prepareRestore(key) })
  contexts.releaseRestore(leader.id)
  assert.equal(restored.status, 'TASK_CONTEXT_RESTORED', JSON.stringify(restored))
  assert.ok(restored.recoveryPath)
  t.after(() => rm(restored.recoveryPath, { recursive: true, force: true }))
  assert.equal(drains, 1); assert.equal(registry.get(leader.id).workers[id], undefined)
  assert.equal(await readFile(join(restored.recoveryPath, 'files', 'payload.txt'), 'utf8'), 'unstaged user changes\n')
  assert.deepEqual(await readFile(join(restored.recoveryPath, 'files', 'private.bin')), Buffer.from([0, 1, 2, 255]))
  assert.equal(await readFile(join(restored.recoveryPath, 'files', 'secret.local'), 'utf8'), 'fixture-secret-not-for-output')
  assert.deepEqual(await readFile(join(restored.recoveryPath, 'index')), index)
  assert.equal(await readFile(join(worktree, 'payload.txt'), 'utf8'), 'original\n')
  assert.equal(await git(worktree, 'status', '--porcelain=v1', '--untracked-files=all'), '')
  assert.equal(await git(repository, 'rev-parse', 'HEAD'), baseCommit)
  assert.equal(await git(repository, 'branch', '--show-current'), 'preview')
  assert.equal(registry.get(leader.id).bridgeOperations.receipt.synchronization, 'pending')
  assert.equal(await contexts.sync(leader.id, baseCommit, baseCommit), false, 'invalid receipt never becomes synchronized')
  await writeFile(join(repository, 'receipt.md'), 'new publication')
  await git(repository, 'add', 'receipt.md'); await git(repository, 'commit', '-m', 'receipt')
  const publication = await git(repository, 'rev-parse', 'HEAD')
  await git(repository, 'push', 'origin', 'HEAD:refs/heads/' + branch)
  assert.equal(await contexts.sync(leader.id, publication, baseCommit), true)
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), publication)
  assert.equal(await git(worktree, 'branch', '--show-current'), branch)
})
