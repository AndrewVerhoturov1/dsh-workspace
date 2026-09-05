import type { SessionScope } from './api.ts';
/**
 * Resolve the physical root that owns a newly opened file.
 *
 * `workspaceRoot` is the explicit Files/Source Control selection.  Its
 * absence means the session's physical main worktree, represented by `cwd`.
 * This helper is for creating a tab pin only; an already-open tab must use its
 * persisted `meta.workspaceRoot` instead of consulting the selector again.
 */
export declare function workspaceRootForOpen(scope: Pick<SessionScope, 'cwd' | 'workspaceRoot'>): string | undefined;
/**
 * Find the physical worktree that owns an already-open absolute path.
 * Nested worktrees are resolved to the deepest matching root.  `fallback`
 * keeps legacy tabs readable when the host cannot enumerate worktrees.
 */
export declare function workspaceRootForPath(path: string, worktrees: readonly {
    path: string;
}[], fallback?: string): string | undefined;
