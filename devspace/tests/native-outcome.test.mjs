import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,copyFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {channel} from 'node:diagnostics_channel';
import {createBackgroundFixture,quote} from './background-fixture.mjs';

test('lost native outcome fences further effects but permits addressed status/stop and reads', {timeout:60000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'postman-native-outcome-'));
  const helper=join(dir,'helper.ps1');
  // Artificial loss of the controller's terminal receipt. No exit is invented.
  writeFileSync(helper,"$null=[Console]::ReadLine(); [Console]::WriteLine('{\"version\":1,\"event\":\"started\"}'); [Console]::WriteLine('lost-native-receipt'); exit 0");
  const f=await createBackgroundFixture({runtimeOptions:{helper}});
  t.after(async()=>{await f.close();rmSync(dir,{recursive:true,force:true});});
  const scope='exact-owner',opened=await f.call('open_workspace',{path:'postman-writer:'+f.binding.jobId},scope);
  assert(!opened.isError,JSON.stringify(opened));
  const workspace_id=opened.structuredContent.workspace_id;
  const call=args=>f.call('bash',{workspace_id,...args},scope);
  const closed=Promise.withResolvers(),spawned=channel('child_process');
  const observe=({process:child})=>child.once('spawn',()=>{if(child.spawnargs?.includes(helper))child.once('close',closed.resolve);});
  spawned.subscribe(observe);
  t.after(()=>spawned.unsubscribe(observe));
  const first=await call({execution:'background',command:'echo original',timeout:1});
  const nativeJobId=first.structuredContent.native_job_id;
  assert.ok(nativeJobId,JSON.stringify(first));
  await closed.promise;
  const descriptor=JSON.parse(readFileSync(join(f.channel,'native-jobs',nativeJobId+'.json'),'utf8'));
  for(const key of ['requestId','leaderSessionId','branch','writeRoot'])assert.equal(descriptor[key],f.binding[key]);
  assert.equal(descriptor.bridgeJobId,f.binding.jobId);assert.equal(descriptor.scope,scope);assert.equal(descriptor.cwd,f.project);
  copyFileSync(fileURLToPath(new URL('../writer-process.ps1',import.meta.url)),helper);
  const write=await f.call('write',{workspace_id,path:'unsafe-after-unknown.txt',content:'must not run'},scope);
  const restarted=await call({execution:'background',command:'node -e '+quote("require('node:fs').writeFileSync('restarted.txt','unexpected');setInterval(()=>{},1000)"),timeout:2});
  console.log(JSON.stringify({phase:'unknown-admission',writeDenied:write.isError===true,restartDenied:restarted.isError===true,
    restartedNativeJobId:restarted.structuredContent?.native_job_id??null}));
  try {
    assert.equal(write.isError,true,JSON.stringify(write));
    assert.match(JSON.stringify(write),/WRITER_NATIVE_OUTCOME_UNKNOWN/);
    assert.equal(restarted.isError,true,JSON.stringify(restarted));
    assert.match(JSON.stringify(restarted),/WRITER_NATIVE_OUTCOME_UNKNOWN/);
    assert.equal(existsSync(join(f.project,'unsafe-after-unknown.txt')),false);
    assert.equal(existsSync(join(f.project,'restarted.txt')),false);
    const status=await call({execution:'status',job_id:nativeJobId});
    assert.equal(status.structuredContent.state,'UNKNOWN');
    assert.equal(status.structuredContent.treeSettled,false);
    const read=await f.call('read',{workspace_id,path:'absent.txt'},scope);
    assert.doesNotMatch(JSON.stringify(read),/WRITER_NATIVE_OUTCOME_UNKNOWN/);
    const stopped=await call({execution:'stop',job_id:nativeJobId});
    assert.equal(stopped.structuredContent.treeSettled,false,'stop cannot manufacture the lost terminal proof');
    const foreign=await f.call('bash',{workspace_id,execution:'status',job_id:nativeJobId},'foreign');
    assert.equal(foreign.isError,true);
    const cold=f.runtimeModule.createWriterRuntime({root:join(f.root,'channels')});
    const coldCall=input=>cold.runTool('bash',{workspace_id,...input},{_meta:{'openai/session':scope}},
      {getWorkspace:async()=>({root:f.project})},()=>cold.background(input,{cwd:f.project},()=>{throw Error('inspection cannot start a shell');}));
    const restored=await coldCall({execution:'status',job_id:nativeJobId});
    assert.equal(restored.structuredContent.treeSettled,false);
    assert.equal(restored.structuredContent.evidence,'GENERATION_CENSUS_LOST');
    const refused=await coldCall({execution:'background',command:'must not start'});
    assert.equal(refused.isError,true);
    console.log(JSON.stringify({scenario:'native-outcome-lost',bridgeJobId:f.binding.jobId,requestId:f.binding.requestId,nativeJobId,
      owner:scope,workspace:workspace_id,restartAllowed:false,treeSettled:false,modelRequests:0}));
  } finally {
    if(restarted.structuredContent?.native_job_id)await call({execution:'stop',job_id:restarted.structuredContent.native_job_id});
  }
});
