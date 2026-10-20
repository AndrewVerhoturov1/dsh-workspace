import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

// One row per exact Leader session. Writes finish on the backend before any
// Git, child-creation, or destructive runner operation is attempted.
const workerLifecycle = z.object({ version: z.literal(1),
  stop: z.object({ id: z.string(), mode: z.enum(['close', 'cancel']), cascade: z.boolean(),
    childIds: z.array(z.string()), requestedAt: z.string() }).optional(),
  admissions: z.array(z.object({ id: z.string(), state: z.enum(['pending', 'accepted']), messageId: z.string().nullable(), worktree: z.string().optional() })),
  reports: z.array(z.object({ childId: z.string(), turn: z.number(), callId: z.string(), messageId: z.string(), hostBudgetAfterSeq: z.number().int().nonnegative().optional() })),
})

export const POSTMAN_TASK_DOMAIN = defineDomain({
  name: 'postman_task_registry', version: 1,
  tables: { leaders: domainTable(z.preprocess(value => {
    // Existing v1 storage contains the removed team budget. Discard only its
    // fields so assignment budgets and unrelated strict row contracts survive.
    if (!value || typeof value !== 'object') return value
    const { objectives, ...row } = value
    const stripBudget = budget => {
      if (!budget || typeof budget !== 'object' || !Object.hasOwn(budget, 'rootObjectiveId')) return budget
      const { rootObjectiveId, ...assignment } = budget
      // A stored exhaustion caused by the old team cap is not assignment exhaustion.
      return { ...assignment, exhausted: assignment.used >= assignment.hardLimit }
    }
    const stripWorker = worker => {
      if (!worker || typeof worker !== 'object') return worker
      return { ...worker, ...(worker.budget ? { budget: stripBudget(worker.budget) } : {}),
        ...(worker.pendingBudgets ? { pendingBudgets: Object.fromEntries(Object.entries(worker.pendingBudgets).map(([id, budget]) => [id, stripBudget(budget)])) } : {}) }
    }
    if (row.workers) row.workers = Object.fromEntries(Object.entries(row.workers).map(([id, worker]) => [id, stripWorker(worker)]))
    if (Array.isArray(row.retiredWorkers)) row.retiredWorkers = row.retiredWorkers.map(stripWorker)
    return row
  }, z.object({
    leaderSessionId: z.string().min(1), repository: z.string(), repositoryPath: z.string(),
    originUrl: z.string(), baseCommit: z.string(), branch: z.string(), worktree: z.string(),
    bindingId: z.string().optional(),
    pullRequest: z.object({ number: z.number().int().positive(), url: z.string(), base: z.string() }).strict().optional(),
    resumedFrom: z.object({ leaderSessionId: z.string(), bindingId: z.string().optional() }).strict().optional(),
    // Optional for new universal project bindings. Historical v1 rows are not migrated.
    universalProject: z.literal(true).optional(),
    workspaceOnly: z.literal(true).optional(),
    // New explicit DSH selections keep their verified root across cold recovery.
    // Absent on historical v1 DSH bindings; no migration of pinned rows.
    selectedDshProject: z.literal(true).optional(),
    defaultBranch: z.string().min(1).optional(),
    baseSource: z.enum(['remote', 'cached', 'bootstrap']).optional(),
    devspaceReadOnly: z.boolean().optional(),
    stage: z.enum(['intent', 'worktree', 'ready', 'uncertain', 'closed']),
    diagnostic: z.string().nullable(),
    closedAt: z.string().optional(),
    abandoned: z.boolean().optional(),
    // Exact Worker retirement proof only, not external shell/app process death.
    workerRetirementProven: z.boolean().optional(),
    retiredTasks: z.array(z.unknown()).optional(),
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
        exhausted: z.boolean(), notified: z.boolean(), reported: z.boolean() }).optional(),
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
    appJobs: z.record(z.string(), z.object({ jobId: z.string(), workerSessionId: z.string(),
      assignmentId: z.string(), worktree: z.string(), port: z.number().int().min(1).max(65535).optional(),
      terminal: z.enum(['completed', 'killed']).optional(), replacedBy: z.string().optional() }).strict()).optional(),
    runner: z.object({ state: z.enum(['none', 'running', 'failed', 'unknown', 'restoring']),
      requestId: z.string().nullable() }),
    // Keep the legacy single marker readable; new jobs use individually keyed operations.
    bridge: z.object({ id: z.string(), state: z.enum(['pending', 'unknown']) }).nullable(),
    // Stage 2: one exact continuable communications Luna belongs to the Leader task.
    // Optional on disk so Stage-1 and historical v1 rows remain readable.
    devspaceLuna: z.object({
      childId: z.string().min(1), state: z.enum(['intent', 'ready', 'uncertain', 'closing', 'closed']),
      activeBridgeJobId: z.string().nullable().optional(),
      requestIds: z.array(z.string()).optional(),
      conversationRef: z.string().nullable().optional(),
    }).strict().optional(),
    // Optional on-disk lanes. Historical single devspaceLuna remains valid and
    // is adopted as lane "legacy" on the first new Devspace admission only.
    devspaceLanes: z.record(z.string(), z.object({
      childId: z.string().min(1).optional(),
      state: z.enum(['reserved', 'intent', 'ready', 'uncertain', 'closing', 'closed']),
      activeBridgeJobId: z.string().nullable().optional(),
      requestIds: z.array(z.string()).optional(),
      conversationRef: z.string().nullable().optional(),
    }).strict()).optional(),
    bridgeOperations: z.record(z.string(), z.object({
      state: z.enum(['pending', 'unknown', 'received']),
      phase: z.enum(['reserved', 'child-known', 'request-known', 'publication-known', 'terminal', 'not-sent', 'synchronized']).optional(),
      transportKind: z.enum(['artifact', 'text', 'image', 'devspace']).optional(),
      devspace: z.object({ mode: z.enum(['READ_ONLY', 'WRITE_TEST', 'WRITE_ISOLATED', 'WRITE_APPROVED_TARGET']), channel: z.string().optional(),
        laneId: z.string().optional(), approvedRoot: z.string().optional(),
        approvedAccess: z.enum(['read', 'write']).optional(),
        coldBellRecovery: z.enum(['intent']).optional(),
        coldReadyWake: z.enum(['intent', 'sent', 'unknown']).optional(),
        lateBellRecovery: z.enum(['intent']).optional(),
        payload: z.string().optional(), computerUse: z.enum(['allow', 'deny']).optional(),
        recovery: z.object({ rootJobId: z.string(), sourceJobId: z.string(), sourceRequestId: z.string().optional(),
          attempt: z.number().int().nonnegative(), freshConversation: z.boolean().optional(), isolated: z.boolean().optional() }).strict().optional(),
        recoveryRetired: z.boolean().optional(),
        hostFailure: z.object({status: z.string(), diagnostic: z.string().optional()}).strict().optional(),
        recoveryNextJobId: z.string().optional() }).strict().optional(),
      archivedAt: z.string().optional(), executionRevoked: z.boolean().optional(),
      lateTerminal: z.unknown().optional(), residualWriteRoot: z.string().optional(),
      writerSettlement: z.object({version: z.literal(1), source: z.literal('devspace_native_tree'),
        jobId: z.string(), requestId: z.string(), leaderSessionId: z.string(), branch: z.string(),
        writeRoot: z.string(), generation: z.string(), settledAt: z.string()}).strict().optional(),
      createdAt: z.string().optional(),
      childSessionId: z.string().optional(),
      requestId: z.string().optional(),
      publication: z.unknown().optional(),
      terminal: z.unknown().optional(),
      synchronization: z.enum(['pending', 'busy', 'failed', 'synchronized', 'not-required']).optional(),
      grantDiagnostic: z.string().optional(),
      cancellationRequested: z.boolean().optional(),
      // Trusted Host-only refusal before Luna/REQ/Send; retain through cold
      // JsonStorage rehydration so NOT_SENT does not consume DevSpace capacity.
      preSendFailure: z.literal('POSTMAN_DEVSPACE_WORKTREE_NOT_READY').optional(),
    })).optional(),
  }).strict())),
    // Same private ledger contract, independently addressable before any Git
    // task context is prepared. No repository document or new workspace.
    ledgers: domainTable(z.object({
      revision: z.number().int().nonnegative(), content: z.string(),
      updatedBy: z.string(),
    }).strict()),
  },
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
    const ledgerTable = domain.table('ledgers')
    const blankLedger = () => ({ revision: 0, content: '', updatedBy: '' })
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
    }
    const creating = new Set()
    return {
      get: id => table.get(id) ?? null,
      entries: () => [...table.entries()],
      readLedger: id => ledgerTable.get(id) ?? table.get(id)?.secretaryLedger ?? blankLedger(),
      async changeLedger(id, fn) {
        if (typeof id !== 'string' || !id) throw Error('POSTMAN_SECRETARY_LEDGER_OWNER_INVALID')
        if (ledgerTable.get(id)) return ledgerTable.update(id, fn)
        // Retain old leader-row journal once, including its original revision.
        return ledgerTable.put(id, fn(table.get(id)?.secretaryLedger ?? blankLedger()))
      },
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
      replace: (id, expected, record) => table.update(id, current => {
        if (JSON.stringify(current) !== JSON.stringify(expected)) throw Error('POSTMAN_TASK_BINDING_CHANGED')
        return { ...record, retiredTasks: [...(current.retiredTasks ?? []),
          Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'retiredTasks'))] }
      }),
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
  const records = new Map(), ledgers = new Map()
  const blankLedger = () => ({ revision: 0, content: '', updatedBy: '' })
  return {
    get: id => records.get(id) ?? null,
    entries: () => [...records.entries()],
    readLedger: id => ledgers.get(id) ?? records.get(id)?.secretaryLedger ?? blankLedger(),
    async changeLedger(id, fn) {
      const next = fn(this.readLedger(id))
      ledgers.set(id, next)
      return next
    },
    async create(id, record) {
      const previous = records.get(id)
      if (previous && previous.stage !== 'closed') throw new Error('POSTMAN_TASK_BINDING_EXISTS')
      records.set(id, { ...record, ...(previous ? { retiredTasks: [...(previous.retiredTasks ?? []),
        Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'retiredTasks'))] } : {}) })
    },
    async replace(id, expected, record) {
      const current = records.get(id)
      if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw Error('POSTMAN_TASK_BINDING_CHANGED')
      records.set(id, { ...record, retiredTasks: [...(current.retiredTasks ?? []),
        Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'retiredTasks'))] })
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
