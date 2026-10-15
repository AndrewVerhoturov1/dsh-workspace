import { readFileSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// rc.2 validates this envelope marker when reading, but its append path drops it.
// Replace files atomically so pnpm's shared hardlinks remain untouched.
const sessionImages = new Map([
  ['dc14c845b915a9faaeb867499966e7b1991af3b6285f314bf353417e939d9c36', '4e397f47c300d0e5ea195b381719356144ccaa1117866f8f7eefa9caba3c3312'],
  ['c8fab6a1d8cd56613dab9037852d54e35d98358e248ded3c9dfd729cc2df817c', 'ce7d3f8965427ab9870868a6e38a5f0ade252942d1fc10eeb575d2180190b5df'],
  ['94f795be373b553dcb9aa8b4c16475abcc4e3afd3340c015a6c7e44a46bfcd87', 'e76438e4007543a00c58ef1c7c9c623e49cc540db13bfa134da7d3c68011d382'],
]);
const hash = source => createHash('sha256').update(source.replaceAll('\r', '')).digest('hex');
export function applySessionIgnorableEvents(anchors) {
  const paths = new Set(anchors.map(anchor => realpathSync(createRequire(anchor).resolve('@deepseek-ai/dsh-session'))));
  const prepared = [...paths].map(path => {
    const source = readFileSync(path, 'utf8');
    // Retain the native SDK file's line endings; installed Windows images may be CRLF.
    const newline = source.includes('\t\tconst surfaceMetadata = {\r\n') ? '\r\n' : '\n';
    const before = '\t\tconst surfaceMetadata = {' + newline;
    const after = before + '\t\t\t...surfaceOpts?.ignorable === true ? { ignorable: true } : {},' + newline;
    const digest = hash(source);
    if ([...sessionImages.values()].includes(digest)) return { path, updated: false };
    if (!sessionImages.has(digest)) throw new Error('Session append compatibility patch preimage mismatch: ' + path);
    const patched = source.replace(before, after);
    if (hash(patched) !== sessionImages.get(digest)) throw new Error('Session append compatibility patch postimage mismatch: ' + path);
    return { path, updated: true, source: patched };
  });
  for (const target of prepared) {
    if (!target.updated) continue;
    const staged = target.path + '.cost-panel-' + randomUUID();
    try {
      writeFileSync(staged, target.source, { flag: 'wx' });
      renameSync(staged, target.path);
    } finally {
      try { unlinkSync(staged); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return prepared.map(({ path, updated }) => ({ path, updated }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(applySessionIgnorableEvents(process.argv.slice(2))));
