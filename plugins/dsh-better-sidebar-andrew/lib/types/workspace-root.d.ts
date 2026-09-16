/** A validated physical worktree exposed to the Files/Source Control selector. */
export interface SidebarWorkspaceTarget {
    path: string;
    branch: string;
    current: boolean;
}
/** Compare physical paths using the host filesystem's case rules. */
export declare function sameWorkspacePath(left: string, right: string, platform?: NodeJS.Platform): boolean;
/**
 * Resolve a UI-selected filesystem checkout without performing `git checkout`.
 * The requested path must match a real entry returned by `git worktree list
 * --porcelain`; arbitrary directories are rejected.
 */
export declare function resolveWorkspaceCwd(baseCwd: string, requested?: string): Promise<string>;
/** List the authoritative repository's physical worktrees for the selector. */
export declare function listWorkspaceTargets(baseCwd: string): Promise<SidebarWorkspaceTarget[]>;
