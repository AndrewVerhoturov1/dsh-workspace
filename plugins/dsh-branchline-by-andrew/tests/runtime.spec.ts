import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupRuntimeSandbox } from '../src/runtime/cleanup.ts'
import { isPathInside, sourceFromExternalWorktree, sourceFromTask, staleSourceReason } from '../src/runtime/descriptor.ts'
import { TaskId, type TaskView } from '../src/types.ts'
import { createRepositoryFixture, git, removeFixture } from './helpers.ts'
import { defaultRuntimeRoot } from '../src/runtime/runtime-service.ts'
import { buildWorktreePackageIndex, generateRuntimePackage, packageManagerInvocation, resolvePnpm } from '../src/runtime/profile-snapshot.ts'
import { canTerminateFailedStart, canTerminateNormally, isExpectedProcessRecord, type ControllerState, type ProcessRecord } from '../src/runtime/runtime-controller.ts'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'branchline-runtime-'))
}

function writePackage(path: string, name: string): void {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), `${JSON.stringify({ name }, null, 2)}\n`, 'utf8')
}

describe('branch runtime profile overlay', () => {
  it('overrides only a matching primary link with a package inside the worktree', () => {
    const root = tempRoot()
    const primaryHome = join(root, 'primary')
    const primaryProfile = join(primaryHome, 'profiles', 'web')
    const primaryPlugin = join(primaryHome, 'plugins', 'dsh-postman-harness')
    const worktree = join(root, 'worktree')
    const branchPlugin = join(worktree, 'plugins', 'dsh-postman-harness')
    writePackage(primaryPlugin, 'dsh-postman-harness')
    writePackage(branchPlugin, 'dsh-postman-harness')
    mkdirSync(primaryProfile, { recursive: true })

    const result = generateRuntimePackage({
      primaryPackage: {
        name: 'profile',
        dependencies: {
          'dsh-postman-harness': 'link:../../plugins/dsh-postman-harness',
          'registry-package': '^1.2.3',
        },
      },
      primaryProfile,
      primaryHome,
      worktreePath: worktree,
    })

    expect(result.packageJson.dependencies?.['dsh-postman-harness']).toBe(`link:${branchPlugin}`)
    expect(result.packageJson.dependencies?.['registry-package']).toBe('^1.2.3')
    expect(result.overrides).toEqual([{
      packageName: 'dsh-postman-harness',
      primarySpec: 'link:../../plugins/dsh-postman-harness',
      primaryPath: primaryPlugin,
      branchPath: branchPlugin,
    }])
  })

  it('does not override a branch package whose manifest name does not match', () => {
    const root = tempRoot()
    const primaryHome = join(root, 'primary')
    const primaryProfile = join(primaryHome, 'profiles', 'web')
    const primaryPlugin = join(primaryHome, 'plugins', 'expected')
    const worktree = join(root, 'worktree')
    writePackage(primaryPlugin, 'expected')
    writePackage(join(worktree, 'plugins', 'expected'), 'wrong-name')
    mkdirSync(primaryProfile, { recursive: true })

    const result = generateRuntimePackage({
      primaryPackage: { dependencies: { expected: 'link:../../plugins/expected' } },
      primaryProfile,
      primaryHome,
      worktreePath: worktree,
    })

    expect(result.packageJson.dependencies?.expected).toBe(`link:${primaryPlugin}`)
    expect(result.overrides).toEqual([])
  })
})

