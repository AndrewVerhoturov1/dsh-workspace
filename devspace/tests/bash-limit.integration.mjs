import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const install=process.env.DEVSPACE_INSTALL_ROOT ?? 'C:/Users/Andrew/.dsh/devspace';
const root=mkdtempSync(join(tmpdir(),'devspace-bash-limit-'));
const pkg=join(root,'node_modules/@waishnav/devspace');mkdirSync(join(pkg,'dist'),{recursive:true});
const sourceFile=join(install,'node_modules/@waishnav/devspace/dist/pi-tools.js');
const original=readFileSync(existsSync(sourceFile+'.dsh-original')?sourceFile+'.dsh-original':sourceFile);
const file=join(pkg,'dist/pi-tools.js');writeFileSync(file,original);writeFileSync(join(pkg,'package.json'),'{"version":"1.1.0-beta.4"}');
const serverSource=join(install,'node_modules/@waishnav/devspace/dist/server.js');
copyFileSync(existsSync(serverSource+'.dsh-original')?serverSource+'.dsh-original':serverSource,join(pkg,'dist/server.js'));
mkdirSync(join(pkg,'dist/tool-surfaces'),{recursive:true});
const surfaceSource=join(install,'node_modules/@waishnav/devspace/dist/tool-surfaces/claude.js');
const surfaceOriginal=readFileSync(existsSync(surfaceSource+'.dsh-original')?surfaceSource+'.dsh-original':surfaceSource);
const surface=join(pkg,'dist/tool-surfaces/claude.js');writeFileSync(surface,surfaceOriginal);
symlinkSync(join(install,'node_modules'),join(pkg,'node_modules'),'junction');
for(const name of ['writer-runtime.mjs','writer-process.ps1','ordinary-process.ps1']) copyFileSync(fileURLToPath(new URL('../'+name,import.meta.url)),join(root,name));
const patcher=fileURLToPath(new URL('../prepare-runtime.mjs',import.meta.url));
const checkedFiles=[file,join(pkg,'dist/server.js'),surface];
const beforeCheck=checkedFiles.map(path=>readFileSync(path,'utf8'));
const stale=spawnSync(process.execPath,[patcher,root,'--check'],{encoding:'utf8'});
assert.notEqual(stale.status,0,'read-only preflight must refuse an unprepared runtime');
assert.deepEqual(checkedFiles.map(path=>readFileSync(path,'utf8')),beforeCheck,'check must never apply patches');
assert(checkedFiles.every(path=>!existsSync(path+'.dsh-original')),'check must not create backups');
// The real runner must reject a stale install before opening a listener or writer control.
for(const name of ['server-runner.mjs','prepare-runtime.mjs'])copyFileSync(fileURLToPath(new URL('../'+name,import.meta.url)),join(root,name));
const refusedStart=spawnSync(process.execPath,[join(root,'server-runner.mjs')],{encoding:'utf8',timeout:10000,
  env:{...process.env,LOCALAPPDATA:root,DEVSPACE_CONFIG_DIR:join(root,'unused-config')}});
