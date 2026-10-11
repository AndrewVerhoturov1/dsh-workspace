import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import { Session, SessionStore } from '@deepseek-ai/dsh-session';
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { repairCostPanelSessions } from './repair-sessions.mjs';

const sdkAnchor = fileURLToPath(import.meta.url);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cost-repair-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const root = join(directory, 'sessions'), backup = join(directory, 'backup');
  const ctx = new Context(); new SessionStore(ctx);
  const persistence = new JsonlSessionPersistence(ctx, { root });
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  async function save(id, required = false) {
    const session = Session.create(id, [], { id, version: 0, createdAt: Date.now(), cwd: directory });
    session.append('turn/start', { turn: 1 });
    session.append('cost-panel/attempt', { id: 1, status: 'started', usage: null });
    session.append('cost-panel/attempt', { id: 1, status: 'stop', usage: { inputTokens: 7, outputTokens: 3 } });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    if (required) session.append('extension/required-test', { necessary: true });
    await persistence.create(session.header); await persistence.append(id, session.events);
    return { session, path: persistence.locate(session.header).path };
  }
  return { root, backup, persistence, save };
}

test('offline repair backs up exact bytes, preserves all native events and is a no-op on a second run', async t => {
  const f = await fixture(t), { session, path } = await f.save('legacy');
  const original = await readFile(path);
  await assert.rejects(f.persistence.inspect(session.id), /unknown to this harness/);
  const result = await repairCostPanelSessions({ root: f.root, backup: f.backup, sdkAnchor });
  assert.equal(result.repaired.length, 1);
  assert.equal(result.repaired[0].marked, 2);
  assert.deepEqual(await readFile(result.repaired[0].originalPath), original);
  assert.deepEqual((await f.persistence.inspect(session.id)).events, session.events.map(e => e.type === 'cost-panel/attempt' ? { ...e, ignorable: true } : e));
  const repaired = await readFile(path);
  const again = await repairCostPanelSessions({ root: f.root, backup: f.backup + '-second', sdkAnchor });
  assert.equal(again.repaired.length, 0);
  assert.deepEqual(await readFile(path), repaired);
});

test('an unknown required event fails preflight without modifying any original log', async t => {
  const f = await fixture(t), first = await f.save('a-valid'), second = await f.save('z-required', true);
  const originals = await Promise.all([first.path, second.path].map(path => readFile(path)));
  await assert.rejects(repairCostPanelSessions({ root: f.root, backup: f.backup, sdkAnchor }), /unknown to this harness and not marked ignorable/);
  assert.deepEqual(await readFile(first.path), originals[0]);
  assert.deepEqual(await readFile(second.path), originals[1]);
});

test('an incomplete zstd tail is preserved and refused even when it has no recovered events', async t => {
  const f = await fixture(t), { path } = await f.save('torn');
  const frame = zstdCompressSync('unfinished record');
  await appendFile(path, frame.subarray(0, frame.length - 2));
  const original = await readFile(path);
  await assert.rejects(repairCostPanelSessions({ root: f.root, backup: f.backup, sdkAnchor }), /Refusing to discard a torn log tail/);
  assert.deepEqual(await readFile(path), original);
});
