import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { createTemplate, SLOTS } from '../lib/domain.js';

// The task worktree intentionally has no node_modules. Test the exact Host
// adapter contract with inert core services; no model calls or DSH activation.
const mocks = new Map([
  ['@deepseek-ai/cordis', 'export class Service { static init = Symbol("init"); }'],
  ['@deepseek-ai/dsh-storage-domain', 'export const defineDomain = x => x; export const domainTable = x => x;'],
  ['@deepseek-ai/dsh-tools', 'export const defineTool = x => x;'],
  ['@deepseek-ai/dsh-llm', 'export const createUserMessage = x => ({ ...x, id: "user-message" });'],
  ['@deepseek-ai/dsh-scope', 'export const scopeOf = ctx => ctx.scope; export const scopeParentOf = () => undefined;'],
  ['zod', 'export const z = { record:()=>({}), string:()=>({}), unknown:()=>({}), object:()=>({}) };']
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!mocks.has(specifier)) return nextResolve(specifier, context);
    return { url: 'data:text/javascript,' + encodeURIComponent(mocks.get(specifier)), shortCircuit: true };
  }
});
const { NodesAgentService } = await import('../lib/index.js');
const { Service } = await import('@deepseek-ai/cordis');

class Table {
  constructor() { this.map = new Map(); }
  get(id) { return this.map.get(id); }
  entries() { return this.map.entries(); }
  async put(id, value) { this.map.set(id, structuredClone(value)); }
}
function setup() {
  const tables = Object.fromEntries(['definitions', 'layouts', 'runs', 'messages', 'tasks', 'attempts', 'luna_archives'].map(k => [k, new Table()]));
  const agents = new Map();
  const sent = [];
  const steered = [];
  const skillRegistrations = [];
  const leader = {
    id: 'root-1', status: 'idle', async whenIdle() {}, options: { provider: 'codex', model: 'gpt-6.1-sol' },
    session: { header: { agentPreset: 'postman-leader-ptc-nodes', delegationDepth: 0 } },
    ctx: { skills: { register: skill => { skillRegistrations.push(skill); return () => {}; } } },
    steer: event => steered.push(event)
  };
  agents.set(leader.id, leader);
  const models = [...new Set(SLOTS.map(s => s.model))].map(id => ({ id, name: id }));
  const catalog = { llm: { listProviders: () => [{ id: 'codex', name: 'Codex' }], listModels: async () => models,
    resolveModelInfo: (_provider, id) => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'xhigh' }], defaultEffort: id === 'gpt-6-luna' ? 'low' : 'xhigh' } }) },
    skills: { list: async () => [{ name: 'sample-skill', description: 'Sample', invocation: { modelInvocable: true } },
      { name: 'postman-worker', description: 'Required role skill', invocation: { modelInvocable: true } }] },
    tools: { schemas: () => [{name:'report',description:''}, {name:'notify_parent',description:''}] } };
  const service = Object.create(NodesAgentService.prototype);
  service.tables = tables; service.chains = new Map(); service.initializing = new Map();
  service.ctx = { agents: { get: id => agents.get(id) }, ...catalog };
  const native = {
    async start(parent, id) {
      assert.equal(parent.id, 'root-1');
      assert.equal(service.getRun(id).status, 'RUNNING');
      return { status: 'NODES_NATIVE_READY' };
    },
    async deliverMessage(sender, child, nativeOwner, runId, content) {
      sent.push({ sender: sender.id, child, nativeOwner, runId, content });
      return 'message-received';
    }
  };
  service.ctx.postmanNativeNodes = native;
  const template = createTemplate();
  void tables.definitions.put(template.definition.id, template.definition);
  void tables.layouts.put(template.definition.id, template.layout);
  return { service, template, tables, leader, agents, sent, steered, native, skillRegistrations };
}
test('empty effective allowlist denies optional tools without changing empty-grant inheritance', async () => {
  const { service, tables, leader } = setup();
  let guard;
  Object.assign(service.ctx, {
    storageDomain: { open: async () => ({ table: key => tables[key], close() {} }) },
    effect() {}, inject() {}, on() {},
    systemPrompt: { section() {} }, subagents: { registerContinuableSetup() {} }
  });
  Object.assign(service.ctx.tools, { register() {}, guard: callback => { guard = callback; } });
  await service[Service.init]();
  const node = { slot: 'entry', capabilities: { grants: [
    { kind: 'tool', id: 'read', mode: 'allow' },
    { kind: 'tool', id: 'read', mode: 'deny' }
  ] } };
  service.bindingOf = agent => agent === leader ? { run: { status: 'RUNNING' }, node } : null;
  const check = name => guard({ agent: leader, name });
  assert.equal(check('read'), 'NODES_CAPABILITY_DENIED');
  assert.equal(check('write'), 'NODES_CAPABILITY_NOT_GRANTED');
  for (const name of service.nativePolicy(node.slot).requiredTools) assert.equal(check(name), undefined);
  node.capabilities.grants = [];
  assert.equal(check('read'), undefined);
  assert.equal(check('write'), undefined);
  assert.equal(guard({ agent: {}, name: 'write' }), undefined, 'unbound Sessions remain untouched');
});

