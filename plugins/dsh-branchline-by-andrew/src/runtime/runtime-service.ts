import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TaskView } from '../types.ts'
import { cleanupRuntimeSandbox } from './cleanup.ts'
import { isPathInside, sourceFromExternalWorktree, sourceFromTask, staleSourceReason } from './descriptor.ts'
import { snapshotHomeConfiguration } from './credentials-policy.ts'
import { prepareRuntimeProfile } from './profile-snapshot.ts'
import { BranchRuntimeController, findFreePort } from './runtime-controller.ts'
import type {
  BranchRuntimeDescriptor,
  BranchRuntimeSource,
  BranchRuntimeView,
  RuntimeState,
} from './types.ts'

const RUNTIME_ID = /^brt-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/u

/** Lifecycle owner for private Harness snapshots. It never owns or mutates the source worktree. */
export class BranchRuntimeService {
  private readonly controller: BranchRuntimeController
  readonly runtimeRoot: string

  constructor(
    readonly primaryHome: string,
    runtimeRoot = defaultRuntimeRoot(primaryHome),
    readonly profileName = 'web',
    readonly portStart = 4174,
    readonly portEnd = 4214,
    controller = new BranchRuntimeController(),
  ) {
    this.runtimeRoot = resolve(runtimeRoot)
    if (isPathInside(this.runtimeRoot, this.primaryHome)) {
      throw new Error('branch runtime: runtime root must remain outside primary DSH_HOME')
    }
    this.controller = controller
  }

  inspectExternal(worktreePath: string): BranchRuntimeSource {
    return sourceFromExternalWorktree(worktreePath)
  }

  async startTask(task: TaskView): Promise<BranchRuntimeView> {
    return await this.startSource(sourceFromTask(task))
  }

  async startExternal(worktreePath: string): Promise<BranchRuntimeView> {
    return await this.startSource(sourceFromExternalWorktree(worktreePath))
  }

  statusByWorktree(worktreePath: string): BranchRuntimeView | null {
    const target = normalizePath(worktreePath)
    const descriptors = this.listDescriptors()
      .filter(value => normalizePath(value.source.worktreePath) === target)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const candidate = descriptors.find(value => value.state === 'RUNNING' || value.state === 'STALE_SOURCE' || value.state === 'PREPARING')
      ?? descriptors[0]
    return candidate === undefined ? null : this.refresh(candidate)
  }

  status(runtimeId: string): BranchRuntimeView {
    return this.refresh(this.readDescriptor(runtimeId))
  }

  async stop(runtimeId: string): Promise<BranchRuntimeView> {
    const descriptor = this.readDescriptor(runtimeId)
    await this.controller.stop(descriptor.launcherRoot)
    return this.toView(this.updateDescriptor(descriptor, { state: 'STOPPED', staleReason: undefined }))
  }

  cleanup(runtimeId: string): { readonly runtimeId: string; readonly cleaned: true } {
    const descriptor = this.readDescriptor(runtimeId)
    const controller = this.controller.status(descriptor.launcherRoot)
    if (controller.state === 'RUNNING') throw new Error('branch runtime: stop runtime before cleanup')
    if (controller.state === 'FOREIGN_PROCESS') throw new Error('branch runtime: cleanup blocked by unproven process identity')
    cleanupRuntimeSandbox(this.runtimeRoot, descriptor.runtimeRoot)
    return { runtimeId, cleaned: true }
  }

