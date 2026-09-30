import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { POSTMAN_INPUT_FILES_TOOL_NAME, postmanBridgeCallerAllowed } from './postman-bridge-core.js'

// Process-local provenance: descriptors and bundle ownership belong to one exact Leader
// and its prepared task context. No file bytes enter the model or the Bridge.
export class PostmanInputGrants {
  constructor() { this.owners = new Map() }
  record(agent, context, result) {
    const owner = this.owners.get(agent.id)
    if (owner && (owner.context !== context || owner.agent !== agent)) this.owners.delete(agent.id)
    const current = this.owners.get(agent.id) ?? { agent, context, descriptors: new Set(), bundles: new Map() }
    current.agent = agent
    for (const descriptor of result.descriptors) current.descriptors.add(JSON.stringify(descriptor))
    if (result.bundle_id) current.bundles.set(result.bundle_id, result.descriptors.map(item => JSON.stringify(item)))
    this.owners.set(agent.id, current)
  }
  owns(agent, context, descriptors) {
    const current = this.owners.get(agent?.id)
    return !!context && current?.agent === agent && current.context === context &&
      descriptors.every(item => current.descriptors.has(JSON.stringify(item)))
  }
  bundle(agent, context, id) {
    const current = this.owners.get(agent?.id)
    return current?.agent === agent && current.context === context ? current.bundles.get(id) : undefined
  }
  cleaned(agent, id) {
    const current = this.owners.get(agent.id)
    const entries = current?.bundles.get(id)
    if (!entries) return
    current.bundles.set(id, null)
    for (const value of entries) current.descriptors.delete(value)
  }
  release(agent) {
    if (this.owners.get(agent?.id)?.agent === agent) this.owners.delete(agent.id)
  }
}

export const postmanInputGrants = new PostmanInputGrants()
const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export function pythonInputCommand(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'python' : 'python3',
      [join(root, 'postman', 'input_files.py'), ...args], { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 65536) child.kill() })
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 4096) stderr = stderr.slice(-4096) })
    child.on('error', reject)
    child.on('close', code => {
      try {
        const value = JSON.parse(stdout)
        if (code !== 0 || value.error) reject(new Error(value.error ?? stderr ?? 'input helper failed'))
        else resolve(value)
      } catch (error) { reject(error) }
    })
  })
}

export function createPostmanInputFilesTool(ctx, contexts, { grants = postmanInputGrants, run = pythonInputCommand } = {}) {
  return defineTool({
    name: POSTMAN_INPUT_FILES_TOOL_NAME,
    description: 'Describe an existing immutable GitHub file, stage exact selected local files, or clean up your own staged bundle.',
    parameters: {
      action: { type: 'string', required: true, enum: ['describe_existing', 'stage', 'cleanup'] },
      repository: { type: 'string', description: 'Existing file repository; only AndrewVerhoturov1/dsh-workspace is supported.' },
      commit: { type: 'string', description: 'Exact existing GitHub commit.' },
      path: { type: 'string', description: 'Repository-relative path of the existing file.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Explicit absolute paths to selected regular files.' },
      bundleId: { type: 'string', description: 'Exact bundle ID returned by stage in this Leader task context.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const agent = exec?.agent
      if (!postmanBridgeCallerAllowed(agent) || ctx.agents.get(agent.id) !== agent)
        return { status: 'POSTMAN_INPUT_CALLER_REJECTED' }
      const context = contexts.get(agent.id)
      if (!context) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
      if (exec.signal?.aborted) return { status: 'POSTMAN_INPUT_ABORTED' }
      const keys = Object.keys(args ?? {}).sort().join(',')
      let operation
      if (args.action === 'describe_existing' && keys === 'action,commit,path,repository' &&
          args.repository === 'AndrewVerhoturov1/dsh-workspace' && typeof args.commit === 'string' && typeof args.path === 'string')
        operation = ['--existing', args.commit, args.path]
      else if (args.action === 'stage' && keys === 'action,paths' && Array.isArray(args.paths) &&
          args.paths.length >= 1 && args.paths.length <= 20 && args.paths.every(path => typeof path === 'string' && path.length > 0))
        operation = ['--stage', ...args.paths]
      else if (args.action === 'cleanup' && keys === 'action,bundleId' && typeof args.bundleId === 'string') {
        const owned = grants.bundle(agent, context, args.bundleId)
        if (owned === undefined) return { status: 'POSTMAN_INPUT_BUNDLE_NOT_OWNED' }
        if (owned === null) return { status: 'POSTMAN_INPUT_ALREADY_CLEANED', bundleId: args.bundleId }
        operation = ['--cleanup', args.bundleId]
      } else return { status: 'POSTMAN_INPUT_ARGUMENTS_INVALID' }
      try {
        // Use the trusted session checkout, not any model-supplied executable/path.
        const result = await run(HOST_ROOT, operation)
        if (contexts.get(agent.id) !== context || ctx.agents.get(agent.id) !== agent)
          return { status: 'POSTMAN_INPUT_CONTEXT_CHANGED' }
        if (args.action === 'cleanup') {
          grants.cleaned(agent, args.bundleId)
          return { status: 'POSTMAN_INPUT_CLEANED', bundleId: args.bundleId, removed: result.removed }
        }
        const descriptors = args.action === 'stage' ? result.descriptors : [result]
        if (!Array.isArray(descriptors) || !descriptors.length) return { status: 'POSTMAN_INPUT_HOST_INVALID_RESULT' }
        grants.record(agent, context, { descriptors, bundle_id: result.bundle_id })
        return { status: 'POSTMAN_INPUT_READY', descriptors, ...(result.bundle_id ? { bundleId: result.bundle_id } : {}) }
      } catch (error) { return { status: 'POSTMAN_INPUT_HOST_FAILED', diagnostic: String(error?.message ?? error) } }
    },
  })
}
