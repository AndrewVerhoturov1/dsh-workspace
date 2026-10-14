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
  // JSONL may use a different Session copy from the subagent/Agent peers.
  // Register the closure vocabulary in the exact reader too, not just its writer.
  const sdk = createRequire(anchors[0])
  const jsonl = createRequire(sdk.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
  const persistence = createRequire(jsonl.resolve('@deepseek-ai/dsh-session-persistence'))
  targets.set(realpathSync(persistence.resolve('@deepseek-ai/dsh-session')), 'node_modules/@deepseek-ai/dsh-session/lib/index.js')
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
  // Optional in older compositions; capability remains absent/fail-closed.
  for (const anchor of anchors) {
    const resolver = createRequire(anchor)
    let tool
    try { tool = resolver.resolve('@deepseek-ai/dsh-tool-pwsh') } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
    if (tool) targets.set(realpathSync(tool), 'node_modules/@deepseek-ai/dsh-tool-pwsh/lib/index.js')
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
      const targetPatch = relative.includes('/dsh-tool-pwsh/') ? new URL('./postman-native-app-owner.patch', import.meta.url)
        : relative === goalRelative ? new URL('./postman-native-goal-continuation.patch', import.meta.url) : patch
      writeFileSync(normalizedPatch, readFileSync(targetPatch, 'utf8').replaceAll('\r', ''))
      const apply = args => spawnSync('git', ['-c', 'core.longpaths=true', 'apply', '--include=' + relative, ...args, normalizedPatch], { cwd:directory, env:{...process.env,GIT_CEILING_DIRECTORIES:dirname(directory)}, stdio:'ignore', windowsHide:true })
      let changed = false, lifecycleInstalled = false, scopedInstalled = false, deferredInstalled = false
      // Preserve the installed compaction-service lookup while reapplying our exact overlays.
      // The scoped patch was authored against the direct-property variant; some installations
      // use the equivalent Cordis service lookup. Normalize only our private staging copy.
      const scopedLookup = 'this.ownerCtx.agentPresets?.serviceFor(agent, "compaction")'
      const installedLookup = 'this.ownerCtx.get("agentPresets")?.serviceFor(agent, "compaction")'
      let restoreInstalledLookup = false
      if (relative.includes('/dsh-subagent/')) {
        const text = readFileSync(staged, 'utf8')
        if (text.includes(installedLookup)) {
          if (text.includes(scopedLookup) || text.indexOf(installedLookup) !== text.lastIndexOf(installedLookup))
            throw new Error('Native scoped compaction lookup ambiguous: ' + path)
          writeFileSync(staged, text.replace(installedLookup, scopedLookup))
          restoreInstalledLookup = true
        }
      }
      // Peel only our own overlays in reverse order in the private staging copy.
      if (relative.includes('/dsh-subagent/')) {
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-deferred-source.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        deferredInstalled = apply(['--reverse','--check']).status === 0
        if (deferredInstalled && apply(['--reverse']).status !== 0) throw new Error('Native deferred source unstage mismatch: ' + path)
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
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-luna-bootstrap-report.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--reverse','--check']).status !== 0) {
          if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native Luna bootstrap report patch mismatch: ' + path)
          changed = true
        }
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-deferred-source.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--reverse','--check']).status !== 0) {
          if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native deferred source patch mismatch: ' + path)
          changed ||= !deferredInstalled
        }
      }
      if (relative.includes('/dsh-session/')) {
        // Historical cost snapshots are informational, not execution/closure proof.
        // Recognize this exact type without rewriting logs or ignoring unknown events.
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-session-events.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--reverse','--check']).status !== 0) {
          if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native session event vocabulary patch mismatch: ' + path)
          changed = true
        }
      }
      if (restoreInstalledLookup) {
        const text = readFileSync(staged, 'utf8')
        if (!text.includes(scopedLookup) || text.indexOf(scopedLookup) !== text.lastIndexOf(scopedLookup))
          throw new Error('Native scoped compaction lookup restoration mismatch: ' + path)
        writeFileSync(staged, text.replace(scopedLookup, installedLookup))
      }
      if (relative === goalRelative && digest(staged) !== goalImages.after)
        throw new Error('Native goal continuation patch postimage mismatch: ' + path)
      // Patch context alone accepts unrelated appended/modified SDK bytes.
      // These exact pinned postimages are the supported composition; check all
      // staging targets before the first replacement, including the app owner.
      const postimages = {
        'node_modules/@deepseek-ai/dsh-subagent/lib/index.js': '4d6115442509a1084d0586c8e528f0c5f2bc374c46a225bb5aa468d86e83099c',
        'node_modules/@deepseek-ai/dsh-session/lib/index.js': '94f795be373b553dcb9aa8b4c16475abcc4e3afd3340c015a6c7e44a46bfcd87',
        'node_modules/@deepseek-ai/dsh-tool-pwsh/lib/index.js': '49f21df3595f052a05fdd7b123d50f04632b725f5df15092ba0019a77f18e154',
      }
      if (postimages[relative]) {
        const canonical = readFileSync(staged, 'utf8').replaceAll('\r', '').replace(installedLookup, scopedLookup)
        if (createHash('sha256').update(canonical).digest('hex') !== postimages[relative])
          throw new Error('Native SDK postimage mismatch: ' + path)
      }
      if (changed) prepared.at(-1).staged = staged
    }
    for (const target of prepared) if (target.staged) renameSync(target.staged, target.path)
    return prepared.map(target => ({ path:target.path, updated:!!target.staged }))
  } finally { for (const target of prepared) rmSync(target.directory, { recursive:true, force:true }) }
}
