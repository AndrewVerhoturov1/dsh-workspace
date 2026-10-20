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
  return {
    run(job, message, parent) {
      return get(parent.id, laneFromJob(job)).run(job, message, parent)
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
        lanes: details, capacity: { used: details.filter(v => v.runtimeActive).length, limit: 3 } }
    },
    async close(parent, taskContext, laneId) {
      if (ctx.agents?.get(parent?.id) !== parent ||
          taskContext?.leaderSessionId && taskContext.leaderSessionId !== parent.id)
        return { status: 'POSTMAN_DEVSPACE_LUNA_CALLER_REJECTED' }
      const ids = laneId ? [laneId] : laneIds(record(parent.id))
      if (!ids.length) return legacy.close(parent, taskContext)
      const results = []
      for (const id of ids) {
        const lane = laneOf(record(parent.id), id)
        if (!lane) return { status: 'POSTMAN_DEVSPACE_LUNA_LANE_NOT_FOUND' }
        if (lane.state === 'closed') continue
        if (!lane.childId) {
          await contexts.changeRecord(parent.id, row => ({ ...row, devspaceLanes: {
            ...row.devspaceLanes, [id]: { ...laneOf(row, id), state: 'closed', activeBridgeJobId: null } } }))
          results.push({ laneId: id, status: 'POSTMAN_DEVSPACE_LUNA_CLOSED' })
        } else results.push({ laneId: id, ...await get(parent.id, id).close(parent, taskContext) })
      }
      return { status: results.every(v => v.status === 'POSTMAN_DEVSPACE_LUNA_CLOSED')
        ? 'POSTMAN_DEVSPACE_LUNA_CLOSED' : 'POSTMAN_DEVSPACE_LUNA_CLOSE_UNKNOWN', results }
    },
  }
}
