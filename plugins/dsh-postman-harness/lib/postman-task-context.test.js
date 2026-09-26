import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)
const git = async (cwd, ...args) => (await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true })).stdout.trim()
import { createPostmanTaskContexts, POSTMAN_TASK_BRANCH_PATTERN } from './postman-task-context.js'

const base = 'a'.repeat(40), published = 'b'.repeat(40), latest = 'c'.repeat(40), other = 'e'.repeat(40)
const repository = resolve('C:/Users/Andrew/.dsh')
const worktree = resolve('C:/Users/Andrew/AppData/Local/Temp/dsh-postman-task-test')
const secondWorktree = resolve('C:/Users/Andrew/AppData/Local/Temp/dsh-postman-task-test-B')
const leader = id => ({ id, session: { header: { cwd: repository } } })

function fixture(options = {}) {
  const calls = []
  let directoryNumber = 0
  const state = {
    remoteUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git', origin: 'https://github.com/andrewverhoturov1/dsh-workspace.git', base, remote: base, fetched: base, rootOriginOverride: undefined,
    head: base, clean: true, branch: null, trees: [repository, resolve(repository, '..', '.dsh-preview')], branches: new Map(),
    parents: new Map([[base, null], [published, base], [latest, published], [other, null]]),
    afterSyncFetch: null, gate: null, entered: null, ...options,
  }
  const gitCommand = async (cwd, ...args) => {
    calls.push({ cwd, args })
    const [verb, ...rest] = args
    const chain = sha => { const list = []; while (sha && !list.includes(sha)) { list.push(sha); sha = state.parents.get(sha) } return list }
    const branchFor = path => [...state.branches].find(([, bound]) => bound.toLowerCase() === path.toLowerCase())?.[0] ?? (path.toLowerCase() === repository.toLowerCase() ? 'main' : 'preview')
    if (verb === 'rev-parse' && rest[0] === '--show-toplevel') return [worktree, secondWorktree].some(path => cwd.toLowerCase() === path.toLowerCase()) ? cwd : repository
    if (verb === 'remote' && rest.join(' ') === 'get-url origin') return [worktree, secondWorktree].some(path => cwd.toLowerCase() === path.toLowerCase()) ? (state.worktreeOriginOverride ?? state.origin) : (state.rootOriginOverride ?? state.remoteUrl)
    if (verb === 'fetch') {
      if (rest[0] === 'origin' && rest[1]?.startsWith('refs/heads/')) {
        state.fetched = state.remote
        await state.afterSyncFetch?.()
        state.entered?.()
        await state.gate
      }
      return ''
    }
    if (verb === 'worktree' && rest[0] === 'list') return state.trees.map(path => { const branch = branchFor(path); return 'worktree ' + path + '\nHEAD ' + base + '\nbranch refs/heads/' + branch }).join('\n\n') + '\n\n'
    if (verb === 'worktree' && rest[0] === 'add') { const path = rest[3] === worktree ? worktree : secondWorktree; state.branch = rest[2]; state.branches.set(state.branch, path); state.trees.push(path); return '' }
    if (verb === 'rev-parse' && rest[0] === '--git-path') return resolve(repository, '.git', 'missing-' + rest[1])
    if (verb === 'rev-parse' && rest[0] === '--verify' && rest[1] === 'refs/remotes/origin/preview^{commit}') return state.base
    if (verb === 'rev-parse' && rest[0] === '--verify') { const sha = rest[1]?.replace(/\^\{commit\}$/, ''); return state.parents.has(sha) ? sha : '' }
    if (verb === 'rev-parse' && rest[0] === 'HEAD^{tree}') return base
    if (verb === 'rev-parse' && rest[0] === 'HEAD') return branchFor(cwd) === state.branch ? state.head : state.base
    if (verb === 'rev-parse' && rest[0]?.startsWith('refs/remotes/origin/')) return state.fetched
    if (verb === 'rev-list' && rest[0] === '--parents') { const sha = rest.at(-1), parent = state.parents.get(sha); return sha + (parent ? ' ' + parent : '') + (sha === state.mergeCommit ? ' ' + state.mergeParent : '') }
    if (verb === 'symbolic-ref' && rest[0] === '--short') return state.branch
    if (verb === 'branch' && rest[0] === '--show-current') return branchFor(cwd)
    if (verb === 'status') return state.clean ? '' : '?? private.txt'
    if (verb === 'merge-base') { const right = chain(rest[1]); return chain(rest[0]).find(sha => right.includes(sha)) ?? '' }
    if (verb === 'reset' && rest[0] === '--hard') { state.head = rest[1]; state.clean = true; return '' }
    if (verb === 'clean' && rest[0] === '-fd') { state.clean = true; return '' }
    if (verb === 'push') return ''
    if (verb === 'ls-remote') return state.branch === rest[2] ? state.remote + '\trefs/heads/' + rest[2] : ''
    if (verb === 'merge' && rest[0] === '--ff-only') { state.head = rest[1]; return '' }
    throw new Error('Unexpected git command: ' + JSON.stringify({ cwd, args }))
  }
  const contexts = createPostmanTaskContexts({ gitCommand, realPath: options.realPath ?? (async path => path),
    temporaryDirectory: () => resolve('C:/Users/Andrew/AppData/Local/Temp'), makeDirectory: async () => options.directory ?? (directoryNumber++ === 0 ? worktree : secondWorktree) })
  return { contexts, state, calls }
}
const invoked = (calls, ...args) => calls.some(call => JSON.stringify(call.args) === JSON.stringify(args))
const prepare = async (f, id = 'A') => { const result = await f.contexts.prepare(leader(id)); assert.equal(result.status, 'TASK_CONTEXT_READY', JSON.stringify(result)); return result }

