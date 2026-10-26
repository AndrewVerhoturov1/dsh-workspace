import { Service } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { scopeParentOf } from '@deepseek-ai/dsh-scope';
import { POSTMAN_LEADER_TOOL_ALLOWLIST, SECRETARY_TOOLS, DELEGATION_TOOLS, POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_NODES_TOOL_NAMES } from '../../dsh-postman-harness/lib/postman-bridge-core.js';
import { NODES_PRESET, SLOTS, createTemplate, slotFor, validateTeam, allowedMessage, allowedAssignment, effectiveTools } from './domain.js';

const valueSchema = z.record(z.string(), z.unknown());
export const nodesDomain = defineDomain({
  name: 'nodes_agent_by_andrew', version: 0,
  tables: {
    definitions: domainTable(valueSchema), layouts: domainTable(valueSchema),
    runs: domainTable(valueSchema), messages: domainTable(valueSchema),
    tasks: domainTable(valueSchema), attempts: domainTable(valueSchema)
  }
});
export const RPC_CHANNEL = '/nodes-agent-by-andrew';
const copy = value => structuredClone(value);
const err = (code, description) => Object.assign(new Error(description), { code });
const isNewLeader = agent => {
  if (!agent || agent.session?.header?.origin === 'subagent' ||
      (agent.session?.header?.delegationDepth ?? 0) !== 0) return false;
  const preset = agent.ctx?.get?.('agentPresets')?.composedPreset?.(agent.ctx) ??
    agent.session?.header?.agentPreset;
  return preset === NODES_PRESET;
};
const isValidId = text => typeof text === 'string' && text.length > 0 && text.length < 150;
const toolResult = () => ({
  schema: { type: 'object', additionalProperties: true,
    properties: { status: { type: 'string', required: true } } },
  render: (_args, val) => [{ type: 'text', text: JSON.stringify(val) }]
});

