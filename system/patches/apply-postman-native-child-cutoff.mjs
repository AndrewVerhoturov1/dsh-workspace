import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export function applyPostmanNativeChildCutoff(anchors, { replaceFile = renameSync, sessionIgnorableAnchors = [] } = {}) {
  const requirePanel = sessionIgnorableAnchors.length > 0
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
  for (const anchor of sessionIgnorableAnchors) {
    // An installed panel may not own a separate Session dependency under
    // autoInstallPeers:false. The authoritative CLI SDK Session was registered
    // above; only add another physical Session if this panel really resolves one.
    let session
    try { session = createRequire(anchor).resolve('@deepseek-ai/dsh-session') }
    catch (error) { if (error?.code !== 'MODULE_NOT_FOUND') throw error }
    if (session) targets.set(realpathSync(session), 'node_modules/@deepseek-ai/dsh-session/lib/index.js')
  }
  // The first anchor is the actual CLI SDK (or isolated SDK fixture), not
  // the plugin's optional development dependency tree.
  const goalPath = realpathSync(createRequire(anchors[0]).resolve('@deepseek-ai/dsh-goal-round-driver'))
  const goalRelative = 'node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js'
  const goalImages = {
    before: '95f68fdb41a96082df3ae0dab2fb27a80de7bf57b1cc147651d0ff7a8f1a1af8',
    legacy: '93733a1750665882a3f5bce5bc96c7249d8ab019dfb91e25ff736b2f7bd27d77',
    after: '6a9c69f86411f14c52786b628911b0706c5be90182d7d519090e320b760ba6cb',
  }
  const toolGoalPath = realpathSync(createRequire(anchors[0]).resolve('@deepseek-ai/dsh-tool-goal'))
  const toolGoalRelative = 'node_modules/@deepseek-ai/dsh-tool-goal/lib/index.js'
  const toolGoalImages = {
    before: 'b6ebe2f5b412eb4043fd8c1483a1ee3aeaaa3858b95e0b285ab811d99b89a1e3',
    after: 'b1b70a17847149edf92fa578c9fd5811b5e959f543f767b78bd28ad4e870391e',
  }
  const sessionRelative = 'node_modules/@deepseek-ai/dsh-session/lib/index.js'
  // Entire pinned rc.2 images: clean, child-cutoff, then session vocabulary.
  // Cost-panel's sole supported delta is admitted by full image hash, never fragments.
  const sessionImages = new Map([
    ['dc14c845b915a9faaeb867499966e7b1991af3b6285f314bf353417e939d9c36', false],
    ['c8fab6a1d8cd56613dab9037852d54e35d98358e248ded3c9dfd729cc2df817c', false],
    ['94f795be373b553dcb9aa8b4c16475abcc4e3afd3340c015a6c7e44a46bfcd87', false],
    ['4e397f47c300d0e5ea195b381719356144ccaa1117866f8f7eefa9caba3c3312', true],
    ['ce7d3f8965427ab9870868a6e38a5f0ade252942d1fc10eeb575d2180190b5df', true],
    ['e76438e4007543a00c58ef1c7c9c623e49cc540db13bfa134da7d3c68011d382', true],
  ])
  const digestText = text => createHash('sha256').update(text).digest('hex')
  const lf = text => text.replaceAll('\r', '')
  const digest = path => digestText(lf(readFileSync(path, 'utf8')))
  if (![goalImages.before, goalImages.legacy, goalImages.after].includes(digest(goalPath)))
    throw new Error('Native goal continuation patch preimage mismatch: ' + goalPath)
  targets.set(goalPath, goalRelative)
  if (![toolGoalImages.before, toolGoalImages.after].includes(digest(toolGoalPath)))
    throw new Error('Native goal tool patch preimage mismatch: ' + toolGoalPath)
  targets.set(toolGoalPath, toolGoalRelative)
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
      const original = readFileSync(path, 'utf8')
      const newline = original.includes('\r\n') ? '\r\n' : '\n'
      const sessionCompatBefore = '\t\tconst surfaceMetadata = {\n'
      const sessionCompatAfter = sessionCompatBefore + '\t\t\t...surfaceOpts?.ignorable === true ? { ignorable: true } : {},\n'
      if (relative === goalRelative && digest(path) === goalImages.legacy) {
        // Upgrade only the exact previous wait-only image, in private staging.
        writeFileSync(staged, lf(original)
          .replace('\t\t// An authoritative plugin wait defers only automatic goal admission.\n\t\t// Native inbox input and the existing checkpoint recheck stay unchanged.\n', '')
          .replace(' && ctx.bail("goal/continuation-defer", state.agent) !== true', ''))
      }
      let restorePanel = false
      if (relative === sessionRelative) {
        const source = lf(original), hash = digestText(source)
        if (!sessionImages.has(hash)) throw new Error('Native session patch preimage mismatch: ' + path)
        restorePanel = sessionImages.get(hash) || requirePanel
        writeFileSync(staged, sessionImages.get(hash) ? source.replace(sessionCompatAfter, sessionCompatBefore) : source)
      }
      const normalizedPatch = join(directory, 'cutoff.patch')
      const targetPatch = relative.includes('/dsh-tool-pwsh/') ? new URL('./postman-native-app-owner.patch', import.meta.url)
        : [goalRelative, toolGoalRelative].includes(relative) ? new URL('./postman-native-goal-continuation.patch', import.meta.url) : patch
      writeFileSync(normalizedPatch, readFileSync(targetPatch, 'utf8').replaceAll('\r', ''))
      const apply = args => spawnSync('git', ['-c', 'core.longpaths=true', 'apply', '--include=' + relative, ...args, normalizedPatch], { cwd:directory, env:{...process.env,GIT_CEILING_DIRECTORIES:dirname(directory)}, stdio:'ignore', windowsHide:true })
      let lifecycleInstalled = false, scopedInstalled = false, deferredInstalled = false
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
      }
      if (relative.includes('/dsh-subagent/')) {
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-lifecycle.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native lifecycle patch mismatch: ' + path)
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-scoped-compact.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native scoped compaction patch mismatch: ' + path)
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-settlement.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--reverse','--check']).status !== 0) {
          if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native settlement patch mismatch: ' + path)
          }
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-luna-bootstrap-report.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--reverse','--check']).status !== 0) {
          if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native Luna bootstrap report patch mismatch: ' + path)
          }
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-deferred-source.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--reverse','--check']).status !== 0) {
          if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native deferred source patch mismatch: ' + path)
        }
      }
      if (relative.includes('/dsh-session/')) {
        // Historical cost snapshots are informational, not execution/closure proof.
        // Recognize this exact type without rewriting logs or ignoring unknown events.
        writeFileSync(normalizedPatch, readFileSync(new URL('./postman-native-session-events.patch', import.meta.url), 'utf8').replaceAll('\r', ''))
        if (apply(['--reverse','--check']).status !== 0) {
          if (apply(['--check']).status !== 0 || apply([]).status !== 0) throw new Error('Native session event vocabulary patch mismatch: ' + path)
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
      if (relative === toolGoalRelative && digest(staged) !== toolGoalImages.after)
        throw new Error('Native goal tool patch postimage mismatch: ' + path)
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
      if (relative === sessionRelative && restorePanel) {
        const canonical = lf(readFileSync(staged, 'utf8'))
        const combined = canonical.replace(sessionCompatBefore, sessionCompatAfter)
        if (digestText(combined) !== 'e76438e4007543a00c58ef1c7c9c623e49cc540db13bfa134da7d3c68011d382')
          throw new Error('Native panel composition postimage mismatch: ' + path)
        writeFileSync(staged, combined)
      }
      // Hashes are LF semantic images; retain the target's actual newline contract.
      writeFileSync(staged, lf(readFileSync(staged, 'utf8')).replaceAll('\n', newline))
      if (readFileSync(staged, 'utf8') !== original) prepared.at(-1).staged = staged
    }
    const replacements = prepared.filter(target => target.staged)
    for (const target of replacements) {
      target.backup = join(target.directory, 'original')
      copyFileSync(target.path, target.backup)
    }
    try {
      for (const target of replacements) {
        replaceFile(target.staged, target.path)
        target.replaced = true
      }
    } catch (error) {
      const failures = [error]
      for (const target of replacements.filter(item => item.replaced).reverse()) {
        try { renameSync(target.backup, target.path) }
        catch (rollbackError) { target.recoveryRequired = true; failures.push(rollbackError) }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Native SDK rollback incomplete; original backups retained')
      throw error
    }
    return prepared.map(target => ({ path:target.path, updated:!!target.staged }))
  } finally { for (const target of prepared) if (!target.recoveryRequired) rmSync(target.directory, { recursive:true, force:true }) }
}