assert.equal(refusedStart.status,1,refusedStart.stdout+refusedStart.stderr);
assert(!existsSync(join(root,'logs'))&&!existsSync(join(root,'writer-control.json')),'preflight precedes all runtime startup writes');
console.log('PASS stale runtime refused before startup; read-only check preserves all bytes and backups');
// Replay the installed legacy limiter, not just a clean npm package.
const legacyLimiter=`// DSH: bound active Bash calls; never queue or replay commands after disconnect.
let dshActiveShells = 0;
export async function runShellTool(input, context) {
    if (dshActiveShells >= 8) return { content: [{ type: "text", text: "Eight Bash calls are already running. No command was started." }], isError: true };
    dshActiveShells++;
    try { return await dshRunShellTool(input, context); }
    finally { dshActiveShells--; }
}
async function dshRunShellTool(input, context) {`;
const legacy=original.toString().replace('export async function runShellTool(input, context) {',legacyLimiter);
writeFileSync(file,legacy);writeFileSync(file+'.dsh-original',original);
assert.notEqual(spawnSync(process.execPath,[patcher,root,'--check'],{encoding:'utf8'}).status,0);
assert.equal(readFileSync(file,'utf8'),legacy,'legacy preflight must not apply a migration');
assert.equal(spawnSync(process.execPath,[patcher,root],{encoding:'utf8'}).status,0);
const patched=readFileSync(file,'utf8');
const patchedSurface=readFileSync(surface,'utf8');
assert.equal(spawnSync(process.execPath,[patcher,root,'--check'],{encoding:'utf8'}).status,0);
assert.equal(spawnSync(process.execPath,[patcher,root],{encoding:'utf8'}).status,0);
assert.equal(readFileSync(file,'utf8'),patched);
assert.equal(readFileSync(file+'.dsh-original','utf8'),original.toString());
assert.equal(readFileSync(surface+'.dsh-original','utf8'),surfaceOriginal.toString());
assert.equal(readFileSync(surface,'utf8'),patchedSurface);
console.log('PASS legacy limiter migration, guarded patch, original backup and idempotent installation');
const agent=pathToFileURL(join(install,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
const module=await import('data:text/javascript;base64,'+Buffer.from(patched.replace('"@earendil-works/pi-coding-agent"',JSON.stringify(agent))).toString('base64'));
process.env.PATH='C:/Program Files/Git/bin;C:/Program Files/nodejs;'+process.env.PATH;
const active=Array.from({length:8},()=>module.runShellTool({command:'node -e "setTimeout(()=>console.log(1),1800)"',timeout:10},{cwd:root}));
const ninth=await module.runShellTool({command:'node -e "process.exit(99)"',timeout:10},{cwd:root});
assert(ninth.isError&&JSON.stringify(ninth).includes('Eight Bash'));
assert((await Promise.all(active)).every(v=>!v.isError));
assert(!(await module.runShellTool({command:'node --version',timeout:10},{cwd:root})).isError);
console.log('PASS eight parallel commands, ninth refused before execution, capacity restored');
// Upstream MCP does not forward Signal. Check its actual executor API separately,
// using precisely the default operations choice made inside an ordinary ALS scope.
const {createBashTool}=await import(agent);
const {createWriterRuntime}=await import(pathToFileURL(join(root,'writer-runtime.mjs')));
const runtime=createWriterRuntime({root:join(root,'channels')});
let cancelChecked=false;
await runtime.runTool('bash',{workspace_id:'ordinary'},{_meta:{'openai/session':'ordinary-cancel'}},{getWorkspace:async()=>({root})},async()=>{
  const operations=runtime.bashOperations(()=>{throw Error('ordinary cancellation selected Postman helper')});
  assert.equal(operations,undefined);
  const controller=new AbortController();
  const tool=createBashTool(root,{operations});
  const canceled=assert.rejects(tool.execute('native-cancel',{command:'node -e "const fs=require(\'node:fs\');fs.writeFileSync(\'cancel-started\',\'yes\');setTimeout(()=>fs.writeFileSync(\'cancel-survived\',\'bad\'),1500)"',timeout:10},controller.signal),/aborted/i);
  for(let i=0;i<80&&!existsSync(join(root,'cancel-started'));i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert(existsSync(join(root,'cancel-started')),'real upstream child started');
  controller.abort();await canceled;
  await new Promise(resolve=>setTimeout(resolve,1700));
  assert(!existsSync(join(root,'cancel-survived')),'upstream abort actually cancels its own process');
  cancelChecked=true;
});
assert(cancelChecked,'real upstream cancellation assertions completed');
console.log('PASS actual upstream Bash AbortSignal in unbound ALS; MCP does not forward Signal');
writeFileSync(file,'// unknown upstream source');
assert.notEqual(spawnSync(process.execPath,[patcher,root],{encoding:'utf8'}).status,0);
assert.equal(readFileSync(file,'utf8'),'// unknown upstream source');
console.log('PASS unknown upstream source preserved');
writeFileSync(file,patched);writeFileSync(surface,'// unknown MCP surface');
assert.notEqual(spawnSync(process.execPath,[patcher,root],{encoding:'utf8'}).status,0);
assert.equal(readFileSync(surface,'utf8'),'// unknown MCP surface');assert.equal(readFileSync(file,'utf8'),patched);
console.log('PASS unknown MCP schema source refused before writing known executor');
writeFileSync(join(root,'results.json'),JSON.stringify({passed:6,root,productionFilesChanged:false}));
console.log(JSON.stringify({passed:6,root}));
