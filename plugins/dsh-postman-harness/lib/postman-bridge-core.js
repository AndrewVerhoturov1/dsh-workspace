export const POSTMAN_BRIDGE_PROVIDER = 'spawn'
export const POSTMAN_BRIDGE_TOOL_NAME = 'postman_bridge'
export const POSTMAN_BRIDGE_STATUS_TOOL_NAME = 'postman_bridge_status'
export const POSTMAN_CHILD_NOTIFY_TOOL_NAME = 'notify_parent'
export const POSTMAN_TASK_PREPARE_TOOL_NAME = 'postman_task_prepare'
export const POSTMAN_TASK_RESTORE_TOOL_NAME = 'postman_task_restore'
export const POSTMAN_WORKER_TOOL_NAME = 'postman_worker'
export const POSTMAN_WORKER_INTERRUPT_TOOL_NAME = 'postman_worker_interrupt'
export const POSTMAN_WORKER_STOP_TOOL_NAME = 'postman_worker_stop'
export const POSTMAN_YIELD_TOOL_NAME = 'postman_yield'
export const POSTMAN_INPUT_FILES_TOOL_NAME = 'postman_input_files'
export const POSTMAN_WORKER_LIST_TOOL_NAME = 'postman_worker_list'
export const POSTMAN_BRIDGE_AGENT_OPTIONS = Object.freeze({
  provider: 'codex',
  model: 'gpt-6-luna',
})
export const POSTMAN_BRIDGE_MAX_DEPTH = 1
export const POSTMAN_BRIDGE_TOOL_ALLOWLIST = Object.freeze([
  'skill',
  'postman_send_current_turn',
  'postman_current_turn_status',
  'postman_ask_validate_reply',
  POSTMAN_CHILD_NOTIFY_TOOL_NAME,
])
export const POSTMAN_LEADER_PRESET_ID = 'postman-leader'
export const POSTMAN_PTC_LEADER_PRESET_ID = 'postman-leader-ptc'
export const POSTMAN_PTC_TOOL_NAME = 'ptc_execute'
export const POSTMAN_LEADER_TOOL_ALLOWLIST = Object.freeze([
  'ask_user_question',
  'todo_write',
  'exit_plan_mode',
  'create_goal',
  'get_goal',
  'update_goal',
  'read',
  'read_image',
  'grep',
  'skill',
  'web_fetch',
  POSTMAN_TASK_PREPARE_TOOL_NAME,
  POSTMAN_TASK_RESTORE_TOOL_NAME,
  POSTMAN_INPUT_FILES_TOOL_NAME,
  POSTMAN_BRIDGE_TOOL_NAME,
  POSTMAN_BRIDGE_STATUS_TOOL_NAME,
  POSTMAN_WORKER_TOOL_NAME,
  POSTMAN_WORKER_INTERRUPT_TOOL_NAME,
  POSTMAN_WORKER_STOP_TOOL_NAME,
  POSTMAN_YIELD_TOOL_NAME,
  POSTMAN_WORKER_LIST_TOOL_NAME,
])
// Ordinary visibility stays intact for nested QuickJS → ToolRuntime dispatch.
// These operations are not model-direct for the exact experimental Leader.
export const POSTMAN_PTC_ONLY_LEADER_TOOLS = Object.freeze(POSTMAN_LEADER_TOOL_ALLOWLIST.filter(
  name => !['skill', 'ask_user_question', 'exit_plan_mode', 'read_image', POSTMAN_YIELD_TOOL_NAME].includes(name),
))

export const POSTMAN_WORKER_PTC_TOOL_NAMES = Object.freeze(['read', 'glob', 'grep', 'web_fetch', 'web_search', 'write', 'edit'])

