import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupRuntimeSandbox } from '../src/runtime/cleanup.ts'
import { sourceFromExternalWorktree, sourceFromTask, staleSourceReason } from '../src/runtime/descriptor.ts'
import { TaskId, type TaskView } from '../src/types.ts'
import { createRepositoryFixture, git, removeFixture } from './helpers.ts'
import { generateRuntimePackage } from '../src/runtime/profile-snapshot.ts'
import { isExpectedProcessRecord } from '../src/runtime/runtime-controller.ts'

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
