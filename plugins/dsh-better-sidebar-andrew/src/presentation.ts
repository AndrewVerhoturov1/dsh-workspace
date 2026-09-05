import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  BetterSidebarPresentationService,
  SidebarPresentationRequest,
  SidebarPresentationWireRequest,
} from './context-types.ts'
import { requireAbsolute } from './fs-tree.ts'
import { ensureWorkspacePath } from './path-security.ts'
import { resolveWorkspaceCwd } from './workspace-root.ts'

type Sender = (request: SidebarPresentationWireRequest) => void
type EnqueueRequest =
  | ({ action: 'present' } & SidebarPresentationRequest)
  | { action: 'clear'; sessionId: string; workspaceRoot?: string }

export class SidebarPresentationRegistry {
  private pending = new Map<string, SidebarPresentationWireRequest[]>()
  private subscribers = new Map<string, Set<Sender>>()

  enqueue(request: EnqueueRequest): { id: string; delivered: boolean } {
    const value: SidebarPresentationWireRequest = { ...request, id: randomUUID() }
    const list = this.pending.get(value.sessionId) ?? []
    list.push(value)
    this.pending.set(value.sessionId, list)
    const views = this.subscribers.get(value.sessionId)
    if (views !== undefined && views.size > 0) {
      for (const send of views) send(value)
      this.pending.delete(value.sessionId)
      return { id: value.id, delivered: true }
    }
    return { id: value.id, delivered: false }
  }

  attach(sessionId: string, send: Sender): () => void {
    let views = this.subscribers.get(sessionId)
    if (views === undefined) {
      views = new Set()
      this.subscribers.set(sessionId, views)
    }
    views.add(send)
    const queued = this.pending.get(sessionId) ?? []
    for (const request of queued) send(request)
    this.pending.delete(sessionId)
    return () => {
      const current = this.subscribers.get(sessionId)
      current?.delete(send)
      if (current !== undefined && current.size === 0) this.subscribers.delete(sessionId)
    }
  }

  dispose(): void {
    this.pending.clear()
    this.subscribers.clear()
  }
}

function titleOf(kind: SidebarPresentationRequest['kind'], target: string, supplied?: string): string {
  if (supplied !== undefined && supplied.trim() !== '') return supplied.trim()
  if (kind === 'url') {
    try { return new URL(target).hostname || target } catch { return target }
  }
  return basename(target) || target
}

export function createBetterSidebarPresentationService(options: {
  registry: SidebarPresentationRegistry
  resolveSessionCwd: (sessionId: string) => Promise<string>
}): BetterSidebarPresentationService {
  const { registry, resolveSessionCwd } = options
  return {
    async present(input) {
      if (input === null || typeof input !== 'object') throw new Error('presentation request is required')
      if (typeof input.sessionId !== 'string' || input.sessionId === '') throw new Error('sessionId is required')
      if (input.kind !== 'html' && input.kind !== 'url' && input.kind !== 'file' && input.kind !== 'folder') {
        throw new Error('unsupported presentation kind')
      }
      const base = await resolveSessionCwd(input.sessionId)
      const workspaceRoot = await resolveWorkspaceCwd(base, input.workspaceRoot)
      let target = input.target
      if (input.kind === 'url') {
        let parsed: URL
        try { parsed = new URL(target) } catch { throw new Error('presentation URL is invalid') }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('presentation URL must use http or https')
        target = parsed.href
      } else {
        const requested = requireAbsolute(target)
        target = await ensureWorkspacePath(workspaceRoot, requested)
        const info = await stat(target)
        if (input.kind === 'folder') {
          if (!info.isDirectory()) throw new Error('presentation target is not a directory')
        } else if (!info.isFile()) {
          throw new Error('presentation target is not a file')
        }
      }
      const queued = registry.enqueue({
        action: 'present',
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot === undefined ? undefined : workspaceRoot,
        kind: input.kind,
        target,
        title: titleOf(input.kind, target, input.title),
      })
      return { ...queued, workspaceRoot: input.workspaceRoot === undefined ? undefined : workspaceRoot, target }
    },
    async clear(input) {
      if (input === null || typeof input !== 'object') throw new Error('clear request is required')
      if (typeof input.sessionId !== 'string' || input.sessionId === '') throw new Error('sessionId is required')
      const base = await resolveSessionCwd(input.sessionId)
      const workspaceRoot = await resolveWorkspaceCwd(base, input.workspaceRoot)
      const queued = registry.enqueue({
        action: 'clear',
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot === undefined ? undefined : workspaceRoot,
      })
      return { ...queued, workspaceRoot: input.workspaceRoot === undefined ? undefined : workspaceRoot }
    },
  }
}
