import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export function applyPostmanNativeChildCutoff(anchors) {
  const patch = fileURLToPath(new URL('./postman-native-child-cutoff.patch', import.meta.url))
  const targets = new Map()
  for (const anchor of anchors) {
    const native = createRequire(createRequire(anchor).resolve('@deepseek-ai/dsh-subagent'))
    for (const name of ['dsh-subagent', 'dsh-session']) {
      const path = realpathSync(native.resolve('@deepseek-ai/' + name))
      targets.set(path, 'node_modules/@deepseek-ai/' + name + '/lib/index.js')
    }
  }
  // The first anchor is the actual CLI SDK (or isolated SDK fixture), not
  // the plugin's optional development dependency tree.
  const goalPath = realpathSync(createRequire(anchors[0]).resolve('@deepseek-ai/dsh-goal-round-driver'))
  const goalRelative = 'node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js'
  const goalImages = {
    before: '95f68fdb41a96082df3ae0dab2fb27a80de7bf57b1cc147651d0ff7a8f1a1af8',
    after: 'ddddc089e626116da257dfa6a35bae83080d1f931a6df04edd3e8bf442ee64b1',
  }
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  if (![goalImages.before, goalImages.after].includes(digest(goalPath)))
    throw new Error('Native goal continuation patch preimage mismatch: ' + goalPath)
  targets.set(goalPath, goalRelative)
  const prepared = []
  try {
    for (const [path, relative] of targets) {
      // Same-volume private copy: git never traverses pnpm symlinks or mutates store hardlinks.
      const directory = mkdtempSync(join(dirname(path), '.postman-cutoff-'))
      prepared.push({ path, directory })
      const staged = join(directory, relative)
      mkdirSync(dirname(staged), { recursive: true }); copyFileSync(path, staged)
      const normalizedPatch = join(directory, 'cutoff.patch')
      const targetPatch = relative === goalRelative ? new URL('./postman-native-goal-continuation.patch', import.meta.url) : patch
      writeFileSync(normalizedPatch, readFileSync(targetPatch, 'utf8').replaceAll('\r', ''))
      const apply = args => spawnSync('git', ['-c', 'core.longpaths=true', 'apply', '--include=' + relative, ...args, normalizedPatch], { cwd:directory, env:{...process.env,GIT_CEILING_DIRECTORIES:dirname(directory)}, stdio:'ignore', windowsHide:true })
      let changed = false, lifecycleInstalled = false, scopedInstalled = false
      // Peel only our own overlays in reverse order in the private staging copy.
      if (relative.includes('/dsh-subagent/')) {
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-scoped-compact.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        scopedInstalled = apply(['--reverse','--check']).status === 0
        if (scopedInstalled && apply(['--reverse']).status !== 0) throw new Error('Native scoped compaction unstage mismatch: ' + path)
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-lifecycle.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        lifecycleInstalled = apply(['--reverse','--check']).status === 0
        if (lifecycleInstalled && apply(['--reverse']).status !== 0) throw new Error('Native lifecycle unstage mismatch: ' + path)
        writeFileSync(normalizedPatch, readFileSync(patch, 'utf8').replaceAll('\r', ''))
      }
      if (apply(['--reverse','--check']).status !== 0) {
        if (apply(['--check']).status !== 0 && relative.includes('/dsh-subagent/'))
          writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-cold-compact.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--check']).status !== 0 && relative.includes('/dsh-subagent/'))
          writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-close-only-upgrade.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native child cutoff patch mismatch: ' + path)
        changed = true
      }
      if (relative.includes('/dsh-subagent/')) {
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-lifecycle.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native lifecycle patch mismatch: ' + path)
        changed ||= !lifecycleInstalled
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-scoped-compact.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native scoped compaction patch mismatch: ' + path)
        changed ||= !scopedInstalled
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-settlement.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--reverse','--check']).status !== 0) {
          if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native settlement patch mismatch: ' + path)
          changed = true
        }
      }
      if (relative === goalRelative && digest(staged) !== goalImages.after)
        throw new Error('Native goal continuation patch postimage mismatch: ' + path)
      if (changed) prepared.at(-1).staged = staged
    }
    for (const target of prepared) if (target.staged) renameSync(target.staged, target.path)
    return prepared.map(target => ({ path:target.path, updated:!!target.staged }))
  } finally { for (const target of prepared) rmSync(target.directory, { recursive:true, force:true }) }
}
