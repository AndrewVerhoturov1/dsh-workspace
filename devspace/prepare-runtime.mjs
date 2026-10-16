import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = process.argv[2];
const pkg = join(root, 'node_modules/@waishnav/devspace');
if (JSON.parse(readFileSync(join(pkg, 'package.json'))).version !== '1.1.0-beta.4') throw new Error('Unreviewed DevSpace version; no patch applied');
const file = join(pkg, 'dist/pi-tools.js');
const original = readFileSync(file, 'utf8');
const before = 'export async function runShellTool(input, context) {';
const after = `// DSH: bound active Bash calls; never queue or replay commands after disconnect.
let dshActiveShells = 0;
export async function runShellTool(input, context) {
    if (dshActiveShells >= 8) return { content: [{ type: "text", text: "Eight Bash calls are already running. No command was started." }], isError: true };
    dshActiveShells++;
    try { return await dshRunShellTool(input, context); }
    finally { dshActiveShells--; }
}
async function dshRunShellTool(input, context) {`;
if (original.includes(after)) { console.log('Runtime limit already installed'); }
else {
  const digest = createHash('sha256').update(original).digest('hex');
  if (digest !== '98f0b596058dad3aa34d99f6735ef9fdb5f1053844da41f7a59117e4d9fd6b00' || original.split(before).length !== 2) throw new Error('Unexpected upstream source; preserved');
  const backup = file + '.dsh-original';
  if (existsSync(backup) && readFileSync(backup, 'utf8') !== original) throw new Error('Backup differs; preserved');
  if (!existsSync(backup)) writeFileSync(backup, original);
  writeFileSync(file, original.replace(before, after));
  console.log('Runtime limit installed');
}

