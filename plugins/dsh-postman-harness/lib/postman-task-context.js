import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const REPOSITORY = 'andrewverhoturov1/dsh-workspace'
const repositoryIdentity = value => {
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(value ?? '')
  return match?.[1].toLowerCase() ?? null
}
const SHA = /^[0-9a-f]{40}$/
const BRANCH = /^task\/postman-[0-9a-f]{32}$/
const normalize = value => resolve(value).replaceAll('\\', '/').toLowerCase()
const fileExists = async path => { try { await stat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }

async function git(cwd, ...args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 120000 })
  return stdout.trim()
}

/** Shared process-local instance across both plugin entrypoints. Model prose is never authority. */
export function createPostmanTaskContexts({ gitCommand = git, temporaryDirectory = tmpdir, makeDirectory = mkdtemp, realPath = realpath } = {}) {
  const contexts = new Map()
  const children = new Map()
  const pending = new Set()
  const activeOperations = new Set()
  const syncQueues = new Map()
  const contextOperations = new Map()
  const runnerFailures = new Set()
  const failed = new Map()
  const command = gitCommand

  async function prepare(leader) {
    const id = leader?.id
    if (failed.has(id)) return { status: 'POSTMAN_TASK_PREPARE_UNCERTAIN', diagnostic: failed.get(id) }
    if (pending.has(id)) return { status: 'POSTMAN_TASK_PREPARE_IN_PROGRESS' }
    if (contexts.has(id)) return { status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY', ...contexts.get(id) }
    pending.add(id)
    let created = false
    try {
      const cwd = leader?.session?.header?.cwd
      if (typeof id !== 'string' || !id || typeof cwd !== 'string' || !cwd) throw new Error('POSTMAN_TASK_REPOSITORY_UNAVAILABLE')
      const repository = await command(cwd, 'rev-parse', '--show-toplevel')
      const remote = await command(repository, 'remote', 'get-url', 'origin')
      if (repositoryIdentity(remote) !== REPOSITORY) throw new Error('POSTMAN_TASK_REPOSITORY_REJECTED')
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
      created = true
      await command(repository, 'worktree', 'add', '-b', branch, worktree, baseCommit)
      if (normalize(await command(worktree, 'rev-parse', '--show-toplevel')) !== normalize(worktree) ||
          await command(worktree, 'rev-parse', 'HEAD') !== baseCommit ||
          await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '') {
        throw new Error('POSTMAN_TASK_WORKTREE_INVALID')
      }
      await command(repository, 'push', 'origin', baseCommit + ':refs/heads/' + branch)
      const remoteRef = await command(repository, 'ls-remote', '--heads', 'origin', branch)
      if (remoteRef !== baseCommit + '\trefs/heads/' + branch) throw new Error('POSTMAN_TASK_REMOTE_REF_INVALID')
      const context = Object.freeze({ leaderSessionId: id, repository: REPOSITORY, repositoryRoot: repository, branch, worktree, baseCommit })
      contexts.set(id, context)
      return { status: 'TASK_CONTEXT_READY', ...context }
    } catch (error) {
      const diagnostic = String(error?.message ?? error)
      if (created) failed.set(id, diagnostic) // Never lose possibly published branch/worktree on retry.
      return { status: created ? 'POSTMAN_TASK_PREPARE_UNCERTAIN' : 'POSTMAN_TASK_PREPARE_FAILED', diagnostic }
    } finally { pending.delete(id) }
  }

  // Only the existing process-local Leader binding may authorize destructive recovery.
  async function restore(leader, { isBusy = () => false, beforeRestore = async () => true } = {}) {
    const id = leader?.id
    const context = get(id)
    if (!context || context.leaderSessionId !== id || !runnerFailures.has(id))
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED' }
    if (!pending.has(id) && !reserveRestore(id)) return { status: 'POSTMAN_TASK_RESTORE_REJECTED' }
    try {
      if (activeOperations.has(id) || isBusy(id) || !await beforeRestore(id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      const { branch, worktree, baseCommit } = context
      const repository = await command(leader.session.header.cwd, 'rev-parse', '--show-toplevel')
      const origin = await command(repository, 'remote', 'get-url', 'origin')
      const worktreeOrigin = await command(worktree, 'remote', 'get-url', 'origin')
      if (context.repository !== REPOSITORY || repositoryIdentity(origin) !== REPOSITORY ||
          repositoryIdentity(worktreeOrigin) !== REPOSITORY || !BRANCH.test(branch) || !SHA.test(baseCommit))
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
      // Explicitly discard only this Host-created temporary tree, including untracked patch files.
      await command(worktree, 'reset', '--hard', remote)
      await command(worktree, 'clean', '-fd')
      if (await command(worktree, 'rev-parse', 'HEAD') !== remote ||
          await command(worktree, 'branch', '--show-current') !== branch ||
          await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '' ||
          await command(repository, 'ls-remote', '--heads', 'origin', branch) !== remoteLine)
        throw new Error('restored task worktree could not be verified')
      runnerFailures.delete(id)
      return { status: 'TASK_CONTEXT_RESTORED', branch, worktree, head: remote }
    } catch (error) {
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: String(error?.message ?? error) }
    } finally { pending.delete(id) }
  }

  async function sync(leaderId, publicationCommit, expectedParent) {
    const context = get(leaderId)
    if (!context || !SHA.test(publicationCommit ?? '') || !SHA.test(expectedParent ?? '')) return false
    // FIFO promise queue is scoped to one task context, never the repository globally.
    const previous = syncQueues.get(leaderId) ?? Promise.resolve()
    let release
    const turn = new Promise(resolve => { release = resolve })
    const queued = previous.catch(() => undefined).then(() => turn)
    syncQueues.set(leaderId, queued)
    contextOperations.set(leaderId, (contextOperations.get(leaderId) ?? 0) + 1)
    await previous.catch(() => undefined)
    try {
      const { worktree, branch } = context
      const root = await command(worktree, 'rev-parse', '--show-toplevel')
      const origin = await command(context.repositoryRoot, 'remote', 'get-url', 'origin')
      const worktreeOrigin = await command(worktree, 'remote', 'get-url', 'origin')
      if (contextOperations.get(leaderId) === undefined || contexts.get(leaderId) !== context || context.repository !== REPOSITORY || !BRANCH.test(branch) ||
          normalize(root) !== normalize(worktree) || normalize(await realPath(worktree)) !== normalize(worktree) ||
          repositoryIdentity(origin) !== REPOSITORY || repositoryIdentity(worktreeOrigin) !== REPOSITORY ||
          await command(worktree, 'branch', '--show-current') !== branch ||
          await command(worktree, 'symbolic-ref', '--short', 'HEAD') !== branch ||
          await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '') return false

      const listing = await command(root, 'worktree', 'list', '--porcelain')
      const bindings = listing.split(/\n\s*\n/).filter(Boolean).filter(entry =>
        entry.split(/\r?\n/).some(line => line.startsWith('worktree ') && normalize(line.slice(9)) === normalize(worktree)))
      if (bindings.length !== 1 ||
          !bindings[0].split(/\r?\n/).includes('branch refs/heads/' + branch)) return false

      // Fetch itself provides the authoritative snapshot; an ls-remote move after it is harmless.
      let fetch = async () => {
        await command(worktree, 'fetch', 'origin', 'refs/heads/' + branch + ':refs/remotes/origin/' + branch)
        return command(worktree, 'rev-parse', 'refs/remotes/origin/' + branch)
      }
      let remoteTip = await fetch()
      if (!SHA.test(remoteTip)) return false
      const resolveCommit = async sha => await command(worktree, 'rev-parse', '--verify', sha + '^{commit}') === sha
      if (!await resolveCommit(publicationCommit) || !await resolveCommit(expectedParent) ||
          !await resolveCommit(context.baseCommit)) return false
      const parentLine = await command(worktree, 'rev-list', '--parents', '-n', '1', publicationCommit)
      if (parentLine !== publicationCommit + ' ' + expectedParent) return false
      let receiptAncestor = await command(worktree, 'merge-base', publicationCommit, remoteTip)
      let baseAncestor = await command(worktree, 'merge-base', context.baseCommit, remoteTip)
      if (receiptAncestor !== publicationCommit || baseAncestor !== context.baseCommit) {
        // The exact push may race this fetch; one retry lets an append-only publisher settle.
        remoteTip = await fetch()
        if (!SHA.test(remoteTip)) return false
        receiptAncestor = await command(worktree, 'merge-base', publicationCommit, remoteTip)
        baseAncestor = await command(worktree, 'merge-base', context.baseCommit, remoteTip)
        if (receiptAncestor !== publicationCommit || baseAncestor !== context.baseCommit) return false
      }
      const head = await command(worktree, 'rev-parse', 'HEAD')
      if (!SHA.test(head) || await command(worktree, 'merge-base', head, remoteTip) !== head) return false
      if (head !== remoteTip) await command(worktree, 'merge', '--ff-only', remoteTip)
      return await command(worktree, 'rev-parse', 'HEAD') === remoteTip &&
        await command(worktree, 'rev-parse', 'HEAD^{tree}') !== '' &&
        await command(worktree, 'branch', '--show-current') === branch &&
        await command(worktree, 'symbolic-ref', '--short', 'HEAD') === branch &&
        normalize(await command(worktree, 'rev-parse', '--show-toplevel')) === normalize(worktree) &&
        await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') === ''
    } catch { return false }
    finally {
      const count = contextOperations.get(leaderId) ?? 0
      if (count <= 1) contextOperations.delete(leaderId)
      else contextOperations.set(leaderId, count - 1)
      release()
      if (syncQueues.get(leaderId) === queued) syncQueues.delete(leaderId)
    }
  }

  function beginSync(leaderId) {
    if (!contexts.has(leaderId)) return false
    contextOperations.set(leaderId, (contextOperations.get(leaderId) ?? 0) + 1)
    return true
  }
  function endSync(leaderId) {
    const count = contextOperations.get(leaderId) ?? 0
    if (count <= 1) contextOperations.delete(leaderId)
    else contextOperations.set(leaderId, count - 1)
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

  function get(leaderId) { return contexts.get(leaderId) ?? null }
  function isRestoring(leaderId) { return pending.has(leaderId) }
  // Bridge admission blocks runner work, but terminal sync is a short Git lock, not a Web-job lock.
  function hasActiveOperation(leaderId) { return activeOperations.has(leaderId) }
  function hasSyncOperation(leaderId) { return contextOperations.has(leaderId) }
  function beginOperation(leaderId, isBusy = () => false) {
    if (!contexts.has(leaderId) || pending.has(leaderId) || activeOperations.has(leaderId) || contextOperations.has(leaderId) || isBusy(leaderId)) return false
    activeOperations.add(leaderId)
    return true
  }
  function endOperation(leaderId, outcome) {
    activeOperations.delete(leaderId)
    if (outcome?.status === 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT') {
      if (outcome.result?.ok === false) runnerFailures.add(leaderId)
      else runnerFailures.delete(leaderId)
    }
  }
  function reserveRestore(leaderId) {
    if (!contexts.has(leaderId) || pending.has(leaderId) || contextOperations.has(leaderId)) return false
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
  function dispose() { contexts.clear(); children.clear(); pending.clear(); activeOperations.clear(); syncQueues.clear(); contextOperations.clear(); runnerFailures.clear(); failed.clear() }
  return { prepare, restore, sync, beginSync, endSync, verifyWorktree, get, isRestoring, hasActiveOperation, hasSyncOperation, beginOperation, endOperation, reserveRestore, releaseRestore, bindChild, child, releaseChild, dispose }
}

export const postmanTaskContexts = createPostmanTaskContexts()
export const POSTMAN_TASK_BRANCH_PATTERN = BRANCH
