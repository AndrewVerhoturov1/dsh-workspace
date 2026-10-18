import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inspectLoadedRuntime} from '../runtime-identity.mjs';

test('V8 identity retains loaded bytes after disk changes; cold process sees new bytes',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'runtime-source-proof-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'probe.mjs'),url=pathToFileURL(path).href;
  const first='export const value="Исходный загруженный код";\n';
  const second='export const value="Новый файл на диске";\n';
  await writeFile(path,first,'utf8');
  const loaded=await import(url);
  const target=[{name:'probe',url}];
  const before=await inspectLoadedRuntime(target);
  assert.equal(before.status,'RUNTIME_IDENTITY_PROVEN');
  assert.equal(before.modules.find(item=>item.name==='probe').sha256,createHash('sha256').update(first).digest('hex'));
  await writeFile(path,second,'utf8');
  const after=await inspectLoadedRuntime(target);
  assert.equal(after.sha256,before.sha256,'disk SHA cannot replace the loaded source SHA');
  assert.equal(loaded.value,'Исходный загруженный код');
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    'import {inspectLoadedRuntime} from '+JSON.stringify(new URL('../runtime-identity.mjs',import.meta.url).href)+';'+
    'await import('+JSON.stringify(url)+');console.log(JSON.stringify(await inspectLoadedRuntime('+JSON.stringify(target)+')));'],
    {encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0,child.stderr);
  const cold=JSON.parse(child.stdout);
  assert.equal(cold.status,'RUNTIME_IDENTITY_PROVEN');
  assert.notEqual(cold.instanceId,before.instanceId);assert.notEqual(cold.pid,before.pid);
  assert.equal(cold.modules.find(item=>item.name==='probe').sha256,createHash('sha256').update(second).digest('hex'));
  assert.notEqual(cold.sha256,before.sha256);
  const absent=await inspectLoadedRuntime([{name:'not-loaded',url:pathToFileURL(join(dir,'missing.mjs')).href}]);
  assert.equal(absent.status,'RUNTIME_SHA_UNPROVEN');assert.equal(absent.sha256,undefined);
  await import(url+'?second');
  const ambiguous=await inspectLoadedRuntime(target);
  assert.equal(ambiguous.status,'RUNTIME_SHA_UNPROVEN');assert.equal(ambiguous.diagnostic,'AMBIGUOUS_LOADED_MODULE');
  console.log(JSON.stringify({scenario:'loaded-runtime-vs-disk',sameProcessRetainsLoadedHash:true,coldSeesNewHash:true,
    missingUnproven:true,ambiguousUnproven:true,modelRequests:0}));
});
