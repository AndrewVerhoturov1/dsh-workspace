import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createWriterRuntime,startWriterControl} from '../writer-runtime.mjs';

const until=async predicate=>{const deadline=Date.now()+10000;while(!predicate()){if(Date.now()>deadline)throw Error('Test condition timed out');await delay(10);}};
const execute=()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--version'],{stdio:'ignore',windowsHide:true});
  child.once('error',reject);child.once('exit',code=>code===0?resolve('finished'):reject(Error('test child failed')));
});

test('a buffered pre-effect census cannot release a lease before a causally acknowledged post-effect snapshot',{timeout:15000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'ordinary-census-barrier-')),helper=join(root,'old-buffer.ps1');
  // Negative protocol test only. These synthetic rows never constitute positive
  // Windows lifecycle evidence: the helper deliberately never acknowledges the
  // post-effect request. Real Win32 lifecycle is covered by ordinary.integration.
  await writeFile(helper,`param([int]$OwnerPid)
$first=[Console]::In.ReadLine()|ConvertFrom-Json
$rows=@(@{pid=$OwnerPid;parent=0;birth='1'},@{pid=$PID;parent=$OwnerPid;birth='2'})
[Console]::Out.WriteLine((@{version=1;sequence=1;ack=$first.ticket;rows=$rows}|ConvertTo-Json -Depth 4 -Compress))
$null=[Console]::In.ReadLine()
[Console]::Out.WriteLine((@{version=1;sequence=2;ack=$first.ticket;rows=$rows}|ConvertTo-Json -Depth 4 -Compress))
$null=[Console]::In.ReadToEnd()
`);
  const runtime=createWriterRuntime({root:join(root,'channels'),censusHelper:helper}),spaces={getWorkspace:async()=>({root})};
  t.after(async()=>{runtime.closeObservation();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  let exited=false;
  const pending=runtime.runTool('bash',{workspace_id:'test'},{},spaces,async()=>{const result=await execute();exited=true;return result;});
  await until(()=>exited);await delay(250);
  assert.deepEqual(runtime.untrackedRoots(),[root],'a higher sequence with the old acknowledgement is not a post-exit census');
  assert.equal(await pending,'finished');
  assert.equal((await runtime.ordinaryAdmission(root)).status,'EXIT_UNPROVEN');
});

test('collector loss preserves the original tool rejection and only the retained root; stale close cannot replace a newer controller',{timeout:15000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'ordinary-census-loss-')),channels=join(root,'channels');await mkdir(channels);
  const file=join(root,'writer-control.json'),runtime=createWriterRuntime({root:channels,censusHelper:join(root,'absent.ps1')});
  const control=await startWriterControl(runtime,{file});let replacement;
  t.after(async()=>{await control.close();if(replacement)await replacement.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const sentinel=Error('ORIGINAL_UPSTREAM_REJECTION');
  await assert.rejects(runtime.runTool('bash',{workspace_id:'test'},{},{getWorkspace:async()=>({root})},async()=>{await execute();throw sentinel;}),error=>error===sentinel);
  assert.equal((await runtime.ordinaryAdmission(root)).status,'EXIT_UNPROVEN');
  assert.equal((await runtime.ordinaryAdmission(join(tmpdir(),'unrelated-'+Date.now()))).ok,true);
  const fresh=createWriterRuntime({root:channels});replacement=await startWriterControl(fresh,{file});
  const current=JSON.parse(await readFile(file,'utf8'));
  await control.close();await delay(100);
  assert.equal(JSON.parse(await readFile(file,'utf8')).secret,current.secret,'a late old controller must not overwrite the new endpoint');
  assert.equal((await fresh.ordinaryAdmission(root)).status,'EXIT_UNPROVEN','cold restart cannot recover the lost complete census');
});

test('an active ordinary file write holds its root until the actual handler finishes without a native tombstone',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ordinary-write-lease-')),file=join(root,'preserved.txt');
  const runtime=createWriterRuntime({root:join(root,'channels')}),entered=Promise.withResolvers(),finish=Promise.withResolvers();
  t.after(async()=>{finish.resolve();runtime.closeObservation();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const pending=runtime.runTool('write',{workspace_id:'test'},{},{getWorkspace:async()=>({root})},async()=>{
    entered.resolve();await finish.promise;await writeFile(file,'actual file contents');return 'written';
  });
  await entered.promise;
  assert.equal((await runtime.ordinaryAdmission(root)).status,'OTHER_WRITER_ACTIVE');
  assert.equal((await runtime.ordinaryAdmission(join(tmpdir(),'disjoint-write-root'))).ok,true);
  finish.resolve();assert.equal(await pending,'written');
  assert.equal(await readFile(file,'utf8'),'actual file contents');
  assert.equal((await runtime.ordinaryAdmission(root)).ok,true);
  assert.deepEqual(runtime.untrackedRoots(),[]);assert.deepEqual(runtime.ordinaryLeases(),[]);
});

test('lost census generation does not veto upstream work or overwrite the newer controller',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ordinary-census-generation-')),file=join(root,'writer-control.json');
  const runtime=createWriterRuntime({root:join(root,'channels')}),control=await startWriterControl(runtime,{file});
  t.after(async()=>{await control.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const descriptor=JSON.parse(await readFile(file,'utf8'));await writeFile(file,JSON.stringify({...descriptor,secret:'new-controller-generation'}));
  let invoked=false;
  const upstream=Error('UPSTREAM_SENTINEL');
  await assert.rejects(runtime.runTool('write',{workspace_id:'test'},{},{getWorkspace:async()=>({root})},async()=>{invoked=true;throw upstream;}),error=>error===upstream);
  assert.equal(invoked,true);
  assert.equal(JSON.parse(await readFile(file,'utf8')).secret,'new-controller-generation');
});