test('saved definitions use optimistic revisions, independently persisted layouts', async () => {
  const { service, template, tables } = setup();
  const before = service.getTeam(template.definition.id);
  const changed = structuredClone(before.definition); changed.name = 'New name';
  const saved = await service.saveTeam(changed, before.layout, before.definition.revision);
  assert.equal(saved.definition.revision, 1);
  assert.equal(tables.definitions.get(changed.id).name, 'New name');
  await assert.rejects(service.saveTeam(changed, before.layout, 0), e => e.code === 'REVISION_CONFLICT');
  const moved = structuredClone(before.layout); moved.viewport.zoom = 1.5;
  await service.saveLayout(moved);
  assert.equal(service.getTeam(changed.id).layout.viewport.zoom, 1.5);
  assert.equal(service.getTeam(changed.id).definition.revision, 1);
});

test('verified Luna archive survives a closed TeamRun and explicit old-chat selection never reuses a REQ', async () => {
  const { service, template, leader, agents, native, tables } = setup();
  const reservations = [];
  const evidence = new Map(), busy = new Set();
  native.start = async (parent, id) => {
    assert.equal(service.getRun(id).rootSessionId, parent.id);
    return { status: 'NODES_NATIVE_READY' };
  };
  native.reserveLunas = async (root, lanes, archive = null, previousLane = null) => {
    reservations.push({ rootId: root.id, lanes, archive, previousLane });
    return { status: 'NODES_LUNA_RESERVED' };
  };
  native.lunaSnapshot = (root, lanes) => lanes.map(laneId => ({
    laneId, status: busy.has(laneId) ? 'WORKING' : 'POTENTIAL',
    activeJobId: busy.has(laneId) ? 'current-job' : null,
    conversations: evidence.get((typeof root === 'string' ? root : root.id) + ':' + laneId) ?? []
  }));
  const luna = template.definition.lunas[0];
  const first = await service.start(template.definition.id, leader.id);
  assert.equal(first.lunas.length, 3, 'native template has three optional Luna bridges');
  assert.equal(reservations[0].lanes.length, 3);
  const originalLane = first.lunaSelections[luna.id];
  const original = {
    id: 'job-archived', conversationRef: 'https://chatgpt.com/c/verified-history',
    sourceLeaderSessionId: leader.id, sourceLaneId: originalLane, sourceChildSessionId: 'historical-luna',
    requestId: 'REQ_20261026T120000Z_0001', createdAt: '2026-10-26T12:00:00Z',
    reminderSent: 2
  };
  evidence.set(leader.id + ':' + originalLane, [original]);
  await service.control(first.id, 'stop');
  assert.deepEqual(tables.luna_archives.get(template.definition.id)[luna.id], [original]);
  agents.delete(leader.id); // Old Leader is cold; Host history is still readable.
  const nextRoot = { ...leader, id: 'root-2', status: 'idle' };
  agents.set(nextRoot.id, nextRoot);
  const next = await service.start(template.definition.id, nextRoot.id);
  assert.notEqual(next.lunaSelections[luna.id], originalLane);
  await service.syncLunaArchive(next.id);
  assert.equal(service.getRun(next.id).lunaArchive[luna.id][0].requestId, original.requestId);
  await assert.rejects(service.selectLunaConversation(next.id, luna.id, 'invented'),
    error => error.code === 'LUNA_ARCHIVE_NOT_FOUND');
  const selected = await service.selectLunaConversation(next.id, luna.id, original.id);
  assert.equal(selected.lunas.find(x => x.id === luna.id).selectedArchivedConversation, original.conversationRef);
  assert.notEqual(selected.lunaSelections[luna.id], next.lunaSelections[luna.id]);
  assert.notEqual(selected.lunaSelections[luna.id], originalLane);
  assert.equal(reservations.at(-1).archive.requestId, original.requestId,
    'original REQ provenance is retained as history, not new job identity');
  busy.add(selected.lunaSelections[luna.id]);
  const before = reservations.length;
  await assert.rejects(service.selectLunaConversation(next.id, luna.id, null),
    error => error.code === 'NODES_LUNA_BUSY');
  assert.equal(reservations.length, before, 'cannot replace a Luna with live job');
  assert.deepEqual(tables.luna_archives.get(template.definition.id)[luna.id], [original]);
});

