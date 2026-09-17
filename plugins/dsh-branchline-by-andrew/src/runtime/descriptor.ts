import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { TaskView } from '../types.ts'
import type { BranchRuntimeSource } from './types.ts'

const SHA256 = /^[0-9a-f]{64}$/u

/** Build and verify an immutable runtime source descriptor from a fresh Branchline task view. */
export function sourceFromTask(task: TaskView): BranchRuntimeSource {
  if (!task.exists) throw new Error('branch runtime: task worktree does not exist')
  if (task.headCommit === null) throw new Error('branch runtime: task HEAD is unavailable')
  const branch = task.currentBranch ?? task.branch
  if (branch === null || branch.trim() === '') throw new Error('branch runtime: task branch is unavailable')
  if (!SHA256.test(task.changeToken)) throw new Error('branch runtime: task changeToken is invalid')
  const inspected = inspectWorktree(task.workspacePath, 'branchline-task')
  if (!samePath(inspected.commonDirectory, task.commonDirectory)) {
    throw new Error('branch runtime: task common directory changed')
  }
  if (!samePath(inspected.repository, task.repository)) throw new Error('branch runtime: task repository changed before launch')
  if (inspected.head !== task.headCommit) throw new Error('branch runtime: task HEAD changed before launch')
  if (inspected.branch !== branch) throw new Error('branch runtime: task branch changed before launch')
  const expectedChangeToken = createHash('sha256')
    .update(String(task.id))
    .update('\0')
    .update(task.path)
    .update('\0')
    .update(inspected.sourceFingerprint)
    .digest('hex')
  if (expectedChangeToken !== task.changeToken) throw new Error('branch runtime: task changed before launch')
  return { ...inspected, changeToken: task.changeToken }
}

/** Inspect an existing worktree without taking ownership of it. */
export function sourceFromExternalWorktree(worktreePath: string): BranchRuntimeSource {
  const inspected = inspectWorktree(worktreePath, 'external-worktree')
  return { ...inspected, changeToken: inspected.sourceFingerprint }
}

/** Recompute source identity and return a reason when the running runtime is stale. */
export function staleSourceReason(source: BranchRuntimeSource): string | undefined {
  try {
    const current = inspectWorktree(source.worktreePath, source.source)
    if (!samePath(current.commonDirectory, source.commonDirectory)) return 'repository identity changed'
    if (current.branch !== source.branch) return `branch changed: ${source.branch} -> ${current.branch}`
    if (current.head !== source.head) return `HEAD changed: ${source.head.slice(0, 10)} -> ${current.head.slice(0, 10)}`
    if (current.sourceFingerprint !== source.sourceFingerprint) return 'worktree content changed after runtime launch'
    return undefined
  } catch (error) {
    return `source is no longer inspectable: ${errorMessage(error)}`
  }
}

/** Canonical containment guard used for runtime roots and branch-local package overrides. */
export function isPathInside(child: string, parent: string): boolean {
  const childPath = normalizePath(realpathOrResolve(child))
  const parentPath = normalizePath(realpathOrResolve(parent))
  const rel = relative(parentPath, childPath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function canonicalExistingPath(value: string): string {
  if (!isAbsolute(value)) throw new Error('branch runtime: path must be absolute')
  return realpathSync.native(resolve(value))
}

function inspectWorktree(worktreePath: string, source: BranchRuntimeSource['source']): BranchRuntimeSource {
  const worktree = canonicalExistingPath(worktreePath)
  const topLevel = canonicalExistingPath(gitText(worktree, ['rev-parse', '--show-toplevel']))
  if (!samePath(worktree, topLevel)) throw new Error('branch runtime: path must be the worktree root')
  const commonDirectoryRaw = gitText(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const commonDirectory = canonicalExistingPath(commonDirectoryRaw)
  const head = gitText(worktree, ['rev-parse', 'HEAD'])
  const branch = gitText(worktree, ['branch', '--show-current'])
  if (branch === '') throw new Error('branch runtime: detached HEAD is not supported by the MVP')
  const sourceFingerprint = worktreeFingerprint(worktree, head, branch)
  return {
    source,
    repository: topLevel,
    commonDirectory,
    worktreePath: worktree,
    branch,
    head,
    changeToken: sourceFingerprint,
    sourceFingerprint,
  }
}

function worktreeFingerprint(worktree: string, head: string, branch: string): string {
  const hash = createHash('sha256')
  hash.update('branch-runtime-source-v1\0')
  hash.update(head)
  hash.update('\0')
  hash.update(branch)
  hash.update('\0')
  hash.update(gitBuffer(worktree, ['status', '--porcelain=v2', '-z', '--untracked-files=all']))
  hash.update('\0')
  hash.update(gitBuffer(worktree, ['diff', '--binary', '--full-index', 'HEAD', '--']))
  hash.update('\0')
  const untracked = gitBuffer(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort()
  for (const relativePath of untracked) {
    const absolute = resolve(worktree, relativePath)
    if (!isPathInside(dirname(absolute), worktree)) throw new Error('branch runtime: untracked path escaped worktree')
    const stat = lstatSync(absolute)
    hash.update(relativePath)
    hash.update('\0')
    hash.update(String(stat.mode))
    hash.update('\0')
    if (stat.isSymbolicLink()) hash.update(readlinkSync(absolute))
    else if (stat.isFile()) hash.update(readFileSync(absolute))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function gitText(worktree: string, args: readonly string[]): string {
  return gitBuffer(worktree, args).toString('utf8').trim()
}

function gitBuffer(worktree: string, args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', worktree, ...args], {
    encoding: 'buffer',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
}

function samePath(left: string, right: string): boolean {
  return normalizePath(realpathOrResolve(left)) === normalizePath(realpathOrResolve(right))
}

function realpathOrResolve(value: string): string {
  try { return realpathSync.native(resolve(value)) } catch { return resolve(value) }
}

function normalizePath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
