import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const modules = new Map([
  ['@deepseek-ai/dsh-scope', 'export const scopeParentOf = x => x;'],
  ['@deepseek-ai/dsh-tools', 'export const defineTool = x => x;'],
  ['@deepseek-ai/dsh-agent', 'export class Inbox {}'],
  ['@deepseek-ai/dsh-subagent', 'export const applyChildComposition = x => x; export const foldSubagentDescriptor = x => x;']
]);
registerHooks({ resolve(specifier, context, nextResolve) {
  return modules.has(specifier)
    ? { url: 'data:text/javascript,' + encodeURIComponent(modules.get(specifier)), shortCircuit: true }
    : nextResolve(specifier, context);
}});
const core = await import('../../dsh-postman-harness/lib/postman-bridge-core.js');
const worker = await import('../../dsh-postman-harness/lib/postman-worker.js');

const asParent = preset => ({ id: 'parent', session: {
  header: { agentPreset: preset, delegationDepth: 0 }
} });
test('new exact top-level Nodes ID has Supervisor/PTC permissions; old identities retain unchanged tool filters', () => {
  const a = asParent('postman-leader');
  const b = asParent('postman-leader-ptc');
  const c = asParent('postman-leader-ptc-nodes');
  assert.equal(core.isTopLevelPostmanSupervisor(a), true);
  assert.equal(core.isTopLevelPostmanSupervisor(b), true);
  assert.equal(core.isTopLevelPostmanSupervisor(c), true);
  assert.equal(core.isTopLevelPostmanNodesLeader(c), true);
  assert.equal(core.isTopLevelPostmanNodesLeader(a), false);
  assert.equal(core.isTopLevelPostmanNodesLeader(b), false);
  const oldAllow = [...core.POSTMAN_LEADER_TOOL_ALLOWLIST, core.POSTMAN_PTC_TOOL_NAME];
  assert.deepEqual(core.postmanBridgeRestrictionForAgent(a), { allow: oldAllow });
  assert.deepEqual(core.postmanBridgeRestrictionForAgent(b), { allow: oldAllow });
  const newAllow = core.postmanBridgeRestrictionForAgent(c).allow;
  assert.deepEqual(newAllow, [...core.POSTMAN_LEADER_TOOL_ALLOWLIST, ...core.POSTMAN_NODES_TOOL_NAMES,
    ...core.POSTMAN_NODES_LEADER_TOOL_NAMES, 'ptc_execute']);
  assert.ok(!core.postmanBridgeRestrictionForAgent(b).allow.includes('nodes_team_luna_send'));
  assert.equal(core.postmanPtcDirectCallGuard(
    { agent: c, name: 'nodes_team_luna_send' }, () => c
  ), 'POSTMAN_PTC_DIRECT_CALL_REJECTED: use ptc_execute');
  assert.equal(core.postmanPtcDirectCallGuard(
    { agent: c, name: 'nodes_team_assign_task' }, () => c
  ), 'POSTMAN_PTC_DIRECT_CALL_REJECTED: use ptc_execute');
  assert.equal(core.postmanPtcDirectCallGuard(
    { agent: c, name: 'nodes_team_assign_task', parent: {} }, () => c
  ), undefined);
  assert.equal(core.postmanPtcDirectCallGuard(
    { agent: a, name: 'nodes_team_assign_task' }, () => a
  ), undefined);
  const forged = { ...c, session: { header: {
    agentPreset: 'postman-leader-ptc-nodes', origin: 'subagent', delegationDepth: 1
  } } };
  assert.equal(core.isTopLevelPostmanSupervisor(forged), false);
});

