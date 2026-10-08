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
      let changed = false, lifecycleInstalled = false, scopedInstalled = false
      // Peel only our own overlays in reverse order in the private staging copy.
      if (relative.includes('/dsh-subagent/')) {
        const scopedPatch = readFileSync(new URL('./postman-native-scoped-compact.patch', import.meta.url), 'utf8').replaceAll('\r', '')
        writeFileSync(normalizedPatch, scopedPatch)
        scopedInstalled = apply(['--reverse','--check']).status === 0
        if (scopedInstalled) {
          if (apply(['--reverse']).status !== 0) throw new Error('Native scoped compaction unstage mismatch: ' + path)
        } else {
          // Upgrade the previous overlay that accessed an uninjected Cordis property.
          writeFileSync(normalizedPatch, scopedPatch.replace('this.ownerCtx.get("agentPresets")', 'this.ownerCtx.agentPresets'))
          if (apply(['--reverse','--check']).status === 0 && apply(['--reverse']).status !== 0)
            throw new Error('Native previous scoped compaction unstage mismatch: ' + path)
        }
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
      if (changed) prepared.at(-1).staged = staged
    }
    for (const target of prepared) if (target.staged) renameSync(target.staged, target.path)
    return prepared.map(target => ({ path:target.path, updated:!!target.staged }))
  } finally { for (const target of prepared) rmSync(target.directory, { recursive:true, force:true }) }
}