  private async startSource(source: BranchRuntimeSource): Promise<BranchRuntimeView> {
    const existing = this.statusByWorktree(source.worktreePath)
    if (existing !== null && (existing.state === 'RUNNING' || existing.state === 'STALE_SOURCE' || existing.state === 'PREPARING')) {
      throw new Error(`branch runtime: source already has runtime ${existing.runtimeId}`)
    }

    mkdirSync(this.runtimeRoot, { recursive: true })
    const runtimeId = makeRuntimeId()
    const sandbox = join(this.runtimeRoot, runtimeId)
    const homePath = join(sandbox, 'home')
    const launcherRoot = join(sandbox, 'launcher')
    const now = new Date().toISOString()
    mkdirSync(sandbox, { recursive: false })
    let descriptor: BranchRuntimeDescriptor = {
      version: 1,
      runtimeId,
      state: 'PREPARING',
      source,
      runtimeRoot: sandbox,
      homePath,
      profilePath: join(homePath, 'profiles', this.profileName),
      launcherRoot,
      profileName: this.profileName,
      overrides: [],
      createdAt: now,
      updatedAt: now,
    }
    this.writeDescriptor(descriptor)

    try {
      snapshotHomeConfiguration(this.primaryHome, homePath)
      const prepared = prepareRuntimeProfile({
        primaryHome: this.primaryHome,
        runtimeHome: homePath,
        worktreePath: source.worktreePath,
        profileName: this.profileName,
      })
      const port = findFreePort(this.portStart, this.portEnd)
      descriptor = this.updateDescriptor(descriptor, {
        primaryProfileHash: prepared.profileHash,
        profilePath: prepared.profilePath,
        overrides: prepared.overrides,
        port,
      })
      const launch = await this.controller.start({
        runtimeId,
        cwd: source.worktreePath,
        home: homePath,
        launcherRoot,
        profile: this.profileName,
        port,
      })
      descriptor = this.updateDescriptor(descriptor, {
        state: 'RUNNING',
        pid: launch.pid,
        port: launch.port,
        startedAt: new Date().toISOString(),
      })
      return this.toView(descriptor, launch.authenticatedUrl)
    } catch (error) {
      descriptor = this.updateDescriptor(descriptor, {
        state: 'ERROR',
        lastError: safeError(error),
      })
      throw error
    }
  }

  private refresh(descriptor: BranchRuntimeDescriptor): BranchRuntimeView {
    if (descriptor.state === 'RUNNING' || descriptor.state === 'STALE_SOURCE') {
      const controller = this.controller.status(descriptor.launcherRoot)
      if (controller.state === 'STOPPED') {
        descriptor = this.updateDescriptor(descriptor, { state: 'STOPPED', pid: undefined })
      } else if (controller.state === 'FOREIGN_PROCESS') {
        descriptor = this.updateDescriptor(descriptor, {
          state: 'ERROR',
          lastError: 'runtime process identity no longer matches its controller state',
        })
      } else {
        const reason = staleSourceReason(descriptor.source)
        const nextState: RuntimeState = reason === undefined ? 'RUNNING' : 'STALE_SOURCE'
        if (descriptor.state !== nextState || descriptor.staleReason !== reason) {
          descriptor = this.updateDescriptor(descriptor, { state: nextState, staleReason: reason })
        }
      }
    }
    const controller = descriptor.state === 'RUNNING' || descriptor.state === 'STALE_SOURCE'
      ? this.controller.status(descriptor.launcherRoot)
      : undefined
    const authenticatedUrl = controller?.state === 'RUNNING' ? controller.authenticatedUrl : undefined
    return this.toView(descriptor, authenticatedUrl)
  }

  private listDescriptors(): BranchRuntimeDescriptor[] {
    if (!existsSync(this.runtimeRoot)) return []
    const result: BranchRuntimeDescriptor[] = []
    for (const entry of readdirSync(this.runtimeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUNTIME_ID.test(entry.name)) continue
      try { result.push(this.readDescriptor(entry.name)) } catch {}
    }
    return result
  }

