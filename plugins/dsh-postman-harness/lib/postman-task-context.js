import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises'
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

// Kept outside Git and temp cleanup; never uploaded or included in tool output.
async function preserveTaskChanges({ worktree, command, ...metadata }) {
  const root = join(homedir(), '.dsh-recovery', 'postman')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const backup = await mkdtemp(join(root, 'restore-'))
  await cp(worktree, join(backup, 'files'), { recursive: true, dereference: false, verbatimSymlinks: true,
    filter: source => normalize(source) !== normalize(join(worktree, '.git')) })
  const index = resolve(worktree, await command(worktree, 'rev-parse', '--git-path', 'index'))
  await copyFile(index, join(backup, 'index'))
  await writeFile(join(backup, 'recovery.json'), JSON.stringify({ ...metadata, worktree }, null, 2), 'utf8')
  return backup
}

/** The host injects one durable registry; tests explicitly inject an in-memory one. */
export function createPostmanTaskContexts({ registry = createMemoryTaskRegistry(), gitCommand = git, temporaryDirectory = tmpdir, makeDirectory = mkdtemp, realPath = realpath, localDevelopment = false, preserveChanges = preserveTaskChanges } = {}) {
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

  async function prepare(leader) {
    const id = leader?.id
    if (pending.has(id)) return { status: 'POSTMAN_TASK_PREPARE_IN_PROGRESS' }
    if (contexts.has(id) && registry.get(id)?.stage === 'ready') return { status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY', ...contexts.get(id) }
    if (registry.get(id) && registry.get(id).stage !== 'closed') return recover(leader)
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
        branch, worktree, baseCommit, stage: 'intent', diagnostic: null, workers: {},
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
      changed(id)
      return { status: 'TASK_CONTEXT_READY', ...context }
    } catch (error) {
      const diagnostic = String(error?.message ?? error)
      if (created) {
        try { await registry.change(id, row => ({ ...row, stage: 'uncertain', diagnostic })) } catch {}
      }
      return { status: created ? 'POSTMAN_TASK_PREPARE_UNCERTAIN' : 'POSTMAN_TASK_PREPARE_FAILED', diagnostic }
    } finally { pending.delete(id) }
  }

  // Close retires authority, not files/branches and not a task-success certificate.
  // It deliberately needs no Git/worktree access after external merge/cleanup.
  async function close(leader, { isBusy = () => false, beforeClose = async () => true } = {}) {
    const id = leader?.id
    const reject = code => ({ status: 'POSTMAN_TASK_CLOSE_REJECTED', diagnostic: { code } })
    if (pending.has(id) || activeOperations.has(id) || syncOperations.has(id) || workerAdmissions.has(id))
      return reject('TASK_OPERATION_BUSY')
    const row = registry.get(id)
    if (!row || row.leaderSessionId !== id) return reject('TASK_CONTEXT_REQUIRED')
    if (row.stage === 'closed') return { status: 'POSTMAN_TASK_CLOSED', branch: row.branch, closedAt: row.closedAt }
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
        if (!cwd || row.repository !== REPOSITORY || !BRANCH.test(row.branch) || !SHA.test(row.baseCommit) ||
            !row.repositoryPath || !row.originUrl || !row.worktree) return reject('TASK_STATE_UNCERTAIN')
        const repository = await command(cwd, 'rev-parse', '--show-toplevel')
        const originMatch = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(row.originUrl)
        if (normalize(repository) !== normalize(row.repositoryPath) || originMatch?.[1].toLowerCase() !== REPOSITORY ||
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

  // Recovery never invokes restore(), reset, clean, merge, or a new worktree add.
  async function recover(leader) {
    const id = leader?.id
    if (pending.has(id)) return { status: 'POSTMAN_TASK_PREPARE_IN_PROGRESS' }
    const row = registry.get(id)
    if (!row || row.stage === 'closed') return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
    pending.add(id)
    let repositoryVerified = false
    try {
      const cwd = leader?.session?.header?.cwd
      if (typeof cwd !== 'string' || !cwd || row.leaderSessionId !== id ||
          row.repository !== REPOSITORY || !BRANCH.test(row.branch) || !SHA.test(row.baseCommit) ||
          !row.worktree || !row.repositoryPath || !row.originUrl) throw new Error('invalid durable binding')
      const repository = await command(cwd, 'rev-parse', '--show-toplevel')
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

  // Explicit runner restore is a separate destructive path; never call from recover.
  async function restore(leader, { isBusy = () => false, beforeRestore = async () => true } = {}) {
    const id = leader?.id
    const context = get(id)
    if (!context) return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: { code: 'TASK_CONTEXT_REQUIRED' } }
    if (context.leaderSessionId !== id || registry.get(id)?.leaderSessionId !== id)
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: { code: 'LEADER_CONTEXT_MISMATCH' } }
    if (registry.get(id)?.runner.state !== 'failed')
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: { code: 'RUNNER_NOT_FAILED' } }
    if (!reserveRestore(id))
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: { code: 'RESTORE_RESERVATION_UNAVAILABLE' } }
    let recoveryPath = null
    try {
      if (activeOperations.has(id) || syncOperations.has(id) || isBusy(id) || !await beforeRestore(id))
        return { status: 'POSTMAN_TASK_CONTEXT_BUSY', diagnostic: { code: 'RESTORE_OPERATION_BUSY' } }
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
      // A failed package does not identify which dirty bytes belong to that
      // runner rather than B/C. With retained Worker bindings, only an already
      // clean tree can be restored without discarding another session's work.
      const dirty = await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== ''
      if (!localDevelopment && Object.keys(registry.get(id)?.workers ?? {}).length > 0 && dirty)
        throw new Error('dirty Worker changes have no proven restore ownership')
      // Do not guess which dirty bytes came from runner or user. Preserve them
      // privately before a local reset, including untracked/ignored files and index.
      recoveryPath = dirty
        ? await preserveChanges({ worktree, branch, head, remote, leaderSessionId: id, command }) : null
      // A crash after this point must not authorize an automatic second attempt.
      await registry.change(id, row => ({ ...row, runner: { ...row.runner, state: 'restoring' } }))
      if (localDevelopment && !dirty) {
        if (head !== remote) await command(worktree, 'merge', '--ff-only', remote)
      } else {
        await command(worktree, 'reset', '--hard', remote)
        await command(worktree, 'clean', '-fd')
      }
      if (await command(worktree, 'rev-parse', 'HEAD') !== remote ||
          await command(worktree, 'branch', '--show-current') !== branch ||
          await command(worktree, 'status', '--porcelain=v1', '--untracked-files=all') !== '' ||
          await command(repository, 'ls-remote', '--heads', 'origin', branch) !== remoteLine)
        throw new Error('restored task worktree could not be verified')
      await registry.change(id, row => ({ ...row, runner: { state: 'none', requestId: null } }))
      return { status: 'TASK_CONTEXT_RESTORED', branch, worktree, head: remote, ...(recoveryPath ? { recoveryPath } : {}) }
    } catch (error) {
      return { status: 'POSTMAN_TASK_RESTORE_REJECTED', diagnostic: String(error?.message ?? error),
        ...(recoveryPath ? { recoveryPath } : {}) }
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
  function hasSyncOperation(leaderId) { return syncOperations.has(leaderId) }
  // Synchronous reservation closes the gap before durable Worker intent/delivery.
  function beginWorkerAdmission(leaderId, token) {
    if (!get(leaderId) || pending.has(leaderId) || activeOperations.has(leaderId) || syncOperations.has(leaderId)) return false
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
        ['running', 'unknown', 'restoring'].includes(registry.get(leaderId)?.runner.state) ||
        Object.values(registry.get(leaderId)?.bridgeOperations ?? {}).some(op =>
          op.state === 'received' && !['synchronized', 'not-required'].includes(op.synchronization)) || isBusy(leaderId)) return false
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
    if (!get(leaderId) || pending.has(leaderId) || syncOperations.has(leaderId) || activeOperations.has(leaderId) || workerAdmissions.has(leaderId) ||
        (!localDevelopment && Object.values(registry.get(leaderId)?.bridgeOperations ?? {}).some(op =>
          op.state === 'received' && !['synchronized', 'not-required'].includes(op.synchronization)))) return false
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
  async function recordBridgeRequest(childId, requestId) {
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
        { ...op, requestId, phase: 'request-known' } } }
    })
  }
  function releaseChild(childId) { children.delete(childId) }
  function dispose() { contexts.clear(); children.clear(); pending.clear(); activeOperations.clear(); syncOperations.clear(); syncQueues.clear(); workerAdmissions.clear(); contextListeners.clear() }
  return { prepare, recover, close, restore, sync, beginSync, endSync, verifyWorktree, get, record, changeRecord, onContextChange, isRestoring, hasActiveOperation, hasSyncOperation, beginWorkerAdmission, endWorkerAdmission, beginOperation, startRunner, endOperation, reserveRestore, releaseRestore, bindChild, child, recordBridgeRequest, releaseChild, dispose }
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
