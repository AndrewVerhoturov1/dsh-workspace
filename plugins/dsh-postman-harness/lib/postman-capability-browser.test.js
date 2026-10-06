import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {capabilityRuntime,native,repositoryRoot} from './fixtures/postman-capability-runtime.js'
const ptc=program=>({program,description:'Create exact bounded role for browser inventory',boundary:'semantic_decision'})
const value=r=>{assert.equal(r.isError,false,JSON.stringify(r));return r.value}
const nested=r=>{const v=value(r);assert.equal(v.status,'ok',JSON.stringify(v));return v.value}
const names=r=>r.tools.filter(t=>t.name.startsWith('mcp__playwright__')).map(t=>t.name).sort()
const report={name:'report',args:{output:'Exact browser schema inventory verified, no Web Send'}}

test('actual production Playwright MCP inventory is equal for Workers and Sol, absent for Secretary/Leader',{skip:!process.env.POSTMAN_BROWSER_INVENTORY,timeout:90000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'postman-browser-catalog-')),gate=Promise.withResolvers(),entered=Promise.withResolvers(),queues=new Map()
 t.after(()=>gate.resolve())
 const f=await capabilityRuntime(dir,{plan:async a=>{if(a.options.model==='gpt-6.1-sol'&&a.id!=='leader'){entered.resolve(a);await gate.promise}return queues.get(a.id)?.shift()??(a.id==='leader'?null:report)}})
 t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
 await f.prepare();await f.turn(f.leader)
 const call=async(name,args)=>nested(await f.execute(f.leader,'ptc_execute',ptc('return await tools.'+name+'('+JSON.stringify(args)+')')))
 const w=await call('postman_worker',{task:'bounded pre-MCP assignment'}),s=await call('postman_secretary',{task:'bounded pre-MCP facts'})
 await f.childDone(w.workerSessionId);await f.childDone(s.workerSessionId)
 // Use real production MCP client and exact production server configuration,
 // globally registered AFTER boundaries, not pretend browser tool definitions.
 const m=await native('dsh-mcp-client'),mount=f.ctx.plugin(m,{transport:'stdio',serverName:'playwright',command:'npx',args:['-y','@playwright/mcp@latest','--config',join(repositoryRoot,'profiles/web/playwright-mcp.config.json')],env:{},cwd:dir,toolCallTimeoutMs:30000,failOnStartupError:true})
 await mount.await();await f.ctx.fiber.await()
 const inventory=f.ctx.tools.schemas().filter(t=>t.name.startsWith('mcp__playwright__')).map(t=>t.name).sort()
 assert.ok(inventory.length>0,'actual MCP must register');t.diagnostic('BROWSER INVENTORY: '+JSON.stringify(inventory))
 for(const row of [w,s]){
  queues.set(row.workerSessionId,[...(row===w?[{name:'mcp__playwright__browser_close',args:{}}]:[]),report])
  const r=await call(row===w?'postman_worker':'postman_secretary',{workerSessionId:row.workerSessionId,task:'bounded post-MCP inventory'});assert.equal(r.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(r));await f.childDone(row.workerSessionId)
 }
 const sr=await call('postman_sol_worker',{task:'User selected explicit Sol route, bounded browser inventory'});assert.equal(sr.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(sr));const sol=await entered.promise
 const own=value(await f.execute(sol,'postman_worker',{task:'bounded owned browser inventory'}));assert.equal(own.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(own));await f.childDone(own.workerSessionId)
 const latest=id=>f.requests.filter(x=>x.agent.id===id).at(-1).request
 for(const id of [w.workerSessionId,own.workerSessionId,sol.id])assert.deepEqual(names(latest(id)),inventory)
 assert.deepEqual(names(latest(s.workerSessionId)),[]);assert.deepEqual(names(await f.turn(f.leader)),[])
 const smoke=f.results.find(x=>x.agent.id===w.workerSessionId&&x.name==='mcp__playwright__browser_close');assert.ok(smoke);const solSmoke=await f.execute(sol,'mcp__playwright__browser_close',{})
 for(const r of [smoke.result,solSmoke]){if(r.isError){assert.match(r.error.message,/Browser .* is not installed/);t.diagnostic('ENVIRONMENT: native dispatch reached MCP; configured Chromium binary is absent')}else assert.equal(r.isError,false)}
 gate.resolve();await f.childDone(sol.id)
})
