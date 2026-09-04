import { realpath } from 'node:fs/promises'
import { requireAbsolute } from './fs-tree.ts'
import * as git from './git.ts'
import { SidebarError } from './wire.ts'

/** A validated physical worktree exposed to the Files/Source Control selector. */
export interface SidebarWorkspaceTarget {
  path: string
  branch: string
  current: boolean
}

/**
 * Resolve a UI-selected filesystem checkout without performing `git checkout`.
 * The requested path must match a real entry returned by `git worktree list
 * --porcelain`; arbitrary directories are rejected.
 */
export async function resolveWorkspaceCwd(baseCwd: string, requested?: string): Promise<string> {
  if (requested === undefined || requested === '') return baseCwd
  const absolute = requireAbsolute(requested)
  const authority = await git.repoRoot(baseCwd).catch(() => baseCwd)
  const entries = await git.worktrees(authority)
  const requestedReal = await realpath(absolute).catch(() => undefined)
  if (requestedReal === undefined) {
    throw new SidebarError('forbidden', 'selected workspace does not exist', 403)
  }
  for (const entry of entries) {
    const entryReal = await realpath(entry.path).catch(() => undefined)
    if (entryReal !== undefined && entryReal.toLowerCase() === requestedReal.toLowerCase()) return entryReal
  }
  throw new SidebarError('forbidden', 'selected path is not a linked git worktree', 403)
}

/** List the authoritative repository's physical worktrees for the selector. */
export async function listWorkspaceTargets(baseCwd: string): Promise<SidebarWorkspaceTarget[]> {
  const authority = await git.repoRoot(baseCwd).catch(() => baseCwd)
  const rootReal = await realpath(authority).catch(() => authority)
  const entries = await git.worktrees(authority)
  return Promise.all(entries.map(async (entry) => {
    const path = await realpath(entry.path).catch(() => entry.path)
    return {
      path,
      branch: entry.branch,
      current: path.toLowerCase() === rootReal.toLowerCase(),
    }
  }))
}
