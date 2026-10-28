import { randomUUID } from 'node:crypto';

export const NODES_PRESET = 'postman-leader-ptc-nodes';
export const LUNA_SLOT = 'luna-bridge';
export const SLOTS = Object.freeze([
  { id: 'entry', label: 'Postman Leader PTC', owner: null, workerType: null, model: 'gpt-6.1-sol', reasoning: 'xhigh' },
  { id: 'secretary', label: 'Secretary', owner: 'entry', workerType: 'secretary', model: 'gpt-6-luna', reasoning: 'low' },
  { id: 'worker-1', label: 'Worker 1', owner: 'entry', workerType: 'luna', model: 'gpt-6-luna', reasoning: 'low' },
  { id: 'worker-2', label: 'Worker 2', owner: 'entry', workerType: 'luna', model: 'gpt-6-luna', reasoning: 'low' },
  { id: 'sol', label: 'Sol Worker', owner: 'entry', workerType: 'sol', model: 'gpt-6.1-sol', reasoning: 'xhigh' },
  { id: 'sol-worker-1', label: 'Worker 1 (Sol)', owner: 'sol', workerType: 'luna', model: 'gpt-6-luna', reasoning: 'low' },
  { id: 'sol-worker-2', label: 'Worker 2 (Sol)', owner: 'sol', workerType: 'luna', model: 'gpt-6-luna', reasoning: 'low' }
]);
export const LUNA_ROLE = Object.freeze({ id: LUNA_SLOT, label: 'LunaBridge', owner: 'entry',
  workerType: LUNA_SLOT, model: 'gpt-6-luna', reasoning: 'low' });
const slotById = new Map([...SLOTS, LUNA_ROLE].map(s => [s.id, s]));
export function slotFor(id) { return slotById.get(id); }
export function nativeRole(type, parentSlot, index) {
  const roles = SLOTS.filter(slot => slot.workerType === type && slot.owner === parentSlot);
  return roles[index] || null;
}
const clone = value => structuredClone(value);
const edge = (from, to, id = randomUUID()) => ({ id, from, to });
const link = (agentId, chatNodeId) => ({
  id: 'chat-connection:' + agentId + ':' + chatNodeId, agentId, chatNodeId
});

// Convert a saved v1 definition in memory only. Caller chooses whether to Save.
// Existing AgentNode, Luna, chat, layout and archive identifiers are preserved.
export function normalizeTeam(source) {
  if (!source || !Array.isArray(source.agents)) return source;
  const team = clone(source);
  if (team.schemaVersion === 1) {
    team.chats = [];
    team.chatConnections = [];
    for (const [index, luna] of (team.lunas ?? []).entries()) {
      if (!team.agents.some(agent => agent.id === luna.id)) {
        team.agents.push({
          id: luna.id, slot: LUNA_SLOT, technicalName: 'luna_bridge_' + (index + 1),
          displayName: luna.displayName, role: 'LunaBridge',
          systemPrompt: 'Follow native Postman role constraints and use connected Postman Chat through Nodes tools.',
          model: { provider: 'codex', model: LUNA_ROLE.model, reasoningEffort: LUNA_ROLE.reasoning },
          capabilities: { grants: [] }
        });
      }
      team.chats.push({ id: luna.chatNodeId, kind: 'postman-chat',
        displayName: 'Postman Chat ' + (index + 1), lunaId: luna.id });
      team.authorityEdges.push(edge(team.entryAgentId, luna.id, 'authority:luna:' + luna.id));
      team.chatConnections.push(link(luna.id, luna.chatNodeId));
      team.chatConnections.push(link(team.entryAgentId, luna.chatNodeId));
    }
    delete team.lunas;
    team.schemaVersion = 2;
  }
  if (team.schemaVersion === 2) {
    // Direct Authority already supplies both Communication directions.
    const direct = new Set(team.authorityEdges.flatMap(e =>
      [e.from + '\0' + e.to, e.to + '\0' + e.from]));
    team.communicationEdges = team.communicationEdges.filter(e => !direct.has(e.from + '\0' + e.to));
  }
  return team;
}

