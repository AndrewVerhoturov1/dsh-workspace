const REQUEST_ID_PATTERN = /^REQ_\d{8}T\d{6}Z_\d{4}$/

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function confirmedRequirements(values) {
  if (values === undefined || values === null) return []
  if (!Array.isArray(values)) throw new Error('confirmedRequirements must be an array')
  return values.map((value, index) => {
    const text = requiredText(value, `confirmedRequirements[${index}]`).trim()
    if (/\r|\n/.test(text)) throw new Error(`confirmedRequirements[${index}] must be a single line`)
    return text
  })
}

function assertRequestId(requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('requestId must match REQ_YYYYMMDDTHHMMSSZ_NNNN')
  }
}

function assertPublishedTaskUrl(taskUrl, requestId) {
  const text = requiredText(taskUrl, 'taskUrl').trim()
  if (/[\u0000-\u001F\u007F]/.test(text)) throw new Error('taskUrl must not contain control characters')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('taskUrl must be an absolute HTTP(S) URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('taskUrl must be an absolute HTTP(S) URL')
  }
  const filename = decodeURIComponent(url.pathname.replace(/\/$/, '').split('/').pop() ?? '')
  if (filename !== `${requestId}.md`) {
    throw new Error('taskUrl must point to the exact request task filename')
  }
  return text
}

export function renderIntentTaskFile({ requestId, userIntent, confirmedRequirements: requirements } = {}) {
  assertRequestId(requestId)
  const intent = requiredText(userIntent, 'userIntent')
  const items = confirmedRequirements(requirements)
  let content = `# POSTMAN TASK\n\nuser_intent:\n${intent}\n`
  if (items.length > 0) content += `\nconfirmed_requirements:\n${items.map((item) => `- ${item}`).join('\n')}\n`
  return content
}

export function createTaskPackage(input = {}) {
  assertRequestId(input.requestId)
  const filename = `${input.requestId}.md`
  return {
    requestId: input.requestId,
    filename,
    content: renderIntentTaskFile(input),
  }
}

export async function createAndPublishTask(taskCreationBridge, input = {}) {
  const taskPackage = createTaskPackage(input)
  const publish = typeof taskCreationBridge === 'function'
    ? taskCreationBridge
    : taskCreationBridge?.publish ?? taskCreationBridge?.createAndPublish
  if (typeof publish !== 'function') throw new Error('task creation bridge is not configured')

  const published = await publish({
    ...taskPackage,
    userIntent: input.userIntent,
    confirmedRequirements: input.confirmedRequirements ?? [],
  })
  const taskUrl = typeof published === 'string'
    ? published
    : published?.taskUrl ?? published?.task_url
  return {
    ...taskPackage,
    taskUrl: assertPublishedTaskUrl(taskUrl, input.requestId),
  }
}

export function attachTaskUrl(record, taskUrl) {
  if (!taskUrl) {
    throw new Error('task_url required')
  }

  return {
    ...record,
    task_url: taskUrl,
    state: 'TASK_CREATED',
  }
}
