import { randomUUID } from 'node:crypto';

export const NODES_PRESET = 'postman-leader-ptc-nodes';
export const SLOTS = Object.freeze([
  { id: 'entry', label: 'Postman Leader PTC', owner: null, workerType: null, model: 'gpt-6.1-sol', reasoning: 'xhigh' },
  { id: 'secretary', label: 'Secretary', owner: 'entry', workerType: 'secretary', model: 'gpt-6-luna', reasoning: 'low' },
  { id: 'worker-1', label: 'Worker 1', owner: 'entry', workerType: 'luna', model: 'gpt-6-luna', reasoning: 'low' },
  { id: 'worker-2', label: 'Worker 2', owner: 'entry', workerType: 'luna', model: 'gpt-6-luna', reasoning: 'low' },
  { id: 'sol', label: 'Sol Worker', owner: 'entry', workerType: 'sol', model: 'gpt-6.1-sol', reasoning: 'xhigh' },
  { id: 'sol-worker-1', label: 'Worker 1 (Sol)', owner: 'sol', workerType: 'luna', model: 'gpt-6-luna', reasoning: 'low' },
  { id: 'sol-worker-2', label: 'Worker 2 (Sol)', owner: 'sol', workerType: 'luna', model: 'gpt-6-luna', reasoning: 'low' }
]);
const slotById = new Map(SLOTS.map(s => [s.id, s]));
export function slotFor(id) { return slotById.get(id); }
export function nativeRole(type, parentSlot, index) {
  const roles = SLOTS.filter(slot => slot.workerType === type && slot.owner === parentSlot);
  return roles[index] || null;
}
export function createTemplate() {
  const id = randomUUID();
  const agents = SLOTS.map((slot) => ({
    id: randomUUID(), slot: slot.id,
    technicalName: slot.id.replaceAll('-', '_'), displayName: slot.label,
    role: slot.label, systemPrompt: 'Follow the native Postman role constraints and report evidence to your manager.',
    model: { provider: 'codex', model: slot.model, reasoningEffort: slot.reasoning },
    capabilities: { grants: [] }
  }));
  const bySlot = new Map(agents.map(a => [a.slot, a.id]));
  const authorityEdges = SLOTS.filter(s => s.owner).map(s => ({
    id: randomUUID(), from: bySlot.get(s.owner), to: bySlot.get(s.id)
  }));
  const communicationEdges = authorityEdges.flatMap(e => [
    { id: randomUUID(), from: e.from, to: e.to },
    { id: randomUUID(), from: e.to, to: e.from }
  ]);
  const lunas = Array.from({ length: 3 }, (_, i) => ({
    id: randomUUID(), kind: 'luna-bridge', displayName: 'LunaBridge ' + (i + 1),
    chatNodeId: randomUUID()
  }));
  const layout = {
    schemaVersion: 1, teamId: id, viewport: { x: 100, y: 65, zoom: 0.85 },
    nodes: { ...Object.fromEntries(agents.map((a, i) => [a.id,
      { x: i === 0 ? 460 : i === 4 ? 800 : i === 5 ? 630 : i === 6 ? 1000 : 100 + ((i - 1) % 3) * 290,
        y: i === 0 ? 40 : i > 4 ? 570 : i === 4 ? 285 : 285 }])),
      ...Object.fromEntries(lunas.map((a, i) => [a.id, { x: 130 + i * 480, y: 870 }])) }
  };
  return { definition: {
    schemaVersion: 1, id, revision: 0, name: 'Postman Native Team',
    entryAgentId: bySlot.get('entry'), agents, lunas, authorityEdges, communicationEdges
  }, layout };
}
const invalid = (errors, code, message) => errors.push({ code, message, blocking: true });
export function validateTeam(team, catalog = null) {
  const errors = [];
  if (!team || team.schemaVersion !== 1 || !Array.isArray(team.agents) || !Array.isArray(team.authorityEdges) ||
    !Array.isArray(team.communicationEdges)) return [{ code: 'INVALID_SCHEMA', message: 'Invalid TeamDefinition', blocking: true }];
  const lunas = team.lunas ?? [];
  if (!Array.isArray(lunas) || lunas.length > 3) invalid(errors, 'LUNA_LIMIT', 'Zero to three LunaBridge nodes permitted');
  const lunaIds = new Set(), chatIds = new Set();
  for (const luna of Array.isArray(lunas) ? lunas : []) {
    if (!luna || luna.kind !== 'luna-bridge' || !luna.id || typeof luna.id !== 'string' ||
      lunaIds.has(luna.id) || !luna.chatNodeId || typeof luna.chatNodeId !== 'string' ||
      chatIds.has(luna.chatNodeId) || typeof luna.displayName !== 'string' || !luna.displayName.trim())
      invalid(errors, 'LUNA_INVALID', 'Each LunaBridge needs a unique node, chat and name');
    else { lunaIds.add(luna.id); chatIds.add(luna.chatNodeId); }
  }
  const byId = new Map(), bySlot = new Map(), names = new Set();
  for (const a of team.agents) {
    if (!a || typeof a.id !== 'string' || !a.id || byId.has(a.id)) { invalid(errors, 'DUPLICATE_ID', 'Invalid or duplicate agent id'); continue; }
    byId.set(a.id, a);
    if (lunaIds.has(a.id) || chatIds.has(a.id)) invalid(errors, 'LUNA_ID_COLLISION', 'Luna node conflicts with a native AgentNode');
    if (!slotById.has(a.slot) || bySlot.has(a.slot)) invalid(errors, 'INVALID_SLOT', 'Unknown or duplicate native Postman slot: ' + a.slot);
    else bySlot.set(a.slot, a);
    for (const field of ['technicalName', 'displayName', 'role', 'systemPrompt']) {
      if (typeof a[field] !== 'string' || !a[field].trim()) invalid(errors, 'REQUIRED_FIELD', a.slot + ': missing ' + field);
    }
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
      if (!grant || !['allow','deny'].includes(grant.mode) || !['tool','skill'].includes(grant.kind) ||
        typeof grant.id !== 'string' || !grant.id) { invalid(errors, 'INVALID_GRANT', a.slot + ': invalid capability'); continue; }
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
  const incoming = new Map(), adjacency = new Map([...byId.keys()].map(id => [id, []]));
  for (const e of team.authorityEdges) {
    if (!e || !byId.has(e.from) || !byId.has(e.to) || e.from === e.to) {
      invalid(errors, 'AUTHORITY_ENDPOINT', 'Authority has invalid endpoint'); continue;
    }
    incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
    adjacency.get(e.from).push(e.to);
    if (incoming.get(e.to) > 1) invalid(errors, 'MULTIPLE_MANAGERS', 'An agent has multiple managers');
  }
  for (const a of byId.values()) {
    const expected = slotById.get(a.slot)?.owner;
    const managers = team.authorityEdges.filter(e => e.to === a.id);
    if (expected === null && managers.length) invalid(errors, 'ENTRY_PARENT', 'Entry cannot have a manager');
    // Native DSH Session ownership and editable Authority are deliberately distinct.
    // Only the Entry is fixed: no AgentNode may acquire Postman Supervisor privileges.
    if (expected && !bySlot.has(expected))
      invalid(errors, 'NATIVE_PARENT_ABSENT', a.slot + ': native parent slot ' + expected + ' is required for its DSH Session');
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
  for (const e of team.communicationEdges) {
    if (!e || !byId.has(e.from) || !byId.has(e.to) || e.from === e.to) invalid(errors, 'COMMUNICATION_ENDPOINT', 'Communication has invalid endpoint');
  }
  return errors;
}
export function allowedMessage(team, from, to) {
  return team.communicationEdges.some(edge => edge.from === from && edge.to === to);
}
export function allowedAssignment(team, from, to) {
  return team.authorityEdges.some(edge => edge.from === from && edge.to === to) && allowedMessage(team, from, to);
}
export function effectiveTools(agent, nativeDenied = []) {
  const grants = agent.capabilities?.grants || [];
  const deny = new Set(nativeDenied);
  for (const grant of grants) if (grant.kind === 'tool' && grant.mode === 'deny') deny.add(grant.id);
  const allow = [...new Set(grants.filter(g => g.kind === 'tool' && g.mode === 'allow').map(g => g.id))];
  return { deny: [...deny], allow: allow.filter(name => !deny.has(name)), hasAllowlist: allow.length > 0 };
}
