import {AsyncLocalStorage} from 'node:async_hooks';
import {spawn} from 'node:child_process';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {readFileSync, realpathSync, existsSync, writeFileSync, unlinkSync} from 'node:fs';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {homedir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const normalize = value => resolve(value).replaceAll('\\','/').toLowerCase();
const overlaps = (a,b) => { a=normalize(a); b=normalize(b); return a===b || a.startsWith(b+'/') || b.startsWith(a+'/'); };
const inside = (target,root) => normalize(target)===normalize(root) || normalize(target).startsWith(normalize(root)+'/');
const sameSecret = (a,b) => typeof a==='string' && typeof b==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const channelRoot = () => process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA,'DSH','Postman','devspace') : join(homedir(),'.dsh','postman','devspace');
const denied = code => ({isError:true,content:[{type:'text',text:code}]});
const nativeHelper = join(dirname(fileURLToPath(import.meta.url)),'writer-process.ps1');

/** In-memory observations belong to this live server instance. Losing them is UNKNOWN. */
export function createWriterRuntime({root=channelRoot(), helper=nativeHelper}={}) {
  const local = new AsyncLocalStorage(), records=new Map(), scopes=new Map(), unboundScopes=new Set(), otherTools=new Set();
  function binding(jobId) {
    if (!/^[0-9a-f-]{36}$/.test(jobId)) throw Error('WRITER_BINDING_CHANGED');
    const channel=join(root,jobId);
    if(realpathSync(channel)!==resolve(channel)) throw Error('WRITER_BINDING_CHANGED');
    const value=JSON.parse(readFileSync(join(channel,'binding.json'),'utf8'));
    if(value.jobId!==jobId || value.channel!==channel || value.writerRuntimeVersion!==1 ||
       !value.writeRoot || !value.branch || realpathSync(value.writeRoot)!==resolve(value.writeRoot)) throw Error('WRITER_BINDING_CHANGED');
    return value;
  }
  function revoked(record) {
    const file=join(record.binding.channel,'revoked.json');
    if(!existsSync(file)) return false;
    const receipt=JSON.parse(readFileSync(file,'utf8'));
    for(const key of ['jobId','requestId','leaderSessionId','lunaSessionId','capability'])
      if(receipt[key]!==record.binding[key]) throw Error('WRITER_BINDING_CHANGED');
    return true;
  }
  async function runTool(name,input,extra,workspaces,operation,readOnly=false) {
    // Upstream marks open_workspace read-only even when it creates Git state.
    readOnly=readOnly && !(name==='open_workspace' && input.mode==='worktree');
    const scope=extra?._meta?.['openai/session'];
    const alias=name==='open_workspace' && /^postman-writer:([0-9a-f-]{36})$/.exec(input.path??'');
    let record=typeof scope==='string' ? scopes.get(scope) : null;
    try {
      if(alias) {
        if(process.platform!=='win32' || !scope || unboundScopes.has(scope)) return denied('DEVSPACE_NATIVE_PROOF_UNAVAILABLE');
        const owned=binding(alias[1]);
        record=records.get(owned.jobId);
        if(!record) { record={binding:owned,scope,generation:randomUUID(),active:0,unknown:false}; records.set(owned.jobId,record); }
        if(record.scope!==scope || revoked(record)) return denied('WRITER_EXECUTION_REVOKED');
        if(input.mode && input.mode!=='checkout') return denied('WRITER_BINDING_CHANGED');
        scopes.set(scope,record);
        input.path=owned.writeRoot; input.mode='checkout';
      }
      let target;
      if(input.workspace_id) target=(await workspaces.getWorkspace(input.workspace_id)).root;
      else if(name==='open_workspace' && typeof input.path==='string') target=input.path;
      if(record) {
        if(revoked(record)) return denied('WRITER_EXECUTION_REVOKED');
        if(!readOnly && name!=='open_workspace' && !['bash','write','edit'].includes(name)) return denied('WRITER_TOOL_NOT_INSTRUMENTED');
        if(!readOnly && target && !inside(target,record.binding.writeRoot)) return denied('WRITER_BINDING_CHANGED');
      } else if(!readOnly) {
        if(target && [...records.values()].some(other=>overlaps(target,other.binding.writeRoot) &&
          (!other.settlementIssued || other.active || other.unknown || !revoked(other)))) return denied('WRITER_BINDING_REQUIRED');
        if(scope) unboundScopes.add(scope);
      }
      if(readOnly) return await operation();
      if(!record) {
        const other={writeRoot:target,active:1,unknown:name==='open_workspace' && input.mode==='worktree'}; otherTools.add(other);
        try { return await local.run(other,operation); }
        finally { other.active=0; if(!other.unknown) otherTools.delete(other); }
      }
      record.active++;
      try { return await local.run(record,operation); }
      finally { record.active--; }
    } catch { return denied('WRITER_BINDING_CHANGED'); }
  }
  function bashOperations(shellConfig) {
    const record=local.getStore();
    if(!record) return undefined; // Ordinary non-Postman tools keep their native behavior.
    return {exec: async (command,cwd,{onData,signal,timeout,env}) => {
      if(record.binding && (revoked(record) || !inside(cwd,record.binding.writeRoot))) throw Error('WRITER_EXECUTION_REVOKED');
      const config=shellConfig();
      const child=spawn('pwsh',['-NoProfile','-NonInteractive','-File',helper],{
        cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe'],
      });
      let proof='';
      child.stdout.on('data',data=>{ proof+=data; if(proof.length>4096) record.unknown=true; });
      child.stderr.on('data',onData);
      child.stdin.on('error',()=>{});
      child.stdin.end(JSON.stringify({shell:config.shell,args:config.commandTransport==='stdin' ? config.args : [...config.args,command],
        stdin:config.commandTransport==='stdin',command,cwd,timeout:timeout??30}));
      // A UI abort does not manufacture native settlement. The helper retains the job.
      let exit;
      try { exit=await new Promise((resolve,reject)=>{ child.once('error',reject); child.once('close',resolve); }); }
      catch(error) { record.unknown=true; throw error; }
      let observed;
      try { observed=JSON.parse(proof); } catch {}
      if(exit!==0 || observed?.version!==1 || observed.jobSettled!==true || !Number.isInteger(observed.exitCode)) {
        record.unknown=true; throw Error('DEVSPACE_NATIVE_PROOF_UNAVAILABLE');
      }
      if(signal?.aborted) throw Error('aborted');
      if(observed.timedOut) throw Error('timeout:'+timeout);
      return {exitCode:observed.exitCode};
    }};
  }
  function reconcile(expected) {
    try {
      const record=records.get(expected.jobId);
      if(!record) return {ok:false,code:'DEVSPACE_NATIVE_PROOF_UNAVAILABLE'};
      const own=record.binding;
      for(const key of ['jobId','requestId','leaderSessionId','branch','writeRoot'])
        if(own[key]!==expected[key]) return {ok:false,code:'WRITER_BINDING_CHANGED'};
      if(!sameSecret(own.capability,expected.capability) || !revoked(record)) return {ok:false,code:'WRITER_BINDING_CHANGED'};
      if(record.unknown) return {ok:false,code:'DEVSPACE_NATIVE_PROOF_UNAVAILABLE'};
      if(record.active) return {ok:false,code:'WRITER_STILL_RUNNING'};
      for(const expectedOther of expected.otherWriters??[]) {
        const other=records.get(expectedOther.jobId);
        if(!other || ['requestId','leaderSessionId','branch','writeRoot'].some(key=>other.binding[key]!==expectedOther[key]) ||
          other.unknown || other.active || !revoked(other)) return {ok:false,code:'OTHER_WRITER_ACTIVE'};
      }
      if([...otherTools].some(other=>(!other.writeRoot || overlaps(other.writeRoot,own.writeRoot)) && (other.active || other.unknown)))
        return {ok:false,code:'OTHER_WRITER_ACTIVE'};
      if([...records.values()].some(other=>other!==record && overlaps(other.binding.writeRoot,own.writeRoot) &&
        (other.active || other.unknown || !revoked(other)))) return {ok:false,code:'OTHER_WRITER_ACTIVE'};
      record.settlementIssued=true;
      return {ok:true,proof:{version:1,source:'devspace_native_tree',
        ...Object.fromEntries(['jobId','requestId','leaderSessionId','branch','writeRoot'].map(key=>[key,own[key]])),
        generation:record.generation,settledAt:new Date().toISOString()}};
    } catch { return {ok:false,code:'WRITER_BINDING_CHANGED'}; }
  }
  return {runTool,bashOperations,reconcile};
}

