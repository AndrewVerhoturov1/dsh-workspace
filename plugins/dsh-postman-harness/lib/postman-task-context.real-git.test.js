import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createPostmanTaskContexts } from './postman-task-context.js'

const exec = promisify(execFile)
const shaPattern = /^[0-9a-f]{40}$/
const call = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { windowsHide: true })).stdout.trim()
const makeLeader = (id, root) => ({ id, session: { header: { cwd: root } } })

test('production sync validates and fast-forwards a real temporary bare DAG', async t => {
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
    assert.equal(await contexts.sync(leader.id, req2, parent2), true)
    assert.equal(await call(worktree, 'rev-parse', 'HEAD'), req2)
    assert.equal(await contexts.sync(leader.id, req1, parent1), true)
    assert.equal(await call(worktree, 'rev-parse', 'HEAD'), req2, 'older receipt may not rewind local HEAD')

    // Wrong parent and unrelated commits fail closed, without moving worktree HEAD.
    const beforeReject = await call(worktree, 'rev-parse', 'HEAD')
    assert.equal(await contexts.sync(leader.id, req2, p0), false)
    const unrelatedRoot = join(temp, 'unrelated')
    await exec('git', ['init', '-b', 'unrelated', unrelatedRoot], { windowsHide: true })
    await call(unrelatedRoot, 'config', 'user.email', 'postman-test@example.invalid')
    await call(unrelatedRoot, 'config', 'user.name', 'Postman test')
    await writeFile(join(unrelatedRoot, 'unrelated.txt'), 'unrelated', 'utf8')
    await call(unrelatedRoot, 'add', 'unrelated.txt'); await call(unrelatedRoot, 'commit', '-m', 'unrelated')
    const unrelated = await call(unrelatedRoot, 'rev-parse', 'HEAD')
    assert.equal(await contexts.sync(leader.id, unrelated, p0), false)
    assert.equal(await call(worktree, 'rev-parse', 'HEAD'), beforeReject)

    // Remote divergence is rejected; no merge/rebase/reset is attempted.
    await call(root, 'checkout', '--detach', req1)
    await writeFile(join(root, 'diverged.txt'), 'diverged', 'utf8'); await call(root, 'add', 'diverged.txt'); await call(root, 'commit', '-m', 'diverged')
    const divergence = await call(root, 'rev-parse', 'HEAD')
    await call(root, 'push', '--force', 'origin', 'HEAD:refs/heads/' + branch)
    assert.equal(await contexts.sync(leader.id, divergence, req1), false)
    assert.equal(await call(worktree, 'rev-parse', 'HEAD'), beforeReject)

    // A dirty bound worktree is refused before any mutation.
    await writeFile(join(worktree, 'private.txt'), 'keep')
    assert.equal(await contexts.sync(leader.id, divergence, req1), false)
    assert.equal(await call(worktree, 'rev-parse', 'HEAD'), beforeReject)
    assert.equal(await call(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '', true)
    assert.ok(shaPattern.test(c1) && shaPattern.test(c2) && shaPattern.test(c3) && shaPattern.test(req2))
    contexts.dispose()
  } finally { await rm(temp, { recursive: true, force: true }) }
})
