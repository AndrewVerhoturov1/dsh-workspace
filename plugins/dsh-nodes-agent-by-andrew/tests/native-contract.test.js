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
  let service, rt, facility; const skillStates = new Map(), allRequests = []; let solProof, activeHold;
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
          nodeAction:(...args)=>rt.worker.nativeNodeAction(...args),
          deliverMessage:(...args)=>rt.worker.deliverNodesMessage(...args) });
        service = new NodesAgentService(ctx, {});
        await service[Service.init]();
      },
      plan: async (agent,request) => { skillStates.set(agent.id, (await agent.ctx.skills.get('sample-skill', { scope: agent })).invocation.modelInvocable);
        const current=service.bindingOf(agent);
        if(current?.node.slot==='sol' && !solProof) {
          const child=current.run.definition.agents.find(a=>a.slot==='sol-worker-1');
          const executed=await rt.ctx.tools.execute({name:'ptc_execute',arguments:{program:'return {list:await tools.postman_worker_list(), task:await tools.nodes_team_assign_task({toNodeId:'+JSON.stringify(child.id)+',goal:"Bounded native Sol-owned task"}), snapshot:typeof tools.nodes_team_snapshot, lunaSend:typeof tools.nodes_team_luna_send};'},callId:'native-sol-ptc',...rt.exec(agent)});
          solProof=executed.value??executed;
        }
        if(activeHold?.sessionId===agent.id) {
          const hold=activeHold;
          hold.requestSignal=request.signal;
          hold.entered.resolve();
          if (hold.abortDriven) {
            assert.ok(request.signal instanceof AbortSignal, 'real native model turn has a cancellation signal');
            await Promise.race([hold.release.promise, new Promise(resolve => {
              if (request.signal.aborted) resolve();
              else request.signal.addEventListener('abort', resolve, {once:true});
            })]);
          } else await hold.release.promise;
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
    assert.equal(Object.keys(run.bindings).length, 1, 'Start creates only Entry');
    assert.equal(allRequests.length, 0, 'Start must not invoke model adapter');
    await rt.wake(rt.leader);
    const rootRequest=allRequests.find(r=>r.id===rt.leader.id).request;
    assert.equal(rootRequest.model,'gpt-6-luna');assert.equal(rootRequest.reasoningEffort,'max');
    assert.match(JSON.stringify(rootRequest),/Entry node request configuration/);
    const entryTool=rt.ctx.tools.get('ptc_execute',rt.leader);
    assert.ok(entryTool, 'Native PTC tool is registered for Entry');
    const entryDispatch=await rt.ctx.tools.execute({name:'ptc_execute',arguments:{program:'const s=await tools.nodes_team_snapshot({}); return {nodes:typeof tools.nodes_team_message,work:typeof tools.postman_worker,activate:typeof tools.nodes_team_activate,lunaSelect:typeof tools.nodes_team_luna_select,lunaSend:typeof tools.nodes_team_luna_send,snapshot:s.status,nodeCount:s.run.nodes.length,lunaCount:s.run.lunas.length};'},callId:'native-entry-ptc',...rt.exec(rt.leader)});
    const entryResult=entryDispatch.value??entryDispatch;
    assert.equal(entryResult.status, 'ok', 'Native PTC must execute: ' + JSON.stringify(entryResult));
    assert.deepEqual(entryResult.value, {nodes:'function',work:'function',activate:'function',lunaSelect:'function',lunaSend:'function',snapshot:'NODES_SNAPSHOT',nodeCount:7,lunaCount:3});
    const activation=await service.nodeAction(rt.leader,worker.id,'activate');
    assert.equal(activation.status,'NODES_NODE_ACTIVE',JSON.stringify(activation));
    assert.equal(allRequests.length,1, 'Only the explicitly awakened Entry invoked the adapter');
    assert.ok(['IDLE','COLD'].includes(service.getRun(run.id).bindings[worker.id].status),
      'Bootstrap is idle in memory or durably cold, never model-working');
    const childId=service.getRun(run.id).bindings[worker.id].sessionId;
    assert.ok(childId);
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
    // The fake native adapter holds a real SDK model turn. finish must wait
    // for its settlement rather than returning BUSY or closing the Session.
    const hold={sessionId:childId,entered:Promise.withResolvers(),release:Promise.withResolvers()};
    activeHold=hold;
    const ensuredBeforeHold=await service.nodeAction(rt.leader,worker.id,'activate');
    assert.equal(ensuredBeforeHold.status,'NODES_NODE_ACTIVE',JSON.stringify(ensuredBeforeHold));
    await service.sendMessage(rt.leader,worker.id,'Held native worker turn');
    await hold.entered.promise;
    let finishSettled=false;
    const pendingFinish=service.nodeAction(rt.leader,worker.id,'finish').then(value=>{
      finishSettled=true; return value;
    });
    try {
      await new Promise(resolve=>setTimeout(resolve,40));
      assert.equal(finishSettled,false,'finish must not return while the model turn is unresolved');
    } finally { hold.release.resolve(); activeHold=null; }
    const finishedBusy=await pendingFinish;
    assert.equal(finishedBusy.status,'NODES_NODE_SUSPENDED',JSON.stringify(finishedBusy));
    assert.equal(service.getRun(run.id).bindings[worker.id].sessionId,childId);
    assert.equal(service.getRun(run.id).bindings[worker.id].status,'COLD');
    assert.equal(rt.ctx.agents.get(childId),undefined,'native child activation was released');
    const reactivatedBusy=await service.nodeAction(rt.leader,worker.id,'activate');
    assert.equal(reactivatedBusy.status,'NODES_NODE_ACTIVE',JSON.stringify(reactivatedBusy));
    assert.equal(reactivatedBusy.workerSessionId,childId,'finish preserves exact native Session');
    assert.equal(rt.requests.filter(r=>r.agent.id===childId).length,3,
      'reactivation does not launch a new model turn');
    // Interrupt is an explicit cancellation, unlike finish: the native
    // running request must receive abort while the Session survives.
    const interruptHold={sessionId:childId,entered:Promise.withResolvers(),
      release:Promise.withResolvers(),abortDriven:true};
    activeHold=interruptHold;
    try {
      await service.sendMessage(rt.leader,worker.id,'Active native turn to interrupt');
      await interruptHold.entered.promise;
      const interrupted=await service.nodeAction(rt.leader,worker.id,'interrupt');
      assert.equal(interrupted.status,'NODES_NODE_SUSPENDED',JSON.stringify(interrupted));
      assert.equal(interruptHold.requestSignal?.aborted,true,
        'native interrupt must abort the exact running model request');
      assert.equal(service.getRun(run.id).bindings[worker.id].status,'COLD');
      assert.equal(service.getRun(run.id).bindings[worker.id].sessionId,childId);
      assert.equal(rt.ctx.agents.get(childId),undefined);
    } finally {interruptHold.release.resolve();activeHold=null;}
    const callsBeforeInterruptResume=rt.requests.filter(r=>r.agent.id===childId).length;
    const afterInterrupt=await service.nodeAction(rt.leader,worker.id,'activate');
    assert.equal(afterInterrupt.status,'NODES_NODE_ACTIVE',JSON.stringify(afterInterrupt));
    assert.equal(afterInterrupt.workerSessionId,childId);
    assert.equal(rt.requests.filter(r=>r.agent.id===childId).length,callsBeforeInterruptResume,
      'interrupt reactivation must not launch a new model turn');
    const sol=run.definition.agents.find(a=>a.slot==='sol');
    const solChild=run.definition.agents.find(a=>a.slot==='sol-worker-1');
    const idleSolChild=run.definition.agents.find(a=>a.slot==='sol-worker-2');
    const missingParent=await service.userNodeAction(run.id,solChild.id,'activate');
    assert.equal(missingParent.status,'NODES_NATIVE_PARENT_UNAVAILABLE','a nested child cannot auto-activate Sol');
    assert.equal(service.getRun(run.id).bindings[sol.id],undefined);
    const activatedSol=await service.nodeAction(rt.leader,sol.id,'activate');
    assert.equal(activatedSol.status,'NODES_NODE_ACTIVE',JSON.stringify(activatedSol));
    const solId=service.getRun(run.id).bindings[sol.id].sessionId;
    const nested=await service.userNodeAction(run.id,idleSolChild.id,'activate');
    assert.equal(nested.status,'NODES_NODE_ACTIVE',JSON.stringify(nested));
    const nestedId=service.getRun(run.id).bindings[idleSolChild.id].sessionId;
    assert.equal(service.getRun(run.id).bindings[idleSolChild.id].parentSessionId,solId,
      'Sol-owned children keep native ownership');
    assert.ok(!allRequests.some(r=>r.id===nestedId),'idle activation must not invoke child model');
    await turn(solId,()=>service.sendMessage(rt.leader,sol.id,'Native Sol route and scope'));
    assert.equal(solProof?.status, 'ok', 'Sol native PTC must execute: ' + JSON.stringify(solProof));
    assert.equal(solProof.value.task.status,'NODES_TASK_ASSIGNED');
    assert.equal(solProof.value.list.status,'POSTMAN_WORKER_LIST');
    assert.equal(solProof.value.snapshot,'function','Sol can read its native scoped snapshot');
    assert.equal(solProof.value.lunaSend,'undefined','Sol cannot use Entry-only Luna Send');
    assert.equal(service.getRun(run.id).bindings[solChild.id].parentSessionId,solId);
    assert.equal(service.table('tasks').get(solProof.value.task.taskId).status,'working');
    await assert.rejects(service.assignTask(rt.leader,solChild.id,'Unauthorized bypass'), /Only a direct manager/);
    assert.ok(!allRequests.some(r=>r.id===nestedId),
      'prior idle activation must not invoke the task-free Sol child model');
    const cascade=await service.userNodeAction(run.id,sol.id,'finish');
    assert.ok(['NODES_NODE_SUSPENDED','NODES_NODE_ALREADY_COLD'].includes(cascade.status),
      JSON.stringify({cascade,solChild:solChild.id,idleSolChild:idleSolChild.id}));
    assert.equal(service.getRun(run.id).bindings[idleSolChild.id].sessionId,nestedId);
    assert.equal(service.getRun(run.id).bindings[sol.id].sessionId,solId);
    assert.equal(service.getRun(run.id).bindings[idleSolChild.id].status,'COLD');
    const nestedAgain=await service.userNodeAction(run.id,idleSolChild.id,'activate');
    assert.equal(nestedAgain.status,'NODES_NODE_ACTIVE',JSON.stringify(nestedAgain));
    assert.equal(nestedAgain.workerSessionId,nestedId,'cascade must preserve exact nested Session history');
    assert.ok(!allRequests.some(r=>r.id===nestedId),
      'cold reactivation must not invoke the exact child model');
    const solTurnsBeforeResume=rt.requests.filter(r=>r.agent.id===solId).length;
    const reactivatedSol=await service.nodeAction(rt.leader,sol.id,'activate');
    assert.equal(reactivatedSol.status,'NODES_NODE_ACTIVE',JSON.stringify(reactivatedSol));
    assert.equal(reactivatedSol.workerSessionId,solId);
    assert.equal(rt.requests.filter(r=>r.agent.id===solId).length,solTurnsBeforeResume,
      'parent cold reactivation is not a model turn');
    await turn(nestedId,()=>service.sendMessage(rt.ctx.agents.get(solId),idleSolChild.id,
      'Native nested followup after cascade, same Session'));
    assert.equal(rt.requests.filter(r=>r.agent.id===nestedId).length,1,
      'saved nested child receives a genuine model turn on its original Session');
    assert.equal(service.getRun(run.id).bindings[worker.id].sessionId, childId);
    const released=await service.nodeAction(rt.leader,worker.id,'finish');
    assert.ok(['NODES_NODE_SUSPENDED','NODES_NODE_ALREADY_COLD'].includes(released.status),JSON.stringify(released));
    assert.equal(service.getRun(run.id).bindings[worker.id].sessionId,childId,'release must preserve exact identity');
    const resumed=await service.nodeAction(rt.leader,worker.id,'activate');
    assert.equal(resumed.status,'NODES_NODE_ACTIVE',JSON.stringify(resumed));
    assert.equal(resumed.workerSessionId,childId,'reactivation must reuse durable Session');
    await service.control(run.id,'pause');
    await assert.rejects(service.sendMessage(rt.leader,worker.id,'blocked'), /Sender has no running/);
    await service.control(run.id,'resume');
    assert.equal(service.getRun(run.id).bindings[worker.id].sessionId,childId);
    await service.control(run.id,'stop');
    await assert.rejects(service.assignTask(rt.leader,worker.id,'blocked'), /Sender has no active/);
    const expectedPersistedBindings=Object.keys(service.getRun(run.id).bindings).length;
    await rt.dispose();rt=null;
    const backend=new JsonStorageBackend(join(dir,'nodes'));
    const reopened=new DomainFacility({storage:{backend:{get:()=>backend}},emit(){}},{backend:'json',routes:{}});
    const persisted=await reopened.open(nodesDomain);
    try {
      assert.equal(persisted.table('runs').get(run.id).status,'STOPPED');
      assert.equal(Object.keys(persisted.table('runs').get(run.id).bindings).length,
        expectedPersistedBindings,'native mappings persist after shutdown');
      assert.ok(persisted.table('definitions').get(saved.definition.id));
      assert.ok([...persisted.table('messages').entries()].length>=3);
      assert.equal(persisted.table('tasks').get(solProof.value.task.taskId).status,'working');
      assert.equal(persisted.table('attempts').get(solProof.value.task.attemptId).status,'working');
    } finally {await persisted.close()} 
  } finally { await rt?.dispose(); await rm(dir,{recursive:true,force:true}); }
});
