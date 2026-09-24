import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const REPOSITORY = 'andrewverhoturov1/dsh-workspace'
const SHA = /^[0-9a-f]{40}$/
const BRANCH = /^task\/postman-[0-9a-f]{32}$/
const normalize = value => resolve(value).replaceAll('\\', '/').toLowerCase()

async function git(cwd, ...args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 120000 })
  return stdout.trim()
}

/** Shared process-local instance across both plugin entrypoints. Model prose is never authority. */
export function createPostmanTaskContexts({ gitCommand = git, temporaryDirectory = tmpdir, makeDirectory = mkdtemp } = {}) {
  const contexts = new Map()
  const children = new Map()
  const pending = new Set()
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
      const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remote)
      if (match?.[1].toLowerCase() !== REPOSITORY) throw new Error('POSTMAN_TASK_REPOSITORY_REJECTED')
      await command(repository, 'fetch', '--prune', 'origin')
      const baseCommit = await command(repository, 'rev-parse', '--verify', 'refs/remotes/origin/preview^{commit}')
      if (!SHA.test(baseCommit)) throw new Error('POSTMAN_TASK_BASE_INVALID')
      const trees = await command(repository, 'worktree', 'list', '--porcelain')
      const existingTrees = trees.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
      if (!existingTrees.some(tree => normalize(tree) === normalize(repository))) throw new Error('POSTMAN_TASK_WORKTREES_UNAVAILABLE')
      const permanent = [repository, resolve(repository, '..', '.dsh-preview'), resolve(repository, '..', '.dsh')]
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
      const context = Object.freeze({ leaderSessionId: id, repository: REPOSITORY, branch, worktree, baseCommit })
      contexts.set(id, context)
      return { status: 'TASK_CONTEXT_READY', ...context }
    } catch (error) {
      const diagnostic = String(error?.message ?? error)
      if (created) failed.set(id, diagnostic) // Never lose possibly published branch/worktree on retry.
      return { status: created ? 'POSTMAN_TASK_PREPARE_UNCERTAIN' : 'POSTMAN_TASK_PREPARE_FAILED', diagnostic }
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

  function get(leaderId) { return contexts.get(leaderId) ?? null }
  function bindChild(leaderId, childId) {
    const context = get(leaderId)
    if (!context || children.has(childId)) return false
    children.set(childId, context)
    return true
  }
  function child(childId) { return children.get(childId) ?? null }
  function releaseChild(childId) { children.delete(childId) }
  function dispose() { contexts.clear(); children.clear(); pending.clear(); failed.clear() }
  return { prepare, sync, verifyWorktree, get, bindChild, child, releaseChild, dispose }
}

export const postmanTaskContexts = createPostmanTaskContexts()
export const POSTMAN_TASK_BRANCH_PATTERN = BRANCH
