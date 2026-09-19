import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { clearResultPresentation } from './result-presentation.js'

const textBlock = (text) => ({ type: 'text', text })
const CANONICAL_REQ_RE = /^REQ_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_(\d{4})$/

function toolOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        status: { type: 'string', required: true },
      },
    },
    render: (_args, value) => [textBlock(JSON.stringify(value))],
  }
}

function atomicWriteJson(target, value) {
  const temp = target + '.' + process.pid + '.' + Date.now() + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(temp, target)
}

function samePath(left, right) {
  const normalize = (value) => {
    const normalized = path.normalize(value).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}

function isCanonicalRequestId(value) {
  if (typeof value !== 'string') return false
  const match = CANONICAL_REQ_RE.exec(value)
  if (!match) return false

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
}

function readJsonReceipt(receiptJson) {
  const receiptPath = fs.realpathSync(String(receiptJson))
  const value = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  return { receiptPath, value }
}

function requireFile(filePath, label) {
  if (!fs.statSync(filePath).isFile()) {
    throw new Error(label + ' is not a file')
  }
}

function workspaceReceiptPath(publishedPath) {
  return path.join(path.dirname(publishedPath), 'result-workspace.json')
}

function durableWorkspaceReceiptPath(resultDirectory) {
  return path.join(resultDirectory, 'result-workspace.json')
}

export function readPublishedReceipt(publishedJson) {
  const { receiptPath, value } = readJsonReceipt(publishedJson)
  if (value?.ok !== true || value?.code !== 'PUBLISHED') {
    throw new Error('published receipt must be a successful PUBLISHED result')
  }
  if (value.worktreeRemoved !== false || value.worktreeRetained !== true) {
    throw new Error('published result does not retain its task worktree')
  }
  if (typeof value.worktree !== 'string' || value.worktree.length === 0) {
    throw new Error('published result does not contain worktree')
  }
  const worktree = fs.realpathSync(value.worktree)
  if (!fs.statSync(worktree).isDirectory()) throw new Error('published worktree is not a directory')
  return { receiptPath, value, worktree }
}

export function readDurableReceipt(resultHandoffJson) {
  const { receiptPath, value } = readJsonReceipt(resultHandoffJson)
  if (value?.ok !== true || value?.code !== 'RESULT_DURABLE' || value?.state !== 'RESULT_DURABLE') {
    throw new Error('durable receipt must be an exact successful RESULT_DURABLE result')
  }
  if (!isCanonicalRequestId(value.requestId)) {
    throw new Error('durable receipt requestId is not canonical')
  }
  if (typeof value.resultRoot !== 'string' || value.resultRoot.length === 0) {
    throw new Error('durable receipt does not contain resultRoot')
  }
  const resultRoot = fs.realpathSync(value.resultRoot)
  if (!fs.statSync(resultRoot).isDirectory()) throw new Error('resultRoot is not a directory')

  if (typeof value.resultZip !== 'string' || value.resultZip.length === 0) {
    throw new Error('durable receipt does not contain resultZip')
  }
  const resultZip = fs.realpathSync(value.resultZip)
  requireFile(resultZip, 'resultZip')
  if (path.basename(resultZip) !== 'result.zip') {
    throw new Error('resultZip must be named result.zip')
  }

  const resultDirectory = path.dirname(resultZip)
  if (path.basename(resultDirectory) !== value.requestId) {
    throw new Error('resultDirectory must be named after requestId')
  }
  if (!samePath(path.dirname(resultDirectory), resultRoot)) {
    throw new Error('resultZip is outside resultRoot/requestId')
  }

  const manifestCandidate = path.join(resultDirectory, 'manifest.json')
  try {
    if (!fs.lstatSync(manifestCandidate).isFile()) {
      throw new Error('manifest.json is not a file')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const name of ['validation.json', 'metadata.json']) {
    const candidate = path.join(resultDirectory, name)
    if (!fs.existsSync(candidate)) throw new Error('durable result is missing ' + name)
    requireFile(candidate, name)
  }

  return { receiptPath, value, resultRoot, resultZip, resultDirectory }
}

export function resultWorkspaceTitle(value, worktree) {
  const suffix = path.basename(worktree)
  if (Number.isInteger(value.prNumber)) return 'Postman PR #' + value.prNumber + ' — ' + suffix
  return 'Postman ' + value.requestId + ' — ' + suffix
}

function normalizeInput(first, second) {
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    return {
      request_id: first.request_id,
      published_json: first.published_json,
      result_handoff_json: first.result_handoff_json,
    }
  }
  return { request_id: undefined, published_json: first, result_handoff_json: second }
}

function resolveReceiptInput(first, second) {
  const input = normalizeInput(first, second)
  const hasPublished = input.published_json !== undefined && input.published_json !== null
  const hasDurable = input.result_handoff_json !== undefined && input.result_handoff_json !== null
  if (hasPublished === hasDurable) {
    throw new Error('exactly one of published_json or result_handoff_json is required')
  }
  return hasPublished
    ? { source: 'PUBLISHED', path: input.published_json, requestId: input.request_id }
    : { source: 'RESULT_DURABLE', path: input.result_handoff_json, requestId: input.request_id }
}

function assertDurableRequestId(receipt, value) {
  if (!isCanonicalRequestId(receipt.requestId)) {
    throw new Error('request_id is required for RESULT_DURABLE and must be canonical')
  }
  if (value.requestId !== receipt.requestId) {
    throw new Error('durable receipt requestId does not match request_id')
  }
}

function requireWorkspaceRegistry(ctx, operation) {
  if (!ctx.workspaceRegistry || typeof ctx.workspaceRegistry[operation] !== 'function') {
    throw new Error('Harness workspaceRegistry service is unavailable for ' + operation)
  }
}

export async function registerResultWorkspace(ctx, input, resultHandoffJson) {
  const receipt = resolveReceiptInput(input, resultHandoffJson)
  if (receipt.source === 'PUBLISHED') {
    const { receiptPath, value, worktree } = readPublishedReceipt(receipt.path)
    requireWorkspaceRegistry(ctx, 'create')

    const title = resultWorkspaceTitle(value, worktree)
    const workspace = await ctx.workspaceRegistry.create(worktree, title)
    const workspaceId = typeof workspace?.id === 'string' ? workspace.id : undefined
    if (!workspaceId) throw new Error('workspaceRegistry.create did not return workspace.id')

    const sidecarPath = workspaceReceiptPath(receiptPath)
    const result = {
      ok: true,
      status: 'RESULT_WORKSPACE_REGISTERED',
      requestId: value.requestId,
      prNumber: value.prNumber ?? null,
      commitSha: value.commitSha,
      worktree,
      workspaceId,
      title,
      publishedJson: receiptPath,
      workspaceJson: sidecarPath,
      workspaceRemoved: false,
    }
    atomicWriteJson(sidecarPath, result)
    return result
  }

  const durable = readDurableReceipt(receipt.path)
  assertDurableRequestId(receipt, durable.value)
  const { receiptPath, value, resultRoot, resultZip, resultDirectory } = durable
  requireWorkspaceRegistry(ctx, 'create')

  const title = 'Postman ' + value.requestId + ' — result'
  const workspace = await ctx.workspaceRegistry.create(resultDirectory, title)
  const workspaceId = typeof workspace?.id === 'string' ? workspace.id : undefined
  if (!workspaceId) throw new Error('workspaceRegistry.create did not return workspace.id')

  const sidecarPath = durableWorkspaceReceiptPath(resultDirectory)
  const result = {
    ok: true,
    status: 'RESULT_WORKSPACE_REGISTERED',
    source: 'RESULT_DURABLE',
    requestId: value.requestId,
    resultRoot,
    resultDirectory,
    resultZip,
    workspaceId,
    title,
    resultHandoffJson: receiptPath,
    workspaceJson: sidecarPath,
    workspaceRemoved: false,
  }
  atomicWriteJson(sidecarPath, result)
  return result
}

function validateLegacyRegistration(registration, value, worktree) {
  if (registration?.status !== 'RESULT_WORKSPACE_REGISTERED' && registration?.status !== 'RESULT_WORKSPACE_UNREGISTERED') {
    throw new Error('result workspace registration receipt is invalid')
  }
  if (registration.requestId !== value.requestId || registration.worktree !== worktree) {
    throw new Error('result workspace registration receipt does not match published result')
  }
  if (typeof registration.workspaceId !== 'string' || registration.workspaceId.length === 0) {
    throw new Error('result workspace registration receipt has no workspaceId')
  }
}

function validateDurableRegistration(registration, receipt, sidecarPath) {
  if (registration?.status !== 'RESULT_WORKSPACE_REGISTERED' && registration?.status !== 'RESULT_WORKSPACE_UNREGISTERED') {
    throw new Error('result workspace registration receipt is invalid')
  }
  if (registration.source !== 'RESULT_DURABLE' ||
      registration.requestId !== receipt.value.requestId ||
      !samePath(registration.resultDirectory, receipt.resultDirectory) ||
      !samePath(registration.resultZip, receipt.resultZip) ||
      !samePath(registration.resultHandoffJson, receipt.receiptPath) ||
      !samePath(registration.workspaceJson, sidecarPath)) {
    throw new Error('result workspace registration receipt does not match durable result')
  }
  if (typeof registration.workspaceId !== 'string' || registration.workspaceId.length === 0) {
    throw new Error('result workspace registration receipt has no workspaceId')
  }
}

async function deleteWorkspaceRegistration(ctx, registration) {
  if (registration.workspaceRemoved !== true) {
    const existing = typeof ctx.workspaceRegistry.get === 'function'
      ? ctx.workspaceRegistry.get(registration.workspaceId)
      : undefined
    if (existing !== undefined || typeof ctx.workspaceRegistry.get !== 'function') {
      await ctx.workspaceRegistry.delete(registration.workspaceId)
    }
  }
}

export async function unregisterResultWorkspace(ctx, input, resultHandoffJson) {
  const receipt = resolveReceiptInput(input, resultHandoffJson)
  if (receipt.source === 'PUBLISHED') {
    const { receiptPath, value, worktree } = readPublishedReceipt(receipt.path)
    requireWorkspaceRegistry(ctx, 'delete')
    const sidecarPath = workspaceReceiptPath(receiptPath)
    if (!fs.existsSync(sidecarPath)) {
      throw new Error('result workspace registration receipt is missing')
    }
    const registration = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))
    validateLegacyRegistration(registration, value, worktree)
    await deleteWorkspaceRegistration(ctx, registration)
    await clearResultPresentation(ctx, receipt.path).catch(() => {})

    const result = {
      ...registration,
      ok: true,
      status: 'RESULT_WORKSPACE_UNREGISTERED',
      workspaceRemoved: true,
    }
    atomicWriteJson(sidecarPath, result)
    return result
  }

  const receiptValue = readDurableReceipt(receipt.path)
  assertDurableRequestId(receipt, receiptValue.value)
  requireWorkspaceRegistry(ctx, 'delete')
  const sidecarPath = durableWorkspaceReceiptPath(receiptValue.resultDirectory)
  if (!fs.existsSync(sidecarPath)) {
    throw new Error('result workspace registration receipt is missing')
  }
  const registration = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))
  validateDurableRegistration(registration, receiptValue, sidecarPath)
  await deleteWorkspaceRegistration(ctx, registration)

  const result = {
    ...registration,
    ok: true,
    status: 'RESULT_WORKSPACE_UNREGISTERED',
    workspaceRemoved: true,
  }
  atomicWriteJson(sidecarPath, result)
  return result
}

