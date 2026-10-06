import { defineTool } from '@deepseek-ai/dsh-tools'
import { createPtcRuntime, DEFAULT_LIMITS, validatePtcProfile } from 'dsh-ptc'
import { buildPtcHelperPrelude, ptcHelperGuidance } from './ptc-helpers.js'
import { POSTMAN_PTC_DISCIPLINE } from './ptc-discipline.js'
import { guardWorkerPtcFilesystem } from './ptc-worktree-boundary.js'
import { readPtcTextPage } from './ptc-read.js'
import { POSTMAN_PTC_ONLY_LEADER_TOOLS, POSTMAN_WORKER_PTC_TOOL_NAMES, POSTMAN_SOL_PTC_TOOL_NAMES, POSTMAN_PTC_SUCCESS_STATUSES } from './postman-bridge-core.js'

export const PTC_TOOL_NAME = 'ptc_execute'
export const PILOT_PROFILE = validatePtcProfile({
  schemaVersion: 1, id: 'postman-leader-supervisor', revision: 8,
  tools: [...POSTMAN_PTC_ONLY_LEADER_TOOLS],
  limits: { ...DEFAULT_LIMITS, maxWallMs: 300000, maxToolCalls: 256,
    quickjsMemoryBytes: 67108864, maxTotalBridgeBytes: 16777216, maxConcurrentToolCalls: 1 },
})
export const WORKER_MUTATION_PROFILE = validatePtcProfile({
  schemaVersion: 1, id: 'postman-worker-mutation', revision: 5,
  tools: [...POSTMAN_WORKER_PTC_TOOL_NAMES],
  limits: { ...DEFAULT_LIMITS, maxConcurrentToolCalls: 1 },
})
export const SOL_WORKER_PROFILE = validatePtcProfile({
  schemaVersion: 1, id: 'postman-sol-worker-engineering', revision: 1,
  tools: [...POSTMAN_SOL_PTC_TOOL_NAMES],
  limits: { ...DEFAULT_LIMITS, maxWallMs: 300000, maxConcurrentToolCalls: 1 },
})
const LEADER_REQUIRED = ['read', 'grep']
const WORKER_REQUIRED = ['read', 'glob', 'grep']
const MAX_DESCRIPTION = 160
const BOUNDARIES = ['semantic_decision', 'user_input', 'external_event', 'approval_boundary', 'task_complete']
// Auto-yield must not hide a refused/unknown prepare or async dispatch returned as ordinary JSON.
// This gate does not recover statuses or alter the tool result/authority.
const EVENT_PRODUCERS = ['postman_worker', 'postman_secretary', 'postman_worker_fresh', 'postman_worker_interrupt', 'postman_bridge']
const YIELD_ACCEPTANCE = POSTMAN_PTC_SUCCESS_STATUSES
const output = {
  schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

// Ownership of this runtime is the owning plugin, never an individual program.
// resolveAssignment is trusted Host code; the model cannot choose its profile or role.
export function createPtcAdapter(ctx, { authorize, resolveAssignment, workerContextOf, profile = PILOT_PROFILE, runtime = createPtcRuntime() }) {
  function pilotProfile(value) {
    const checked = validatePtcProfile(value)
    if (checked.tools.some(name => !POSTMAN_PTC_ONLY_LEADER_TOOLS.includes(name))) throw new TypeError('PTC pilot profile tool not allowed')
    return checked
  }
  let current = pilotProfile(profile), disposed = false
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
  const stagedConclusions = new WeakMap(), externalTurns = new WeakMap()
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
    const waitingTurn = externalTurns.get(agent)
    if (waitingTurn === undefined) return decision
    if (waitingTurn !== turn) { externalTurns.delete(agent); return decision }
    const record = owners.get(agent.id)
    if (decision.kind !== 'reject' && allowed(agent, record) && record.role === 'leader' &&
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
  const logger = ctx.logger('postman-ptc')
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
    if (old) { owners.delete(agent.id); revoke(old) }
    if (disposed || ctx.agents.get(agent.id) !== agent) return false
    const assignment = assignmentFor(agent, current)
    if (!assignment || !((assignment.role === 'leader' && assignment.profile === current) ||
        (assignment.role === 'sol' && assignment.profile === SOL_WORKER_PROFILE))) return false
    const record = { agent, profile: assignment.profile, role: assignment.role,
      revision: assignment.profile.revision, runs: new Set(), section: null, tool: null }
    owners.set(agent.id, record)
    // Pre-review Sol Sessions persist a spawn filter denying inherited PTC.
    // Bind this one Host-authorized capability in the exact Sol scope; do not
    // rewrite audit/descriptor, lift other filters or grant it to FAST children.
    const descriptor = agent.session?.events?.find(event => event.type === 'subagent/descriptor')?.data
    if (record.role === 'sol' && descriptor?.toolFilter?.deny?.includes(PTC_TOOL_NAME))
      record.tool = agent.ctx.tools.register(tool)
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
      'This exact Sol Worker uses PTC-first for its own batchable engineering work; direct PTC-managed calls are rejected. Follow postman-sol-worker: Worker-first for independent cheap tasks, two free Workers in parallel for two independent tasks. Worker controls are direct-only, limited to your exact children; no supervisor/Bridge/Secretary/Sol creation or approval tools in PTC. Use the assigned task worktree explicitly for shell commands. ' :
      'This Leader uses Postman PTC; direct PTC-managed calls are rejected. PTC changes execution mode, not Postman Leader routing: follow the postman-leader skill, obtain user approval before medium/complex task preparation or delegation, and delegate repository discovery/execution to Worker/Postman as required. Never poll Worker/Bridge: reports and READY arrive as later events, not within this program. '
    return roleText + helperText +
      'Use await tools.name(JSON_arguments). Current nested argument schemas: ' +
      JSON.stringify(schemas.map(s => ({ name: s.name, parameters: s.parameters })))
  }
  function remove(agent) {
    const record = owners.get(agent?.id)
    if (record?.agent !== agent) return false
    owners.delete(agent.id); revoke(record); return true
  }
  function setProfile(next) {
    const checked = pilotProfile(next)
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
    description: 'Run one isolated PTC program for the exact experimental Postman Leader or managed Sol Worker. Each role has its own profile; guidance lists current nested tool schemas.',
    parameters: {
      program: { type: 'string', required: true, description: 'One async-function body with explicit JSON return. No imports, Node or persistent state.' },
      description: { type: 'string', required: true, description: 'Short purpose and why the deterministic phase ends at the declared boundary.' },
      boundary: { type: 'string', required: true, enum: BOUNDARIES, description: 'Next genuine decision boundary; encode all safe deterministic work before it in this program.' },
      yield_on_success: { type: 'boolean', description: 'Compatibility flag, Leader only. external_event automatically concludes after safe exact accepted Worker/interrupt/Bridge dispatch, even when omitted or false.' },
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
          (args.yield_on_success === true && (args.boundary !== 'external_event' || record.role !== 'leader')))
        return { status: 'PTC_YIELD_INVALID' }
      const autoConclude = record.role === 'leader' && args.boundary === 'external_event'
      if (autoConclude && typeof exec.concludeTurn !== 'function')
        return { status: 'PTC_YIELD_UNSUPPORTED' }
      if (exec.signal.aborted) return { status: 'cancelled', effects: { calls: [], completed: 0, failed: 0, pending: 0 } }
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
              else if (EVENT_PRODUCERS.includes(name)) eventAccepted = true
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
          autoConclude && !eventAccepted ? 'no-accepted-producer' : undefined
        if ((autoConclude || nestedConclude) && !yieldBlockedReason) {
          exec.concludeTurn()
          if (autoConclude) stagedConclusions.set(exec, record)
          yieldApplied = true
        }
        return result
      } finally {
        const resultBytes = terminal?.status === 'ok' ? Buffer.byteLength(JSON.stringify(terminal.value), 'utf8') : 0
        // Plugin diagnostic vocabulary is not supported by native persistence.
        // Keep efficiency metadata in the ordinary logger, never in the durable session.
        logger.info('postman/ptc-run', { sessionId: agent.id,
          role: record.role, description, boundary: args.boundary,
          ...(description !== args.description ? { descriptionNormalized: true } : {}),
          ...(autoConclude && yieldBlockedReason ? { yieldBlockedReason } : {}),
          status: terminal?.status ?? 'runtime-error', durationMs: Date.now() - startedAt,
          nestedToolCalls: started.size, toolCounts,
          resultBytes, oversizedResultCandidate: resultBytes > 64 * 1024 || terminal?.error?.code === 'maxOutputBytes',
          yieldRequested: args.yield_on_success === true, yieldApplied,
          ...(terminal?.status === 'limit-exceeded' ? { limitCode: terminal.error?.code } : {}),
          underbatchedCandidate: started.size === 1,
        })
        record.runs.delete(run)
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
  })
  async function dispose() {
    if (disposed) return
    disposed = true
    stopConclusionObserver(); stopExternalBoundary(); stopTextReads()
    for (const record of owners.values()) revoke(record)
    owners.clear()
    await runtime.dispose()
  }
  return { tool, refresh, remove, setProfile, permissionsChanged, dispose }
}
