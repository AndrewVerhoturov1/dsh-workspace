import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync, lstatSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { POSTMAN_INPUT_FILES_TOOL_NAME, postmanBridgeCallerAllowed } from './postman-bridge-core.js'

// Private roots have bounded abandoned cleanup; live owners are never removed.
function privateDirectory(kind) {
  const base = tmpdir(), prefix = 'dsh-postman-input-' + kind + '-'
  for (const name of readdirSync(base).filter(name => name.startsWith(prefix)).slice(0, 64)) {
    try {
      const path = join(base, name)
      if (lstatSync(path).isSymbolicLink()) continue
      const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'))
      if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
          !Number.isSafeInteger(owner.createdAt) || Date.now() - owner.createdAt < 86400000) continue
      try { process.kill(owner.pid, 0) } catch (error) {
        if (error.code === 'ESRCH') rmSync(path, { recursive: true, force: true })
      }
    } catch { /* best-effort, only our marked roots */ }
  }
  const path = mkdtempSync(join(base, prefix))
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ version: 1, pid: process.pid, createdAt: Date.now() }), { mode: 0o600 })
  return path
}
const removePrivate = path => { try { rmSync(path, { recursive: true, force: true }) } catch {} }

// Exact descriptors bind private byte snapshots. Pins are opaque process-local records,
// never reconstructed from model text or persisted as filesystem capabilities.
export class PostmanInputGrants {
  constructor() { this.owners = new Map(); this.pins = new Map(); this.children = new Map() }
  record(agent, context, result) {
    const owner = this.owners.get(agent.id)
    if (owner && (owner.context !== context || owner.agent !== agent)) this.release(owner.agent)
    if (!result.snapshotRoot || result.materializations?.length !== result.descriptors.length)
      throw new Error('POSTMAN_INPUT_MATERIALIZATION_MISSING')
    const current = this.owners.get(agent.id) ?? { agent, context, descriptors: new Map(), bundles: new Map() }
    const root = { path: result.snapshotRoot, refs: result.descriptors.length }
    const entries = result.descriptors.map((descriptor, index) => {
      const snapshot = result.materializations[index]
      if (snapshot.snapshot_path !== join(root.path, String(index + 1).padStart(3, '0') + '.bin') ||
          snapshot.sha256 !== descriptor.sha256 || snapshot.byte_length !== descriptor.byte_length)
        throw new Error('POSTMAN_INPUT_MATERIALIZATION_MISMATCH')
      // Trusted selection helper wrote these bytes; build checks the snapshot's
      // current hash/length immediately before packing, not again at admission.
      return [JSON.stringify(descriptor), { root, snapshot: Object.freeze({ ...snapshot }) }]
    })
    for (const [key, entry] of entries) {
      if (current.descriptors.has(key)) this.drop(current.descriptors.get(key))
      current.descriptors.set(key, entry)
    }
    if (result.bundle_id) current.bundles.set(result.bundle_id, entries.map(([key]) => key))
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
    for (const value of entries) {
      const entry = current.descriptors.get(value)
      if (entry) this.drop(entry)
      current.descriptors.delete(value)
    }
  }
  drop(entry) { if (--entry.root.refs === 0) removePrivate(entry.root.path) }
  release(agent) {
    const owner = this.owners.get(agent?.id)
    if (owner?.agent !== agent) return
    for (const entry of owner.descriptors.values()) this.drop(entry)
    this.owners.delete(agent.id)
  }
  releaseStale(agent, context) {
    const owner = this.owners.get(agent?.id)
    if (owner && owner.context !== context) this.release(owner.agent)
  }
  pin(agent, context, descriptors) {
    if (!this.owns(agent, context, descriptors)) throw new Error('POSTMAN_INPUT_PROVENANCE_REJECTED')
    const entries = descriptors.map(d => this.owners.get(agent.id).descriptors.get(JSON.stringify(d)))
    for (const entry of entries) entry.root.refs++
    const binding = Object.freeze({})
    this.pins.set(binding, { agent, context, entries, identity: JSON.stringify(descriptors) })
    return binding
  }
  bindChild(binding, parent, context, child) {
    const pin = this.pins.get(binding)
    if (!pin || pin.agent !== parent || pin.context !== context || this.children.has(child.id)) return false
    this.children.set(child.id, { binding, child })
    return true
  }
  child(agent, context, descriptors) {
    const child = this.children.get(agent.id), pin = this.pins.get(child?.binding)
    return child?.child === agent && pin?.context === context && pin.identity === JSON.stringify(descriptors)
      ? child.binding : null
  }
  unpin(binding) {
    const pin = this.pins.get(binding)
    if (!pin) return
    this.pins.delete(binding)
    for (const [id, child] of this.children) if (child.binding === binding) this.children.delete(id)
    for (const entry of pin.entries) this.drop(entry)
  }
  async build(binding, sessionId, requestId, descriptors) {
    const pin = this.pins.get(binding)
    if (!pin || this.children.get(sessionId)?.binding !== binding || pin.identity !== JSON.stringify(descriptors))
      throw new Error('POSTMAN_INPUT_PROVENANCE_REJECTED')
    const directory = privateDirectory('request')
    try {
      const spec = join(directory, 'input-build.json')
      writeFileSync(spec, JSON.stringify({ request_id: requestId, descriptors,
        materializations: pin.entries.map(entry => entry.snapshot) }), { mode: 0o600 })
      const result = await pythonCommand(HOST_ROOT, 'input_bundle.py', ['--build', spec])
      if (this.pins.get(binding) !== pin || this.children.get(sessionId)?.binding !== binding)
        throw new Error('POSTMAN_INPUT_PROVENANCE_REJECTED')
      rmSync(spec)
      if (result.requestId !== requestId || result.displayName !== 'POSTMAN_INPUT_' + requestId + '.zip' ||
          result.handoffPath !== join(directory, 'input-handoff.json')) throw new Error('POSTMAN_INPUT_BUNDLE_HANDOFF_INVALID')
      return { ...result, cleanup: () => removePrivate(directory) }
    } catch (error) { removePrivate(directory); throw error }
  }
  dispose() { for (const binding of this.pins.keys()) this.unpin(binding); for (const owner of this.owners.values()) this.release(owner.agent) }
}

