// Only native report calls whose accepted message entered the Leader's model context
// can complete an assignment. A settlement notice or notify_parent cannot.
const idOf = event => event?.data?.id
const reportOutput = call => {
  try {
    const args = typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments
    return typeof args?.output === 'string' && args.output.trim().length > 0
  } catch { return false }
}

export function workerEvidence(worker, child, leader) {
  const admissions = worker?.lifecycle?.version === 1 ? worker.lifecycle.admissions : null
  if (!Array.isArray(admissions) || admissions.length === 0 || !child?.session?.events || !leader?.session?.events)
    return { ready: false, reason: 'assignment or live history unavailable' }
  if (worker.delivery !== 'none' || worker.state !== 'ready' || admissions.some(a => a.state !== 'accepted'))
    return { ready: false, reason: 'admission uncertain or stopping' }
  const events = child.session.events
  const parentEvents = leader.session.events
  const turns = new Map()
  let currentTurn
  for (const [position, event] of events.entries()) {
    if (event.type === 'turn/start') {
      currentTurn = event.data.turn
      turns.set(currentTurn, { started: true, consumed: new Set(), claimedAt: new Map(), calls: [], results: new Map() })
    } else if (event.type === 'user/message' && currentTurn !== undefined) {
      turns.get(currentTurn)?.consumed.add(idOf(event))
      turns.get(currentTurn)?.claimedAt.set(idOf(event), position)
    } else if (event.type === 'tool/call') {
      turns.get(event.data.turn)?.calls.push({ ...event, position })
    } else if (event.type === 'tool/result') {
      turns.get(event.data.turn)?.results.set(event.data.message?.callId, event)
    } else if (event.type === 'turn/end') {
      if (turns.has(event.data.turn)) turns.get(event.data.turn).end = event.data.reason?.kind
      if (currentTurn === event.data.turn) currentTurn = undefined
    }
  }
  if (currentTurn !== undefined || child.status !== 'idle' || child.inbox?.hasPending)
    return { ready: false, reason: 'Worker has an active or unclosed turn' }
  const reports = worker.lifecycle.reports ?? []
  const assignmentIds = new Set(admissions.map(a => a.messageId))
  if (assignmentIds.size !== admissions.length || [...assignmentIds].some(id => typeof id !== 'string' || !id))
    return { ready: false, reason: 'admission identity missing' }
  const consumed = new Set()
  for (const [turnId, turn] of turns) {
    const assigned = [...turn.consumed].filter(id => assignmentIds.has(id))
    if (!assigned.length) continue
    for (const id of assigned) consumed.add(id)
    if (turn.end !== 'completed') return { ready: false, reason: 'assignment turn not completed' }
    const matching = reports.filter(report => report.turn === turnId && report.childId === worker.id &&
      typeof report.messageId === 'string' && report.messageId &&
      parentEvents.some(event => event.type === 'user/message' && idOf(event) === report.messageId))
    const final = matching.find(report => {
      const index = turn.calls.findIndex(call => call.data.callId === report.callId && call.data.name === 'report' &&
        reportOutput(call))
      return index >= 0 && assigned.every(id => turn.claimedAt.get(id) < turn.calls[index].position) &&
        turn.calls.slice(index + 1).length === 0 &&
        turn.results.has(report.callId) && !turn.results.get(report.callId).data.message?.isError
    })
    if (!final) return { ready: false, reason: 'native final report not included in Leader context' }
  }
  if (consumed.size !== assignmentIds.size) return { ready: false, reason: 'accepted assignment remains unclaimed' }
  const lastTurn = [...turns.values()].at(-1)
  if (!lastTurn || lastTurn.end !== 'completed' || ![...lastTurn.calls].at(-1) ||
      lastTurn.calls.at(-1).data.name !== 'report')
    return { ready: false, reason: 'subsequent work has no current final report' }
  return { ready: true, reason: 'completed assignments and delivered native reports' }
}