export function createTemplate() {
  const id = randomUUID();
  const agents = SLOTS.map(slot => ({
    id: randomUUID(), slot: slot.id,
    technicalName: slot.id.replaceAll('-', '_'), displayName: slot.label,
    role: slot.label, systemPrompt: 'Follow the native Postman role constraints and report evidence to your manager.',
    model: { provider: 'codex', model: slot.model, reasoningEffort: slot.reasoning },
    capabilities: { grants: [] }
  }));
  const bySlot = new Map(agents.map(a => [a.slot, a.id]));
  const authorityEdges = SLOTS.filter(s => s.owner).map(s => edge(bySlot.get(s.owner), bySlot.get(s.id)));
  const chats = [];
  const chatConnections = [];
  for (let i = 0; i < 3; i++) {
    const agentId = randomUUID(), chatId = randomUUID();
    agents.push({ id: agentId, slot: LUNA_SLOT, technicalName: 'luna_bridge_' + (i + 1),
      displayName: 'LunaBridge ' + (i + 1), role: 'LunaBridge',
      systemPrompt: 'Follow native Postman role constraints and use connected Postman Chat through Nodes tools.',
      model: { provider: 'codex', model: LUNA_ROLE.model, reasoningEffort: LUNA_ROLE.reasoning },
      capabilities: { grants: [] } });
    chats.push({ id: chatId, kind: 'postman-chat', displayName: 'Postman Chat ' + (i + 1), lunaId: agentId });
    authorityEdges.push(edge(bySlot.get('entry'), agentId));
    chatConnections.push(link(agentId, chatId), link(bySlot.get('entry'), chatId));
  }
  const layout = {
    schemaVersion: 1, teamId: id, viewport: { x: 100, y: 65, zoom: 0.85 },
    nodes: Object.fromEntries([...agents.map((a, i) => [a.id, i < 7
      ? { x: i === 0 ? 460 : i === 4 ? 800 : i === 5 ? 630 : i === 6 ? 1000 : 100 + ((i - 1) % 3) * 290,
        y: i === 0 ? 40 : i > 4 ? 570 : i === 4 ? 285 : 285 }
      : { x: 130 + (i - 7) * 480, y: 870 }]), ...chats.map((c, i) => [c.id,
      { x: 130 + i * 480 + 250, y: 882 }])])
  };
  return { definition: {
    schemaVersion: 2, id, revision: 0, name: 'Postman Native Team',
    entryAgentId: bySlot.get('entry'), agents, chats, chatConnections,
    authorityEdges, communicationEdges: []
  }, layout };
}
const invalid = (errors, code, message) => errors.push({ code, message, blocking: true });
export function validateTeam(source, catalog = null) {
  const errors = [];
  const team = normalizeTeam(source);
  if (!team || team.schemaVersion !== 2 || !Array.isArray(team.agents) ||
      !Array.isArray(team.authorityEdges) || !Array.isArray(team.communicationEdges) ||
      !Array.isArray(team.chats) || !Array.isArray(team.chatConnections))
    return [{ code: 'INVALID_SCHEMA', message: 'Invalid TeamDefinition', blocking: true }];
  const byId = new Map(), bySlot = new Map(), names = new Set();
  const lunas = team.agents.filter(a => a?.slot === LUNA_SLOT);
  if (lunas.length > 3 || team.chats.length > 3 || lunas.length !== team.chats.length)
    invalid(errors, 'LUNA_LIMIT', 'Zero to three LunaBridge/Chat pairs permitted');
  for (const a of team.agents) {
    if (!a || typeof a.id !== 'string' || !a.id || byId.has(a.id)) {
      invalid(errors, 'DUPLICATE_ID', 'Invalid or duplicate agent id'); continue;
    }
    byId.set(a.id, a);
    if (!slotById.has(a.slot) || a.slot !== LUNA_SLOT && bySlot.has(a.slot))
      invalid(errors, 'INVALID_SLOT', 'Unknown or duplicate native Postman slot: ' + a.slot);
    else if (a.slot !== LUNA_SLOT) bySlot.set(a.slot, a);
    for (const field of ['technicalName', 'displayName', 'role', 'systemPrompt'])
      if (typeof a[field] !== 'string' || !a[field].trim())
        invalid(errors, 'REQUIRED_FIELD', a.slot + ': missing ' + field);
    if (names.has(a.technicalName)) invalid(errors, 'DUPLICATE_NAME', 'Duplicate technical name: ' + a.technicalName);
    names.add(a.technicalName);
    if (!a.model || typeof a.model.provider !== 'string' || typeof a.model.model !== 'string' ||
        !a.model.provider || !a.model.model) invalid(errors, 'INVALID_MODEL', a.slot + ': provider/model required');
    else if (catalog && !catalog.models.some(p => p.provider === a.model.provider &&
        p.models.some(m => m.id === a.model.model))) invalid(errors, 'INVALID_MODEL', a.slot + ': provider/model unavailable');
    const modelInfo = catalog?.models.find(p => p.provider === a.model?.provider)?.models.find(m => m.id === a.model?.model);
    if (a.model?.reasoningEffort && modelInfo && !modelInfo.reasoningEfforts?.includes(a.model.reasoningEffort))
      invalid(errors, 'INVALID_REASONING', a.slot + ': unsupported reasoning effort');
    const seen = new Set();
    for (const grant of a.capabilities?.grants || []) {
      if (!grant || !['allow', 'deny'].includes(grant.mode) || !['tool', 'skill'].includes(grant.kind) ||
          typeof grant.id !== 'string' || !grant.id) {
        invalid(errors, 'INVALID_GRANT', a.slot + ': invalid capability'); continue;
      }
      const key = grant.kind + ':' + grant.id + ':' + grant.mode;
      if (seen.has(key)) invalid(errors, 'DUPLICATE_GRANT', a.slot + ': duplicate grant');
      seen.add(key);
      if (grant.kind === 'skill' && catalog && !catalog.skills?.items?.some(s => s.name === grant.id))
        invalid(errors, 'INVALID_SKILL', a.slot + ': unknown skill ' + grant.id);
      if (grant.kind === 'skill' && grant.mode === 'deny' && grant.id.startsWith('postman-'))
        invalid(errors, 'REQUIRED_NATIVE_SKILL', 'Native Postman role instructions are fixed');
      if (grant.kind === 'tool' && catalog && !catalog.tools.some(t => t.name === grant.id))
        invalid(errors, 'INVALID_TOOL', a.slot + ': unknown tool ' + grant.id);
      const fixed = catalog?.nativeSlots?.find(s => s.id === a.slot);
      if (grant.kind === 'tool' && fixed && (fixed.deniedTools.includes(grant.id) || fixed.requiredTools.includes(grant.id)))
        invalid(errors, 'FIXED_NATIVE_TOOL', a.slot + ': this tool is fixed by the native role');
    }
  }
  if (!bySlot.get('entry') || team.entryAgentId !== bySlot.get('entry')?.id)
    invalid(errors, 'ENTRY_REQUIRED', 'Exactly one native Entry Agent is required');
  const adjacency = new Map([...byId.keys()].map(id => [id, []])), incoming = new Map();
  for (const e of team.authorityEdges) {
    if (!e || !byId.has(e.from) || !byId.has(e.to) || e.from === e.to) {
      invalid(errors, 'AUTHORITY_ENDPOINT', 'Authority has invalid endpoint'); continue;
    }
    incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
    adjacency.get(e.from).push(e.to);
    if (incoming.get(e.to) > 1) invalid(errors, 'MULTIPLE_MANAGERS', 'An agent has multiple managers');
  }
  for (const a of byId.values()) {
    const expected = slotFor(a.slot)?.owner;
    const managers = team.authorityEdges.filter(e => e.to === a.id);
    if (expected === null && managers.length) invalid(errors, 'ENTRY_PARENT', 'Entry cannot have a manager');
    if (expected && a.slot !== LUNA_SLOT && !bySlot.has(expected))
      invalid(errors, 'NATIVE_PARENT_ABSENT', a.slot + ': native parent slot ' + expected + ' is required for its DSH Session');
    if (a.slot === LUNA_SLOT && managers.length !== 1)
      invalid(errors, 'LUNA_PARENT_REQUIRED', 'Each LunaBridge needs one direct native parent');
    else if (a.slot === LUNA_SLOT && !['entry', 'sol'].includes(byId.get(managers[0].from)?.slot))
      invalid(errors, 'LUNA_PARENT_UNSUPPORTED', 'LunaBridge native parent must be Entry or Sol');
  }
  const visiting = new Set(), visited = new Set();
  function cycle(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const child of adjacency.get(id) || []) if (cycle(child)) return true;
    visiting.delete(id); visited.add(id); return false;
  }
  if ([...byId.keys()].some(cycle)) invalid(errors, 'AUTHORITY_CYCLE', 'Authority cycle');
  for (const e of team.communicationEdges)
    if (!e || !byId.has(e.from) || !byId.has(e.to) || e.from === e.to)
      invalid(errors, 'COMMUNICATION_ENDPOINT', 'Communication has invalid endpoint');
  const chatIds = new Set(), boundLunas = new Set(), pairIds = new Set();
  for (const chat of team.chats) {
    if (!chat || chat.kind !== 'postman-chat' || typeof chat.id !== 'string' || !chat.id ||
        chatIds.has(chat.id) || byId.has(chat.id) || typeof chat.displayName !== 'string' ||
        !chat.displayName.trim() || !lunas.some(luna => luna.id === chat.lunaId) || boundLunas.has(chat.lunaId))
      invalid(errors, 'CHAT_INVALID', 'Postman Chat requires unique id and LunaBridge owner');
    else { chatIds.add(chat.id); boundLunas.add(chat.lunaId); }
    if (chat && !team.chatConnections.some(e => e.chatNodeId === chat.id))
      invalid(errors, 'CHAT_DISCONNECTED', 'Postman Chat needs an explicit AgentNode connection');
  }
  for (const c of team.chatConnections) {
    if (!c || !byId.has(c.agentId) || !chatIds.has(c.chatNodeId) ||
        pairIds.has(c.agentId + '\0' + c.chatNodeId))
      invalid(errors, 'CHAT_CONNECTION_INVALID', 'Only valid unique AgentNode/Postman Chat connections allowed');
    else pairIds.add(c.agentId + '\0' + c.chatNodeId);
  }
  return errors;
}
export function allowedMessage(team, from, to) {
  return team.communicationEdges.some(e => e.from === from && e.to === to) ||
    team.authorityEdges.some(e => e.from === from && e.to === to || e.from === to && e.to === from);
}
export function allowedAssignment(team, from, to) {
  return team.authorityEdges.some(e => e.from === from && e.to === to);
}
export function allowedChat(team, agentId, chatNodeId) {
  return team.chatConnections?.some(e => e.agentId === agentId && e.chatNodeId === chatNodeId) === true &&
    team.chats?.some(c => c.id === chatNodeId) === true;
}
export function effectiveTools(agent, nativeDenied = []) {
  const grants = agent.capabilities?.grants || [];
  const deny = new Set(nativeDenied);
  for (const grant of grants) if (grant.kind === 'tool' && grant.mode === 'deny') deny.add(grant.id);
  const allow = [...new Set(grants.filter(g => g.kind === 'tool' && g.mode === 'allow').map(g => g.id))];
  return { deny: [...deny], allow: allow.filter(name => !deny.has(name)), hasAllowlist: allow.length > 0 };
}
