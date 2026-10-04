import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolvePtcWorktreePath } from './ptc-worktree-boundary.js'

async function fixture(fn) {
  const base = await mkdtemp(join(tmpdir(), 'ptc-boundary-'))
  try {
    const root = join(base, 'task'), outside = join(base, 'outside')
    await mkdir(root); await mkdir(outside); await mkdir(join(root, 'safe'))
    await writeFile(join(root, 'proof.txt'), 'МАРКЕР\n')
    await writeFile(join(outside, 'secret.txt'), 'SECRET\n')
    await symlink(outside, join(root, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir')
    return await fn({ base, root, outside })
  } finally { await rm(base, { recursive: true, force: true }) }
}

const denied = /PTC_FILESYSTEM_PATH_INVALID/
test('existing canonical target: relative, absolute inside and normalized internal parent', () => fixture(async ({ root }) => {
  assert.equal(await resolvePtcWorktreePath(root, 'proof.txt'), join(root, 'proof.txt'))
  assert.equal(await resolvePtcWorktreePath(root, join(root, 'proof.txt')), join(root, 'proof.txt'))
  assert.equal(await resolvePtcWorktreePath(root, join('safe', '..', 'proof.txt')), join(root, 'proof.txt'))
  // The normalized absolute path sent to DSH omits the junction segment entirely.
  assert.equal(await resolvePtcWorktreePath(root, 'escape-link/../proof.txt'), join(root, 'proof.txt'))
}))

test('outside, parent and junction paths are delegated to ordinary filesystem policy', () => fixture(async ({ root, outside }) => {
  for (const path of [join(outside, 'secret.txt'), '../outside/secret.txt', '../../outside/secret.txt', 'safe/../../outside/secret.txt',
    'escape-link/secret.txt', 'escape-link', 'escape-link/new.txt', '../outside/new.txt', 'escape-link/missing/deep.txt'])
    assert.equal(await resolvePtcWorktreePath(root, path), resolve(root, path))
}))

test('invalid path forms still fail before dispatch', () => fixture(async ({ root }) => {
  for (const path of ['', ' ', '\0', 'C:relative.txt', null, 1])
    await assert.rejects(resolvePtcWorktreePath(root, path), denied)
  await assert.rejects(resolvePtcWorktreePath('relative-root', 'proof.txt'), denied)
}))
