import { realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isWithin, requireAbsolute } from './fs-tree.ts'
import { SidebarError } from './wire.ts'

/** Resolve an existing path and require it to remain inside a workspace root. */
export async function ensureWorkspacePath(
  workspaceRoot: string,
  target: string,
  allowMissing = false,
): Promise<string> {
  const root = await realpath(requireAbsolute(workspaceRoot)).catch((error: unknown) => {
    throw new SidebarError('forbidden', `workspace root is unavailable: ${messageOf(error)}`, 403)
  })
  const absolute = requireAbsolute(target)
  let resolved: string
  try {
    resolved = await realpath(absolute)
  } catch (error) {
    if (!allowMissing) {
      throw new SidebarError('forbidden', `path is unavailable: ${messageOf(error)}`, 403)
    }
    const parent = await realpath(dirname(absolute)).catch((parentError: unknown) => {
      throw new SidebarError('forbidden', `path parent is unavailable: ${messageOf(parentError)}`, 403)
    })
    resolved = join(parent, absolute.slice(dirname(absolute).length).replace(/^[\\/]+/, ''))
  }
  if (!isWithin(root, resolved)) {
    throw new SidebarError('forbidden', 'path escapes the selected workspace', 403)
  }
  return resolved
}

/** Require a workspace root to be a real directory. */
export async function ensureWorkspaceDirectory(workspaceRoot: string): Promise<string> {
  const resolved = await ensureWorkspacePath(workspaceRoot, workspaceRoot)
  const info = await stat(resolved).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw new SidebarError('forbidden', 'workspace root is not a directory', 403)
  }
  return resolved
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
