import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, isAbsolute, sep, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdCompressSync, constants } from 'node:zlib';

// Offline, explicit repair of the optional accounting events written by 0.1.0.
// Never accept other unknown events, discard a torn tail, or rewrite event data.
export async function repairCostPanelSessions({ root, backup, sdkAnchor }) {
  root = resolve(root); backup = resolve(backup);
  const backupRelative = relative(root, backup);
  if (!backupRelative || (!isAbsolute(backupRelative) && backupRelative !== '..' && !backupRelative.startsWith('..' + sep)))
    throw new Error('Backup directory must be outside the session root');
  const native = createRequire(resolve(sdkAnchor));
  const load = name => import(pathToFileURL(native.resolve('@deepseek-ai/' + name)).href);
  const { Context } = await load('cordis');
  const { SessionStore, decodeStorageRecord } = await load('dsh-session');
  const { JsonlSessionPersistence } = await load('dsh-session-persistence-jsonl');
  const ctx = new Context(), stagedCtx = new Context();
  new SessionStore(ctx); new SessionStore(stagedCtx);
  const persistence = new JsonlSessionPersistence(ctx, { root });
  const staged = new JsonlSessionPersistence(stagedCtx, { root: join(backup, 'validation-sessions') });
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const prepared = [];
  const manifest = { root, backup, scanned: 0, repaired: [] };
  try {
    for (const header of await persistence.list()) {
      manifest.scanned++;
      const raw = await persistence.readRaw(header.id);
      if (!raw) throw new Error('Session disappeared: ' + header.id);
      const lines = raw.content.split('\n');
      const changedSeqs = [];
      const repaired = lines.map((line, index) => {
        if (!index || !line.trim()) return line;
        const row = JSON.parse(line);
        if (row.type !== 'cost-panel/attempt' || row.ignorable !== undefined) return line;
        changedSeqs.push(row.seq);
        const end = line.lastIndexOf('}');
        return line.slice(0, end) + ',"ignorable":true' + line.slice(end);
      }).join('\n');
      if (!changedSeqs.length) continue;
      const path = persistence.locate(raw.meta).path;
      const location = relative(root, path);
      if (!location || isAbsolute(location) || location === '..' || location.startsWith('..' + sep))
        throw new Error('Session outside root: ' + header.id);
      const original = await readFile(path);
      const prefix = await persistence.readZstdPrefix(original);
      assert.equal(prefix.tornMarker, undefined, 'Refusing to discard a torn log tail: ' + header.id);
      const decode = text => text.split('\n').slice(1).filter(line => line.trim()).flatMap(line => decodeStorageRecord(JSON.parse(line)));
      assert.deepEqual(decode(raw.content), prefix.events, 'Refusing to discard a torn or changed log tail: ' + header.id);
      assert.deepEqual(decode(repaired), prefix.events.map(event => changedSeqs.includes(event.seq) ? { ...event, ignorable: true } : event));
      const split = repaired.indexOf('\n') + 1;
      const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
      const bytes = Buffer.concat([zstdCompressSync(repaired.slice(0, split), options), zstdCompressSync(repaired.slice(split), options)]);
      const validationPath = staged.locate(raw.meta).path;
      await mkdir(dirname(validationPath), { recursive: true });
      await writeFile(validationPath, bytes, { flag: 'wx' });
      assert.equal((await staged.readRaw(header.id)).content, repaired);
      assert.deepEqual((await staged.readZstdPrefix(bytes)).events, decode(repaired));
      await staged.inspect(header.id); // Same required-event guard as opening a chat.
      const originalPath = join(backup, 'originals', location);
      await mkdir(dirname(originalPath), { recursive: true });
      await writeFile(originalPath, original, { flag: 'wx' });
      prepared.push({ path, bytes, record: { id: header.id, path, originalPath, events: prefix.events.length,
        marked: changedSeqs.length, originalSha256: digest(original), repairedSha256: digest(bytes) } });
    }
    // Preflight every affected log before replacing any of them. Host must be stopped.
    for (const item of prepared)
      assert.equal(digest(await readFile(item.path)), item.record.originalSha256, 'Log changed during repair: ' + item.record.id);
    manifest.prepared = prepared.map(item => item.record);
    const manifestPath = join(backup, 'repair-manifest.json');
    await mkdir(backup, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    for (const item of prepared) {
      assert.equal(digest(await readFile(item.path)), item.record.originalSha256, 'Log changed during repair: ' + item.record.id);
      const temporary = item.path + '.cost-repair-' + randomUUID();
      try { await writeFile(temporary, item.bytes, { flag: 'wx' }); await rename(temporary, item.path); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      manifest.repaired.push(item.record);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    }
    return manifest;
  } finally { await stagedCtx.fiber.dispose(); await ctx.fiber.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, backup, sdkAnchor] = process.argv.slice(2);
  if (!root || !backup || !sdkAnchor) throw new Error('Usage (Host stopped): node repair-sessions.mjs <sessions-root> <new-backup-directory> <dsh-package.json>');
  const result = await repairCostPanelSessions({ root, backup, sdkAnchor });
  console.log(JSON.stringify({ scanned: result.scanned, repaired: result.repaired.length,
    marked: result.repaired.reduce((count, item) => count + item.marked, 0), backup: result.backup }));
}