test('run identity, native owner binding, messages, formal TaskAttempt and lifecycle', async () => {
  const { service, template, leader, agents, sent, steered, tables, skillRegistrations } = setup();
  const entry = template.definition.agents.find(a => a.slot === 'entry');
  entry.capabilities.grants = [{ kind: 'skill', id: 'sample-skill', mode: 'deny' }];
  await tables.definitions.put(template.definition.id, template.definition);
  const run = await service.start(template.definition.id, leader.id);
  assert.equal(run.rootSessionId, leader.id);
  assert.equal(run.teamDefinitionRevision, 0);
  assert.equal(skillRegistrations.length, 1);
  assert.equal(skillRegistrations[0].name, 'sample-skill');
  assert.deepEqual(skillRegistrations[0].invocation, { modelInvocable: false, userInvocable: false });
  assert.equal(run.skillCatalog.some(skill => skill.name === 'postman-worker'), true);
  assert.equal(Object.keys(run.bindings).length, 1);
  const worker = service.nodeForNativeWorker(leader, 'luna', {});
  assert.equal(worker.node.slot, 'worker-1');
  await service.nativeChildAccepted(leader, 'child-1', worker.nodeId, run.id);
  const childAgent = { id: 'child-1', session: { header: {
    origin: 'subagent', parentSession: leader.id, delegationDepth: 1
  } } };
  agents.set(childAgent.id, childAgent);
  assert.equal(service.bindingOf(childAgent)?.nodeId, worker.nodeId);
  assert.equal(service.runFor(leader.id)?.bindings[worker.nodeId].sessionId, 'child-1');
  const taskResult = await service.assignTask(leader, worker.nodeId, 'Verify implementation');
  assert.equal(taskResult.status, 'NODES_TASK_ASSIGNED');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].nativeOwner, leader.id);
  assert.equal(tables.attempts.get(taskResult.attemptId).status, 'working');
  const done = await service.completeTask(childAgent, taskResult.taskId, 'Verified');
  assert.equal(done.status, 'NODES_TASK_COMPLETED');
  assert.equal(tables.tasks.get(taskResult.taskId).status, 'completed');
  assert.equal(tables.attempts.get(taskResult.attemptId).status, 'completed');
  assert.equal(steered.length, 1);
  assert.match(steered[0].content[0].text, /Verified/);
  await assert.rejects(service.completeTask(leader, taskResult.taskId, 'Spoofed'), e => e.code === 'TASK_IDENTITY_REJECTED');
  assert.equal((await service.control(run.id, 'pause')).status, 'PAUSED');
  await assert.rejects(service.sendMessage(leader, worker.nodeId, 'Forbidden'), e => e.code === 'SENDER_REJECTED');
  assert.equal((await service.control(run.id, 'resume')).status, 'RUNNING');
  assert.equal((await service.control(run.id, 'stop')).status, 'STOPPED');
  await assert.rejects(service.assignTask(leader, worker.nodeId, 'Another'), e => e.code === 'ASSIGNMENT_DENIED');
  await assert.rejects(service.start(template.definition.id, leader.id), e => e.code === 'SESSION_ALREADY_BOUND');
});

