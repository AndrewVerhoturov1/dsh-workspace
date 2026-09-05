/** Resolve an existing path and require it to remain inside a workspace root. */
export declare function ensureWorkspacePath(workspaceRoot: string, target: string, allowMissing?: boolean): Promise<string>;
/** Require a workspace root to be a real directory. */
export declare function ensureWorkspaceDirectory(workspaceRoot: string): Promise<string>;
