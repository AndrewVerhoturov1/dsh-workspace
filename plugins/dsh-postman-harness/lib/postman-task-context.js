import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, stat } from 'node:fs/promises'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const REPOSITORY = 'andrewverhoturov1/dsh-workspace'
const SHA = /^[0-9a-f]{40}$/
const BRANCH = /^task\/postman-[0-9a-f]{32}$/
const normalize = value => resolve(value).replaceAll('\\', '/').toLowerCase()
const fileExists = async path => { try { await stat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }

async function git(cwd, ...args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 120000 })
  return stdout.trim()
}

/** The host injects one durable registry; tests explicitly inject an in-memory one. */
export function createPostmanTaskContexts({ registry = createMemoryTaskRegistry(), gitCommand = git, temporaryDirectory = tmpdir, makeDirectory = mkdtemp, realPath = realpath } = {}) {
  const contexts = new Map()
  const children = new Map()
  const pending = new Set()
  const activeOperations = new Set()
  const command = gitCommand

  async function prepare(leader) {
    const id = leader?.id
    if (pending.has(id)) return { status: 'POSTMAN_TASK_PREPARE_IN_PROGRESS' }
    if (contexts.has(id) && registry.get(id)?.stage === 'ready') return { status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY', ...contexts.get(id) }
    if (registry.get(id)) return recover(leader)
    pending.add(id)
    let created = false
    try {
      const cwd = leader?.session?.header?.cwd
      if (typeof id !== 'string' || !id || typeof cwd !== 'string' || !cwd) throw new Error('POSTMAN_TASK_REPOSITORY_UNAVAILABLE')
      const repository = await command(cwd, 'rev-parse', '--show-toplevel')
      const remote = await command(repository, 'remote', 'get-url', 'origin')
      const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remote)
      if (match?.[1].toLowerCase() !== REPOSITORY) throw new Error('POSTMAN_TASK_REPOSITORY_REJECTED')
      await command(repository, 'fetch', '--prune', 'origin')
      const baseCommit = await command(repository, 'rev-parse', '--verify', 'refs/remotes/origin/preview^{commit}')
      if (!SHA.test(baseCommit)) throw new Error('POSTMAN_TASK_BASE_INVALID')
      const trees = await command(repository, 'worktree', 'list', '--porcelain')
      const existingTrees = trees.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
      if (!existingTrees.some(tree => normalize(tree) === normalize(repository))) throw new Error('POSTMAN_TASK_WORKTREES_UNAVAILABLE')
      const permanent = [repository, resolve(homedir(), '.dsh'), resolve(homedir(), '.dsh-preview')]
      const branch = 'task/postman-' + randomUUID().replaceAll('-', '')
      if (!BRANCH.test(branch)) throw new Error('POSTMAN_TASK_BRANCH_INVALID')
      const remoteExisting = await command(repository, 'ls-remote', '--heads', 'origin', branch)
      if (remoteExisting !== '') throw new Error('POSTMAN_TASK_REMOTE_BRANCH_EXISTS')
      const worktree = await makeDirectory(join(temporaryDirectory(), 'dsh-postman-task-'))
      if (permanent.some(path => normalize(path) === normalize(worktree)) || existingTrees.some(path => normalize(path) === normalize(worktree))) throw new Error('POSTMAN_TASK_PERMANENT_WORKTREE')
      const record = { leaderSessionId: id, repository: REPOSITORY, repositoryPath: repository, originUrl: remote,
        branch, worktree, baseCommit, stage: 'intent', diagnostic: null, worker: null,
        runner: { state: 'none', requestId: null }, bridge: null }
      await registry.create(id, record) // Durable intent precedes the first Git mutation.
      created = true
      await command(repository, 'worktree', 'add', '-b', branch, worktree, baseCommit)
      await registry.change(id, row => ({ ...row, stage: 'worktree' }))
      if (normalize(await command(worktree, 'rev-parse', '--show-toplevel')) !== normalize(worktree) ||
          await command(worktree, 'rev-parse', 'HEAD') !== baseCommit ||
          await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '') {
        throw new Error('POSTMAN_TASK_WORKTREE_INVALID')
      }
      await command(repository, 'push', 'origin', baseCommit + ':refs/heads/' + branch)
      const remoteRef = await command(repository, 'ls-remote', '--heads', 'origin', branch)
      if (remoteRef !== baseCommit + '\trefs/heads/' + branch) throw new Error('POSTMAN_TASK_REMOTE_REF_INVALID')
      const context = Object.freeze({ leaderSessionId: id, repository: REPOSITORY, branch, worktree, baseCommit })
      await registry.change(id, row => ({ ...row, stage: 'ready' }))
      contexts.set(id, context)
      return { status: 'TASK_CONTEXT_READY', ...context }
    } catch (error) {
      const diagnostic = String(error?.message ?? error)
      if (registry.get(id)) {
        try { await registry.change(id, row => ({ ...row, stage: 'uncertain', diagnostic })) } catch {}
      }
      return { status: registry.get(id) ? 'POSTMAN_TASK_PREPARE_UNCERTAIN' : 'POSTMAN_TASK_PREPARE_FAILED', diagnostic }
    } finally { pending.delete(id) }
  }

  // Recovery never invokes restore(), reset, clean, merge, or a new worktree add.
  async function recover(leader) {
    const id = leader?.id
    if (pending.has(id)) return { status: 'POSTMAN_TASK_PREPARE_IN_PROGRESS' }
    const row = registry.get(id)
    if (!row) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
    pending.add(id)
    try {
      const cwd = leader?.session?.header?.cwd
      if (typeof cwd !== 'string' || !cwd || row.leaderSessionId !== id ||
          row.repository !== REPOSITORY || !BRANCH.test(row.branch) || !SHA.test(row.baseCommit) ||
          !row.worktree || !row.repositoryPath || !row.originUrl) throw new Error('invalid durable binding')
      const repository = await command(cwd, 'rev-parse', '--show-toplevel')
      if (normalize(repository) !== normalize(row.repositoryPath) ||
          await command(repository, 'remote', 'get-url', 'origin') !== row.originUrl ||
          normalize(row.worktree) === normalize(repository) ||
          [resolve(homedir(), '.dsh'), resolve(homedir(), '.dsh-preview')]
            .some(path => normalize(path) === normalize(row.worktree))) throw new Error('repository or worktree identity mismatch')
      // A reserved empty directory with no registered Git tree is not authority
      // to create a new tree in recovery: it is merely an incomplete intent.
      const listing = await command(repository, 'worktree', 'list', '--porcelain')
      const entries = listing.split(/\n\s*\n/).filter(Boolean)
      const owned = entries.filter(entry => entry.split(/\r?\n/).some(line =>
        line.startsWith('worktree ') && normalize(line.slice(9)) === normalize(row.worktree)))
      const branchEntries = entries.filter(entry => entry.split(/\r?\n/).includes('branch refs/heads/' + row.branch))
      if (owned.length !== 1 || branchEntries.length !== 1 || owned[0] !== branchEntries[0] ||
          /(?:^|\n)(?:locked|prunable)(?: |\r?$)/m.test(owned[0]) ||
          normalize(await realPath(row.worktree)) !== normalize(row.worktree) ||
          normalize(await command(row.worktree, 'rev-parse', '--show-toplevel')) !== normalize(row.worktree) ||
          await command(row.worktree, 'branch', '--show-current') !== row.branch ||
          await command(row.worktree, 'remote', 'get-url', 'origin') !== row.originUrl)
        throw new Error('task worktree ownership uncertain')
      for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        const markerPath = await command(row.worktree, 'rev-parse', '--git-path', marker)
        if (await fileExists(resolve(row.worktree, markerPath))) throw new Error('git operation in progress')
      }
      const head = await command(row.worktree, 'rev-parse', 'HEAD')
      const remoteLine = await command(repository, 'ls-remote', '--heads', 'origin', row.branch)
      const remote = remoteLine.split('\t')[0]
      if (!SHA.test(head) || !SHA.test(remote) || remoteLine !== remote + '\trefs/heads/' + row.branch ||
          await command(row.worktree, 'merge-base', head, row.baseCommit) !== row.baseCommit ||
          await command(row.worktree, 'merge-base', remote, row.baseCommit) !== row.baseCommit ||
          await command(row.worktree, 'merge-base', remote, head) !== remote ||
          await command(repository, 'ls-remote', '--heads', 'origin', row.branch) !== remoteLine)
        throw new Error('task branch history uncertain')
      const context = Object.freeze({ leaderSessionId: id, repository: REPOSITORY,
        branch: row.branch, worktree: row.worktree, baseCommit: row.baseCommit })
      // Interrupted runner outcome is not a trusted FAIL, even if the tree is dirty.
      if (row.stage !== 'ready' || row.runner.state === 'running' || row.runner.state === 'restoring')
        await registry.change(id, old => ({ ...old, stage: 'ready', diagnostic: null,
          runner: ['running', 'restoring'].includes(old.runner.state)
            ? { ...old.runner, state: 'unknown' } : old.runner }))
      contexts.set(id, context)
      return { status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY', ...context }
    } catch (error) {
      const diagnostic = String(error?.message ?? error)
      try { await registry.change(id, old => ({ ...old, stage: 'uncertain', diagnostic })) } catch {}
      contexts.delete(id)
      return { status: 'POSTMAN_TASK_PREPARE_UNCERTAIN', diagnostic }
    } finally { pending.delete(id) }
  }

  // Explicit runner restore is a separate destructive path; never call from recover.
  async function restore(leader, { isBusy = () => false, beforeRestore = async () => true } = {}) {
    const id = leader?.id
    const context = get(id)
    if (!context || context.leaderSessionId !== id || registry.get(id)?.runner.state !== 'failed')
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED' }
    if (!pending.has(id) && !reserveRestore(id)) return { status: 'POSTMAN_TASK_RESTORE_REJECTED' }
    try {
      if (activeOperations.has(id) || isBusy(id) || !await beforeRestore(id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      const { branch, worktree, baseCommit } = context
      const repository = await command(leader.session.header.cwd, 'rev-parse', '--show-toplevel')
      const origin = await command(repository, 'remote', 'get-url', 'origin')
      const worktreeOrigin = await command(worktree, 'remote', 'get-url', 'origin')
      const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(origin)
      if (context.repository !== REPOSITORY || match?.[1].toLowerCase() !== REPOSITORY ||
          origin !== worktreeOrigin || !BRANCH.test(branch) || !SHA.test(baseCommit))
        throw new Error('repository identity mismatch')
      const permanent = [repository, resolve(homedir(), '.dsh'), resolve(homedir(), '.dsh-preview')]
      if (permanent.some(path => normalize(path) === normalize(worktree))) throw new Error('permanent worktree')
      // The temporary path was created by Host; reject a later symlink/junction swap.
      if (normalize(await realPath(worktree)) !== normalize(worktree)) throw new Error('task worktree path was redirected')
      const listing = await command(repository, 'worktree', 'list', '--porcelain')
      const entries = listing.split(/\n\s*\n/).filter(Boolean)
      const owned = entries.filter(entry => entry.split(/\r?\n/).some(line =>
        line.startsWith('worktree ') && normalize(line.slice(9)) === normalize(worktree)))
      if (owned.length !== 1 || /(?:^|\n)(?:locked|prunable)(?: |\r?$)/m.test(owned[0]) ||
          !owned[0].split(/\r?\n/).includes('branch refs/heads/' + branch) ||
          normalize(await command(worktree, 'rev-parse', '--show-toplevel')) !== normalize(worktree) ||
          await command(worktree, 'branch', '--show-current') !== branch)
        throw new Error('task worktree binding mismatch')
      for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        const markerPath = await command(worktree, 'rev-parse', '--git-path', marker)
        if (await fileExists(resolve(worktree, markerPath))) throw new Error('git operation in progress')
      }
      const head = await command(worktree, 'rev-parse', 'HEAD')
      if (!SHA.test(head) || await command(worktree, 'merge-base', head, baseCommit) !== baseCommit)
        throw new Error('task HEAD is not descended from base')
      const remoteLine = await command(repository, 'ls-remote', '--heads', 'origin', branch)
      const remote = remoteLine.split('\t')[0]
      if (!SHA.test(remote) || remoteLine !== remote + '\trefs/heads/' + branch)
        throw new Error('remote task branch missing')
      await command(worktree, 'fetch', 'origin', 'refs/heads/' + branch + ':refs/remotes/origin/' + branch)
      if (await command(worktree, 'rev-parse', 'refs/remotes/origin/' + branch) !== remote ||
          await command(worktree, 'merge-base', remote, baseCommit) !== baseCommit ||
          await command(worktree, 'merge-base', remote, head) !== head ||
          await command(repository, 'ls-remote', '--heads', 'origin', branch) !== remoteLine)
        throw new Error('remote task branch moved unexpectedly')
      // A crash during explicit restore must not allow an automatic second attempt.
      await registry.change(id, row => ({ ...row, runner: { ...row.runner, state: 'restoring' } }))
      // Explicitly discard only this Host-created temporary tree, including untracked patch files.
      await command(worktree, 'reset', '--hard', remote)
      await command(worktree, 'clean', '-fd')
      if (await command(worktree, 'rev-parse', 'HEAD') !== remote ||
          await command(worktree, 'branch', '--show-current') !== branch ||
          await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '' ||
          await command(repository, 'ls-remote', '--heads', 'origin', branch) !== remoteLine)
        throw new Error('restored task worktree could not be verified')
      await registry.change(id, row => ({ ...row, runner: { state: 'none', requestId: null } }))
      return { status: 'TASK_CONTEXT_RESTORED', branch, worktree, head: remote }
    } catch (error) {
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: String(error?.message ?? error) }
    } finally { pending.delete(id) }
  }

  async function sync(leaderId, publicationCommit, expectedParent) {
    const context = get(leaderId)
    if (!context || !SHA.test(publicationCommit ?? '') || !SHA.test(expectedParent ?? '')) return false
    try {
      const { worktree, branch } = context
      if (await command(worktree, 'branch', '--show-current') !== branch ||
          await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '') return false
      await command(worktree, 'fetch', 'origin', 'refs/heads/' + branch + ':refs/remotes/origin/' + branch)
      const remote = await command(worktree, 'rev-parse', 'refs/remotes/origin/' + branch)
      if (remote !== publicationCommit) return false
      const parent = await command(worktree, 'rev-parse', publicationCommit + '^')
      if (parent !== expectedParent) return false
      const head = await command(worktree, 'rev-parse', 'HEAD')
      if (head !== expectedParent) return false
      await command(worktree, 'merge', '--ff-only', publicationCommit)
      return await command(worktree, 'rev-parse', 'HEAD') === publicationCommit &&
        await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') === ''
    } catch { return false }
  }

  async function verifyWorktree(leaderId) {
    const context = get(leaderId)
    if (!context) return false
    try {
      return normalize(await command(context.worktree, 'rev-parse', '--show-toplevel')) === normalize(context.worktree) &&
        await command(context.worktree, 'branch', '--show-current') === context.branch &&
        await command(context.worktree, 'rev-parse', 'HEAD') ===
          await command(context.worktree, 'rev-parse', 'refs/remotes/origin/' + context.branch) &&
        await command(context.worktree, 'status', '--porcelain=v1', '--untracked-files=all') === ''
    } catch { return false }
  }

  function get(leaderId) { return registry.get(leaderId)?.stage === 'ready' ? contexts.get(leaderId) ?? null : null }
  function record(leaderId) { return registry.get(leaderId) }
  const changeRecord = (leaderId, fn) => registry.change(leaderId, fn)
  function isRestoring(leaderId) { return pending.has(leaderId) }
  function hasActiveOperation(leaderId) { return activeOperations.has(leaderId) }
  function beginOperation(leaderId, isBusy = () => false) {
    if (!get(leaderId) || pending.has(leaderId) || activeOperations.has(leaderId) ||
        ['running', 'unknown', 'restoring'].includes(registry.get(leaderId)?.runner.state) || isBusy(leaderId)) return false
    activeOperations.add(leaderId)
    return true
  }
  async function startRunner(leaderId, requestId) {
    if (!activeOperations.has(leaderId) || !get(leaderId) || typeof requestId !== 'string' || !requestId)
      throw new Error('POSTMAN_TASK_RUNNER_NOT_RESERVED')
    await registry.change(leaderId, row => {
      if (['running', 'unknown', 'restoring'].includes(row.runner.state)) throw new Error('POSTMAN_TASK_RUNNER_UNCERTAIN')
      return { ...row, runner: { state: 'running', requestId } }
    })
  }
  async function endOperation(leaderId, outcome) {
    try {
      if (registry.get(leaderId)?.runner.state === 'running') {
        const state = outcome?.status === 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT'
          ? outcome.result?.ok === false ? 'failed' : outcome.result?.ok === true ? 'none' : 'unknown'
          : 'unknown'
        await registry.change(leaderId, row => ({ ...row, runner: { ...row.runner, state } }))
      }
    } finally { activeOperations.delete(leaderId) }
  }
  function reserveRestore(leaderId) {
    if (!get(leaderId) || pending.has(leaderId)) return false
    pending.add(leaderId)
    return true
  }
  function releaseRestore(leaderId) { pending.delete(leaderId) }
  function bindChild(leaderId, childId) {
    const context = get(leaderId)
    if (!context || children.has(childId)) return false
    children.set(childId, context)
    return true
  }
  function child(childId) { return children.get(childId) ?? null }
  function releaseChild(childId) { children.delete(childId) }
  function dispose() { contexts.clear(); children.clear(); pending.clear(); activeOperations.clear() }
  return { prepare, recover, restore, sync, verifyWorktree, get, record, changeRecord, isRestoring, hasActiveOperation, beginOperation, startRunner, endOperation, reserveRestore, releaseRestore, bindChild, child, releaseChild, dispose }
}

// Both entrypoints use one facade. Initialization is awaited before Git/child actions;
// never substitute a volatile registry if the storage backend fails to open.
let sharedContexts = null
export function initializePostmanTaskContexts(registry) {
  if (!sharedContexts) sharedContexts = createPostmanTaskContexts({ registry })
  return sharedContexts
}
export function releasePostmanTaskContexts(contexts) {
  if (sharedContexts === contexts) {
    contexts.dispose()
    sharedContexts = null
  }
}
export const postmanTaskContexts = new Proxy({}, { get: (_target, key) => {
  if (!sharedContexts) throw new Error('POSTMAN_TASK_STORAGE_REQUIRED')
  return sharedContexts[key]
} })
export const POSTMAN_TASK_BRANCH_PATTERN = BRANCH
