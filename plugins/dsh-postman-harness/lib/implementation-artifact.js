import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const IMPLEMENTATION_ARTIFACT_APPLY_TOOL_NAME = 'implementation_artifact_apply'
export const IMPLEMENTATION_REPOSITORY = 'AndrewVerhoturov1/dsh-workspace'
const REQUEST_ID = /^REQ_\d{8}T\d{6}Z_\d{4}$/
const SHA256 = /^[a-fA-F0-9]{64}$/
const execFileAsync = promisify(execFile)

export async function verifiedRepository(worktree) {
  try {
    const top = await execFileAsync('git', ['-C', worktree, 'rev-parse', '--show-toplevel'],
      { windowsHide: true, timeout: 30000 })
    if (top.stdout.trim().replaceAll('\\', '/').toLowerCase() !== worktree.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()) return false
    const { stdout } = await execFileAsync('git', ['-C', worktree, 'remote', 'get-url', 'origin'],
      { windowsHide: true, timeout: 30000 })
    const remote = stdout.trim().replaceAll('\\', '/')
    const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remote)
    return match?.[1].toLowerCase() === IMPLEMENTATION_REPOSITORY.toLowerCase()
  } catch { return false }
}

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

  async function register(leaderId, terminal) {
    const result = terminal?.result
    if (terminal?.status !== 'POSTMAN_BRIDGE_TERMINAL' || terminal.terminalStatus !== 'COMPLETED' ||
        typeof leaderId !== 'string' || leaderId === '' ||
        terminal.transportKind !== 'artifact' ||
        result?.ok !== true || result?.code !== 'RESULT_DURABLE' ||
        result?.state !== 'RESULT_DURABLE' ||
        !REQUEST_ID.test(result?.requestId ?? '') ||
        terminal.requestId !== result.requestId ||
        result.repository !== IMPLEMENTATION_REPOSITORY ||
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
      if (row.leaderSessionId !== leaderId || row.stage === 'closed') return row
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
    if (row?.leaderSessionId !== leaderId || row.stage === 'closed') return null
    const grant = row.artifactGrants?.[requestId]
    return grant?.requestId === requestId && grant.repository === IMPLEMENTATION_REPOSITORY &&
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
    description: 'Apply the trusted RESULT_DURABLE ZIP in the exact Leader-bound clean task worktree using the existing repository runner. Only the exact active Worker of its owning Leader may call this.',
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
      const operationLock = options.taskContexts?.beginOperation
      if (typeof operationLock === 'function' &&
          !operationLock(leaderId, id => Boolean(options.jobs?.hasActive(id)), caller.id)) {
        return { status: 'IMPLEMENTATION_ARTIFACT_WORKTREE_BUSY' }
      }
      let runnerOutcome
      try {
        if (typeof operationLock === 'function' &&
            !await worker.pauseForOperation(leaderId, caller.id))
          return { status: 'IMPLEMENTATION_ARTIFACT_WORKTREE_BUSY' }
        const grant = await grants.resolve(leaderId, args?.requestId)
        if (grant === null) return { status: 'IMPLEMENTATION_ARTIFACT_GRANT_REJECTED' }
        if (typeof args?.worktree !== 'string' || !isAbsolute(args.worktree)) {
          return { status: 'IMPLEMENTATION_ARTIFACT_WORKTREE_INVALID' }
        }
        const context = options.taskContexts?.get(leaderId)
        if (options.taskContexts && (!context || worker.contextOf(leaderId, caller.id) !== context ||
            resolve(args.worktree).replaceAll('\\', '/').toLowerCase() !==
            resolve(context.worktree).replaceAll('\\', '/').toLowerCase())) {
          return { status: 'IMPLEMENTATION_ARTIFACT_WORKTREE_REJECTED' }
        }
        if (options.taskContexts && !await options.taskContexts.verifyWorktree(leaderId)) {
          return { status: 'IMPLEMENTATION_ARTIFACT_WORKTREE_REJECTED' }
        }
        if (!await (options.verifiedRepository ?? verifiedRepository)(args.worktree)) {
          return { status: 'IMPLEMENTATION_ARTIFACT_REPOSITORY_REJECTED' }
        }
        // Persist intent before the runner can change files. A crash without a
        // trusted result remains unknown, never an authority for restore.
        await options.taskContexts?.startRunner?.(leaderId, args.requestId)
        runnerOutcome = await runImplementationPackage(grant, args.worktree, options)
        return runnerOutcome
      } finally { await options.taskContexts?.endOperation?.(leaderId, runnerOutcome) }
    },
  })
}
