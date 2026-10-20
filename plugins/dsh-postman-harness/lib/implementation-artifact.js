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
const SHA40 = /^[a-f0-9]{40}$/
const execFileAsync = promisify(execFile)

export async function verifiedRepository(worktree, binding = {}) {
  try {
    const top = await execFileAsync('git', ['-C', worktree, 'rev-parse', '--show-toplevel'],
      { windowsHide: true, timeout: 30000 })
    if (top.stdout.trim().replaceAll('\\', '/').toLowerCase() !== worktree.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()) return false
    const { stdout } = await execFileAsync('git', ['-C', worktree, 'remote', 'get-url', 'origin'],
      { windowsHide: true, timeout: 30000 })
    const remote = stdout.trim().replaceAll('\\', '/')
    const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remote)
    const expected = binding.repository ?? IMPLEMENTATION_REPOSITORY
    return match?.[1].toLowerCase() === expected.toLowerCase() &&
      (!binding.originUrl || stdout.trim() === binding.originUrl)
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

  async function register(leaderId, terminal, binding = registry.get(leaderId)) {
    const result = terminal?.result
    const owner = registry.get(leaderId)
    const expectedRepository = owner?.universalProject ? owner.repository : IMPLEMENTATION_REPOSITORY
    if (owner?.bindingId !== binding?.bindingId || terminal?.status !== 'POSTMAN_BRIDGE_TERMINAL' || terminal.terminalStatus !== 'COMPLETED' ||
        typeof leaderId !== 'string' || leaderId === '' ||
        terminal.transportKind !== 'artifact' ||
        result?.ok !== true || result?.code !== 'RESULT_DURABLE' ||
        result?.state !== 'RESULT_DURABLE' || result?.verified === false ||
        result?.unresolvedSendUnknown === true || result?.applyEligible === false ||
        !REQUEST_ID.test(result?.requestId ?? '') ||
        terminal.requestId !== result.requestId ||
        result.repository?.toLowerCase() !== expectedRepository?.toLowerCase() ||
        result.expectedFilename !== `POSTMAN_${result.requestId}_RESULT.zip` ||
        typeof result.resultZip !== 'string' || !isAbsolute(result.resultZip) ||
        !SHA256.test(result.sha256 ?? '')) return false
    if (owner?.universalProject &&
        (result.branch !== owner.branch || !SHA40.test(result.taskPublicationCommit ?? '') ||
         result.taskUrl !== 'https://raw.githubusercontent.com/' + owner.repository + '/' +
           result.taskPublicationCommit + '/' + result.requestId + '.md')) return false
    const grant = Object.freeze({
      repository: result.repository, requestId: result.requestId,
      resultZip: result.resultZip, sha256: result.sha256.toLowerCase(),
      expectedFilename: result.expectedFilename,
    })
    if (!await verifiedZip(grant)) return false
    let registered = false
    await registry.change(leaderId, row => {
      if (row.leaderSessionId !== leaderId || row.stage === 'closed' || row.bindingId !== binding?.bindingId) return row
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
    const expectedRepository = row.universalProject ? row.repository : IMPLEMENTATION_REPOSITORY
    return grant?.requestId === requestId && grant.repository?.toLowerCase() === expectedRepository?.toLowerCase() &&
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
          !operationLock(leaderId)) {
        return { status: 'IMPLEMENTATION_ARTIFACT_WORKTREE_BUSY' }
      }
      let runnerOutcome
      try {
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
        // New local-first projects have no published REQ by default. An
        // artifact grant, unlike ordinary Devspace edits, requires the exact
        // remote task HEAD to be proven before the runner may touch files.
        if (context?.universalProject &&
            !await options.taskContexts.verifyDirectPublication?.(leaderId))
          return { status: 'IMPLEMENTATION_ARTIFACT_WORKTREE_REJECTED' }
        if (context && grant.repository.toLowerCase() !== context.repository.toLowerCase())
          return { status: 'IMPLEMENTATION_ARTIFACT_REPOSITORY_REJECTED' }
        if (!await (options.verifiedRepository ?? verifiedRepository)(args.worktree,
          context ? { repository: context.repository,
            originUrl: options.taskContexts?.record?.(leaderId)?.originUrl ?? context.originUrl } : {})) {
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