export function postmanPtcDirectCallGuard(exec, lookupAgent, ownsPtcWorker = () => false) {
  return lookupAgent(exec.agent?.id) === exec.agent && exec.parent === undefined &&
    ((isTopLevelPostmanPtcLeader(exec.agent) && POSTMAN_PTC_ONLY_LEADER_TOOLS.includes(exec.name)) ||
      (ownsPtcWorker(exec.agent) && POSTMAN_WORKER_PTC_TOOL_NAMES.includes(exec.name)))
    ? 'POSTMAN_PTC_DIRECT_CALL_REJECTED: use ptc_execute' : undefined
}

export const POSTMAN_LEADER_ONLY_TOOL_NAMES = Object.freeze([
  POSTMAN_TASK_PREPARE_TOOL_NAME,
  POSTMAN_TASK_RESTORE_TOOL_NAME,
  POSTMAN_INPUT_FILES_TOOL_NAME,
  POSTMAN_BRIDGE_TOOL_NAME,
  POSTMAN_BRIDGE_STATUS_TOOL_NAME,
  POSTMAN_WORKER_TOOL_NAME,
  POSTMAN_WORKER_INTERRUPT_TOOL_NAME,
  POSTMAN_WORKER_STOP_TOOL_NAME,
  POSTMAN_YIELD_TOOL_NAME,
  POSTMAN_WORKER_LIST_TOOL_NAME,
])

export const POSTMAN_BRIDGE_PERSONA = `You are Postman Bridge, a minimal one-shot transport subagent.

You do not solve, redesign, expand, summarize, improve, or reinterpret the delegated task. The exact current user message is the transport message authored by your parent.

Protocol:
1. If the current message starts with exact @PostmanAsk, first load skill(delegate-via-postman-ask). If it starts with exact @PostmanImage, first load skill(delegate-via-postman-image). If it starts with exact @Postman, first load skill(delegate-via-postman).
2. Then call postman_send_current_turn() with no arguments. Never copy the current user text into a tool argument, Base64, shell command, or another prompt.
3. While waiting, you may call notify_parent({message: ...}) for a factual intermediate update. Never present your message as a trusted result. Repeatedly call postman_current_turn_status() until the current Direct Postman request reaches a terminal result. Never start a second request.
4. For TEXT_RESULT_DURABLE, inspect deliveryMode. If deliveryMode=inline, call postman_ask_validate_reply(request_id, text) with the exact assistantText and respond with exactly that text only after EXACT_REPLY_MATCH. If deliveryMode=file, do not call postman_ask_validate_reply, do not read or reconstruct resultFile, and finish with only a compact acknowledgement containing the trusted requestId/resultFile metadata. The bridge host reads the trusted terminal directly; your prose is not result authority.
5. For image mode, report IMAGE_RESULT_DURABLE with the trusted resultImage descriptor; never read or reconstruct the image, register it as an implementation artifact, or request continuation. For artifact mode, report the terminal receipt without inventing continuation. Never call an automatic continuation tool.

Native ChatGPT attachment is the primary input-file transport. Never publish a user/local input to GitHub merely so ChatGPT can read it when native attachment delivery is available. GitHub public staging is fallback-only and requires explicit user approval.
Visual references are native image attachments whenever Host can resolve their bytes. Inputs are already Host-authorized: do not publish inputs, construct attachments, use manual raw_url fallback, or perform browser upload. GitHub fallback is only a separately approved Host/Leader decision.

You have no authority to choose a follow-up task. The parent Postman Leader decides whether to ask another question, continue with --chat, request an artifact, or stop.`

export function buildPostmanBridgeStartRequest({ parent, message, signal, transportKind }) {
  if (parent === undefined || parent === null) throw new Error('POSTMAN_BRIDGE_PARENT_REQUIRED')
  if (typeof message !== 'string' || message.length === 0) throw new Error('POSTMAN_BRIDGE_MESSAGE_REQUIRED')
  if (!['artifact', 'text', 'image'].includes(transportKind)) throw new Error('POSTMAN_BRIDGE_MODE_INVALID')
  if (signal === undefined || signal === null) throw new Error('POSTMAN_BRIDGE_SIGNAL_REQUIRED')

  return {
    label: transportKind === 'text' ? 'Postman Ask Bridge' : transportKind === 'image' ? 'Postman Image Bridge' : 'Postman Artifact Bridge',
    prompt: [{ type: 'text', text: message }],
    parent,
    signal,
    agentOptions: { ...POSTMAN_BRIDGE_AGENT_OPTIONS },
    maxDepth: POSTMAN_BRIDGE_MAX_DEPTH,
    toolFilter: { allow: [...POSTMAN_BRIDGE_TOOL_ALLOWLIST] },
    persona: POSTMAN_BRIDGE_PERSONA,
  }
}

