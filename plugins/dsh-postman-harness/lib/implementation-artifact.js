import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const IMPLEMENTATION_ARTIFACT_APPLY_TOOL_NAME = 'implementation_artifact_apply'
export const IMPLEMENTATION_REPOSITORY = 'AndrewVerhoturov1/dsh-workspace'
const REQUEST_ID = /^REQ_\d{8}T\d{6}Z_\d{4}$/
const SHA256 = /^[a-fA-F0-9]{64}$/
function output() {
  return {
    schema: { type: 'object', additionalProperties: true,
      properties: { status: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

// No repository paths are inferred from a REQ, resultRoot, Web prose or ZIP manifest.
async function verifiedZip(grant) {
  if (!grant || !isAbsolute(grant.resultZip)) return false
  try {
    const info = await stat(grant.resultZip)
    if (!info.isFile()) return false
    const bytes = await readFile(grant.resultZip)
    return createHash('sha256').update(bytes).digest('hex') === grant.sha256
  } catch {
    return false
  }
}

export function createImplementationArtifactGrants(registry) {
  if (typeof registry?.get !== 'function' || typeof registry?.change !== 'function')
    throw new Error('IMPLEMENTATION_ARTIFACT_STORAGE_REQUIRED')

  async function register(leaderId, terminal, binding = registry.get(leaderId)) {
    const result = terminal?.result
    const owner = registry.get(leaderId)
    if (owner?.leaderSessionId !== leaderId || terminal?.status !== 'POSTMAN_BRIDGE_TERMINAL' || terminal.terminalStatus !== 'COMPLETED' ||
        typeof leaderId !== 'string' || leaderId === '' ||
        terminal.transportKind !== 'artifact' ||
        result?.ok !== true || result?.code !== 'RESULT_DURABLE' ||
        result?.state !== 'RESULT_DURABLE' || result?.verified === false ||
        !REQUEST_ID.test(result?.requestId ?? '') ||
        terminal.requestId !== result.requestId ||
        typeof result.repository !== 'string' ||
        result.expectedFilename !== `POSTMAN_${result.requestId}_RESULT.zip` ||
        typeof result.resultZip !== 'string' || !isAbsolute(result.resultZip) ||
        !SHA256.test(result.sha256 ?? '')) return false
    const grant = Object.freeze({
      repository: result.repository, requestId: result.requestId,
      resultZip: result.resultZip, sha256: result.sha256.toLowerCase(),
      expectedFilename: result.expectedFilename,
    })
    if (!await verifiedZip(grant)) return false
    let registered = false
    await registry.change(leaderId, row => {
      if (row.leaderSessionId !== leaderId) return row
      const prior = row.artifactGrants?.[grant.requestId]
      if (prior !== undefined && (prior.sha256 !== grant.sha256 ||
          prior.resultZip !== grant.resultZip || prior.expectedFilename !== grant.expectedFilename ||
          prior.repository !== grant.repository)) return row
      registered = true
      return { ...row, artifactGrants: { ...row.artifactGrants, [grant.requestId]: grant } }
    })
    return registered
  }

  async function resolve(leaderId, requestId) {
    if (!REQUEST_ID.test(requestId ?? '')) return null
    const row = registry.get(leaderId)
    if (row?.leaderSessionId !== leaderId) return null
    const operation = Object.values(row.bridgeOperations ?? {}).find(op => op.requestId === requestId)
    if (operation?.executionRevoked || row.stage === 'closed' && !operation) return null
    let grant = row.artifactGrants?.[requestId]
    if (!grant && operation?.terminal) {
      // Explicit use may finish a grant write interrupted after terminal persistence.
      if (await register(leaderId, operation.terminal)) grant = registry.get(leaderId)?.artifactGrants?.[requestId]
    }
    return grant?.requestId === requestId &&
      grant.expectedFilename === `POSTMAN_${requestId}_RESULT.zip` && SHA256.test(grant.sha256 ?? '') &&
      await verifiedZip(grant) ? Object.freeze({ ...grant }) : null
  }

  return { register, resolve }
}

// Python owns package validation, patch application, tests and diagnostics.
export async function runImplementationPackage(grant, worktree, { python = 'python', runner = fileURLToPath(new URL('../../../system/implementation_package_runner.py', import.meta.url)), spawnProcess = spawn } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = ''
    let child
    try {
      child = spawnProcess(python, ['-X', 'utf8', runner, 'apply', grant.resultZip, '--repo', worktree],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ status: 'IMPLEMENTATION_ARTIFACT_RUNNER_FAILED', exitCode: null, diagnostic: String(error?.message ?? error) })
      return
    }
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', error => resolve({ status: 'IMPLEMENTATION_ARTIFACT_RUNNER_FAILED',
      exitCode: null, diagnostic: String(error.message) }))
    child.on('close', exitCode => {
      let result
      try { result = JSON.parse(stdout) } catch {
        resolve({ status: 'IMPLEMENTATION_ARTIFACT_RUNNER_INVALID', exitCode, stdout, stderr })
        return
      }
      resolve({ status: 'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT', exitCode, result,
        ...(stderr ? { stderr } : {}) })
    })
  })
}

export function createImplementationArtifactApplyTool(ctx, grants, worker, options = {}) {
  return defineTool({
    name: IMPLEMENTATION_ARTIFACT_APPLY_TOOL_NAME,
    description: 'Apply the trusted RESULT_DURABLE ZIP in the explicitly selected worktree using the existing repository runner. Only the exact active Worker of its owning Leader may call this.',
    parameters: {
      requestId: { type: 'string', required: true },
      worktree: { type: 'string', required: true },
    },
    output: output(),
    async execute(args, exec) {
      const caller = exec?.agent
      const leaderId = worker.ownerOf(caller, args?.requestId)
      if (leaderId === null || ctx.agents.get(caller.id) !== caller) {
        return { status: 'IMPLEMENTATION_ARTIFACT_CALLER_REJECTED' }
      }
      const grant = await grants.resolve(leaderId, args.requestId)
      if (!grant) return { status: 'IMPLEMENTATION_ARTIFACT_GRANT_REJECTED' }
      if (exec.signal?.aborted || ctx.agents.get(caller.id) !== caller) return { status: 'IMPLEMENTATION_ARTIFACT_CALLER_REJECTED' }
      return runImplementationPackage(grant, args.worktree, options)
    },
  })
}
