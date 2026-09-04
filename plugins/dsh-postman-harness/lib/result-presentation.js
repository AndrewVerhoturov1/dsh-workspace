import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const textBlock = (text) => ({ type: 'text', text })

function atomicWriteJson(target, value) {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, target)
}

function presentationReceiptPath(publishedPath) {
  return path.join(path.dirname(publishedPath), 'result-presentation.json')
}

function readRetainedPublishedReceipt(publishedJson) {
  const publishedPath = fs.realpathSync(String(publishedJson))
  const value = JSON.parse(fs.readFileSync(publishedPath, 'utf8'))
  if (value?.ok !== true || value?.code !== 'PUBLISHED') throw new Error('published receipt must be successful PUBLISHED')
  if (value.worktreeRetained !== true || value.worktreeRemoved !== false) throw new Error('published receipt must retain worktree')
  if (typeof value.worktree !== 'string' || value.worktree === '') throw new Error('published receipt has no worktree')
  const worktree = fs.realpathSync(value.worktree)
  if (!fs.statSync(worktree).isDirectory()) throw new Error('published worktree is not a directory')
  return { publishedPath, value, worktree }
}

function serviceOf(ctx) {
  const service = typeof ctx.get === 'function' ? ctx.get('betterSidebarPresentation') : ctx.betterSidebarPresentation
  if (service === undefined || typeof service.present !== 'function' || typeof service.clear !== 'function') {
    throw new Error('betterSidebarPresentation service is unavailable')
  }
  return service
}

function sessionIdOf(exec) {
  if (exec?.agent === undefined) throw new Error('postman_result_present requires a calling Harness agent')
  const sessionId = exec.agent.session?.id ?? exec.agent.id
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('calling agent has no session id')
  return sessionId
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolveEntry(worktree, entryPath, kind) {
  if (kind === 'url') {
    let parsed
    try { parsed = new URL(entryPath) } catch { throw new Error('result URL is invalid') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('result URL must use http or https')
    return parsed.href
  }
  if (typeof entryPath !== 'string' || entryPath.trim() === '') throw new Error('entry_path is required')
  if (path.isAbsolute(entryPath)) throw new Error('entry_path must be relative to the retained worktree')
  const candidate = path.resolve(worktree, entryPath)
  if (!inside(worktree, candidate)) throw new Error('entry_path escapes retained worktree')
  const resolved = fs.realpathSync(candidate)
  if (!inside(worktree, resolved)) throw new Error('entry_path resolves outside retained worktree')
  const info = fs.statSync(resolved)
  if (kind === 'folder') {
    if (!info.isDirectory()) throw new Error('folder presentation target is not a directory')
  } else if (!info.isFile()) throw new Error('file/html presentation target is not a file')
  return resolved
}

export async function presentResult(ctx, publishedJson, options, targetSessionId) {
  const { publishedPath, value, worktree } = readRetainedPublishedReceipt(publishedJson)
  const kind = options.kind
  if (!['html', 'url', 'file', 'folder'].includes(kind)) throw new Error('unsupported result presentation kind')
  const target = resolveEntry(worktree, options.entry_path, kind)
  const delivered = await serviceOf(ctx).present({
    sessionId: targetSessionId,
    workspaceRoot: worktree,
    kind,
    target,
    ...(typeof options.title === 'string' && options.title.trim() !== '' ? { title: options.title.trim() } : {}),
  })
  const receiptPath = presentationReceiptPath(publishedPath)
  const result = {
    ok: true, status: 'RESULT_PRESENTED', requestId: value.requestId, prNumber: value.prNumber ?? null,
    commitSha: value.commitSha, worktree, targetSessionId, kind, target, title: options.title ?? null,
    delivered: delivered?.delivered === true, presentationId: delivered?.id ?? null,
    publishedJson: publishedPath, presentationJson: receiptPath, cleared: false,
  }
  atomicWriteJson(receiptPath, result)
  return result
}

export async function clearResultPresentation(ctx, publishedJson) {
  const { publishedPath, value, worktree } = readRetainedPublishedReceipt(publishedJson)
  const receiptPath = presentationReceiptPath(publishedPath)
  if (!fs.existsSync(receiptPath)) return { ok: true, status: 'RESULT_PRESENTATION_NOT_REGISTERED', requestId: value.requestId }
  const prior = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  if (prior?.requestId !== value.requestId || prior?.worktree !== worktree) throw new Error('result presentation receipt does not match published result')
  if (prior.cleared === true) return { ...prior, ok: true, status: 'RESULT_PRESENTATION_ALREADY_CLEARED' }
  let clearResult = null
  try {
    clearResult = await serviceOf(ctx).clear({ sessionId: prior.targetSessionId, workspaceRoot: worktree })
  } catch (error) {
    clearResult = { skipped: true, error: error instanceof Error ? error.message : String(error) }
  }
  const result = { ...prior, ok: true, status: 'RESULT_PRESENTATION_CLEARED', cleared: true, clearResult }
  atomicWriteJson(receiptPath, result)
  return result
}

export function createResultPresentationTool(ctx) {
  return defineTool({
    name: 'postman_result_present',
    description: 'Present an already PUBLISHED retained result in the calling user session Better Sidebar. UI presentation only: no Postman transport, REQ creation, browser automation or ORCA.',
    parameters: {
      published_json: { type: 'string', required: true, description: 'Absolute path to exact PUBLISHED receipt.' },
      kind: { type: 'string', required: true, description: 'html | url | file | folder' },
      entry_path: { type: 'string', required: true, description: 'For html/file/folder: worktree-relative path. For url: http(s) URL.' },
      title: { type: 'string', description: 'Optional sidebar tab title.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string', required: true } } },
      render: (_args, value) => [textBlock(JSON.stringify(value))],
    },
    async execute(args, exec) { return presentResult(ctx, args.published_json, args, sessionIdOf(exec)) },
  })
}
