import { resolve } from 'node:path'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { inspectDevspaceRuntime } from './postman-writer-proof.js'

// The historical module name remains; these are ownership records, not Git tasks.
export function createPostmanTaskContexts({ registry = createMemoryTaskRegistry(), writerControlFile } = {}) {
  const owners = new Map(), children = new Map(), creating = new Map(), listeners = new Set()
  const changed = id => { for (const listener of listeners) listener(id) }
  const record = id => registry.get(id)
  function get(id) {
    if (owners.has(id)) return owners.get(id)
    const row = record(id)
    if (!row) return null
    const cwd = row.cwd ?? process.cwd()
    const owner = Object.freeze({ leaderSessionId: id, worktree: cwd, cwd, workspaceOnly: true })
    owners.set(id, owner)
    return owner
  }
  async function ensure(leader) {
    const id = leader.id
    if (creating.has(id)) return creating.get(id)
    const pending = (async () => {
      const cwd = resolve(leader.session?.header?.cwd ?? process.cwd())
      if (!record(id)) await registry.create(id, { leaderSessionId: id, cwd, workers: {} })
      if (owners.get(id)?.cwd !== cwd) owners.set(id, Object.freeze({ leaderSessionId: id, cwd, worktree: cwd, workspaceOnly: true }))
      return owners.get(id)
    })()
    creating.set(id, pending)
    try { return await pending } finally { creating.delete(id) }
  }
  async function changeRecord(id, fn) {
    const result = await registry.change(id, fn)
    changed(id)
    return result
  }
  function bindChild(leaderId, childId, bridgeJobId) {
    if (!get(leaderId) || children.has(childId)) return false
    children.set(childId, { leaderId, bridgeJobId })
    return true
  }
  function child(childId) { return get(children.get(childId)?.leaderId) }
  function devspaceBinding(childId) {
    const bound = children.get(childId)
    if (!bound) return null
    const op = record(bound.leaderId)?.bridgeOperations?.[bound.bridgeJobId]
    if (op?.transportKind !== 'devspace' || op.executionRevoked || op.childSessionId !== childId || !op.devspace) return null
    return { bridgeJobId: bound.bridgeJobId, leaderSessionId: bound.leaderId, lunaSessionId: childId,
      worktree: get(bound.leaderId).worktree, workspaceOnly: true, mode: op.devspace.mode }
  }
  async function recordBridgeRequest(childId, requestId, channel) {
    const bound = children.get(childId)
    if (!bound) throw Error('POSTMAN_BRIDGE_REQUEST_OWNER_MISSING')
    await changeRecord(bound.leaderId, row => {
      const op = row.bridgeOperations?.[bound.bridgeJobId]
      if (!op || op.executionRevoked || op.childSessionId !== childId || op.requestId && op.requestId !== requestId)
        throw Error('POSTMAN_BRIDGE_REQUEST_OWNER_CHANGED')
      return { ...row, bridgeOperations: { ...row.bridgeOperations, [bound.bridgeJobId]: {
        ...op, requestId, phase: 'request-known', ...(channel && op.transportKind === 'devspace' ?
          { devspace: { ...op.devspace, channel } } : {}) } } }
    })
  }
  return { ensure, get, record, records: () => registry.entries(), changeRecord,
    onContextChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    readLedger: id => registry.readLedger(id), changeLedger: (id, fn) => registry.changeLedger(id, fn),
    bindChild, child, devspaceBinding, recordBridgeRequest, releaseChild: id => children.delete(id),
    inspectDevspaceRuntime: () => inspectDevspaceRuntime({ controlFile: writerControlFile }),
    dispose() { owners.clear(); children.clear(); listeners.clear(); creating.clear() } }
}

let sharedContexts = null
export function initializePostmanTaskContexts(registry, options = {}) {
  return sharedContexts ??= createPostmanTaskContexts({ registry, ...options })
}
export function releasePostmanTaskContexts(contexts) {
  if (sharedContexts === contexts) { contexts.dispose(); sharedContexts = null }
}
export const postmanTaskContexts = new Proxy({}, { get: (_target, key) => {
  if (!sharedContexts) throw Error('POSTMAN_TASK_STORAGE_REQUIRED')
  return sharedContexts[key]
} })
