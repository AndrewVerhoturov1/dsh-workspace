import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve as absolute } from 'node:path'
import { spawnSync } from 'node:child_process'

const images = [
  [
    "dsh-session-persistence-jsonl",
    "22b987da1a66b00c2e83839f0b00b02fa8d2ea718e60c99f124b073bfb3506d5",
    "d316f5869b0674d56ac16a034b90606af0dbda6d56c017522009b50e47beccb3"
  ],
  [
    "dsh-workspace",
    "d53e71d931937066ff20440afcff911ced09cefb8a0f3d024348b0e5248d4c74",
    "6c03263a6d0ccf017d40069815cd83bb334a567d708d1c2fbee66b6a48cce2df"
  ],
  [
    "dsh-host-apiproxy",
    "5b161ce05078b26486a8713374f9c94310e186423d964d3cbbd426599f055845",
    "06eea3fe3dd0b8297379682df8c3402de2f11177621c1a5479faa1b4e00adcf4"
  ]
]

const hash = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex')

/** Install the pinned rc.2 overlays without mutating pnpm store hardlinks. */
export function applyHarnessArchiveIdle(sdkAnchor) {
  const resolve = createRequire(sdkAnchor)
  const prepared = []
  try {
    for (const [name, before, after] of images) {
      const path = realpathSync(resolve.resolve('@deepseek-ai/' + name))
      const original = readFileSync(path, 'utf8')
      const current = hash(original)
      if (current === after) continue
      if (current !== before) throw new Error('Archive idle patch preimage mismatch: ' + path)
      const directory = mkdtempSync(join(dirname(path), '.archive-idle-'))
      const relative = 'node_modules/@deepseek-ai/' + name + '/lib/index.js'
      const staged = join(directory, relative)
      prepared.push({ path, directory, staged, original })
      mkdirSync(dirname(staged), { recursive: true })
      writeFileSync(staged, original.replaceAll('\r\n', '\n'))
      const patch = join(directory, 'performance.patch')
      writeFileSync(patch, readFileSync(new URL('./harness-archive-idle.patch', import.meta.url), 'utf8').replaceAll('\r\n', '\n'))
      const result = spawnSync('git', ['apply', '--unidiff-zero', '--include=' + relative, patch], {
        cwd: directory, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(directory) },
      })
      if (result.status !== 0) throw new Error('Archive idle patch failed: ' + result.stderr)
      if (hash(readFileSync(staged, 'utf8')) !== after) throw new Error('Archive idle patch output mismatch: ' + path)
      if (original.includes('\r\n')) writeFileSync(staged, readFileSync(staged, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))
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
    for (const item of prepared) {
      if (dirname(absolute(item.directory)) !== dirname(absolute(item.path)) || !basename(item.directory).startsWith('.archive-idle-'))
        throw new Error('Unexpected archive patch staging directory')
      rmSync(item.directory, { recursive: true, force: true })
    }
  }
}
