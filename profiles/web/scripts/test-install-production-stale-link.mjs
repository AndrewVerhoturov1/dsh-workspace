import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const keepStaging = process.argv.includes('--keep')
const stagingRoot = mkdtempSync(join(tmpdir(), 'dsh-better-sidebar-stale-'))
const archivePath = join(tmpdir(), `${stagingRoot.split(/[\\/]/).pop()}.tar`)
const staleTarget = realpathSync(resolve(repositoryRoot, 'plugins/dsh-better-sidebar-andrew'))

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? 'unknown'}`)
}

try {
  execFileSync('git', ['archive', '--format=tar', `--output=${archivePath}`, 'HEAD'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
  })
  execFileSync('tar', ['-xf', archivePath, '-C', stagingRoot], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true,
  })

  const profileRoot = resolve(stagingRoot, 'profiles/web')
  const installedPackage = resolve(profileRoot, 'node_modules/dsh-better-sidebar')
  mkdirSync(resolve(profileRoot, 'node_modules'), { recursive: true })
  symlinkSync(staleTarget, installedPackage, process.platform === 'win32' ? 'junction' : 'dir')

  const staleRealpath = realpathSync(installedPackage)
  if (staleRealpath !== staleTarget || !staleRealpath.includes('.dsh-worktrees')) {
    throw new Error(`stale fixture was not created as a feature-worktree link: ${staleRealpath}`)
  }

  // This is the exact production command required after a merged checkout.
  run(process.execPath, ['profiles/web/scripts/install-production.mjs'], stagingRoot)

  const managedRoot = realpathSync(resolve(stagingRoot, 'plugins/dsh-better-sidebar-andrew'))
  const installedRealpath = realpathSync(installedPackage)
  const requireFromProfile = createRequire(resolve(profileRoot, 'package.json'))
  const resolvedMain = realpathSync(requireFromProfile.resolve('dsh-better-sidebar'))
  const canonicalMain = realpathSync(resolve(managedRoot, 'lib/index.js'))
  if (installedRealpath !== managedRoot || installedRealpath === staleRealpath || installedRealpath.includes('.dsh-worktrees')) {
    throw new Error(`stale Better Sidebar link was not migrated: ${installedRealpath}`)
  }
  if (resolvedMain !== canonicalMain || resolvedMain.includes('.dsh-worktrees')) {
    throw new Error(`Better Sidebar main resolved unexpectedly: ${resolvedMain}`)
  }
  if (!existsSync(resolve(managedRoot, 'lib/client-registry.js'))) {
    throw new Error('managed Better Sidebar client entry is missing')
  }

  const loaded = await import(`${pathToFileURL(canonicalMain).href}?stale-link-migration`)
  if (loaded.name !== 'dsh-better-sidebar' || typeof loaded.apply !== 'function') {
    throw new Error('managed Better Sidebar host plugin did not load')
  }
  console.log(`stale-link migration verified: ${installedRealpath}`)
  console.log(`require.resolve realpath verified: ${resolvedMain}`)
  console.log(`staging retained: ${stagingRoot}`)
} finally {
  rmSync(archivePath, { force: true })
  if (!keepStaging) rmSync(stagingRoot, { recursive: true, force: true })
}
