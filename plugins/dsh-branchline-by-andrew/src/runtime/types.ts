/** Pure data contracts for one isolated Branchline test runtime. */

export type RuntimeSourceKind = 'branchline-task' | 'external-worktree'
export type RuntimeState = 'PREPARING' | 'RUNNING' | 'STALE_SOURCE' | 'STOPPED' | 'ERROR'

export interface BranchRuntimeSource {
  readonly source: RuntimeSourceKind
  readonly repository: string
  readonly commonDirectory: string
  readonly worktreePath: string
  readonly branch: string
  readonly head: string
  readonly changeToken: string
  readonly sourceFingerprint: string
}

export interface BranchRuntimeOverride {
  readonly packageName: string
  readonly primarySpec: string
  readonly primaryPath?: string | undefined
  readonly branchPath: string
}

export interface BranchRuntimeDescriptor {
  readonly version: 1
  readonly runtimeId: string
  readonly state: RuntimeState
  readonly source: BranchRuntimeSource
  readonly runtimeRoot: string
  readonly homePath: string
  readonly profilePath: string
  readonly launcherRoot: string
  readonly profileName: string
  readonly primaryProfileHash?: string | undefined
  readonly overrides: readonly BranchRuntimeOverride[]
  readonly port?: number | undefined
  readonly pid?: number | undefined
  readonly createdAt: string
  readonly startedAt?: string | undefined
  readonly updatedAt: string
  readonly staleReason?: string | undefined
  readonly lastError?: string | undefined
}

export interface BranchRuntimeView {
  readonly runtimeId: string
  readonly state: RuntimeState
  readonly worktreePath: string
  readonly branch: string
  readonly head: string
  readonly port?: number | undefined
  readonly authenticatedUrl?: string | undefined
  readonly overrides: readonly string[]
  readonly staleReason?: string | undefined
  readonly lastError?: string | undefined
}
