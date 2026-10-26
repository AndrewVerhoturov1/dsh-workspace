import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
await import('./sdk-loader.mjs');
const { stage1Runtime, stage1Native } = await import('../../dsh-postman-harness/lib/fixtures/postman-stage1-runtime.js');
const { NodesAgentService, nodesDomain } = await import('../lib/index.js');
const { SkillRegistry } = await stage1Native('dsh-skill');
const { Service } = await stage1Native('cordis');
const { createTemplate } = await import('../lib/domain.js');
const { JsonStorageBackend } = await stage1Native('dsh-storage-json');
const { DomainFacility } = await stage1Native('dsh-storage-domain');
test('actual rc.2 native bootstrap, routes/prompts, scoped skills and cold Session followup', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-nodes-native-'));
  let service, rt, facility; const skillStates = new Map(), allRequests = []; let solProof;
  async function turn(id, deliver) {
    const ended = Promise.withResolvers();
    const stop = rt.ctx.on('session/event',(session,event)=>{if(session.id===id && event.type==='turn/end') ended.resolve()});
    try {await deliver();await ended.promise;await rt.ctx.agents.get(id)?.whenIdle()} finally {stop()}
  }
  try {
    rt = await stage1Runtime(dir, { preset: 'postman-leader-ptc-nodes', modelCatalog:['gpt-6-luna','gpt-6.1-sol'], onRequest:(agent,request)=>allRequests.push({id:agent.id,request}), nodesService: () => service,
      async setupTools(ctx) {
        new SkillRegistry(ctx);
        ctx.skills.register({ name:'sample-skill', description:'Sample', content:'secret test instruction', source:'fixture' });
        const backend=new JsonStorageBackend(join(dir,'nodes'));
        facility=new DomainFacility({storage:{backend:{get:()=>backend}},emit(){}},{backend:'json',routes:{}});
        ctx.provide('storageDomain',facility);
        ctx.provide('postmanNativeNodes', { start:(...args)=>rt.worker.startNodesTeam(...args),
          deliverMessage:(...args)=>rt.worker.deliverNodesMessage(...args) });
        service = new NodesAgentService(ctx, {});
        await service[Service.init]();
      },
      plan: async agent => { skillStates.set(agent.id, (await agent.ctx.skills.get('sample-skill', { scope: agent })).invocation.modelInvocable);
        const current=service.bindingOf(agent);
        if(current?.node.slot==='sol' && !solProof) {
          const child=current.run.definition.agents.find(a=>a.slot==='sol-worker-1');
          const executed=await rt.ctx.tools.execute({name:'ptc_execute',arguments:{program:'return {list:await tools.postman_worker_list(), task:await tools.nodes_team_assign_task({toNodeId:'+JSON.stringify(child.id)+',goal:"Bounded native Sol-owned task"})};'},callId:'native-sol-ptc',...rt.exec(agent)});
          solProof=executed.value??executed;
        }
        return { text:'bounded fake adapter output; no external model calls' }; }
    });
    // Native source metadata, not a desired-shape mock catalog.
    const template = createTemplate();
    const worker = template.definition.agents.find(a=>a.slot==='worker-1');
    const entry = template.definition.agents.find(a=>a.slot==='entry');
    entry.model = {provider:'codex',model:'gpt-6-luna',reasoningEffort:'max'};
    entry.systemPrompt='Entry node request configuration';
    worker.model.reasoningEffort = 'max';
    worker.systemPrompt = 'Node prompt must reach actual model request';
    worker.capabilities.grants = [{kind:'skill',id:'sample-skill',mode:'deny'}];
    const saved = await service.saveTeam(template.definition, template.layout, 0);
    const run = await service.start(saved.definition.id, rt.leader.id);
    assert.equal(Object.keys(run.bindings).length, 7);
    assert.equal(allRequests.length, 0, 'bootstrap must not invoke adapter');
    await rt.wake(rt.leader);
    const rootRequest=allRequests.find(r=>r.id===rt.leader.id).request;
    assert.equal(rootRequest.model,'gpt-6-luna');assert.equal(rootRequest.reasoningEffort,'max');
    assert.match(JSON.stringify(rootRequest),/Entry node request configuration/);
    const entryTool=rt.ctx.tools.get('ptc_execute',rt.leader);
    const entryResult=await entryTool.execute({program:'return {nodes:typeof tools.nodes_team_message, work:typeof tools.postman_worker};'},rt.exec(rt.leader));
    assert.equal(entryResult.status,'ok',JSON.stringify(entryResult));
    assert.deepEqual(entryResult.value,{nodes:'function',work:'function'});
    for (const [id,b] of Object.entries(run.bindings)) {
      const node = run.definition.agents.find(a=>a.id===id);
      assert.equal(b.parentSessionId, node.slot==='entry'?null:run.bindings[run.definition.agents.find(a=>a.slot===(node.slot.startsWith('sol-worker')?'sol':'entry')).id].sessionId);
    }
    const childId=run.bindings[worker.id].sessionId;
    const ended = Promise.withResolvers();
    const stop = rt.ctx.on('session/event', (session,event) => { if(session.id===childId && event.type==='turn/end') ended.resolve(); });
    await service.sendMessage(rt.leader, worker.id, 'First actual turn');
    await ended.promise; stop();
    await rt.ctx.agents.get(childId)?.whenIdle();
    const first=rt.requests.find(r=>r.agent.id===childId);
    assert.ok(first);
    assert.equal(first.request.reasoningEffort, 'max', JSON.stringify(first.request).slice(0,3000));
    assert.equal(skillStates.get(childId), false);
    assert.match(JSON.stringify(first.request), /Node prompt must reach actual model request/);
    await turn(childId,()=>service.sendMessage(rt.leader, worker.id, 'Same Session followup'));
    assert.equal(rt.requests.filter(r=>r.agent.id===childId).length,2);
    assert.equal(skillStates.get(childId),false);
    const sol=run.definition.agents.find(a=>a.slot==='sol');
    const solChild=run.definition.agents.find(a=>a.slot==='sol-worker-1');
    const solId=run.bindings[sol.id].sessionId;
    await turn(solId,()=>service.sendMessage(rt.leader,sol.id,'Native Sol route and scope'));
    assert.equal(solProof?.status,'ok',JSON.stringify(solProof));
    assert.equal(solProof.value.task.status,'NODES_TASK_ASSIGNED');
    assert.equal(solProof.value.list.status,'POSTMAN_WORKER_LIST');
    assert.equal(service.getRun(run.id).bindings[solChild.id].parentSessionId,solId);
    assert.equal(service.table('tasks').get(solProof.value.task.taskId).status,'working');
    await assert.rejects(service.assignTask(rt.leader,solChild.id,'Unauthorized bypass'), /Only a direct manager/);
    assert.equal(service.getRun(run.id).bindings[worker.id].sessionId, childId);
    await service.control(run.id,'pause');
    await assert.rejects(service.sendMessage(rt.leader,worker.id,'blocked'), /Sender has no running/);
    await service.control(run.id,'resume');
    assert.equal(service.getRun(run.id).bindings[worker.id].sessionId,childId);
    await service.control(run.id,'stop');
    await assert.rejects(service.assignTask(rt.leader,worker.id,'blocked'), /Sender has no active/);
    await rt.dispose();rt=null;
    const backend=new JsonStorageBackend(join(dir,'nodes'));
    const reopened=new DomainFacility({storage:{backend:{get:()=>backend}},emit(){}},{backend:'json',routes:{}});
    const persisted=await reopened.open(nodesDomain);
    try {
      assert.equal(persisted.table('runs').get(run.id).status,'STOPPED');
      assert.equal(Object.keys(persisted.table('runs').get(run.id).bindings).length,7);
      assert.ok(persisted.table('definitions').get(saved.definition.id));
      assert.ok([...persisted.table('messages').entries()].length>=4);
      assert.equal(persisted.table('tasks').get(solProof.value.task.taskId).status,'working');
      assert.equal(persisted.table('attempts').get(solProof.value.task.attemptId).status,'working');
    } finally {await persisted.close()} 
  } finally { await rt?.dispose(); await rm(dir,{recursive:true,force:true}); }
});
