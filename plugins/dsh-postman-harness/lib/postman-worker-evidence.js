// Accepted admission IDs and successful native report results must correlate with
// the complete current Worker execution, not just with the last Postman tool call.
const idOf = event => event?.data?.id
const reportOutput = call => {
  try {
    const args = typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments
    return typeof args?.output === 'string' && args.output.trim().length > 0
  } catch { return false }
}
const isSuccessful = result => result?.data?.message?.content?.[0]?.isError === false
const meaningful = event => event.type === 'assistant/message' &&
  event.data?.message?.content?.some(block => block.type === 'text' && block.text.trim())

export function workerEvidence(worker, child, leader) {
  const admissions = worker?.lifecycle?.version === 1 ? worker.lifecycle.admissions : null
  if (!Array.isArray(admissions) || !admissions.length || !Array.isArray(child?.session?.events) ||
      !Array.isArray(leader?.session?.events))
    return { ready: false, reason: 'assignment or durable history unavailable' }
  if (worker.delivery !== 'none' || worker.state !== 'ready' || admissions.some(a => a.state !== 'accepted'))
    return { ready: false, reason: 'admission uncertain or stopping' }
  if (child.status !== 'idle' || child.inbox?.hasPending)
    return { ready: false, reason: 'Worker active or inbox pending' }
  const assignmentIds = new Set(admissions.map(a => a.messageId))
  if (assignmentIds.size !== admissions.length || [...assignmentIds].some(id => typeof id !== 'string' || !id))
    return { ready: false, reason: 'admission identity missing' }
  const events = child.session.events, parentEvents = leader.session.events
  const turns = new Map(), consumed = new Set()
  let currentTurn
  for (const [position, event] of events.entries()) {
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      if (currentTurn !== undefined || turns.has(data.turn))
        return { ready: false, reason: 'overlapping or duplicated turn' }
      currentTurn = data.turn
      turns.set(data.turn, { consumed: new Set(), claimedAt: new Map(), calls: [], results: new Map(), actions: [] })
    } else if (event.type === 'turn/end') {
      if (currentTurn !== data.turn) return { ready: false, reason: 'unmatched turn end' }
      turns.get(data.turn).end = data.reason?.kind
      currentTurn = undefined
    } else if (event.type === 'user/message' && currentTurn !== undefined) {
      const id = idOf(event)
      const turn = turns.get(currentTurn)
      turn.consumed.add(id); turn.claimedAt.set(id, position)
      turn.actions.push({ type: 'input', position, id })
    } else if (event.type === 'tool/call') {
      const turn = turns.get(data.turn)
      if (!turn || currentTurn !== data.turn) return { ready: false, reason: 'tool call outside active turn' }
      turn.calls.push({ event, position })
      turn.actions.push({ type: 'call', position, id: data.callId })
    } else if (event.type === 'tool/result') {
      const turn = turns.get(data.turn)
      if (!turn || currentTurn !== data.turn || !data.message?.source?.callId)
        return { ready: false, reason: 'tool result outside active turn' }
      turn.results.set(data.message.source.callId, { event, position })
    } else if (meaningful(event) && currentTurn !== undefined) {
      turns.get(currentTurn).actions.push({ type: 'text', position })
    }
  }
  if (currentTurn !== undefined || !turns.size)
    return { ready: false, reason: 'Worker has an unclosed or missing turn' }
  const reports = worker.lifecycle.reports ?? []
  for (const [turnId, turn] of turns) {
    if (turn.end !== 'completed') return { ready: false, reason: 'Worker turn did not complete normally' }
    const assigned = [...turn.consumed].filter(id => assignmentIds.has(id))
    for (const id of assigned) consumed.add(id)
    // Every meaningful turn, including native followups outside Postman admissions,
    // needs its own final result after all work in that turn settled.
    if (!turn.actions.length) continue
    const valid = reports.some(report => {
      if (report.childId !== worker.id || report.turn !== turnId ||
          !parentEvents.some(event => event.type === 'user/message' && idOf(event) === report.messageId &&
            event.data?.source?.kind === 'subagent-report' &&
            event.data.source.senderSessionId === worker.id)) return false
      const call = turn.calls.find(item => item.event.data.callId === report.callId &&
        item.event.data.name === 'report' && reportOutput(item.event))
      const result = turn.results.get(report.callId)
      if (!call || !result || !isSuccessful(result.event) || result.position <= call.position ||
          assigned.some(id => turn.claimedAt.get(id) >= call.position)) return false
      // A report is final only if no meaningful content/input/call came afterward,
      // and ALL prior tool calls have settled before its actual result.
      // The installed driver may produce a text-only closing step after the
      // tool result. It has no new input or tool work and is not a replacement report.
      if (turn.actions.some(action => action.position > call.position && action.type !== 'text')) return false
      return turn.calls.every(item => item.event.data.callId === report.callId ||
        (turn.results.has(item.event.data.callId) &&
         turn.results.get(item.event.data.callId).position < call.position &&
         isSuccessful(turn.results.get(item.event.data.callId).event)))
    })
    if (!valid) return { ready: false, reason: 'current native final report not successfully delivered' }
  }
  if (consumed.size !== assignmentIds.size ||
      [...turns.values()].every(turn => !turn.actions.length))
    return { ready: false, reason: 'accepted assignment remains unclaimed' }
  return { ready: true, reason: 'all current turns completed with delivered native reports' }
}
