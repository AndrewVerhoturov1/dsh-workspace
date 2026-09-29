import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'
import { createPostmanTaskContexts } from './postman-task-context.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createMemoryTaskRegistry, openPostmanTaskRegistry } from './postman-task-registry.js'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'

const exec = promisify(execFile)
const REMOTE = 'https://github.com/AndrewVerhoturov1/dsh-workspace.git'
async function command(cwd, executable, ...args) {
  const { stdout } = await exec(executable, args, { cwd, windowsHide: true, timeout: 120000 })
  return stdout.trim()
}
const git = (cwd, ...args) => command(cwd, 'git', ...args)

// The identity-facing origin remains GitHub; only network operations use this
// test's local bare remote. No external branch or user worktree is touched.
async function packageZip(root, name, patch, tests) {
  const manifest = { schemaVersion: 1, package: name,
    repository: 'AndrewVerhoturov1/dsh-workspace', baseBranch: 'preview', prBase: 'preview',
    patch: 'changes.patch', tests }
  const manifestPath = join(root, name + '.json')
  const patchPath = join(root, name + '.patch')
  const zip = join(root, name + '.zip')
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
  await writeFile(patchPath, patch, 'utf8')
  await command(root, 'python', '-X', 'utf8', '-c',
    'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1], "w"); z.write(sys.argv[2], "manifest.json"); z.write(sys.argv[3], "changes.patch"); z.close()',
    zip, manifestPath, patchPath)
  return zip
}

async function applyRunner(root, zip, worktree) {
  try {
    return JSON.parse(await command(root, 'python', '-X', 'utf8',
      resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'system', 'implementation_package_runner.py'),
      'apply', zip, '--repo', worktree, '--diagnostics-dir', join(root, 'diagnostics')))
  } catch (error) {
    if (!error.stdout) throw error
    return JSON.parse(error.stdout)
  }
}

test('fresh runtime reopens JSON registry and preserves dirty real Git bytes and branch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-restart-git-'))
  const repository = join(root, 'repo'), bare = join(root, 'origin.git')
  await mkdir(repository)
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  await git(root, 'init', '--bare', bare)
  await git(repository, 'init', '-b', 'preview')
  await git(repository, 'config', 'user.email', 'test@example.com')
  await git(repository, 'config', 'user.name', 'Restart Test')
  await git(repository, 'remote', 'add', 'origin', REMOTE)
  await git(repository, 'remote', 'set-url', '--push', 'origin', bare)
  await writeFile(join(repository, 'payload.txt'), 'original\n')
  await git(repository, 'add', 'payload.txt')
  await git(repository, 'commit', '-m', 'base')
  await git(repository, 'push', 'origin', 'preview')
  const storage = new JsonStorageBackend(join(root, 'storage'))
  const domainCtx = { storage: { backend: { get: () => storage } }, emit() {} }
  const facility = () => new DomainFacility(domainCtx, { backend: 'json' })
  const gitCommand = async (cwd, ...args) => {
    if (args[0] === 'fetch' && args[1] === '--prune')
      return git(cwd, 'fetch', '--prune', bare, '+refs/heads/*:refs/remotes/origin/*')
    if (args[0] === 'fetch' && args[1] === 'origin') return git(cwd, 'fetch', bare, ...args.slice(2))
    if (args[0] === 'ls-remote' && args[2] === 'origin')
      return git(cwd, 'ls-remote', args[1], bare, ...args.slice(3))
    return git(cwd, ...args)
  }
  const leader = { id: 'disk-git-leader', session: { header: { cwd: repository, agentPreset: 'postman-leader', delegationDepth: 0 } } }
  const children = new Set(), launches = [], followups = []
  const subagents = {
    async listChildren() { return [...children].map(id => ({ id, kind: 'child', mode: 'continuable' })) },
    async startContinuable(spec) { launches.push(spec.childId); children.add(spec.childId)
      return { childId: spec.childId, messageId: 'initial' } },
    async followup(_leader, id) { followups.push(id); return 'followup' },
  }
  const workerCtx = { agents: { get: id => id === leader.id ? leader : undefined },
    tools: { schemas: () => [{ name: 'postman_bridge' }] }, subagents }
  const task = worker => worker.taskTool.execute({ task: 'continue bound work' },
    { agent: leader, signal: new AbortController().signal })
  const firstRegistry = await openPostmanTaskRegistry(facility())
  const a = createPostmanTaskContexts({ registry: firstRegistry, temporaryDirectory: () => root, gitCommand })
  const first = await a.prepare(leader)
  assert.equal(first.status, 'TASK_CONTEXT_READY', JSON.stringify(first))
  const branch = first.branch, worktree = first.worktree
  const workerA = createPostmanWorkerTools(workerCtx, undefined, a)
  const acceptedA = await task(workerA)
  assert.equal(acceptedA.status, 'POSTMAN_WORKER_TASK_ACCEPTED', JSON.stringify(acceptedA))
  assert.equal(acceptedA.created, true)
  await writeFile(join(worktree, 'payload.txt'), 'private dirty bytes\n')
  const before = await git(worktree, 'status', '--porcelain=v1', '--untracked-files=all')
  workerA.dispose()
  a.dispose()
  await firstRegistry.close()
  const secondRegistry = await openPostmanTaskRegistry(facility())
  const b = createPostmanTaskContexts({ registry: secondRegistry, temporaryDirectory: () => root, gitCommand })
  const second = await b.prepare(leader)
  assert.equal(second.status, 'POSTMAN_TASK_CONTEXT_ALREADY_READY', JSON.stringify(second))
  assert.equal(second.branch, branch)
  assert.equal(second.worktree, worktree)
  const workerB = createPostmanWorkerTools(workerCtx, undefined, b)
  const acceptedB = await task(workerB)
  assert.equal(acceptedB.status, 'POSTMAN_WORKER_TASK_ACCEPTED', JSON.stringify(acceptedB))
  assert.equal(acceptedB.created, false)
  assert.equal(acceptedB.workerSessionId, acceptedA.workerSessionId)
  assert.deepEqual(launches, [acceptedA.workerSessionId])
  assert.deepEqual(followups, [acceptedA.workerSessionId])
  assert.equal(await readFile(join(worktree, 'payload.txt'), 'utf8'), 'private dirty bytes\n')
  assert.equal(await git(worktree, 'status', '--porcelain=v1', '--untracked-files=all'), before)
  assert.equal((await b.restore(leader)).status, 'POSTMAN_TASK_RESTORE_REJECTED')
  workerB.dispose()
  b.dispose()
  await secondRegistry.close()
  await storage.close()
})

