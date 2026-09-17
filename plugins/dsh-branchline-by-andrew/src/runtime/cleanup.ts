import { existsSync, realpathSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { isPathInside } from './descriptor.ts'

/** Remove only a proven runtime sandbox below the configured Branchline runtime root. */
export function cleanupRuntimeSandbox(runtimeRoot: string, sandboxPath: string): void {
  const root = canonicalOrResolved(runtimeRoot)
  const sandbox = canonicalOrResolved(sandboxPath)
  if (sandbox === root || !isPathInside(sandbox, root)) {
    throw new Error('branch runtime: cleanup target is outside runtime root')
  }
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
}

function canonicalOrResolved(value: string): string {
  try { return realpathSync.native(resolve(value)) } catch { return resolve(value) }
}
