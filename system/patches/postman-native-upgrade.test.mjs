import assert from 'node:assert/strict'
import test from 'node:test'
import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname,resolve,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {applyPostmanNativeChildCutoff} from './apply-postman-native-child-cutoff.mjs'
const repository=resolve(fileURLToPath(new URL('../../',import.meta.url)))
const sdk=createRequire(process.env.DSH_INSTALL_SDK ?? process.env.DSH_CAPABILITY_SDK ?? createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
const names=['dsh-subagent','dsh-session','dsh-goal-round-driver','dsh-tool-pwsh']
const images=Object.fromEntries(names.map(name=>[name,readFileSync(sdk.resolve('@deepseek-ai/'+name))]))
const lf=text=>text.toString().replaceAll(String.fromCharCode(13),'')
const canonical=bytes=>lf(bytes).replace('this.ownerCtx.get("agentPresets")?.serviceFor(agent, "compaction")','this.ownerCtx.agentPresets?.serviceFor(agent, "compaction")')
const blob=bytes=>createHash('sha1').update('blob '+Buffer.byteLength(lf(bytes))+String.fromCharCode(0)).update(lf(bytes)).digest('hex')
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'postman-native-upgrade-'))
 assert.ok(relative(repository,root).startsWith('..'),'native fixture must be outside task source')
 t.after(()=>rmSync(root,{recursive:true,force:true}))
 writeFileSync(join(root,'package.json'),'{}')
 const paths={}
 for(const name of [...names,'dsh-session-persistence-jsonl','dsh-session-persistence']){
  const path=join(root,'node_modules/@deepseek-ai',name,'lib/index.js');mkdirSync(dirname(path),{recursive:true})
  writeFileSync(join(path,'../../package.json'),JSON.stringify({name:'@deepseek-ai/'+name,main:'lib/index.js'}))
  writeFileSync(path,images[name]??'');if(images[name])paths[name]=path
 }
 return {root,paths,anchor:join(root,'package.json')}
}
function reverse(f,name,target){
 const patch=join(f.root,'overlay.patch');writeFileSync(patch,lf(readFileSync(new URL('./postman-native-'+name+'.patch',import.meta.url))))
 const args=['-c','core.longpaths=true','apply','--reverse','--include=node_modules/@deepseek-ai/'+target+'/lib/index.js',patch]
 const result=spawnSync('git',args,{cwd:f.root,stdio:'inherit',env:{...process.env,GIT_CEILING_DIRECTORIES:f.root}})
 assert.equal(result.status,0,'reverse exact own overlay '+name)
}
function historical(f,kind){
 const path=f.paths['dsh-subagent'];writeFileSync(path,canonical(images['dsh-subagent']))
 // The old inline fixture omitted settlement: even the pinned pre-task
 // installer retained these extra bytes and could not match historical hashes.
 for(const name of ['deferred-source','luna-bootstrap-report','settlement','scoped-compact','lifecycle',kind==='cold'?'cold-compact':'close-only-upgrade'])reverse(f,name,'dsh-subagent')
 const expected=kind==='cold'?'753ba9babe4aa1e548cf7b1dd6eee2ccdc666f40':'d7bcddd29f0952e2e8e4d0308b6f6f4cf921f0e6'
 assert.equal(blob(readFileSync(path)),expected,'UNCHANGED historical Git preimage')
 console.log(JSON.stringify({historical:kind,gitBlob:expected}))
}
function beforeOtherTargets(f){
 reverse(f,'app-owner','dsh-tool-pwsh')
 reverse(f,'session-events','dsh-session');reverse(f,'child-cutoff','dsh-session')
 reverse(f,'goal-continuation','dsh-goal-round-driver')
 // The SDK ships this module as LF; Git on Windows can write CRLF while
 // reversing its patch. Hash the original SDK line-ending composition.
 writeFileSync(f.paths['dsh-goal-round-driver'],lf(readFileSync(f.paths['dsh-goal-round-driver'])))
}
function verifyCurrent(f){
 for(const name of names)assert.equal(canonical(readFileSync(f.paths[name])),canonical(images[name]),name+' exact current postimage')
 assert.ok(applyPostmanNativeChildCutoff([f.anchor]).every(t=>!t.updated),'second application is idempotent')
}
test('current four-target native composition is idempotent',t=>{
 const f=fixture(t),result=applyPostmanNativeChildCutoff([f.anchor]);assert.equal(result.length,4);assert.ok(result.every(t=>!t.updated));verifyCurrent(f)
})
test('older composition without optional pwsh is three-target idempotent',t=>{
 const f=fixture(t);rmSync(join(f.root,'node_modules/@deepseek-ai/dsh-tool-pwsh'),{recursive:true})
 const result=applyPostmanNativeChildCutoff([f.anchor]);assert.equal(result.length,3);assert.ok(result.every(t=>!t.updated))
})
for(const kind of ['cold','close'])test('unchanged historical '+kind+' preimage upgrades all four targets then is idempotent',t=>{
 const f=fixture(t);historical(f,kind);beforeOtherTargets(f)
 const result=applyPostmanNativeChildCutoff([f.anchor]);assert.equal(result.length,4);assert.ok(result.every(t=>t.updated));verifyCurrent(f)
})
for(const bad of names)test('unknown '+bad+' refuses before any of four target replacements',t=>{
 const f=fixture(t);historical(f,'cold');beforeOtherTargets(f)
 writeFileSync(f.paths[bad],Buffer.concat([readFileSync(f.paths[bad]),Buffer.from('\n// unrecognized SDK composition\n')]))
 const before=Object.fromEntries(names.map(name=>[name,readFileSync(f.paths[name])]))
 assert.throws(()=>applyPostmanNativeChildCutoff([f.anchor]),/preimage mismatch|postimage mismatch|patch mismatch/)
 for(const name of names)assert.deepEqual(readFileSync(f.paths[name]),before[name],name+' unchanged after refusal')
})