export const postmanInputGrants = new PostmanInputGrants()
const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

export function pythonInputCommand(root, args) { return pythonCommand(root, 'input_files.py', args) }

function pythonCommand(root, script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'python' : 'python3',
      [join(root, 'postman', script), ...args], { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
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
      const snapshotRoot = args.action === 'cleanup' ? null : privateDirectory('snapshot')
      let retained = false
      try {
        // Source paths never leave this selection operation. Host chooses the private root.
        const result = await run(HOST_ROOT, snapshotRoot ? [...operation, '--snapshot-dir', snapshotRoot] : operation)
        if (contexts.get(agent.id) !== context || ctx.agents.get(agent.id) !== agent || exec.signal?.aborted)
          return { status: 'POSTMAN_INPUT_CONTEXT_CHANGED' }
        if (args.action === 'cleanup') {
          grants.cleaned(agent, args.bundleId)
          return { status: 'POSTMAN_INPUT_CLEANED', bundleId: args.bundleId, removed: result.removed }
        }
        const descriptors = result.descriptors
        if (!Array.isArray(descriptors) || !descriptors.length) return { status: 'POSTMAN_INPUT_HOST_INVALID_RESULT' }
        grants.record(agent, context, { descriptors, bundle_id: result.bundle_id, snapshotRoot, materializations: result.materializations })
        retained = true
        return { status: 'POSTMAN_INPUT_READY', descriptors, ...(result.bundle_id ? { bundleId: result.bundle_id } : {}) }
      } catch (error) {
        const code = String(error?.message ?? '')
        return { status: /^POSTMAN_INPUT_[A-Z_]+$/.test(code) ? code : 'POSTMAN_INPUT_HOST_FAILED' }
      } finally { if (snapshotRoot && !retained) removePrivate(snapshotRoot) }
    },
  })
}