/** A private loopback controller; neither MCP nor a model can submit an exit receipt. */
export async function startWriterControl(runtime,{file=join(homedir(),'.dsh','devspace','writer-control.json')}={}) {
  const secret=randomBytes(32).toString('hex');
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST' || req.url!=='/reconcile' || !sameSecret(req.headers.authorization,'Bearer '+secret)) {
      res.writeHead(403); res.end(); return;
    }
    let body='';
    try {
      for await(const chunk of req) { body+=chunk; if(body.length>65536) throw Error('Too large'); }
      const result=runtime.reconcile(JSON.parse(body));
      res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(result));
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const descriptor={version:1,port:server.address().port,secret};
  try { writeFileSync(file,JSON.stringify(descriptor),{mode:0o600}); }
  catch(error) { server.close(); throw error; }
  return {file,port:descriptor.port,close:async()=>{
    await new Promise(resolve=>server.close(resolve));
    try { if(JSON.parse(readFileSync(file,'utf8')).secret===secret) unlinkSync(file); } catch {}
  }};
}

// The patch is inert until the reviewed runner explicitly enables it.
let configured=null;
export const dshWriters={
  configure(options) { if(configured) throw Error('Writer runtime already configured'); configured=createWriterRuntime(options); return configured; },
  runTool(...args) { return configured ? configured.runTool(...args) : args[4](); },
  bashOperations(shellConfig) { return configured?.bashOperations(shellConfig); },
};
