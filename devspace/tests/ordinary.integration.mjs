// Native ordinary lifecycle and admission through real isolated OAuth/MCP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {createBackgroundFixture,quote}=await import(process.env.DSH_TEST_BASE_FIXTURE
  ?pathToFileURL(process.env.DSH_TEST_BASE_FIXTURE).href:new URL('./background-fixture.mjs',import.meta.url).href);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const node=source=>'node -e '+quote(source);
const output=result=>JSON.stringify(result);
const code=result=>result.content?.find(item=>item.type==='text')?.text;
async function until(predicate,name) {
  for(let i=0;i<150;i++){if(await predicate())return;await delay(100)}
  assert.fail(name);
}
async function fixture(operation) {
  const f=await createBackgroundFixture();
  const controlFile=join(f.root,'ordinary-control.json');
  const control=await f.runtimeModule.startWriterControl(f.writers,{file:controlFile});
  try {return await operation(f,controlFile)} finally {await control.close();await f.close()}
}
async function open(f,root=f.project,scope='ordinary') {
  const result=await f.call('open_workspace',{path:root},scope);assert(!result.isError,output(result));
  return result.structuredContent.workspace_id;
}
async function admission(f,path='new-writer.txt') {
  const result=await f.call('open_workspace',{path:'postman-writer:'+f.binding.jobId});
  if(result.isError)return result;
  return await f.call('write',{workspace_id:result.structuredContent.workspace_id,path,content:'preserved writer data'});
}
function gate(f,name) {
  return {started:join(f.project,name+'-started'),release:join(f.project,name+'-release'),
    command:node("const fs=require('node:fs');fs.writeFileSync('"+name+"-started','yes');const timer=setInterval(()=>{if(fs.existsSync('"+name+"-release')){clearInterval(timer);console.log('GATE_COMPLETED')}},50);setTimeout(()=>{clearInterval(timer)},25000).unref()")};
}

test('A1 finite ordinary Bash leaves neither memory nor durable hold; actual same-root Postman admission succeeds',{timeout:45000},()=>fixture(async(f,controlFile)=>{
  const workspace_id=await open(f);
  const result=await f.call('bash',{workspace_id,command:node("console.log('FINITE_NO_CHILDREN');console.log(process.pid)"),timeout:5},'ordinary');
  assert(!result.isError&&output(result).includes('FINITE_NO_CHILDREN'),'real finite command completed');
  const roots=f.writers.untrackedRoots(),next=await admission(f);
  console.log(JSON.stringify({case:'A1',source:process.env.DSH_TEST_BASE_FIXTURE?'exact d36 archive':'working source',
    finiteCompleted:!result.isError,retainedRoot:roots.includes(f.project),retainedRoots:roots.length,
    admissionDenied:!!next.isError,admissionCode:next.isError?code(next):null}));
  assert(!next.isError,'A1: finite ordinary completion permits a same-root Postman write');
  assert(!f.writers.untrackedRoots().includes(f.project),'both memory hold readers are clear');
  assert.equal(f.writers.ordinaryLeases().some(lease=>lease.writeRoot===f.project),false,'otherTools has no retained finite Bash entry');
  const saved=JSON.parse(readFileSync(controlFile,'utf8'));
  const cold=f.runtimeModule.createWriterRuntime({root:join(f.root,'channels')});
  cold.restoreCensus(saved.untrackedRoots,()=>{});
  assert(!cold.untrackedRoots().includes(f.project),'finite completion is not restored as UNKNOWN');
  assert.equal(readFileSync(join(f.project,'new-writer.txt'),'utf8'),'preserved writer data');
}));

test('A2 real handler throw keeps upstream error and clears its unused ordinary lease',{timeout:45000},()=>fixture(async f=>{
  const workspace_id=await open(f);
  const failed=await f.call('bash',{workspace_id,working_directory:'missing-working-directory',command:node("console.log('UNREACHABLE')"),timeout:5},'ordinary');
  assert(failed.isError,'upstream rejects missing working directory');
  assert(!output(failed).includes('WRITER_BINDING_CHANGED'),'real handler failure is not a false binding refusal');
  assert.match(output(failed),/directory|ENOENT|exist/i);
  const next=await admission(f);
  assert(!next.isError,'A2: failed ordinary handler does not leave an eternal same-root hold');
  assert(!f.writers.untrackedRoots().includes(f.project));
  assert.equal(f.writers.ordinaryLeases().some(lease=>lease.writeRoot===f.project),false,'the rejected ordinary handler leaves no otherTools entry');
}));

test('B actual MCP missing workspace and missing file retain provider error shape',{timeout:30000},()=>fixture(async f=>{
  const missingWorkspace=await f.call('bash',{workspace_id:'missing-test-workspace',command:'node --version',timeout:5},'provider-errors');
  assert(missingWorkspace.isError,'real missing workspace is a tool error');
  assert(!output(missingWorkspace).includes('WRITER_BINDING_CHANGED'));
  assert.match(output(missingWorkspace),/workspace|not found|unknown/i);
  const workspace_id=await open(f,f.project,'provider-errors');
  const missingFile=await f.call('read',{workspace_id,path:'missing-test-file'},'provider-errors');
  assert(missingFile.isError,'real missing file remains structured isError');
  assert(!output(missingFile).includes('WRITER_BINDING_CHANGED'));
  assert.match(output(missingFile),/ENOENT|not found|no such/i);
}));

