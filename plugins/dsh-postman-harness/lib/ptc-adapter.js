import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createPtcRuntime, DEFAULT_LIMITS, validatePtcProfile } from 'dsh-ptc'
import { buildPtcHelperPrelude, ptcHelperGuidance } from './ptc-helpers.js'
import { POSTMAN_PTC_DISCIPLINE } from './ptc-discipline.js'
import { readPtcTextPage } from './ptc-read.js'
import { POSTMAN_PTC_ONLY_LEADER_TOOLS, POSTMAN_WORKER_PTC_TOOL_NAMES, POSTMAN_SOL_PTC_TOOL_NAMES, POSTMAN_NODES_TOOL_NAMES, POSTMAN_NODES_LEADER_TOOL_NAMES } from './postman-bridge-core.js'

export const PTC_TOOL_NAME = 'ptc_execute'
export const LEADER_SUPERVISOR_PROFILE = validatePtcProfile({
  schemaVersion: 1, id: 'postman-leader-supervisor', revision: 10,
  tools: [...POSTMAN_PTC_ONLY_LEADER_TOOLS],
  limits: { ...DEFAULT_LIMITS, maxWallMs: 300000, maxToolCalls: 256,
    quickjsMemoryBytes: 67108864, maxTotalBridgeBytes: 16777216, maxConcurrentToolCalls: 1 },
})
// Historical import compatibility; the canonical profile is no longer a pilot.
export const PILOT_PROFILE = LEADER_SUPERVISOR_PROFILE
export const NODES_LEADER_PROFILE = validatePtcProfile({
  schemaVersion: 1, id: 'postman-nodes-supervisor', revision: 1,
  tools: [...POSTMAN_PTC_ONLY_LEADER_TOOLS, ...POSTMAN_NODES_TOOL_NAMES, ...POSTMAN_NODES_LEADER_TOOL_NAMES],
  limits: { ...DEFAULT_LIMITS, maxWallMs: 300000, maxToolCalls: 256,
    quickjsMemoryBytes: 67108864, maxTotalBridgeBytes: 16777216, maxConcurrentToolCalls: 1 },
})
export const WORKER_MUTATION_PROFILE = validatePtcProfile({
  schemaVersion: 1, id: 'postman-worker-mutation', revision: 5,
  tools: [...POSTMAN_WORKER_PTC_TOOL_NAMES],
  limits: { ...DEFAULT_LIMITS, maxConcurrentToolCalls: 1 },
})
export const SOL_WORKER_PROFILE = validatePtcProfile({
  schemaVersion: 1, id: 'postman-sol-worker-engineering', revision: 3,
  tools: [...POSTMAN_SOL_PTC_TOOL_NAMES],
  limits: { ...DEFAULT_LIMITS, maxWallMs: 300000, maxConcurrentToolCalls: 1 },
})
export const NODES_SOL_PROFILE = validatePtcProfile({
  ...SOL_WORKER_PROFILE, id: 'postman-nodes-sol', tools: [...POSTMAN_SOL_PTC_TOOL_NAMES, ...POSTMAN_NODES_TOOL_NAMES],
})
const MAX_DESCRIPTION = 160
const output = {
  schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

// Ownership of this runtime is the owning plugin, never an individual program.
// resolveAssignment is trusted Host code; the model cannot choose its profile or role.
export function createPtcAdapter(ctx, { authorize, resolveAssignment, workerContextOf, readWait, writeWait, profile = LEADER_SUPERVISOR_PROFILE, runtime = createPtcRuntime() }) {
  function supervisorProfile(value) {
    const checked = validatePtcProfile(value)
    if (checked.tools.some(name => ![...POSTMAN_PTC_ONLY_LEADER_TOOLS, ...POSTMAN_NODES_TOOL_NAMES, ...POSTMAN_NODES_LEADER_TOOL_NAMES].includes(name))) throw new TypeError('PTC supervisor profile tool not allowed')
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
  // The saved value is the Leader's choice, not evidence of a live producer.
  const localWait = new WeakMap(), stagedConclusions = new WeakMap(), externalTurns = new WeakMap()
  const waiting = agent => readWait ? readWait(agent) === true : localWait.get(agent) === true
  async function setWaiting(agent, value) {
    if (writeWait) await writeWait(agent, value)
    else localWait.set(agent, value)
  }
  const deferredFact = message => ['subagent-report', 'subagent-settled'].includes(message.source?.kind) && message.source.form === 'postman-deferred'
  const stopConclusionObserver = ctx.on('tools/result', (exec, result) => {
    const record = stagedConclusions.get(exec)
    stagedConclusions.delete(exec)
    if (!record || result.isError || result.concludesTurn !== true || !allowed(exec.agent, record)) return
    const turn = exec.agent.session?.events?.findLast(event => event.type === 'turn/start')?.data.turn
    if (Number.isSafeInteger(turn)) externalTurns.set(exec.agent, turn)
  })
  const stopExternalBoundary = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const { agent, turn } = payload
    if (decision.kind === 'reject' || !allowed(agent, owners.get(agent?.id))) return decision
    if (decision.messages.length && decision.messages.every(deferredFact) && isWaitingForExternalEvent(agent, true)) {
      agent.inbox.splice('next-step', 0, 0, decision.messages)
      return { kind: 'reject' }
    }
    if (waiting(agent) && decision.messages.some(message => !deferredFact(message))) await setWaiting(agent, false)
    const waitingTurn = externalTurns.get(agent)
    if (waitingTurn === undefined) return decision
    if (waitingTurn !== turn) { externalTurns.delete(agent); return decision }
    if (allowed(agent, owners.get(agent.id)) && agent.inbox.nextTurn.length === 0) {
      if (decision.messages.length) agent.inbox.splice('next-step', 0, 0, decision.messages)
      return { kind: 'enter', messages: [] }
    }
    return decision
  })
  const stopGoalContinuation = ctx.on('goal/continuation-defer', agent =>
    isWaitingForExternalEvent(agent) ? true : undefined)
  const logger = ctx.logger('postman-ptc')
  const assignmentFor = resolveAssignment ?? (agent => authorize(agent) ? { profile: current, role: 'leader' } : null)
  function allowed(agent, record) {
    if (disposed || !agent || !record || record.agent !== agent ||
        owners.get(agent.id) !== record || ctx.agents.get(agent.id) !== agent) return false
    const assignment = assignmentFor(agent, current)
    return assignment?.profile === record.profile && assignment.role === record.role &&
      assignment.profile.revision === record.revision
  }
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
    if (!assignment || !((assignment.role === 'leader' && [current, NODES_LEADER_PROFILE].includes(assignment.profile)) ||
        (assignment.role === 'sol' && [SOL_WORKER_PROFILE, NODES_SOL_PROFILE].includes(assignment.profile)))) return false
    const record = { agent, profile: assignment.profile, role: assignment.role,
      revision: assignment.profile.revision, runs: new Set(), section: null, tool: null }
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
    if (!available(agent, PTC_TOOL_NAME)) return ''
    const schemas = ctx.tools.schemas(agent).filter(s => record.profile.tools.includes(s.name))
    const roleText = record.role === 'sol' ?
      'Use PTC for your assigned engineering tools and controls of your own Workers. report and notify_parent remain direct tools. ' :
      'Use PTC for the tools managed by your Leader role. Routing, recovery, retries and acceptance are your decisions. '
    return roleText + POSTMAN_PTC_DISCIPLINE + '\n' + ptcHelperGuidance(schemas.map(s => s.name)) +
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
      const ownerValid = allowed(record.agent, record) && available(record.agent, PTC_TOOL_NAME)
      for (const run of record.runs) if (!ownerValid ||
        run.profile.tools.some(name => !available(record.agent, name))) run.controller.abort()
    }
  }
  const tool = defineTool({
    name: PTC_TOOL_NAME,
    description: 'Run a JavaScript/TypeScript program with the tools granted to this Leader or Sol Worker. Batch known operations and return JSON. Set wait_for_event to finish the turn and wait.',
    parameters: {
      program: { type: 'string', required: true, description: 'One async-function body with explicit JSON return. No imports, Node or persistent state.' },
      description: { type: 'string', description: 'Optional short description of this program.' },
      wait_for_event: { type: 'boolean', description: 'After successful execution, finish this turn and wait for user input or an executor event.' },
      language: { type: 'string', enum: ['javascript', 'typescript'], description: 'JavaScript by default; TypeScript supports erasable syntax only.' },
    }, output,
    async execute(args, exec) {
      const agent = exec?.agent, record = owners.get(agent?.id)
      if (!allowed(agent, record) || !available(agent, PTC_TOOL_NAME)) return { status: 'PTC_CALLER_REJECTED' }
      const activeProfile = validatePtcProfile({ ...record.profile,
        tools: record.profile.tools.filter(name => available(agent, name)) })
      const description = typeof args.description === 'string' ?
        Array.from(args.description.trim().replace(/\s+/g, ' ')).slice(0, MAX_DESCRIPTION).join('') : ''
      if (exec.signal.aborted) return { status: 'cancelled', effects: { calls: [], completed: 0, failed: 0, pending: 0 } }
      const controller = new AbortController(), started = new Map()
      const startedAt = Date.now(), toolCounts = Object.create(null)
      let terminal, waitApplied = false, nestedConclude = false
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
            const base = workerContextOf?.(agent)?.worktree
            const field = ['read', 'write', 'edit'].includes(name) ? 'file_path' : 'path'
            const location = nestedArgs?.[field] ?? (field === 'path' ? '.' : undefined)
            if (typeof base === 'string' && typeof location === 'string')
              nestedArgs = { ...nestedArgs, [field]: resolve(base, location) }
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
            if (controller.signal.aborted || !allowed(agent, record) || !available(agent, name))
              throw new Error('PTC_ACCESS_REVOKED')
            for (const context of result.additionalContexts ?? []) exec.deferContext(context)
            if (result.isError) return { isError: true, error: result.error,
              ...(result.content ? { content: result.content } : {}) }
            if (result.concludesTurn) nestedConclude = true // Apply only after the complete program is known safe.
            if (textRequest) {
              if (!textRequest.page || JSON.stringify(result.value) !== JSON.stringify(textRequest.preview))
                throw new Error('PTC full read result replaced or unavailable; text is incomplete')
              return textRequest.page
            }
            return result.value // Canonical public JSON, not rendered cards or execution metadata.
          } catch (error) {
            if (!entry.settled) {
              entry.settled = true
              agent.session?.append('tool/code-dispatch', { ...details, isError: true,
                content: [{ type: 'text', text: 'PTC nested dispatch failed; outcome not confirmed' }] })
            }
            if (call.signal.aborted || controller.signal.aborted || !allowed(agent, record) || !available(agent, name))
              throw error
            return { isError: true, error: { message: String(error?.message ?? error),
              ...(typeof error?.name === 'string' ? { name: error.name } : {}),
              ...(typeof error?.code === 'string' ? { code: error.code } : {}) } }
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
        for (const entry of started.values()) if (!entry.settled) {
          entry.settled = true
          agent.session?.append('tool/code-dispatch', { ...entry.details, isError: true,
            content: [{ type: 'text', text: 'PTC program stopped; external operation still pending, outcome unknown' }] })
        }
        if (result.status === 'ok' && !controller.signal.aborted && !exec.signal.aborted && allowed(agent, record)) {
          if (args.wait_for_event === true) {
            await setWaiting(agent, true)
            waitApplied = true
          }
          if (waitApplied || nestedConclude) {
            exec.concludeTurn()
            stagedConclusions.set(exec, record)
          }
        }
        return result
      } finally {
        logger.info('postman/ptc-run', { sessionId: agent.id, role: record.role, description,
          status: terminal?.status ?? 'runtime-error', durationMs: Date.now() - startedAt,
          nestedToolCalls: started.size, toolCounts, waitRequested: args.wait_for_event === true, waitApplied,
          ...(terminal?.status === 'limit-exceeded' ? { limitCode: terminal.error?.code } : {}) })
        record.runs.delete(run)
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
  })
  function isWaitingForExternalEvent(agent, proposingStep = false) {
    if (!allowed(agent, owners.get(agent?.id)) || !waiting(agent)) return false
    if (!proposingStep && agent.phase?.kind !== 'idle') return false
    return ![...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].some(message => !deferredFact(message))
  }
  async function dispose() {
    if (disposed) return
    disposed = true
    stopConclusionObserver(); stopExternalBoundary(); stopGoalContinuation(); stopTextReads()
    for (const record of owners.values()) revoke(record)
    owners.clear()
    await runtime.dispose()
  }
  return { tool, refresh, remove, setProfile, permissionsChanged, isWaitingForExternalEvent, dispose }
}
