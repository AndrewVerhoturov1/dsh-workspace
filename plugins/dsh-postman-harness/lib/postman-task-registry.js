import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

// One row per exact Leader session. Writes finish on the backend before any
// Git, child-creation, or destructive runner operation is attempted.
export const POSTMAN_TASK_DOMAIN = defineDomain({
  name: 'postman_task_registry', version: 1,
  tables: { leaders: domainTable(z.object({
    leaderSessionId: z.string().min(1), repository: z.string(), repositoryPath: z.string(),
    originUrl: z.string(), baseCommit: z.string(), branch: z.string(), worktree: z.string(),
    stage: z.enum(['intent', 'worktree', 'ready', 'uncertain']),
    diagnostic: z.string().nullable(),
    worker: z.object({ id: z.string(), state: z.enum(['intent', 'ready', 'uncertain', 'stopping']),
      delivery: z.enum(['none', 'pending', 'unknown']),
      artifactRequests: z.array(z.string()) }).nullable(),
    runner: z.object({ state: z.enum(['none', 'running', 'failed', 'unknown', 'restoring']),
      requestId: z.string().nullable() }),
    bridge: z.object({ id: z.string(), state: z.enum(['pending', 'unknown']) }).nullable(),
  }).strict()) },
})

// Both Cordis entrypoints share this one ready promise. The owner closes the
// handle once; no second open is attempted while the service is mounted.
let shared = null
export function sharedPostmanTaskRegistry(storageDomain) {
  if (!shared) {
    const current = { ready: openPostmanTaskRegistry(storageDomain) }
    current.ready.catch(() => { if (shared === current) shared = null })
    shared = current
  }
  return shared.ready
}

export async function closeSharedPostmanTaskRegistry() {
  const current = shared
  if (!current) return
  shared = null
  const registry = await current.ready
  await registry.close()
}

export async function openPostmanTaskRegistry(storageDomain) {
  if (typeof storageDomain?.open !== 'function') throw new Error('POSTMAN_TASK_STORAGE_REQUIRED')
  const domain = await storageDomain.open(POSTMAN_TASK_DOMAIN)
  const table = domain.table('leaders')
  const creating = new Set()
  return {
    get: id => table.get(id) ?? null,
    entries: () => [...table.entries()],
    async create(id, record) {
      if (table.get(id) || creating.has(id)) throw new Error('POSTMAN_TASK_BINDING_EXISTS')
      creating.add(id)
      try { await table.put(id, record) } finally { creating.delete(id) }
    },
    change: (id, fn) => table.update(id, fn),
    close: () => domain.close(),
  }
}

// Explicitly injected in unit tests only. The production plugin never uses this
// implementation or silently falls back to it after an unavailable backend.
export function createMemoryTaskRegistry() {
  const records = new Map()
  return {
    get: id => records.get(id) ?? null,
    entries: () => [...records.entries()],
    async create(id, record) {
      if (records.has(id)) throw new Error('POSTMAN_TASK_BINDING_EXISTS')
      records.set(id, record)
    },
    async change(id, fn) {
      if (!records.has(id)) throw new Error('POSTMAN_TASK_BINDING_MISSING')
      const next = fn(records.get(id))
      records.set(id, next)
      return next
    },
    async close() {},
  }
}
