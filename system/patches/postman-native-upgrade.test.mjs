import assert from 'node:assert/strict'
import test from 'node:test'
import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,renameSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname,resolve,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {applyPostmanNativeChildCutoff} from './apply-postman-native-child-cutoff.mjs'
const repository=resolve(fileURLToPath(new URL('../../',import.meta.url)))
const sdk=createRequire(process.env.DSH_INSTALL_SDK ?? process.env.DSH_CAPABILITY_SDK ?? createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
const names=['dsh-subagent','dsh-session','dsh-goal-round-driver','dsh-tool-goal','dsh-tool-pwsh']
const images=Object.fromEntries(names.map(name=>[name,readFileSync(sdk.resolve('@deepseek-ai/'+name))]))
const lf=text=>text.toString().replaceAll(String.fromCharCode(13),'')
// Expected current images remove the former transcript interpretation.
const previousImages={...images}
{
 let source=lf(images['dsh-goal-round-driver'])
 if(source.includes('function hasWorkToContinue(agent)')){
  const start=source.indexOf('\t/** Goal bookkeeping and a delivered answer'),end=source.indexOf('\t/** Whether this exact lifecycle',start)
  source=(source.slice(0,start)+source.slice(end)).replace(' && hasWorkToContinue(state.agent)','')
   .replace('\t\treturn ctx.fiber.state === 2 && !state.stopping','\t\t// An authoritative plugin wait defers only automatic goal admission.\n\t\t// Native inbox input and the existing checkpoint recheck stay unchanged.\n\t\treturn ctx.fiber.state === 2 && !state.stopping')
 }
 images['dsh-goal-round-driver']=Buffer.from(source)
 source=lf(images['dsh-tool-goal'])
 if(source.includes('// A terminal answer in this very response')){
  const start=source.indexOf('\t\t\t// A terminal answer in this very response'),end=source.indexOf(' exec.deferContext(createUserMessage({',start)
  source=source.slice(0,start)+'\t\t\tif (authority.kind === "goal-round")'+source.slice(end)
 }
 images['dsh-tool-goal']=Buffer.from(source)
}
// Fixtures start at the native-only image even when the installed SDK already has the approved panel delta.
images['dsh-session']=Buffer.from(lf(images['dsh-session']).replace('\t\t\t...surfaceOpts?.ignorable === true ? { ignorable: true } : {},\n',''))
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
test('current five-target native composition is idempotent',t=>{
 const f=fixture(t),result=applyPostmanNativeChildCutoff([f.anchor]);assert.equal(result.length,5);assert.ok(result.every(t=>!t.updated));verifyCurrent(f)
})
test('previous semantic goal overlays upgrade to explicit waiting and native goal reporting',t=>{
 const f=fixture(t)
 for(const name of ['dsh-goal-round-driver','dsh-tool-goal'])writeFileSync(f.paths[name],previousImages[name])
 const result=applyPostmanNativeChildCutoff([f.anchor]);verifyCurrent(f)
 assert.doesNotMatch(readFileSync(f.paths['dsh-goal-round-driver'],'utf8'),/hasWorkToContinue|needsModelDecision|\.boundary/)
 assert.doesNotMatch(readFileSync(f.paths['dsh-tool-goal'],'utf8'),/finalReady/)
 assert.equal(result.filter(t=>t.updated).length,previousImages['dsh-goal-round-driver'].equals(images['dsh-goal-round-driver'])?0:2)
})
test('older composition without optional pwsh is four-target idempotent',t=>{
 const f=fixture(t);rmSync(join(f.root,'node_modules/@deepseek-ai/dsh-tool-pwsh'),{recursive:true})
 const result=applyPostmanNativeChildCutoff([f.anchor]);assert.equal(result.length,4);assert.ok(result.every(t=>!t.updated))
})
for(const kind of ['cold','close'])test('unchanged historical '+kind+' preimage upgrades all five targets then is idempotent',t=>{
 const f=fixture(t);historical(f,kind);beforeOtherTargets(f)
 const result=applyPostmanNativeChildCutoff([f.anchor]);assert.equal(result.length,5);assert.equal(result.filter(t=>t.updated).length,4);verifyCurrent(f)
})
for(const bad of names)test('unknown '+bad+' refuses before any of five target replacements',t=>{
 const f=fixture(t);historical(f,'cold');beforeOtherTargets(f)
 writeFileSync(f.paths[bad],Buffer.concat([readFileSync(f.paths[bad]),Buffer.from('\n// unrecognized SDK composition\n')]))
 const before=Object.fromEntries(names.map(name=>[name,readFileSync(f.paths[name])]))
 assert.throws(()=>applyPostmanNativeChildCutoff([f.anchor]),/preimage mismatch|postimage mismatch|patch mismatch/)
 for(const name of names)assert.deepEqual(readFileSync(f.paths[name]),before[name],name+' unchanged after refusal')
})
for(const newline of ['LF','CRLF'])test('known panel composition remains strict and idempotent with '+newline,t=>{
 const f=fixture(t),path=f.paths['dsh-session']
 const before='\t\tconst surfaceMetadata = {\n',after=before+'\t\t\t...surfaceOpts?.ignorable === true ? { ignorable: true } : {},\n'
 let text=lf(readFileSync(path));assert.equal(text.split(before).length,2)
 text=text.replace(before,after);if(newline==='CRLF')text=text.replaceAll('\n','\r\n')
 writeFileSync(path,text)
 const bytes=readFileSync(path)
 assert.ok(applyPostmanNativeChildCutoff([f.anchor]).every(t=>!t.updated))
 assert.deepEqual(readFileSync(path),bytes,'already final panel bytes unchanged')
 reverse(f,'session-events','dsh-session');reverse(f,'child-cutoff','dsh-session')
 const pre=lf(readFileSync(path));writeFileSync(path,newline==='CRLF'?pre.replaceAll('\n','\r\n'):pre)
 assert.equal(applyPostmanNativeChildCutoff([f.anchor]).find(t=>t.path===path).updated,true)
 assert.deepEqual(readFileSync(path),bytes,'full supported panel native composition restored')
 assert.ok(applyPostmanNativeChildCutoff([f.anchor]).every(t=>!t.updated))
})
test('later target replacement failure restores exact previous multi-target bytes',t=>{
 const f=fixture(t);historical(f,'cold');beforeOtherTargets(f)
 const before=Object.fromEntries(names.map(name=>[name,readFileSync(f.paths[name])]))
 let calls=0
 assert.throws(()=>applyPostmanNativeChildCutoff([f.anchor],{replaceFile(from,to){if(++calls===2)throw Error('controlled second-target replacement failure');renameSync(from,to)}}),/controlled second-target/)
 assert.equal(calls,2)
 for(const name of names)assert.deepEqual(readFileSync(f.paths[name]),before[name],name+' restored byte-for-byte')
})
test('clean final session adds required panel inside the same atomic SDK composition',t=>{
 const f=fixture(t),path=f.paths['dsh-session']
 const before=lf(readFileSync(path));assert.ok(!before.includes('			...surfaceOpts?.ignorable === true ? { ignorable: true } : {},'))
 assert.equal(applyPostmanNativeChildCutoff([f.anchor],{sessionIgnorableAnchors:[f.anchor]}).find(t=>t.path===path).updated,true)
 assert.ok(readFileSync(path,'utf8').includes('			...surfaceOpts?.ignorable === true ? { ignorable: true } : {},'))
 assert.ok(applyPostmanNativeChildCutoff([f.anchor],{sessionIgnorableAnchors:[f.anchor]}).every(t=>!t.updated))
})
