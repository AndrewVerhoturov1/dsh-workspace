import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { createPostmanTaskContexts, POSTMAN_TASK_BRANCH_PATTERN } from './postman-task-context.js'

const base = 'a'.repeat(40)
const published = 'b'.repeat(40)
const other = 'c'.repeat(40)
const repository = resolve('C:/Users/Andrew/.dsh')
const worktree = resolve('C:/Users/Andrew/AppData/Local/Temp/dsh-postman-task-test')
const leader = id => ({ id, session: { header: { cwd: repository } } })

function fixture(options = {}) {
  const calls = []
  const state = {
    remoteUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
    base, remote: base, parent: base, head: base, clean: true,
    branch: null, trees: [repository, resolve(repository, '..', '.dsh-preview')],
    ...options,
  }
  const gitCommand = async (cwd, ...args) => {
    calls.push({ cwd, args })
    const [verb, ...rest] = args
    if (verb === 'rev-parse' && rest[0] === '--show-toplevel') return cwd === worktree ? worktree : repository
    if (verb === 'remote' && rest.join(' ') === 'get-url origin') return state.remoteUrl
    if (verb === 'fetch') return ''
    if (verb === 'rev-parse' && rest[0] === '--verify') return state.base
    if (verb === 'worktree' && rest[0] === 'list') return state.trees.map(path => 'worktree ' + path + '\nHEAD ' + base + '\n' + (path === worktree ? 'branch refs/heads/' + state.branch + '\n' : 'branch refs/heads/main\n')).join('\n')
    if (verb === 'worktree' && rest[0] === 'add') { state.branch = rest[2]; return '' }
    if (verb === 'rev-parse' && rest[0] === 'HEAD') return state.head
    if (verb === 'status') return state.clean ? '' : '?? private.txt'
    if (verb === 'rev-parse' && rest[0] === '--git-path') return resolve(repository, '.git', 'missing-' + rest[1])
    if (verb === 'merge-base') return rest[0] === base || rest[1] === base ? base : state.head
    if (verb === 'reset' && rest[0] === '--hard') { state.head = rest[1]; state.clean = true; return '' }
    if (verb === 'clean' && rest[0] === '-fd') { state.clean = true; return '' }
    if (verb === 'rev-parse' && rest[0] === '--show-toplevel' && cwd === repository) return repository
    if (verb === 'push') return ''
    if (verb === 'ls-remote') return state.branch === rest[2] ? state.remote + '\trefs/heads/' + rest[2] : ''
    if (verb === 'branch' && rest[0] === '--show-current') return state.branch
    if (verb === 'rev-parse' && rest[0]?.startsWith('refs/remotes/origin/')) return state.remote
    if (verb === 'rev-parse' && rest[0]?.endsWith('^')) return state.parent
    if (verb === 'merge' && rest[0] === '--ff-only') { state.head = rest[1]; return '' }
    throw new Error('Unexpected git command: ' + JSON.stringify({ cwd, args }))
  }
  const contexts = createPostmanTaskContexts({ gitCommand, realPath: options.realPath ?? (async path => path),
    temporaryDirectory: () => resolve('C:/Users/Andrew/AppData/Local/Temp'),
    makeDirectory: async () => options.directory ?? worktree })
  return { contexts, state, calls }
}
const invoked = (calls, ...args) => calls.some(call => JSON.stringify(call.args) === JSON.stringify(args))

test('prepare pins exact fetched origin/preview and publishes a safe branch', async () => {
  const { contexts, calls } = fixture()
  const result = await contexts.prepare(leader('leader-A'))
  assert.equal(result.status, 'TASK_CONTEXT_READY')
  assert.equal(result.repository, 'andrewverhoturov1/dsh-workspace')
  assert.equal(result.baseCommit, base)
  assert.equal(result.worktree, worktree)
  assert.match(result.branch, POSTMAN_TASK_BRANCH_PATTERN)
  assert.ok(invoked(calls, 'fetch', '--prune', 'origin'))
  assert.ok(invoked(calls, 'rev-parse', '--verify', 'refs/remotes/origin/preview^{commit}'))
  assert.ok(invoked(calls, 'worktree', 'add', '-b', result.branch, worktree, base))
  assert.ok(invoked(calls, 'push', 'origin', base + ':refs/heads/' + result.branch))
  assert.ok(invoked(calls, 'ls-remote', '--heads', 'origin', result.branch))
  assert.equal(contexts.get('leader-A').branch, result.branch)
  assert.equal(Object.isFrozen(contexts.get('leader-A')), true)
})

