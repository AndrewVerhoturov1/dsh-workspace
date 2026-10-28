import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const images = [
  ['dsh-session-persistence-jsonl', '8b6ebc4509a3e969ab3ad6e0dfb553ae4861e5b101831afed23e593d148d97f3', '22b987da1a66b00c2e83839f0b00b02fa8d2ea718e60c99f124b073bfb3506d5'],
  ['dsh-host-apiproxy', '8e32ffc951f499849c155e30cb30813af5ed7abb11008653125092299b693d9f', '5b161ce05078b26486a8713374f9c94310e186423d964d3cbbd426599f055845'],
  ['dsh-api-remotes', '5406e17c29e42b81ebb8c36030a67de3db19d4d94bace10052b924d72a10e756', '2512f74714aeddeaeeaa221ad52135fffa5fbf2493c0f84231f24dcb870c4f72'],
]
const hash = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex')

/** Install the pinned rc.2 overlays without mutating pnpm store hardlinks. */
export function applyHarnessSessionPerformance(sdkAnchor) {
  const resolve = createRequire(sdkAnchor)
  const prepared = []
  try {
    for (const [name, before, after] of images) {
      const path = realpathSync(resolve.resolve('@deepseek-ai/' + name))
      const original = readFileSync(path, 'utf8')
      const current = hash(original)
      if (current === after) continue
      if (current !== before) throw new Error('Session performance patch preimage mismatch: ' + path)
      const directory = mkdtempSync(join(dirname(path), '.session-performance-'))
      const relative = 'node_modules/@deepseek-ai/' + name + '/lib/index.js'
      const staged = join(directory, relative)
      prepared.push({ path, directory, staged, original })
      mkdirSync(dirname(staged), { recursive: true })
      writeFileSync(staged, original.replaceAll('\r\n', '\n'))
      const patch = join(directory, 'performance.patch')
      writeFileSync(patch, readFileSync(new URL('./harness-session-performance.patch', import.meta.url), 'utf8').replaceAll('\r\n', '\n'))
      const result = spawnSync('git', ['apply', '--include=' + relative, patch], {
        cwd: directory, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(directory) },
      })
      if (result.status !== 0) throw new Error('Session performance patch failed: ' + result.stderr)
      if (hash(readFileSync(staged, 'utf8')) !== after) throw new Error('Session performance patch output mismatch: ' + path)
      if (original.includes('\r\n')) writeFileSync(staged, readFileSync(staged, 'utf8').replaceAll('\n', '\r\n'))
    }
    // Validate all inputs before replacing any installed module.
    for (const item of prepared) {
      if (readFileSync(item.path, 'utf8') !== item.original) throw new Error('Session module changed during installation: ' + item.path)
    }
    const installed = []
    try {
      for (const item of prepared) { renameSync(item.staged, item.path); installed.push(item) }
    } catch (error) {
      for (const item of installed) {
        const rollback = join(item.directory, 'rollback.js')
        writeFileSync(rollback, item.original)
        renameSync(rollback, item.path)
      }
      throw error
    }
    return images.map(([name]) => realpathSync(resolve.resolve('@deepseek-ai/' + name)))
  } finally {
    for (const item of prepared) rmSync(item.directory, { recursive: true, force: true })
  }
}
