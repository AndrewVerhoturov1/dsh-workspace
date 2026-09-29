#!/usr/bin/env node
// Reversible compatibility correction for the installed dsh-subagent 0.1.1-rc.2.
// Apply only offline after a version AND exact source fingerprint check.
import { readFile, writeFile, mkdir, copyFile, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const version = '0.1.1-rc.2'
const fingerprint = '555AB9189CC4BAA7CD2B527099B932497310A6A609798A4D5CFF30FA89349C5A'
const sha = text => createHash('sha256').update(text).digest('hex').toUpperCase()
async function replaceWithoutMutatingLinks(file, content) {
  const temporary = `${file}.overlay-${randomUUID()}`
  try {
    await copyFile(file, temporary, constants.COPYFILE_EXCL)
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
const replaceOnce = (source, oldText, newText) => {
  if (source.split(oldText).length !== 2) throw new Error('dsh-subagent fragment does not match')
  return source.replace(oldText, newText)
}
export function patchSubagentSource(source) {
  if (sha(source) !== fingerprint) throw new Error('dsh-subagent SHA-256 mismatch')
  let next = replaceOnce(source,
    'const { end, droppedUnrun } = foldConsumedWork(events);\n\tswitch (end?.data.reason.kind) {',
    'const { end, droppedUnrun } = foldConsumedWork(events);\n\tconst lastStart = events.findLastIndex(event => event.type === "turn/start");\n\tconst lastEnd = events.findLastIndex(event => event.type === "turn/end");\n\tif (lastStart > lastEnd) return "error";\n\tswitch (end?.data.reason.kind) {')
  next = replaceOnce(next,
    'case void 0:\n\t\tcase "completed": return droppedUnrun ? "aborted" : "completed";',
    'case void 0: return events.some(event => event.type === "turn/start") || droppedUnrun ? "error" : "completed";\n\t\tcase "completed": return droppedUnrun ? "aborted" : "completed";')
  next = replaceOnce(next,
    'const output = finalAssistantOutput(own);',
    'const lastStart = own.findLastIndex(event => event.type === "turn/start");\n\t\t\tconst latest = lastStart < 0 ? void 0 : own.slice(lastStart).findLast(event => event.type === "assistant/message");\n\t\t\tconst finalBlocks = latest?.data.message.content?.filter(block => block.type === "text" && block.text.trim());\n\t\t\tconst output = finalBlocks?.length ? finalBlocks : void 0;')
  // Exact-child close shares followup's child lock and retains a process-local cutoff.
  next = replaceOnce(next,
    "\tactivations = /* @__PURE__ */ new Map();\n\t/** Materializations admitted before drain",
    "\tactivations = /* @__PURE__ */ new Map();\n\tclosedChildren = /* @__PURE__ */ new Set();\n\t/** Materializations admitted before drain")
  next = replaceOnce(next,
    "\tasync followup(parent, childId, content, options) {\n\t\tthis.assertAdmitting(parent);",
    "\tasync followup(parent, childId, content, options) {\n\t\tthis.assertAdmitting(parent);\n\t\tthis.assertChildOpen(childId);")
  next = replaceOnce(next,
    "\t\t\tconst live = await this.locks.run(childId, async () => {\n\t\t\t\tconst activation = this.activations.get(childId);",
    "\t\t\tconst live = await this.locks.run(childId, async () => {\n\t\t\t\tthis.assertChildOpen(childId);\n\t\t\t\tconst activation = this.activations.get(childId);")
  next = replaceOnce(next,
    "\t\t\tthis.assertAdmitting(parent);\n\t\t\toptions.signal.throwIfAborted();",
    "\t\t\tthis.assertAdmitting(parent);\n\t\t\tthis.assertChildOpen(childId);\n\t\t\toptions.signal.throwIfAborted();")
  next = replaceOnce(next,
    "\tasync drainChildren(parent, childIds) {",
    "\tassertChildOpen(childId) {\n\t\tif (this.closedChildren.has(childId)) throw new SubagentError(`subagent \"${childId}\" is closed; the message was not accepted`, \"ACTIVATION_CLOSING\");\n\t}\n\tasync closeChild(parent, childId, verify) {\n\t\tif (this.ctx.agents.get(parent.id) !== parent) throw new SubagentError(\"selected child close requires the exact live parent agent\", \"UNAUTHORIZED\");\n\t\tconst result = await this.locks.run(childId, async () => {\n\t\t\tthis.assertChildOpen(childId);\n\t\t\tthis.assertAdmitting(parent);\n\t\t\tconst resident = this.activations.get(childId);\n\t\t\tif (resident === void 0) {\n\t\t\t\tconst saved = await this.requirePersistence().inspect(childId);\n\t\t\t\tthis.authorizeLineage(parent, childId, saved.meta.parentSession);\n\t\t\t} else if (resident.parentSession !== parent.id || !resident.ancestry.has(parent)) {\n\t\t\t\tthrow new SubagentError(\"selected child belongs to another parent\", \"UNAUTHORIZED\");\n\t\t\t}\n\t\t\tif (!await verify()) return { closed: false };\n\t\t\tthis.assertAdmitting(parent);\n\t\t\tthis.assertChildOpen(childId);\n\t\t\tconst activation = this.activations.get(childId);\n\t\t\tif (activation !== void 0 && (activation.parentSession !== parent.id || !activation.ancestry.has(parent))) throw new SubagentError(\"selected child belongs to another parent\", \"UNAUTHORIZED\");\n\t\t\tthis.closedChildren.add(childId);\n\t\t\treturn { closed: true, disposal: activation === void 0 ? void 0 : this.dispose(activation) };\n\t\t});\n\t\tif (!result.closed) return false;\n\t\tif (result.disposal !== void 0) await result.disposal;\n\t\treturn true;\n\t}\n\tasync drainChildren(parent, childIds) {")
  next = replaceOnce(next,
    "\tasync drainContinuableChildren(parent, childIds) {\n\t\tconst manager = this.continuations;",
    "\tasync closeContinuableChild(parent, childId, verify) {\n\t\tconst manager = this.continuations;\n\t\tif (manager === void 0) throw new SubagentError(\"continuation manager unavailable\", \"NOT_RESUMABLE\");\n\t\treturn manager.closeChild(parent, childId, verify);\n\t}\n\tasync drainContinuableChildren(parent, childIds) {\n\t\tconst manager = this.continuations;")
  return next
}
export async function subagentOverlay(root, action, backupDir) {
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-subagent')
  const metadata = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
  if (metadata.name !== '@deepseek-ai/dsh-subagent' || metadata.version !== version)
    throw new Error('dsh-subagent version mismatch')
  const file = join(pkg, 'lib', 'index.js')
  const original = await readFile(file, 'utf8')
  if (action === '--rollback') {
    if (!backupDir) throw new Error('Use --rollback --backup-dir')
    const backup = join(backupDir, 'dsh-subagent-index.js')
    const saved = await readFile(backup, 'utf8')
    if (sha(saved) !== fingerprint || sha(original) !== sha(patchSubagentSource(saved)))
      throw new Error('dsh-subagent rollback SHA-256 mismatch')
    await replaceWithoutMutatingLinks(file, saved)
    return { status: 'ROLLED_BACK', file, fingerprint }
  }
  const patched = patchSubagentSource(original)
  if (action === '--verify') return { status: 'COMPATIBLE_NOT_APPLIED', file, fingerprint }
  if (action !== '--apply' || !backupDir) throw new Error('Use --apply --backup-dir or --verify')
  await mkdir(backupDir, { recursive: true })
  const backup = join(backupDir, 'dsh-subagent-index.js')
  await copyFile(file, backup, constants.COPYFILE_EXCL)
  await replaceWithoutMutatingLinks(file, patched)
  return { status: 'APPLIED', file, backup, patchedHash: sha(patched) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1] }
  subagentOverlay(resolve(option('--root') ?? '.'),
    process.argv.includes('--rollback') ? '--rollback' : process.argv.includes('--apply') ? '--apply' : '--verify',
    option('--backup-dir'))
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1 })
}
