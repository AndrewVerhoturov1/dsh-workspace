import { describe, expect, it } from 'vitest'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as git from '../src/git.ts'
import { listWorkspaceTargets, resolveWorkspaceCwd } from '../src/workspace-root.ts'

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

describe('workspace/worktree selector authority', () => {
  it('lists physical linked worktrees and accepts the current one', async () => {
    const root = await realpath(await git.repoRoot(pluginRoot))
    const targets = await listWorkspaceTargets(pluginRoot)
    expect(targets.some(target => target.path === root)).toBe(true)
    await expect(resolveWorkspaceCwd(pluginRoot, root)).resolves.toBe(root)
  })

  it('falls back to the session cwd when no workspace is selected', async () => {
    await expect(resolveWorkspaceCwd(pluginRoot)).resolves.toBe(pluginRoot)
  })

  it('rejects an arbitrary directory that is not a linked worktree', async () => {
    await expect(resolveWorkspaceCwd(pluginRoot, resolve(pluginRoot, 'src')))
      .rejects.toThrow('not a linked git worktree')
  })
})