test('prepare is idempotent for its Leader but not shared with another Leader', async () => {
  const { contexts, calls } = fixture()
  const first = await contexts.prepare(leader('leader-A'))
  const count = calls.length
  assert.deepEqual(await contexts.prepare(leader('leader-A')), {
    status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY', ...contexts.get('leader-A'),
  })
  assert.equal(calls.length, count)
  assert.equal(contexts.get('leader-B'), null)
  const second = await contexts.prepare(leader('leader-B'))
  assert.equal(second.status, 'TASK_CONTEXT_READY')
  assert.notEqual(second.branch, first.branch)
  assert.notEqual(contexts.get('leader-B'), contexts.get('leader-A'))
  assert.equal(contexts.bindChild('unknown', 'child-B'), false)
  assert.equal(await contexts.sync('unknown', published, base), false)
  assert.equal(contexts.bindChild('leader-A', 'child-A'), true)
  assert.equal(contexts.bindChild('leader-B', 'child-A'), false)
  assert.equal(contexts.child('child-A')?.branch, first.branch)
  contexts.releaseChild('child-A')
  assert.equal(contexts.child('child-A'), null)
})

test('prepare rejects another origin identity before fetch or worktree mutation', async () => {
  for (const remoteUrl of ['https://github.com/another/dsh-workspace.git', 'https://example.com/andrewverhoturov1/dsh-workspace.git']) {
    const { contexts, calls } = fixture({ remoteUrl })
    assert.deepEqual(await contexts.prepare(leader('leader-A')), {
      status: 'POSTMAN_TASK_PREPARE_FAILED', diagnostic: 'POSTMAN_TASK_REPOSITORY_REJECTED',
    })
    assert.equal(calls.some(call => ['fetch', 'worktree', 'push'].includes(call.args[0])), false)
  }
})

test('prepare rejects malformed base and mismatched published remote ref', async () => {
  const invalid = fixture({ base: 'not-a-sha' })
  assert.equal((await invalid.contexts.prepare(leader('A'))).diagnostic, 'POSTMAN_TASK_BASE_INVALID')
  assert.equal(invalid.calls.some(call => call.args[0] === 'worktree'), false)
  const mismatch = fixture({ remote: other })
  assert.equal((await mismatch.contexts.prepare(leader('A'))).diagnostic, 'POSTMAN_TASK_REMOTE_REF_INVALID')
  assert.equal(mismatch.contexts.get('A'), null)
  assert.equal(mismatch.calls.some(call => call.args[0] === 'push'), true)
})

test('prepare refuses permanent worktrees and existing worktree paths', async () => {
  for (const forbidden of [repository, resolve(repository, '..', '.dsh-preview'), worktree]) {
    const { contexts, calls } = fixture({ directory: forbidden, trees: [repository, worktree] })
    assert.equal((await contexts.prepare(leader('A'))).diagnostic, 'POSTMAN_TASK_PERMANENT_WORKTREE')
    assert.equal(calls.some(call => call.args[0] === 'worktree' && call.args[1] === 'add'), false)
    assert.equal(calls.some(call => call.args[0] === 'push'), false)
  }
})

test('sync accepts only clean exact remote publication with expected parent', async () => {
  const { contexts, state, calls } = fixture()
  const prepared = await contexts.prepare(leader('A'))
  state.remote = published
  assert.equal(await contexts.sync('A', published, base), true)
  assert.ok(invoked(calls, 'fetch', 'origin', 'refs/heads/' + prepared.branch + ':refs/remotes/origin/' + prepared.branch))
  assert.ok(invoked(calls, 'merge', '--ff-only', published))
  assert.equal(state.head, published)
})

