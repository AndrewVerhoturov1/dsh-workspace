import { Service } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { scopeParentOf } from '@deepseek-ai/dsh-scope';
import { POSTMAN_LEADER_TOOL_ALLOWLIST, SECRETARY_TOOLS, DELEGATION_TOOLS, POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_NODES_TOOL_NAMES, POSTMAN_NODES_LEADER_TOOL_NAMES } from '../../dsh-postman-harness/lib/postman-bridge-core.js';
import { NODES_PRESET, SLOTS, LUNA_ROLE, LUNA_SLOT, createTemplate, normalizeTeam, slotFor, validateTeam, allowedMessage, allowedAssignment, allowedChat, effectiveTools } from './domain.js';

const valueSchema = z.record(z.string(), z.unknown());
export const nodesDomain = defineDomain({
  name: 'nodes_agent_by_andrew', version: 0,
  tables: {
    definitions: domainTable(valueSchema), layouts: domainTable(valueSchema),
    runs: domainTable(valueSchema), messages: domainTable(valueSchema),
    tasks: domainTable(valueSchema), attempts: domainTable(valueSchema),
    luna_archives: domainTable(valueSchema)
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
    tool('nodes_team_activate', 'Address a direct native child by exact nodeId; wake an idle Session without assigning a Task or calling the model.',
      { nodeId: { type: 'string', required: true } },
      (a, e) => this.nodeAction(e.agent, a.nodeId, 'activate', e.signal));
    tool('nodes_team_deactivate', 'Address a direct native child by nodeId: finish current work then release, or interrupt now; Sol includes its entire branch.',
      { nodeId: { type: 'string', required: true }, mode: { type: 'string', enum: ['finish', 'interrupt'], required: true } },
      (a, e) => this.nodeAction(e.agent, a.nodeId, a.mode, e.signal));
    tool('nodes_team_luna_select', 'Entry only: select a new chat or exact verified archived conversation for one Luna node. No Send.',
      { lunaId: { type: 'string', required: true }, archiveId: { type: 'string', description: 'Exact archive entry ID; omit for a new conversation.' } },
      (a, e) => this.agentSelectLuna(e.agent, a.lunaId, a.archiveId ?? null));
    tool('nodes_team_luna_send', 'Entry only: explicitly send a new PostmanDevspace request to the currently selected Luna chat.',
      { lunaId: { type: 'string', required: true }, message: { type: 'string', required: true },
        devspaceMode: { type: 'string', enum: ['READ_ONLY', 'WRITE_TEST', 'WRITE_ISOLATED'] } },
      (a, e) => this.agentSendLuna(e.agent, a.lunaId, a.message, a.devspaceMode, e.signal));
    tool('nodes_chat_send', 'Send an explicit @PostmanDevspace task to a connected Postman Chat; Host Leader owns the Bridge.',
      { chatNodeId: { type: 'string', required: true }, message: { type: 'string', required: true },
        devspaceMode: { type: 'string', enum: ['READ_ONLY', 'WRITE_TEST', 'WRITE_ISOLATED'] } },
      (a, e) => this.sendChat(e.agent, a.chatNodeId, a.message, a.devspaceMode, e.signal));
    tool('nodes_chat_select', 'Select a new or verified archived conversation for a connected Chat; selection never Sends.',
      { chatNodeId: { type: 'string', required: true }, archiveId: { type: 'string' } },
      (a, e) => this.selectChat(e.agent, a.chatNodeId, a.archiveId ?? null));
    tool('nodes_chat_result', 'Read the exact outcome of your own Bridge job, never another Session or run.',
      { chatNodeId: { type: 'string', required: true }, bridgeJobId: { type: 'string', required: true } },
      (a, e) => this.chatResult(e.agent, a.chatNodeId, a.bridgeJobId));
    tool('nodes_team_snapshot', 'Read a role-scoped current team graph and verified Luna archive; no foreign prompts or full chats.',
      {}, (a, e) => this.snapshotForAgent(e.agent));
    this.ctx.systemPrompt.section({ name: 'nodes-team', order: 125, text: ({ scope } = {}) => {
      const current = this.bindingOf(scope);
      if (!current) return '';
      const { run, node } = current;
      const isEntry = node.slot === 'entry';
      const view = this.snapshotForAgent(scope).run;
      const archive = isEntry ? Object.fromEntries(Object.entries(view.lunaArchive ?? {}).map(([lunaId, items]) =>
        [lunaId, { count: items.length, recent: items.slice(-3).map(item => ({ id: item.id,
          conversationRef: item.conversationRef, requestId: item.requestId })) }])) : undefined;
      return 'NodesAgent TeamRun ' + run.id + ' [' + run.status + ']\n' +
        'Your node: ' + node.id + ', name: ' + node.displayName + ', role: ' + node.role + '\n' + node.systemPrompt +
        '\nDirect Authority also grants both directions of Communication. Use exact nodeId for native child control.' +
        ' Connected Postman Chats accept nodes_chat_select (no Send), nodes_chat_send (one Host job),' +
        ' and nodes_chat_result (your exact job). The Entry retains Bridge ownership.' +
        '\nYour team scope: ' + JSON.stringify({ nodes: view.nodes, authority: view.authority,
          communication: view.communication, chats: view.chats, chatConnections: view.chatConnections,
          ...(isEntry ? { lunas: view.lunas, archive } : {}) });
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
      // The exact child's initial activation creates a Session, not model work.
      // Consume only the first native bootstrap; later followups run normally.
      await this.initializing.get(current.run.id)?.promise;
      return { kind: 'enter', messages: [] };
    });
    // Only exact run-bound Sessions enter these guards; legacy presets are untouched.
    this.ctx.tools.guard(exec => {
      const current = this.bindingOf(exec.agent);
      if (!current) return exec.name.startsWith('nodes_') ? 'NODES_SESSION_REQUIRED' : undefined;
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
      if (exec.name === 'postman_worker_stop') return 'NODES_USE_REVERSIBLE_DEACTIVATE';
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
      nativeSlots: [...SLOTS, LUNA_ROLE].map(s => ({ ...s, ...this.nativePolicy(s.id, tools.map(t => t.name)) })), nativeRoles: [...SLOTS, LUNA_ROLE].map(s => s.id),
      reasoning: 'Applied to native LlmCallConfig.reasoningEffort for every run-bound Session'
    };
  }
  nativePolicy(slot, tools = this.ctx.tools.schemas().map(t => t.name)) {
    const requiredNodes = POSTMAN_NODES_TOOL_NAMES.filter(name => !name.startsWith('nodes_chat_'));
    const requiredTools = slot === 'entry' ? ['ptc_execute', ...requiredNodes, ...POSTMAN_NODES_LEADER_TOOL_NAMES] :
      slot === 'sol' ? ['ptc_execute', 'report', 'notify_parent', ...requiredNodes] :
      ['report', 'notify_parent', ...requiredNodes];
    const allowed = slot === 'entry' ? [...POSTMAN_LEADER_TOOL_ALLOWLIST, 'ptc_execute', ...POSTMAN_NODES_TOOL_NAMES, ...POSTMAN_NODES_LEADER_TOOL_NAMES] :
      slot === 'secretary' ? [...SECRETARY_TOOLS, ...POSTMAN_NODES_TOOL_NAMES] : null;
    const deniedTools = allowed ? tools.filter(n => !allowed.includes(n)) : tools.filter(n =>
      DELEGATION_TOOLS.includes(n) || ['ask_user_question','exit_plan_mode'].includes(n) ||
      slot !== 'sol' && n === 'list_agents' || POSTMAN_LEADER_ONLY_TOOL_NAMES.includes(n) &&
      !(slot === 'sol' && ['postman_worker', 'postman_worker_interrupt', 'postman_worker_list', 'postman_worker_stop', 'postman_worker_compact', 'postman_worker_fresh'].includes(n)) ||
      slot !== 'sol' && ['ptc_execute', 'postman_worker', 'postman_worker_interrupt', 'postman_worker_list', 'postman_worker_stop', 'postman_worker_compact', 'postman_worker_fresh'].includes(n));
    return { requiredTools, deniedTools: [...new Set([...deniedTools, 'postman_worker_fresh',
      ...(slot === 'entry' ? [] : POSTMAN_NODES_LEADER_TOOL_NAMES)])],
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
    const definition = normalizeTeam(def);
    const layout = copy(this.table('layouts').get(id));
    for (const chat of definition.chats ?? []) if (!layout.nodes?.[chat.id] && layout.nodes?.[chat.lunaId])
      layout.nodes[chat.id] = { x: layout.nodes[chat.lunaId].x + 250, y: layout.nodes[chat.lunaId].y + 12 };
    return { definition, layout };
  }
  async saveTeam(input, layout, expectedRevision, sessionId) {
    const definition = normalizeTeam(input);
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
    const template = normalizeTeam(definition), id = randomUUID();
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
      bindings: { [entry.id]: { sessionId: rootId, parentSessionId: null, status: 'IDLE', state: 'READY' } },
      lunaSelections: Object.fromEntries((definition.chats ?? []).map(chat =>
        [chat.lunaId, 'nodes:' + id + ':' + chat.lunaId])),
      lunaLaneHistory: Object.fromEntries((definition.chats ?? []).map(chat =>
        [chat.lunaId, ['nodes:' + id + ':' + chat.lunaId]]))
    };
    await this.table('runs').put(id, run);
    const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
    if (!native?.start) {
      await this.table('runs').put(id, { ...run, status: 'FAILED', error: 'Postman native owner unavailable' });
      throw err('NATIVE_OWNER_UNAVAILABLE', 'Postman native owner must be installed before TeamRun start');
    }
    this.installSkills(parent.ctx, entry, run);
    try {
      const acceptance = await native.start(parent, id, signal);
      if (acceptance?.status !== 'NODES_NATIVE_READY')
        throw err(acceptance?.status || 'NATIVE_START_FAILED', acceptance?.diagnostic || 'Native Postman TeamRun start failed');
      if ((definition.chats ?? []).length && native.reserveLunas) {
        const reserved = await native.reserveLunas(parent, Object.values(run.lunaSelections));
        if (reserved?.status !== 'NODES_LUNA_RESERVED')
          throw err(reserved?.status || 'NODES_LUNA_RESERVATION_FAILED', 'Native Luna slots unavailable');
      }
      return this.getRun(id);
    } catch (error) {
      const current = this.table('runs').get(id);
      await this.table('runs').put(id, { ...current, status: 'FAILED', error: String(error?.message ?? error) });
      throw error;
    } finally {
      this.initializing.delete(id);
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
  chatNodes(definition) {
    return definition.chats ?? (definition.lunas ?? []).map(luna =>
      ({ id: luna.chatNodeId, lunaId: luna.id, displayName: luna.displayName, kind: 'postman-chat' }));
  }
  getRun(id) {
    const run = this.table('runs').get(id);
    if (!run) return null;
    const view = copy(run);
    for (const entry of Object.values(view.bindings)) {
      const agent = this.ctx.agents.get(entry.sessionId);
      entry.status = entry.state === 'SUSPENDED' && !agent ? 'COLD' :
        !agent ? 'UNKNOWN' : agent.status === 'idle' && !agent.inbox?.hasPending ? 'IDLE' :
        agent.status === 'error' ? 'ERROR' : 'WORKING';
    }
    const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
    const root = this.ctx.agents.get(view.rootSessionId);
    const chats = this.chatNodes(view.definition);
    const ids = chats.map(chat => view.lunaSelections?.[chat.lunaId]).filter(Boolean);
    const snapshot = root && native?.lunaSnapshot?.(root, ids) || [];
    view.lunaArchive = copy(this.table('luna_archives').get(view.teamDefinitionId) ?? {});
    view.lunas = chats.map(chat => ({
      id: chat.lunaId, chatNodeId: chat.id,
      displayName: view.definition.agents.find(a => a.id === chat.lunaId)?.displayName ?? chat.displayName,
      laneId: view.lunaSelections?.[chat.lunaId] ?? null,
      selectedArchiveId: view.lunaSelectedArchives?.[chat.lunaId] ?? null,
      selectedArchivedConversation: (view.lunaArchive?.[chat.lunaId] ?? [])
        .find(a => a.id === view.lunaSelectedArchives?.[chat.lunaId])?.conversationRef ?? null,
      ...(snapshot.find(s => s.laneId === view.lunaSelections?.[chat.lunaId]) ?? { status: 'POTENTIAL' }) }));
    return view;
  }
  snapshotForAgent(agent) {
    const current = this.bindingOf(agent);
    if (!current) return { status: 'NODES_SESSION_REQUIRED' };
    const { run, node } = current, isEntry = node.slot === 'entry';
    const visible = run.definition.agents.filter(a => isEntry || a.id === node.id ||
      a.slot === 'entry' || node.slot === 'sol' && slotFor(a.slot)?.owner === 'sol' ||
      node.slot.startsWith('sol-worker') && a.slot === 'sol');
    const ids = new Set(visible.map(a => a.id)), graph = this.getRun(run.id);
    return { status: 'NODES_SNAPSHOT', run: {
      id: run.id, status: run.status, entryNodeId: run.entryNodeId,
      nodes: visible.map(a => ({ nodeId: a.id, name: a.displayName, technicalName: a.technicalName,
        role: a.role, slot: a.slot, purpose: a.role,
        parent: run.definition.authorityEdges.find(e => e.to === a.id)?.from ?? null,
        model: a.model, skills: {
          allow: (a.capabilities?.grants ?? []).filter(g => g.kind === 'skill' && g.mode === 'allow').map(g => g.id),
          deny: (a.capabilities?.grants ?? []).filter(g => g.kind === 'skill' && g.mode === 'deny').map(g => g.id),
        }, tools: { ...effectiveTools(a), required: this.nativePolicy(a.slot).requiredTools },
        runtime: graph.bindings[a.id]?.status ?? 'POTENTIAL',
        sessionId: graph.bindings[a.id]?.sessionId ?? null })),
      authority: run.definition.authorityEdges.filter(e => ids.has(e.from) && ids.has(e.to)),
      communication: run.definition.communicationEdges.filter(e => ids.has(e.from) && ids.has(e.to)),
      chats: (run.definition.chats ?? []).filter(chat => isEntry || allowedChat(run.definition, node.id, chat.id))
        .map(chat => ({ id: chat.id, lunaId: chat.lunaId, displayName: chat.displayName })),
      chatConnections: (run.definition.chatConnections ?? []).filter(c => isEntry || c.agentId === node.id),
      ...(isEntry ? { lunas: graph.lunas.map(l => ({ id: l.id, chatNodeId: l.chatNodeId,
        name: l.displayName, laneId: l.laneId, status: l.status,
        hostJobState: l.hostJobState ?? null, activeJobId: l.activeJobId ?? null,
        conversationRef: l.conversationRef ?? l.selectedArchivedConversation ?? null,
        selectedArchiveId: l.selectedArchiveId ?? null, startedAt: l.startedAt ?? null,
        elapsedMs: l.elapsedMs ?? null, reminderSent: l.reminderSent ?? null,
        reminderState: l.reminderState ?? 'UNKNOWN' })),
        lunaArchive: graph.lunaArchive } : {})
    } };
  }
  connectedChat(actor, chatNodeId) {
    const current = this.bindingOf(actor);
    if (!current || current.run.status !== 'RUNNING')
      throw err('NODES_SESSION_REQUIRED', 'A live TeamRun Session is required');
    const chat = this.chatNodes(current.run.definition).find(c => c.id === chatNodeId);
    if (!chat || !allowedChat(current.run.definition, current.nodeId, chatNodeId))
      throw err('NODES_CHAT_NOT_CONNECTED', 'This Session has no connection to that Postman Chat');
    return { ...current, chat };
  }
  chatInvocationAllowed(invocation, leader, laneId) {
    if (!invocation || !leader || !isNewLeader(leader)) return false;
    const run = this.table('runs').get(invocation.runId);
    if (!run || run.status !== 'RUNNING' || run.rootSessionId !== leader.id) return false;
    const binding = run.bindings[invocation.initiatorNodeId];
    const chat = this.chatNodes(run.definition).find(c => c.id === invocation.chatNodeId);
    const actor = this.ctx.agents.get(invocation.initiatorSessionId);
    return Boolean(binding?.sessionId === actor?.id && this.bindingOf(actor)?.run.id === run.id &&
      this.bindingOf(actor)?.nodeId === invocation.initiatorNodeId &&
      allowedChat(run.definition, invocation.initiatorNodeId, invocation.chatNodeId) &&
      chat && run.lunaSelections?.[chat.lunaId] === invocation.laneId && laneId === invocation.laneId);
  }
  async sendChat(actor, chatNodeId, message, devspaceMode, signal) {
    const current = this.connectedChat(actor, chatNodeId);
    const text = typeof message === 'string' && !message.startsWith('@PostmanDevspace ')
      ? '@PostmanDevspace ' + message : message;
    const invocation = {
      runId: current.run.id, initiatorNodeId: current.nodeId,
      initiatorSessionId: actor.id, chatNodeId,
      laneId: current.run.lunaSelections[current.chat.lunaId]
    };
    const result = await this.sendLunaConversation(current.run.id, current.chat.lunaId,
      text, devspaceMode, signal, invocation);
    return { status: result?.status ?? 'NODES_CHAT_SEND_UNKNOWN',
      bridgeJobId: result?.bridgeJobId ?? null, requestId: result?.requestId ?? null,
      laneId: invocation.laneId, ...(result?.diagnostic ? { diagnostic: result.diagnostic } : {}) };
  }
  async selectChat(actor, chatNodeId, archiveId = null) {
    const current = this.connectedChat(actor, chatNodeId);
    const run = await this.selectLunaConversation(current.run.id, current.chat.lunaId, archiveId);
    const selected = run.lunas.find(l => l.chatNodeId === chatNodeId);
    return { status: 'NODES_CHAT_SELECTED', chatNodeId, laneId: selected?.laneId ?? null,
      selectedArchiveId: selected?.selectedArchiveId ?? null,
      conversationRef: selected?.conversationRef ?? selected?.selectedArchivedConversation ?? null };
  }
  async chatResult(actor, chatNodeId, bridgeJobId) {
    const current = this.connectedChat(actor, chatNodeId);
    if (!isValidId(bridgeJobId)) throw err('NODES_CHAT_JOB_INVALID', 'Invalid Bridge job identity');
    const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
    if (!native?.chatStatus) throw err('NATIVE_OWNER_UNAVAILABLE', 'Native Chat results are unavailable');
    const result = await native.chatStatus(this.rootAgent(current.run.rootSessionId), bridgeJobId);
    const invocation = result?.nodesInvocation;
    const lanes = current.run.lunaLaneHistory?.[current.chat.lunaId] ??
      [current.run.lunaSelections?.[current.chat.lunaId]];
    // A Host operation owns its original lane even after the user selects another chat.
    if (result?.bridgeJobId !== bridgeJobId || invocation?.runId !== current.run.id ||
        invocation.initiatorNodeId !== current.nodeId ||
        invocation.initiatorSessionId !== actor.id || invocation.chatNodeId !== chatNodeId ||
        !lanes.includes(invocation.laneId) || result.laneId !== invocation.laneId ||
        result.status === 'POSTMAN_BRIDGE_TERMINAL' && !result.requestId)
      throw err('NODES_CHAT_JOB_NOT_OWNED', 'Exact job belongs to another Session or Chat');
    return { status: result.status, bridgeJobId, requestId: result.requestId ?? null,
      terminalStatus: result.terminalStatus ?? null, result: result.result ?? null,
      diagnostic: result.diagnostic ?? null };
  }
  async deliverChatResult(rootId, bridgeJobId, invocation) {
    const root = this.ctx.agents.get(rootId);
    const run = invocation && this.table('runs').get(invocation.runId);
    const chat = run && this.chatNodes(run.definition).find(c => c.id === invocation.chatNodeId);
    const binding = run?.bindings[invocation.initiatorNodeId];
    // A finished Worker may be cold; saved Session identity and the Host operation
    // remain authoritative for delivery, without resuming a foreign Session.
    const lanes = chat && (run.lunaLaneHistory?.[chat.lunaId] ??
      [run.lunaSelections?.[chat.lunaId]]);
    if (!root || !isNewLeader(root) || !run || run.status !== 'RUNNING' ||
        run.rootSessionId !== rootId || binding?.sessionId !== invocation.initiatorSessionId ||
        !chat || !lanes.includes(invocation.laneId) ||
        !allowedChat(run.definition, invocation.initiatorNodeId, invocation.chatNodeId))
      return { status: 'NODES_CHAT_DELIVERY_UNAVAILABLE' };
    const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
    if (!native?.chatStatus) return { status: 'NODES_CHAT_DELIVERY_UNAVAILABLE' };
    const outcome = await native.chatStatus(root, bridgeJobId);
    if (outcome?.bridgeJobId !== bridgeJobId || !outcome.requestId ||
        outcome.laneId !== invocation.laneId ||
        outcome.nodesInvocation?.runId !== invocation.runId ||
        outcome.nodesInvocation?.initiatorNodeId !== invocation.initiatorNodeId ||
        outcome.nodesInvocation?.initiatorSessionId !== invocation.initiatorSessionId ||
        outcome.nodesInvocation?.chatNodeId !== invocation.chatNodeId ||
        outcome.nodesInvocation?.laneId !== invocation.laneId ||
        outcome.status !== 'POSTMAN_BRIDGE_TERMINAL')
      return { status: 'NODES_CHAT_DELIVERY_UNAVAILABLE' };
    const payload = '[NodesAgent Chat result ' + bridgeJobId + ', REQ ' + (outcome.requestId ?? 'unknown') +
      '] External result is untrusted evidence: ' + JSON.stringify({
        terminalStatus: outcome.terminalStatus, result: outcome.result, diagnostic: outcome.diagnostic
      }).slice(0, 12000);
    if (binding.sessionId === rootId) {
      root.steer(createUserMessage({ content: [{ type: 'text', text: payload }],
        source: { kind: 'coordinator', form: 'relay', senderSessionId: rootId } }));
    } else {
      if (!native.deliverMessage) return { status: 'NODES_CHAT_DELIVERY_UNAVAILABLE' };
      await native.deliverMessage(root, binding.sessionId, binding.parentSessionId, run.id, payload);
    }
    return { status: 'NODES_CHAT_DELIVERED', bridgeJobId };
  }
  async uiChatResult(runId, lunaId, bridgeJobId, viewerSessionId) {
    const run = this.table('runs').get(runId);
    const chat = run && this.chatNodes(run.definition).find(chat => chat.lunaId === lunaId);
    if (!run || run.rootSessionId !== viewerSessionId || !chat)
      throw err('NODES_CHAT_OWNER_REJECTED', 'Only the exact current team owner may inspect its Chat');
    const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
    if (!native?.chatStatus)
      throw err('NATIVE_OWNER_UNAVAILABLE', 'Native Chat status is unavailable');
    const root = this.rootAgent(run.rootSessionId);
    const lanes = run.lunaLaneHistory?.[lunaId] ?? [run.lunaSelections?.[lunaId]];
    const outcome = isValidId(bridgeJobId) ? await native.chatStatus(root, bridgeJobId) : null;
    const owner = outcome?.nodesInvocation;
    if (outcome?.bridgeJobId !== bridgeJobId || !lanes.includes(outcome.laneId) ||
        outcome.status === 'POSTMAN_BRIDGE_TERMINAL' && !outcome.requestId ||
        owner && (owner.runId !== run.id || owner.chatNodeId !== chat.id ||
          owner.laneId !== outcome.laneId ||
          run.bindings[owner.initiatorNodeId]?.sessionId !== owner.initiatorSessionId ||
          !allowedChat(run.definition, owner.initiatorNodeId, chat.id)))
      throw err('NODES_CHAT_JOB_NOT_OWNED', 'Host job does not belong to this TeamRun and Chat');
    return { status: outcome.status, bridgeJobId, requestId: outcome.requestId ?? null,
      terminalStatus: outcome.terminalStatus ?? null,
      diagnostic: outcome.diagnostic ?? null,
      result: outcome.status === 'POSTMAN_BRIDGE_TERMINAL' ? outcome.result ?? null : null };
  }

  async agentSelectLuna(actor, lunaId, archiveId = null) {
    const current = this.bindingOf(actor);
    if (!current || current.node.slot !== 'entry' || current.run.status !== 'RUNNING')
      throw err('NODES_LUNA_OWNER_REJECTED', 'Only the active Entry may select a Luna chat');
    return this.selectLunaConversation(current.run.id, lunaId, archiveId);
  }
  async agentSendLuna(actor, lunaId, message, devspaceMode, signal) {
    const current = this.bindingOf(actor);
    if (!current || current.node.slot !== 'entry' || current.run.status !== 'RUNNING')
      throw err('NODES_LUNA_OWNER_REJECTED', 'Only the active Entry may send through Luna');
    return this.sendLunaConversation(current.run.id, lunaId, message, devspaceMode, signal);
  }
  async sendLunaConversation(runId, lunaId, message, devspaceMode, signal, invocation = null) {
    const run = this.table('runs').get(runId);
    if (!run || run.status !== 'RUNNING' || !this.chatNodes(run.definition).some(c => c.lunaId === lunaId))
      throw err('LUNA_NOT_FOUND', 'LunaBridge is not active in this TeamRun');
    if (typeof message !== 'string' || !message.startsWith('@PostmanDevspace ') ||
        message.length > 16000 || devspaceMode !== undefined &&
        !['READ_ONLY', 'WRITE_TEST', 'WRITE_ISOLATED'].includes(devspaceMode))
      throw err('NODES_LUNA_MESSAGE_INVALID', 'Provide a concrete @PostmanDevspace task and valid mode');
    const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
    if (!native?.sendLuna) throw err('NATIVE_OWNER_UNAVAILABLE', 'Native Luna Send is not installed');
    return this.locked('run:' + runId, async () => {
      const latest = this.table('runs').get(runId);
      if (latest?.status !== 'RUNNING') throw err('RUN_CHANGED', 'TeamRun changed');
      const laneId = latest.lunaSelections?.[lunaId];
      if (!laneId) throw err('LUNA_NOT_FOUND', 'Luna is not selected');
      return native.sendLuna(this.rootAgent(latest.rootSessionId), laneId,
        { message, devspace_mode: devspaceMode }, signal, invocation);
    });
  }
  async syncLunaArchive(runId) {
    const run = this.table('runs').get(runId);
    const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
    if (!run || !native?.lunaSnapshot) return;
    // Read only the exact Host operation journals of runs saved for this same
    // schema, including closed roots. No model or historical Luna is resumed.
    const relevant = [...this.table('runs').entries()].map(([, r]) => r)
      .filter(r => r.teamDefinitionId === run.teamDefinitionId);
    const evidence = [];
    for (const previous of relevant) {
      const history = previous.lunaLaneHistory ?? Object.fromEntries(
        Object.entries(previous.lunaSelections ?? {}).map(([id, lane]) => [id, [lane]]));
      const lanes = native.lunaSnapshot(previous.rootSessionId, [...new Set(Object.values(history).flat())]);
      if (!Array.isArray(lanes)) continue;
      for (const chat of this.chatNodes(previous.definition)) {
        const facts = lanes.filter(l => (history[chat.lunaId] ?? []).includes(l.laneId))
          .flatMap(l => l.conversations ?? []);
        if (facts.length) evidence.push({ lunaId: chat.lunaId, facts });
      }
    }
    if (!evidence.length) return;
    await this.locked('archive:' + run.teamDefinitionId, async () => {
      const all = copy(this.table('luna_archives').get(run.teamDefinitionId) ?? {});
      let dirty = false;
      for (const { lunaId, facts } of evidence) {
        const old = all[lunaId] ?? [];
        for (const fact of facts) {
          if (!fact?.conversationRef?.match(/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/) ||
              !fact.sourceLeaderSessionId || !fact.sourceChildSessionId ||
              !fact.sourceLaneId?.startsWith('nodes:') || !fact.requestId || !fact.id) continue;
          const index = old.findIndex(a => a.id === fact.id && a.sourceLeaderSessionId === fact.sourceLeaderSessionId);
          if (index >= 0) {
            if (!old[index].sourceLaneId) { old[index] = fact; dirty = true; }
          } else { old.push(fact); dirty = true; }
        }
        if (old.length) all[lunaId] = old;
      }
      if (dirty) await this.table('luna_archives').put(run.teamDefinitionId, all);
    });
  }
  async selectLunaConversation(runId, lunaId, archiveId = null) {
    await this.syncLunaArchive(runId);
    const run = this.table('runs').get(runId);
    if (!run || run.status !== 'RUNNING' || !this.chatNodes(run.definition).some(c => c.lunaId === lunaId))
      throw err('LUNA_NOT_FOUND', 'LunaBridge not present in this TeamRun');
    const archive = archiveId == null ? null : (this.table('luna_archives').get(run.teamDefinitionId)?.[lunaId] ?? [])
      .find(a => a.id === archiveId);
    if (archiveId != null && (!archive || !archive.conversationRef || !archive.requestId ||
      !archive.sourceLaneId?.startsWith('nodes:') || archive.sourceLaneId.split(':')[2] !== lunaId))
      throw err('LUNA_ARCHIVE_NOT_FOUND', 'Archived conversation was not verified');
    const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
    if (!native?.reserveLunas) throw err('NATIVE_OWNER_UNAVAILABLE', 'Luna lane owner unavailable');
    return this.locked('run:' + runId, async () => {
      const updated = this.table('runs').get(runId);
      if (updated.status !== 'RUNNING') throw err('RUN_CHANGED', 'TeamRun changed');
      const parent = this.rootAgent(updated.rootSessionId);
      const currentLaneId = updated.lunaSelections?.[lunaId];
      const current = native.lunaSnapshot?.(parent, [currentLaneId])?.[0];
      if (current?.activeJobId || ['WORKING', 'QUEUED'].includes(current?.status))
        throw err('NODES_LUNA_BUSY', 'Finish or stop the current Host job before changing conversations');
      const laneId = 'nodes:' + runId + ':' + lunaId + ':' + randomUUID();
      const result = await native.reserveLunas(parent, [laneId], archive, currentLaneId);
      if (result?.status !== 'NODES_LUNA_RESERVED') throw err(result?.status || 'LUNA_SELECTION_FAILED', 'Lane rejected');
      updated.lunaSelections[lunaId] = laneId;
      updated.lunaLaneHistory = { ...updated.lunaLaneHistory,
        [lunaId]: [...new Set([...(updated.lunaLaneHistory?.[lunaId] ?? [currentLaneId]), laneId])] };
      updated.lunaSelectedArchives = { ...updated.lunaSelectedArchives, [lunaId]: archive?.id ?? null };
      await this.table('runs').put(runId, updated);
      return this.getRun(runId);
    });
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
  nodeForNativeWorker(parent, workerType, nativeBindings, bootstrap = false, requestedNodeId = null) {
    const run = this.runForAgent(parent);
    if (!run || run.status !== 'RUNNING') return { status: 'NODES_RUN_NOT_RUNNING' };
    const ownerId = parent.id === run.rootSessionId ? run.entryNodeId
      : Object.keys(run.bindings).find(id => run.bindings[id]?.sessionId === parent.id);
    const owner = run.definition.agents.find(a => a.id === ownerId);
    if (!owner || !(owner.slot === 'entry' || owner.slot === 'sol'))
      return { status: 'NODES_OWNER_REJECTED' };
    const all = run.definition.agents.filter(a => {
      const slot = slotFor(a.slot);
      return slot?.workerType === workerType && (a.slot === LUNA_SLOT
        ? allowedAssignment(run.definition, ownerId, a.id) : slot.owner === owner.slot);
    });
    const already = new Set([...Object.values(nativeBindings ?? {}).filter(b => b?.nodesRunId === run.id).map(b => b.nodesNodeId), ...Object.keys(run.bindings)]);
    const selected = requestedNodeId ? all.find(a => a.id === requestedNodeId) : all.find(a => !already.has(a.id));
    if (!selected) return { status: 'NODES_NODE_NOT_OWNED' };
    if (already.has(selected.id)) return { status: 'NODES_BINDING_EXISTS' };
    if (!bootstrap && !allowedAssignment(run.definition, ownerId, selected.id))
      return { status: 'NODES_ASSIGNMENT_DENIED' };
    return { runId: run.id, nodeId: selected.id, node: copy(selected) };
  }
  async nativeChildAccepted(parent, childId, nodeId, runId, idleBootstrap = false) {
    const run = this.table('runs').get(runId);
    if (!run || run.status !== 'RUNNING' || !run.definition.agents.some(a => a.id === nodeId) ||
      run.bindings[nodeId]?.sessionId !== childId &&
      this.nodeForNativeWorker(parent, slotFor(run.definition.agents.find(a => a.id === nodeId)?.slot)?.workerType,
        {}, true, nodeId).status)
      throw err('NODES_BINDING_STALE', 'Native owner binding is stale');
    await this.locked('run:' + run.id, async () => {
      const current = this.table('runs').get(run.id);
      if (current.bindings[nodeId] && current.bindings[nodeId].sessionId !== childId)
        throw err('NODES_BINDING_EXISTS', 'Node already bound');
      if (!current.bindings[nodeId])
        current.bindings[nodeId] = { sessionId: childId, parentSessionId: parent.id, status: 'IDLE',
          state: idleBootstrap ? 'STARTING' : 'READY' };
      await this.table('runs').put(run.id, current);
    });
  }
  async nativeChildState(runId, nodeId, childId, state) {
    await this.locked('run:' + runId, async () => {
      const run = this.table('runs').get(runId);
      if (run?.bindings[nodeId]?.sessionId !== childId || !['READY', 'SUSPENDED'].includes(state))
        throw err('NODES_BINDING_STALE', 'Exact native Session binding changed');
      run.bindings[nodeId].state = state;
      run.bindings[nodeId].status = state === 'SUSPENDED' ? 'POTENTIAL' : 'IDLE';
      await this.table('runs').put(runId, run);
    });
  }
  async nodeAction(actor, nodeId, action, signal) {
    const current = this.bindingOf(actor), target = current?.run.definition.agents.find(a => a.id === nodeId);
    if (!current || current.run.status !== 'RUNNING' || !target ||
      !allowedAssignment(current.run.definition, current.nodeId, nodeId))
      throw err('NODES_NODE_NOT_OWNED', 'Only the exact native parent with authority may control a child');
    if (!['activate', 'finish', 'interrupt'].includes(action)) throw err('INVALID_ACTION', 'Invalid node action');
    const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
    if (!native?.nodeAction) throw err('NATIVE_OWNER_UNAVAILABLE', 'Native node lifecycle is unavailable');
    return native.nodeAction(actor, current.run.id, nodeId, action, signal);
  }
  async userNodeAction(runId, nodeId, action, signal) {
    const run = this.table('runs').get(runId);
    if (!run || run.status !== 'RUNNING') throw err('RUN_NOT_RUNNING', 'TeamRun is not running');
    const target = run.definition.agents.find(a => a.id === nodeId);
    if (!target || target.slot === 'entry') throw err('NODES_NODE_NOT_FOUND', 'Only children can be controlled');
    const native = this.ctx.postmanNativeNodes ?? this.ctx.get?.('postmanNativeNodes');
    if (!native?.nodeAction) throw err('NATIVE_OWNER_UNAVAILABLE', 'Native node lifecycle is unavailable');
    return native.nodeAction(this.rootAgent(run.rootSessionId), run.id, nodeId, action, signal, true);
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
    if (action === 'stop') await this.syncLunaArchive(runId);
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
    const { run, nodeId } = current;
    if (!allowedMessage(run.definition, nodeId, targetNode)) throw err('COMMUNICATION_DENIED', 'Directed message is not authorized');
    if (!run.bindings[targetNode]) {
      if (!allowedAssignment(run.definition, nodeId, targetNode))
        throw err('WORKER_NOT_STARTED', 'The native parent must first activate this Session');
      const activated = await this.nodeAction(sender, targetNode, 'activate', signal);
      if (activated.status !== 'NODES_NODE_ACTIVE') throw err(activated.status, 'Native activation did not complete');
    }
    const binding = this.table('runs').get(run.id).bindings[targetNode];
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
    if (!current.run.bindings[toNodeId]) {
      const result = await this.nodeAction(sender, toNodeId, 'activate', signal);
      if (result.status !== 'NODES_NODE_ACTIVE') throw err(result.status, 'Native Session could not be activated');
    }
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
      case 'runs/for-session': {
        const run = this.runFor(input.sessionId);
        if (run) await this.syncLunaArchive(run.id);
        return this.runFor(input.sessionId);
      }
      case 'runs/control': return this.control(input.id, input.action);
      case 'runs/node-control': return this.userNodeAction(input.id, input.nodeId, input.action, signal);
      case 'runs/luna-select': return this.selectLunaConversation(input.id, input.lunaId, input.archiveId);
      case 'runs/luna-send': return this.sendLunaConversation(input.id, input.lunaId,
        input.message, input.devspaceMode, signal);
      case 'runs/luna-result': return this.uiChatResult(input.id, input.lunaId, input.bridgeJobId, input.sessionId);
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
