import {Session} from 'node:inspector/promises';
import {createHash,randomUUID} from 'node:crypto';

const instanceId=randomUUID();
const processStartedAt=new Date(Date.now()-process.uptime()*1000).toISOString();
const hash=value=>createHash('sha256').update(value).digest('hex');
const normalized=value=>{
  const url=new URL(value);url.search='';url.hash='';
  if(url.protocol!=='file:')throw Error('A loaded file module is required');
  return process.platform==='win32'?url.href.toLowerCase():url.href;
};

/** Hash V8's loaded source, never a file currently on disk or a Git ref.
 * Callers own the fixed module allowlist. No source text leaves this function.
 * This identifies the listed modules, not every dependency in the process. */
export async function inspectLoadedRuntime(targets) {
  const identity={source:'v8_loaded_script',coverage:'listed-modules',pid:process.pid,instanceId,processStartedAt};
  const session=new Session();
  try {
    const modules=[{name:'runtime-identity',url:import.meta.url},...targets];
    const scripts=[];
    session.connect();
    session.on('Debugger.scriptParsed',event=>scripts.push(event.params));
    await session.post('Debugger.enable');
    const hashes=[];
    for(const module of modules) {
      const wanted=normalized(String(module.url));
      const matching=scripts.filter(script=>{try{return normalized(script.url)===wanted;}catch{return false;}});
      if(!matching.length)return {...identity,status:'RUNTIME_SHA_UNPROVEN',diagnostic:'MODULE_NOT_LOADED',module:module.name};
      const sources=new Set();
      for(const script of matching) {
        const {scriptSource}=await session.post('Debugger.getScriptSource',{scriptId:script.scriptId});
        sources.add(hash(scriptSource));
      }
      if(sources.size!==1)return {...identity,status:'RUNTIME_SHA_UNPROVEN',diagnostic:'AMBIGUOUS_LOADED_MODULE',module:module.name};
      hashes.push({name:module.name,sha256:[...sources][0]});
    }
    hashes.sort((a,b)=>a.name.localeCompare(b.name,'en'));
    return {...identity,status:'RUNTIME_IDENTITY_PROVEN',sha256:hash(JSON.stringify(hashes)),modules:hashes};
  } catch {
    return {...identity,status:'RUNTIME_SHA_UNPROVEN',diagnostic:'INSPECTION_UNAVAILABLE'};
  } finally {
    try{await session.post('Debugger.disable');}catch{}
    try{session.disconnect();}catch{}
  }
}