  private readDescriptor(runtimeId: string): BranchRuntimeDescriptor {
    if (!RUNTIME_ID.test(runtimeId)) throw new Error('branch runtime: invalid runtime id')
    const path = join(this.runtimeRoot, runtimeId, 'runtime.json')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BranchRuntimeDescriptor
    if (parsed?.version !== 1 || parsed.runtimeId !== runtimeId) throw new Error('branch runtime: invalid runtime descriptor')
    const expectedRoot = join(this.runtimeRoot, runtimeId)
    if (!isPathInside(parsed.runtimeRoot, expectedRoot) || !isPathInside(expectedRoot, parsed.runtimeRoot)) {
      throw new Error('branch runtime: descriptor runtime root mismatch')
    }
    if (![parsed.homePath, parsed.profilePath, parsed.launcherRoot].every(value => typeof value === 'string')) {
      throw new Error('branch runtime: descriptor paths are invalid')
    }
    if (normalizePath(parsed.homePath) === normalizePath(parsed.runtimeRoot) || !isPathInside(parsed.homePath, parsed.runtimeRoot)) {
      throw new Error('branch runtime: descriptor home is outside runtime sandbox')
    }
    if (normalizePath(parsed.launcherRoot) === normalizePath(parsed.runtimeRoot) || !isPathInside(parsed.launcherRoot, parsed.runtimeRoot)) {
      throw new Error('branch runtime: descriptor launcher is outside runtime sandbox')
    }
    if (!isPathInside(parsed.profilePath, parsed.homePath)) {
      throw new Error('branch runtime: descriptor profile is outside runtime home')
    }
    return parsed
  }

  private writeDescriptor(descriptor: BranchRuntimeDescriptor): void {
    mkdirSync(descriptor.runtimeRoot, { recursive: true })
    const path = join(descriptor.runtimeRoot, 'runtime.json')
    const temporary = `${path}.tmp-${String(process.pid)}`
    writeFileSync(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  }

  private updateDescriptor(
    descriptor: BranchRuntimeDescriptor,
    patch: Partial<Omit<BranchRuntimeDescriptor, 'version' | 'runtimeId' | 'source' | 'runtimeRoot' | 'homePath' | 'launcherRoot' | 'profileName' | 'createdAt'>>,
  ): BranchRuntimeDescriptor {
    const next: BranchRuntimeDescriptor = {
      ...descriptor,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    this.writeDescriptor(next)
    return next
  }

  private toView(descriptor: BranchRuntimeDescriptor, authenticatedUrl?: string): BranchRuntimeView {
    return {
      runtimeId: descriptor.runtimeId,
      state: descriptor.state,
      worktreePath: descriptor.source.worktreePath,
      branch: descriptor.source.branch,
      head: descriptor.source.head,
      ...(descriptor.port === undefined ? {} : { port: descriptor.port }),
      ...(authenticatedUrl === undefined ? {} : { authenticatedUrl }),
      overrides: descriptor.overrides.map(value => value.packageName),
      ...(descriptor.staleReason === undefined ? {} : { staleReason: descriptor.staleReason }),
      ...(descriptor.lastError === undefined ? {} : { lastError: descriptor.lastError }),
    }
  }
}

export function defaultRuntimeRoot(primaryHome: string): string {
  const canonicalHome = canonicalPrimaryHome(primaryHome)
  const homeId = createHash('sha256')
    .update(`branchline-runtime-root-v1\0${canonicalHome}`)
    .digest('hex')
    .slice(0, 16)
  const base = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA?.trim() || homedir(), 'DSH', 'branchline-runtimes')
    : (() => {
      const home = homedir()
      return home === '' ? join(tmpdir(), 'dsh-branchline-runtimes') : join(home, '.dsh-branchline-runtimes')
    })()
  const root = join(base, homeId)
  if (isPathInside(root, canonicalHome)) {
    throw new Error('branch runtime: default runtime root would be inside primary DSH_HOME')
  }
  return root
}

function canonicalPrimaryHome(value: string): string {
  const resolved = resolve(value)
  try { return normalizePath(realpathSync.native(resolved)) } catch { return normalizePath(resolved) }
}

function makeRuntimeId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  return `brt-${stamp}-${randomUUID().replaceAll('-', '').slice(0, 8)}`
}

function normalizePath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(token|key|secret|password|credential)=([^\s]+)/giu, '$1=<redacted>')
}
