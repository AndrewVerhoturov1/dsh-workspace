import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const textBlock = (text) => ({ type: 'text', text })

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
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, target)
}

function workspaceReceiptPath(publishedPath) {
  return path.join(path.dirname(publishedPath), 'result-workspace.json')
}

export function readPublishedReceipt(publishedJson) {
  const receiptPath = fs.realpathSync(String(publishedJson))
  const value = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
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

export function resultWorkspaceTitle(value, worktree) {
  const suffix = path.basename(worktree)
  if (Number.isInteger(value.prNumber)) return `Postman PR #${value.prNumber} — ${suffix}`
  return `Postman ${value.requestId} — ${suffix}`
}

export async function registerResultWorkspace(ctx, publishedJson) {
  const { receiptPath, value, worktree } = readPublishedReceipt(publishedJson)
  if (!ctx.workspaceRegistry || typeof ctx.workspaceRegistry.create !== 'function') {
    throw new Error('Harness workspaceRegistry service is unavailable')
  }

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

export async function unregisterResultWorkspace(ctx, publishedJson) {
  const { receiptPath, value, worktree } = readPublishedReceipt(publishedJson)
  if (!ctx.workspaceRegistry || typeof ctx.workspaceRegistry.delete !== 'function') {
    throw new Error('Harness workspaceRegistry service is unavailable')
  }

  const sidecarPath = workspaceReceiptPath(receiptPath)
  if (!fs.existsSync(sidecarPath)) {
    throw new Error('result workspace registration receipt is missing')
  }
  const registration = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))
  if (registration?.status !== 'RESULT_WORKSPACE_REGISTERED' && registration?.status !== 'RESULT_WORKSPACE_UNREGISTERED') {
    throw new Error('result workspace registration receipt is invalid')
  }
  if (registration.requestId !== value.requestId || registration.worktree !== worktree) {
    throw new Error('result workspace registration receipt does not match published result')
  }
  if (typeof registration.workspaceId !== 'string' || registration.workspaceId.length === 0) {
    throw new Error('result workspace registration receipt has no workspaceId')
  }

  if (registration.workspaceRemoved !== true) {
    const existing = typeof ctx.workspaceRegistry.get === 'function'
      ? ctx.workspaceRegistry.get(registration.workspaceId)
      : undefined
    if (existing !== undefined || typeof ctx.workspaceRegistry.get !== 'function') {
      await ctx.workspaceRegistry.delete(registration.workspaceId)
    }
  }

  const result = {
    ...registration,
    ok: true,
    status: 'RESULT_WORKSPACE_UNREGISTERED',
    workspaceRemoved: true,
  }
  atomicWriteJson(sidecarPath, result)
  return result
}

export function createResultWorkspaceTools(ctx) {
  return [
    defineTool({
      name: 'postman_result_workspace_register',
      description: 'Register the retained exact PUBLISHED Postman worktree as a normal Harness Workspace. This does not create a copy and does not open a new browser or Session.',
      parameters: {
        published_json: { type: 'string', required: true, description: 'Absolute path to the request published.json receipt.' },
      },
      output: toolOutput(),
      async execute(args) {
        return registerResultWorkspace(ctx, args.published_json)
      },
    }),
    defineTool({
      name: 'postman_result_workspace_unregister',
      description: 'Remove only the Harness Workspace registration for one retained published Postman result. It does not delete the worktree or Session logs.',
      parameters: {
        published_json: { type: 'string', required: true, description: 'Absolute path to the request published.json receipt.' },
      },
      output: toolOutput(),
      async execute(args) {
        return unregisterResultWorkspace(ctx, args.published_json)
      },
    }),
  ]
}