function topLevelPostmanPreset(agent) {
  const header = agent?.session?.header
  const presets = agent?.ctx?.get?.('agentPresets')
  const composedPreset = typeof presets?.composedPreset === 'function'
    ? presets.composedPreset(agent.ctx)
    : undefined
  if (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) !== 0) return null
  return composedPreset ?? header?.agentPreset
}

export function isTopLevelPostmanLeader(agent) {
  return topLevelPostmanPreset(agent) === POSTMAN_LEADER_PRESET_ID
}

export function isTopLevelPostmanPtcLeader(agent) {
  return topLevelPostmanPreset(agent) === POSTMAN_PTC_LEADER_PRESET_ID
}

export function isTopLevelPostmanSupervisor(agent) {
  const preset = topLevelPostmanPreset(agent)
  return preset === POSTMAN_LEADER_PRESET_ID || preset === POSTMAN_PTC_LEADER_PRESET_ID
}

export function postmanBridgeCallerAllowed(agent) {
  return isTopLevelPostmanSupervisor(agent)
}

export function postmanBridgeRestrictionForAgent(agent, ownsPtcWorker = () => false) {
  if (isTopLevelPostmanPtcLeader(agent)) {
    return { allow: [...POSTMAN_LEADER_TOOL_ALLOWLIST, POSTMAN_PTC_TOOL_NAME] }
  }
  if (isTopLevelPostmanLeader(agent)) {
    return { allow: [...POSTMAN_LEADER_TOOL_ALLOWLIST] }
  }
  return { deny: ownsPtcWorker(agent) ? [...POSTMAN_LEADER_ONLY_TOOL_NAMES] :
    [...POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_PTC_TOOL_NAME] }
}

export function createPostmanBridgeBoundaryManager(lookupAgent, ownsPtcWorker = () => false) {
  if (typeof lookupAgent !== 'function') throw new Error('POSTMAN_BRIDGE_AGENT_LOOKUP_REQUIRED')
  const active = new Map()

  const install = (agent) => {
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id === '') {
      throw new Error('POSTMAN_BRIDGE_BOUNDARY_AGENT_REQUIRED')
    }
    if (typeof agent.ctx?.tools?.restrict !== 'function') {
      throw new Error('POSTMAN_BRIDGE_TOOL_RESTRICTION_REQUIRED')
    }

    const dispose = agent.ctx.tools.restrict(postmanBridgeRestrictionForAgent(agent, ownsPtcWorker))
    if (typeof dispose !== 'function') throw new Error('POSTMAN_BRIDGE_TOOL_RESTRICTION_DISPOSER_REQUIRED')

    const previous = active.get(agent.id)
    try {
      previous?.dispose()
    } catch (error) {
      dispose()
      throw error
    }
    active.set(agent.id, { agent, dispose })
    return isTopLevelPostmanSupervisor(agent)
  }

  const refreshSession = (sessionId) => {
    const agent = lookupAgent(sessionId)
    if (agent === undefined) return false
    install(agent)
    return true
  }

  const disposeAgent = (agent) => {
    const current = active.get(agent?.id)
    if (current === undefined || current.agent !== agent) return false
    active.delete(agent.id)
    current.dispose()
    return true
  }

  const disposeAll = () => {
    const current = [...active.values()]
    active.clear()
    for (const entry of current) entry.dispose()
  }

  return { install, refreshSession, disposeAgent, disposeAll }
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
        terminalStatus: status.status,
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
