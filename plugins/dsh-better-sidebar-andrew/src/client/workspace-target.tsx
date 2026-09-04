import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { api, type GitWorktree, type SessionScope } from './api.ts'
import type { SidebarStore } from './state.ts'
import css from './sidebar.module.css'

function leafName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

export function useWorkspaceRoot(store: SidebarStore): string | undefined {
  return useSyncExternalStore(
    useCallback(listener => store.subscribe(listener), [store]),
    useCallback(() => store.getSnapshot().state?.workspaceRoot, [store]),
  )
}

export function setWorkspaceRoot(store: SidebarStore, workspaceRoot: string | undefined): void {
  const normalized = workspaceRoot === '' ? undefined : workspaceRoot
  store.reduce(state => {
    if (state.workspaceRoot === normalized) return state
    return { ...state, workspaceRoot: normalized, expanded: [] }
  })
  window.dispatchEvent(new CustomEvent('dsh-sidebar:workspace-target-changed', { detail: { workspaceRoot: normalized } }))
  window.dispatchEvent(new Event('dsh-sidebar:refresh-files'))
}

/** Shared Files/Source Control selector. It only changes store state. */
export function WorkspaceTargetSelect(props: { scope: SessionScope; store: SidebarStore }): JSX.Element | null {
  const { scope, store } = props
  const selected = useWorkspaceRoot(store)
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    const controller = new AbortController()
    void api.gitWorktrees({ sessionId: scope.sessionId, cwd: scope.cwd }, controller.signal).then(listed => {
      setWorktrees(listed)
      setError(null)
      if (selected !== undefined && !listed.some(entry => !entry.current && entry.path === selected)) setWorkspaceRoot(store, undefined)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => controller.abort()
  }, [scope.sessionId, scope.cwd, selected, store])
  useEffect(() => refresh(), [refresh])
  useEffect(() => {
    const onRefresh = (): void => { refresh() }
    window.addEventListener('focus', onRefresh)
    window.addEventListener('dsh-sidebar:refresh-workspaces', onRefresh)
    return () => {
      window.removeEventListener('focus', onRefresh)
      window.removeEventListener('dsh-sidebar:refresh-workspaces', onRefresh)
    }
  }, [refresh])
  if (worktrees.length <= 1) return null
  const current = worktrees.find(entry => entry.current)
  const linked = worktrees.filter(entry => !entry.current)
  return (
    <div className={css.editorTreeSearch} data-dsh-workspace-selector>
      <select
        className={css.editorSearchInput}
        aria-label="Workspace / Worktree"
        title={error ?? selected ?? current?.path}
        value={selected ?? ''}
        onChange={event => { setWorkspaceRoot(store, event.target.value === '' ? undefined : event.target.value) }}
      >
        <option value="">{current?.branch || 'main'}{current?.path !== undefined ? ` · ${leafName(current.path)}` : ''}</option>
        {linked.map(entry => <option key={entry.path} value={entry.path}>{entry.branch} · {leafName(entry.path)}</option>)}
      </select>
    </div>
  )
}
