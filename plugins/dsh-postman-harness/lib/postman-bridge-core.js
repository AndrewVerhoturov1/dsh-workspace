export const POSTMAN_BRIDGE_PROVIDER = 'spawn'
export const POSTMAN_BRIDGE_AGENT_OPTIONS = Object.freeze({
  provider: 'codex',
  model: 'gpt-5.6-luna',
})
export const POSTMAN_BRIDGE_MAX_DEPTH = 1
export const POSTMAN_BRIDGE_TOOL_ALLOWLIST = Object.freeze([
  'skill',
  'postman_send_current_turn',
  'postman_current_turn_status',
  'postman_ask_validate_reply',
])
export const POSTMAN_LEADER_PRESET_ID = 'postman-leader'
export const POSTMAN_LEADER_TOOL_ALLOWLIST = Object.freeze([
  'read',
  'glob',
  'grep',
  'skill',
  'web_fetch',
  'web_search',
  'postman_bridge',
])

export const POSTMAN_BRIDGE_PERSONA = `You are Postman Bridge, a minimal one-shot transport subagent.

You do not solve, redesign, expand, summarize, improve, or reinterpret the delegated task. The exact current user message is the transport message authored by your parent.

Protocol:
1. If the current message starts with exact @PostmanAsk, first load skill(delegate-via-postman-ask). If it starts with exact @Postman, first load skill(delegate-via-postman).
2. Then call postman_send_current_turn() with no arguments. Never copy the current user text into a tool argument, Base64, shell command, or another prompt.
3. Repeatedly call postman_current_turn_status() until the current Direct Postman request reaches a terminal result. Never start a second request.
4. For TEXT_RESULT_DURABLE, before your final response call postman_ask_validate_reply(request_id, text) with the exact assistantText and respond with exactly that text only after EXACT_REPLY_MATCH.
5. For artifact mode, report the terminal receipt without inventing continuation. Never call an automatic continuation tool.

You have no authority to choose a follow-up task. The parent Postman Leader decides whether to ask another question, continue with --chat, request an artifact, or stop.`

export function buildPostmanBridgeStartRequest({ parent, message, signal, transportKind }) {
  if (parent === undefined || parent === null) throw new Error('POSTMAN_BRIDGE_PARENT_REQUIRED')
  if (typeof message !== 'string' || message.length === 0) throw new Error('POSTMAN_BRIDGE_MESSAGE_REQUIRED')
  if (transportKind !== 'artifact' && transportKind !== 'text') throw new Error('POSTMAN_BRIDGE_MODE_INVALID')
  if (signal === undefined || signal === null) throw new Error('POSTMAN_BRIDGE_SIGNAL_REQUIRED')

  return {
    label: transportKind === 'text' ? 'Postman Ask Bridge' : 'Postman Artifact Bridge',
    prompt: [{ type: 'text', text: message }],
    parent,
    signal,
    agentOptions: { ...POSTMAN_BRIDGE_AGENT_OPTIONS },
    maxDepth: POSTMAN_BRIDGE_MAX_DEPTH,
    toolFilter: { allow: [...POSTMAN_BRIDGE_TOOL_ALLOWLIST] },
    persona: POSTMAN_BRIDGE_PERSONA,
  }
}

export function isTopLevelPostmanLeader(agent) {
  const header = agent?.session?.header
  const presets = agent?.ctx?.get?.('agentPresets')
  const composedPreset = typeof presets?.composedPreset === 'function'
    ? presets.composedPreset(agent.ctx)
    : undefined
  if ((composedPreset ?? header?.agentPreset) !== POSTMAN_LEADER_PRESET_ID) return false
  if (header?.origin === 'subagent') return false
  return (header?.delegationDepth ?? 0) === 0
}

export async function settleTrustedPostmanStatus(readStatus, signal) {
  if (typeof readStatus !== 'function') throw new Error('POSTMAN_BRIDGE_STATUS_READER_REQUIRED')
  let checks = 0
  while (true) {
    if (signal?.aborted) throw new Error('POSTMAN_BRIDGE_ABORTED')
    const status = await readStatus()
    checks += 1
    if (status?.status === 'RUNNING') continue
    if (status?.status === 'COMPLETED' || status?.status === 'FAILED') {
      if (status.result === undefined || status.result === null || typeof status.result !== 'object') {
        return {
          status: 'POSTMAN_BRIDGE_INVALID_TERMINAL',
          checks,
          requestId: status?.requestId ?? null,
        }
      }
      return {
        status: 'POSTMAN_BRIDGE_TERMINAL',
        checks,
        requestId: status.requestId ?? status.result.requestId ?? null,
        result: status.result,
      }
    }
    if (status?.status === 'NO_JOB') {
      return { status: 'POSTMAN_BRIDGE_NO_TRANSPORT', checks, requestId: null }
    }
    return {
      status: 'POSTMAN_BRIDGE_STATUS_INVALID',
      checks,
      requestId: status?.requestId ?? null,
      observedStatus: status?.status ?? null,
    }
  }
}