describe('branch runtime package index hardening', () => {
  it('overrides npm dependencies by manifest name in arbitrary directories', () => {
    const root = tempRoot()
    const worktree = join(root, 'worktree')
    const branchPath = join(worktree, 'plugins', 'arbitrary-directory')
    writePackage(branchPath, 'example-plugin')

    const result = generateRuntimePackage({
      primaryPackage: { dependencies: { 'example-plugin': '^1.2.3' } },
      primaryProfile: join(root, 'primary', 'profiles', 'web'),
      primaryHome: join(root, 'primary'),
      worktreePath: worktree,
    })

    expect(result.packageJson.dependencies?.['example-plugin']).toBe(`link:${branchPath}`)
    expect(result.overrides).toEqual([{
      packageName: 'example-plugin',
      primarySpec: '^1.2.3',
      branchPath,
    }])
  })

  it('overrides a matching primary file dependency', () => {
    const root = tempRoot()
    const primaryHome = join(root, 'primary')
    const primaryProfile = join(primaryHome, 'profiles', 'web')
    const primaryPath = join(primaryHome, 'plugins', 'file-plugin')
    const worktree = join(root, 'worktree')
    const branchPath = join(worktree, 'packages', 'renamed-file-plugin')
    writePackage(primaryPath, 'file-plugin')
    writePackage(branchPath, 'file-plugin')

    const result = generateRuntimePackage({
      primaryPackage: { dependencies: { 'file-plugin': 'file:../../plugins/file-plugin' } },
      primaryProfile,
      primaryHome,
      worktreePath: worktree,
    })

    expect(result.packageJson.dependencies?.['file-plugin']).toBe(`link:${branchPath}`)
    expect(result.overrides).toEqual([{
      packageName: 'file-plugin',
      primarySpec: 'file:../../plugins/file-plugin',
      primaryPath,
      branchPath,
    }])
  })

  it('does not add an unrelated branch package to primary dependencies', () => {
    const root = tempRoot()
    const worktree = join(root, 'worktree')
    writePackage(join(worktree, 'apps', 'unrelated'), 'unrelated-package')

    const result = generateRuntimePackage({
      primaryPackage: { dependencies: { primary: '^1.0.0' } },
      primaryProfile: join(root, 'primary', 'profiles', 'web'),
      primaryHome: join(root, 'primary'),
      worktreePath: worktree,
    })

    expect(result.packageJson.dependencies).toEqual({ primary: '^1.0.0' })
    expect(result.overrides).toEqual([])
    expect(buildWorktreePackageIndex(worktree).get('unrelated-package')).toHaveLength(1)
  })

  it('fails closed on duplicate exact package names', () => {
    const root = tempRoot()
    const worktree = join(root, 'worktree')
    writePackage(join(worktree, 'plugins', 'one'), 'duplicate-plugin')
    writePackage(join(worktree, 'packages', 'two'), 'duplicate-plugin')

    expect(() => generateRuntimePackage({
      primaryPackage: { dependencies: { 'duplicate-plugin': '^1.0.0' } },
      primaryProfile: join(root, 'primary', 'profiles', 'web'),
      primaryHome: join(root, 'primary'),
      worktreePath: worktree,
    })).toThrow(/ambiguous branch package duplicate-plugin/u)
  })

  it('ignores a symlink package whose canonical directory escapes the worktree', () => {
    const root = tempRoot()
    const outside = join(root, 'outside-package')
    const worktree = join(root, 'worktree')
    const escaped = join(worktree, 'plugins', 'escaped-link')
    writePackage(outside, 'escape-plugin')
    mkdirSync(join(worktree, 'plugins'), { recursive: true })
    symlinkSync(outside, escaped, 'junction')

    const result = generateRuntimePackage({
      primaryPackage: { dependencies: { 'escape-plugin': '^1.0.0' } },
      primaryProfile: join(root, 'primary', 'profiles', 'web'),
      primaryHome: join(root, 'primary'),
      worktreePath: worktree,
    })

    expect(result.packageJson.dependencies?.['escape-plugin']).toBe('^1.0.0')
    expect(result.overrides).toEqual([])
    expect(buildWorktreePackageIndex(worktree).get('escape-plugin')).toBeUndefined()
  })
})