export class NodesAgentService extends Service {
  static inject = ['storageDomain', 'agents', 'tools', 'llm', 'subagents', 'systemPrompt', 'skills', 'postmanNativeNodes'];
  static Config = z.object({});
  constructor(ctx, config) {
    super(ctx, 'nodesAgent');
    this.tables = null;
    this.chains = new Map();
    this.initializing = new Map();
    this.config = config;
  }
  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(nodesDomain);
    this.ctx.effect(() => () => domain.close(), 'nodes_agent_by_andrew.close()');
    this.tables = Object.fromEntries(Object.keys(nodesDomain.tables).map(key => [key, domain.table(key)]));
    if (![...this.tables.definitions.entries()].length) {
      const template = createTemplate();
      await this.tables.definitions.put(template.definition.id, template.definition);
      await this.tables.layouts.put(template.definition.id, template.layout);
    }
    this.ctx.inject(['connection'], client => {
      client.connection.rpc.handle(RPC_CHANNEL, async (endpoint, input, signal) => {
        try {
          if (signal?.aborted) throw signal.reason ?? err('ABORTED', 'Request cancelled');
          return { ok: true, value: await this.dispatch(endpoint, input || {}, signal) };
        } catch (error) {
          return { ok: false, error: {
            code: error?.code || 'NODES_AGENT_ERROR',
            message: String(error?.message ?? error).slice(0, 1000)
          } };
        }
      }, { authority: 'loopback' });
    });
    const tool = (name, description, parameters, handler) => {
      this.ctx.tools.register(defineTool({
        name, description, parameters, output: toolResult(),
        async execute(args, exec) {
          try {
            return await handler(args, exec);
          } catch (e) {
            return { status: e?.code ?? 'NODES_AGENT_REJECTED', message: String(e?.message ?? e) };
          }
        }
      }));
    };
    tool('nodes_team_message', 'Send an authorized ordinary message to a node of your active Postman TeamRun. This is not a Task.',
      { toNodeId: { type: 'string', required: true }, text: { type: 'string', required: true } },
      (a, e) => this.sendMessage(e.agent, a.toNodeId, a.text, e.signal));
    tool('nodes_team_assign_task', 'Assign a formal Task only to your direct subordinate in the active Postman TeamRun.',
      { toNodeId: { type: 'string', required: true }, goal: { type: 'string', required: true } },
      (a, e) => this.assignTask(e.agent, a.toNodeId, a.goal, e.signal));
    tool('nodes_team_complete_task', 'Complete one TaskAttempt belonging to your active Session.',
      { taskId: { type: 'string', required: true }, result: { type: 'string', required: true } },
      (a, e) => this.completeTask(e.agent, a.taskId, a.result, e.signal));
    this.ctx.systemPrompt.section({ name: 'nodes-team', order: 125, text: ({ scope } = {}) => {
      const current = this.bindingOf(scope);
      if (!current) return '';
      const { run, node } = current;
      return 'NodesAgent TeamRun ' + run.id + ' [' + run.status + ']\n' +
        'Your node: ' + node.id + ', name: ' + node.displayName + ', role: ' + node.role + '\n' + node.systemPrompt +
        '\nTeam (native ownership is fixed; authority/communication are separate): ' + JSON.stringify({
          nodes: run.definition.agents.map(a => ({ id: a.id, name: a.displayName, role: a.role, slot: a.slot })),
          authority: run.definition.authorityEdges, communication: run.definition.communicationEdges
        });
    }});
    this.ctx.on('agent/request', async ({ agent }, next) => {
      const config = await next(), current = this.bindingOf(agent);
      if (!current) return config;
      const { reasoningEffort, ...rest } = config;
      return { ...rest, provider: current.node.model.provider, model: current.node.model.model,
        ...(current.node.model.reasoningEffort ? { reasoningEffort: current.node.model.reasoningEffort } : {}) };
    });
    this.ctx.subagents.registerContinuableSetup(childCtx => {
      const current = this.configForSession(childCtx.agent.id);
      return current ? this.installSkills(childCtx, current.node, current.run) : undefined;
    });
    this.ctx.on('agent/created', ({ agent }) => {
      const current = this.bindingOf(agent);
      if (current?.node.slot === 'entry') this.installSkills(agent.ctx, current.node, current.run);
    });
    this.ctx.on('postman/subagent-settlement-defer', (parent, child) => {
      const current = this.configForSession(child.id);
      if (current && current.binding.parentSessionId === parent.id &&
          !child.session.events.some(e => e.type === 'step/start')) return true;
    });
    this.ctx.on('agent/pre-step', async (payload, next) => {
      const current = this.bindingOf(payload.agent);
      if (current?.binding.state !== 'STARTING') return next();
      // Initial native admissions reserve all Sessions, not a model turn. Hold Sol
      // live until its children exist, then consume only this bootstrap message.
      await this.initializing.get(current.run.id)?.promise;
      return { kind: 'enter', messages: [] };
    });
    // Only exact run-bound Sessions enter these guards; legacy presets are untouched.
    this.ctx.tools.guard(exec => {
      const current = this.bindingOf(exec.agent);
      if (!current) return exec.name.startsWith('nodes_team_') ? 'NODES_SESSION_REQUIRED' : undefined;
      const { run, node, nodeId } = current;
      if (run.status !== 'RUNNING' && !['report', 'notify_parent', 'nodes_team_complete_task'].includes(exec.name))
        return 'NODES_RUN_NOT_RUNNING';
      const policy = effectiveTools(node), required = this.nativePolicy(node.slot).requiredTools;
      if (policy.deny.includes(exec.name)) return 'NODES_CAPABILITY_DENIED';
      if (policy.hasAllowlist && !policy.allow.includes(exec.name) && !required.includes(exec.name))
        return 'NODES_CAPABILITY_NOT_GRANTED';
      if (['report', 'notify_parent'].includes(exec.name)) {
        const target = Object.keys(run.bindings).find(id => run.bindings[id].sessionId === exec.agent.session.header.parentSession);
        if (!target || !allowedMessage(run.definition, nodeId, target)) return 'COMMUNICATION_DENIED';
      }
      if (exec.name === 'postman_worker_fresh') return 'NODES_SESSION_FIXED_FOR_RUN';
    });
  }
  table(name) {
    if (!this.tables) throw err('NOT_READY', 'NodesAgent storage is not initialized');
    return this.tables[name];
  }
  async locked(key, task) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const settled = current.catch(() => {});
    this.chains.set(key, settled);
    try { return await current; } finally { if (this.chains.get(key) === settled) this.chains.delete(key); }
  }
  async catalog(sessionId) {
    const scope = sessionId && this.ctx.agents.get(sessionId);
    const models = await Promise.all(this.ctx.llm.listProviders().map(async provider => {
      try {
        const entries = await this.ctx.llm.listModels(provider.id);
        return { provider: provider.id, name: provider.name, models: await Promise.all(entries.map(async m => {
          const info = await this.ctx.llm.resolveModelInfo(provider.id, m.id);
          return { id: m.id, label: m.name || m.id, reasoningEfforts: info?.reasoning?.efforts?.map(e => e.id) || [],
            defaultReasoning: info?.reasoning?.defaultEffort };
        })) };
      } catch { return { provider: provider.id, name: provider.name, models: [] }; }
    }));
    const tools = this.ctx.tools.schemas(scope ? scopeParentOf(scope) : undefined);
    return {
      models, tools: tools.map(t => ({ name: t.name, description: t.description || '' })),
      skills: { supported: true, items: (await this.ctx.skills.list(scope ? { scope:scopeParentOf(scope), cwd:scope.session.header.cwd } : {})).filter(s => s.invocation?.modelInvocable).map(s => ({ name: s.name, description: s.description })) },
      nativeSlots: SLOTS.map(s => ({ ...s, ...this.nativePolicy(s.id, tools.map(t => t.name)) })), nativeRoles: SLOTS.map(s => s.id),
      reasoning: 'Applied to native LlmCallConfig.reasoningEffort for every run-bound Session'
    };
  }
  nativePolicy(slot, tools = this.ctx.tools.schemas().map(t => t.name)) {
    const requiredTools = slot === 'entry' ? ['ptc_execute', ...POSTMAN_NODES_TOOL_NAMES] :
      slot === 'sol' ? ['ptc_execute', 'report', 'notify_parent', ...POSTMAN_NODES_TOOL_NAMES] :
      ['report', 'notify_parent', ...POSTMAN_NODES_TOOL_NAMES];
    const allowed = slot === 'entry' ? [...POSTMAN_LEADER_TOOL_ALLOWLIST, 'ptc_execute', ...POSTMAN_NODES_TOOL_NAMES] :
      slot === 'secretary' ? [...SECRETARY_TOOLS, ...POSTMAN_NODES_TOOL_NAMES] : null;
    const deniedTools = allowed ? tools.filter(n => !allowed.includes(n)) : tools.filter(n =>
      DELEGATION_TOOLS.includes(n) || ['ask_user_question','exit_plan_mode'].includes(n) ||
      slot !== 'sol' && n === 'list_agents' || POSTMAN_LEADER_ONLY_TOOL_NAMES.includes(n) &&
      !(slot === 'sol' && ['postman_worker', 'postman_worker_interrupt', 'postman_worker_list', 'postman_worker_stop', 'postman_worker_compact', 'postman_worker_fresh'].includes(n)) ||
      slot !== 'sol' && ['ptc_execute', 'postman_worker', 'postman_worker_interrupt', 'postman_worker_list', 'postman_worker_stop', 'postman_worker_compact', 'postman_worker_fresh'].includes(n));
    return { requiredTools, deniedTools: [...new Set([...deniedTools, 'postman_worker_fresh'])],
      restriction: 'Fixed native ownership/quotas: Leader 2 Workers + Secretary + Sol; Sol 2 Workers. Grants only narrow existing rights. DevSpace/Luna is a transport, not a model node.' };
  }
  installSkills(scope, node, run) {
    const grants = node.capabilities?.grants?.filter(g => g.kind === 'skill') || [];
    const allow = grants.filter(g => g.mode === 'allow').map(g => g.id);
    const deny = new Set(grants.filter(g => g.mode === 'deny').map(g => g.id));
    const disposers = [];
    for (const skill of run.skillCatalog || []) {
      if (skill.name.startsWith('postman-')) continue;
      if (deny.has(skill.name) || allow.length && !allow.includes(skill.name))
        disposers.push(scope.skills.register({ name: skill.name, description: 'Disabled for this TeamRun node',
          content: '', source: 'nodes-agent-by-andrew', invocation: { modelInvocable: false, userInvocable: false } }));
    }
    return () => disposers.forEach(dispose => dispose());
  }
  listTeams() {
    return [...this.table('definitions').entries()].map(([, v]) => ({
      id: v.id, revision: v.revision, name: v.name
    }));
  }
  getTeam(id) {
    const def = this.table('definitions').get(id);
    if (!def) throw err('TEAM_NOT_FOUND', 'Team not found');
    return { definition: copy(def), layout: copy(this.table('layouts').get(id)) };
  }
  async saveTeam(definition, layout, expectedRevision, sessionId) {
    if (!definition || !layout || layout.teamId !== definition.id || !isValidId(definition.id)) throw err('INVALID_TEAM', 'Team and layout identifiers differ');
    if (JSON.stringify(definition).length > 128000 || JSON.stringify(layout).length > 64000) throw err('TOO_LARGE', 'Team exceeds size limit');
    const errors = validateTeam(definition, await this.catalog(sessionId));
    if (errors.length) throw err('INVALID_TEAM', errors.map(e => e.message).join('; '));
    return this.locked('def:' + definition.id, async () => {
      const table = this.table('definitions');
      const current = table.get(definition.id);
      if (current && (current.revision !== expectedRevision || expectedRevision !== definition.revision))
        throw err('REVISION_CONFLICT', 'Another editor has saved a newer TeamDefinition');
      if (!current && expectedRevision !== 0) throw err('REVISION_CONFLICT', 'New TeamDefinition must start at revision 0');
      const updated = { ...copy(definition), revision: (current?.revision ?? 0) + 1 };
      await table.put(definition.id, updated);
      await this.table('layouts').put(definition.id, copy(layout));
      return { definition: copy(updated), layout: copy(layout) };
    });
  }
  async saveLayout(layout) {
    if (!layout || !isValidId(layout.teamId) || !this.table('definitions').get(layout.teamId))
      throw err('TEAM_NOT_FOUND', 'Cannot save orphan layout');
    await this.table('layouts').put(layout.teamId, copy(layout));
    return layout;
  }
  async newTeam() {
    const team = createTemplate();
    await this.table('definitions').put(team.definition.id, team.definition);
    await this.table('layouts').put(team.definition.id, team.layout);
    return team;
  }
  async saveAs(definition, layout, sessionId) {
    const template = copy(definition), id = randomUUID();
    template.id = id; template.revision = 0;
    const coordinates = copy(layout); coordinates.teamId = id;
    return this.saveTeam(template, coordinates, 0, sessionId);
  }
  rootAgent(rootId) {
    const agent = this.ctx.agents.get(rootId);
    if (!agent || !isNewLeader(agent) || this.ctx.agents.get(agent.id) !== agent)
      throw err('ENTRY_SESSION_REQUIRED', 'Select an active top-level DSH Chat with preset Postman Leader PTC - Nodes');
    return agent;
  }
  workerNodeFromBinding(binding) {
    const run = binding?.nodesRunId && this.table('runs').get(binding.nodesRunId);
    return run?.definition?.agents?.find(a => a.id === binding.nodesNodeId) ?? null;
  }
  async start(teamId, rootId, signal) {
    this.rootAgent(rootId);
    const { definition } = this.getTeam(teamId);
    const errors = validateTeam(definition, await this.catalog(rootId));
    if (errors.length) throw err('INVALID_TEAM', errors.map(e => e.message).join('; '));
    if ([...this.table('runs').entries()].some(([, r]) => r.rootSessionId === rootId))
      throw err('SESSION_ALREADY_BOUND', 'Use a fresh DSH Chat for an independent TeamRun');
    const entry = definition.agents.find(a => a.id === definition.entryAgentId);
    const parent = this.rootAgent(rootId);
    if (parent.status !== 'idle') throw err('ENTRY_BUSY', 'Start from an idle DSH Chat');
    const skillCatalog = (await this.ctx.skills.list({ scope:parent, cwd:parent.session.header.cwd })).map(s => ({ name: s.name }));
    const id = randomUUID();
    const run = {
      id, teamDefinitionId: definition.id, teamDefinitionRevision: definition.revision,
      rootSessionId: rootId, entryNodeId: entry.id, status: 'RUNNING',
      definition: copy(definition), skillCatalog, startedAt: Date.now(),
      bindings: { [entry.id]: { sessionId: rootId, parentSessionId: null, status: 'RUNNING' } }
    };
    await this.table('runs').put(id, run);
    const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
    if (!native?.start) {
      await this.table('runs').put(id, { ...run, status: 'FAILED', error: 'Postman native owner unavailable' });
      throw err('NATIVE_OWNER_UNAVAILABLE', 'Postman native owner must be installed before TeamRun start');
    }
    this.installSkills(parent.ctx, entry, run);
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    this.initializing.set(id, { promise, release });
    try {
      const acceptance = await native.start(parent, id, signal);
      if (acceptance?.status !== 'NODES_NATIVE_READY')
        throw err(acceptance?.status || 'NATIVE_START_FAILED', acceptance?.diagnostic || 'Native Postman TeamRun start failed');
      const current = this.table('runs').get(id);
      for (const binding of Object.values(current.bindings)) binding.state = 'READY';
      await this.table('runs').put(id, current);
      return this.getRun(id);
    } catch (error) {
      const current = this.table('runs').get(id);
      await this.table('runs').put(id, { ...current, status: 'FAILED', error: String(error?.message ?? error) });
      throw error;
    } finally {
      release(); this.initializing.delete(id);
      await Promise.all(Object.values(this.table('runs').get(id).bindings).map(b => this.ctx.agents.get(b.sessionId)?.whenIdle()));
    }
  }
  configForSession(sessionId) {
    for (const [, run] of this.table('runs').entries()) {
      const nodeId = Object.keys(run.bindings).find(id => run.bindings[id].sessionId === sessionId);
      if (nodeId) return { run, node: run.definition.agents.find(a => a.id === nodeId), nodeId, binding: run.bindings[nodeId] };
    }
    return null;
  }
  runFor(rootId) {
    const runs = [...this.table('runs').entries()].map(([, r]) => r)
      .filter(r => r.rootSessionId === rootId);
    return runs.length ? this.getRun(runs.at(-1).id) : null;
  }
  getRun(id) {
    const run = this.table('runs').get(id);
    if (!run) return null;
    const view = copy(run);
    if (view.status === 'RUNNING') for (const entry of Object.values(view.bindings)) {
      const agent = this.ctx.agents.get(entry.sessionId);
      if (agent) entry.status = agent.status === 'idle' ? 'IDLE' : agent.status === 'error' ? 'ERROR' : 'RUNNING';
    }
    return view;
  }
  runForAgent(agent) {
    if (!agent || this.ctx.agents.get(agent.id) !== agent) return null;
    const current = this.configForSession(agent.id);
    if (!current) return null;
    const binding = current.binding;
    if (binding.parentSessionId && (agent.session.header.origin !== 'subagent' ||
      agent.session.header.parentSession !== binding.parentSessionId)) return null;
    if (!binding.parentSessionId && !isNewLeader(agent)) return null;
    return current.run;
  }
  bindingOf(agent) {
    const run = this.runForAgent(agent);
    if (!run) return null;
    const nodeId = Object.keys(run.bindings).find(id => run.bindings[id]?.sessionId === agent.id);
    return nodeId ? { run, node: run.definition.agents.find(a => a.id === nodeId), nodeId, binding: run.bindings[nodeId] } : null;
  }
  nodeForNativeWorker(parent, workerType, nativeBindings, bootstrap = false) {
    const run = this.runForAgent(parent);
    if (!run || run.status !== 'RUNNING') return { status: 'NODES_RUN_NOT_RUNNING' };
    const ownerId = parent.id === run.rootSessionId ? run.entryNodeId
      : Object.keys(run.bindings).find(id => run.bindings[id]?.sessionId === parent.id);
    const owner = run.definition.agents.find(a => a.id === ownerId);
    if (!owner || !(owner.slot === 'entry' || owner.slot === 'sol'))
      return { status: 'NODES_OWNER_REJECTED' };
    const all = run.definition.agents.filter(a => {
      const slot = slotFor(a.slot);
      return slot?.workerType === workerType && slot.owner === owner.slot;
    });
    const already = new Set(Object.values(nativeBindings ?? {}).filter(b => b?.nodesRunId === run.id).map(b => b.nodesNodeId));
    const selected = all.find(a => !already.has(a.id));
    if (!selected) return { status: 'NODES_NO_SLOT_AVAILABLE' };
    if (!bootstrap && !allowedAssignment(run.definition, ownerId, selected.id))
      return { status: 'NODES_ASSIGNMENT_DENIED' };
    return { runId: run.id, nodeId: selected.id, node: copy(selected) };
  }
  async nativeChildAccepted(parent, childId, nodeId, runId) {
    const run = this.table('runs').get(runId);
    if (!run || run.status !== 'RUNNING' || !run.definition.agents.some(a => a.id === nodeId))
      throw err('NODES_BINDING_STALE', 'Native owner binding is stale');
    await this.locked('run:' + run.id, async () => {
      const current = this.table('runs').get(run.id);
      if (current.bindings[nodeId] && current.bindings[nodeId].sessionId !== childId)
        throw err('NODES_BINDING_EXISTS', 'Node already bound');
      current.bindings[nodeId] = { sessionId: childId, parentSessionId: parent.id, status: 'IDLE', state: 'STARTING' };
      await this.table('runs').put(run.id, current);
    });
  }
  nativeDeliveryAllowed(parent, childId, binding) {
    const run = this.runForAgent(parent);
    if (!run) return true;
    if (run.status !== 'RUNNING' || !binding || binding.nodesRunId !== run.id) return false;
    const fromNode = Object.keys(run.bindings).find(id => run.bindings[id]?.sessionId === parent.id);
    return Boolean(fromNode && allowedAssignment(run.definition, fromNode, binding.nodesNodeId) &&
      run.bindings[binding.nodesNodeId]?.sessionId === childId);
  }
  async control(runId, action) {
    const run = this.table('runs').get(runId);
    if (!run) throw err('RUN_NOT_FOUND', 'Run missing');
    const states = { pause: ['RUNNING', 'PAUSED'], resume: ['PAUSED', 'RUNNING'],
      stop: ['RUNNING', 'STOPPED'] };
    const valid = states[action];
    if (!valid) throw err('INVALID_ACTION', 'Invalid run control');
    if (run.status !== valid[0] && !(action === 'stop' && run.status === 'PAUSED'))
      throw err('INVALID_RUN_STATE', 'Invalid TeamRun transition');
    await this.locked('run:' + runId, async () => {
      const active = this.table('runs').get(runId);
      if (active.status !== run.status) throw err('RUN_CHANGED', 'TeamRun changed');
      active.status = valid[1];
      for (const binding of Object.values(active.bindings)) binding.status = action === 'stop' ? 'STOPPED' :
        action === 'pause' ? 'PAUSED' : 'IDLE';
      await this.table('runs').put(runId, active);
    });
    return this.getRun(runId);
  }
  async sendMessage(sender, targetNode, text, signal = new AbortController().signal) {
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw err('INVALID_TEXT', 'Text must be 1..16000 characters');
    const current = this.bindingOf(sender);
    if (!current || current.run.status !== 'RUNNING') throw err('SENDER_REJECTED', 'Sender has no running Session binding');
    const { run, nodeId } = current, binding = run.bindings[targetNode];
    if (!binding || !allowedMessage(run.definition, nodeId, targetNode)) throw err('COMMUNICATION_DENIED', 'Directed message is not authorized');
    const message = { id: randomUUID(), runId: run.id, from: nodeId, to: targetNode,
      text, createdAt: Date.now(), state: 'queued' };
    await this.table('messages').put(message.id, message);
    try {
      if (signal?.aborted) throw err('ABORTED', 'Delivery aborted');
      // The native Postman owner created and still owns this continuable child;
      // there is deliberately no alternative child creation path here.
      const payload = '[NodesAgent message ' + message.id + ' from ' + nodeId + ']\n' + text;
      if (binding.sessionId === run.rootSessionId) {
        const root = this.rootAgent(run.rootSessionId);
        if (typeof root.steer !== 'function') throw err('ENTRY_UNAVAILABLE', 'DSH Entry Agent cannot receive messages');
        root.steer(createUserMessage({ content: [{ type: 'text', text: payload }],
          source: { kind: 'coordinator', form: 'relay', senderSessionId: sender.id } }));
      } else {
        const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
        if (!native?.deliverMessage) throw err('NATIVE_OWNER_UNAVAILABLE', 'Native Postman owner is unavailable');
        await native.deliverMessage(sender, binding.sessionId, binding.parentSessionId, run.id, payload, signal);
      }
      message.state = 'delivered';
    } catch (error) {
      message.state = 'failed';
      await this.table('messages').put(message.id, message);
      throw error;
    }
    await this.table('messages').put(message.id, message);
    return { status: 'NODES_MESSAGE_DELIVERED', id: message.id };
  }
  async assignTask(sender, toNodeId, goal, signal) {
    const current = this.bindingOf(sender);
    if (!current || current.run.status !== 'RUNNING') throw err('ASSIGNMENT_DENIED', 'Sender has no active TeamRun');
    if (!allowedAssignment(current.run.definition, current.nodeId, toNodeId)) throw err('AUTHORITY_DENIED', 'Only a direct manager may assign work');
    if (!current.run.bindings[toNodeId]) throw err('WORKER_NOT_STARTED', 'Native Postman must create the worker Session first');
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 16000) throw err('INVALID_GOAL', 'Goal is invalid');
    const task = { id: randomUUID(), runId: current.run.id, creator: current.nodeId,
      assignee: toNodeId, goal, status: 'working', result: null, createdAt: Date.now() };
    const attempt = { id: randomUUID(), taskId: task.id, runId: task.runId,
      assignee: toNodeId, status: 'working', attempt: 1 };
    await this.table('tasks').put(task.id, task);
    await this.table('attempts').put(attempt.id, attempt);
    try {
      await this.sendMessage(sender, toNodeId,
        '[Task ' + task.id + ', Attempt ' + attempt.id + '] ' + goal, signal);
    } catch (e) {
      task.status = 'failed'; attempt.status = 'failed';
      await this.table('tasks').put(task.id, task);
      await this.table('attempts').put(attempt.id, attempt);
      throw e;
    }
    return { status: 'NODES_TASK_ASSIGNED', taskId: task.id, attemptId: attempt.id };
  }
  async completeTask(sender, taskId, result, signal) {
    const current = this.bindingOf(sender), task = this.table('tasks').get(taskId);
    if (!current || !task || task.runId !== current.run.id || task.assignee !== current.nodeId ||
      task.status !== 'working') throw err('TASK_IDENTITY_REJECTED', 'Wrong Session, Task or state');
    const attempt = [...this.table('attempts').entries()].find(([, a]) => a.taskId === taskId)?.[1];
    if (!attempt || attempt.assignee !== current.nodeId || attempt.status !== 'working')
      throw err('ATTEMPT_REJECTED', 'Attempt is not active');
    if (typeof result !== 'string' || !result.trim() || result.length > 16000)
      throw err('INVALID_RESULT', 'Result is invalid');
    const done = { ...task, status: 'completed', result },
      finishedAttempt = { ...attempt, status: 'completed', result, completedAt: Date.now() };
    await this.table('tasks').put(taskId, done);
    await this.table('attempts').put(attempt.id, finishedAttempt);
    // The result remains durable even if manager delivery needs explicit repair.
    try { await this.sendMessage(sender, task.creator, '[Task result ' + taskId + '] ' + result, signal); }
    catch { return { status: 'NODES_TASK_COMPLETED_NOTIFICATION_FAILED', taskId }; }
    return { status: 'NODES_TASK_COMPLETED', taskId };
  }
  async dispatch(endpoint, input, signal) {
    switch (endpoint) {
      case 'catalog': return this.catalog(input.sessionId);
      case 'teams/list': return this.listTeams();
      case 'teams/get': return this.getTeam(input.id);
      case 'teams/new': return this.newTeam();
      case 'teams/save': return this.saveTeam(input.definition, input.layout, input.expectedRevision, input.sessionId);
      case 'teams/save-as': return this.saveAs(input.definition, input.layout, input.sessionId);
      case 'layouts/save': return this.saveLayout(input.layout);
      case 'teams/validate': return validateTeam(input.definition, await this.catalog(input.sessionId));
      case 'runs/start': return this.start(input.teamId, input.sessionId, signal);
      case 'runs/get': return this.getRun(input.id);
      case 'runs/for-session': return this.runFor(input.sessionId);
      case 'runs/control': return this.control(input.id, input.action);
      case 'runs/activity': return {
        messages: [...this.table('messages').entries()].map(([, m]) => m).filter(m => m.runId === input.id).slice(-50),
        tasks: [...this.table('tasks').entries()].map(([, t]) => t).filter(t => t.runId === input.id).slice(-50)
      };
      default: throw err('UNKNOWN_ENDPOINT', 'Unknown NodesAgent action');
    }
  }
}
export const name = 'dsh-nodes-agent-by-andrew';
export default NodesAgentService;
