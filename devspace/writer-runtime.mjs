import {AsyncLocalStorage} from 'node:async_hooks';
import {spawn} from 'node:child_process';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {readFileSync, realpathSync, existsSync, writeFileSync, renameSync, mkdirSync, readdirSync, lstatSync, unlinkSync} from 'node:fs';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {homedir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {channel as diagnosticsChannel} from 'node:diagnostics_channel';
import {inspectLoadedRuntime} from './runtime-identity.mjs';

const normalize = value => resolve(value).replaceAll('\\','/').toLowerCase();
const overlaps = (a,b) => { a=normalize(a); b=normalize(b); return a===b || a.startsWith(b+'/') || b.startsWith(a+'/'); };
const inside = (target,root) => normalize(target)===normalize(root) || normalize(target).startsWith(normalize(root)+'/');
const sameSecret = (a,b) => typeof a==='string' && typeof b==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const channelRoot = () => process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA,'DSH','Postman','devspace') : join(homedir(),'.dsh','postman','devspace');
const denied = code => ({isError:true,content:[{type:'text',text:code}]});
const nativeHelper = join(dirname(fileURLToPath(import.meta.url)),'writer-process.ps1');
const ordinaryHelper = join(dirname(fileURLToPath(import.meta.url)),'ordinary-process.ps1');

