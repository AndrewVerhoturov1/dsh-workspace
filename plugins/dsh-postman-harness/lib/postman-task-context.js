import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, stat, writeFile, unlink } from 'node:fs/promises'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { observeDevspaceWriter,devspaceWriterHoldRoot,readDevspaceWriterHold,clearDevspaceWriterHold } from './postman-writer-proof.js'
import {loadDevspaceChannelForOwner,revokeDevspaceChannel} from './postman-devspace.js'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const REPOSITORY = 'andrewverhoturov1/dsh-workspace'
const SHA = /^[0-9a-f]{40}$/
const BRANCH = /^task\/postman-[0-9a-f]{32}$/
const normalize = value => resolve(value).replaceAll('\\', '/').toLowerCase()
const githubRepository = origin => {
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(origin)
  return match?.[1] ?? null
}
const boundContext = row => Object.freeze({
  leaderSessionId: row.leaderSessionId, repository: row.repository,
  branch: row.branch, worktree: row.worktree, baseCommit: row.baseCommit,
  ...(row.devspaceReadOnly ? { devspaceReadOnly: true } : {}),
  ...(row.universalProject ? { universalProject: true,
    repositoryPath: row.repositoryPath, originUrl: row.originUrl,
    ...(row.defaultBranch ? { defaultBranch: row.defaultBranch } : {}),
    ...(row.baseSource ? { baseSource: row.baseSource } : {}) } : {}),
})
const sameProject = (row, root, origin) =>
  normalize(row.repositoryPath) === normalize(root) && row.originUrl === origin &&
  githubRepository(origin)?.toLowerCase() === row.repository.toLowerCase()
async function defaultGitHubBranch(repository) {
  const { stdout } = await exec('gh', ['api', 'repos/' + repository, '--jq', '.default_branch'],
    { windowsHide: true, timeout: 30000 })
  return stdout.trim()
}
const fileExists = async path => { try { await stat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }

async function git(cwd, ...args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 120000 })
  return stdout.trim()
}

