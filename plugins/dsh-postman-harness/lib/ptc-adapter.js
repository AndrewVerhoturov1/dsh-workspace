import { defineTool } from '@deepseek-ai/dsh-tools'
import { createPtcRuntime, DEFAULT_LIMITS, validatePtcProfile } from 'dsh-ptc'

export const PTC_TOOL_NAME = 'ptc_execute'
const PILOT_NAMES = Object.freeze(['read', 'grep', 'get_goal', 'web_fetch'])
export const PILOT_PROFILE = validatePtcProfile({
  schemaVersion: 1, id: 'postman-leader-readonly', revision: 1,
  tools: [...PILOT_NAMES],
  limits: { ...DEFAULT_LIMITS, maxConcurrentToolCalls: 1 },
})
const REQUIRED = ['read', 'grep']
const MAX_DESCRIPTION = 160
const output = {
  schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

// Ownership of this runtime is the owning plugin, never an individual program.
// authorize is Postman's exact-preset predicate; the adapter knows no role names.
export function createPtcAdapter(ctx, { authorize, profile = PILOT_PROFILE, runtime = createPtcRuntime() }) {
  function pilotProfile(value) {
    const checked = validatePtcProfile(value)
    if (checked.tools.some(name => !PILOT_NAMES.includes(name))) throw new TypeError('PTC pilot profile tool not allowed')
    return checked
  }
  let current = pilotProfile(profile), disposed = false
  const owners = new Map()
  function allowed(agent, record) {
    return !disposed && !!agent && !!record && record.agent === agent &&
      owners.get(agent.id) === record && ctx.agents.get(agent.id) === agent && authorize(agent) &&
      record.profile === current && record.revision === current.revision
  }
  function available(agent, name) {
    return !!ctx.tools.get(name, agent) && ctx.tools.schemas(agent).some(schema => schema.name === name)
  }
  function revoke(record) {
    if (!record) return
    for (const run of record.runs) run.controller.abort()
    record.runs.clear()
    record.section?.()
    record.section = null
  }
  function refresh(agent) {
    if (!agent || typeof agent.id !== 'string') return false
    const old = owners.get(agent.id)
    if (old) { owners.delete(agent.id); revoke(old) }
    if (disposed || ctx.agents.get(agent.id) !== agent || !authorize(agent)) return false
    const record = { agent, profile: current, revision: current.revision, runs: new Set(), section: null }
    owners.set(agent.id, record)
    if (agent.ctx?.systemPrompt?.section) record.section = agent.ctx.systemPrompt.section({
      name: 'postman-ptc-pilot', order: 125,
      text: ({ scope } = {}) => scope === agent && allowed(agent, record) ? guidance(agent, record) : '',
    })
    return true
  }
  function guidance(agent, record) {
    if (REQUIRED.some(name => !available(agent, name))) return ''
    const schemas = ctx.tools.schemas(agent).filter(s => record.profile.tools.includes(s.name))
    return 'Pilot PTC: ptc_execute runs a single isolated JavaScript/erasable TypeScript async-function body. ' +
      'Use await tools.name(JSON_arguments) and return a JSON value explicitly. No persistent state or automatic retry; inspect status/effects after errors. ' +
      'Only these nested tools are available with their current Harness argument schemas: ' +
      JSON.stringify(schemas.map(s => ({ name: s.name, description: s.description, parameters: s.parameters })))
  }
  function remove(agent) {
    const record = owners.get(agent?.id)
    if (record?.agent !== agent) return false
    owners.delete(agent.id); revoke(record); return true
  }
  function setProfile(next) {
    const checked = pilotProfile(next)
    current = checked
    for (const record of [...owners.values()]) refresh(record.agent)
  }
  function permissionsChanged() {
    for (const record of owners.values()) {
      const ownerValid = allowed(record.agent, record) && available(record.agent, PTC_TOOL_NAME) &&
        REQUIRED.every(name => available(record.agent, name))
      for (const run of record.runs) if (!ownerValid ||
        run.profile.tools.some(name => !available(record.agent, name))) run.controller.abort()
    }
  }
  const tool = defineTool({
    name: PTC_TOOL_NAME,
    description: 'Run one isolated PTC program for the exact experimental Postman Leader. Pilot guidance lists currently available nested tools and their real schemas.',
    parameters: {
      program: { type: 'string', required: true, description: 'One async-function body with explicit JSON return. No imports, Node or persistent state.' },
      description: { type: 'string', required: true, description: 'Short purpose of this one program.' },
      language: { type: 'string', enum: ['javascript', 'typescript'], description: 'JavaScript by default; TypeScript supports erasable syntax only.' },
    }, output,
    async execute(args, exec) {
      const agent = exec?.agent, record = owners.get(agent?.id)
      if (!allowed(agent, record) || !available(agent, PTC_TOOL_NAME)) return { status: 'PTC_CALLER_REJECTED' }
      if (REQUIRED.some(name => !available(agent, name))) return { status: 'PTC_REQUIRED_TOOL_UNAVAILABLE' }
      const activeProfile = validatePtcProfile({ ...record.profile,
        tools: record.profile.tools.filter(name => available(agent, name)) })
      if (typeof args.description !== 'string' || !args.description.trim() || args.description.length > MAX_DESCRIPTION)
        return { status: 'PTC_DESCRIPTION_INVALID' }
      if (exec.signal.aborted) return { status: 'cancelled', effects: { calls: [], completed: 0, failed: 0, pending: 0 } }
      const controller = new AbortController(), started = new Map()
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
          const subCallId = String(exec.callId) + ':ptc:' + call.callId
          const details = { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId, name, arguments: arg }
          const entry = { details, settled: false }
          started.set(call.callId, entry)
          agent.session?.append('tool/code-dispatch-start', details)
          try {
            const result = await ctx.tools.execute({ callId: subCallId, rootCallId: exec.rootCallId,
              name, arguments: arg, agent, parent: exec.token, signal: call.signal })
            if (!entry.settled) {
              entry.settled = true
              agent.session?.append('tool/code-dispatch', { ...details, isError: result.isError, content: result.content })
            }
            if (controller.signal.aborted || !allowed(agent, record) || !available(agent, name))
              throw new Error('PTC_ACCESS_REVOKED')
            if (result.isError) throw new Error(result.error.message)
            for (const context of result.additionalContexts ?? []) exec.deferContext(context)
            if (result.concludesTurn) exec.concludeTurn()
            return result.value // Canonical public JSON, not rendered cards or execution metadata.
          } catch (error) {
            if (!entry.settled) {
              entry.settled = true
              agent.session?.append('tool/code-dispatch', { ...details, isError: true,
                content: [{ type: 'text', text: 'PTC nested dispatch failed; outcome not confirmed' }] })
            }
            throw error
          }
        }
      }
      try {
        const result = await runtime.run({ program: args.program, language: args.language ?? 'javascript',
          profile: activeProfile, bindings, signal: controller.signal })
        // The guest can stop while a noncooperative Host promise remains pending.
        // Close the durable event pair with an explicit unknown outcome before the turn ends.
        for (const entry of started.values()) if (!entry.settled) {
          entry.settled = true
          agent.session?.append('tool/code-dispatch', { ...entry.details, isError: true,
            content: [{ type: 'text', text: 'PTC program stopped; external operation still pending, outcome unknown' }] })
        }
        return result
      } finally {
        record.runs.delete(run)
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
  })
  async function dispose() {
    if (disposed) return
    disposed = true
    for (const record of owners.values()) revoke(record)
    owners.clear()
    await runtime.dispose()
  }
  return { tool, refresh, remove, setProfile, permissionsChanged, dispose }
}