/** In-memory observations belong to this live server instance. Losing them is UNKNOWN. */
export function createWriterRuntime({root=channelRoot(), helper=nativeHelper,censusHelper=ordinaryHelper}={}) {
  const local=new AsyncLocalStorage(), records=new Map(), scopes=new Map(), unboundScopes=new Set(), otherTools=new Set();
  const untrackedRoots=new Set(),coldRoots=new Set(); let saveCensus=()=>{};
  let observer=null,lastCensus=null,observationLost=false,nextTicket=0;
  const censusWaiters=new Set(),childChannel=diagnosticsChannel('child_process');
  const keyFields=['jobId','requestId','leaderSessionId','branch','writeRoot'];
  const boundedWait=async(promise,ms)=>{
    let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),ms)})]);}
    finally{clearTimeout(timer);}
  };
  const ordinaryLeases=()=>[...otherTools].map(other=>({id:other.id,writeRoot:other.writeRoot,
    state:other.active?'ACTIVE':!other.ordinary || other.observationLost?'UNKNOWN':'POSSIBLE_DESCENDANTS'}));
  function publishOrdinary() {
    untrackedRoots.clear();for(const target of coldRoots)untrackedRoots.add(target);
    for(const other of otherTools)if((other.active || other.unknown) && other.writeRoot)untrackedRoots.add(other.writeRoot);
    saveCensus([...untrackedRoots],ordinaryLeases());
  }
  function loseObservation() {
    if(observationLost)return;
    observationLost=true;
    childChannel.unsubscribe(captureChild);
    // End only the read-only collector, never the ordinary tool or its children.
    try{observer?.stdin.end();}catch{}
    for(const other of otherTools)if(other.ordinary){other.observationLost=true;other.unknown=true;}
    for(const waiter of censusWaiters)waiter.resolve(null);censusWaiters.clear();
    try{publishOrdinary();}catch{}
  }
  function captureChild({process:child}) {
    const context=local.getStore();
    if(context?.censusProbe){context.child=child;return;}
    if(!context?.ordinary)return;
    const root={child,pid:null,finished:false};context.children.push(root);
    child.once('spawn',()=>{root.pid=child.pid;});
    child.once('exit',()=>{root.finished=true;context.postTicket=requestCensus();});
    child.once('error',()=>{if(!child.pid)root.finished=true;else context.observationLost=true;});
  }
  // A missing intermediate parent is never evidence of absence. Every new live
  // orphan remains a possible descendant until a subsequent complete census has
  // no possible descendants. Baseline identities require BOTH PID and birth.
  function possibleDescendant(other,census) {
    const roots=new Set(other.children.map(child=>child.pid).filter(Boolean));
    const visit=(row,seen=new Set())=>{
      if(roots.has(row.pid))return true;
      if(other.baseline.get(row.pid)?.birth===row.birth)return false;
      if(seen.has(row.pid))return true;
      seen.add(row.pid);
      const parent=census.rows.get(row.parent);
      if(!parent || BigInt(parent.birth)>BigInt(row.birth))return true;
      return visit(parent,seen);
    };
    for(const row of census.rows.values())if(visit(row))return true;
    return false;
  }
  function observeOrdinary(census) {
    let changed=false;
    for(const other of otherTools)if(other.ordinary && !other.active && !other.observationLost && other.baseline &&
      census.ack>=other.postTicket && other.children.every(child=>child.finished)) {
      if(!other.children.length || !possibleDescendant(other,census)){other.unknown=false;otherTools.delete(other);changed=true;}
    }
    if(changed)try{publishOrdinary();}catch{loseObservation();}
  }
  function requestCensus() {
    if(!observer || observationLost || !Number.isSafeInteger(nextTicket+1))return Infinity;
    const ticket=++nextTicket;
    try{observer.stdin.write(JSON.stringify({ticket})+'\n');}catch{loseObservation();return Infinity;}
    return ticket;
  }
  function waitCensus(ticket) {
    if(observationLost)return Promise.resolve(null);
    if(lastCensus && lastCensus.ack>=ticket)return Promise.resolve(lastCensus);
    const result=Promise.withResolvers(),waiter={ticket,resolve:result.resolve};censusWaiters.add(waiter);
    return boundedWait(result.promise,5000).then(value=>{if(!value)loseObservation();return value;})
      .finally(()=>censusWaiters.delete(waiter));
  }
  function startObservation() {
    if(observer || observationLost)return;
    if(process.platform!=='win32' || process.arch!=='x64'){loseObservation();return;}
    childChannel.subscribe(captureChild);
    const probe={censusProbe:true};
    const child=local.run(probe,()=>spawn('pwsh',['-NoProfile','-NonInteractive','-File',censusHelper,'-OwnerPid',String(process.pid)],
      {windowsHide:true,stdio:['pipe','pipe','ignore']}));
    observer=child;
    if(probe.child!==child){loseObservation();child.stdin.end();return;}
    child.unref();for(const stream of [child.stdin,child.stdout])stream.unref?.();
    let buffer='';
    child.stdout.on('data',data=>{
      if(observationLost){buffer='';return;}
      buffer+=data;if(buffer.length>4194304){buffer='';loseObservation();return;}
      let newline;
      while((newline=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        try{
          const value=JSON.parse(line);
          if(value.version!==1 || value.error || !Number.isSafeInteger(value.sequence) || value.sequence<1 ||
            value.sequence<=(lastCensus?.sequence??0) || !Number.isSafeInteger(value.ack) || value.ack<0 || value.ack>nextTicket ||
            value.ack<(lastCensus?.ack??0) || !Array.isArray(value.rows) || value.rows.length>65536)throw Error('CENSUS_UNAVAILABLE');
          const rows=new Map();
          for(const row of value.rows){
            if(!Number.isSafeInteger(row.pid) || row.pid<0 || !Number.isSafeInteger(row.parent) || row.parent<0 ||
              !/^[0-9]+$/.test(row.birth) || rows.has(row.pid))throw Error('CENSUS_UNAVAILABLE');
            rows.set(row.pid,row);
          }
          if(!rows.has(process.pid) || !rows.has(child.pid))throw Error('CENSUS_UNAVAILABLE');
          lastCensus={sequence:value.sequence,ack:value.ack,rows};observeOrdinary(lastCensus);
          for(const waiter of censusWaiters)if(value.ack>=waiter.ticket){censusWaiters.delete(waiter);waiter.resolve(lastCensus);}
        }catch{loseObservation();}
      }
    });
    child.stdin.on('error',loseObservation);child.once('error',loseObservation);child.once('close',loseObservation);
  }
  async function beginOrdinary(other) {
    other.ordinary=true;other.id=randomUUID();other.children=[];other.baseline=null;other.postTicket=Infinity;other.observationLost=observationLost;
    // The durable root barrier precedes the actual upstream spawn/effect.
    publishOrdinary();startObservation();
    const census=await waitCensus(requestCensus());
    if(census && !observationLost)other.baseline=census.rows;
    else{other.observationLost=true;other.unknown=true;}
  }
  async function finishOrdinary(other) {
    other.active=0;other.postTicket=requestCensus();
    // The native snapshot must acknowledge a request made after handler/root
    // completion; a later-arriving pre-effect stdout buffer is insufficient.
    const census=await waitCensus(other.postTicket);
    if(census)observeOrdinary(census);
  }
  async function ordinaryAdmission(writeRoot) {
    if(typeof writeRoot!=='string' || !writeRoot)return {ok:false,status:'EXIT_UNPROVEN'};
    if([...untrackedRoots].some(target=>overlaps(target,writeRoot)) && observer && !observationLost)await waitCensus(requestCensus());
    const held=[...untrackedRoots].some(target=>overlaps(target,writeRoot));
    return {ok:!held,status:held?(coldRoots.size && [...coldRoots].some(target=>overlaps(target,writeRoot)) || observationLost?'EXIT_UNPROVEN':'OTHER_WRITER_ACTIVE'):'READY',writeRoot};
  }
  function closeObservation() {
    if(observer){loseObservation();observer.stdin.end();childChannel.unsubscribe(captureChild);}
  }
  function privateJson(file) {
    const stat=lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>65536 || realpathSync(file)!==resolve(file))throw Error('WRITER_BINDING_CHANGED');
    return JSON.parse(readFileSync(file,'utf8'));
  }
  function binding(jobId) {
    if(!/^[0-9a-f-]{36}$/.test(jobId)) throw Error('WRITER_BINDING_CHANGED');
    const channel=join(root,jobId);
    if(realpathSync(channel)!==resolve(channel)) throw Error('WRITER_BINDING_CHANGED');
    const value=privateJson(join(channel,'binding.json'));
    if(value.jobId!==jobId || value.channel!==channel || value.writerRuntimeVersion!==1 || !value.writeRoot ||
      (!value.branch && !(value.workspaceOnly===true && value.branch==='')) ||
      realpathSync(value.writeRoot)!==resolve(value.writeRoot)) throw Error('WRITER_BINDING_CHANGED');
    return value;
  }
  function revoked(record) {
    const file=join(record.binding.channel,'revoked.json');
    let receipt;
    try{receipt=privateJson(file);}catch(error){if(error.code==='ENOENT')return false;throw error;}
    for(const key of ['jobId','requestId','leaderSessionId','lunaSessionId','capability'])
      if(receipt[key]!==record.binding[key]) throw Error('WRITER_BINDING_CHANGED');
    return true;
  }
  const markerFor=owned=>join(owned.channel,'writer-claim.json');
  const markerMatches=(marker,owned)=>marker.version===1 && keyFields.every(key=>marker[key]===owned[key]) &&
    typeof marker.scope==='string' && /^[0-9a-f-]{36}$/.test(marker.generation??'');
  function descriptorFor(record,id) {
    if(!/^[0-9a-f-]{36}$/.test(id??'')) throw Error('WRITER_NATIVE_JOB_UNKNOWN');
    const file=join(record.binding.channel,'native-jobs',id+'.json');
    if(lstatSync(file).isSymbolicLink() || lstatSync(file).size>65536 || realpathSync(file)!==resolve(file)) throw Error('WRITER_NATIVE_JOB_UNKNOWN');
    const saved=JSON.parse(readFileSync(file,'utf8'));
    if(saved.version!==1 || saved.nativeJobId!==id || saved.bridgeJobId!==record.binding.jobId || saved.scope!==record.scope ||
      saved.generation!==record.generation || ['requestId','leaderSessionId','branch','writeRoot'].some(key=>saved[key]!==record.binding[key]) ||
      !/^Local\\DSH_Postman_[a-f0-9-]{36}_[a-f0-9]{64}$/.test(saved.jobName??'') || !inside(saved.cwd,record.binding.writeRoot))
      throw Error('WRITER_NATIVE_JOB_UNKNOWN');
    return saved;
  }
  function ownControl(input,scope,target) {
    if(typeof scope!=='string' || !target) throw Error('WRITER_BINDING_CHANGED');
    if(input.job_id) for(const record of records.values()) if(record.nativeJobs.has(input.job_id)) {
      if(record.scope!==scope || normalize(target)!==normalize(record.binding.writeRoot)) throw Error('WRITER_BINDING_CHANGED');
      descriptorFor(record,input.job_id); return record;
    }
    const current=scopes.get(scope);
    if(!input.job_id && current && normalize(target)===normalize(current.binding.writeRoot)) return current;
    const candidates=[];
    for(const entry of readdirSync(root,{withFileTypes:true})) {
      if(!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      try {
        const owned=binding(entry.name), marker=JSON.parse(readFileSync(markerFor(owned),'utf8'));
        if(!markerMatches(marker,owned) || marker.scope!==scope || normalize(target)!==normalize(owned.writeRoot)) continue;
        const record={binding:owned,scope,generation:marker.generation,nativeJobs:new Map(),active:0,unknown:true,coldControl:true};
        if(input.job_id) descriptorFor(record,input.job_id);
        candidates.push(record);
      } catch {}
    }
    if(!input.job_id && candidates.length>1)return {...candidates[0],controlRecords:candidates};
    if(candidates.length!==1) throw Error('WRITER_NATIVE_JOB_UNKNOWN');
    return candidates[0]; // Inspection/stop only: never restored as a fresh native census.
  }
  function hasClaimedScope(scope) {
    if(typeof scope!=='string' || !existsSync(root))return false;
    for(const entry of readdirSync(root,{withFileTypes:true})) {
      if(!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name))continue;
      try{const owned=binding(entry.name),claim=privateJson(markerFor(owned));if(markerMatches(claim,owned) && claim.scope===scope)return true;}catch{}
    }
    return false;
  }
  async function runTool(name,input,extra,workspaces,operation,readOnly=false) {
    readOnly=readOnly && !(name==='open_workspace' && input.mode==='worktree');
    const scope=extra?._meta?.['openai/session'];
    const alias=name==='open_workspace' && /^postman-writer:([0-9a-f-]{36})$/.exec(input.path??'');
    let record=typeof scope==='string'?scopes.get(scope):null;
    // Workspace lookup belongs to the upstream provider. Its errors are not
    // evidence of a changed Host binding and keep the provider's error path.
    let target;
    if(input.workspace_id) target=(await workspaces.getWorkspace(input.workspace_id)).root;
    else if(name==='open_workspace' && typeof input.path==='string') target=input.path;
    const validationFailure=error=>denied(error?.message==='WRITER_NATIVE_JOB_UNKNOWN'
      ? 'WRITER_NATIVE_JOB_UNKNOWN' : 'WRITER_BINDING_CHANGED');
    if(name==='bash' && ['status','stop'].includes(input.execution)) {
      try{record=ownControl(input,scope,target);}catch(error){return validationFailure(error);}
      return await local.run(record,operation);
    }
    try {
      if(name==='open_workspace' && typeof input.path==='string' && input.path.startsWith('postman-writer:') && !alias)
        return denied('WRITER_BINDING_CHANGED');
      if(alias) {
        if(process.platform!=='win32' || !scope || unboundScopes.has(scope)) return denied('DEVSPACE_NATIVE_PROOF_UNAVAILABLE');
        const owned=binding(alias[1]); record=records.get(owned.jobId);
        if(!record) {
          const candidate={binding:owned,scope,generation:randomUUID(),active:0,unknown:false,nativeJobs:new Map()};
          if(revoked(candidate)) return denied('WRITER_EXECUTION_REVOKED');
          if(input.mode && input.mode!=='checkout') return denied('WRITER_BINDING_CHANGED');
          const claim={version:1,...Object.fromEntries(keyFields.map(key=>[key,owned[key]])),scope,generation:candidate.generation};
          try {writeFileSync(markerFor(owned),JSON.stringify(claim),{flag:'wx',mode:0o600});}
          catch(error){if(error.code==='EEXIST')return denied('DEVSPACE_NATIVE_CENSUS_LOST');throw error;}
          record=candidate; records.set(owned.jobId,record);
        }
        if(record.scope!==scope || revoked(record)) return denied('WRITER_EXECUTION_REVOKED');
        if(input.mode && input.mode!=='checkout') return denied('WRITER_BINDING_CHANGED');
        scopes.set(scope,record); input.path=owned.writeRoot; input.mode='checkout'; target=owned.writeRoot;
      }
      if(record) {
        if(revoked(record)) return denied('WRITER_EXECUTION_REVOKED');
        // Native uncertainty remains visible in status/settlement. The Leader
        // decides whether another authorized operation should proceed.
        if(!readOnly && name!=='open_workspace' && !['bash','write','edit'].includes(name)) return denied('WRITER_TOOL_NOT_INSTRUMENTED');
        if(!readOnly && target && !inside(target,record.binding.writeRoot)) return denied('WRITER_BINDING_CHANGED');
      } else if(!readOnly) {
        // A cold Postman scope must explicitly obtain a new Host binding, even
        // after its old hold was released. Metadata loss cannot grant native access.
        if(hasClaimedScope(scope))return denied('WRITER_BINDING_REQUIRED');
        if(name==='bash' && input.execution && input.execution!=='foreground') return denied('WRITER_BINDING_REQUIRED');
        if(scope) unboundScopes.add(scope);
      }
    } catch(error){return validationFailure(error);}
    // No Host validation catch surrounds operation(): thrown/rejected upstream
    // errors and structured isError results retain their original semantics.
    if(readOnly) return await operation();
    if(!record) {
      const unknown=name==='bash' || name==='open_workspace' && input.mode==='worktree';
      const other={id:randomUUID(),writeRoot:target,active:1,unknown}; otherTools.add(other);
      let effectStarted=false;
      try{
        try{
          if(name==='bash' && target)await beginOrdinary(other);
          else if(unknown && target){coldRoots.add(target);publishOrdinary();}
          else publishOrdinary();
        }catch{other.observationLost=true;other.unknown=true;}
        effectStarted=true;return await local.run(other,operation);
      }
      finally{
        other.active=0;
        if(!effectStarted){other.unknown=false;otherTools.delete(other);try{publishOrdinary();}catch{}}
        else if(other.ordinary){try{await finishOrdinary(other);}catch{other.observationLost=true;other.unknown=true;try{publishOrdinary();}catch{}}}
        else if(!other.unknown){otherTools.delete(other);try{publishOrdinary();}catch{}}
      }
    }
    record.active++;
    try{return await local.run(record,operation);}finally{record.active--;clearFiniteHold(record);}
  }
  function snapshot(job) {
    return {native_job_id:job.id,state:job.unknown?'UNKNOWN':job.treeSettled?'TREE_SETTLED':job.stopRequested?'STOP_REQUESTED':job.startedObserved?'BACKGROUND_RUNNING':'STARTING',
      foregroundFinished:job.foregroundFinished,exitCode:job.exitCode,treeSettled:job.treeSettled,output:job.output};
  }
  const response=(value,isError=false)=>({...(isError?{isError:true}:{}),content:[{type:'text',text:JSON.stringify(value)}],structuredContent:{result:JSON.stringify(value),...value}});
  function releaseParentReferences(job) {
    job.child.unref();
    for(const stream of [job.child.stdin,job.child.stdout,job.child.stderr])stream.unref?.();
  }
  function ensureHold(record) {
    const receipt={version:1,...Object.fromEntries(['jobId','requestId','leaderSessionId','lunaSessionId','branch','writeRoot','capability'].map(key=>[key,record.binding[key]])),generation:record.generation};
    const file=join(record.binding.channel,'writer-hold.json');
    try{writeFileSync(file,JSON.stringify(receipt),{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST' || lstatSync(file).isSymbolicLink() || readFileSync(file,'utf8')!==JSON.stringify(receipt))throw Error('WRITER_BINDING_CHANGED');}
  }
  function clearFiniteHold(record) {
    if(record.retainHold || record.active || ![...record.nativeJobs.values()].every(job=>job.treeSettled))return;
    const file=join(record.binding.channel,'writer-hold.json');
    try{const receipt=JSON.parse(readFileSync(file,'utf8'));if(receipt.generation===record.generation && !lstatSync(file).isSymbolicLink())unlinkSync(file);}catch{}
  }
  function startNative(record,command,cwd,options,shellConfig) {
    if(!record?.binding || record.coldControl || revoked(record) || !inside(cwd,record.binding.writeRoot)) throw Error('WRITER_EXECUTION_REVOKED');
    const config=shellConfig();
    const id=randomUUID(), directory=join(record.binding.channel,'native-jobs'); mkdirSync(directory,{recursive:true});
    if(realpathSync(directory)!==resolve(directory)) throw Error('WRITER_BINDING_CHANGED');
    const descriptor={version:1,nativeJobId:id,bridgeJobId:record.binding.jobId,
      ...Object.fromEntries(['requestId','leaderSessionId','branch','writeRoot'].map(key=>[key,record.binding[key]])),
      scope:record.scope,generation:record.generation,cwd,jobName:'Local\\DSH_Postman_'+id+'_'+randomBytes(32).toString('hex')};
    writeFileSync(join(directory,id+'.json'),JSON.stringify(descriptor),{flag:'wx',mode:0o600});
    if(options.background)record.retainHold=true;
    ensureHold(record);
    const job={id,descriptor,started:Promise.withResolvers(),done:Promise.withResolvers(),startedObserved:false,
      foregroundFinished:false,exitCode:null,treeSettled:false,stopRequested:false,unknown:false,output:''};
    record.nativeJobs.set(id,job); record.active++;
    const decoder=new StringDecoder('utf8');
    const append=data=>{const value=decoder.write(data);job.output=(job.output+value).slice(-65536);options.onData?.(data);};
    // Detached pwsh exits before script execution on the supported Windows build.
    // A detached Node owner launches only this fixed helper with normal hidden flags.
    const owner="const{spawn}=require('node:child_process');const child=spawn('pwsh',['-NoProfile','-NonInteractive','-File',process.argv[1]],{windowsHide:true,stdio:'inherit'});child.once('error',()=>process.exitCode=1);child.once('exit',code=>process.exitCode=code??1);";
    const child=spawn(process.execPath,['-e',owner,helper],{cwd,env:options.env,detached:true,windowsHide:true,stdio:['pipe','pipe','pipe']});
    job.child=child; let buffer='',settledObserved=false,finished=false;
    const finish=code=>{
      if(finished)return;finished=true;
      job.output=(job.output+decoder.end()).slice(-65536);
      if(code===0 && settledObserved){job.treeSettled=true;job.foregroundFinished=true;}
      else{job.unknown=true;record.unknown=true;}
      record.active--;clearFiniteHold(record);job.started.resolve(job);job.done.resolve(job);
    };
    child.stdout.on('data',data=>{
      buffer+=data;
      if(buffer.length>65536){job.unknown=true;record.unknown=true;buffer='';return;}
      let newline;
      while((newline=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        try{
          const event=JSON.parse(line);if(event.version!==1)throw Error('Invalid native event');
          if(event.event==='started'){job.startedObserved=true;job.started.resolve(job);}
          else if(event.event==='foreground' && Number.isInteger(event.exitCode)){job.foregroundFinished=true;job.exitCode=event.exitCode;}
          else if(event.event==='stop_requested')job.stopRequested=true;
          else if(event.event==='settled' && event.jobSettled===true && Number.isInteger(event.exitCode)){
            settledObserved=true;if(job.exitCode===null)job.exitCode=event.exitCode;
          }
        }catch{job.unknown=true;record.unknown=true;}
      }
    });
    child.stderr.on('data',append);
    child.stdin.on('error',()=>{if(!settledObserved){job.unknown=true;record.unknown=true;}});
    child.once('error',()=>finish(null));child.once('close',finish);
    child.stdin.write(JSON.stringify({shell:config.shell,args:config.commandTransport==='stdin'?config.args:[...config.args,command],
      stdin:config.commandTransport==='stdin',command,cwd,timeout:options.timeout??30,jobName:descriptor.jobName})+'\n');
    return job;
  }
  async function inspectNative(descriptor,action) {
    return await new Promise(resolve=>{
      const child=spawn('pwsh',['-NoProfile','-NonInteractive','-File',helper],{windowsHide:true,stdio:['pipe','pipe','ignore']});
      let output='',complete=false;
      const finish=value=>{if(complete)return;complete=true;clearTimeout(timer);resolve(value);};
      const timer=setTimeout(()=>{child.unref();child.stdout.unref?.();finish(null);},10000);
      child.stdout.on('data',data=>{output+=data;if(output.length>4096)finish(null);});
      child.once('error',()=>finish(null));child.once('close',code=>{
        try{const event=JSON.parse(output);finish(code===0 && event.version===1 && event.event==='inspection'?event:null);}catch{finish(null);}
      });
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({action,jobName:descriptor.jobName})+'\n');
    });
  }
  function background(input,context,shellConfig) {
    const record=local.getStore();
    if(!record?.binding || !input.execution || input.execution==='foreground')return undefined;
    return backgroundBound(record,input,context,shellConfig);
  }
  async function backgroundBound(record,input,{cwd,env=process.env}={},shellConfig) {
    const execution=input.execution??'foreground';
    if(!['foreground','background','status','stop'].includes(execution))return denied('WRITER_EXECUTION_INVALID');
    if(execution==='status' && !input.job_id){
      let jobs=[...record.nativeJobs.values()].map(snapshot);
      if(record.coldControl){
        jobs=[];
        for(const source of record.controlRecords??[record]){
          const directory=join(source.binding.channel,'native-jobs');
          if(!existsSync(directory))continue;
          for(const name of readdirSync(directory).filter(name=>/^[a-f0-9-]{36}[.]json$/.test(name)).slice(-32)){
            const saved=descriptorFor(source,name.slice(0,-5));jobs.push({native_job_id:saved.nativeJobId,generation:source.generation,state:'UNKNOWN',treeSettled:false,foregroundFinished:false,exitCode:null});
          }
        }
      }
      return response({jobs:jobs.slice(-32)});
    }
    if(execution==='status' || execution==='stop'){
      if(!input.job_id)return denied('WRITER_NATIVE_JOB_REQUIRED');
      const saved=descriptorFor(record,input.job_id),job=record.nativeJobs.get(input.job_id);
      if(!job){
        const observed=await inspectNative(saved,execution==='stop'?'stop':'inspect');
        return response({native_job_id:saved.nativeJobId,state:observed?.treeSettled?'TREE_SETTLED':observed?(execution==='stop'?'STOP_REQUESTED':'BACKGROUND_RUNNING'):'UNKNOWN',
          treeSettled:observed?.treeSettled===true,foregroundFinished:false,exitCode:null,evidence:'GENERATION_CENSUS_LOST'});
      }
      if(execution==='stop' && !job.treeSettled){
        job.stopRequested=true;
        if(!job.unknown && !job.child.stdin.destroyed)job.child.stdin.write(JSON.stringify({action:'stop'})+'\n');
        else await inspectNative(saved,'stop');
        await boundedWait(job.done.promise,3000);
      }
      return response(snapshot(job));
    }
    if(input.job_id || typeof input.command!=='string')return denied('WRITER_COMMAND_REQUIRED');
    const timeout=input.timeout??30;
    if(!Number.isFinite(timeout) || timeout<=0 || timeout>300)return denied('WRITER_TIMEOUT_INVALID');
    const job=startNative(record,input.command,cwd,{env,timeout,background:true},shellConfig);
    await boundedWait(job.started.promise,timeout*1000);releaseParentReferences(job);return response(snapshot(job),job.unknown);
  }
  function bashOperations(shellConfig) {
    const record=local.getStore();
    if(!record?.binding)return undefined; // options omitted: upstream owns ordinary execution.
    return {exec:async(command,cwd,options)=>{
      const job=startNative(record,command,cwd,options,shellConfig);
      await boundedWait(job.done.promise,(options.timeout??30)*1000);
      if(!job.treeSettled){record.retainHold=true;ensureHold(record);releaseParentReferences(job);throw Error(JSON.stringify(snapshot(job)));}
      if(options.signal?.aborted)throw Error('aborted');
      return {exitCode:job.exitCode};
    }};
  }
  function reconcile(expected) {
    try{
      const record=records.get(expected.jobId);if(!record)return {ok:false,code:'DEVSPACE_NATIVE_PROOF_UNAVAILABLE'};
      const own=record.binding;
      if(keyFields.some(key=>own[key]!==expected[key]) || !sameSecret(own.capability,expected.capability) || !revoked(record))return {ok:false,code:'WRITER_BINDING_CHANGED'};
      if(record.unknown)return {ok:false,code:'DEVSPACE_NATIVE_PROOF_UNAVAILABLE'};
      if(record.active)return {ok:false,code:'WRITER_STILL_RUNNING'};
      if([...untrackedRoots].some(target=>overlaps(target,own.writeRoot)))return {ok:false,code:'OTHER_WRITER_ACTIVE'};
      for(const expectedOther of expected.otherWriters??[]){
        const other=records.get(expectedOther.jobId);
        if(!other || ['requestId','leaderSessionId','branch','writeRoot'].some(key=>other.binding[key]!==expectedOther[key]) ||
          other.unknown || other.active || !revoked(other))return {ok:false,code:'OTHER_WRITER_ACTIVE'};
      }
      if([...otherTools].some(other=>(!other.writeRoot || overlaps(other.writeRoot,own.writeRoot)) && (other.active || other.unknown)))return {ok:false,code:'OTHER_WRITER_ACTIVE'};
      if([...records.values()].some(other=>other!==record && overlaps(other.binding.writeRoot,own.writeRoot) &&
        (other.active || other.unknown || !revoked(other))))return {ok:false,code:'OTHER_WRITER_ACTIVE'};
      record.settlementIssued=true;
      return {ok:true,proof:{version:1,source:'devspace_native_tree',...Object.fromEntries(keyFields.map(key=>[key,own[key]])),generation:record.generation,settledAt:new Date().toISOString()}};
    }catch{return {ok:false,code:'WRITER_BINDING_CHANGED'};}
  }
  function restoreCensus(saved,persist){
    if(Array.isArray(saved))for(const target of saved)if(typeof target==='string' && target){untrackedRoots.add(target);coldRoots.add(target);}
    saveCensus=(roots,leases)=>persist(roots,leases);
  }
  return {runTool,bashOperations,background,reconcile,restoreCensus,ordinaryAdmission,ordinaryLeases,closeObservation,untrackedRoots:()=>[...untrackedRoots]};
}

/** A private loopback controller; neither MCP nor a model can submit an exit receipt. */
export async function startWriterControl(runtime,{file=join(homedir(),'.dsh','devspace','writer-control.json'),identityModules=[]}={}) {
  const secret=randomBytes(32).toString('hex');
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST' || !['/reconcile','/ordinary-admission','/runtime-identity'].includes(req.url) || !sameSecret(req.headers.authorization,'Bearer '+secret)) {
      res.writeHead(403); res.end(); return;
    }
    let body='';
    try {
      for await(const chunk of req) { body+=chunk; if(body.length>65536) throw Error('Too large'); }
      const input=JSON.parse(body),result=req.url==='/runtime-identity'
        ? await inspectLoadedRuntime([{name:'writer-runtime.mjs',url:import.meta.url},...identityModules])
        : req.url==='/ordinary-admission'?await runtime.ordinaryAdmission(input.writeRoot):runtime.reconcile(input);
      res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(result));
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const descriptor={version:1,port:server.address().port,secret};
  let persistenceActive=true;
  const persist=value=>{
    if(existsSync(file) && lstatSync(file).isSymbolicLink())throw Error('Writer control redirected');
    const temporary=file+'.'+randomUUID()+'.tmp';
    writeFileSync(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});renameSync(temporary,file);
  };
  let previous;
  try{if(existsSync(file))previous=JSON.parse(readFileSync(file,'utf8'));}
  catch(error){server.close();throw error;}
  runtime.restoreCensus(previous?.untrackedRoots,(roots,leases)=>{
    if(!persistenceActive)return;
    // A delayed old observer must never replace a newer controller descriptor.
    if(JSON.parse(readFileSync(file,'utf8')).secret!==secret)throw Error('WRITER_CONTROL_GENERATION_CHANGED');
    persist({...descriptor,untrackedRoots:roots,ordinaryLeases:leases});
  });
  try { persist({...descriptor,untrackedRoots:runtime.untrackedRoots(),ordinaryLeases:runtime.ordinaryLeases()}); }
  catch(error) { server.close(); throw error; }
  return {file,port:descriptor.port,close:async()=>{
    persistenceActive=false;
    runtime.closeObservation();
    await new Promise(resolve=>server.close(resolve));
    try { if(JSON.parse(readFileSync(file,'utf8')).secret===secret)persist({version:1,untrackedRoots:runtime.untrackedRoots(),ordinaryLeases:runtime.ordinaryLeases()}); } catch {}
  }};
}

// The patch is inert until the reviewed runner explicitly enables it.
let configured=null;
export const dshWriters={
  configure(options) { if(configured) throw Error('Writer runtime already configured'); configured=createWriterRuntime(options); return configured; },
  runTool(...args) { return configured ? configured.runTool(...args) : args[4](); },
  bashOperations(shellConfig) { return configured?.bashOperations(shellConfig); },
  background(...args) { return configured?.background(...args); },
};
