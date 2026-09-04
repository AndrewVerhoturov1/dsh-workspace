import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const profileRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = resolve(profileRoot, '../..')
const managedRoot = resolve(repositoryRoot, 'plugins/dsh-better-sidebar-andrew')
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function runInstall(cwd, label) {
  const result = spawnSync(packageManager, ['install', '--offline', '--frozen-lockfile'], {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`)
}

runInstall(managedRoot, 'managed Better Sidebar install')
runInstall(profileRoot, 'web profile install')

const profilePackage = JSON.parse(readFileSync(resolve(profileRoot, 'package.json'), 'utf8'))
const link = profilePackage.dependencies?.['dsh-better-sidebar']
if (link !== 'link:../../plugins/dsh-better-sidebar-andrew') {
  throw new Error(`unexpected Better Sidebar link: ${link ?? '<missing>'}`)
}

const resolvedRoot = resolve(profileRoot, link.slice('link:'.length))
if (resolvedRoot !== managedRoot || resolvedRoot.includes('.dsh-worktrees')) {
  throw new Error(`managed Better Sidebar resolved outside merged repository: ${resolvedRoot}`)
}

const requireFromProfile = createRequire(resolve(profileRoot, 'package.json'))
const hostMain = requireFromProfile.resolve(resolvedRoot)
const clientMain = resolve(resolvedRoot, 'lib/client-registry.js')
if (!existsSync(hostMain) || !existsSync(clientMain)) {
  throw new Error(`managed Better Sidebar entrypoint missing: ${hostMain} / ${clientMain}`)
}

for (const runtimeDependency of ['ws', 'schemastery', 'node-pty', 'mermaid', '@codemirror/state']) {
  requireFromProfile.resolve(runtimeDependency, { paths: [resolvedRoot] })
}

const loaded = await import(`${pathToFileURL(hostMain).href}?production-install`)
if (loaded.name !== 'dsh-better-sidebar' || typeof loaded.apply !== 'function') {
  throw new Error('managed Better Sidebar host plugin did not load')
}

console.log(`production install verified: ${hostMain}`)
