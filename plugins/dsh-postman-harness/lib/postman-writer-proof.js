import {readFileSync, lstatSync, realpathSync} from 'node:fs'
import {homedir} from 'node:os'
import {join, resolve} from 'node:path'

const controlPath=controlFile=>controlFile??join(homedir(),'.dsh','devspace','writer-control.json')
export async function inspectDevspaceRuntime({controlFile}={}) {
  const unproven=()=>({status:'RUNTIME_SHA_UNPROVEN',diagnostic:'CONTROLLER_IDENTITY_UNAVAILABLE'})
  try {
    const file=controlPath(controlFile),info=lstatSync(file)
    if(info.isSymbolicLink() || info.size>1048576 || realpathSync(file)!==resolve(file))return unproven()
    const control=JSON.parse(readFileSync(file,'utf8'))
    if(control.version!==1 || !Number.isSafeInteger(control.port) || control.port<1 || control.port>65535 ||
      !/^[a-f0-9]{64}$/.test(control.secret??''))return unproven()
    const response=await fetch('http://127.0.0.1:'+control.port+'/runtime-identity',{method:'POST',
      headers:{authorization:'Bearer '+control.secret,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)})
    if(!response.ok)return unproven()
    const result=await response.json()
    if(result.source!=='v8_loaded_script' || result.status!=='RUNTIME_IDENTITY_PROVEN' ||
      result.coverage!=='listed-modules' || !Number.isSafeInteger(result.pid) || result.pid<1 ||
      !/^[a-f0-9-]{36}$/.test(result.instanceId??'') || !/^[a-f0-9]{64}$/.test(result.sha256??'') ||
      !Array.isArray(result.modules) || !result.modules.length || result.modules.length>64 ||
      result.modules.some(item=>!/^[-\w.]{1,80}$/.test(item?.name??'') || !/^[a-f0-9]{64}$/.test(item?.sha256??'')))return unproven()
    return {status:result.status,source:result.source,coverage:result.coverage,pid:result.pid,instanceId:result.instanceId,
      processStartedAt:result.processStartedAt,sha256:result.sha256,modules:result.modules.map(({name,sha256})=>({name,sha256}))}
  } catch {return unproven()}
}