test('sync refuses dirty worktree, foreign branch, remote mismatch, parent mismatch, and stale HEAD', async () => {
  for (const mutation of [
    s => { s.clean = false }, s => { s.branch = 'preview' },
    s => { s.remote = other }, s => { s.parent = other }, s => { s.head = other },
  ]) {
    const { contexts, state, calls } = fixture()
    assert.equal((await contexts.prepare(leader('A'))).status, 'TASK_CONTEXT_READY')
    mutation(state)
    assert.equal(await contexts.sync('A', published, base), false)
    assert.equal(calls.some(call => call.args[0] === 'merge'), false)
  }
  const { contexts } = fixture()
  assert.equal((await contexts.prepare(leader('A'))).status, 'TASK_CONTEXT_READY')
  assert.equal(await contexts.sync('A', 'invalid', base), false)
  assert.equal(await contexts.sync('A', published, 'invalid'), false)
})

test('apply guard requires unchanged bound branch and exact published HEAD', async () => {
  const { contexts, state } = fixture()
  assert.equal((await contexts.prepare(leader('A'))).status, 'TASK_CONTEXT_READY')
  state.remote = published
  assert.equal(await contexts.sync('A', published, base), true)
  assert.equal(await contexts.verifyWorktree('A'), true)
  state.head = other
  assert.equal(await contexts.verifyWorktree('A'), false)
  state.head = published
  state.branch = 'task/foreign'
  assert.equal(await contexts.verifyWorktree('A'), false)
  state.branch = contexts.get('A').branch
  state.clean = false
  assert.equal(await contexts.verifyWorktree('A'), false)
})

test('restore discards dirty bound tree only after explicit Leader call', async () => {
  const f = fixture(), prepared = await f.contexts.prepare(leader('A'))
  f.state.head = published; f.state.remote = published; f.state.clean = false
  f.state.trees.push(worktree)
  assert.equal((await f.contexts.restore(leader('B'))).status, 'POSTMAN_TASK_RESTORE_REJECTED')
  assert.equal((await f.contexts.restore(leader('A'))).status, 'POSTMAN_TASK_RESTORE_REJECTED')
  assert.equal(f.state.clean, false)
  assert.equal(f.contexts.beginOperation('A'), true)
  f.contexts.endOperation('A', { status: 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT', result: { ok: false } })
  assert.equal((await f.contexts.restore(leader('A'))).status, 'TASK_CONTEXT_RESTORED')
  assert.equal(f.state.clean, true)
  assert.equal(f.state.head, published)
  assert.ok(invoked(f.calls, 'reset', '--hard', published))
  assert.ok(invoked(f.calls, 'clean', '-fd'))
  assert.equal(prepared.worktree, worktree)
})

test('restore rejects redirected task path before discarding data', async () => {
  const f = fixture({ realPath: async () => repository }); await f.contexts.prepare(leader('A'))
  f.state.trees.push(worktree); f.state.clean = false
  assert.equal(f.contexts.beginOperation('A'), true)
  f.contexts.endOperation('A', { status: 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT', result: { ok: false } })
  f.contexts.endOperation('A', { status: 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT', result: { ok: false } })
  const result = await f.contexts.restore(leader('A'))
  assert.equal(result.status, 'POSTMAN_TASK_RESTORE_REJECTED')
  assert.equal(f.state.clean, false)
  assert.equal(f.calls.some(call => ['reset', 'clean'].includes(call.args[0])), false)
})

test('restore rejects wrong branch, moved remote, permanent and foreign worktree', async () => {
  for (const mutate of [
    s => { s.branch = 'preview' },
    s => { s.remote = '' },
    s => { s.trees = [repository] },
    s => { s.remoteUrl = 'https://github.com/other/repo.git' },
  ]) {
    const f = fixture(); await f.contexts.prepare(leader('A'))
    f.state.trees.push(worktree); f.state.clean = false; mutate(f.state)
    assert.equal(f.contexts.beginOperation('A'), true)
    f.contexts.endOperation('A', { status: 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT', result: { ok: false } })
    const result = await f.contexts.restore(leader('A'))
    assert.equal(result.status, 'POSTMAN_TASK_RESTORE_REJECTED')
    assert.equal(f.state.clean, false)
    assert.equal(f.calls.some(call => call.args[0] === 'reset' || call.args[0] === 'clean'), false)
  }
})

test('prepare refuses dirty new worktree', async () => {
  const { contexts, calls } = fixture({ clean: false })
  assert.equal((await contexts.prepare(leader('A'))).diagnostic, 'POSTMAN_TASK_WORKTREE_INVALID')
  assert.equal(calls.some(call => call.args[0] === 'push'), false)
})
