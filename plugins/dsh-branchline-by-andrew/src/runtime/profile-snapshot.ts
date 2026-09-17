import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isPathInside } from './descriptor.ts'
import { isolatedLaunchEnvironment } from './credentials-policy.ts'
import type { BranchRuntimeOverride } from './types.ts'

interface PackageJson {
  readonly name?: string
  readonly dsh?: unknown
  readonly dependencies?: Record<string, string>
  readonly [key: string]: unknown
}

export interface PreparedProfile {
  readonly profilePath: string
  readonly profileHash: string
  readonly overrides: readonly BranchRuntimeOverride[]
}

export type WorktreePackageIndex = ReadonlyMap<string, readonly string[]>

/** Copy the real user profile, rewrite local links, and install into a private node_modules. */
export function prepareRuntimeProfile(input: {
  readonly primaryHome: string
  readonly runtimeHome: string
  readonly worktreePath: string
  readonly profileName?: string
}): PreparedProfile {
  const profileName = input.profileName ?? 'web'
  const primaryProfile = canonicalDirectory(join(input.primaryHome, 'profiles', profileName))
  const runtimeProfile = join(input.runtimeHome, 'profiles', profileName)
  mkdirSync(dirname(runtimeProfile), { recursive: true })
  const excludedProfileEntries = new Set(['node_modules', '.dsh-market', '.playwright-mcp'])
  cpSync(primaryProfile, runtimeProfile, {
    recursive: true,
    filter: (source: string) => !excludedProfileEntries.has(basename(source).toLowerCase()),
  })
  rmSync(join(runtimeProfile, 'node_modules'), { recursive: true, force: true })

  const primaryPackagePath = join(primaryProfile, 'package.json')
  const runtimePackagePath = join(runtimeProfile, 'package.json')
  const primaryPackage = readJson(primaryPackagePath)
  const generated = generateRuntimePackage({
    primaryPackage,
    primaryProfile,
    primaryHome: input.primaryHome,
    worktreePath: input.worktreePath,
  })
  writeFileSync(runtimePackagePath, `${JSON.stringify(generated.packageJson, null, 2)}\n`, 'utf8')
  writeFileSync(join(runtimeProfile, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    '',
  ].join('\n'), 'utf8')

  installProfile(runtimeProfile)
  const profileHash = hashFiles([
    runtimePackagePath,
    join(runtimeProfile, 'cordis.patch.yml'),
    join(runtimeProfile, 'pnpm-lock.yaml'),
  ])
  return { profilePath: runtimeProfile, profileHash, overrides: generated.overrides }
}

/** Pure package rewrite, exported for deterministic unit tests. */
export function generateRuntimePackage(input: {
  readonly primaryPackage: PackageJson
  readonly primaryProfile: string
  readonly primaryHome: string
  readonly worktreePath: string
}): { readonly packageJson: PackageJson; readonly overrides: readonly BranchRuntimeOverride[] } {
  const dependencies = { ...(input.primaryPackage.dependencies ?? {}) }
  const overrides: BranchRuntimeOverride[] = []
  const packageIndex = buildWorktreePackageIndex(input.worktreePath)
  for (const [packageName, spec] of Object.entries(dependencies)) {
    const primaryPath = primaryDependencyPath(input.primaryProfile, spec)
    const branchPath = matchingBranchPackage(packageIndex, packageName)
    if (branchPath !== undefined) {
      dependencies[packageName] = `link:${branchPath}`
      overrides.push({
        packageName,
        primarySpec: spec,
        ...(primaryPath === undefined ? {} : { primaryPath }),
        branchPath,
      })
      continue
    }
    if (primaryPath !== undefined) {
      const prefix = spec.startsWith('link:') ? 'link:' : 'file:'
      dependencies[packageName] = `${prefix}${primaryPath}`
    }
  }
  return {
    packageJson: { ...input.primaryPackage, dependencies },
    overrides: overrides.sort((left, right) => left.packageName.localeCompare(right.packageName)),
  }
}

