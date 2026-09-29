#!/usr/bin/env node
// Reversible compatibility correction for the installed dsh-subagent 0.1.1-rc.2.
// Apply only offline after a version AND exact source fingerprint check.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const version = '0.1.1-rc.2'
const fingerprint = '80ADB031F9BFA27CE173F16BFDF4780B590E1A915E3553B05ABA62187496E036'
const sha = text => createHash('sha256').update(text).digest('hex').toUpperCase()
const replaceOnce = (source, oldText, newText) => {
  if (source.split(oldText).length !== 2) throw new Error('dsh-subagent fragment does not match')
  return source.replace(oldText, newText)
}
export function patchSubagentSource(source) {
  if (sha(source) !== fingerprint) throw new Error('dsh-subagent SHA-256 mismatch')
  let next = replaceOnce(source,
    'case void 0:\n\t\tcase "completed": return droppedUnrun ? "aborted" : "completed";',
    'case void 0: return events.some(event => event.type === "turn/start") || droppedUnrun ? "error" : "completed";\n\t\tcase "completed": return droppedUnrun ? "aborted" : "completed";')
  next = replaceOnce(next,
    'const output = finalAssistantOutput(own);',
    'const lastStart = own.findLastIndex(event => event.type === "turn/start");\n\t\t\tconst output = lastStart < 0 ? void 0 : finalAssistantOutput(own.slice(lastStart).filter(event => event.type === "assistant/message" && event.data.message.content.some(block => block.type === "text" && block.text.trim())).map(event => ({ ...event, data: { ...event.data, message: { ...event.data.message, content: event.data.message.content.filter(block => block.type === "text" && block.text.trim()) } } })));')
  return next
}
export async function subagentOverlay(root, action, backupDir) {
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-subagent')
  const metadata = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
  if (metadata.name !== '@deepseek-ai/dsh-subagent' || metadata.version !== version)
    throw new Error('dsh-subagent version mismatch')
  const file = join(pkg, 'lib', 'index.js')
  const original = await readFile(file, 'utf8')
  const patched = patchSubagentSource(original)
  if (action === '--verify') return { status: 'COMPATIBLE_NOT_APPLIED', file, fingerprint }
  if (action !== '--apply' || !backupDir) throw new Error('Use --apply --backup-dir or --verify')
  await mkdir(backupDir, { recursive: true })
  const backup = join(backupDir, 'dsh-subagent-index.js')
  await copyFile(file, backup, constants.COPYFILE_EXCL)
  await writeFile(file, patched, 'utf8')
  return { status: 'APPLIED', file, backup, patchedHash: sha(patched) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1] }
  subagentOverlay(resolve(option('--root') ?? '.'), process.argv.includes('--apply') ? '--apply' : '--verify', option('--backup-dir'))
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1 })
}
