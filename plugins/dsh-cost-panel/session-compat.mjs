import { readFileSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// rc.2 validates this envelope marker when reading, but its append path drops it.
// Replace files atomically so pnpm's shared hardlinks remain untouched.
export function applySessionIgnorableEvents(anchors) {
  const paths = new Set(anchors.map(anchor => realpathSync(createRequire(anchor).resolve('@deepseek-ai/dsh-session'))));
  const before = '\t\tconst surfaceMetadata = {\n';
  const after = before + '\t\t\t...surfaceOpts?.ignorable === true ? { ignorable: true } : {},\n';
  const prepared = [...paths].map(path => {
    const source = readFileSync(path, 'utf8');
    if (source.includes(after)) return { path, updated: false };
    if (!source.includes('append(type, data, ...opts)') || source.split(before).length !== 2)
      throw new Error('Session append compatibility patch preimage mismatch: ' + path);
    return { path, updated: true, source: source.replace(before, after) };
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
