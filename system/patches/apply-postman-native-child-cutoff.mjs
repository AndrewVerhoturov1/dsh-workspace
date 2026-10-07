import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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
  const prepared = []
  try {
    for (const [path, relative] of targets) {
      // Same-volume private copy: git never traverses pnpm symlinks or mutates store hardlinks.
      const directory = mkdtempSync(join(dirname(path), '.postman-cutoff-'))
      prepared.push({ path, directory })
      const staged = join(directory, relative)
      mkdirSync(dirname(staged), { recursive: true }); copyFileSync(path, staged)
      const normalizedPatch = join(directory, 'cutoff.patch')
      writeFileSync(normalizedPatch, readFileSync(patch, 'utf8').replaceAll('\r', ''))
      const apply = args => spawnSync('git', ['-c', 'core.longpaths=true', 'apply', '--include=' + relative, ...args, normalizedPatch], { cwd:directory, env:{...process.env,GIT_CEILING_DIRECTORIES:dirname(directory)}, stdio:'ignore', windowsHide:true })
      let changed = false, lifecycleInstalled = false
      // Check the exact earlier postimage after peeling only our own lifecycle
      // patch in this private staging copy; never touch pnpm store/live bytes.
      if (relative.includes('/dsh-subagent/')) {
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-lifecycle.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        lifecycleInstalled = apply(['--reverse','--check']).status === 0
        if (lifecycleInstalled && apply(['--reverse']).status !== 0) throw new Error('Native lifecycle unstage mismatch: ' + path)
        writeFileSync(normalizedPatch, readFileSync(patch, 'utf8').replaceAll('\r', ''))
      }
      if (apply(['--reverse','--check']).status !== 0) {
        if (apply(['--check']).status !== 0 && relative.includes('/dsh-subagent/'))
          writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-cold-compact.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native child cutoff patch mismatch: ' + path)
        changed = true
      }
      if (relative.includes('/dsh-subagent/')) {
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-lifecycle.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native lifecycle patch mismatch: ' + path)
        changed ||= !lifecycleInstalled
      }
      if (changed) prepared.at(-1).staged = staged
    }
    for (const target of prepared) if (target.staged) renameSync(target.staged, target.path)
    return prepared.map(target => ({ path:target.path, updated:!!target.staged }))
  } finally { for (const target of prepared) rmSync(target.directory, { recursive:true, force:true }) }
}