/** Index only the worktree root and its bounded package directories. */
export function buildWorktreePackageIndex(worktreePath: string): WorktreePackageIndex {
  const worktree = canonicalDirectory(worktreePath)
  const candidates = [worktree]
  for (const group of ['plugins', 'packages', 'apps']) {
    const groupPath = join(worktree, group)
    if (!existsSync(groupPath)) continue
    let canonicalGroup: string
    try {
      canonicalGroup = canonicalDirectory(groupPath)
      if (!statSync(canonicalGroup).isDirectory() || !isPathInside(canonicalGroup, worktree)) continue
    } catch { continue }
    for (const entry of readdirSync(canonicalGroup, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) candidates.push(join(canonicalGroup, entry.name))
    }
  }
  const index = new Map<string, string[]>()
  for (const candidate of candidates) {
    const manifestPath = join(candidate, 'package.json')
    if (!existsSync(manifestPath)) continue
    let canonical: string
    try {
      canonical = canonicalDirectory(candidate)
      if (!statSync(canonical).isDirectory() || !isPathInside(canonical, worktree)) continue
    } catch { continue }
    const manifest = readJson(join(canonical, 'package.json'))
    if (typeof manifest.name !== 'string' || manifest.name.trim() === '') continue
    const paths = index.get(manifest.name) ?? []
    if (!paths.includes(canonical)) paths.push(canonical)
    index.set(manifest.name, paths)
  }
  return index
}

function matchingBranchPackage(index: WorktreePackageIndex, packageName: string): string | undefined {
  const matches = index.get(packageName) ?? []
  if (matches.length > 1) {
    throw new Error(`branch runtime: ambiguous branch package ${packageName}: ${matches.join(', ')}`)
  }
  return matches[0]
}

function primaryDependencyPath(profilePath: string, spec: string): string | undefined {
  const prefix = spec.startsWith('link:') ? 'link:' : spec.startsWith('file:') ? 'file:' : undefined
  if (prefix === undefined) return undefined
  const raw = spec.slice(prefix.length)
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(profilePath, raw)
  try { return canonicalDirectory(absolute) } catch { return absolute }
}

function installProfile(profilePath: string): void {
  const pnpm = resolvePnpm()
  const args = pnpm.prefix.length === 0
    ? ['install', '--offline', '--no-frozen-lockfile']
    : [...pnpm.prefix, 'install', '--offline', '--no-frozen-lockfile']
  execFileSync(pnpm.program, args, {
    cwd: profilePath,
    env: isolatedLaunchEnvironment(dirname(dirname(profilePath))),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
}

function resolvePnpm(): { readonly program: string; readonly prefix: readonly string[] } {
  if (process.platform === 'win32') {
    const direct = firstWhere('pnpm.cmd')
    if (direct !== undefined) return { program: direct, prefix: [] }
    const corepack = firstWhere('corepack.cmd')
    if (corepack !== undefined) return { program: corepack, prefix: ['pnpm'] }
  } else {
    const direct = firstWhich('pnpm')
    if (direct !== undefined) return { program: direct, prefix: [] }
    const corepack = firstWhich('corepack')
    if (corepack !== undefined) return { program: corepack, prefix: ['pnpm'] }
  }
  throw new Error('branch runtime: pnpm or corepack was not found in PATH')
}

function firstWhere(program: string): string | undefined {
  try {
    return execFileSync('where.exe', [program], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/u).find(Boolean)
  } catch { return undefined }
}

function firstWhich(program: string): string | undefined {
  try {
    const value = execFileSync('which', [program], { encoding: 'utf8' }).trim()
    return value === '' ? undefined : value
  } catch { return undefined }
}

function resolveDependencyPath(profilePath: string, raw: string): string {
  return canonicalDirectory(isAbsolute(raw) ? raw : resolve(profilePath, raw))
}

function canonicalDirectory(value: string): string {
  return realpathSync.native(resolve(value))
}

function readJson(path: string): PackageJson {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`branch runtime: ${path} must contain a JSON object`)
  }
  return parsed as PackageJson
}

function hashFiles(paths: readonly string[]): string {
  const hash = createHash('sha256')
  for (const path of paths) {
    if (!existsSync(path)) continue
    hash.update(path)
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}
