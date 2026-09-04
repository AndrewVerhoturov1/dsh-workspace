import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBetterSidebarPresentationService, SidebarPresentationRegistry } from '../src/presentation.ts'

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

describe('Better Sidebar presentation service', () => {
  it('queues a validated HTTP result without changing model browser tools', async () => {
    const registry = new SidebarPresentationRegistry()
    const service = createBetterSidebarPresentationService({ registry, resolveSessionCwd: async () => repoRoot })
    await expect(service.present({ sessionId: 's', kind: 'url', target: 'https://example.test/result' }))
      .resolves.toMatchObject({ delivered: false, target: 'https://example.test/result' })
  })

  it('rejects non-HTTP URLs', async () => {
    const service = createBetterSidebarPresentationService({
      registry: new SidebarPresentationRegistry(),
      resolveSessionCwd: async () => repoRoot,
    })
    await expect(service.present({ sessionId: 's', kind: 'url', target: 'file:///tmp/result.html' }))
      .rejects.toThrow('must use http or https')
  })

  it('uses one workspaceRoot model for folder presentations', async () => {
    const root = repoRoot
    const service = createBetterSidebarPresentationService({
      registry: new SidebarPresentationRegistry(),
      resolveSessionCwd: async () => root,
    })
    await expect(service.present({ sessionId: 's', workspaceRoot: root, kind: 'folder', target: resolve(root, 'plugins') }))
      .resolves.toMatchObject({ workspaceRoot: root, target: resolve(root, 'plugins') })
  })
})
