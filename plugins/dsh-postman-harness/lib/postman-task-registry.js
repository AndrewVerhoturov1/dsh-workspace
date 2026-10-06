import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

// One row per exact Leader session. Writes finish on the backend before any
// Git, child-creation, or destructive runner operation is attempted.
const workerLifecycle = z.object({ version: z.literal(1),
  admissions: z.array(z.object({ id: z.string(), state: z.enum(['pending', 'accepted']), messageId: z.string().nullable() })),
  reports: z.array(z.object({ childId: z.string(), turn: z.number(), callId: z.string(), messageId: z.string(), hostBudgetAfterSeq: z.number().int().nonnegative().optional() })),
})

export const POSTMAN_TASK_DOMAIN = defineDomain({
  name: 'postman_task_registry', version: 1,
  tables: { leaders: domainTable(z.object({
    leaderSessionId: z.string().min(1), repository: z.string(), repositoryPath: z.string(),
    originUrl: z.string(), baseCommit: z.string(), branch: z.string(), worktree: z.string(),
    stage: z.enum(['intent', 'worktree', 'ready', 'uncertain', 'closed']),
    diagnostic: z.string().nullable(),
    closedAt: z.string().optional(),
    retiredTasks: z.array(z.unknown()).optional(),
    objectives: z.record(z.string(), z.object({ id: z.string(), ownerSessionId: z.string(),
      objective: z.string(), used: z.number().int().nonnegative(), cap: z.literal(48) }).strict()).optional(),
    // Optional on disk so v1 rows can be validated before their in-place migration.
    worker: z.object({ id: z.string().min(1), state: z.enum(['intent', 'ready', 'uncertain', 'stopping']),
      delivery: z.enum(['none', 'pending', 'unknown']),
      artifactRequests: z.array(z.string()),
      lifecycle: workerLifecycle.optional() }).nullable().optional(),
    workers: z.record(z.string(), z.object({
      id: z.string(), label: z.string(), workerType: z.enum(['luna', 'sol', 'secretary']).optional(), ownerSessionId: z.string().optional(),
      pendingBudgets: z.record(z.string(), z.unknown()).optional(),
      budget: z.object({ assignmentId: z.string(), task: z.string(), used: z.number().int().nonnegative(),
        softLimit: z.number().int().positive(), hardLimit: z.number().int().positive(),
        exhausted: z.boolean(), notified: z.boolean(), reported: z.boolean(),
        rootObjectiveId: z.string().optional() }).optional(),
      state: z.enum(['intent', 'ready', 'uncertain', 'stopping']),
      delivery: z.enum(['none', 'pending', 'unknown']),
      artifactRequests: z.array(z.string()), lifecycle: workerLifecycle.optional(),
    })).optional(),
    secretaryLedger: z.object({ revision: z.number().int().nonnegative(), content: z.string(), updatedBy: z.string() }).optional(),
    // Retired bindings are audit only, never quota/authority.
    retiredWorkers: z.array(z.unknown()).optional(),
    // Leader-owned authority survives Worker retirement and Bridge journal cleanup.
    artifactGrants: z.record(z.string(), z.object({
      requestId: z.string(), repository: z.string(), resultZip: z.string(),
      sha256: z.string(), expectedFilename: z.string(),
    }).strict()).optional(),
    runner: z.object({ state: z.enum(['none', 'running', 'failed', 'unknown', 'restoring']),
      requestId: z.string().nullable() }),
    // Keep the legacy single marker readable; new jobs use individually keyed operations.
    bridge: z.object({ id: z.string(), state: z.enum(['pending', 'unknown']) }).nullable(),
    bridgeOperations: z.record(z.string(), z.object({
      state: z.enum(['pending', 'unknown', 'received']),
      phase: z.enum(['reserved', 'child-known', 'request-known', 'publication-known', 'terminal', 'not-sent', 'synchronized']).optional(),
      transportKind: z.enum(['artifact', 'text', 'image']).optional(),
      createdAt: z.string().optional(),
      childSessionId: z.string().optional(),
      requestId: z.string().optional(),
      publication: z.unknown().optional(),
      terminal: z.unknown().optional(),
      synchronization: z.enum(['pending', 'busy', 'failed', 'synchronized', 'not-required']).optional(),
      grantDiagnostic: z.string().optional(),
      cancellationRequested: z.boolean().optional(),
    })).optional(),
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
  try {
    const table = domain.table('leaders')
    // DomainFacility has no migration hook: open v1 once with a compatible schema,
    // then durably normalize each row before exposing the registry to callers.
    for (const [id, row] of table.entries()) {
      if (row.worker !== undefined && row.workers !== undefined)
        throw new Error('POSTMAN_TASK_WORKER_MIGRATION_CONFLICT: ' + id)
      if (row.worker !== undefined || row.workers === undefined) await table.update(id, current => {
        const { worker, ...rest } = current
        return { ...rest, workers: worker ? { [worker.id]: { ...worker, label: worker.id } } : {} }
      })
      const workers = table.get(id)?.workers
      if (!workers || Object.entries(workers).some(([key, value]) => key !== value.id))
        throw new Error('POSTMAN_TASK_WORKER_BINDING_INVALID: ' + id)
      if ([...Object.values(workers), ...(table.get(id).retiredWorkers ?? [])].some(worker => worker.workerType !== 'sol' && !worker.budget?.rootObjectiveId))
        await table.update(id, current => {
          const objectives = { ...(current.objectives ?? {}) }, migrated = { ...current.workers }, retired = [...(current.retiredWorkers ?? [])]
          for (const worker of [...Object.values(migrated), ...retired]) {
            if (worker.workerType === 'sol' || worker.budget?.rootObjectiveId) continue
            const ownerSessionId = worker.ownerSessionId ?? id, rootId = 'legacy:' + ownerSessionId
            // Previous assignment costs were not recorded cumulatively. Refuse
            // refinancing when the old audit cannot prove a remaining allowance.
            const history = [...Object.values(current.workers), ...(current.retiredWorkers ?? [])]
              .filter(w => (w.ownerSessionId ?? id) === ownerSessionId && w.workerType !== 'sol')
            const unknown = history.some(w => !w.budget || (w.lifecycle?.admissions?.length ?? 0) > 1)
            const used = Math.min(48, unknown ? 48 : history.reduce((sum, w) => sum + w.budget.used, 0))
            objectives[rootId] ??= { id: rootId, ownerSessionId, objective: 'Legacy unresolved objective', used, cap: 48 }
            const next = { ...worker,
              ...(worker.budget ? { budget: { ...worker.budget, rootObjectiveId: rootId } } : {}),
              ...(worker.pendingBudgets ? { pendingBudgets: Object.fromEntries(Object.entries(worker.pendingBudgets).map(([key, b]) => [key, { ...b, rootObjectiveId: rootId }])) } : {}) }
            if (Object.hasOwn(migrated, worker.id)) migrated[worker.id] = next
            else retired[retired.indexOf(worker)] = next
          }
          return { ...current, workers: migrated, ...(current.retiredWorkers ? { retiredWorkers: retired } : {}), objectives }
        })
    }
    const creating = new Set()
    return {
      get: id => table.get(id) ?? null,
      entries: () => [...table.entries()],
      async create(id, record) {
        if ((table.get(id) && table.get(id).stage !== 'closed') || creating.has(id)) throw new Error('POSTMAN_TASK_BINDING_EXISTS')
        creating.add(id)
        if (record.worker !== undefined && record.workers !== undefined)
          throw new Error('POSTMAN_TASK_WORKER_MIGRATION_CONFLICT')
        const { worker, ...rest } = record
        try {
          const previous = table.get(id)
          await table.put(id, { ...rest, ...(previous ? { retiredTasks: [...(previous.retiredTasks ?? []),
            Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'retiredTasks'))] } : {}), workers: rest.workers ??
          (worker ? { [worker.id]: { ...worker, label: worker.id } } : {}) })
        } finally { creating.delete(id) }
      },
      change: (id, fn) => table.update(id, current => {
        // A partial transform must not drop unrelated row fields or the workers map.
        const next = fn(current)
        if (next.worker !== undefined) throw new Error('POSTMAN_TASK_LEGACY_WORKER_WRITE_REJECTED')
        const merged = { ...current, ...next, workers: next.workers ?? current.workers }
        if (Object.entries(merged.workers).some(([key, value]) => key !== value.id))
          throw new Error('POSTMAN_TASK_WORKER_BINDING_INVALID')
        return merged
      }),
      close: () => domain.close(),
    }
  } catch (error) {
    await domain.close()
    throw error
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
      const previous = records.get(id)
      if (previous && previous.stage !== 'closed') throw new Error('POSTMAN_TASK_BINDING_EXISTS')
      records.set(id, { ...record, ...(previous ? { retiredTasks: [...(previous.retiredTasks ?? []),
        Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'retiredTasks'))] } : {}) })
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
