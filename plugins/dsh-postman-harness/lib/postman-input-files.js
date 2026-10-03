import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
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

// Shared by Leader selection and standalone trusted current-turn orchestration.
const topLevel = agent => !!agent && agent.session?.header?.origin !== 'subagent' &&
  (agent.session?.header?.delegationDepth ?? 0) === 0

// Only live exact human messages confer current-attachment authority; never replay
// model text or session exports. Keep handles/metadata, not attachment bytes.
export class CurrentAttachmentStore {
  constructor(ctx) {
    this.ctx = ctx
    this.records = new Map()
    // Process-local ordinals are never reused across messages/sessions in this store.
    this.nextSelectionId = 1n
    this.stop = ctx.on('session/event', (session, event) => this.capture(session, event))
  }
  capture(session, event) {
    if (event?.type !== 'user/message' || event.data?.role !== 'user' || event.data?.source?.kind !== 'user') return
    const agent = this.ctx.agents.get(session?.id)
    if (!topLevel(agent) || agent.session !== session) return
    const attachments = []
    for (const block of Array.isArray(event.data.content) ? event.data.content : []) {
      if (block?.type === 'text') continue
      // Every non-text occurrence counts, even when the installed Host cannot read it.
      // Unsupported metadata is display-only: never resolve it or interpret it as a path.
      const ref = block?.attachment
      const image = block?.type === 'image' && ref && Object.hasOwn(IMAGE_EXTENSIONS, ref.mediaType)
      const file = block?.type === 'file' && ref && typeof this.ctx.attachments?.readFile === 'function'
      const supported = image || file
      attachments.push(Object.freeze({ selectionId: String(this.nextSelectionId++),
        ...(supported ? { ref, attachmentId: ref.attachmentId, mediaType: ref.mediaType,
          bytes: ref.bytes, width: ref.width, height: ref.height, ...(ref.name !== undefined ? { name: ref.name } : {}) }
          : { supported: false, capabilityStatus: CURRENT_UNAVAILABLE,
              ...(typeof ref?.name === 'string' ? { name: ref.name } : {}),
              ...(typeof ref?.mediaType === 'string' ? { mediaType: ref.mediaType } : {}) }) }))
    }
    this.records.set(session.id, Object.freeze({ session, seq: Number.isSafeInteger(event.seq) ? event.seq : -1,
      attachments: Object.freeze(attachments) }))
  }
  get(agent) {
    const record = this.records.get(agent.id)
    return record?.session === agent.session ? record : undefined
  }
  release(agent) {
    if (this.get(agent)) this.records.delete(agent.id)
  }
  dispose() { this.stop?.(); this.records.clear() }
}

const CURRENT_UNAVAILABLE = 'POSTMAN_INPUT_CURRENT_ATTACHMENT_UNAVAILABLE'
const CURRENT_MISMATCH = 'POSTMAN_INPUT_CURRENT_ATTACHMENT_MISMATCH'
const MAX_INPUT_BYTES = 48 * 1024 * 1024, MAX_AGGREGATE_BYTES = 144 * 1024 * 1024
const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

