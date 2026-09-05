import { useEffect } from 'react'
import type { Context } from '../context-types.ts'
import { htmlUrl } from './api.ts'
import type { SidebarStore } from './state.ts'
import { setWorkspaceRoot, useWorkspaceRoot } from './workspace-target.tsx'
import { workspaceRootForOpen } from './workspace-root.ts'

const FAILURE_LIMIT = 3

interface PresentationFrame {
  action?: unknown
  sessionId?: unknown
  workspaceRoot?: unknown
  kind?: unknown
  target?: unknown
  title?: unknown
}

/** Consume host-only user presentation frames; this does not alter model tools. */
export function usePresentationFeed(input: { ctx: Context; store: SidebarStore; sessionId: string | undefined }): void {
  const { ctx, store, sessionId } = input
  const selectedRoot = useWorkspaceRoot(store)
  useEffect(() => {
    if (sessionId === undefined) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let failures = 0
    let closed = false
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/presentations', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ sessionId }).toString()
      socket = new WebSocket(url.toString())
      socket.onmessage = event => {
        if (typeof event.data !== 'string') return
        let frame: PresentationFrame
        try { frame = JSON.parse(event.data) as PresentationFrame } catch { return }
        if (frame === null || typeof frame !== 'object' || frame.sessionId !== sessionId) return
        const workspaceRoot = typeof frame.workspaceRoot === 'string' && frame.workspaceRoot !== '' ? frame.workspaceRoot : undefined
        if (frame.action === 'clear') {
          if (workspaceRoot === undefined || selectedRoot === workspaceRoot) setWorkspaceRoot(store, undefined)
          window.dispatchEvent(new Event('dsh-sidebar:refresh-workspaces'))
          return
        }
        if (frame.action !== 'present') return
        if (workspaceRoot !== undefined) setWorkspaceRoot(store, workspaceRoot)
        const service = ctx.get('betterSidebar')
        if (service === undefined) return
        const title = typeof frame.title === 'string' && frame.title !== '' ? frame.title : undefined
        const sessionCwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
        const tabWorkspaceRoot = workspaceRootForOpen({ cwd: sessionCwd, workspaceRoot })
        const scope = {
          sessionId,
          ...(sessionCwd === undefined ? {} : { cwd: sessionCwd }),
          ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        }
        if (frame.kind === 'html' && typeof frame.target === 'string' && frame.target !== '') {
          service.openTab({ type: 'browser', url: htmlUrl(scope, frame.target), title: title ?? 'Result' }, { sessionId })
        } else if (frame.kind === 'url' && typeof frame.target === 'string' && frame.target !== '') {
          service.openTab({ type: 'browser', url: frame.target, title }, { sessionId })
        } else if (frame.kind === 'file' && typeof frame.target === 'string' && frame.target !== '') {
          service.openTab({
            type: 'editor', path: frame.target, title,
            ...(tabWorkspaceRoot === undefined ? {} : { meta: { workspaceRoot: tabWorkspaceRoot } }),
          }, scope)
        } else if (frame.kind === 'folder' && typeof frame.target === 'string' && frame.target !== '') {
          service.openTab({
            type: 'editor', path: frame.target, title,
            meta: { dir: true, ...(tabWorkspaceRoot === undefined ? {} : { workspaceRoot: tabWorkspaceRoot }) },
          }, scope)
        }
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        if (failures < FAILURE_LIMIT) retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => { closed = true; window.clearTimeout(retry); socket?.close() }
  }, [ctx, store, sessionId, selectedRoot])
}
