#!/usr/bin/env node
// Apply the small first-step boundary correction to the installed DSH agent loop.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const version = '0.1.1-rc.2'
const fragment = 'if (phase.step > 0 && this.inbox.nextTurn.length > 0) {'
const replacement = 'if (this.inbox.nextTurn.length > 0) { // AGENT_MESSAGE_ROUND_BOUNDARY_V1'

export function patchSource(source) {
  if (source.includes(replacement)) {
    if (source.split(replacement).length !== 2 || source.includes(fragment))
      throw new Error('DSH agent-loop patched fragment is ambiguous')
    return source
  }
  if (source.split(fragment).length !== 2) throw new Error('DSH agent-loop fragment does not match')
  return source.replace(fragment, replacement)
}

export async function overlay(root, action, backupDir) {
  const pkg = join(root, 'node_modules', '@deepseek-ai', 'dsh-agent-loop')
  const metadata = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
  if (metadata.name !== '@deepseek-ai/dsh-agent-loop' || metadata.version !== version)
    throw new Error('DSH agent-loop version does not match ' + version)
  const file = join(pkg, 'lib', 'index.js')
  const original = await readFile(file, 'utf8')
  const patched = patchSource(original)
  if (action === '--verify') return { status: patched === original ? 'APPLIED' : 'NOT_APPLIED', file }
  if (action !== '--apply' || !backupDir) throw new Error('Use --apply --backup-dir <directory> or --verify')
  if (patched === original) return { status: 'ALREADY_APPLIED', file }
  await mkdir(backupDir, { recursive: true })
  const backup = join(backupDir, 'dsh-agent-loop-index.js')
  // Never overwrite an earlier backup: applying to a newer installation must fail instead.
  await copyFile(file, backup, constants.COPYFILE_EXCL)
  await writeFile(file, patched, 'utf8')
  return { status: 'APPLIED', file, backup }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = flag => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1] }
  const root = option('--root')
  const action = process.argv.includes('--apply') ? '--apply' : '--verify'
  if (!root) throw new Error('--root <installed DSH directory> is required')
  overlay(resolve(root), action, option('--backup-dir')).then(result => {
    console.log(JSON.stringify(result))
    if (result.status === 'NOT_APPLIED') process.exitCode = 1
  }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