describe('branch runtime root isolation', () => {
  it('namespaces roots by canonical primaryHome outside the home itself', () => {
    const root = tempRoot()
    const primaryHome = join(root, 'primary')
    mkdirSync(primaryHome, { recursive: true })
    const same = defaultRuntimeRoot(join(primaryHome, '.'))
    const sameCanonical = defaultRuntimeRoot(realpathSync.native(primaryHome))
    const different = defaultRuntimeRoot(join(root, 'other-home'))

    expect(same).toBe(sameCanonical)
    expect(different).not.toBe(same)
    expect(isPathInside(same, primaryHome)).toBe(false)
    expect(same).not.toContain('primary')
    if (process.platform === 'win32') {
      const base = join(process.env.LOCALAPPDATA ?? '', 'DSH', 'branchline-runtimes')
      expect(same.toLowerCase().startsWith(base.toLowerCase())).toBe(true)
    }
  })
})

describe('failed-start cleanup decisions', () => {
  const expected: ControllerState = {
    runtimeId: 'brt-test',
    pid: 123,
    port: 4174,
    profile: 'web',
    cwd: 'C:\\worktree',
    home: 'C:\\runtime\\home',
    launcherRoot: 'C:\\runtime\\launcher',
    dshBin: 'C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    logPath: 'C:\\runtime\\launcher\\dsh.log',
    startedAt: '2026-01-01T00:00:00.000Z',
  }
  const record: ProcessRecord = {
    pid: 123,
    executablePath: expected.nodePath,
    commandLine: `"${expected.nodePath}" --expose-internals "${expected.dshBin}" --profile web --port 4174 --no-open`,
  }

  it('allows only this expected spawned process without listener ownership', () => {
    expect(canTerminateFailedStart(expected, expected, record)).toBe(true)
    expect(canTerminateNormally(record, expected, [])).toBe(false)
  })

  it('rejects a foreign PID and identity mismatch', () => {
    expect(canTerminateFailedStart(expected, expected, { ...record, pid: 999 })).toBe(false)
    expect(canTerminateFailedStart(expected, expected, { ...record, commandLine: record.commandLine.replace('--port 4174', '--port 4175') })).toBe(false)
    expect(canTerminateFailedStart({ ...expected, startedAt: '2026-01-01T00:00:01.000Z' }, expected, record)).toBe(false)
  })

  it('keeps normal stop listener ownership strict', () => {
    expect(canTerminateNormally(record, expected, [])).toBe(false)
    expect(canTerminateNormally(record, expected, [expected.pid])).toBe(true)
  })
})

describe('branch runtime source identity', () => {
  it('accepts a Branchline task whose linked worktree differs from its primary repository', async () => {
    const fixture = await createRepositoryFixture()
    const worktree = join(fixture.root, 'linked-worktree')
    const branch = 'runtime-linked-regression'
    git(fixture.repository, ['worktree', 'add', '-b', branch, worktree, 'HEAD'])

    try {
      const repository = git(fixture.repository, ['rev-parse', '--show-toplevel'])
      const commonDirectory = realpathSync.native(git(fixture.repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
      const head = git(worktree, ['rev-parse', 'HEAD'])
      const task: TaskView = {
        id: TaskId('wt-00000000-0000-4000-8000-000000000001'),
        title: 'linked worktree regression',
        repository,
        commonDirectory,
        path: worktree,
        branch,
        baseCommit: head,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        phase: 'active',
        headCommit: head,
        currentBranch: branch,
        changes: { dirty: false, staged: 0, unstaged: 0, untracked: 0, commitsAhead: 0 },
        exists: true,
        changeToken: 'a'.repeat(64),
        workspacePath: worktree,
      }

      const linkedCommonDirectory = realpathSync.native(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
      expect(task.repository).toBe(repository)
      expect(task.workspacePath).toBe(worktree)
      expect(task.path).toBe(worktree)
      expect(task.repository).not.toBe(task.workspacePath)
      expect(linkedCommonDirectory).toBe(commonDirectory)

      const source = sourceFromTask(task)
      expect(source).toMatchObject({
        source: 'branchline-task',
        worktreePath: worktree,
        commonDirectory,
        head,
        branch,
        changeToken: task.changeToken,
      })
    } finally {
      git(fixture.repository, ['worktree', 'remove', '--force', worktree])
      await removeFixture(fixture.root)
    }
  })

  it('marks an external worktree stale after content changes', () => {
    const repository = join(tempRoot(), 'repo')
    mkdirSync(repository, { recursive: true })
    execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'branchline@example.invalid'], { cwd: repository })
    execFileSync('git', ['config', 'user.name', 'Branchline Test'], { cwd: repository })
    writeFileSync(join(repository, 'a.txt'), 'one\n', 'utf8')
    execFileSync('git', ['add', 'a.txt'], { cwd: repository })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repository, stdio: 'ignore' })

    const source = sourceFromExternalWorktree(repository)
    expect(staleSourceReason(source)).toBeUndefined()
    writeFileSync(join(repository, 'a.txt'), 'two\n', 'utf8')
    expect(staleSourceReason(source)).toContain('content changed')
  })
})

