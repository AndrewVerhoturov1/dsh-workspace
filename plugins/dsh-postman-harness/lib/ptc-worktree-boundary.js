import { isAbsolute, resolve } from 'node:path'

const reject = () => new Error('PTC_FILESYSTEM_PATH_INVALID: invalid task worktree or filesystem path')

// Keep the task worktree as the relative-path base, not an access boundary.
// Absolute paths and links remain subject to ordinary DSH filesystem policy.
export async function resolvePtcWorktreePath(worktree, requested) {
  if (typeof worktree !== 'string' || !isAbsolute(worktree) ||
      typeof requested !== 'string' || !requested.trim() || requested.includes('\0') ||
      (!isAbsolute(requested) && /^[a-zA-Z]:/.test(requested))) throw reject()
  return resolve(worktree, requested)
}

// Only the actual filesystem-location fields in the installed DSH schemas are
// rewritten. Search patterns and web calls are not filesystem roots.
export async function guardWorkerPtcFilesystem(name, args, worktree) {
  if (!['read', 'glob', 'grep', 'write', 'edit'].includes(name)) return args
  const field = ['read', 'write', 'edit'].includes(name) ? 'file_path' : 'path'
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw reject()
  const location = field === 'path' && args[field] === undefined ? '.' : args[field]
  const path = await resolvePtcWorktreePath(worktree, location)
  return { ...args, [field]: path }
}