function attachmentSourceName(ref, index) {
  const extension = IMAGE_EXTENSIONS[ref.mediaType]
  const name = ref.name ?? (extension ? 'attachment-' + index + '.' + extension : 'attachment-' + index + '.bin')
  // Preserve admissible original names exactly; never interpret a display name
  // as a path (including Windows drives/ADS/reserved names on any platform).
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 180 ||
      /[\\/<>#`:"|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error(CURRENT_MISMATCH)
  return name
}

// Exact descriptors bind private byte snapshots. Pins are opaque process-local records,
// never reconstructed from model text or persisted as filesystem capabilities.
async function resolveCurrentAttachment(ctx, ref, signal) {
  if (IMAGE_EXTENSIONS[ref.mediaType]) return ctx.attachments.readImage(ref, signal)
  if (typeof ctx.attachments?.readFile !== 'function') throw new Error(CURRENT_UNAVAILABLE)
  return ctx.attachments.readFile(ref, signal)
}

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
  async build(binding, sessionId, requestId, descriptors, transportKind = 'artifact') {
    const pin = this.pins.get(binding)
    if (!pin || this.children.get(sessionId)?.binding !== binding || pin.identity !== JSON.stringify(descriptors))
      throw new Error('POSTMAN_INPUT_PROVENANCE_REJECTED')
    const directory = privateDirectory('request')
    try {
      const spec = join(directory, 'input-build.json')
      writeFileSync(spec, JSON.stringify({ request_id: requestId, descriptors, image: transportKind === 'image',
        materializations: pin.entries.map(entry => entry.snapshot) }), { mode: 0o600 })
      const result = await pythonCommand(HOST_ROOT, 'input_bundle.py', ['--build', spec])
      if (this.pins.get(binding) !== pin || this.children.get(sessionId)?.binding !== binding)
        throw new Error('POSTMAN_INPUT_PROVENANCE_REJECTED')
      rmSync(spec)
      const imageNames = descriptors.length === 1 ? [result.displayName] : result.names
      const validImages = Array.isArray(imageNames) && imageNames.length === descriptors.length && imageNames.every((name,index) =>
        typeof name === 'string' && new RegExp('^POSTMAN_REFERENCE_' + requestId + (descriptors.length > 1 ? '_' + (index+1) : '') + '\\.(png|jpg|webp|gif)$').test(name))
      if (result.requestId !== requestId || (transportKind === 'image' ? !validImages : result.displayName !== 'POSTMAN_INPUT_' + requestId + '.zip') ||
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

// Same private stage path as the Leader tool; caller authority comes from exact
// current-turn capture, not model arguments. The record is also the grant context.
export async function stageStandaloneCurrentAttachments(ctx, agent, record, currentAttachments, signal, grants = postmanInputGrants) {
  if (!topLevel(agent) || ctx.agents.get(agent.id) !== agent || currentAttachments.get(agent) !== record)
    return { status: CURRENT_MISMATCH }
  return snapshotInputs(ctx, { get: id => id === agent.id ? currentAttachments.get(agent) : undefined },
    { action: 'stage_current_attachments', ...(record.attachments.length > 1 && record.attachments.every(item=>item.ref)
        ? {selectionIds:record.attachments.map(item=>item.selectionId)} : {}) }, { agent, signal }, { grants, run: pythonInputCommand,
      currentAttachments, resolveAttachment: (ref, abort) => resolveCurrentAttachment(ctx, ref, abort) })
}

async function snapshotInputs(ctx, contexts, args, exec, { grants, run, currentAttachments, resolveAttachment }) {
  const agent = exec.agent
  const context = contexts.get(agent.id)
  if (!context) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
  if (exec.signal?.aborted) return { status: 'POSTMAN_INPUT_ABORTED' }
  const keys = Object.keys(args ?? {}).sort().join(',')
  let operation, selected, current
  if (args.action === 'describe_existing' && keys === 'action,commit,path,repository' &&
      args.repository === 'AndrewVerhoturov1/dsh-workspace' && typeof args.commit === 'string' && typeof args.path === 'string')
    operation = ['--existing', args.commit, args.path]
  else if (args.action === 'stage' && keys === 'action,paths' && Array.isArray(args.paths) &&
      args.paths.length >= 1 && args.paths.length <= 20 && args.paths.every(path => typeof path === 'string' && path.length > 0))
    operation = ['--stage', ...args.paths]
  else if (args.action === 'stage_current_attachments' && (keys === 'action' || keys === 'action,selectionIds')) {
    const ids = args.selectionIds
    if (ids !== undefined && (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 ||
        ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length))
      return { status: 'POSTMAN_INPUT_ARGUMENTS_INVALID' }
    current = currentAttachments?.get(agent)
    if (!current?.attachments.length) return { status: CURRENT_UNAVAILABLE, reason: 'Installed Host supports current images through readImage only; provide an explicit local file path.' }
    if (ids === undefined && current.attachments.length > 1)
      return { status: 'POSTMAN_INPUT_CURRENT_ATTACHMENT_SELECTION_REQUIRED',
        attachments: current.attachments.map(({ ref, ...metadata }) => metadata) }
    const wanted = ids ?? [current.attachments[0].selectionId]
    const occurrences = wanted.map(id => current.attachments.find(occurrence => occurrence.selectionId === id))
    if (occurrences.some(item => !item)) return { status: CURRENT_MISMATCH }
    if (occurrences.some(item => !item.ref)) return { status: CURRENT_UNAVAILABLE,
      reason: 'Installed Host supports current images through readImage only; provide an explicit local file path.' }
    selected = occurrences.map(item => item.ref)
  }
  else if (args.action === 'cleanup' && keys === 'action,bundleId' && typeof args.bundleId === 'string') {
    const owned = grants.bundle(agent, context, args.bundleId)
    if (owned === undefined) return { status: 'POSTMAN_INPUT_BUNDLE_NOT_OWNED' }
    if (owned === null) return { status: 'POSTMAN_INPUT_ALREADY_CLEANED', bundleId: args.bundleId }
    const removed = owned.length
    grants.cleaned(agent, args.bundleId)
    return { status: 'POSTMAN_INPUT_CLEANED', bundleId: args.bundleId, removed }
  } else return { status: 'POSTMAN_INPUT_ARGUMENTS_INVALID' }
  let snapshotRoot, sourceRoot, retained = false
  try {
    if (selected) {
      let total = 0
      const sources = []
      // Validate the complete selection before resolving any bytes.
      for (const [index, ref] of selected.entries()) {
        attachmentSourceName(ref, index + 1)
        if (!Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) throw new Error(CURRENT_MISMATCH)
        total += ref.bytes
        if (ref.bytes > MAX_INPUT_BYTES || total > MAX_AGGREGATE_BYTES)
          throw new Error('POSTMAN_INPUT_BUNDLE_LIMIT_EXCEEDED')
      }
      sourceRoot = privateDirectory('source')
      for (const [index, ref] of selected.entries()) {
        let resolved
        try { resolved = await resolveAttachment(ref, exec.signal) }
        catch (error) { throw new Error(error?.code === 'ATTACHMENT_CORRUPT' ? CURRENT_MISMATCH : CURRENT_UNAVAILABLE) }
        if (currentAttachments.get(agent) !== current) throw new Error(CURRENT_MISMATCH)
        const data = resolved?.data
        if (!(data instanceof Uint8Array) || data.byteLength !== ref.bytes ||
            (/^sha256:[0-9a-f]{64}$/.test(ref.attachmentId) &&
             createHash('sha256').update(data).digest('hex') !== ref.attachmentId.slice(7)))
          throw new Error(CURRENT_MISMATCH)
        const directory = join(sourceRoot, String(index + 1))
        mkdirSync(directory, { mode: 0o700 })
        const path = join(directory, attachmentSourceName(ref, index + 1))
        writeFileSync(path, data, { mode: 0o600, flag: 'wx' })
        sources.push(path)
      }
      if (contexts.get(agent.id) !== context || ctx.agents.get(agent.id) !== agent || exec.signal?.aborted)
        return { status: 'POSTMAN_INPUT_CONTEXT_CHANGED' }
      if (currentAttachments.get(agent) !== current) throw new Error(CURRENT_MISMATCH)
      operation = ['--stage', ...sources]
    }
    snapshotRoot = privateDirectory('snapshot')
    // Source paths never leave this selection operation. Host chooses the private root.
    const result = await run(HOST_ROOT, [...operation, '--snapshot-dir', snapshotRoot])
    if (contexts.get(agent.id) !== context || ctx.agents.get(agent.id) !== agent || exec.signal?.aborted)
      return { status: 'POSTMAN_INPUT_CONTEXT_CHANGED' }
    if (selected && currentAttachments.get(agent) !== current) throw new Error(CURRENT_MISMATCH)
    const descriptors = result.descriptors
    if (!Array.isArray(descriptors) || !descriptors.length) return { status: 'POSTMAN_INPUT_HOST_INVALID_RESULT' }
    grants.record(agent, context, { descriptors, bundle_id: result.bundle_id, snapshotRoot, materializations: result.materializations })
    retained = true
    return { status: 'POSTMAN_INPUT_READY', descriptors, ...(result.bundle_id ? { bundleId: result.bundle_id } : {}) }
  } catch (error) {
    const code = String(error?.message ?? '')
    return { status: /^POSTMAN_INPUT_[A-Z_]+$/.test(code) ? code : 'POSTMAN_INPUT_HOST_FAILED' }
  } finally {
    if (sourceRoot) removePrivate(sourceRoot)
    if (snapshotRoot && !retained) removePrivate(snapshotRoot)
  }
}

export function createPostmanInputFilesTool(ctx, contexts, { grants = postmanInputGrants, run = pythonInputCommand, currentAttachments,
  resolveAttachment = (ref, signal) => resolveCurrentAttachment(ctx, ref, signal) } = {}) {
  return defineTool({
    name: POSTMAN_INPUT_FILES_TOOL_NAME,
    description: 'Privately snapshot exact current attachments or selected local files; locate filename metadata; pack, list or safely unpack selected ZIPs. Existing GitHub sources are read-only. Never publishes input bytes.',
    parameters: {
      action: { type: 'string', required: true, enum: ['describe_existing', 'stage', 'stage_current_attachments', 'cleanup', 'locate', 'pack', 'list', 'unpack'] },
      repository: { type: 'string', description: 'Existing file repository; only AndrewVerhoturov1/dsh-workspace is supported.' },
      commit: { type: 'string', description: 'Exact existing GitHub commit.' },
      path: { type: 'string', description: 'Repository-relative path of the existing file.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Explicit absolute paths to selected regular files.' },
      selectionIds: { type: 'array', items: { type: 'string' }, description: 'Exact Host occurrence selectors from this Leader latest user message; omit only for a single attachment.' },
      bundleId: { type: 'string', description: 'Exact bundle ID returned by stage in this Leader task context.' },
      filename: { type: 'string', description: 'Exact or near filename for bounded metadata search.' },
      source: { type: 'string', description: 'Explicit absolute ZIP path for list/unpack.' },
      destination: { type: 'string', description: 'Explicit absolute new ZIP path for pack or new directory for unpack; never overwrite.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: { status: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const agent = exec?.agent
      if (!postmanBridgeCallerAllowed(agent) || ctx.agents.get(agent.id) !== agent)
        return { status: 'POSTMAN_INPUT_CALLER_REJECTED' }
      if (['locate', 'pack', 'list', 'unpack'].includes(args.action)) {
        const keys = Object.keys(args).sort().join(',')
        let operation
        if (args.action === 'locate' && keys === 'action,filename' && typeof args.filename === 'string') {
          const cwd = agent.session?.header?.cwd
          if (typeof cwd !== 'string' || !cwd) return { status:'POSTMAN_INPUT_CONTEXT_UNAVAILABLE' }
          const roots = [cwd, ...['Downloads','Desktop','Documents'].map(name => join(homedir(),name))]
          const result = await pythonCommand(HOST_ROOT,'archive_operations.py',['locate','--name',args.filename,'--roots',...roots])
          const current = currentAttachments?.get(agent)
          if (current?.attachments) result.attachments = current.attachments.filter(item => item.name?.toLowerCase() === args.filename.toLowerCase())
            .map(({ref,...metadata}) => metadata)
          return result
        }
        if (args.action === 'pack' && keys === 'action,destination,paths' && Array.isArray(args.paths) &&
            args.paths.length >= 1 && args.paths.length <= 20 && args.paths.every(p => typeof p === 'string') && typeof args.destination === 'string')
          operation = ['pack','--paths',...args.paths,'--destination',args.destination]
        if (args.action === 'list' && keys === 'action,source' && typeof args.source === 'string')
          operation = ['list','--source',args.source]
        if (args.action === 'unpack' && keys === 'action,destination,source' && typeof args.source === 'string' && typeof args.destination === 'string')
          operation = ['unpack','--source',args.source,'--destination',args.destination]
        if (!operation) return { status:'POSTMAN_INPUT_ARGUMENTS_INVALID' }
        return pythonCommand(HOST_ROOT,'archive_operations.py',operation)
      }
      return snapshotInputs(ctx, contexts, args, exec, { grants, run, currentAttachments, resolveAttachment })
    },
  })
}
