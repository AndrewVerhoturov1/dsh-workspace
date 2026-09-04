import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPOSITORY_ROOT = resolve(PLUGIN_ROOT, '../..')
const PROFILE_ROOT = resolve(REPOSITORY_ROOT, 'profiles/web')

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function trackedPath(path: string): string {
  const relativePath = relative(REPOSITORY_ROOT, path).replaceAll('\\', '/')
  return execFileSync('git', ['ls-files', '--error-unmatch', '--', relativePath], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  }).trim()
}

describe('fresh merged main Better Sidebar shape', () => {
  it('keeps the managed link, tracked entrypoints, and loadable host plugin self-contained', async () => {
    const packageJson = readJson<{ main: string }>(resolve(PLUGIN_ROOT, 'package.json'))
    const manifest = readJson<{ main: string; client: { main: string } }>(resolve(PLUGIN_ROOT, 'dsh.plugin.json'))
    const profile = readJson<{ dependencies?: Record<string, string> }>(resolve(PROFILE_ROOT, 'package.json'))
    const link = profile.dependencies?.['dsh-better-sidebar']
    const workspace = readFileSync(resolve(PROFILE_ROOT, 'pnpm-workspace.yaml'), 'utf8')
    const lockfile = readFileSync(resolve(PROFILE_ROOT, 'pnpm-lock.yaml'), 'utf8')

    expect(link).toBe('link:../../plugins/dsh-better-sidebar-andrew')
    expect(workspace).toContain('  - ../../plugins/dsh-better-sidebar-andrew')
    expect(lockfile).toContain('  ../../plugins/dsh-better-sidebar-andrew:')
    const managedRoot = resolve(PROFILE_ROOT, link!.slice('link:'.length))
    expect(managedRoot).toBe(PLUGIN_ROOT)
    expect(existsSync(resolve(managedRoot, 'package.json'))).toBe(true)

    const hostMain = resolve(managedRoot, packageJson.main)
    const clientMain = resolve(managedRoot, manifest.client.main)
    expect(trackedPath(hostMain)).toBe('plugins/dsh-better-sidebar-andrew/lib/index.js')
    expect(trackedPath(clientMain)).toBe('plugins/dsh-better-sidebar-andrew/lib/client-registry.js')
    expect(existsSync(hostMain)).toBe(true)
    expect(existsSync(clientMain)).toBe(true)

    const requireFromProfile = createRequire(resolve(PROFILE_ROOT, 'package.json'))
    expect(requireFromProfile.resolve(managedRoot)).toBe(hostMain)

    const loaded = await import(`${pathToFileURL(hostMain).href}?fresh-checkout-shape`)
    expect(loaded.name).toBe('dsh-better-sidebar')
    expect(typeof loaded.apply).toBe('function')

    for (const runtimeDependency of ['ws', 'schemastery', 'node-pty', 'mermaid', '@codemirror/state']) {
      expect(requireFromProfile.resolve(runtimeDependency, { paths: [managedRoot] })).toBeTruthy()
    }
  })

  it('exposes one frozen production install command for the whole workspace', () => {
    const profile = readJson<{ scripts?: Record<string, string> }>(resolve(PROFILE_ROOT, 'package.json'))
    expect(profile.scripts?.['install:production']).toBe('pnpm install --offline --frozen-lockfile')
  })

  it('keeps the manifest and package entrypoints inside the managed package', () => {
    const packageJson = readJson<{ main: string }>(resolve(PLUGIN_ROOT, 'package.json'))
    const manifest = readJson<{ main: string; client: { main: string } }>(resolve(PLUGIN_ROOT, 'dsh.plugin.json'))
    for (const entry of [packageJson.main, manifest.main, manifest.client.main]) {
      expect(resolve(PLUGIN_ROOT, entry).startsWith(`${PLUGIN_ROOT}${process.platform === 'win32' ? '\\' : '/'}`)).toBe(true)
    }
  })
})
