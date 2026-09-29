import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const denied = /PTC_FILESYSTEM_BOUNDARY_REJECTED/
test('existing canonical target: relative, absolute inside and normalized internal parent', () => fixture(async ({ root }) => {
  assert.equal(await resolvePtcWorktreePath(root, 'proof.txt'), join(root, 'proof.txt'))
  assert.equal(await resolvePtcWorktreePath(root, join(root, 'proof.txt')), join(root, 'proof.txt'))
  assert.equal(await resolvePtcWorktreePath(root, join('safe', '..', 'proof.txt')), join(root, 'proof.txt'))
  // The normalized absolute path sent to DSH omits the junction segment entirely.
  assert.equal(await resolvePtcWorktreePath(root, 'escape-link/../proof.txt'), join(root, 'proof.txt'))
}))

test('absolute outside, parent escapes and junction targets fail closed', () => fixture(async ({ root, outside }) => {
  for (const path of [join(outside, 'secret.txt'), '../outside/secret.txt', '../../outside/secret.txt', 'safe/../../outside/secret.txt',
    'escape-link/secret.txt', 'escape-link'])
    await assert.rejects(resolvePtcWorktreePath(root, path), denied, path)
}))

test('future target uses canonical existing parent and never accepts junction or traversal', () => fixture(async ({ root }) => {
  assert.equal(await resolvePtcWorktreePath(root, 'new/file.txt'), join(root, 'new', 'file.txt'))
  await assert.rejects(resolvePtcWorktreePath(root, 'escape-link/new.txt'), denied)
  await assert.rejects(resolvePtcWorktreePath(root, '../outside/new.txt'), denied)
  await assert.rejects(resolvePtcWorktreePath(root, 'escape-link/missing/deep.txt'), denied)
}))