test('real runner FAIL leaves dirty patch; explicit bound restore permits ZIP #2 on same branch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-restore-integration-'))
  const repository = join(root, 'repo'), bare = join(root, 'origin.git')
  await mkdir(repository)
  t.after(async () => rm(root, { recursive: true, force: true }))
  await git(root, 'init', '--bare', bare)
  await git(repository, 'init', '-b', 'preview')
  await git(repository, 'config', 'user.email', 'test@example.com')
  await git(repository, 'config', 'user.name', 'Postman Restore Test')
  await git(repository, 'config', 'core.autocrlf', 'false')
  await git(repository, 'remote', 'add', 'origin', REMOTE)
  await git(repository, 'remote', 'set-url', '--push', 'origin', bare)
  await writeFile(join(repository, 'payload.txt'), 'original\n')
  await git(repository, 'add', 'payload.txt')
  await git(repository, 'commit', '-m', 'fixture base')
  const base = await git(repository, 'rev-parse', 'HEAD')
  await git(repository, 'push', 'origin', 'preview')

  const registry = createMemoryTaskRegistry()
  const contexts = createPostmanTaskContexts({
    registry, temporaryDirectory: () => root,
    async gitCommand(cwd, ...args) {
      if (args[0] === 'fetch' && (args[1] === 'origin' || args[1] === '--prune')) {
        if (args[1] === '--prune') return git(cwd, 'fetch', '--prune', bare, '+refs/heads/*:refs/remotes/origin/*')
        return git(cwd, 'fetch', bare, ...args.slice(2))
      }
      if (args[0] === 'ls-remote' && args[2] === 'origin')
        return git(cwd, 'ls-remote', args[1], bare, ...args.slice(3))
      return git(cwd, ...args)
    },
  })
  const leader = { id: 'integration-leader', session: { header: { cwd: repository } } }
  t.after(() => contexts.dispose())
  const prepared = await contexts.prepare(leader)
  assert.equal(prepared.status, 'TASK_CONTEXT_READY', JSON.stringify(prepared))
  assert.equal(prepared.baseCommit, base)
  const { branch, worktree } = prepared
  assert.equal(await git(worktree, 'branch', '--show-current'), branch)

  // Produce the two ZIP patches using Git, from an isolated authoring tree.
  const authoring = join(root, 'authoring')
  await git(repository, 'worktree', 'add', '--detach', authoring, base)
  async function patchFor(value) {
    await writeFile(join(authoring, 'payload.txt'), value + '\n')
    await git(authoring, 'add', 'payload.txt')
    return (await git(authoring, 'diff', '--cached', '--binary', 'HEAD')) + '\n'
  }
  const firstPatch = await patchFor('first candidate')
  const secondPatch = await patchFor('second candidate')
  await writeFile(join(authoring, 'payload.txt'), 'original\n')
  await git(authoring, 'add', 'payload.txt')
  await git(repository, 'worktree', 'remove', authoring)
  const testCommand = expected => ({ name: 'targeted payload check',
    command: ['node', '-e', 'const fs=require("node:fs"); if(fs.readFileSync("payload.txt","utf8")!==process.argv[1]+"\\n") process.exit(1)', expected],
    timeoutSeconds: 30 })
  const first = await packageZip(root, 'zip-one', firstPatch, [testCommand('deliberately wrong')])
  const second = await packageZip(root, 'zip-two', secondPatch, [testCommand('second candidate')])

  const failure = await applyRunner(root, first, worktree)
  assert.equal(failure.ok, false, JSON.stringify(failure))
  assert.equal(failure.code, 'TARGETED_TEST_FAILED', JSON.stringify(failure))
  assert.ok((await stat(failure.diagnosticsZip)).isFile())
  assert.equal(await readFile(join(worktree, 'payload.txt'), 'utf8'), 'first candidate\n')
  assert.match(await git(worktree, 'status', '--porcelain=v1'), /^M payload\.txt$/)
  assert.equal(await git(worktree, 'branch', '--show-current'), branch)
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), base)

  const dirtyBefore = await git(worktree, 'status', '--porcelain=v1', '--untracked-files=all')
  const cold = createPostmanTaskContexts({ registry, temporaryDirectory: () => root,
    async gitCommand(cwd, ...args) {
      if (args[0] === 'ls-remote' && args[2] === 'origin')
        return git(cwd, 'ls-remote', args[1], bare, ...args.slice(3))
      if (args[0] === 'fetch' && args[1] === 'origin') return git(cwd, 'fetch', bare, ...args.slice(2))
      return git(cwd, ...args)
    },
  })
  const recovered = await cold.prepare(leader)
  assert.equal(recovered.status, 'POSTMAN_TASK_CONTEXT_ALREADY_READY', JSON.stringify(recovered))
  assert.equal(recovered.branch, branch)
  assert.equal(recovered.worktree, worktree)
  assert.equal(await readFile(join(worktree, 'payload.txt'), 'utf8'), 'first candidate\n')
  assert.equal(await git(worktree, 'status', '--porcelain=v1', '--untracked-files=all'), dirtyBefore)
  assert.equal((await cold.restore(leader)).status, 'POSTMAN_TASK_RESTORE_REJECTED')

  assert.equal(contexts.beginOperation('integration-leader'), true)
  await contexts.startRunner('integration-leader', 'REQ_20260927T120000Z_1234')
  await contexts.endOperation('integration-leader', { status: 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT', result: failure })
  const restored = await contexts.restore(leader) // Explicit, authorized discard on this verified temporary tree only.
  assert.equal(restored.status, 'TASK_CONTEXT_RESTORED', JSON.stringify(restored))
  assert.equal(restored.branch, branch)
  assert.equal(restored.head, base)
  assert.equal(await git(worktree, 'status', '--porcelain=v1', '--untracked-files=all'), '')
  assert.equal(await readFile(join(worktree, 'payload.txt'), 'utf8'), 'original\n')

  const success = await applyRunner(root, second, worktree)
  assert.equal(success.ok, true, JSON.stringify(success))
  assert.equal(success.code, 'IMPLEMENTATION_PACKAGE_APPLIED')
  assert.equal(await readFile(join(worktree, 'payload.txt'), 'utf8'), 'second candidate\n')
  assert.equal(await git(worktree, 'branch', '--show-current'), branch)
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), base)
  assert.equal(await git(repository, 'ls-remote', '--heads', bare, branch), base + '\trefs/heads/' + branch)

  await git(worktree, 'config', 'user.email', 'test@example.com')
  await git(worktree, 'config', 'user.name', 'Postman Worker')
  await writeFile(join(worktree, 'private.txt'), 'local changes\n')
  await git(worktree, 'add', 'private.txt')
  await git(worktree, 'commit', '-m', 'local unpublished work')
  await writeFile(join(worktree, 'payload.txt'), 'worker dirty bytes\n')
  const localHead = await git(worktree, 'rev-parse', 'HEAD')
  const localStatus = await git(worktree, 'status', '--porcelain=v1', '--untracked-files=all')
  const ahead = await cold.prepare(leader)
  assert.equal(ahead.status, 'POSTMAN_TASK_CONTEXT_ALREADY_READY', JSON.stringify(ahead))
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), localHead)
  assert.equal(await git(worktree, 'status', '--porcelain=v1', '--untracked-files=all'), localStatus)
  assert.equal(await readFile(join(worktree, 'payload.txt'), 'utf8'), 'worker dirty bytes\n')
  assert.equal(await git(repository, 'ls-remote', '--heads', bare, branch), base + '\trefs/heads/' + branch)
  cold.dispose()
})