test('current Entry graph and scoped Sol branch expose configured rights, not foreign prompts or Luna authority', async () => {
  const { service, template, leader, agents, native, tables } = setup();
  const registered = new Map(); let renderPrompt;
  const unrelated = template.definition.agents.find(a => a.slot === 'worker-1');
  unrelated.systemPrompt = 'PRIVATE_OTHER_WORKER_PROMPT';
  await tables.definitions.put(template.definition.id, template.definition);
  Object.assign(service.ctx, {
    storageDomain: { open: async () => ({ table: key => tables[key], close() {} }) },
    effect() {}, inject() {}, on() {},
    systemPrompt: { section(spec) { if (spec.name === 'nodes-team') renderPrompt = spec.text; } },
    subagents: { registerContinuableSetup() {} }
  });
  Object.assign(service.ctx.tools, { register: tool => registered.set(tool.name, tool), guard() {} });
  await service[Service.init]();
  const run = await service.start(template.definition.id, leader.id);
  const leaderGraph = service.snapshotForAgent(leader);
  assert.equal(leaderGraph.status, 'NODES_SNAPSHOT');
  assert.equal(leaderGraph.run.nodes.length, 7);
  assert.equal(leaderGraph.run.lunas.length, 3);
  assert.equal(leaderGraph.run.nodes.find(a => a.slot === 'worker-1').model.model, 'gpt-6-luna');
  assert.ok(leaderGraph.run.nodes.find(a => a.slot === 'entry').tools.required.includes('nodes_team_luna_send'));
  assert.ok(leaderGraph.run.nodes.every(a => !Object.hasOwn(a, 'systemPrompt')));
  const prompt = renderPrompt({ scope: leader });
  assert.match(prompt, /nodes_team_luna_send/);
  assert.match(prompt, /nodes_team_snapshot/);
  assert.doesNotMatch(prompt, /PRIVATE_OTHER_WORKER_PROMPT/);
  assert.ok(prompt.includes(template.definition.lunas[0].id));
  const sol = template.definition.agents.find(a => a.slot === 'sol');
  await service.nativeChildAccepted(leader, 'sol-test-session', sol.id, run.id);
  const solAgent = { id: 'sol-test-session', session: { header: {
    origin: 'subagent', parentSession: leader.id, delegationDepth: 1 } } };
  agents.set(solAgent.id, solAgent);
  const solGraph = service.snapshotForAgent(solAgent);
  assert.deepEqual(solGraph.run.nodes.map(a => a.slot).sort(),
    ['entry', 'sol', 'sol-worker-1', 'sol-worker-2']);
  assert.equal(solGraph.run.lunas, undefined);
  assert.ok(!solGraph.run.nodes.find(a => a.slot === 'sol').tools.required.includes('nodes_team_luna_send'));
  assert.equal(registered.get('nodes_team_luna_send') !== undefined, true);
  const sent = [];
  native.sendLuna = async (parent, laneId, args) => {
    sent.push({ parent: parent.id, laneId, ...args });
    return { status: 'POSTMAN_BRIDGE_ACCEPTED', bridgeJobId: 'job-' + sent.length };
  };
  const lunaId = template.definition.lunas[0].id;
  const payload = { lunaId, message: '@PostmanDevspace explicit factual task', devspaceMode: 'READ_ONLY' };
  assert.equal((await registered.get('nodes_team_luna_send').execute(payload, { agent: solAgent })).status,
    'NODES_LUNA_OWNER_REJECTED');
  assert.equal((await registered.get('nodes_team_luna_send').execute(payload, { agent: leader })).status,
    'POSTMAN_BRIDGE_ACCEPTED');
  assert.equal((await service.dispatch('runs/luna-send', { id: run.id, ...payload })).status,
    'POSTMAN_BRIDGE_ACCEPTED');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].laneId, run.lunaSelections[lunaId]);
  assert.equal(sent[1].laneId, sent[0].laneId);
});

test('deleting every Luna from the schema preserves its archived verified chat across the next TeamRun', async () => {
  const { service, template, leader, agents, native, tables } = setup();
  native.start = async () => ({ status: 'NODES_NATIVE_READY' });
  const old = await service.start(template.definition.id, leader.id);
  const id = template.definition.lunas[0].id;
  const prior = { id: 'saved-job', sourceLeaderSessionId: leader.id,
    sourceLaneId: old.lunaSelections[id], sourceChildSessionId: 'luna-session',
    requestId: 'REQ_20261026T120000Z_0002', conversationRef: 'https://chatgpt.com/c/proven',
    createdAt: '2026-10-26T12:00:00Z', reminderSent: null };
  native.lunaSnapshot = (root, lanes) => lanes.map(laneId => ({ laneId,
    status: 'IDLE', conversations: laneId === old.lunaSelections[id] ? [prior] : [] }));
  await service.control(old.id, 'stop');
  assert.equal(tables.luna_archives.get(template.definition.id)[id][0].id, prior.id);
  const updated = structuredClone(template.definition);
  updated.lunas = [];
  await service.saveTeam(updated, template.layout, 0);
  agents.delete(leader.id);
  const nextRoot = { ...leader, id: 'new-root', status: 'idle' };
  agents.set(nextRoot.id, nextRoot);
  const latest = await service.start(template.definition.id, nextRoot.id);
  assert.equal(latest.lunas.length, 0);
  assert.deepEqual(service.getRun(latest.id).lunaArchive[id], [prior]);
  await assert.rejects(service.selectLunaConversation(latest.id, id, prior.id),
    error => error.code === 'LUNA_NOT_FOUND');
});