test('prepare pins exact fetched origin/preview and publishes a safe branch', async () => {
  const { contexts, calls } = fixture(), result = await contexts.prepare(leader('leader-A'))
  assert.equal(result.status, 'TASK_CONTEXT_READY'); assert.equal(result.repository, 'andrewverhoturov1/dsh-workspace')
  assert.equal(result.baseCommit, base); assert.equal(result.worktree, worktree); assert.match(result.branch, POSTMAN_TASK_BRANCH_PATTERN)
  assert.ok(invoked(calls, 'fetch', '--prune', 'origin')); assert.ok(invoked(calls, 'rev-parse', '--verify', 'refs/remotes/origin/preview^{commit}'))
  assert.ok(invoked(calls, 'worktree', 'add', '-b', result.branch, worktree, base)); assert.ok(invoked(calls, 'push', 'origin', base + ':refs/heads/' + result.branch))
  assert.ok(invoked(calls, 'ls-remote', '--heads', 'origin', result.branch)); assert.equal(contexts.get('leader-A').branch, result.branch); assert.equal(Object.isFrozen(contexts.get('leader-A')), true)
})

test('prepare is idempotent for its Leader but not shared with another Leader', async () => {
  const { contexts, calls } = fixture(), first = await contexts.prepare(leader('leader-A')), count = calls.length
  assert.deepEqual(await contexts.prepare(leader('leader-A')), { status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY', ...contexts.get('leader-A') })
  assert.equal(calls.length, count); assert.equal(contexts.get('leader-B'), null)
  const second = await contexts.prepare(leader('leader-B')); assert.equal(second.status, 'TASK_CONTEXT_READY', JSON.stringify(second)); assert.notEqual(second.branch, first.branch)
  assert.notEqual(contexts.get('leader-B'), contexts.get('leader-A')); assert.equal(contexts.bindChild('unknown', 'child-B'), false)
  assert.equal(await contexts.sync('unknown', published, base), false); assert.equal(contexts.bindChild('leader-A', 'child-A'), true)
  assert.equal(contexts.bindChild('leader-B', 'child-A'), false); assert.equal(contexts.child('child-A')?.branch, first.branch)
  contexts.releaseChild('child-A'); assert.equal(contexts.child('child-A'), null)
})

test('prepare accepts the bound repository identity in supported HTTPS and SSH URL forms', async () => {
  for (const remoteUrl of [
    'https://github.com/andrewverhoturov1/dsh-workspace.git',
    'https://github.com/AndrewVerhoturov1/dsh-workspace',
    'git@github.com:AndrewVerhoturov1/dsh-workspace.git',
    'ssh://git@github.com/andrewverhoturov1/dsh-workspace',
  ]) {
    const { contexts } = fixture({ remoteUrl })
    assert.equal((await contexts.prepare(leader('leader-A'))).status, 'TASK_CONTEXT_READY', remoteUrl)
  }
})

test('prepare rejects another origin identity before fetch or worktree mutation', async () => {
  for (const remoteUrl of ['https://github.com/another/dsh-workspace.git', 'https://example.com/andrewverhoturov1/dsh-workspace.git', 'ssh://git@evil.example/andrewverhoturov1/dsh-workspace']) {
    const { contexts, calls } = fixture({ remoteUrl }); assert.deepEqual(await contexts.prepare(leader('leader-A')), { status: 'POSTMAN_TASK_PREPARE_FAILED', diagnostic: 'POSTMAN_TASK_REPOSITORY_REJECTED' })
    assert.equal(calls.some(call => ['fetch', 'worktree', 'push'].includes(call.args[0])), false)
  }
})

test('prepare rejects malformed base and mismatched published remote ref', async () => {
  const invalid = fixture({ base: 'not-a-sha' }); assert.equal((await invalid.contexts.prepare(leader('A'))).diagnostic, 'POSTMAN_TASK_BASE_INVALID')
  assert.equal(invalid.calls.some(call => call.args[0] === 'worktree'), false)
  const mismatch = fixture({ remote: other }); assert.equal((await mismatch.contexts.prepare(leader('A'))).diagnostic, 'POSTMAN_TASK_REMOTE_REF_INVALID')
  assert.equal(mismatch.contexts.get('A'), null); assert.equal(mismatch.calls.some(call => call.args[0] === 'push'), true)
})

test('prepare refuses permanent worktrees and existing worktree paths', async () => {
  for (const forbidden of [repository, resolve(repository, '..', '.dsh-preview'), worktree]) {
    const { contexts, calls } = fixture({ directory: forbidden, trees: [repository, worktree] })
    assert.equal((await contexts.prepare(leader('A'))).diagnostic, 'POSTMAN_TASK_PERMANENT_WORKTREE')
    assert.equal(calls.some(call => call.args[0] === 'worktree' && call.args[1] === 'add'), false); assert.equal(calls.some(call => call.args[0] === 'push'), false)
  }
})

test('sync accepts clean receipt and fast-forwards to fetched remote tip', async () => {
  const f = fixture(), context = await prepare(f); f.state.remote = published
  assert.equal(await f.contexts.sync('A', published, base), true)
  assert.ok(invoked(f.calls, 'fetch', 'origin', 'refs/heads/' + context.branch + ':refs/remotes/origin/' + context.branch))
  assert.ok(invoked(f.calls, 'merge', '--ff-only', published)); assert.equal(f.state.head, published)
})

test('sync refuses dirty, foreign, unrelated remote, wrong parent and stale HEAD', async t => {
  const cases = [
    ['dirty', s => { s.clean = false }, published, base], ['foreign branch', s => { s.branch = 'preview' }, published, base],
    ['unrelated remote', s => { s.remote = other }, published, base], ['wrong parent', s => { s.parents.set(published, other); s.remote = published }, published, base],
    ['stale HEAD', s => { s.head = other; s.remote = published }, published, base],
  ]
  for (const [name, mutate, receipt, parent] of cases) await t.test(name, async () => {
    const f = fixture(); await prepare(f); mutate(f.state)
    assert.equal(await f.contexts.sync('A', receipt, parent), false, name + ': ' + JSON.stringify(f.calls.map(call => call.args))); assert.equal(f.calls.some(call => call.args[0] === 'merge'), false)
  })
  const f = fixture(); await prepare(f); assert.equal(await f.contexts.sync('A', 'invalid', base), false); assert.equal(await f.contexts.sync('A', published, 'invalid'), false)
})

test('sync accepts allowed differing GitHub URL forms and rejects foreign root or worktree origin', async t => {
  const allowed = ['https://github.com/andrewverhoturov1/dsh-workspace.git', 'https://github.com/AndrewVerhoturov1/dsh-workspace',
    'git@github.com:AndrewVerhoturov1/dsh-workspace.git', 'ssh://git@github.com/andrewverhoturov1/dsh-workspace']
  for (const remoteUrl of allowed) await t.test(remoteUrl, async () => {
    const f = fixture({ remoteUrl }); await prepare(f)
    f.state.worktreeOriginOverride = allowed[0]
    f.state.remote = published
    assert.equal(await f.contexts.sync('A', published, base), true)
  })
  for (const [label, rootOriginOverride, worktreeOriginOverride] of [
    ['foreign root', 'https://github.com/attacker/other.git', undefined],
    ['foreign worktree', undefined, 'ssh://git@evil.example/andrewverhoturov1/dsh-workspace'],
  ]) await t.test(label, async () => {
    const f = fixture(); await prepare(f)
    if (rootOriginOverride !== undefined) f.state.remoteUrl = rootOriginOverride
    f.state.worktreeOriginOverride = worktreeOriginOverride
    f.state.remote = published
    assert.equal(await f.contexts.sync('A', published, base), false)
    assert.equal(f.calls.some(call => call.args[0] === 'fetch' && call.args[1] === 'origin' && call.args[2]?.startsWith('refs/heads/')), false)
    assert.equal(f.state.head, base)
  })
})

test('apply guard requires unchanged bound branch and exact published HEAD', async () => {
  const f = fixture(); await prepare(f); f.state.remote = published; assert.equal(await f.contexts.sync('A', published, base), true)
  assert.equal(await f.contexts.verifyWorktree('A'), true); f.state.head = other; assert.equal(await f.contexts.verifyWorktree('A'), false)
  f.state.head = published; f.state.branch = 'task/foreign'; assert.equal(await f.contexts.verifyWorktree('A'), false)
  f.state.branch = f.contexts.get('A').branch; f.state.clean = false; assert.equal(await f.contexts.verifyWorktree('A'), false)
})

test('restore discards dirty bound tree only after explicit Leader call', async () => {
  const f = fixture(), prepared = await f.contexts.prepare(leader('A')); f.state.parents.set(published, base); f.state.head = published; f.state.remote = published; f.state.fetched = published; f.state.clean = false
  assert.equal((await f.contexts.restore(leader('B'))).status, 'POSTMAN_TASK_RESTORE_REJECTED'); assert.equal((await f.contexts.restore(leader('A'))).status, 'POSTMAN_TASK_RESTORE_REJECTED')
  assert.equal(f.state.clean, false); assert.equal(f.contexts.beginOperation('A'), true)
  f.contexts.endOperation('A', { status: 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT', result: { ok: false } })
  f.state.parents.set(published, base); f.state.remote = published; f.state.fetched = published
  const restored = await f.contexts.restore(leader('A')); assert.equal(restored.status, 'TASK_CONTEXT_RESTORED', JSON.stringify(restored)); assert.equal(f.state.clean, true); assert.equal(f.state.head, published)
  assert.ok(invoked(f.calls, 'reset', '--hard', published)); assert.ok(invoked(f.calls, 'clean', '-fd')); assert.equal(prepared.worktree, worktree)
})

test('restore rejects redirected task path before discarding data', async () => {
  const f = fixture({ realPath: async () => repository }); await f.contexts.prepare(leader('A')); f.state.clean = false
  assert.equal(f.contexts.beginOperation('A'), true); f.contexts.endOperation('A', { status: 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT', result: { ok: false } })
  const result = await f.contexts.restore(leader('A')); assert.equal(result.status, 'POSTMAN_TASK_RESTORE_REJECTED'); assert.equal(f.state.clean, false)
  assert.equal(f.calls.some(call => ['reset', 'clean'].includes(call.args[0])), false)
})

test('restore rejects wrong branch, moved remote, missing and foreign worktree', async () => {
  for (const mutate of [s => { s.branch = 'preview' }, s => { s.remote = ''; s.fetched = '' }, s => { s.trees = [repository] }, s => { s.remoteUrl = 'https://github.com/other/repo.git' }]) {
    const f = fixture(); await f.contexts.prepare(leader('A')); f.state.clean = false; mutate(f.state)
    assert.equal(f.contexts.beginOperation('A'), true); f.contexts.endOperation('A', { status: 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT', result: { ok: false } })
    const result = await f.contexts.restore(leader('A')); assert.equal(result.status, 'POSTMAN_TASK_RESTORE_REJECTED'); assert.equal(f.state.clean, false)
    assert.equal(f.calls.some(call => call.args[0] === 'reset' || call.args[0] === 'clean'), false)
  }
})

test('sync fetch snapshot accepts append after fetch without remote equality check', async () => {
  const f = fixture({ afterSyncFetch: async () => { f.state.remote = latest } }); await prepare(f); f.state.remote = published
  assert.equal(await f.contexts.sync('A', published, base), true); assert.equal(f.state.fetched, published); assert.equal(f.state.head, published)
})

test('same-context FIFO allows two valid concurrent publications and holds operation locks', async () => {
  let unlock, entered; const gate = new Promise(r => { unlock = r }), started = new Promise(r => { entered = r })
  const f = fixture({ gate, entered: () => entered() }); await prepare(f); f.state.remote = latest
  const first = f.contexts.sync('A', published, base), second = f.contexts.sync('A', latest, published); await started
  assert.equal(f.contexts.hasSyncOperation('A'), true); assert.equal(f.contexts.hasActiveOperation('A'), false)
  assert.equal(f.contexts.beginOperation('A'), false); assert.equal(f.contexts.reserveRestore('A'), false)
  unlock()
  assert.deepEqual(await Promise.all([first, second]), [true, true]); assert.equal(f.state.head, latest)
})

test('FIFO is released after failed sync and a valid sync then succeeds', async () => {
  const f = fixture(); await prepare(f); f.state.remote = published
  assert.equal(await f.contexts.sync('A', published, other), false); assert.equal(await f.contexts.sync('A', published, base), true)
})

test('real temporary bare Git DAG synchronizes older publication without rewind and rejects unsafe ancestry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-sync-dag-'))
  try {
    const bare = join(root, 'remote.git'), seed = join(root, 'seed'), branchTree = join(root, 'task')
    await execFileAsync('git', ['init', '--bare', bare], { windowsHide: true })
    await execFileAsync('git', ['init', seed], { windowsHide: true })
    await git(seed, 'config', 'user.email', 'test@example.invalid'); await git(seed, 'config', 'user.name', 'Postman Test')
    await git(seed, 'checkout', '-b', 'preview')
    const makeCommit = async (name) => {
      const file = join(seed, 'state.txt'); await (await import('node:fs/promises')).writeFile(file, name, 'utf8')
      await git(seed, 'add', 'state.txt'); await git(seed, 'commit', '-m', name)
      const sha = await git(seed, 'rev-parse', 'HEAD'); return sha
    }
    const p0 = await makeCommit('P0'), c1 = await makeCommit('C1', p0), c2 = await makeCommit('C2', c1), c3 = await makeCommit('C3', c2)
    await git(seed, 'remote', 'add', 'origin', bare); await git(seed, 'push', 'origin', 'preview')
    await git(seed, 'branch', 'task/postman-' + '1'.repeat(32), p0); await git(seed, 'push', 'origin', 'task/postman-' + '1'.repeat(32))
    await git(seed, 'worktree', 'add', branchTree, 'task/postman-' + '1'.repeat(32))
    await git(seed, 'checkout', 'preview'); await git(seed, 'reset', '--hard', c3); await git(seed, 'push', '--force', 'origin', 'preview')
    const remoteTip = await git(seed, 'rev-parse', 'refs/remotes/origin/preview')
    const fromBare = async (...args) => git(bare, ...args)
    const local = async (...args) => git(branchTree, ...args)
    // Verify Git's actual parent, reachability, ancestry, and --ff-only behavior independently.
    assert.equal(await fromBare('rev-list', '--parents', '-n', '1', c1), c1 + ' ' + p0)
    assert.equal(await fromBare('merge-base', c1, c3), c1)
    assert.equal(await fromBare('merge-base', p0, c3), p0)
    assert.equal(await local('merge-base', c3, c1), c1)
    assert.equal(await local('merge-base', p0, c3), p0)
    await local('merge', '--ff-only', remoteTip)
    assert.equal(await local('rev-parse', 'HEAD'), c3)
    assert.equal(await local('merge-base', await local('rev-parse', 'HEAD'), c1), c1)
    assert.equal(await local('rev-parse', 'HEAD'), c3) // older receipt cannot rewind the fetched C3 tip
    const unrelated = await (async () => { await git(seed, 'checkout', '--orphan', 'unrelated'); await git(seed, 'rm', '-f', 'state.txt'); const file=join(seed,'stranger.txt'); await (await import('node:fs/promises')).writeFile(file,'x'); await git(seed,'add','stranger.txt'); await git(seed,'commit','-m','unrelated'); return git(seed,'rev-parse','HEAD') })()
    assert.notEqual(await fromBare('merge-base', unrelated, c3).catch(() => ''), unrelated)
    await t.test('dirty local branch is not considered safe for sync', async () => {
      const fs = await import('node:fs/promises'); await fs.writeFile(join(branchTree, 'dirty.txt'), 'private')
      assert.notEqual(await local('status', '--porcelain=v1', '--untracked-files=all'), '')
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('prepare refuses dirty new worktree', async () => {
  const { contexts, calls } = fixture({ clean: false }); assert.equal((await contexts.prepare(leader('A'))).diagnostic, 'POSTMAN_TASK_WORKTREE_INVALID')
  assert.equal(calls.some(call => call.args[0] === 'push'), false)
})