test('A3 parallel ordinary calls do not veto Leader-authorized same-root Postman work',{timeout:60000},()=>fixture(async f=>{
  const workspace_id=await open(f),first=gate(f,'first'),second=gate(f,'second');
  const one=f.call('bash',{workspace_id,command:first.command,timeout:30},'ordinary-one');
  const two=f.call('bash',{workspace_id,command:second.command,timeout:30},'ordinary-two');
  try {
    await until(()=>existsSync(first.started)&&existsSync(second.started),'both real commands started');
    assert(!(await admission(f)).isError,'Leader may admit overlapping Postman work while both commands run');
    writeFileSync(first.release,'release');assert(!(await one).isError);
    assert(!(await admission(f)).isError,'one remaining ordinary writer is not a Host admission veto');
    writeFileSync(second.release,'release');assert(!(await two).isError);
    await until(async()=>!(await admission(f)).isError,'both completed commands release their memory and durable holds');
  } finally {writeFileSync(first.release,'release');writeFileSync(second.release,'release');await Promise.allSettled([one,two])}
}));

test('A4/A5 ordinary detached writer holds only its root and releases after native-observed actual descendant exit',{timeout:60000},()=>fixture(async(f,controlFile)=>{
  const workspace_id=await open(f),app=f.application({writes:true});
  const launched=await f.call('bash',{workspace_id,command:app.command,timeout:4},'ordinary-background');
  assert(!launched.isError&&await app.wait(),'real upstream parent exits while detached HTTP child lives');
  await until(()=>existsSync(app.heartbeat),'ordinary descendant actually writes its root');
  const before=readFileSync(app.heartbeat,'utf8');await delay(150);
  assert.notEqual(readFileSync(app.heartbeat,'utf8'),before,'detached descendant continues writing after handler return');
  const ordinaryWrite=await f.call('write',{workspace_id,path:'ordinary-owned.txt',content:'ordinary remains usable'},'ordinary-background');
  assert(!ordinaryWrite.isError,'ordinary same-chat writing keeps its upstream permissions while its own background runs');
  assert(!(await admission(f)).isError,'active ordinary descendant does not block a Leader-authorized same-root write');
  const independent=join(f.root,'independent');mkdirSync(independent);
  const other=await open(f,independent,'independent');
  const written=await f.call('write',{workspace_id:other,path:'independent.txt',content:'independent'},'independent');
  const read=await f.call('read',{workspace_id,path:'server.cjs'},'reader');
  assert(!written.isError&&!read.isError,'independent mutation and overlapping read remain available');
  await app.stop();
  await until(async()=>!(await admission(f)).isError,'actual native descendant exit permits same-root admission');
  assert(!f.writers.untrackedRoots().includes(f.project),'A5 memory census clears after observed whole ordinary tree exit');
  const saved=JSON.parse(readFileSync(controlFile,'utf8'));
  const cold=f.runtimeModule.createWriterRuntime({root:join(f.root,'channels')});
  cold.restoreCensus(saved.untrackedRoots,()=>{});
  assert(!cold.untrackedRoots().includes(f.project),'A5 durable reopen does not resurrect proven finished ordinary tree');
  assert.equal(readFileSync(join(f.project,'new-writer.txt'),'utf8'),'preserved writer data');
  assert.equal(readFileSync(join(f.project,'ordinary-owned.txt'),'utf8'),'ordinary remains usable');
}));

test('A7 ordinary calls in independent roots run concurrently and settle independently',{timeout:60000},()=>fixture(async f=>{
  const workspace_id=await open(f),pending=gate(f,'parallel');
  const active=f.call('bash',{workspace_id,command:pending.command,timeout:30},'ordinary-active');
  try {
    await until(()=>existsSync(pending.started),'first root command started');
    const independent=join(f.root,'other-root');mkdirSync(independent);
    const other=await open(f,independent,'ordinary-other');
    const result=await f.call('bash',{workspace_id:other,command:node("console.log('INDEPENDENT_FINISHED')"),timeout:5},'ordinary-other');
    assert(!result.isError&&output(result).includes('INDEPENDENT_FINISHED'),'second root finishes while first remains active');
    assert(!existsSync(pending.release),'first native command is still gated');
    assert(!f.writers.untrackedRoots().includes(independent),'finished independent root is not held by another root process');
    assert(!(await admission(f)).isError,'first active root remains available to Leader-authorized work');
    writeFileSync(pending.release,'release');assert(!(await active).isError);
    await until(async()=>!(await admission(f)).isError,'first root releases independently after actual completion');
  } finally {writeFileSync(pending.release,'release');await Promise.allSettled([active])}
}));
