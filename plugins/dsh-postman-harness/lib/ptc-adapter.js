import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createPtcRuntime, DEFAULT_LIMITS, validatePtcProfile } from 'dsh-ptc'
import { buildPtcHelperPrelude, ptcHelperGuidance } from './ptc-helpers.js'
import { POSTMAN_PTC_DISCIPLINE } from './ptc-discipline.js'
import { guardWorkerPtcFilesystem } from './ptc-worktree-boundary.js'
import { readPtcTextPage } from './ptc-read.js'
import { POSTMAN_PTC_ONLY_LEADER_TOOLS, POSTMAN_WORKER_PTC_TOOL_NAMES, POSTMAN_SOL_PTC_TOOL_NAMES, POSTMAN_PTC_SUCCESS_STATUSES } from './postman-bridge-core.js'

export const PTC_TOOL_NAME = 'ptc_execute'
export const LEADER_SUPERVISOR_PROFILE = validatePtcProfile({
  schemaVersion: 1, id: 'postman-leader-supervisor', revision: 9,
  tools: [...POSTMAN_PTC_ONLY_LEADER_TOOLS],
  limits: { ...DEFAULT_LIMITS, maxWallMs: 300000, maxToolCalls: 256,
    quickjsMemoryBytes: 67108864, maxTotalBridgeBytes: 16777216, maxConcurrentToolCalls: 1 },
})
// Historical import compatibility; the canonical profile is no longer a pilot.
export const PILOT_PROFILE = LEADER_SUPERVISOR_PROFILE
export const WORKER_MUTATION_PROFILE = validatePtcProfile({
  schemaVersion: 1, id: 'postman-worker-mutation', revision: 5,
  tools: [...POSTMAN_WORKER_PTC_TOOL_NAMES],
  limits: { ...DEFAULT_LIMITS, maxConcurrentToolCalls: 1 },
})
export const SOL_WORKER_PROFILE = validatePtcProfile({
  schemaVersion: 1, id: 'postman-sol-worker-engineering', revision: 2,
  tools: [...POSTMAN_SOL_PTC_TOOL_NAMES],
  limits: { ...DEFAULT_LIMITS, maxWallMs: 300000, maxConcurrentToolCalls: 1 },
})
const LEADER_REQUIRED = ['read', 'grep']
const WORKER_REQUIRED = ['read', 'glob', 'grep']
const MAX_DESCRIPTION = 160
const BOUNDARIES = ['semantic_decision', 'user_input', 'external_event', 'approval_boundary', 'task_complete']
// Auto-yield must not hide a refused/unknown prepare or async dispatch returned as ordinary JSON.
// This gate does not recover statuses or alter the tool result/authority.
const EVENT_PRODUCERS = {
  leader: ['postman_worker', 'postman_sol_worker', 'postman_secretary', 'postman_worker_fresh', 'postman_worker_interrupt', 'postman_bridge'],
  sol: ['postman_worker', 'postman_worker_fresh', 'postman_worker_interrupt'],
}
const YIELD_ACCEPTANCE = POSTMAN_PTC_SUCCESS_STATUSES
const output = {
  schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

// Ownership of this runtime is the owning plugin, never an individual program.
// resolveAssignment is trusted Host code; the model cannot choose its profile or role.
export function createPtcAdapter(ctx, { authorize, resolveAssignment, workerContextOf, hasActiveWork, profile = LEADER_SUPERVISOR_PROFILE, runtime = createPtcRuntime() }) {
  function supervisorProfile(value) {
    const checked = validatePtcProfile(value)
    if (checked.tools.some(name => !POSTMAN_PTC_ONLY_LEADER_TOOLS.includes(name))) throw new TypeError('PTC supervisor profile tool not allowed')
    return checked
  }
  let current = supervisorProfile(profile), disposed = false
  const owners = new Map(), textReads = new Map()
  const stopTextReads = ctx.on('tools/execute', async (nested, next) => {
    const request = textReads.get(nested.parent)?.get(nested.callId)
    if (!request || nested.name !== 'read' || nested.agent !== request.agent || nested.parent !== request.parent) return next()
    // Reach every ordinary around/body check, not only pre-execute/guards.
    // Keep its truthful bounded card; only the internal payload uses raw text.
    const result = await next()
    if (result.isError) return result
    request.page = await readPtcTextPage(ctx, nested, request)
    request.preview = result.value
    return result
  })
  // concludeTurn is a soft boundary in AgentLoop when next-step events are
  // already queued. Arm only from the authoritative successful outer result.
  // The same existing inbox then carries those events into a NEW turn.
  const stagedConclusions = new WeakMap(), externalTurns = new WeakMap(), quietTurns = new WeakMap()
  const deferredFact = message => ['subagent-report','subagent-settled'].includes(message.source?.kind) && message.source.form === 'postman-deferred'
  const stopConclusionObserver = ctx.on('tools/result', (exec, result) => {
    const record = stagedConclusions.get(exec)
    stagedConclusions.delete(exec)
    if (!record || result.isError || result.concludesTurn !== true || result.value?.status !== 'ok' ||
        !allowed(exec.agent, record)) return
    const turn = exec.agent.session?.events?.findLast(event => event.type === 'turn/start')?.data.turn
    if (Number.isSafeInteger(turn)) externalTurns.set(exec.agent, turn)
  })
  const stopExternalBoundary = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next() // Never replace or bypass ordinary pre-step policies.
    const { agent, turn } = payload
    // Native inject is non-waking only while idle. If a quiet fact arrives as
    // a concluded turn stops, AgentLoop may open one more turn to claim it.
    // Suspend that empty proposal through the existing pre-step fence, keeping
    // the exact facts in its durable inbox for the next genuine report/input.
    // Ordinary vetoes and additional policy/context messages always win.
    if (decision.kind !== 'reject' && decision.messages.length > 0 &&
        decision.messages.every(deferredFact) && isWaitingForExternalEvent(agent, true)) {
      agent.inbox.splice('next-step', 0, 0, decision.messages)
      const last = agent.session.events.findLast(e => e.type === 'turn/end'), previous = quietTurns.get(agent)
      quietTurns.set(agent, { turn, completedTurn: last?.data.reason?.kind === 'blocked' && previous?.turn === last.data.turn ? previous.completedTurn : last?.data.turn })
      return { kind: 'reject' }
    }
    const waitingTurn = externalTurns.get(agent)
    if (waitingTurn === undefined) return decision
    if (waitingTurn !== turn) { externalTurns.delete(agent); return decision }
    const record = owners.get(agent.id)
    if (decision.kind !== 'reject' && allowed(agent, record) &&
        agent.inbox.nextTurn.length === 0) {
      // Preserve the accepted policy/context additions too: some are one-shot.
      // Restore at the front of the same durable queue, retaining identity,
      // order and late-arriving input rather than manufacturing new messages.
      // Empty enter ends an ALREADY concluded turn; the normal driver consumes
      // the restored events in the next turn. If nextTurn already has input,
      // AgentLoop itself restores claimed messages there: do not duplicate it.
      if (decision.messages.length) agent.inbox.splice('next-step', 0, 0, decision.messages)
      return { kind: 'enter', messages: [] }
    }
    return decision
  })
  // Optional goal-driver admission veto: only this exact authoritative idle
  // wait defers automatic rounds; native inbox input still wakes normally.
  const stopGoalContinuation = ctx.on('goal/continuation-defer', agent =>
    isWaitingForExternalEvent(agent) ? true : undefined)
  const logger = ctx.logger('postman-ptc')
  // Host-only evidence, never reconstructed from model prose or a saved tool card.
  const fatalResults = new WeakMap(), fatalTurns = new WeakMap(), fatalStreaks = new WeakMap(), revokedGoals = new WeakMap()
  function automaticGoal(agent) {
    const goals = ctx.get('goals') // Native optional lookup; the bridge need not require goal-driver.
    if (!goals || ctx.agents.get(agent?.id) !== agent) return null
    const goal = goals.get(agent), events = agent.session.events
    const start = events.findLastIndex(event => event.type === 'turn/start')
    if (start < 0 || goal?.phase !== 'active' || goal.activation !== 'armed') return null
    const inputs = events.slice(start).filter(event => event.type === 'user/message')
    if (inputs.length !== 1) return null // Real reports/input retain their ordinary review semantics.
    const source = inputs[0].data.source
    return source?.kind === 'goal' && source.round > 0 && source.goalId === goal.id &&
      source.revision === goal.revision && source.round === goal.roundsStarted ?
      { session: agent.session, turn: events[start].data.turn, id: goal.id, revision: goal.revision, round: source.round } : null
  }
  function fatalKind(result) {
    // Program exceptions, syntax, permissions, cancellation and unknown statuses are NOT infrastructure proof.
    const origin = result.failureOrigin
    if (origin?.kind !== 'host-runtime') return null
    // A validated guest terminal never receives this parent-owned provenance.
    if (result.status === 'protocol-error' && origin.stage === 'channel-frame' && ['invalid-json','maxMessageBytes','frame'].includes(result.error?.code)) return 'channel-' + result.error.code
    if (result.status === 'protocol-error' && origin.stage === 'channel-send' && result.error?.code === 'outbound') return 'channel-outbound'
    if (result.status === 'process-error' &&
        ((origin.stage === 'start' && ['spawn','start-timeout'].includes(result.error?.code)) ||
         (origin.stage === 'process-exit' && result.error?.code === 'exit') ||
         (origin.stage === 'channel-io' && ['stdin','stdout','stderr'].includes(result.error?.code)))) return 'process-' + result.error.code
    return null
  }
  const stopFatalResult = ctx.on('tools/result', (exec, result) => {
    const proof = fatalResults.get(exec)
    fatalResults.delete(exec)
    if (!proof) return
    const record = owners.get(exec.agent?.id), ref = automaticGoal(exec.agent)
    const kind = !result.isError && JSON.stringify(result.value) === proof.json &&
      allowed(exec.agent, record) && record.role === 'leader' && ref?.session === proof.ref.session &&
      ref.turn === proof.ref.turn && ref.id === proof.ref.id && ref.revision === proof.ref.revision ? proof.kind : null
    let turn = fatalTurns.get(exec.agent)
    if (!turn || turn.ref.turn !== proof.ref.turn || turn.ref.session !== proof.ref.session) {
      turn = { ref: proof.ref, kinds: [] }; fatalTurns.set(exec.agent, turn)
    }
    turn.kinds.push(kind)
  })
  const stopFatalTurn = ctx.on('agent/turn-stopping', async ({ agent }) => {
    const turn = fatalTurns.get(agent)
    fatalTurns.delete(agent)
    const ref = automaticGoal(agent), record = owners.get(agent?.id)
    const start = agent.session.events.findLastIndex(event => event.type === 'turn/start')
    const calls = agent.session.events.slice(start).filter(event => event.type === 'tool/call')
    const kind = turn?.kinds[0]
    if (!ref || !allowed(agent, record) || record.role !== 'leader' || !kind ||
        turn.ref.session !== ref.session || turn.ref.turn !== ref.turn ||
        turn.ref.id !== ref.id || turn.ref.revision !== ref.revision ||
        calls.length !== turn.kinds.length || calls.some(event => event.data.name !== PTC_TOOL_NAME) ||
        turn.kinds.some(value => value !== kind)) { fatalStreaks.delete(agent); return }
    const previous = fatalStreaks.get(agent)
    const count = previous?.session === ref.session && previous.id === ref.id && previous.revision === ref.revision &&
      previous.round + 1 === ref.round && previous.kind === kind ? previous.count + 1 : 1
    fatalStreaks.set(agent, { ...ref, kind, count })
    if (count < 2) return
    // Revoke locally FIRST. A failed append/flush must never admit round three.
    revokedGoals.set(agent, ref)
    let paused = false, durable = false
    try {
      const goals = ctx.get('goals')
      goals.disarm(agent)
      goals.pause(agent, { id: ref.id, revision: ref.revision })
      paused = true
      await ctx.get('sessions').flush(agent.session)
      durable = true
    } catch (error) {
      try { ctx.get('goals')?.disarm(agent) } catch {} // Local veto below remains in force too.
      logger.warn('postman/ptc-goal-breaker persistence not confirmed', { sessionId: agent.id, goalId: ref.id, revision: ref.revision, kind, paused, durable: false })
    }
    // Native plugin-origin message is visible in the conversation, without queuing a user action or waking a turn.
    const notice = 'Host остановил автоматическое продолжение цели после двух одинаковых сбоев PTC до отправки вложенных действий (' + kind + '). ' +
      (durable ? 'Пауза цели сохранена.' : 'Автозапуск отозван в этом процессе; сохранность паузы НЕ подтверждена.') +
      ' Цель и дочерние задачи сохранены. Возобновление — только по явной команде пользователя.'
    try {
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: notice }],
        source: { kind: 'plugin', plugin: 'dsh-postman-harness-bridge', form: 'ptc-goal-safety-stop' } }), { surfaceOp: 'append' })
      await ctx.get('sessions').flush(agent.session)
    } catch (error) { logger.warn('postman/ptc-goal-breaker visible notice could not be persisted', { sessionId: agent.id, goalId: ref.id, error: error.message }) }
    logger.info('postman/ptc-goal-breaker', { sessionId: agent.id, goalId: ref.id, revision: ref.revision, kind, count, paused, durable })
  })
  const stopFatalAdmission = ctx.on('goal/continuation-defer', agent => {
    const ref = revokedGoals.get(agent)
    const goals = ctx.get('goals')
    if (!ref || ctx.agents.get(agent.id) !== agent || ref.session !== agent.session || !goals) return
    const goal = goals.get(agent)
    // Only an ordinary authorized native resume/edit edge changes this exact revision.
    if (goal?.id === ref.id && goal.revision === ref.revision) return true
    revokedGoals.delete(agent)
  })
  const assignmentFor = resolveAssignment ?? (agent => authorize(agent) ? { profile: current, role: 'leader' } : null)
  function allowed(agent, record) {
    if (disposed || !agent || !record || record.agent !== agent ||
        owners.get(agent.id) !== record || ctx.agents.get(agent.id) !== agent) return false
    const assignment = assignmentFor(agent, current)
    return assignment?.profile === record.profile && assignment.role === record.role &&
      assignment.profile.revision === record.revision
  }
  const required = record => record.role === 'sol' ? WORKER_REQUIRED : LEADER_REQUIRED
  function available(agent, name) {
    return !!ctx.tools.get(name, agent) && ctx.tools.schemas(agent).some(schema => schema.name === name)
  }
  function revoke(record) {
    if (!record) return
    externalTurns.delete(record.agent)
    quietTurns.delete(record.agent)
    for (const run of record.runs) run.controller.abort()
    record.runs.clear()
    record.section?.()
    record.section = null
    record.tool?.()
    record.tool = null
  }
  function refresh(agent) {
    if (!agent || typeof agent.id !== 'string') return false
    const old = owners.get(agent.id)
    // Provisional -> confirmed is the same assignment, not a revocation of an in-flight program.
    if (old && allowed(agent, old)) return true
    // A stop may revoke authority after an exact model request was assembled.
    // Keep that Sol's scoped dispatcher until disposal: execute returns the
    // precise caller rejection, never "unknown tool" for an in-flight request.
    if (old?.agent === agent && old.role === 'sol' && !assignmentFor(agent, current)) {
      for (const run of old.runs) run.controller.abort()
      return false
    }
    if (old) { owners.delete(agent.id); revoke(old) }
    if (disposed || ctx.agents.get(agent.id) !== agent) return false
    const assignment = assignmentFor(agent, current)
    if (!assignment || !((assignment.role === 'leader' && assignment.profile === current) ||
        (assignment.role === 'sol' && assignment.profile === SOL_WORKER_PROFILE))) return false
    const record = { agent, profile: assignment.profile, role: assignment.role,
      revision: assignment.profile.revision, runs: new Set(), section: null, tool: null,
      underbatchedStreak: 0, underbatchedCalls: 0 }
    owners.set(agent.id, record)
    // Exact Sol scope owns its dispatcher across continuation and stop races.
    // Inherited lifecycle filters must not turn an advertised call into unknown.
    // Execution still rechecks exact binding/authority; FAST children get no PTC.
    if (record.role === 'sol') record.tool = agent.ctx.tools.register(tool)
    if (agent.ctx?.systemPrompt?.section) record.section = agent.ctx.systemPrompt.section({
      name: 'postman-ptc-' + record.role, order: 125,
      text: ({ scope } = {}) => scope === agent && allowed(agent, record) ? guidance(agent, record) : '',
    })
    return true
  }
  function guidance(agent, record) {
    if (!available(agent, PTC_TOOL_NAME) || required(record).some(name => !available(agent, name))) return ''
    const schemas = ctx.tools.schemas(agent).filter(s => record.profile.tools.includes(s.name))
    const helperText = POSTMAN_PTC_DISCIPLINE + '\n' + ptcHelperGuidance(schemas.map(s => s.name))
    const roleText = record.role === 'sol' ?
      'This exact Sol Worker uses PTC-first for its own batchable engineering work; direct PTC-managed calls are rejected. Follow postman-sol-worker: Worker-first for independent cheap tasks, two free Workers in parallel for two independent tasks. Owned Worker controls are PTC-managed, limited to your exact children. Dispatch two independent useful Workers in one PTC phase, then finish already-known own engineering mechanics; external_event waits for actual owned Worker reports and safely auto-concludes the turn. report is the final assignment result, not progress; notify_parent is only decision-relevant NEEDS_PARENT_GUIDANCE escalation. Both remain direct-only. No supervisor/Bridge/Secretary/Sol creation or approval tools in PTC. Use the assigned task worktree explicitly for shell commands. ' :
      'This Leader uses Postman PTC; direct PTC-managed calls are rejected. PTC changes execution mode, not Postman Leader routing: follow the postman-leader skill: every new non-trivial task requires Leader routing decision, compact execution plan and explicit user approval before execution. Before approval only minimal necessary Leader read-only understanding; no child creation, plan delegation, transport, implementation, tests/build or mutating Git/product operations. Truly trivial read-only/factual requests execute directly. Human approval remains direct-only outside PTC; approved continuation and preapproved conditional Sol escalation need no repeated permission, material cost/scope/access/destructive-operation/transport changes stop for revised-plan approval. Never poll Worker/Bridge: reports and READY arrive as later events, not within this program. '
    const efficiencyNotice = record.underbatchedStreak === 0 ? '' :
      record.underbatchedStreak >= 2 ?
        '\nPTC UNDERBATCH STREAK: ' + record.underbatchedStreak + '\n' +
        'Recent successful PTC programs repeatedly returned after very small deterministic phases. ' +
        'Do not use semantic_decision as a tool-call boundary. Batch all already-known safe mechanics before waking the model again.\n' :
        '\nPTC EFFICIENCY NOTICE\nPrevious successful PTC used ' + record.underbatchedCalls +
        ' nested tool call(s) and ended at semantic_decision. Verify that it actually created a NEW semantic choice. ' +
        'If the next reads/tests/status checks were already knowable, batch them into one deterministic phase.\n'
    return roleText + helperText + efficiencyNotice +
      'Use await tools.name(JSON_arguments). Current nested argument schemas: ' +
      JSON.stringify(schemas.map(s => ({ name: s.name, parameters: s.parameters })))
  }
  function remove(agent) {
    const record = owners.get(agent?.id)
    if (record?.agent !== agent) return false
    owners.delete(agent.id); revoke(record); return true
  }
  function setProfile(next) {
    const checked = supervisorProfile(next)
    current = checked
    for (const record of [...owners.values()]) if (record.role === 'leader') refresh(record.agent)
  }
  function permissionsChanged() {
    for (const record of owners.values()) {
      const ownerValid = allowed(record.agent, record) && available(record.agent, PTC_TOOL_NAME) &&
        required(record).every(name => available(record.agent, name))
      for (const run of record.runs) if (!ownerValid ||
        run.profile.tools.some(name => !available(record.agent, name))) run.controller.abort()
    }
  }
  const tool = defineTool({
    name: PTC_TOOL_NAME,
    description: 'Run one complete deterministic phase, not a tool wrapper, for the exact Postman Leader or managed Sol Worker. Batch known safe mechanics until a genuine decision boundary; describe the phase goal and stop reason. Each role retains its own profile.',
    parameters: {
      program: { type: 'string', required: true, description: 'One async-function body with explicit JSON return. No imports, Node or persistent state.' },
      description: { type: 'string', required: true, description: 'Phase goal + stop reason, not an individual tool call; include all already-known safe mechanics before that boundary.' },
      boundary: { type: 'string', required: true, enum: BOUNDARIES, description: 'Next genuine decision boundary; encode all safe deterministic work before it in this program.' },
      yield_on_success: { type: 'boolean', description: 'Compatibility flag. Leader/Sol external_event automatically concludes after safe exact role-permitted accepted dispatch or proven existing active work, even when omitted or false.' },
      language: { type: 'string', enum: ['javascript', 'typescript'], description: 'JavaScript by default; TypeScript supports erasable syntax only.' },
    }, output,
    async execute(args, exec) {
      const agent = exec?.agent, record = owners.get(agent?.id)
      if (!allowed(agent, record) || !available(agent, PTC_TOOL_NAME)) return { status: 'PTC_CALLER_REJECTED' }
      if (required(record).some(name => !available(agent, name))) return { status: 'PTC_REQUIRED_TOOL_UNAVAILABLE' }
      const workerContext = record.role === 'sol' ? workerContextOf?.(agent) : null
      if (record.role === 'sol' && (!workerContext || typeof workerContext.worktree !== 'string'))
        return { status: 'PTC_CALLER_REJECTED' }
      const activeProfile = validatePtcProfile({ ...record.profile,
        tools: record.profile.tools.filter(name => available(agent, name)) })
      if (typeof args.description !== 'string' || !args.description.trim())
        return { status: 'PTC_DESCRIPTION_INVALID' }
      // Cosmetic diagnostic text must not reject an otherwise valid program.
      const description = Array.from(args.description.trim().replace(/\s+/g, ' ')).slice(0, MAX_DESCRIPTION).join('')
      if (!BOUNDARIES.includes(args.boundary)) return { status: 'PTC_BOUNDARY_INVALID' }
      if ((args.yield_on_success !== undefined && typeof args.yield_on_success !== 'boolean') ||
          (args.yield_on_success === true && args.boundary !== 'external_event'))
        return { status: 'PTC_YIELD_INVALID' }
      const autoConclude = args.boundary === 'external_event'
      if (autoConclude && typeof exec.concludeTurn !== 'function')
        return { status: 'PTC_YIELD_UNSUPPORTED' }
      if (exec.signal.aborted) return { status: 'cancelled', effects: { calls: [], completed: 0, failed: 0, pending: 0 } }
      const goalRound = record.role === 'leader' ? automaticGoal(agent) : null
      const controller = new AbortController(), started = new Map()
      const startedAt = Date.now(), toolCounts = Object.create(null)
      let terminal, nestedFailed = false, acceptanceFailed = false, eventAccepted = false, yieldApplied = false, nestedConclude = false, yieldBlockedReason
      const onAbort = () => controller.abort()
      exec.signal.addEventListener('abort', onAbort, { once: true })
      const run = { controller, profile: activeProfile }
      record.runs.add(run)
      if (exec.signal.aborted || !allowed(agent, record)) controller.abort()
      const bindings = Object.create(null)
      for (const name of activeProfile.tools) {
        bindings[name] = async (arg, call) => {
          if (call.signal.aborted || controller.signal.aborted || !allowed(agent, record) || !available(agent, name))
            throw new Error('PTC_ACCESS_REVOKED')
          let nestedArgs = arg, textRequest
          if (name === 'read' && arg && Object.hasOwn(arg, '__ptc_text')) {
            const options = arg.__ptc_text
            if (!ctx.fs || !options || !Number.isSafeInteger(options.offset) || options.offset < 0 ||
                !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
              throw new Error('PTC full read unavailable or invalid; text is incomplete')
            textRequest = { textOffset: options.offset, maxBytes: options.maxBytes,
              maxMessageBytes: activeProfile.limits.maxMessageBytes, signal: call.signal, agent, parent: exec.token }
            nestedArgs = { ...arg }; delete nestedArgs.__ptc_text
          }
          if (record.role === 'sol' && ['read', 'glob', 'grep', 'write', 'edit'].includes(name)) {
            if (workerContextOf?.(agent) !== workerContext) throw new Error('PTC_ACCESS_REVOKED')
            nestedArgs = await guardWorkerPtcFilesystem(name, nestedArgs, workerContext.worktree)
            if (call.signal.aborted || controller.signal.aborted || !allowed(agent, record) || !available(agent, name) ||
                workerContextOf?.(agent) !== workerContext) throw new Error('PTC_ACCESS_REVOKED')
          }
          const subCallId = String(exec.callId) + ':ptc:' + call.callId
          const details = { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId, name, arguments: nestedArgs }
          const entry = { details, settled: false }
          started.set(call.callId, entry)
          toolCounts[name] = (toolCounts[name] ?? 0) + 1
          agent.session?.append('tool/code-dispatch-start', details)
          if (textRequest) {
            if (!textReads.has(exec.token)) textReads.set(exec.token, new Map())
            textReads.get(exec.token).set(subCallId, textRequest)
          }
          try {
            const result = await ctx.tools.execute({ callId: subCallId, rootCallId: exec.rootCallId,
              name, arguments: nestedArgs, agent, parent: exec.token, signal: call.signal })
            if (!entry.settled) {
              entry.settled = true
              agent.session?.append('tool/code-dispatch', { ...details, isError: result.isError, content: result.content })
            }
            if (controller.signal.aborted || !allowed(agent, record) || !available(agent, name) ||
                (record.role === 'sol' && ['read', 'glob', 'grep', 'write', 'edit'].includes(name) &&
                  workerContextOf?.(agent) !== workerContext)) throw new Error('PTC_ACCESS_REVOKED')
            if (result.isError) throw new Error(result.error.message)
            if (YIELD_ACCEPTANCE[name]) {
              if (!YIELD_ACCEPTANCE[name].includes(result.value?.status)) acceptanceFailed = true
              else if (EVENT_PRODUCERS[record.role].includes(name)) eventAccepted = true
            }
            for (const context of result.additionalContexts ?? []) exec.deferContext(context)
            if (result.concludesTurn) nestedConclude = true // Apply only after the complete program is known safe.
            if (textRequest) {
              if (!textRequest.page || JSON.stringify(result.value) !== JSON.stringify(textRequest.preview))
                throw new Error('PTC full read result replaced or unavailable; text is incomplete')
              return textRequest.page
            }
            return result.value // Canonical public JSON, not rendered cards or execution metadata.
          } catch (error) {
            nestedFailed = true
            if (!entry.settled) {
              entry.settled = true
              agent.session?.append('tool/code-dispatch', { ...details, isError: true,
                content: [{ type: 'text', text: 'PTC nested dispatch failed; outcome not confirmed' }] })
            }
            throw error
          } finally {
            const requests = textReads.get(exec.token)
            requests?.delete(subCallId)
            if (!requests?.size) textReads.delete(exec.token)
          }
        }
      }
      try {
        const helperPrelude = buildPtcHelperPrelude(activeProfile.tools, activeProfile.limits, true)
        const program = helperPrelude ? helperPrelude + '\n' + args.program : args.program
        const result = terminal = await runtime.run({ program, language: args.language ?? 'javascript',
          profile: activeProfile, bindings, signal: controller.signal })
        // The guest can stop while a noncooperative Host promise remains pending.
        // Close the durable event pair with an explicit unknown outcome before the turn ends.
        const unknownEffect = [...started.values()].some(entry => !entry.settled)
        for (const entry of started.values()) if (!entry.settled) {
          entry.settled = true
          agent.session?.append('tool/code-dispatch', { ...entry.details, isError: true,
            content: [{ type: 'text', text: 'PTC program stopped; external operation still pending, outcome unknown' }] })
        }
        const effects = result.effects
        const allCompleted = effects && effects.pending === 0 && effects.failed === 0 &&
          Array.isArray(effects.calls) && effects.calls.length === started.size &&
          effects.completed === effects.calls.length && new Set(effects.calls.map(call => call.callId)).size === started.size &&
          effects.calls.every(call => call.state === 'completed' && started.get(call.callId)?.settled === true &&
            started.get(call.callId).details.name === call.name)
        // Diagnose the actual Host decision, not a prompt-side guess. Background
        // job state (e.g. Bridge QUEUED) is not a pending nested dispatch effect.
        yieldBlockedReason = result.status !== 'ok' ? 'runtime-not-ok' : result.cleanupError ? 'cleanup-error' :
          controller.signal.aborted || exec.signal.aborted ? 'aborted' :
          !allowed(agent, record) || !available(agent, PTC_TOOL_NAME) ? 'access-revoked' :
          nestedFailed ? 'nested-failure' : acceptanceFailed ? 'acceptance-not-confirmed' :
          !allCompleted || unknownEffect ? 'effects-not-confirmed' :
          result.value?.needsModelDecision ? 'model-decision-requested' :
          autoConclude && !eventAccepted && !nestedConclude && hasActiveWork?.(agent, record.role) !== true ? 'no-accepted-producer' : undefined
        if ((autoConclude || nestedConclude) && !yieldBlockedReason) {
          exec.concludeTurn()
          stagedConclusions.set(exec, record)
          yieldApplied = true
        }
        if (goalRound) {
          const effects = result.effects
          const noActions = started.size === 0 && !nestedFailed && !unknownEffect && !result.cleanupError &&
            !controller.signal.aborted && !exec.signal.aborted && effects && Array.isArray(effects.calls) &&
            effects.calls.length === 0 && effects.completed === 0 && effects.failed === 0 && effects.pending === 0
          fatalResults.set(exec, { ref: goalRound, kind: noActions ? fatalKind(result) : null, json: JSON.stringify(result) })
        }
        return result
      } finally {
        const resultBytes = terminal?.status === 'ok' ? Buffer.byteLength(JSON.stringify(terminal.value), 'utf8') : 0
        const needsModelDecision = terminal?.value?.needsModelDecision === true
        const decisionQuestionPresent = typeof terminal?.value?.decisionQuestion === 'string' &&
          terminal.value.decisionQuestion.trim().length > 0
        // Reuse the exact Host effect/acceptance gate. Do not infer semantics from
        // evidence strings. Conservatively exempt explicit model-decision results
        // and accepted async producers, even if their declared boundary was semantic.
        const safeSemanticPhase = terminal?.status === 'ok' && args.boundary === 'semantic_decision' &&
          (!yieldBlockedReason || yieldBlockedReason === 'model-decision-requested')
        const smallSemanticPhase = safeSemanticPhase && started.size <= 1
        const thinSemanticPhase = safeSemanticPhase && started.size <= 2
        const underbatchedCandidate = smallSemanticPhase && !needsModelDecision && !eventAccepted && !nestedConclude
        const underbatchedReason = underbatchedCandidate ? 'small-semantic-phase' : null
        // Ephemeral exact assignment only: revoke/fresh/cold resume drops this state.
        record.underbatchedStreak = underbatchedCandidate ? record.underbatchedStreak + 1 : 0
        record.underbatchedCalls = underbatchedCandidate ? started.size : 0
        // Plugin diagnostic vocabulary is not supported by native persistence.
        // Keep efficiency metadata in the ordinary logger, never in the durable session.
        logger.info('postman/ptc-run', { sessionId: agent.id,
          role: record.role, description, boundary: args.boundary,
          ...(description !== args.description ? { descriptionNormalized: true } : {}),
          ...((autoConclude || nestedConclude) && yieldBlockedReason ? { yieldBlockedReason } : {}),
          status: terminal?.status ?? 'runtime-error', durationMs: Date.now() - startedAt,
          nestedToolCalls: started.size, toolCounts,
          resultBytes, oversizedResultCandidate: resultBytes > 64 * 1024 || terminal?.error?.code === 'maxOutputBytes',
          yieldRequested: args.yield_on_success === true, yieldApplied,
          ...(terminal?.status === 'limit-exceeded' ? { limitCode: terminal.error?.code } : {}),
          smallSemanticPhase, thinSemanticPhase,
          underbatchedCandidate, underbatchedReason, underbatchedStreak: record.underbatchedStreak,
          ...(terminal?.status === 'ok' && args.boundary === 'semantic_decision' ?
            { needsModelDecision, decisionQuestionPresent } : {}),
        })
        record.runs.delete(run)
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
  })
  // Validate a completed turn's final PTC, never an earlier successful call.
  // Also works after cold restore, without trusting model-authored wait prose.
  function provenExternalWait(inTurn, end, agent) {
    const calls = inTurn.filter(e => e.type === 'tool/call')
    const call = calls.at(-1), turn = externalTurns.get(agent)
    if (call?.data.name !== 'ptc_execute') return false
    // A marker from an earlier PTC in this turn cannot prove the LAST PTC
    // succeeded. With multiple calls, validate its exact durable result.
    if (end.data.turn !== turn || calls.length !== 1) {
      const result = inTurn.findLast(e => e.type === 'tool/result' &&
        e.data.message?.source?.callId === call.data.callId)?.data.message
      const block = result?.content?.[0]
      const content = block?.type === 'tool-result' ? block.content : result?.content
      if (!result || result.isError || block?.isError || content?.length !== 1 || content[0].type !== 'text') return false
      let value
      try { value = JSON.parse(content[0].text) } catch { return false }
      const effects = value.effects
      if (value.status !== 'ok' || value.cleanupError || value.value?.needsModelDecision ||
          !effects || effects.failed !== 0 || effects.pending !== 0 ||
          !Array.isArray(effects.calls) || effects.completed !== effects.calls.length ||
          effects.calls.some(entry => entry.state !== 'completed')) return false
      const dispatches = inTurn.filter(e => e.type === 'tool/code-dispatch' &&
        e.data.parentCallId === call.data.callId)
      if (dispatches.length !== effects.calls.length || dispatches.some(({ data }) => {
        if (data.isError) return true
        if (!YIELD_ACCEPTANCE[data.name]) return false
        try { return !YIELD_ACCEPTANCE[data.name].includes(JSON.parse(data.content[0].text).status) }
        catch { return true }
      })) return false
    }
    // Settlement that can unblock a requested retirement/compact is relevant.
    if (inTurn.some(e => e.type === 'tool/code-dispatch-start' && e.data.parentCallId === call.data.callId &&
        ['postman_worker_stop','postman_worker_compact','postman_worker_fresh','postman_task_close'].includes(e.data.name))) return false
    try { return JSON.parse(call.data.arguments).boundary === 'external_event' } catch { return false }
  }
  function isWaitingForExternalEvent(agent, proposingStep = false) {
    const record = owners.get(agent?.id)
    // An accepted dispatch alone is not a perpetual wake source. Recheck exact
    // current owner, native inbox and live admitted producers on every goal admission.
    if (!allowed(agent, record) || (!proposingStep && agent.phase?.kind !== 'idle') ||
        hasActiveWork?.(agent, record.role) !== true) return false
    // Native delivery marks ONLY exact Host-vetoed redundant facts. They remain
    // durable in the ordinary inbox, but must not create automatic goal rounds.
    if ([...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message =>
      !deferredFact(message))) return false
    const events = agent.session.events
    let end = events.findLast(e => e.type === 'turn/end')
    if (end?.data.reason?.kind === 'blocked' && quietTurns.get(agent)?.turn === end.data.turn) {
      // Only our exact non-semantic pre-step suspension can reuse its previous
      // completed wait. A user/policy rejection, cold unknown or lost producer
      // cannot become a perpetual goal veto.
      end = events.findLast(e => e.type === 'turn/end' && e.data.turn === quietTurns.get(agent).completedTurn)
    }
    if (end?.data.reason?.kind !== 'completed') return false
    const start = events.findLastIndex(e => e.type === 'turn/start' && e.data.turn === end.data.turn)
    if (start < 0) return false
    const inTurn = events.slice(start, events.indexOf(end) + 1), calls = inTurn.filter(e => e.type === 'tool/call')
    if (calls.length === 0) {
      // A real report/Bridge READY has already woken the model for judgement.
      // A completed text-only review needs no second empty PTC just to wait for
      // another independent confirmed producer. User, approval, arbitrary plugin
      // input or a pending turn is never silently consumed by this admission veto.
      const inputs = inTurn.filter(e => e.type === 'user/message' && !deferredFact(e.data))
      // A goal-only acknowledgement can inherit a proven prior wait, never
      // a failed PTC or an unverified claim that work is still running.
      if (inputs.length === 1 && automaticGoal(agent)?.turn === end.data.turn) {
        const previousEnd = events.slice(0, start).findLast(e => e.type === 'turn/end')
        if (previousEnd?.data.reason?.kind === 'completed') {
          const previousStart = events.findLastIndex(e => e.type === 'turn/start' && e.data.turn === previousEnd.data.turn)
          if (previousStart >= 0 && provenExternalWait(
            events.slice(previousStart, events.indexOf(previousEnd) + 1), previousEnd, agent)) return true
        }
      }
      return inputs.length > 0 && inputs.every(({ data }) =>
        data.source?.kind === 'subagent-report' && typeof data.source.senderSessionId === 'string' &&
          data.source.senderSessionId.length > 0 ||
        data.source?.kind === 'plugin' && data.source.plugin === 'dsh-postman-harness-bridge' &&
          data.source.form === 'bridge-ready' && data.source.targetSessionId === agent.id &&
          typeof data.source.bridgeJobId === 'string')
    }
    return provenExternalWait(inTurn, end, agent)
  }
  async function dispose() {
    if (disposed) return
    disposed = true
    stopConclusionObserver(); stopExternalBoundary(); stopGoalContinuation(); stopTextReads()
    stopFatalResult(); stopFatalTurn(); stopFatalAdmission()
    for (const record of owners.values()) revoke(record)
    owners.clear()
    await runtime.dispose()
  }
  return { tool, refresh, remove, setProfile, permissionsChanged, isWaitingForExternalEvent, dispose }
}