test('exact Nodes Sol nodes tools require PTC while ordinary workers keep direct delivery', () => {
  const leader=asParent('postman-leader-ptc-nodes'), sol={id:'nodes-sol',session:{header:{origin:'subagent',parentSession:leader.id,delegationDepth:1}}};
  const lookup=id=>id===leader.id?leader:id===sol.id?sol:null;
  assert.match(core.postmanPtcDirectCallGuard({agent:sol,name:'nodes_team_assign_task'},lookup,a=>a===sol),/PTC_DIRECT_CALL_REJECTED/);
  assert.equal(core.postmanPtcDirectCallGuard({agent:sol,name:'nodes_team_assign_task',parent:{}},lookup,a=>a===sol),undefined);
  assert.equal(core.postmanPtcDirectCallGuard({agent:sol,name:'nodes_team_message'},lookup,()=>false),undefined);
  assert.ok(!core.postmanBridgeRestrictionForAgent(sol,()=>true,()=> 'sol',()=>true).allow?.includes('nodes_team_luna_send'));
});

test('legacy Secretary restriction unchanged, Nodes Secretary gains exact message/task tools only through trusted parent predicate', () => {
  const role = () => 'secretary';
  const child = { id: 'secretary', session: { header: { origin: 'subagent', parentSession: 'parent', delegationDepth: 1 } } };
  assert.deepEqual(core.postmanBridgeRestrictionForAgent(child, () => false, role, () => false),
    { allow: [...core.SECRETARY_TOOLS] });
  assert.deepEqual(core.postmanBridgeRestrictionForAgent(child, () => false, role, () => true),
    { allow: [...core.SECRETARY_TOOLS, ...core.POSTMAN_NODES_TOOL_NAMES] });
});

test('native continuable child retains Postman role, node route/persona and deny-wins tool policy', () => {
  const parent = asParent('postman-leader-ptc-nodes');
  const signal = new AbortController().signal;
  const oldReq = worker.buildPostmanWorkerStartRequest(parent, 'Do task', signal, ['postman_bridge'], 'Worker 1', 'luna');
  assert.equal(oldReq.request.agentOptions.model, worker.FAST_WORKER_MODEL);
  assert.equal(oldReq.request.agentOptions.reasoningEffort, worker.FAST_WORKER_REASONING);
  assert.deepEqual(oldReq.request.toolFilter, { deny: ['postman_bridge'] });
  const node = {
    model: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
    systemPrompt: 'Perform a bounded verification',
    capabilities: { grants: [
      { kind: 'tool', id: 'read', mode: 'allow' },
      { kind: 'tool', id: 'write', mode: 'allow' },
      { kind: 'tool', id: 'write', mode: 'deny' }
    ] }
  };
  const req = worker.buildPostmanWorkerStartRequest(parent, 'Do task', signal, ['postman_bridge'], 'Worker 1', 'luna', node);
  assert.equal(req.request.agentOptions.provider, 'codex');
  assert.equal(req.request.agentOptions.model, 'gpt-6.1-sol');
  assert.equal(req.request.agentOptions.reasoningEffort, 'high');
  assert.match(req.request.persona, /Postman Worker/);
  assert.match(req.request.persona, /bounded verification/);
  assert.equal(req.request.maxDepth, 1);
  assert.deepEqual(req.request.toolFilter.deny, ['postman_bridge', 'write']);
  assert.deepEqual(req.request.toolFilter.allow, ['read', 'report', 'notify_parent', ...core.POSTMAN_NODES_TOOL_NAMES, 'postman_app']);
  const withoutReasoning = structuredClone(node);
  withoutReasoning.model.reasoningEffort = '';
  assert.equal(Object.hasOwn(worker.buildPostmanWorkerStartRequest(parent, 'task', signal, ['postman_bridge'], 'Worker 1', 'luna', withoutReasoning).request.agentOptions, 'reasoningEffort'), false);
});

test('strict native binding fields are optional; canonical existing preset bytes remain untouched', () => {
  const repoRoot = new URL('../../../', import.meta.url);
  const registry = readFileSync(new URL('plugins/dsh-postman-harness/lib/postman-task-registry.js', repoRoot), 'utf8');
  assert.match(registry, /nodesRunId: z\.string\(\)\.optional\(\)/);
  assert.match(registry, /nodesNodeId: z\.string\(\)\.optional\(\)/);
  const a = readFileSync(new URL('.agent-presets/postman-leader/agent.cordis.yml', repoRoot));
  const b = readFileSync(new URL('.agent-presets/postman-leader-ptc/agent.cordis.yml', repoRoot));
  assert.deepEqual(a, b);
});
