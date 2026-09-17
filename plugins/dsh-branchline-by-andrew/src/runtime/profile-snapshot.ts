import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
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
  for (const [packageName, spec] of Object.entries(dependencies)) {
    if (spec.startsWith('link:')) {
      const resolvedPrimary = resolveDependencyPath(input.primaryProfile, spec.slice('link:'.length))
      const branchPath = matchingBranchPackage({
        packageName,
        primaryPath: resolvedPrimary,
        primaryHome: input.primaryHome,
        worktreePath: input.worktreePath,
      })
      if (branchPath !== undefined) {
        dependencies[packageName] = `link:${branchPath}`
        overrides.push({ packageName, primaryPath: resolvedPrimary, branchPath })
      } else {
        dependencies[packageName] = `link:${resolvedPrimary}`
      }
      continue
    }
    if (spec.startsWith('file:')) {
      const raw = spec.slice('file:'.length)
      if (!isAbsolute(raw)) dependencies[packageName] = `file:${resolve(input.primaryProfile, raw)}`
    }
  }
  return {
    packageJson: { ...input.primaryPackage, dependencies },
    overrides: overrides.sort((left, right) => left.packageName.localeCompare(right.packageName)),
  }
}

function matchingBranchPackage(input: {
  readonly packageName: string
  readonly primaryPath: string
  readonly primaryHome: string
  readonly worktreePath: string
}): string | undefined {
  const candidates: string[] = []
  if (isPathInside(input.primaryPath, input.primaryHome)) {
    candidates.push(resolve(input.worktreePath, relative(input.primaryHome, input.primaryPath)))
  }
  candidates.push(
    resolve(input.worktreePath, 'plugins', basename(input.primaryPath)),
    resolve(input.worktreePath, 'packages', basename(input.primaryPath)),
    resolve(input.worktreePath),
  )
  const worktree = canonicalDirectory(input.worktreePath)
  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(join(candidate, 'package.json'))) continue
    let canonical: string
    try { canonical = canonicalDirectory(candidate) } catch { continue }
    if (!isPathInside(canonical, worktree)) continue
    const manifest = readJson(join(canonical, 'package.json'))
    if (manifest.name !== input.packageName) continue
    return canonical
  }
  return undefined
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