describe('branch runtime process and cleanup guards', () => {
  it('requires exact PID, DSH entry, profile and port', () => {
    const expected = {
      pid: 123,
      port: 4174,
      profile: 'web',
      dshBin: 'C:\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    }
    expect(isExpectedProcessRecord({
      pid: 123,
      executablePath: expected.nodePath,
      commandLine: `"${expected.nodePath}" --expose-internals "${expected.dshBin}" --profile web --port 4174 --no-open`,
    }, expected)).toBe(true)
    expect(isExpectedProcessRecord({
      pid: 123,
      executablePath: expected.nodePath,
      commandLine: `"${expected.nodePath}" "${expected.dshBin}" --profile web --port 4173 --no-open`,
    }, expected)).toBe(false)
  })

  it('deletes only a sandbox below the runtime root', () => {
    const root = tempRoot()
    const runtimeRoot = join(root, 'runtimes')
    const sandbox = join(runtimeRoot, 'brt-test')
    const outside = join(root, 'outside')
    mkdirSync(sandbox, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(sandbox, 'runtime.json'), '{}\n', 'utf8')
    cleanupRuntimeSandbox(runtimeRoot, sandbox)
    expect(() => readFileSync(join(sandbox, 'runtime.json'))).toThrow()
    expect(() => cleanupRuntimeSandbox(runtimeRoot, outside)).toThrow(/outside runtime root/u)
  })
})

describe('package manager process invocation', () => {
  it('routes a Windows pnpm shim through the command processor and quotes spaces', () => {
    const pnpm = 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\pnpm.cmd'
    const invocation = packageManagerInvocation({
      program: pnpm,
      prefix: [],
      platform: 'win32',
      comSpec: 'C:\\Windows\\System32\\cmd.exe',
    })

    expect(invocation.program).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(invocation.program.toLowerCase()).not.toMatch(/\\.cmd$/u)
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(invocation.args[3]).toBe('call "' + pnpm + '" install --offline --no-frozen-lockfile')
  })

  it('keeps the fixed install arguments separate and preserves the corepack prefix', () => {
    const corepack = 'C:\\Program Files\\nodejs\\corepack.cmd'
    const invocation = packageManagerInvocation({
      program: corepack,
      prefix: ['pnpm'],
      platform: 'win32',
      comSpec: 'cmd.exe',
    })

    expect(invocation.args[3]).toBe('call "' + corepack + '" pnpm install --offline --no-frozen-lockfile')
  })

  it('keeps direct executable invocation on non-Windows', () => {
    expect(packageManagerInvocation({
      program: '/usr/local/bin/pnpm',
      prefix: [],
      platform: 'linux',
    })).toEqual({
      program: '/usr/local/bin/pnpm',
      args: ['install', '--offline', '--no-frozen-lockfile'],
    })
  })

  it.runIf(process.platform === 'win32')('runs a version probe through the resolved launcher', () => {
    const launcher = resolvePnpm()
    const invocation = packageManagerInvocation({
      ...launcher,
      commandArgs: ['--version'],
    })
    const options = {
      encoding: 'utf8' as const,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32',
    }
    const version = execFileSync(invocation.program, [...invocation.args], options).trim()

    expect(invocation.program.toLowerCase()).not.toMatch(/\.(cmd|bat)$/u)
    expect(version).toMatch(/^\d+\.\d+/u)
  })
})
