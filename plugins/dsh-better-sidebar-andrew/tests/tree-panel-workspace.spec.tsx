/** Regression coverage for the Files surface's physical workspace root. */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { TreePanel } from '../src/client/TreePanel.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { fsTree, fsSearch } = vi.hoisted(() => ({
  fsTree: vi.fn(async () => ({ entries: [] })),
  fsSearch: vi.fn(async () => ({ matches: [], truncated: false })),
}))

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree,
    fsSearch,
    gitWorktrees: async () => [
      { path: '/repo-main', branch: 'main', current: true },
      { path: '/repo-linked', branch: 'fix/linked', current: false },
    ],
  },
  downloadUrl: () => '/sidebar/file',
}))

describe('TreePanel workspace root', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let store: SidebarStore

  afterEach(() => {
    if (root !== undefined) act(() => { root?.unmount() })
    container?.remove()
    root = undefined
    container = undefined
    fsTree.mockClear()
    fsSearch.mockClear()
  })

  it('uses the selected physical root for the tree instead of the session main cwd', async () => {
    store = createSidebarStore()
    store.setSession('s1')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(createElement(TreePanel, {
        store,
        sessionId: 's1',
        cwd: '/repo-main',
        workspaceRoot: '/repo-linked',
        expanded: [],
        onToggle: () => {},
        onOpenFile: () => {},
        onReferenceFile: () => {},
      }))
    })

    expect(fsTree).toHaveBeenCalledWith(
      { sessionId: 's1', cwd: '/repo-main', workspaceRoot: '/repo-linked' },
      '/repo-linked',
    )
    expect(fsTree).not.toHaveBeenCalledWith(
      expect.anything(),
      '/repo-main',
    )
  })
})