function receiptParameters() {
  return {
    request_id: {
      type: 'string',
      description: 'Exact current REQ. Required with result_handoff_json; not required with legacy published_json.',
    },
    published_json: {
      type: 'string',
      description: 'Absolute path to the request published.json receipt.',
    },
    result_handoff_json: {
      type: 'string',
      description: 'Absolute path to the exact RESULT_DURABLE handoff JSON.',
    },
  }
}

export function createResultWorkspaceTools(ctx) {
  return [
    defineTool({
      name: 'postman_result_workspace_register',
      description: 'Register one retained PUBLISHED result or exact RESULT_DURABLE result as a normal Harness Workspace. RESULT_DURABLE requires exact current request_id. This does not create a copy, unpack a ZIP, or open a new browser or Session.',
      parameters: receiptParameters(),
      output: toolOutput(),
      async execute(args) {
        return registerResultWorkspace(ctx, args)
      },
    }),
    defineTool({
      name: 'postman_result_workspace_unregister',
      description: 'Remove only the Harness Workspace registration for one PUBLISHED or RESULT_DURABLE result. RESULT_DURABLE requires exact current request_id. It does not delete the retained result directory, ZIP, worktree, or Session logs.',
      parameters: receiptParameters(),
      output: toolOutput(),
      async execute(args) {
        return unregisterResultWorkspace(ctx, args)
      },
    }),
  ]
}
