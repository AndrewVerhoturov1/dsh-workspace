import { createPostmanDevspaceLuna } from './postman-devspace-luna.js'

/**
 * Three independent continuable communications lanes for one Leader.
 *
 * Reuse the battle-tested single-Luna protocol through a registry projection:
 * each instance only sees its own devspaceLuna row and keeps its own active
 * job guard; all operation/REQ updates remain atomic in the original registry.
 * No second scheduler, no browser/control side channel, no legacy migration.
 */
export function createPostmanDevspaceLanes(ctx, contexts, direct) {
  const instances = new Map()
  const legacy = createPostmanDevspaceLuna(ctx, contexts, direct)
  const record = leaderId => contexts?.record?.(leaderId)
  const laneOf = (row, laneId) => row?.devspaceLanes?.[laneId] ??
    (laneId === 'legacy' ? row?.devspaceLuna : undefined)
  const laneIds = row => [...new Set([
    ...Object.keys(row?.devspaceLanes ?? {}),
    ...(row?.devspaceLuna && !row?.devspaceLanes?.legacy ? ['legacy'] : []),
  ])]
  const keyOf = (leaderId, laneId) => leaderId + ':' + laneId
  function get(leaderId, laneId) {
    if (!laneId) return legacy
    const key = keyOf(leaderId, laneId)
    if (instances.has(key)) return instances.get(key)
    // Production postmanTaskContexts is an accessor-only Proxy: object spread
    // contributes no own properties. Preserve the methods required by the
    // underlying Luna, even when a fixture object spread happened to work.
    const adapted = {
      get: id => contexts.get(id),
      verifyWorktree: contexts.verifyWorktree?.bind(contexts),
      record(id) {
        const row = record(id)
        return row ? { ...row, devspaceLuna: laneOf(row, laneId) } : row
      },
      changeRecord(id, change) {
        return contexts.changeRecord(id, row => {
          const current = laneOf(row, laneId)
          if (!current) throw Error('POSTMAN_DEVSPACE_LANE_UNKNOWN')
          const projected = { ...row, devspaceLuna: current }
          const next = change(projected)
          // Never rewrite the historical single-Luna record while updating
          // a new lane; Bridge journal and other Leader fields remain current.
          return { ...next, devspaceLuna: row.devspaceLuna,
            devspaceLanes: { ...row.devspaceLanes,
              [laneId]: next.devspaceLuna } }
        })
      },
    }
    const instance = createPostmanDevspaceLuna(ctx, adapted, direct)
    instances.set(key, instance)
    return instance
  }
  function laneFromJob(job) {
    return job?.laneId ?? record(job?.parentSessionId)?.bridgeOperations?.[job?.bridgeJobId]?.devspace?.laneId
  }
  // A durable "reserved" row means no Luna child was created. Only an
  // unknown, pre-child/pre-REQ intent with no private channel or conversation
  // can be retired without risking an unobserved ChatGPT Send.
  function neverStarted(row, laneId) {
    const lane = laneOf(row, laneId)
    const operation = row?.bridgeOperations?.[lane?.activeBridgeJobId]
    return lane?.state === 'reserved' && typeof lane.activeBridgeJobId === 'string' &&
      !lane.childId && !lane.conversationRef && (lane.requestIds?.length ?? 0) === 0 &&
      operation?.transportKind === 'devspace' && operation?.devspace?.laneId === laneId &&
      operation.state === 'unknown' && operation.phase === 'reserved' &&
      !operation.requestId && !operation.childSessionId && !operation.devspace?.channel &&
      !operation.terminal && !operation.devspace?.coldBellRecovery
  }
  async function retireNeverStarted(parent, taskContext, laneId) {
    if (ctx.agents?.get(parent?.id) !== parent ||
        contexts?.get(parent.id) !== taskContext)
      return { status: 'POSTMAN_DEVSPACE_LUNA_CALLER_REJECTED' }
    const original = record(parent.id)
    if (!neverStarted(original, laneId))
      return { status: 'POSTMAN_DEVSPACE_LUNA_BUSY' }
    const bridgeJobId = laneOf(original, laneId).activeBridgeJobId
    try {
      await contexts.changeRecord(parent.id, row => {
        if (!neverStarted(row, laneId) ||
            laneOf(row, laneId).activeBridgeJobId !== bridgeJobId)
          throw Error('POSTMAN_DEVSPACE_NEVER_STARTED_CHANGED')
        const current = row.bridgeOperations[bridgeJobId]
        return { ...row,
          devspaceLanes: { ...row.devspaceLanes,
            [laneId]: { ...row.devspaceLanes[laneId],
              state: 'closed', activeBridgeJobId: null } },
          bridgeOperations: { ...row.bridgeOperations,
            [bridgeJobId]: { ...current, state: 'received', phase: 'not-sent',
              synchronization: 'not-required', cancellationRequested: true } },
        }
      })
    } catch { return { status: 'POSTMAN_DEVSPACE_LUNA_CLOSE_UNKNOWN' } }
    return { status: 'POSTMAN_DEVSPACE_LUNA_CLOSED', laneId, bridgeJobId,
      requestId: null, diagnostic: 'POSTMAN_DEVSPACE_NEVER_STARTED' }
  }
  return {
    run(job, message, parent) {
      return get(parent.id, laneFromJob(job)).run(job, message, parent)
    },
    recoverColdBell(parent, bridgeJobId) {
      const laneId = record(parent?.id)?.bridgeOperations?.[bridgeJobId]?.devspace?.laneId
      return get(parent?.id, laneId).recoverColdBell(parent, bridgeJobId)
    },
    upgradeLateBell(parent, job) {
      return get(parent?.id, laneFromJob(job)).upgradeLateBell(parent, job)
    },
    snapshot(parent) {
      const row = record(parent?.id)
      if (!row) return null
      const details = laneIds(row).map(laneId => {
        const value = get(parent.id, laneId).snapshot(parent)
        return value ? { laneId, ...value } : null
      }).filter(Boolean)
      if (!details.length) return legacy.snapshot(parent)
      return { ...(details.length === 1 ? details[0] : {}),
        lanes: details, capacity: { used: details.filter(v => v.state !== 'closed').length, limit: 3 } }
    },
    async close(parent, taskContext, laneId) {
      if (ctx.agents?.get(parent?.id) !== parent ||
          contexts?.get(parent?.id) !== taskContext)
        return { status: 'POSTMAN_DEVSPACE_LUNA_CALLER_REJECTED' }
      if (laneId) {
        if (!laneOf(record(parent.id), laneId))
          return { status: 'POSTMAN_DEVSPACE_LUNA_LANE_NOT_FOUND' }
        return neverStarted(record(parent.id), laneId)
          ? retireNeverStarted(parent, taskContext, laneId)
          : get(parent.id, laneId).close(parent, taskContext)
      }
      const ids = laneIds(record(parent.id))
      if (!ids.length) return legacy.close(parent, taskContext)
      // Never partially close while another lane has a live child or an
      // ambiguous/unproved REQ. Only no-side-effect reservations are exempt.
      if (ids.some(id => {
        const row = laneOf(record(parent.id), id)
        return row?.state !== 'closed' &&
          !neverStarted(record(parent.id), id) &&
          (row?.state !== 'ready' || row?.activeBridgeJobId)
      })) return { status: 'POSTMAN_DEVSPACE_LUNA_BUSY' }
      const results = []
      for (const id of ids) {
        if (laneOf(record(parent.id), id)?.state === 'closed') continue
        const outcome = neverStarted(record(parent.id), id)
          ? await retireNeverStarted(parent, taskContext, id)
          : await get(parent.id, id).close(parent, taskContext)
        results.push({ laneId: id, ...outcome })
        if (outcome.status !== 'POSTMAN_DEVSPACE_LUNA_CLOSED') return {
          status: 'POSTMAN_DEVSPACE_LUNA_CLOSE_UNKNOWN', results }
      }
      return { status: 'POSTMAN_DEVSPACE_LUNA_CLOSED', results }
    },
  }
}