/** The host injects one durable registry; tests explicitly inject an in-memory one. */
export function createPostmanTaskContexts({ registry = createMemoryTaskRegistry(), gitCommand = git, temporaryDirectory = tmpdir, makeDirectory = mkdtemp, realPath = realpath, githubDefaultBranch = defaultGitHubBranch, writerControlFile } = {}) {
  const contexts = new Map()
  const children = new Map()
  const pending = new Set()
  const activeOperations = new Set()
  const syncOperations = new Map()
  const syncQueues = new Map()
  const workerAdmissions = new Map()
  const contextListeners = new Set()
  const changed = id => { for (const listener of contextListeners) listener(id) }
  const onContextChange = listener => { contextListeners.add(listener); return () => contextListeners.delete(listener) }
  const command = gitCommand

  async function repositoryFor(leader, projectPath) {
    const path = projectPath ?? leader?.session?.header?.cwd
    if (typeof path !== 'string' || !path || (projectPath !== undefined && !isAbsolute(path)))
      throw Error('POSTMAN_TASK_REPOSITORY_UNAVAILABLE')
    if (normalize(await realPath(path)) !== normalize(path))
      throw Error('POSTMAN_TASK_REPOSITORY_UNAVAILABLE')
    const repository = await command(path, 'rev-parse', '--show-toplevel')
    if (!isAbsolute(repository) || normalize(await realPath(repository)) !== normalize(repository) ||
        (projectPath !== undefined && normalize(repository) !== normalize(projectPath)))
      throw Error('POSTMAN_TASK_REPOSITORY_UNAVAILABLE')
    const originUrl = await command(repository, 'remote', 'get-url', 'origin')
    const name = githubRepository(originUrl)
    if (!name) throw Error('POSTMAN_TASK_REPOSITORY_REJECTED')
    const universalProject = name.toLowerCase() !== REPOSITORY
    if (universalProject && [resolve(homedir(), '.dsh'), resolve(homedir(), '.dsh-preview')]
        .some(permanent => normalize(repository) === normalize(permanent)))
      throw Error('POSTMAN_TASK_PERMANENT_WORKTREE')
    return { repository, originUrl, name: universalProject ? name : REPOSITORY, universalProject }
  }

  async function determineBase(info) {
    if (!info.universalProject) {
      await command(info.repository, 'fetch', '--prune', 'origin')
      return { defaultBranch: 'main',
        baseCommit: await command(info.repository, 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'),
        baseSource: 'remote' }
    }
    let remoteHead
    try { remoteHead = await command(info.repository, 'ls-remote', '--symref', 'origin', 'HEAD') }
    catch {
      // Offline is local-only and requires an already proven remote HEAD.
      let cached
      try { cached = await command(info.repository, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD') }
      catch { throw Error('POSTMAN_TASK_DEFAULT_BRANCH_UNPROVEN_OFFLINE') }
      if (!cached.startsWith('origin/')) throw Error('POSTMAN_TASK_DEFAULT_BRANCH_UNPROVEN_OFFLINE')
      const defaultBranch = cached.slice('origin/'.length)
      const baseCommit = await command(info.repository, 'rev-parse', '--verify',
        'refs/remotes/origin/' + defaultBranch + '^{commit}')
      if (!SHA.test(baseCommit)) throw Error('POSTMAN_TASK_BASE_INVALID')
      return { defaultBranch, baseCommit, baseSource: 'cached' }
    }
    let branch = /^ref: refs\/heads\/([^\t\r\n]+)\s+HEAD(?:\r?\n|$)/.exec(remoteHead)?.[1]
    if (!branch) {
      const heads = await command(info.repository, 'ls-remote', '--heads', 'origin')
      if (heads.trim()) throw Error('POSTMAN_TASK_DEFAULT_BRANCH_UNPROVEN')
      try { branch = await githubDefaultBranch(info.name) }
      catch { throw Error('POSTMAN_TASK_EMPTY_DEFAULT_BRANCH_UNPROVEN') }
      if (!branch || branch === 'null') throw Error('POSTMAN_TASK_EMPTY_DEFAULT_BRANCH_UNPROVEN')
      await command(info.repository, 'check-ref-format', '--branch', branch)
      return { defaultBranch: branch, baseCommit: '', baseSource: 'bootstrap' }
    }
    await command(info.repository, 'check-ref-format', '--branch', branch)
    const remoteSha = remoteHead.split(/\r?\n/).map(line => /^([0-9a-f]{40})\s+HEAD$/.exec(line)?.[1])
      .find(Boolean)
    if (!SHA.test(remoteSha ?? '')) throw Error('POSTMAN_TASK_BASE_INVALID')
    await command(info.repository, 'fetch', '--prune', 'origin')
    const baseCommit = await command(info.repository, 'rev-parse', '--verify',
      'refs/remotes/origin/' + branch + '^{commit}')
    if (baseCommit !== remoteSha) throw Error('POSTMAN_TASK_BASE_CHANGED')
    return { defaultBranch: branch, baseCommit, baseSource: 'remote' }
  }

  async function emptyBootstrap(repository, directory) {
    // Never use the user's staging area or working files to form the first tree.
    const marker = join(directory, '.postman-empty-tree')
    await writeFile(marker, '', { flag: 'wx' })
    let tree
    try { tree = await command(repository, 'hash-object', '-t', 'tree', '-w', marker) }
    finally { await unlink(marker) }
    return command(repository, '-c', 'user.name=Postman Bootstrap',
      '-c', 'user.email=postman-bootstrap@localhost', 'commit-tree', tree,
      '-m', 'Initial empty repository base')
  }

  // A read-only DevSpace investigation needs no task branch, remote push or
  // secondary worktree. Its authority is still one durable Leader context.
  async function prepareReadOnly(leader, projectPath) {
    const id = leader?.id
    if (pending.has(id)) return { status: 'POSTMAN_TASK_PREPARE_IN_PROGRESS' }
    const previous = get(id), saved = registry.get(id)
    if (saved && saved.stage !== 'closed') {
      if (projectPath !== undefined && (!isAbsolute(projectPath) ||
          normalize(saved.repositoryPath) !== normalize(projectPath)))
        return { status: 'POSTMAN_TASK_PROJECT_CHANGED' }
      if (previous && saved.stage === 'ready')
        return { status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY', ...previous }
      return recover(leader)
    }
    pending.add(id)
    try {
      if (typeof id !== 'string' || !id) throw Error('POSTMAN_TASK_REPOSITORY_UNAVAILABLE')
      const info = await repositoryFor(leader, projectPath)
      let branch = 'main', baseCommit, defaultBranch
      if (info.universalProject) {
        try { branch = await command(info.repository, 'symbolic-ref', '--quiet', '--short', 'HEAD') }
        catch { branch = 'unborn' }
        try { baseCommit = await command(info.repository, 'rev-parse', '--verify', 'HEAD^{commit}') }
        catch { baseCommit = '' }
        try {
          const remote = await command(info.repository, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
          if (remote.startsWith('origin/')) defaultBranch = remote.slice('origin/'.length)
        } catch { /* Branchless reading needs no network or default branch. */ }
      } else {
        baseCommit = await command(info.repository, 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}')
        if (!SHA.test(baseCommit)) throw Error('POSTMAN_TASK_BASE_INVALID')
      }
      const row = { leaderSessionId: id, repository: info.name, repositoryPath: info.repository,
        originUrl: info.originUrl, branch, worktree: info.repository, baseCommit,
        ...(info.universalProject ? { universalProject: true,
          ...(defaultBranch ? { defaultBranch } : {}) } : {}),
        ...(!info.universalProject && projectPath !== undefined ? { selectedDshProject: true } : {}),
        devspaceReadOnly: true, stage: 'ready', diagnostic: null, workers: {},
        runner: { state: 'none', requestId: null }, bridge: null }
      await registry.create(id, row)
      const context = boundContext(row)
      contexts.set(id, context); changed(id)
      return { status: 'POSTMAN_TASK_READ_ONLY_READY', ...context }
    } catch (error) {
      return { status: 'POSTMAN_TASK_PREPARE_FAILED', diagnostic: String(error?.message ?? error) }
    } finally { pending.delete(id) }
  }

  async function prepare(leader, projectPath) {
    const id = leader?.id
    if (pending.has(id)) return { status: 'POSTMAN_TASK_PREPARE_IN_PROGRESS' }
    const previous = get(id), saved = registry.get(id)
    if (saved && saved.stage !== 'closed' && projectPath !== undefined &&
        (!isAbsolute(projectPath) || normalize(saved.repositoryPath) !== normalize(projectPath)))
      return { status: 'POSTMAN_TASK_PROJECT_CHANGED' }
    if (previous && saved?.stage === 'ready' && !previous.devspaceReadOnly)
      return { status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY', ...previous }
    if (!previous && saved && saved.stage !== 'closed') return recover(leader)
    const upgrading = Boolean(previous?.devspaceReadOnly && saved?.stage === 'ready')
    if (upgrading && (activeOperations.has(id) || syncOperations.has(id) ||
        workerAdmissions.has(id) || saved.runner?.state !== 'none' || saved.bridge ||
        Object.values(saved.bridgeOperations ?? {}).some(op =>
          op.state !== 'received' || op.grantDiagnostic) ||
        Object.values(saved.workers ?? {}).some(child =>
          child.workerType !== 'secretary' || child.delivery !== 'none' || child.state !== 'ready') ||
        Object.values(saved.devspaceLanes ?? {}).some(lane =>
          lane.activeBridgeJobId || !['ready', 'closed'].includes(lane.state))))
      return { status: 'POSTMAN_TASK_PROMOTION_BUSY' }
    pending.add(id)
    let created = false
    try {
      if (typeof id !== 'string' || !id) throw Error('POSTMAN_TASK_REPOSITORY_UNAVAILABLE')
      const info = await repositoryFor(leader, projectPath ?? (upgrading ? saved.repositoryPath : undefined))
      if (upgrading && !sameProject(saved, info.repository, info.originUrl))
        throw Error('POSTMAN_TASK_PROJECT_CHANGED')
      const base = await determineBase(info)
      let baseCommit = base.baseCommit
      if (base.baseSource !== 'bootstrap' && !SHA.test(baseCommit))
        throw Error('POSTMAN_TASK_BASE_INVALID')
      const trees = await command(info.repository, 'worktree', 'list', '--porcelain')
      const existingTrees = trees.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
      if (!existingTrees.some(tree => normalize(tree) === normalize(info.repository)))
        throw Error('POSTMAN_TASK_WORKTREES_UNAVAILABLE')
      const permanent = [info.repository, resolve(homedir(), '.dsh'), resolve(homedir(), '.dsh-preview')]
      const branch = 'task/postman-' + randomUUID().replaceAll('-', '')
      if (!BRANCH.test(branch)) throw Error('POSTMAN_TASK_BRANCH_INVALID')
      if (!info.universalProject) {
        const remoteExisting = await command(info.repository, 'ls-remote', '--heads', 'origin', branch)
        if (remoteExisting !== '') throw Error('POSTMAN_TASK_REMOTE_BRANCH_EXISTS')
      }
      const worktree = await makeDirectory(join(temporaryDirectory(), 'dsh-postman-task-'))
      if (permanent.some(path => normalize(path) === normalize(worktree)) ||
          existingTrees.some(path => normalize(path) === normalize(worktree)) ||
          (info.universalProject && normalize(await realPath(worktree)) !== normalize(worktree)))
        throw Error('POSTMAN_TASK_PERMANENT_WORKTREE')
      const row = { leaderSessionId: id, repository: info.name, repositoryPath: info.repository,
        originUrl: info.originUrl, branch, worktree, baseCommit, stage: 'intent',
        diagnostic: null, workers: {}, runner: { state: 'none', requestId: null }, bridge: null,
        ...(info.universalProject ? { universalProject: true, defaultBranch: base.defaultBranch,
          baseSource: base.baseSource } : {}),
        ...(!info.universalProject && (projectPath !== undefined || (upgrading && saved.selectedDshProject))
          ? { selectedDshProject: true } : {}) }
      if (upgrading) {
        await registry.change(id, current => {
          if (current.stage !== 'ready' || current.devspaceReadOnly !== true ||
              current.leaderSessionId !== id || !sameProject(current, info.repository, info.originUrl) ||
              current.runner?.state !== 'none' || current.bridge ||
              Object.values(current.bridgeOperations ?? {}).some(op => op.state !== 'received'))
            throw Error('POSTMAN_TASK_PROMOTION_CHANGED')
          return { ...current, ...row, workers: current.workers, devspaceReadOnly: false,
            diagnostic: 'promoting branchless task' }
        })
      } else {
        await registry.create(id, row) // Durable intent before any task ref change.
      }
      created = true
      if (base.baseSource === 'bootstrap') {
        baseCommit = await emptyBootstrap(info.repository, worktree)
        if (!SHA.test(baseCommit)) throw Error('POSTMAN_TASK_BASE_INVALID')
        await registry.change(id, current => ({ ...current, baseCommit }))
      }
      await command(info.repository, 'worktree', 'add', '-b', branch, worktree, baseCommit)
      await registry.change(id, current => ({ ...current, stage: 'worktree' }))
      if (normalize(await command(worktree, 'rev-parse', '--show-toplevel')) !== normalize(worktree) ||
          await command(worktree, 'rev-parse', 'HEAD') !== baseCommit ||
          await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '')
        throw Error('POSTMAN_TASK_WORKTREE_INVALID')
      if (!info.universalProject) {
        await command(info.repository, 'push', 'origin', baseCommit + ':refs/heads/' + branch)
        const remoteRef = await command(info.repository, 'ls-remote', '--heads', 'origin', branch)
        if (remoteRef !== baseCommit + '	refs/heads/' + branch)
          throw Error('POSTMAN_TASK_REMOTE_REF_INVALID')
      }
      await registry.change(id, current => ({ ...current, stage: 'ready' }))
      const context = boundContext({ ...row, baseCommit, devspaceReadOnly: false })
      contexts.set(id, context); changed(id)
      return { status: 'TASK_CONTEXT_READY', ...context }
    } catch (error) {
      const diagnostic = String(error?.message ?? error)
      if (created) {
        try { await registry.change(id, row => ({ ...row, stage: 'uncertain', diagnostic })) } catch {}
        if (upgrading) { contexts.delete(id); changed(id) }
      }
      return { status: created ? 'POSTMAN_TASK_PREPARE_UNCERTAIN' : 'POSTMAN_TASK_PREPARE_FAILED', diagnostic }
    } finally { pending.delete(id) }
  }

  // Close retires authority, not files/branches and not a task-success certificate.
  // It deliberately needs no Git/worktree access after external merge/cleanup.
  async function close(leader, { isBusy = () => false, beforeClose = async () => true, abandon = false } = {}) {
    const id = leader?.id
    const reject = code => ({ status: 'POSTMAN_TASK_CLOSE_REJECTED', diagnostic: { code } })
    if (pending.has(id) || activeOperations.has(id) || syncOperations.has(id) || workerAdmissions.has(id))
      return reject('TASK_OPERATION_BUSY')
    const row = registry.get(id)
    if (!row || row.leaderSessionId !== id) return reject('TASK_CONTEXT_REQUIRED')
    if (row.stage === 'closed') return { status: 'POSTMAN_TASK_CLOSED', branch: row.branch, closedAt: row.closedAt,
      abandoned: row.abandoned === true, ...(row.workerRetirementProven !== undefined ? { workerRetirementProven: row.workerRetirementProven } : {}), taskCompleted: false }
    if (abandon) {
      // Addressed native cancellation needs the existing Worker admission path.
      // Reserve only after it returns, then archive whatever facts remain.
      let workerRetirementProven
      try { workerRetirementProven = await beforeClose(id) === true && Object.keys(registry.get(id)?.workers ?? {}).length === 0 }
      catch (error) { return reject(String(error?.message ?? error)) }
      if (pending.has(id) || activeOperations.has(id) || syncOperations.has(id) || workerAdmissions.has(id))
        return reject('TASK_OPERATION_BUSY')
      pending.add(id)
      try {
        const closedAt = new Date().toISOString()
        await registry.change(id, current => {
          if (current.leaderSessionId !== id || current.branch !== row.branch || current.worktree !== row.worktree)
            throw Error('TASK_CONTEXT_CHANGED')
          return { ...current, stage: 'closed', closedAt, abandoned: true, workerRetirementProven }
        })
        contexts.delete(id)
        for (const [childId, binding] of children) if (binding.context.leaderSessionId === id) children.delete(childId)
        changed(id)
        return { status: 'POSTMAN_TASK_CLOSED', branch: row.branch, worktree: row.worktree,
          closedAt, abandoned: true, workerRetirementProven, taskCompleted: false }
      } catch (error) { return reject(String(error?.message ?? error)) }
      finally { pending.delete(id) }
    }
    // This synchronous reservation is shared with prepare/Bridge/Worker/runner admission.
    pending.add(id)
    try {
      const stale = row.stage === 'uncertain' && row.diagnostic === 'task worktree missing'
      const blocker = current => current.stage !== 'ready' && !(stale && current.stage === 'uncertain' &&
          current.diagnostic === 'task worktree missing' && ['leaderSessionId', 'repository', 'repositoryPath', 'originUrl', 'branch', 'worktree', 'baseCommit']
            .every(key => current[key] === row[key])) ? 'TASK_STATE_UNCERTAIN'
        : Object.keys(current.workers ?? {}).length ? 'WORKER_BINDINGS_NOT_RETIRED'
        : current.runner?.state !== 'none' ? 'RUNNER_NOT_SETTLED'
        : current.bridge || Object.values(current.bridgeOperations ?? {}).some(op =>
          op.state !== 'received' || op.grantDiagnostic || !['synchronized', 'not-required'].includes(op.synchronization)) ? 'BRIDGE_NOT_SETTLED'
        : [...children.values()].some(binding => binding.context.leaderSessionId === id) ? 'CHILD_NOT_RELEASED'
        : isBusy(id) ? 'TASK_OPERATION_BUSY' : null
      const reason = blocker(row)
      if (reason) return reject(reason)
      if (!await beforeClose(id)) return reject('CHILD_CLOSURE_UNPROVEN')
      if (stale) {
        // Only the recovery diagnostic for a formerly ready, missing tree is
        // eligible. Re-prove identity/absence; no Git mutation or generic uncertain close.
        const cwd = leader?.session?.header?.cwd
        if (!cwd || (!row.universalProject && row.repository !== REPOSITORY) || !BRANCH.test(row.branch) || !SHA.test(row.baseCommit) ||
            !row.repositoryPath || !row.originUrl || !row.worktree) return reject('TASK_STATE_UNCERTAIN')
        const repository = row.universalProject ? row.repositoryPath :
          await command(cwd, 'rev-parse', '--show-toplevel')
        const originMatch = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(row.originUrl)
        if (normalize(repository) !== normalize(row.repositoryPath) ||
            originMatch?.[1].toLowerCase() !== row.repository.toLowerCase() ||
            await command(repository, 'remote', 'get-url', 'origin') !== row.originUrl ||
            [repository, resolve(homedir(), '.dsh'), resolve(homedir(), '.dsh-preview')]
              .some(path => normalize(path) === normalize(row.worktree)) || await fileExists(row.worktree))
          return reject('TASK_STATE_UNCERTAIN')
        const entries = (await command(repository, 'worktree', 'list', '--porcelain')).split(/\n\s*\n/).filter(Boolean)
        // A leftover/prunable registration can retain unproven Git mutations.
        // Completed cleanup must leave neither the old path nor its branch attached.
        if (entries.some(entry => entry.split(/\r?\n/).some(line =>
          line.startsWith('worktree ') && normalize(line.slice(9)) === normalize(row.worktree) ||
          line === 'branch refs/heads/' + row.branch))) return reject('TASK_STATE_UNCERTAIN')
        for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
          if (await fileExists(resolve(repository, await command(repository, 'rev-parse', '--git-path', marker))))
            return reject('TASK_OPERATION_BUSY')
        }
      }
      const closedAt = new Date().toISOString()
      await registry.change(id, current => {
        const reason = blocker(current)
        if (reason) throw new Error(reason)
        return { ...current, stage: 'closed', closedAt }
      })
      contexts.delete(id)
      changed(id)
      return { status: 'POSTMAN_TASK_CLOSED', branch: row.branch, closedAt, taskCompleted: false }
    } catch (error) { return reject(String(error?.message ?? error)) }
    finally { pending.delete(id) }
  }

  async function recoverUniversal(leader, row) {
    const id = leader?.id
    if (pending.has(id)) return { status: 'POSTMAN_TASK_PREPARE_IN_PROGRESS' }
    pending.add(id)
    try {
      const info = await repositoryFor(leader, row.repositoryPath)
      if (row.leaderSessionId !== id || !info.universalProject ||
          !sameProject(row, info.repository, info.originUrl))
        throw Error('POSTMAN_TASK_PROJECT_CHANGED')
      if (row.devspaceReadOnly) {
        if (row.stage !== 'ready' || normalize(row.worktree) !== normalize(info.repository))
          throw Error('POSTMAN_TASK_READ_ONLY_CONTEXT_UNKNOWN')
      } else {
        if (!BRANCH.test(row.branch) || !SHA.test(row.baseCommit) || !row.defaultBranch ||
            !['remote','cached','bootstrap'].includes(row.baseSource) ||
            normalize(row.worktree) === normalize(info.repository) ||
            normalize(await realPath(row.worktree)) !== normalize(row.worktree))
          throw Error('POSTMAN_TASK_BINDING_INVALID')
        const listings = (await command(info.repository, 'worktree', 'list', '--porcelain'))
          .split(/\n\s*\n/).filter(Boolean)
        const owned = listings.filter(entry => entry.split(/\r?\n/).some(line =>
          line.startsWith('worktree ') && normalize(line.slice(9)) === normalize(row.worktree)))
        if (owned.length !== 1 || !owned[0].split(/\r?\n/).includes('branch refs/heads/' + row.branch) ||
            /(?:^|\n)(?:locked|prunable)(?: |\r?$)/m.test(owned[0]) ||
            normalize(await command(row.worktree, 'rev-parse', '--show-toplevel')) !== normalize(row.worktree) ||
            await command(row.worktree, 'branch', '--show-current') !== row.branch ||
            await command(row.worktree, 'remote', 'get-url', 'origin') !== row.originUrl)
          throw Error('POSTMAN_TASK_WORKTREE_IDENTITY_UNKNOWN')
        for (const marker of ['MERGE_HEAD','REBASE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD',
          'rebase-merge','rebase-apply','sequencer']) {
          const path = await command(row.worktree, 'rev-parse', '--git-path', marker)
          if (await fileExists(resolve(row.worktree, path))) throw Error('POSTMAN_TASK_GIT_OPERATION_BUSY')
        }
        const head = await command(row.worktree, 'rev-parse', 'HEAD')
        if (!SHA.test(head) || await command(row.worktree, 'rev-parse', '--verify', row.baseCommit + '^{commit}') !== row.baseCommit ||
            await command(row.worktree, 'merge-base', head, row.baseCommit) !== row.baseCommit)
          throw Error('POSTMAN_TASK_HISTORY_UNKNOWN')
        if (row.baseSource === 'bootstrap' &&
            await command(row.worktree, 'rev-list', '--parents', '-n', '1', row.baseCommit) !== row.baseCommit)
          throw Error('POSTMAN_TASK_BOOTSTRAP_INVALID')
      }
      if (row.stage !== 'ready' || ['running', 'restoring'].includes(row.runner?.state) ||
          Object.values(row.bridgeOperations ?? {}).some(op => op.state === 'pending'))
        await registry.change(id, current => ({ ...current, stage: 'ready', diagnostic: null,
          runner: ['running','restoring'].includes(current.runner.state)
            ? { ...current.runner, state: 'unknown' } : current.runner,
          bridgeOperations: Object.fromEntries(Object.entries(current.bridgeOperations ?? {}).map(([key, op]) =>
            [key, op.state === 'pending' ? { ...op, state: 'unknown' } : op])) }))
      const context = boundContext(row)
      contexts.set(id, context); changed(id)
      return { status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY', ...context }
    } catch (error) {
      const diagnostic = String(error?.message ?? error)
      try { await registry.change(id, current => ({ ...current, stage: 'uncertain', diagnostic })) } catch {}
      contexts.delete(id); changed(id)
      return { status: 'POSTMAN_TASK_PREPARE_UNCERTAIN', diagnostic }
    } finally { pending.delete(id) }
  }

  // Recovery never invokes restore(), reset, clean, merge, or a new worktree add.
  async function recover(leader) {
    const id = leader?.id
    if (pending.has(id)) return { status: 'POSTMAN_TASK_PREPARE_IN_PROGRESS' }
    const row = registry.get(id)
    if (!row || row.stage === 'closed') return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
    if (row.universalProject === true) return recoverUniversal(leader, row)
    if (row.devspaceReadOnly === true) {
      pending.add(id)
      try {
        const cwd = leader?.session?.header?.cwd
        const repository = row.selectedDshProject
          ? (await repositoryFor(leader, row.repositoryPath)).repository
          : await command(cwd, 'rev-parse', '--show-toplevel')
        if (row.leaderSessionId !== id || row.repository !== REPOSITORY ||
            normalize(repository) !== normalize(row.repositoryPath) ||
            normalize(row.worktree) !== normalize(repository) ||
            row.branch !== 'main' || !SHA.test(row.baseCommit) ||
            await command(repository, 'remote', 'get-url', 'origin') !== row.originUrl)
          throw Error('POSTMAN_TASK_READ_ONLY_IDENTITY_UNKNOWN')
        const context = Object.freeze({ leaderSessionId: id, repository: REPOSITORY,
          branch: 'main', worktree: repository, baseCommit: row.baseCommit, devspaceReadOnly: true })
        if (row.stage !== 'ready') throw Error('POSTMAN_TASK_READ_ONLY_CONTEXT_UNKNOWN')
        await registry.change(id, old => ({ ...old, bridgeOperations:
          Object.fromEntries(Object.entries(old.bridgeOperations ?? {}).map(([key, op]) =>
            [key, op.state === 'pending' ? { ...op, state: 'unknown' } : op])) }))
        contexts.set(id, context)
        changed(id)
        return { status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY', ...context }
      } catch (error) { return { status: 'POSTMAN_TASK_PREPARE_UNCERTAIN', diagnostic: String(error?.message ?? error) } }
      finally { pending.delete(id) }
    }
    pending.add(id)
    let repositoryVerified = false
    try {
      const cwd = leader?.session?.header?.cwd
      if (typeof cwd !== 'string' || !cwd || row.leaderSessionId !== id ||
          row.repository !== REPOSITORY || !BRANCH.test(row.branch) || !SHA.test(row.baseCommit) ||
          !row.worktree || !row.repositoryPath || !row.originUrl) throw new Error('invalid durable binding')
      const repository = row.selectedDshProject
        ? (await repositoryFor(leader, row.repositoryPath)).repository
        : await command(cwd, 'rev-parse', '--show-toplevel')
      const originMatch = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(row.originUrl)
      if (normalize(repository) !== normalize(row.repositoryPath) ||
          originMatch?.[1].toLowerCase() !== REPOSITORY ||
          await command(repository, 'remote', 'get-url', 'origin') !== row.originUrl ||
          normalize(row.worktree) === normalize(repository) ||
          [resolve(homedir(), '.dsh'), resolve(homedir(), '.dsh-preview')]
            .some(path => normalize(path) === normalize(row.worktree))) throw new Error('repository or worktree identity mismatch')
      repositoryVerified = true
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
      if (!SHA.test(head) || !SHA.test(remote) || remoteLine !== remote + '\trefs/heads/' + row.branch)
        throw new Error('task branch history uncertain')
      // Fetch only the exact owned task ref to obtain missing objects; never update
      // HEAD or the working files during recovery.
      await command(row.worktree, 'fetch', 'origin', 'refs/heads/' + row.branch + ':refs/remotes/origin/' + row.branch)
      if (await command(row.worktree, 'rev-parse', 'refs/remotes/origin/' + row.branch) !== remote ||
          await command(row.worktree, 'merge-base', head, row.baseCommit) !== row.baseCommit ||
          await command(row.worktree, 'merge-base', remote, row.baseCommit) !== row.baseCommit)
        throw new Error('task branch history uncertain')
      const common = await command(row.worktree, 'merge-base', remote, head)
      if (common !== remote) {
        if (common !== head) throw new Error('task branch history uncertain')
        // Every remote-only commit must be one exact, locally journaled REQ
        // publication. An ordinary fast-forward without receipts is not authority.
        const receipts = new Map()
        const { DirectPostmanJobManager } = await import('./direct-current-turn.js')
        const direct = new DirectPostmanJobManager()
        for (const op of Object.values(row.bridgeOperations ?? {})) {
          const proof = op.requestId && ['artifact', 'text', 'image'].includes(op.transportKind)
            ? direct.inspectRequest(op.requestId, row.branch, op.transportKind) : null
          const terminal = op.state === 'received' && op.terminal &&
            ['pending', 'busy', 'failed', 'synchronized'].includes(op.synchronization) ? op.terminal
            : proof?.state === 'terminal' ? proof.terminal : null
          const result = terminal?.result
          const publication = result?.ok === true ? result :
            result?.ok === false && result.code === 'POSTMAN_TRANSPORT_FAILED' ? result.publicationReceipt
              : proof?.state === 'published' ? proof.publication : null
          if (!publication) continue
          const { taskPublicationCommit: commit, baseCommit: parent } = publication
          if (!SHA.test(commit ?? '') || !SHA.test(parent ?? '') ||
              (terminal && terminal.status !== 'POSTMAN_BRIDGE_TERMINAL') ||
              (!terminal && proof?.state !== 'published') ||
              (result?.ok === true && !['RESULT_DURABLE', 'TEXT_RESULT_DURABLE', 'IMAGE_RESULT_DURABLE',
                'ASSISTANT_COMPLETED_NO_ARTIFACT', 'ARTIFACT_REJECTED'].includes(result.code)) ||
              !['text', 'artifact', 'image'].includes(terminal?.transportKind ?? op.transportKind) ||
              typeof (terminal?.requestId ?? op.requestId) !== 'string' || !((terminal?.requestId ?? op.requestId)) ||
              (result?.requestId !== undefined && result.requestId !== (terminal?.requestId ?? op.requestId)) ||
              (publication.requestId !== undefined && publication.requestId !== (terminal?.requestId ?? op.requestId)) ||
              typeof publication.repository !== 'string' || publication.repository.toLowerCase() !== REPOSITORY ||
              (result?.ok === false ? publication.branch !== row.branch :
                publication.branch !== undefined && publication.branch !== row.branch) ||
              publication.taskUrl !==
                'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + commit + '/' + (terminal?.requestId ?? op.requestId) + '.md' ||
              receipts.has(commit)) throw new Error('task branch history uncertain')
          receipts.set(commit, parent)
        }
        const commits = (await command(row.worktree, 'rev-list', '--reverse', head + '..' + remote)).split(/\r?\n/).filter(Boolean)
        if (!commits.length) throw new Error('task branch history uncertain')
        let parent = head
        for (const commit of commits) {
          if (!SHA.test(commit) || receipts.get(commit) !== parent ||
              await command(row.worktree, 'rev-list', '--parents', '-n', '1', commit) !== commit + ' ' + parent)
            throw new Error('task branch history uncertain')
          parent = commit
        }
        if (parent !== remote) throw new Error('task branch history uncertain')
      }
      if (await command(repository, 'ls-remote', '--heads', 'origin', row.branch) !== remoteLine)
        throw new Error('task branch history uncertain')
      const context = Object.freeze({ leaderSessionId: id, repository: REPOSITORY,
        branch: row.branch, worktree: row.worktree, baseCommit: row.baseCommit })
      // Interrupted runner/Bridge outcomes are unknown, not trusted failures.
      if (row.stage !== 'ready' || row.runner.state === 'running' || row.runner.state === 'restoring' ||
          row.bridge?.state === 'pending' || Object.values(row.bridgeOperations ?? {}).some(op => op.state === 'pending'))
        await registry.change(id, old => ({ ...old, stage: 'ready', diagnostic: null,
          runner: ['running', 'restoring'].includes(old.runner.state)
            ? { ...old.runner, state: 'unknown' } : old.runner,
          bridge: old.bridge?.state === 'pending' ? { ...old.bridge, state: 'unknown' } : old.bridge,
          bridgeOperations: Object.fromEntries(Object.entries(old.bridgeOperations ?? {}).map(([jobId, op]) =>
            [jobId, op.state === 'pending' ? { ...op, state: 'unknown' } : op])) }))
      contexts.set(id, context)
      changed(id)
      return { status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY', ...context }
    } catch (error) {
      let diagnostic = String(error?.message ?? error)
      if (repositoryVerified && (diagnostic === 'task worktree ownership uncertain' || error?.code === 'ENOENT') &&
          (row.stage === 'ready' || row.stage === 'uncertain' && row.diagnostic === 'task worktree missing') &&
          !await fileExists(row.worktree)) diagnostic = 'task worktree missing'
      try { await registry.change(id, old => ({ ...old, stage: 'uncertain', diagnostic })) } catch {}
      contexts.delete(id)
      changed(id)
      return { status: 'POSTMAN_TASK_PREPARE_UNCERTAIN', diagnostic }
    } finally { pending.delete(id) }
  }

  // Explicit failed-runner recovery preserves dirty trees and isolates subsequent work.
  async function restore(leader, { isBusy = () => false, beforeRestore = async () => true, beforeIsolate = async () => null } = {}) {
    const id = leader?.id
    if (registry.get(id) && registry.get(id).leaderSessionId !== id)
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: { code: 'LEADER_CONTEXT_MISMATCH' } }
    const context = get(id)
    if (!context) return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: { code: 'TASK_CONTEXT_REQUIRED' } }
    if (context.devspaceReadOnly) return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: { code: 'DEVSPACE_READ_ONLY_NO_RESTORE' } }
    if (context.leaderSessionId !== id || registry.get(id)?.leaderSessionId !== id)
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: { code: 'LEADER_CONTEXT_MISMATCH' } }
    if (registry.get(id)?.runner.state !== 'failed')
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: { code: 'RUNNER_NOT_FAILED' } }
    if (!reserveRestore(id))
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: { code: 'RESTORE_RESERVATION_UNAVAILABLE' } }
    try {
      if (activeOperations.has(id) || syncOperations.has(id))
        return { status: 'POSTMAN_TASK_CONTEXT_BUSY', diagnostic: { code: 'RESTORE_OPERATION_BUSY' } }
      const { branch, worktree, baseCommit } = context
      const row = registry.get(id)
      const repository = row.universalProject ? row.repositoryPath : row.selectedDshProject
        ? (await repositoryFor(leader, row.repositoryPath)).repository
        : await command(leader.session.header.cwd, 'rev-parse', '--show-toplevel')
      const origin = await command(repository, 'remote', 'get-url', 'origin')
      const worktreeOrigin = await command(worktree, 'remote', 'get-url', 'origin')
      const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(origin)
      if ((row.universalProject || row.selectedDshProject ? !sameProject(row, repository, origin) :
            context.repository !== REPOSITORY || match?.[1].toLowerCase() !== REPOSITORY) ||
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
      let remote = head, remoteLine = null
      if (!row.universalProject) {
        remoteLine = await command(repository, 'ls-remote', '--heads', 'origin', branch)
        remote = remoteLine.split('\t')[0]
        if (!SHA.test(remote) || remoteLine !== remote + '\trefs/heads/' + branch)
          throw new Error('remote task branch missing')
        await command(worktree, 'fetch', 'origin', 'refs/heads/' + branch + ':refs/remotes/origin/' + branch)
        if (await command(worktree, 'rev-parse', 'refs/remotes/origin/' + branch) !== remote ||
            await command(worktree, 'merge-base', remote, baseCommit) !== baseCommit ||
            await command(worktree, 'merge-base', remote, head) !== head ||
            await command(repository, 'ls-remote', '--heads', 'origin', branch) !== remoteLine)
          throw new Error('remote task branch moved unexpectedly')
      }
      // A failed package does not identify which dirty bytes belong to that
      // runner rather than B/C. With retained Worker bindings, only an already
      // clean tree can be restored without discarding another session's work.
      const dirty = await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== ''
      if (dirty) {
        // The entire old tree/index remains available in place, with its pinned
        // REQs and grants. New work gets a distinct branch and worktree from main.
        let operationRetirement
        try { operationRetirement = await beforeIsolate(id) }
        catch { operationRetirement = { status: 'POSTMAN_TASK_ISOLATION_RETIREMENT_UNKNOWN' } }
        await registry.change(id, current => ({ ...current, stage: 'closed',
          abandoned: true, closedAt: new Date().toISOString() }))
        contexts.delete(id)
        for (const [childId, binding] of children) if (binding.context.leaderSessionId === id) children.delete(childId)
        changed(id)
        pending.delete(id)
        const next = await prepare(leader, row.selectedDshProject || row.universalProject ? row.repositoryPath : undefined)
        return { ...next, status: next.status === 'TASK_CONTEXT_READY' ? 'POSTMAN_TASK_RESTORE_ISOLATED' : next.status,
          oldWorktree: worktree, oldBranch: branch, oldHead: head, filesPreserved: true, taskCompleted: false,
          ...(operationRetirement ? { operationRetirement } : {}) }
      }
      if (isBusy(id) || !await beforeRestore(id))
        return { status: 'POSTMAN_TASK_CONTEXT_BUSY', diagnostic: { code: 'RESTORE_OPERATION_BUSY' } }
      // A crash after this point must not authorize an automatic second attempt.
      await registry.change(id, row => ({ ...row, runner: { ...row.runner, state: 'restoring' } }))
      if (head !== remote) await command(worktree, 'merge', '--ff-only', remote)
      if (await command(worktree, 'rev-parse', 'HEAD') !== remote ||
          await command(worktree, 'branch', '--show-current') !== branch ||
          await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '' ||
          (!row.universalProject && await command(repository, 'ls-remote', '--heads', 'origin', branch) !== remoteLine))
        throw new Error('restored task worktree could not be verified')
      await registry.change(id, row => ({ ...row, runner: { state: 'none', requestId: null } }))
      return { status: 'TASK_CONTEXT_RESTORED', branch, worktree, head: remote }
    } catch (error) {
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: String(error?.message ?? error) }
    } finally { pending.delete(id) }
  }

  // Reserve the mutable worktree from terminal handling until the sync completes.
  // Other Web Bridge operations remain independent while runner/restore are blocked.
  function beginSync(leaderId) {
    if (!get(leaderId) || pending.has(leaderId) || activeOperations.has(leaderId) || workerAdmissions.has(leaderId)) return false
    syncOperations.set(leaderId, (syncOperations.get(leaderId) ?? 0) + 1)
    return true
  }
  function endSync(leaderId) {
    const count = syncOperations.get(leaderId) ?? 0
    if (count <= 1) syncOperations.delete(leaderId)
    else syncOperations.set(leaderId, count - 1)
  }

  async function sync(leaderId, publicationCommit, expectedParent, beforeSync = async () => true) {
    const context = get(leaderId)
    const reject = code => ({ ok: false, diagnostic: { code } })
    if (!context) return reject('TASK_CONTEXT_CHANGED')
    if (!SHA.test(publicationCommit ?? '') || !SHA.test(expectedParent ?? '')) return reject('PUBLICATION_COMMIT_INVALID')
    if (workerAdmissions.has(leaderId)) return reject('WORKER_ADMISSION_ACTIVE')
    if (!beginSync(leaderId)) return reject('SYNC_ADMISSION_BUSY')
    // Queue insertion is synchronous, before the first await. Each Leader has
    // one FIFO chain; other Leaders' worktrees do not share a lock.
    const previous = syncQueues.get(leaderId) ?? Promise.resolve()
    let release
    const turn = new Promise(resolve => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => turn)
    syncQueues.set(leaderId, tail)
    try {
      await previous.catch(() => undefined)
      const { worktree, branch, baseCommit } = context
      if (get(leaderId) !== context) return reject('TASK_CONTEXT_CHANGED')
      if (workerAdmissions.has(leaderId)) return reject('WORKER_ADMISSION_ACTIVE')
      if (!await beforeSync(leaderId)) return reject('WORKER_ACTIVE')
      if (!BRANCH.test(branch) ||
          normalize(await realPath(worktree)) !== normalize(worktree) ||
          normalize(await command(worktree, 'rev-parse', '--show-toplevel')) !== normalize(worktree) ||
          await command(worktree, 'branch', '--show-current') !== branch ||
          await command(worktree, 'symbolic-ref', '--short', 'HEAD') !== branch ||
          await command(worktree, 'remote', 'get-url', 'origin') !== registry.get(leaderId)?.originUrl)
        return reject('WORKTREE_IDENTITY_MISMATCH')
      if (await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '') return reject('WORKTREE_DIRTY')
      const listing = await command(worktree, 'worktree', 'list', '--porcelain')
      const owned = listing.split(/\n\s*\n/).filter(Boolean).filter(entry =>
        entry.split(/\r?\n/).some(line => line.startsWith('worktree ') && normalize(line.slice(9)) === normalize(worktree)))
      if (owned.length !== 1 || !owned[0].split(/\r?\n/).includes('branch refs/heads/' + branch) ||
          /(?:^|\n)(?:locked|prunable)(?: |\r?$)/m.test(owned[0])) return reject('WORKTREE_IDENTITY_MISMATCH')
      const fetch = async () => {
        await command(worktree, 'fetch', 'origin', 'refs/heads/' + branch + ':refs/remotes/origin/' + branch)
        return command(worktree, 'rev-parse', 'refs/remotes/origin/' + branch)
      }
      let remote = await fetch()
      if (!SHA.test(remote)) return reject('GIT_SYNC_FAILED')
      const exactCommit = async sha => {
        try { return await command(worktree, 'rev-parse', '--verify', sha + '^{commit}') === sha }
        catch { return false }
      }
      if (!await exactCommit(baseCommit) || !await exactCommit(expectedParent) || !await exactCommit(publicationCommit) ||
          await command(worktree, 'rev-list', '--parents', '-n', '1', publicationCommit) !== publicationCommit + ' ' + expectedParent)
        return reject('PUBLICATION_COMMIT_INVALID')
      let published = await command(worktree, 'merge-base', publicationCommit, remote)
      if (published !== publicationCommit) {
        // An append-only push may race the first fetch; retry once, never publish ourselves.
        remote = await fetch()
        published = await command(worktree, 'merge-base', publicationCommit, remote)
      }
      if (published !== publicationCommit) return reject('PUBLICATION_NOT_REACHABLE')
      if (await command(worktree, 'merge-base', baseCommit, remote) !== baseCommit) return reject('PUBLICATION_COMMIT_INVALID')
      const head = await command(worktree, 'rev-parse', 'HEAD')
      if (!SHA.test(head) || await command(worktree, 'merge-base', head, remote) !== head) return reject('FAST_FORWARD_BLOCKED')
      if (await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '') return reject('WORKTREE_DIRTY')
      if (head !== remote) await command(worktree, 'merge', '--ff-only', remote)
      if (get(leaderId) !== context) return reject('TASK_CONTEXT_CHANGED')
      if (await command(worktree, 'rev-parse', 'HEAD') !== remote) return reject('GIT_SYNC_FAILED')
      if (await command(worktree, 'branch', '--show-current') !== branch) return reject('WORKTREE_IDENTITY_MISMATCH')
      if (await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '') return reject('WORKTREE_DIRTY')
      return true
    } catch { return reject('GIT_SYNC_FAILED') }
    finally {
      release()
      if (syncQueues.get(leaderId) === tail) syncQueues.delete(leaderId)
      endSync(leaderId)
    }
  }

  async function verifyWorktree(leaderId) {
    const context = get(leaderId)
    if (!context || context.devspaceReadOnly) return false
    try {
      const rootValid = normalize(await realPath(context.worktree)) === normalize(context.worktree) &&
        normalize(await command(context.worktree, 'rev-parse', '--show-toplevel')) === normalize(context.worktree) &&
        await command(context.worktree, 'branch', '--show-current') === context.branch &&
        await command(context.worktree, 'status', '--porcelain=v1', '--untracked-files=all') === ''
      if (!rootValid) return false
      if (context.universalProject) {
        const row = registry.get(leaderId)
        if (!row || !sameProject(row, context.repositoryPath,
            await command(context.worktree, 'remote', 'get-url', 'origin'))) return false
        const head = await command(context.worktree, 'rev-parse', 'HEAD')
        return SHA.test(head) && await command(context.worktree, 'merge-base', head, context.baseCommit) === context.baseCommit
      }
      return await command(context.worktree, 'rev-parse', 'HEAD') ===
        await command(context.worktree, 'rev-parse', 'refs/remotes/origin/' + context.branch)
    } catch { return false }
  }

  async function verifyDirectPublication(leaderId) {
    const context = get(leaderId)
    if (!context || context.devspaceReadOnly) return false
    if (!context.universalProject) return true
    try {
      if (!await verifyWorktree(leaderId)) return false
      const head = await command(context.worktree, 'rev-parse', 'HEAD')
      const remoteLine = await command(context.repositoryPath, 'ls-remote', '--heads', 'origin', context.branch)
      return remoteLine === head + '\trefs/heads/' + context.branch
    } catch { return false } // Offline or an unproven remote ref cannot authorize Direct Git publication.
  }

  function get(leaderId) {
    const row = registry.get(leaderId), context = contexts.get(leaderId)
    return row?.stage === 'ready' && context &&
      ['leaderSessionId', 'repository', 'branch', 'worktree', 'baseCommit']
        .every(key => row[key] === context[key]) ? context : null
  }
  function record(leaderId) { return registry.get(leaderId) }
  const records = () => registry.entries()
  const changeRecord = async (leaderId, fn) => { const result = await registry.change(leaderId, fn); changed(leaderId); return result }
  function isRestoring(leaderId) { return pending.has(leaderId) }
  function hasActiveOperation(leaderId) { return activeOperations.has(leaderId) }
  function hasSyncOperation(leaderId) { return syncOperations.has(leaderId) }
  function hasConflictingRetiredWriter(leaderId) {
    const current = registry.get(leaderId)
    if (!current?.worktree) return false
    const target = normalize(current.worktree)
    const overlaps = root => {
      if (typeof root !== 'string' || !root) return false
      const scope = normalize(root)
      return target === scope || target.startsWith(scope + '/') || scope.startsWith(target + '/')
    }
    for(const [,saved] of registry.entries())for(const task of [saved,...(saved.retiredTasks??[])])
      for(const [bridgeJobId,op] of Object.entries(task.bridgeOperations??{}))
        if(overlaps(devspaceWriterHoldRoot({leaderSessionId:task.leaderSessionId,bridgeJobId,task,op})))return true
    return [current, ...(current.retiredTasks ?? [])].some(task =>
      task !== current && ['running', 'unknown', 'restoring'].includes(task.runner?.state) && overlaps(task.worktree) ||
      Object.values(task.bridgeOperations ?? {}).some(op => {
        if (op.writerSettlement) return false
        if (overlaps(op.residualWriteRoot)) return true
        if (task === current && !op.archivedAt && !op.executionRevoked) return false
        const settled = op.state === 'received' && ['synchronized', 'not-required'].includes(op.synchronization)
        return !settled && op.transportKind === 'devspace' && overlaps(
          op.devspace?.approvedAccess === 'write' ? op.devspace.approvedRoot :
            op.devspace?.mode === 'WRITE_ISOLATED' ? task.worktree : null)
      }))
  }
  async function reconcileWriter(leaderId, bridgeJobId) {
    const reject = code => ({status:'POSTMAN_WRITER_EXIT_UNPROVEN', diagnostic:{code},
      alternative:'START_IN_NEW_ISOLATED_WORKSPACE'})
    const row=registry.get(leaderId)
    if(!row || row.leaderSessionId!==leaderId) return {status:'POSTMAN_WRITER_OWNER_MISMATCH'}
    const locate=current => [current,...(current.retiredTasks??[])].filter(task=>
      task.leaderSessionId===leaderId && task.bridgeOperations?.[bridgeJobId])
    const matches=locate(row)
    if(matches.length!==1) return {status:'POSTMAN_WRITER_OWNER_MISMATCH'}
    const task=matches[0], op=task.bridgeOperations[bridgeJobId]
    const hold=readDevspaceWriterHold({leaderSessionId:leaderId,bridgeJobId,task,op})
    const writeRoot=op.residualWriteRoot ?? (op.devspace?.approvedAccess==='write' ? op.devspace.approvedRoot :
      op.devspace?.mode==='WRITE_ISOLATED' ? task.worktree : hold?.root??op.writerSettlement?.writeRoot??null)
    const exact=proof => proof?.jobId===bridgeJobId && proof.leaderSessionId===leaderId && proof.requestId===op.requestId &&
      proof.branch===task.branch && proof.writeRoot===writeRoot
    if(op.writerSettlement) return exact(op.writerSettlement) ?
      {status:'POSTMAN_WRITER_ALREADY_RELEASED',bridgeJobId,writerSettlement:op.writerSettlement,
        holdCleared:clearDevspaceWriterHold({leaderSessionId:leaderId,bridgeJobId,task,op,proof:op.writerSettlement})} : reject('WRITER_BINDING_CHANGED')
    const receivedHold=op.state==='received' && hold?.verified===true
    if(op.transportKind!=='devspace' || !writeRoot || !(op.executionRevoked || op.archivedAt || task.stage==='closed' || receivedHold))
      return reject('WRITER_BINDING_CHANGED')
    if(receivedHold && !op.executionRevoked && !op.archivedAt && task.stage!=='closed'){
      try{revokeDevspaceChannel(loadDevspaceChannelForOwner(op.devspace.channel,{leaderSessionId:leaderId,
        bridgeJobId,lunaSessionId:op.childSessionId,requestId:op.requestId}))}
      catch{return reject('WRITER_BINDING_CHANGED')}
    }
    const otherWriters=[]
    const overlaps=root=>root && (normalize(root)===normalize(writeRoot) || normalize(root).startsWith(normalize(writeRoot)+'/') || normalize(writeRoot).startsWith(normalize(root)+'/'))
    for(const [,current] of registry.entries()) for(const historical of [current,...(current.retiredTasks??[])]) {
      // Idle sessions and retired membership do not prove that a former native
      // shell descendant died. These legacy writers have no complete census.
      if(overlaps(historical.worktree) && (workerAdmissions.has(current.leaderSessionId) ||
        Object.keys(historical.workers??{}).length || historical.retiredWorkers?.length))
        return reject('OTHER_WRITER_ACTIVE')
      if(Object.values(historical.appJobs??{}).some(app=>overlaps(app.worktree) &&
        !['completed','killed'].includes(app.terminal))) return reject('OTHER_WRITER_ACTIVE')
      if(['running','unknown','restoring'].includes(historical.runner?.state) && overlaps(historical.worktree))
        return reject('OTHER_WRITER_ACTIVE')
      for(const [id,other] of Object.entries(historical.bridgeOperations??{})) {
        if(other===op || other.writerSettlement || other.transportKind!=='devspace') continue
        const root=other.residualWriteRoot ?? (other.devspace?.approvedAccess==='write' ? other.devspace.approvedRoot :
          other.devspace?.mode==='WRITE_ISOLATED' ? historical.worktree :
            devspaceWriterHoldRoot({leaderSessionId:historical.leaderSessionId,bridgeJobId:id,task:historical,op:other}))
        if(overlaps(root)) otherWriters.push({jobId:id,requestId:other.requestId,leaderSessionId:historical.leaderSessionId,
          branch:historical.branch,writeRoot:root})
      }
    }
    const observed=await observeDevspaceWriter({leaderSessionId:leaderId,bridgeJobId,task,op,otherWriters,controlFile:writerControlFile})
    if(!observed.ok || !exact(observed.proof)) return reject(observed.code??'WRITER_BINDING_CHANGED')
    let released=false
    await registry.change(leaderId,current=>{
      const found=locate(current)
      if(found.length!==1 || found[0].branch!==task.branch || found[0].worktree!==task.worktree ||
        JSON.stringify(found[0].bridgeOperations[bridgeJobId])!==JSON.stringify(op)) return current
      const {residualWriteRoot,...saved}=op
      const updated={...found[0],bridgeOperations:{...found[0].bridgeOperations,
        [bridgeJobId]:{...saved,writerSettlement:observed.proof}}}
      released=true
      return found[0]===current ? updated : {...current,retiredTasks:current.retiredTasks.map(old=>old===found[0]?updated:old)}
    })
    if(!released) return reject('WRITER_BINDING_CHANGED')
    changed(leaderId)
    return {status:'POSTMAN_WRITER_RELEASED',bridgeJobId,writerSettlement:observed.proof,
      holdCleared:clearDevspaceWriterHold({leaderSessionId:leaderId,bridgeJobId,task,op,proof:observed.proof})}
  }
  // Synchronous reservation closes the gap before durable Worker intent/delivery.
  function canRetireWorkers(leaderId) {
    const row = registry.get(leaderId)
    return Boolean(get(leaderId) || row?.leaderSessionId === leaderId &&
      row.stage === 'uncertain' && row.diagnostic === 'task worktree missing')
  }
  function beginWorkerAdmission(leaderId, token, retirement = false) {
    if (!(retirement ? canRetireWorkers(leaderId) : get(leaderId)) || pending.has(leaderId) || activeOperations.has(leaderId) || syncOperations.has(leaderId)) return false
    // Prompt READ_ONLY does not remove ordinary Worker write/shell rights.
    if (!retirement && (hasConflictingRetiredWriter(leaderId) || Object.values(registry.get(leaderId)?.bridgeOperations ?? {}).some(op =>
      !op.archivedAt && !op.executionRevoked &&
      op.transportKind === 'devspace' && (op.devspace?.approvedAccess === 'write' || op.devspace?.mode === 'WRITE_ISOLATED') &&
      !(op.state === 'received' && ['synchronized','not-required'].includes(op.synchronization))))) return false
    let current = workerAdmissions.get(leaderId)
    if (!current) { current = new Set(); workerAdmissions.set(leaderId, current) }
    current.add(token)
    return true
  }
  function endWorkerAdmission(leaderId, token) {
    const current = workerAdmissions.get(leaderId)
    current?.delete(token)
    if (current?.size === 0) workerAdmissions.delete(leaderId)
  }
  function beginOperation(leaderId, isBusy = () => false, workerId = null) {
    if (!get(leaderId) || pending.has(leaderId) || activeOperations.has(leaderId) || syncOperations.has(leaderId) ||
        workerAdmissions.has(leaderId) ||
        ['running', 'unknown', 'restoring'].includes(registry.get(leaderId)?.runner.state) || hasConflictingRetiredWriter(leaderId) ||
        Object.values(registry.get(leaderId)?.bridgeOperations ?? {}).some(op =>
          !op.archivedAt && !op.executionRevoked && op.state === 'received' && !['synchronized', 'not-required'].includes(op.synchronization)) || isBusy(leaderId)) return false
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
    if (!get(leaderId) || pending.has(leaderId) || syncOperations.has(leaderId) || activeOperations.has(leaderId) || workerAdmissions.has(leaderId)) return false
    pending.add(leaderId)
    return true
  }
  function releaseRestore(leaderId) { pending.delete(leaderId) }
  function bindChild(leaderId, childId, bridgeJobId) {
    const context = get(leaderId)
    if (!context || children.has(childId)) return false
    children.set(childId, { context, bridgeJobId })
    return true
  }
  function child(childId) { return children.get(childId)?.context ?? null }
  function devspaceBinding(childId) {
    const binding = children.get(childId)
    if (!binding || get(binding.context.leaderSessionId) !== binding.context) return null
    const op = registry.get(binding.context.leaderSessionId)?.bridgeOperations?.[binding.bridgeJobId]
    if (op?.transportKind !== 'devspace' || op.state !== 'pending' || op.childSessionId !== childId || !op.devspace) return null
    return { bridgeJobId: binding.bridgeJobId, leaderSessionId: binding.context.leaderSessionId,
      lunaSessionId: childId, worktree: binding.context.worktree, branch:binding.context.branch, mode: op.devspace.mode }
  }
  async function recordBridgeRequest(childId, requestId, channel) {
    const binding = children.get(childId)
    if (!binding?.context || !get(binding.context.leaderSessionId) ||
        get(binding.context.leaderSessionId) !== binding.context ||
        typeof requestId !== 'string' || !/^REQ_\d{8}T\d{6}Z_\d{4}$/.test(requestId))
      throw new Error('POSTMAN_BRIDGE_REQUEST_BINDING_MISSING')
    if (!binding.bridgeJobId) return // Standalone/unit child has no Bridge journal to correlate.
    await registry.change(binding.context.leaderSessionId, row => {
      const op = row.bridgeOperations?.[binding.bridgeJobId]
      if (!op || op.childSessionId !== childId || !['pending', 'unknown'].includes(op.state) ||
          op.requestId && op.requestId !== requestId) throw new Error('POSTMAN_BRIDGE_REQUEST_BINDING_CHANGED')
      return { ...row, bridgeOperations: { ...row.bridgeOperations, [binding.bridgeJobId]:
        { ...op, requestId, phase: 'request-known', ...(channel && op.transportKind === 'devspace' ? { devspace: { ...op.devspace, channel } } : {}) } } }
    })
  }
  function releaseChild(childId) { children.delete(childId) }
  function dispose() { contexts.clear(); children.clear(); pending.clear(); activeOperations.clear(); syncOperations.clear(); syncQueues.clear(); workerAdmissions.clear(); contextListeners.clear() }
  return { readLedger: id => registry.readLedger(id),
    changeLedger: (id, fn) => registry.changeLedger(id, fn),
    prepare, prepareReadOnly, recover, close, restore, sync, beginSync, endSync, verifyWorktree, verifyDirectPublication, get, record, records, changeRecord, onContextChange, isRestoring, hasActiveOperation, hasSyncOperation, canRetireWorkers, beginWorkerAdmission, endWorkerAdmission, beginOperation, startRunner, endOperation, reserveRestore, releaseRestore, bindChild, child, devspaceBinding, recordBridgeRequest, releaseChild, reconcileWriter, hasConflictingRetiredWriter, dispose }
}

// Both entrypoints use one facade. Initialization is awaited before Git/child actions;
// never substitute a volatile registry if the storage backend fails to open.
let sharedContexts = null
export function initializePostmanTaskContexts(registry, options = {}) {
  if (!sharedContexts) sharedContexts = createPostmanTaskContexts({ registry, ...options })
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
