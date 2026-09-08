import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const profileRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = resolve(profileRoot, '../..')
const managedRoot = resolve(repositoryRoot, 'plugins/dsh-better-sidebar-andrew')
const agentTeamsPackageName = 'dsh-agent-teams-nanmicoder-by-andrew'
const forbiddenAgentTeamsNames = ['dsh-agent-team-by-andrew', '@nanmicoder/dsh-agent-teams']
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const canonicalManagedRoot = realpathSync(managedRoot)

if (canonicalManagedRoot.includes('.dsh-worktrees')) {
  throw new Error(`managed Better Sidebar source must be in the merged repository: ${canonicalManagedRoot}`)
}

function runInstall(cwd, label) {
  const result = spawnSync(packageManager, ['install', '--offline', '--frozen-lockfile'], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`)
}

runInstall(managedRoot, 'managed Better Sidebar install')

const installedPackagePath = resolve(profileRoot, 'node_modules/dsh-better-sidebar')
if (existsSync(installedPackagePath)) {
  const installedBeforeProfileInstall = realpathSync(installedPackagePath)
  if (installedBeforeProfileInstall !== canonicalManagedRoot) {
    const installedStat = lstatSync(installedPackagePath)
    if (!installedStat.isSymbolicLink()) {
      throw new Error(`refusing to replace non-link Better Sidebar package: ${installedPackagePath}`)
    }
    rmSync(installedPackagePath, { recursive: true, force: true })
  }
}

runInstall(profileRoot, 'web profile install')

const profilePackage = JSON.parse(readFileSync(resolve(profileRoot, 'package.json'), 'utf8'))
const profileBundles = profilePackage.dsh?.profile?.bundles ?? []
const profileDependencies = profilePackage.dependencies ?? {}
if (!profileBundles.includes(agentTeamsPackageName)) {
  throw new Error(`web profile is missing the active AgentTeams bundle: ${agentTeamsPackageName}`)
}
if (!Object.hasOwn(profileDependencies, agentTeamsPackageName)) {
  throw new Error(`web profile is missing the active AgentTeams dependency: ${agentTeamsPackageName}`)
}
for (const forbiddenName of forbiddenAgentTeamsNames) {
  if (profileBundles.includes(forbiddenName) || Object.hasOwn(profileDependencies, forbiddenName)) {
    throw new Error(`web profile still references the forbidden AgentTeams identity: ${forbiddenName}`)
  }
}

const link = profilePackage.dependencies?.['dsh-better-sidebar']
if (link !== 'link:../../plugins/dsh-better-sidebar-andrew') {
  throw new Error(`unexpected Better Sidebar link: ${link ?? '<missing>'}`)
}

const declaredManagedRoot = resolve(profileRoot, link.slice('link:'.length))
if (declaredManagedRoot !== managedRoot) {
  throw new Error(`managed Better Sidebar declaration resolved unexpectedly: ${declaredManagedRoot}`)
}

const requireFromProfile = createRequire(resolve(profileRoot, 'package.json'))
if (!existsSync(installedPackagePath)) {
  throw new Error(`installed Better Sidebar package link is missing: ${installedPackagePath}`)
}

const installedPackageRoot = realpathSync(installedPackagePath)
if (installedPackageRoot !== canonicalManagedRoot || installedPackageRoot.includes('.dsh-worktrees')) {
  throw new Error(`installed Better Sidebar package resolved outside merged repository: ${installedPackageRoot}`)
}

const packageJson = JSON.parse(readFileSync(resolve(canonicalManagedRoot, 'package.json'), 'utf8'))
const canonicalManagedMain = realpathSync(resolve(canonicalManagedRoot, packageJson.main))
const resolvedPackageMain = requireFromProfile.resolve('dsh-better-sidebar')
const resolvedPackageMainRealpath = realpathSync(resolvedPackageMain)
if (resolvedPackageMainRealpath !== canonicalManagedMain || resolvedPackageMainRealpath.includes('.dsh-worktrees')) {
  throw new Error(`installed Better Sidebar main resolved unexpectedly: ${resolvedPackageMainRealpath}`)
}

const hostMain = resolvedPackageMainRealpath
const clientMain = resolve(canonicalManagedRoot, 'lib/client-registry.js')
if (!existsSync(hostMain) || !existsSync(clientMain)) {
  throw new Error(`managed Better Sidebar entrypoint missing: ${hostMain} / ${clientMain}`)
}

for (const runtimeDependency of ['ws', 'schemastery', 'node-pty', 'mermaid', '@codemirror/state']) {
  requireFromProfile.resolve(runtimeDependency, { paths: [installedPackageRoot] })
}

const loaded = await import(`${pathToFileURL(hostMain).href}?production-install`)
if (loaded.name !== 'dsh-better-sidebar' || typeof loaded.apply !== 'function') {
  throw new Error('managed Better Sidebar host plugin did not load')
}

const agentTeamsPackagePath = resolve(profileRoot, 'node_modules', agentTeamsPackageName)
if (!existsSync(agentTeamsPackagePath)) {
  throw new Error(`installed AgentTeams package is missing: ${agentTeamsPackagePath}`)
}

const agentTeamsPackageRoot = realpathSync(agentTeamsPackagePath)
const agentTeamsPackageJsonPath = resolve(agentTeamsPackageRoot, 'package.json')
const agentTeamsPackageJson = JSON.parse(readFileSync(agentTeamsPackageJsonPath, 'utf8'))
if (agentTeamsPackageJson.name !== agentTeamsPackageName || agentTeamsPackageJson.private !== true) {
  throw new Error(`installed AgentTeams package identity is unexpected: ${agentTeamsPackageJsonPath}`)
}

const agentTeamsHostMain = realpathSync(requireFromProfile.resolve(agentTeamsPackageName))
const declaredAgentTeamsHostMain = realpathSync(resolve(agentTeamsPackageRoot, agentTeamsPackageJson.main))
if (agentTeamsHostMain !== declaredAgentTeamsHostMain) {
  throw new Error(`installed AgentTeams host entrypoint resolved unexpectedly: ${agentTeamsHostMain}`)
}

const agentTeamsClientMain = realpathSync(requireFromProfile.resolve(`${agentTeamsPackageName}/client`))
const declaredAgentTeamsClientMain = realpathSync(resolve(agentTeamsPackageRoot, 'lib/client.js'))
if (agentTeamsClientMain !== declaredAgentTeamsClientMain) {
  throw new Error(`installed AgentTeams client entrypoint resolved unexpectedly: ${agentTeamsClientMain}`)
}

const agentTeamsClientBundle = readFileSync(agentTeamsClientMain, 'utf8')
if (!agentTeamsClientBundle.includes(`id: "${agentTeamsPackageName}"`)) {
  throw new Error(`installed AgentTeams client bundle does not register ${agentTeamsPackageName}`)
}
for (const forbiddenName of forbiddenAgentTeamsNames) {
  if (agentTeamsClientBundle.includes(forbiddenName)) {
    throw new Error(`installed AgentTeams client bundle references the forbidden identity: ${forbiddenName}`)
  }
}

const agentTeamsHostSource = readFileSync(agentTeamsHostMain, 'utf8')
if (!agentTeamsHostSource.includes(`export const name = '${agentTeamsPackageName}'`)) {
  throw new Error(`installed AgentTeams host entrypoint does not export ${agentTeamsPackageName}`)
}

for (const forbiddenName of forbiddenAgentTeamsNames) {
  if (existsSync(resolve(profileRoot, 'node_modules', forbiddenName))) {
    throw new Error(`forbidden AgentTeams package remains installed: ${forbiddenName}`)
  }
}

console.log(`production install verified: Better Sidebar ${hostMain}; AgentTeams ${agentTeamsHostMain}; client ${agentTeamsClientMain}`)
