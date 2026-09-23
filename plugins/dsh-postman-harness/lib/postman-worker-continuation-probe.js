import { randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { postmanWorkerScopeProbeCallerAllowed, POSTMAN_BRIDGE_TOOL_NAME, POSTMAN_WORKER_SCOPE_PROBE_TOOL_NAME } from './postman-bridge-core.js'

const TIMEOUT_MS = 120_000
const MODEL = { provider: 'codex', model: 'gpt-5.6-luna' }
const NOT_PROVEN = 'CONTINUABLE_SPAWN_NOT_PROVEN'

function diagnostic(error) {
  const text = String(error?.message ?? error ?? 'unknown error')
  return text.length <= 512 ? text : text.slice(0, 509) + '...'
}

function toolsOf(ctx, agent) {
  return ctx.tools.schemas(agent).map(tool => tool.name).sort()
}

function turnEvents(session, turn) {
  return session.events.filter(event => event.data?.turn === turn)
}

// The continuable API acknowledges inbox admission, not turn completion. Observe
// committed Session events rather than a timer or the one-shot SubagentRun.result.
export async function runPostmanWorkerContinuationProbe(ctx, exec) {
  const parent = exec?.agent
  if (!postmanWorkerScopeProbeCallerAllowed(parent)) {
    return { status: 'POSTMAN_WORKER_CONTINUATION_PROBE_CALLER_REJECTED', verdict: NOT_PROVEN }
  }
  const cwd = parent.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return { status: 'POSTMAN_WORKER_CONTINUATION_PROBE_CWD_REQUIRED', verdict: NOT_PROVEN }
  }
  const parentTools = toolsOf(ctx, parent)
  const forbidden = ['write', 'edit', 'pwsh', 'bash', 'subagent', 'subagent_fork', 'workflow', 'todo_write']
    .filter(name => ctx.tools.get(name, parent) !== undefined)
  if (forbidden.length || ctx.tools.get(POSTMAN_WORKER_SCOPE_PROBE_TOOL_NAME, parent) === undefined) {
    return { status: 'POSTMAN_WORKER_CONTINUATION_PROBE_PARENT_BOUNDARY_FAILED', verdict: NOT_PROVEN,
      parent: { tools: parentTools, writeVisible: forbidden.includes('write'), forbidden } }
  }

  const childId = randomUUID() // reserved exact SessionId, before any event can arrive
  const secret = 'CONTINUATION_SECRET:' + randomUUID()
  const markerName = '.postman-worker-continuation-probe-' + randomUUID() + '.txt'
  const markerAbsolute = resolve(cwd, markerName)
  const expected = Buffer.from('CONTINUATION_OK:' + secret, 'utf8')
  const firstText = 'Remember this secret for my next turn: ' + secret +
    '. Do not write it to a file, do not look for it in your persona, and finish this turn with a short acknowledgement.'
  const secondText = 'Use the secret I gave you in the previous turn. Call write with file_path=' + JSON.stringify(markerName) +
    ' and content equal to the exact string CONTINUATION_OK: followed immediately by that secret. Do not ask me to repeat it.'
  const turns = { firstAccepted: false, firstCompleted: false, secondAccepted: false,
    secondCompleted: false, sameChildSession: false, secretRepeatedInSecondTurn: secondText.includes(secret),
    childResidentAfterFirst: false, firstMessageId: null, secondMessageId: null }
  const childEvidence = { sessionId: childId, tools: [], toolsAfterFirst: [], toolsSecondTurn: [], writeVisible: false,
    postmanBridgeVisible: false, scopeProbeVisible: false, parentSession: null,
    origin: null, delegationDepth: null, provider: MODEL.provider, model: MODEL.model }
  const cleanupErrors = []
  let drainCompleted = false
  let markerRemoved = false
  let firstTurn
  let secondTurn
  let child
  let accepted
  let followupStarted = false
  let failure
  let markerExact = false
  let writeCalled = false
  let writeSucceeded = false
  let firstTurnWrote = false
  let leakedSecretIntoSecond = false
  let secondTurnSessionId = null
  let secondSentToSameAgent = false
  let settled = false
  let complete
  const completion = new Promise(resolve => { complete = resolve })
  const finish = error => {
    if (settled) return
    settled = true
    failure = error
    complete()
  }
  // Exactly one followup, initiated on the committed end of the first turn,
  // before the runtime's automatic quiescence/disposal watcher can settle it.
  const onEvent = (session, event) => {
    if (session.id !== childId || settled) return
    if (child === undefined) child = ctx.agents.get(childId)
    if (event.type === 'turn/start') {
      if (firstTurn === undefined) firstTurn = event.data.turn
      else if (event.data.turn !== firstTurn) {
        secondTurn = event.data.turn
        secondTurnSessionId = session.id
        if (ctx.agents.get(childId) === child) {
          childEvidence.toolsSecondTurn = toolsOf(ctx, child)
          childEvidence.postmanBridgeVisible ||= ctx.tools.get(POSTMAN_BRIDGE_TOOL_NAME, child) !== undefined
          childEvidence.scopeProbeVisible ||= ctx.tools.get(POSTMAN_WORKER_SCOPE_PROBE_TOOL_NAME, child) !== undefined
        }
      }
    }
    if (event.type !== 'turn/end') return
    if (event.data.turn === firstTurn) {
      turns.firstCompleted = event.data.reason?.kind === 'completed'
      if (!turns.firstCompleted) return finish('first turn did not complete')
      if (followupStarted) return finish('duplicate first-turn completion')
      followupStarted = true
      turns.childResidentAfterFirst = ctx.agents.get(childId) === child
      if (turns.childResidentAfterFirst) childEvidence.toolsAfterFirst = toolsOf(ctx, child)
      if (!turns.childResidentAfterFirst) return finish('child disposed before continuation')
      // followup() is the official inbox delivery; the saved first-turn context
      // is never repeated in this second message or the child persona.
      void ctx.subagents.followup(parent, childId, [{ type: 'text', text: secondText }], {
        source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }, signal: exec.signal,
      }).then(messageId => {
        turns.secondMessageId = String(messageId)
        turns.secondAccepted = true
        secondSentToSameAgent = ctx.agents.get(childId) === child
      }, error => finish('followup failed: ' + diagnostic(error)))
    } else if (event.data.turn === secondTurn) {
      turns.secondCompleted = event.data.reason?.kind === 'completed'
      finish(turns.secondCompleted ? undefined : 'second turn did not complete')
    }
  }
  const disposeEvent = ctx.on('session/event', onEvent)
  const timeout = setTimeout(() => finish('turn completion timed out'), TIMEOUT_MS)
  const onAbort = () => finish('caller aborted')
  exec.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    accepted = await ctx.subagents.startContinuable({
      provider: 'spawn', label: 'Postman Worker Continuation Probe', childId,
      signal: exec.signal,
      request: {
        parent, maxDepth: 1, agentOptions: MODEL, toolFilter: { allow: ['write'] },
        persona: 'You are a two-turn memory probe. In the first turn remember the user secret without writing it. In the second turn call write exactly once with the requested path and content. Do not invent or ask for a secret. You have only the write tool.',
        prompt: [{ type: 'text', text: firstText }],
      },
    })
    turns.firstAccepted = !!accepted.messageId && String(accepted.childId) === childId
    turns.firstMessageId = String(accepted.messageId)
    child ??= ctx.agents.get(childId)
    if (!turns.firstAccepted || child === undefined) throw new Error('continuable child unavailable after admission')
    childEvidence.tools = toolsOf(ctx, child)
    childEvidence.writeVisible = ctx.tools.get('write', child) !== undefined
    childEvidence.postmanBridgeVisible = ctx.tools.get(POSTMAN_BRIDGE_TOOL_NAME, child) !== undefined
    childEvidence.scopeProbeVisible = ctx.tools.get(POSTMAN_WORKER_SCOPE_PROBE_TOOL_NAME, child) !== undefined
    const header = child.session?.header ?? {}
    childEvidence.parentSession = header.parentSession ?? null
    childEvidence.origin = header.origin ?? null
    childEvidence.delegationDepth = header.delegationDepth ?? null
    await completion
    if (failure) throw new Error(failure)
    const events = child.session.events
    const firstEvents = turnEvents(child.session, firstTurn)
    const secondEvents = turnEvents(child.session, secondTurn)
    firstTurnWrote = firstEvents.some(event => event.type === 'tool/call' && event.data.name === 'write')
    const writeCalls = secondEvents.filter(event => event.type === 'tool/call' && event.data.name === 'write')
    writeCalled = writeCalls.length === 1
    writeSucceeded = writeCalled && secondEvents.some(event => event.type === 'tool/result' &&
      event.data.message?.source?.callId === writeCalls[0].data.callId && !event.data.message.content[0].isError)
    leakedSecretIntoSecond = secondEvents.some(event => event.type === 'user/message' &&
      event.data?.content?.some(block => block.type === 'text' && block.text.includes(secret)))
    const firstRecorded = events.filter(event => event.type === 'user/message' &&
      event.data?.id === accepted.messageId && event.data.content?.[0]?.text === firstText).length === 1
    const secondRecorded = events.filter(event => event.type === 'user/message' &&
      event.data?.id === turns.secondMessageId && event.data.content?.[0]?.text === secondText).length === 1
    turns.sameChildSession = String(accepted.childId) === childId && child.id === childId && secondTurnSessionId === childId &&
      secondSentToSameAgent && firstRecorded && secondRecorded
    const actual = await readFile(markerAbsolute)
    markerExact = actual.equals(expected)
  } catch (error) {
    failure = diagnostic(error)
  } finally {
    clearTimeout(timeout)
    exec.signal?.removeEventListener('abort', onAbort)
    disposeEvent()
    if (accepted) {
      await ctx.subagents.drainContinuableChildren(parent, [childId]).then(() => {
        drainCompleted = true
      }, error => { cleanupErrors.push('child drain: ' + diagnostic(error)) })
    }
    if (ctx.agents.get(childId) !== undefined) cleanupErrors.push('child still resident')
    await rm(markerAbsolute, { force: true }).catch(error => cleanupErrors.push('marker remove: ' + diagnostic(error)))
    try {
      await stat(markerAbsolute)
      cleanupErrors.push('marker still exists')
    } catch (error) {
      if (error?.code === 'ENOENT') markerRemoved = true
      else cleanupErrors.push('marker verification: ' + diagnostic(error))
    }
  }
  const cleanup = { childDisposed: !!accepted && drainCompleted && ctx.agents.get(childId) === undefined &&
    !cleanupErrors.some(item => item.startsWith('child')), markerRemoved: markerRemoved && !cleanupErrors.some(item => item.startsWith('marker')),
    errors: cleanupErrors }
  const pass = !failure && cleanup.childDisposed && cleanup.markerRemoved && cleanup.errors.length === 0 && turns.firstAccepted && turns.firstCompleted &&
    turns.secondAccepted && turns.secondCompleted && turns.sameChildSession && turns.childResidentAfterFirst &&
    !turns.secretRepeatedInSecondTurn && !leakedSecretIntoSecond && !firstTurnWrote &&
    childEvidence.tools.length === 1 && childEvidence.tools[0] === 'write' &&
    childEvidence.toolsAfterFirst.length === 1 && childEvidence.toolsAfterFirst[0] === 'write' &&
    childEvidence.toolsSecondTurn.length === 1 && childEvidence.toolsSecondTurn[0] === 'write' && childEvidence.writeVisible &&
    !childEvidence.postmanBridgeVisible && !childEvidence.scopeProbeVisible &&
    childEvidence.parentSession === parent.id && childEvidence.origin === 'subagent' &&
    childEvidence.delegationDepth === 1 && writeCalled && writeSucceeded && markerExact
  return {
    status: pass ? 'POSTMAN_WORKER_CONTINUATION_PROBE_PASS' :
      cleanup.errors.length || (accepted && (!cleanup.childDisposed || !cleanup.markerRemoved))
        ? 'POSTMAN_WORKER_CONTINUATION_PROBE_CLEANUP_FAILED' : 'POSTMAN_WORKER_CONTINUATION_PROBE_FAILED',
    verdict: pass ? 'CONTINUABLE_SPAWN_SUFFICIENT' : NOT_PROVEN,
    parent: { sessionId: parent.id, tools: parentTools, writeVisible: false },
    child: childEvidence, turns: { ...turns, secretRepeatedInSecondTurn: turns.secretRepeatedInSecondTurn || leakedSecretIntoSecond,
      firstTurnWrote, secondSentToSameAgent },
    memory: { writeCalled, writeSucceeded, exactMatch: markerExact },
    cleanup, ...(failure ? { diagnostic: failure } : {}),
  }
}
