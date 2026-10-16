import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const root = process.argv[2];
const pkg = join(root, 'node_modules/@waishnav/devspace');
if (JSON.parse(readFileSync(join(pkg, 'package.json'))).version !== '1.1.0-beta.4') throw new Error('Unreviewed DevSpace version; no patch applied');
const file = join(pkg, 'dist/pi-tools.js');
const original = readFileSync(file, 'utf8');
const runtime=pathToFileURL(join(root,'writer-runtime.mjs')).href;
const shellFile=createRequire(file).resolve.paths('@earendil-works/pi-coding-agent')
  .map(base=>join(base,'@earendil-works/pi-coding-agent/dist/utils/shell.js')).find(existsSync);
if(!shellFile) throw Error('Reviewed native shell implementation unavailable; no patch applied');
const shell=pathToFileURL(shellFile).href;
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
const changes=[
  {file,sha:'98f0b596058dad3aa34d99f6735ef9fdb5f1053844da41f7a59117e4d9fd6b00',
    transform:source=>'import {dshWriters} from '+JSON.stringify(runtime)+';\nimport {getShellConfig} from '+JSON.stringify(shell)+';\n'+
      source.replace(before,after).replace('createBashTool(context.cwd);','createBashTool(context.cwd, {operations: dshWriters.bashOperations(getShellConfig)});')},
  {file:join(pkg,'dist/server.js'),sha:'0c7601c4be6b9d3a53ef7b4d672f43a3b728914cf10f255fdaed6c6cd849269a',
    transform:source=>'import {dshWriters} from '+JSON.stringify(runtime)+';\n'+source
      .replace('withTrackedToolHandlers(server, trackToolActivity)','withTrackedToolHandlers(server, trackToolActivity, workspaces)')
      .replace('function withTrackedToolHandlers(server, trackToolActivity) {','function withTrackedToolHandlers(server, trackToolActivity, workspaces) {')
      .replace('trackToolActivity(() => Promise.resolve(handler(...handlerArgs)))',
        'trackToolActivity(() => dshWriters.runTool(args[0], handlerArgs[0], handlerArgs[1], workspaces, () => Promise.resolve(handler(...handlerArgs)), args[1]?.annotations?.readOnlyHint === true))')},
];
// Validate every upstream input before changing either file. Retain original bytes.
const prepared=changes.map(change=>{
  const saved=readFileSync(change.file,'utf8'), backup=change.file+'.dsh-original';
  const canonical=existsSync(backup)?readFileSync(backup,'utf8'):saved;
  if(createHash('sha256').update(canonical).digest('hex')!==change.sha) throw Error('Unexpected upstream source; preserved');
  const patched=change.transform(canonical);
  const legacy=change.file.endsWith('pi-tools.js') ? canonical.replace(before,after) : canonical;
  if(![canonical,legacy,patched].includes(saved)) throw Error('Unexpected patched source; preserved');
  return {...change,canonical,patched,backup};
});
for(const change of prepared) {
  if(!existsSync(change.backup)) writeFileSync(change.backup,change.canonical);
  writeFileSync(change.file,change.patched);
}
console.log('Reviewed Bash limit and native writer instrumentation prepared');

