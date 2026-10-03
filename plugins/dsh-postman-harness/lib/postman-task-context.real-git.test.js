import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openPostmanTaskRegistry } from './postman-task-registry.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createPostmanTaskContexts } from './postman-task-context.js'

const exec = promisify(execFile)
const shaPattern = /^[0-9a-f]{40}$/
const call = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 10000 })).stdout.trim()
const makeLeader = (id, root) => ({ id, session: { header: { cwd: root } } })

test('production sync validates and fast-forwards a real temporary bare DAG', { timeout: 120000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'postman-production-sync-'))
  try {
    const root = join(temp, 'root'), bare = join(temp, 'origin.git')
    await exec('git', ['init', '--bare', bare], { windowsHide: true })
    await exec('git', ['init', '-b', 'preview', root], { windowsHide: true })
    await call(root, 'config', 'user.email', 'postman-test@example.invalid')
    await call(root, 'config', 'user.name', 'Postman test')
    const commit = async message => {
      await writeFile(join(root, 'history.txt'), message, 'utf8')
      await call(root, 'add', 'history.txt'); await call(root, 'commit', '-m', message)
      return call(root, 'rev-parse', 'HEAD')
    }
    const p0 = await commit('P0'), c1 = await commit('C1'), c2 = await commit('C2'), c3 = await commit('C3')
    await call(root, 'remote', 'add', 'origin', bare); await call(root, 'push', '-u', 'origin', 'preview')
    const gitCommand = async (cwd, ...args) => {
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') return 'https://github.com/andrewverhoturov1/dsh-workspace.git'
      try { return await call(cwd, ...args) }
      catch (error) {
        if (/^merge-base$/.test(args[0]) && error?.code === 1) return ''
        throw error
      }
    }
    const contexts = createPostmanTaskContexts({ gitCommand, temporaryDirectory: () => temp })
    const leader = makeLeader('real-sync-leader', root)
    const prepared = await contexts.prepare(leader)
    assert.equal(prepared.status, 'TASK_CONTEXT_READY', JSON.stringify(prepared))
    const { branch, worktree, baseCommit } = contexts.get(leader.id)
    assert.equal(baseCommit, c3)

    // Real sequential publication chain and an out-of-order older receipt.
    await writeFile(join(root, 'history.txt'), 'REQ 1', 'utf8'); await call(root, 'add', 'history.txt'); await call(root, 'commit', '-m', 'REQ 1')
    const req1 = await call(root, 'rev-parse', 'HEAD'), parent1 = c3
    await call(root, 'push', 'origin', 'HEAD:refs/heads/' + branch)
    await call(worktree, 'fetch', 'origin', 'refs/heads/' + branch + ':refs/remotes/origin/' + branch)
    await call(worktree, 'merge', '--ff-only', 'refs/remotes/origin/' + branch)
    await writeFile(join(root, 'history.txt'), 'REQ 2', 'utf8'); await call(root, 'add', 'history.txt'); await call(root, 'commit', '-m', 'REQ 2')
    const req2 = await call(root, 'rev-parse', 'HEAD'), parent2 = req1
    await call(root, 'push', 'origin', 'HEAD:refs/heads/' + branch)
    await contexts.changeRecord(leader.id, row => ({ ...row, workers: {
      workerA: { id: 'workerA', label: 'A', state: 'ready', delivery: 'none', artifactRequests: [] }
    } }))
    assert.equal(await contexts.sync(leader.id, req2, parent2), true,
      'binding alone cannot discard an already verified publication')
    assert.equal(contexts.record(leader.id).workers.workerA.id, 'workerA')
    assert.equal(await call(worktree, 'rev-parse', 'HEAD'), req2)
    assert.equal(await contexts.sync(leader.id, req1, parent1), true)
    assert.equal(await call(worktree, 'rev-parse', 'HEAD'), req2, 'older receipt may not rewind local HEAD')

    // Independent production-sync check of five sequential Direct-like receipts.
    // This verifies real Git publication and out-of-order synchronization, not Bridge scheduling.
    const receipts = [{ commit: req1, parent: parent1 }, { commit: req2, parent: parent2 }]
    const published = [c3, req1, req2]
    const publicationSnapshots = []
    for (let index = 3; index <= 5; index++) {
      const previous = published.at(-1)
      await writeFile(join(root, 'history.txt'), `REQ ${index}`, 'utf8')
      await call(root, 'add', 'history.txt')
      await call(root, 'commit', '-m', `REQ ${index}`)
      const commit = await call(root, 'rev-parse', 'HEAD')
      const parent = await call(root, 'rev-parse', 'HEAD^')
      assert.equal(parent, previous, `C${index} has exact previous parent`)
      const beforePublish = await call(bare, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`).catch(() => '')
      assert.equal(beforePublish, previous, `C${index} does not exist remotely before publication`)
      await call(root, 'push', 'origin', `HEAD:refs/heads/${branch}`)
      const remote = await call(bare, 'rev-parse', `refs/heads/${branch}`)
      assert.equal(remote, commit, `remote advances monotonically to C${index}`)
      assert.equal(await call(root, 'merge-base', previous, remote), previous)
      publicationSnapshots.push({ commit, previousRemote: beforePublish, remote })
      receipts.push({ commit, parent })
      published.push(commit)
    }
    const receiptOrder = [2, 3, 1, 0, 4]
    let synchronizedHead = await call(worktree, 'rev-parse', 'HEAD')
    const snapshots = []
    for (const receiptIndex of receiptOrder) {
      const { commit, parent } = receipts[receiptIndex]
      const remoteLineBefore = await call(worktree, 'ls-remote', 'origin', `refs/heads/${branch}`)
      const [remoteBefore, remoteBranch] = remoteLineBefore.split(/\s+/)
      assert.equal(remoteBranch, `refs/heads/${branch}`)
      assert.equal(remoteBefore, published[5], 'all five receipts are published before out-of-order synchronization')
      const headBefore = await call(worktree, 'rev-parse', 'HEAD')
      assert.equal(await contexts.sync(leader.id, commit, parent), true, `sync C${receiptIndex + 1}`)
      const headAfter = await call(worktree, 'rev-parse', 'HEAD')
      const remoteAfter = await call(worktree, 'rev-parse', `refs/remotes/origin/${branch}`)
      assert.equal(await call(worktree, 'merge-base', headBefore, headAfter), headBefore, 'local HEAD never rewinds')
      assert.equal(await call(worktree, 'merge-base', commit, remoteAfter), commit, 'receipt remains in remote ancestry')
      assert.equal(await call(worktree, 'merge-base', remoteAfter, headAfter), remoteAfter, 'local worktree contains fetched remote tip')
      assert.ok(shaPattern.test(remoteBefore))
      snapshots.push({ receipt: `C${receiptIndex + 1}`, before: headBefore, after: headAfter, remote: remoteAfter })
      synchronizedHead = headAfter
    }
    assert.deepEqual(publicationSnapshots.map(item => item.previousRemote), [req2, published[3], published[4]])
    assert.deepEqual(publicationSnapshots.map(item => item.remote), published.slice(3), 'each non-force push advances remote by one commit')
    assert.equal(synchronizedHead, published[5], 'out-of-order receipts leave the local worktree at C5')
    assert.deepEqual(snapshots.map(item => item.receipt), ['C3', 'C4', 'C2', 'C1', 'C5'])
    assert.deepEqual(snapshots.map(item => item.remote), [published[5], published[5], published[5], published[5], published[5]])
    // Adversarial simultaneous terminal arrival: FIFO queue must serialize all
    // Git reads/writes and retain the monotonic remote tip without lost updates.
    const concurrent = await Promise.all([4, 0, 3, 1, 2].map(i =>
      contexts.sync(leader.id, receipts[i].commit, receipts[i].parent)))
    assert.deepEqual(concurrent, Array(5).fill(true))
    assert.equal(await call(worktree, 'rev-parse', 'HEAD'), published[5])

    // Wrong parent and unrelated commits fail closed, without moving worktree HEAD.
    const beforeReject = await call(worktree, 'rev-parse', 'HEAD')
    assert.equal((await contexts.sync(leader.id, req2, p0)).diagnostic.code, 'PUBLICATION_COMMIT_INVALID')
    const unrelatedRoot = join(temp, 'unrelated')
    await exec('git', ['init', '-b', 'unrelated', unrelatedRoot], { windowsHide: true })
    await call(unrelatedRoot, 'config', 'user.email', 'postman-test@example.invalid')
    await call(unrelatedRoot, 'config', 'user.name', 'Postman test')
    await writeFile(join(unrelatedRoot, 'unrelated.txt'), 'unrelated', 'utf8')
    await call(unrelatedRoot, 'add', 'unrelated.txt'); await call(unrelatedRoot, 'commit', '-m', 'unrelated')
    const unrelated = await call(unrelatedRoot, 'rev-parse', 'HEAD')
    assert.equal((await contexts.sync(leader.id, unrelated, p0)).diagnostic.code, 'PUBLICATION_COMMIT_INVALID')
    assert.equal(await call(worktree, 'rev-parse', 'HEAD'), beforeReject)

    // Remote divergence is rejected; no merge/rebase/reset is attempted.
    await call(root, 'checkout', '--detach', req1)
    await writeFile(join(root, 'diverged.txt'), 'diverged', 'utf8'); await call(root, 'add', 'diverged.txt'); await call(root, 'commit', '-m', 'diverged')
    const divergence = await call(root, 'rev-parse', 'HEAD')
    await call(root, 'push', '--force', 'origin', 'HEAD:refs/heads/' + branch)
    assert.equal((await contexts.sync(leader.id, divergence, req1)).diagnostic.code, 'FAST_FORWARD_BLOCKED')
    assert.equal(await call(worktree, 'rev-parse', 'HEAD'), beforeReject)

    // A dirty bound worktree is refused before any mutation.
    await writeFile(join(worktree, 'private.txt'), 'keep')
    assert.equal((await contexts.sync(leader.id, divergence, req1)).diagnostic.code, 'WORKTREE_DIRTY')
    assert.equal(await call(worktree, 'rev-parse', 'HEAD'), beforeReject)
    assert.equal(await call(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '', true)
    assert.ok(shaPattern.test(c1) && shaPattern.test(c2) && shaPattern.test(c3) && shaPattern.test(req2))
    contexts.dispose()
  } finally { await rm(temp, { recursive: true, force: true }) }
})

// Real bare origin and JSON domain across independent plugin lifetimes. Only
// the network-facing Git commands are redirected to the local bare repository.
async function recoveryFixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'postman-recover-publication-'))
  const root = join(temp, 'root'), bare = join(temp, 'origin.git'), tree = join(temp, 'task')
  const backend = new JsonStorageBackend(join(temp, 'storage'))
  t.after(async () => { await backend.close(); await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  await exec('git', ['init', '--bare', bare])
  await exec('git', ['init', '-b', 'preview', root])
  await call(root, 'config', 'user.email', 'postman-test@example.invalid')
  await call(root, 'config', 'user.name', 'Postman test')
  await writeFile(join(root, 'history.txt'), 'A')
  await call(root, 'add', 'history.txt'); await call(root, 'commit', '-m', 'A')
  const base = await call(root, 'rev-parse', 'HEAD')
  const branch = 'task/postman-' + 'c'.repeat(32)
  const origin = 'https://github.com/AndrewVerhoturov1/dsh-workspace.git'
  await call(root, 'remote', 'add', 'origin', origin)
  await call(root, 'worktree', 'add', '-b', branch, tree, base)
  await call(root, 'push', bare, base + ':refs/heads/' + branch)
  const calls = []
  const gitCommand = async (cwd, ...args) => {
    calls.push(args)
    if (args[0] === 'ls-remote' && args[2] === 'origin')
      return call(cwd, 'ls-remote', args[1], bare, ...args.slice(3))
    if (args[0] === 'fetch' && args[1] === 'origin')
      return call(cwd, 'fetch', bare, ...args.slice(2))
    return call(cwd, ...args)
  }
  const open = () => openPostmanTaskRegistry(new DomainFacility({
    storage: { backend: { get: () => backend } }, emit() {},
  }, { backend: 'json', routes: {} }))
  const leader = makeLeader('recover-leader', root)
  const first = await open()
  await first.create(leader.id, { leaderSessionId: leader.id, repository: 'andrewverhoturov1/dsh-workspace',
    repositoryPath: root, originUrl: origin, baseCommit: base, branch, worktree: tree,
    stage: 'ready', diagnostic: null, workers: { W: { id: 'W', label: 'W', state: 'ready', delivery: 'none', artifactRequests: [] } },
    runner: { state: 'none', requestId: null }, bridge: null })
  const publish = async (requestId, parent = null) => {
    const old = parent ?? await call(bare, 'rev-parse', 'refs/heads/' + branch)
    await call(root, 'checkout', '--detach', old)
    await writeFile(join(root, requestId + '.md'), requestId)
    await call(root, 'add', requestId + '.md'); await call(root, 'commit', '-m', requestId)
    const commit = await call(root, 'rev-parse', 'HEAD')
    await call(root, 'push', bare, commit + ':refs/heads/' + branch)
    const terminal = { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED',
      transportKind: 'text', requestId, result: { ok: true, code: 'TEXT_RESULT_DURABLE',
        requestId, repository: 'AndrewVerhoturov1/dsh-workspace', assistantText: requestId,
        baseCommit: old, taskPublicationCommit: commit,
        taskUrl: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + commit + '/' + requestId + '.md' } }
    return { old, commit, terminal }
  }
  return { temp, root, bare, tree, branch, base, leader, first, open, gitCommand, calls, publish }
}

const hasDestructiveGit = calls => calls.some(args => ['reset', 'clean', 'merge', 'stash', 'push'].includes(args[0]))

test('recover accepts one proven delayed REQ, then cold retrySync retains result and Worker IDs', { timeout: 120000 }, async t => {
  const f = await recoveryFixture(t)
  const receipt = await f.publish('REQ_20260929T010101Z_0001')
  await f.first.change(f.leader.id, row => ({ ...row, bridgeOperations: {
    job: { state: 'received', terminal: receipt.terminal, synchronization: 'busy' } } }))
  await f.first.close()
  const registry = await f.open()
  const contexts = createPostmanTaskContexts({ registry, gitCommand: f.gitCommand })
  const before = await call(f.tree, 'rev-parse', 'HEAD')
  assert.equal((await contexts.recover(f.leader)).status, 'POSTMAN_TASK_CONTEXT_ALREADY_READY')
  assert.equal(await call(f.tree, 'rev-parse', 'HEAD'), before)
  assert.equal(contexts.get(f.leader.id).worktree, f.tree)
  assert.equal(contexts.record(f.leader.id).workers.W.id, 'W')
  assert.equal(hasDestructiveGit(f.calls), false)
  let sends = 0, grants = 0
  const jobs = createPostmanBridgeJobs({ agents: { get: () => f.leader }, subagents: { start() { sends++; throw Error('Direct replay') } } },
    { run() { sends++; throw Error('Direct replay') }, dispose() {} },
    { async register() { grants++; return true } }, contexts, { async pauseForOperation() { return true } })
  assert.equal((await jobs.status(f.leader, 'job')).result.requestId, receipt.terminal.requestId)
  assert.equal((await jobs.status(f.leader, 'job', true)).synchronization, 'synchronized')
  for (let i = 0; i < 2; i++) {
    const result = await jobs.status(f.leader, 'job')
    assert.equal(result.status, 'POSTMAN_BRIDGE_TERMINAL')
    assert.deepEqual(result.result, receipt.terminal.result)
    assert.ok(result.finishedAt)
  }
  assert.equal(await call(f.tree, 'rev-parse', 'HEAD'), receipt.commit)
  assert.equal(contexts.record(f.leader.id).bridgeOperations.job, undefined)
  assert.equal(contexts.record(f.leader.id).workers.W.id, 'W')
  assert.equal(contexts.get(f.leader.id).branch, f.branch)
  assert.deepEqual({ sends, grants }, { sends: 0, grants: 1 })
  await jobs.dispose(); await registry.close()
})

test('recover verifies every delayed REQ parent and rejects missing, contradictory or divergent history', { timeout: 120000 }, async t => {
  for (const scenario of ['two', 'missing', 'wrong-parent', 'diverged', 'foreign-branch', 'dirty']) {
    await t.test(scenario, async t => {
      const f = await recoveryFixture(t)
      const a = await f.publish('REQ_20260929T010101Z_0001')
      const b = await f.publish('REQ_20260929T010102Z_0002')
      const operations = { first: { state: 'received', synchronization: 'busy', terminal: a.terminal },
        second: { state: 'received', synchronization: 'busy', terminal: b.terminal } }
      if (scenario === 'missing') delete operations.first
      if (scenario === 'wrong-parent') operations.first.terminal.result.baseCommit = b.commit
      if (scenario === 'foreign-branch') operations.second.terminal.result.taskUrl = 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + b.commit + '/OTHER.md'
      if (scenario === 'diverged') {
        await call(f.root, 'checkout', '--detach', a.commit)
        await writeFile(join(f.root, 'foreign.txt'), 'other')
        await call(f.root, 'add', 'foreign.txt'); await call(f.root, 'commit', '-m', 'foreign')
        await call(f.root, 'push', '--force', f.bare, 'HEAD:refs/heads/' + f.branch)
      }
      await f.first.change(f.leader.id, row => ({ ...row, bridgeOperations: operations }))
      await f.first.close()
      const registry = await f.open()
      if (scenario === 'dirty') await writeFile(join(f.tree, 'private.txt'), 'keep me')
      const contexts = createPostmanTaskContexts({ registry, gitCommand: f.gitCommand })
      const before = await call(f.tree, 'rev-parse', 'HEAD')
      const result = await contexts.recover(f.leader)
      assert.equal(result.status, ['two', 'dirty'].includes(scenario)
        ? 'POSTMAN_TASK_CONTEXT_ALREADY_READY' : 'POSTMAN_TASK_PREPARE_UNCERTAIN', JSON.stringify(result))
      assert.equal(await call(f.tree, 'rev-parse', 'HEAD'), before)
      assert.equal(hasDestructiveGit(f.calls), false)
      if (scenario === 'dirty') assert.equal(await readFile(join(f.tree, 'private.txt'), 'utf8'), 'keep me')
      if (scenario === 'two') assert.equal(contexts.record(f.leader.id).workers.W.id, 'W')
      await registry.close()
    })
  }
})

