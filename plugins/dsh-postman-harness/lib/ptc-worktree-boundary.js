import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, dirname, parse, sep } from 'node:path'

const reject = () => new Error('PTC_FILESYSTEM_BOUNDARY_REJECTED: target outside current task worktree or not verifiable')
const contained = (root, target) => {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

// Existing targets resolve through realpath; for a nonexistent target the
// nearest existing canonical ancestor establishes containment. Stage 4.5
// dispatches only research tools, never writes.
export async function resolvePtcWorktreePath(worktree, requested) {
  if (typeof worktree !== 'string' || !isAbsolute(worktree) ||
      typeof requested !== 'string' || !requested.trim() || requested.includes('\0') ||
      (!isAbsolute(requested) && /^[a-zA-Z]:/.test(requested))) throw reject()
  let root
  try { root = await realpath(worktree) } catch { throw reject() }
  const target = isAbsolute(requested) ? resolve(requested) : resolve(root, requested)
  if (!contained(root, target)) throw reject()
  let ancestor = target
  for (;;) {
    try { await lstat(ancestor) } catch (error) {
      if (error?.code !== 'ENOENT') throw reject()
      const parent = dirname(ancestor)
      if (parent === ancestor || ancestor === parse(ancestor).root) throw reject()
      ancestor = parent
      continue
    }
    // An existing but dangling link must never be treated as a missing target.
    let canonical
    try { canonical = await realpath(ancestor) } catch { throw reject() }
    if (!contained(root, canonical)) throw reject()
    return target
  }
}

// Only the actual filesystem-location fields in the installed DSH schemas are
// rewritten. Search patterns and web calls are not filesystem roots.
export async function guardWorkerPtcFilesystem(name, args, worktree) {
  if (!['read', 'glob', 'grep'].includes(name)) return args
  const field = name === 'read' ? 'file_path' : 'path'
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw reject()
  const location = field === 'path' && args[field] === undefined ? '.' : args[field]
  const path = await resolvePtcWorktreePath(worktree, location)
  return { ...args, [field]: path }
}
