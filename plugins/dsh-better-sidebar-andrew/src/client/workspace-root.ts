import type { SessionScope } from './api.ts'

/** Normalize an absolute path for the client-side worktree ownership check. */
function normalizedPath(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  if (normalized.length <= 1) return normalized
  return normalized.replace(/\/+$/, '')
}

/** True when `path` is the root itself or a descendant of `root`. */
function containsPath(root: string, path: string): boolean {
  const normalizedRoot = normalizedPath(root)
  const normalizedPathValue = normalizedPath(path)
  return normalizedPathValue.toLowerCase() === normalizedRoot.toLowerCase()
    || normalizedPathValue.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)
}

/**
 * Resolve the physical root that owns a newly opened file.
 *
 * `workspaceRoot` is the explicit Files/Source Control selection.  Its
 * absence means the session's physical main worktree, represented by `cwd`.
 * This helper is for creating a tab pin only; an already-open tab must use its
 * persisted `meta.workspaceRoot` instead of consulting the selector again.
 */
export function workspaceRootForOpen(scope: Pick<SessionScope, 'cwd' | 'workspaceRoot'>): string | undefined {
  return scope.workspaceRoot ?? scope.cwd
}

/**
 * Find the physical worktree that owns an already-open absolute path.
 * Nested worktrees are resolved to the deepest matching root.  `fallback`
 * keeps legacy tabs readable when the host cannot enumerate worktrees.
 */
export function workspaceRootForPath(
  path: string,
  worktrees: readonly { path: string }[],
  fallback?: string,
): string | undefined {
  const owner = worktrees
    .filter(worktree => containsPath(worktree.path, path))
    .sort((left, right) => normalizedPath(right.path).length - normalizedPath(left.path).length)[0]
  return owner?.path ?? fallback
}
