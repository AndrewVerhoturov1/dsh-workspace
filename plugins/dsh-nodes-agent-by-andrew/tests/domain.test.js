import assert from 'node:assert/strict';
import test from 'node:test';
import { createTemplate, SLOTS, LUNA_SLOT, normalizeTeam, validateTeam, effectiveTools, allowedMessage, allowedAssignment, allowedChat } from '../lib/domain.js';

const catalog = {
  models: [{ provider: 'codex', models: [...new Set(SLOTS.map(s => s.model))].map(id => ({ id, reasoningEfforts: ['low','xhigh','max'] })) }],
  skills: { supported: true, items: [{ name: 'sample-skill' }, { name: 'postman-worker' }] },
  nativeSlots: SLOTS.map(s => ({ id:s.id, requiredTools:['report','notify_parent'], deniedTools:[] })),
  tools: [{ name: 'read' }, { name: 'write' }, { name: 'report' }, { name: 'notify_parent' }, { name: 'nodes_chat_send' }]
};
const clone = value => structuredClone(value);

test('seven fixed slots plus three native Luna AgentNodes and independently connected Chats', () => {
  const { definition: team, layout } = createTemplate();
  assert.equal(team.schemaVersion, 2);
  assert.equal(team.agents.length, SLOTS.length + 3);
  assert.equal(team.agents.filter(a => a.slot === LUNA_SLOT).length, 3);
  assert.equal(team.authorityEdges.length, 9);
  assert.equal(team.communicationEdges.length, 0, 'Authority creates effective Communication without stored duplicates');
  assert.equal(team.chats.length, 3);
  assert.equal(team.chatConnections.length, 6);
  assert.equal(team.agents.find(a => a.id === team.entryAgentId)?.slot, 'entry');
  assert.deepEqual(validateTeam(team, catalog), []);
  for (const chat of team.chats) {
    assert(allowedChat(team, chat.lunaId, chat.id));
    assert(allowedChat(team, team.entryAgentId, chat.id));
    assert(layout.nodes[chat.id]);
    assert(layout.nodes[chat.lunaId]);
  }
});

test('authority cycles, double managers, fake slots and spoofed entry are rejected', () => {
  const team = createTemplate().definition;
  const [entry, secretary, worker] = team.agents;
  const altered = clone(team);
  altered.authorityEdges.push({ id: 'extra', from: worker.id, to: secretary.id });
  assert(validateTeam(altered, catalog).some(e => e.code === 'MULTIPLE_MANAGERS'));
  const cyclic = clone(team);
  cyclic.authorityEdges.push({ id: 'cycle', from: secretary.id, to: entry.id });
  assert(validateTeam(cyclic, catalog).some(e => e.code === 'AUTHORITY_CYCLE'));
  const duplicate = clone(team);
  duplicate.agents[1].slot = 'entry';
  assert(validateTeam(duplicate, catalog).some(e => e.code === 'INVALID_SLOT'));
  const spoofed = clone(team);
  spoofed.entryAgentId = secretary.id;
  assert(validateTeam(spoofed, catalog).some(e => e.code === 'ENTRY_REQUIRED'));
});

test('tool and skill catalog, native capability floor, and deny-wins', () => {
  const def = createTemplate().definition;
  const worker = def.agents.find(a => a.slot === 'worker-1');
  worker.capabilities.grants = [
    { kind: 'tool', id: 'write', mode: 'allow' },
    { kind: 'tool', id: 'write', mode: 'deny' },
    { kind: 'tool', id: 'read', mode: 'allow' }
  ];
  assert.deepEqual(validateTeam(def, catalog), []);
  assert.deepEqual(effectiveTools(worker, ['write']), { deny: ['write'], allow: ['read'], hasAllowlist: true });
  assert.deepEqual(effectiveTools({ capabilities: { grants: worker.capabilities.grants.slice(0, 2) } }),
    { deny: ['write'], allow: [], hasAllowlist: true });
  assert.deepEqual(effectiveTools({ capabilities: { grants: [] } }),
    { deny: [], allow: [], hasAllowlist: false });
  worker.capabilities.grants.push({ kind: 'skill', id: 'sample-skill', mode: 'allow' });
  assert.deepEqual(validateTeam(def, catalog), []);
  worker.capabilities.grants = [{ kind: 'skill', id: 'missing-skill', mode: 'allow' }];
  assert(validateTeam(def, catalog).some(e => e.code === 'INVALID_SKILL'));
  worker.capabilities.grants = [{ kind: 'skill', id: 'postman-worker', mode: 'deny' }];
  assert(validateTeam(def, catalog).some(e => e.code === 'REQUIRED_NATIVE_SKILL'));
  worker.capabilities.grants = [{ kind: 'tool', id: 'report', mode: 'deny' }];
  assert(validateTeam(def, catalog).some(e => e.code === 'FIXED_NATIVE_TOOL'));
  worker.capabilities.grants = [{ kind: 'tool', id: 'nodes_chat_send', mode: 'deny' }];
  assert.deepEqual(validateTeam(def, catalog), [], 'chat tool remains optional and deny-wins');
});

test('direct Authority grants reciprocal effective Communication, not transitive, and independent edges remain directed', () => {
  const t = createTemplate().definition, entry = t.entryAgentId;
  const worker = t.agents.find(a => a.slot === 'worker-1').id;
  const solWorker = t.agents.find(a => a.slot === 'sol-worker-1').id;
  assert.equal(allowedMessage(t, entry, worker), true);
  assert.equal(allowedMessage(t, worker, entry), true);
  assert.equal(allowedAssignment(t, entry, worker), true);
  assert.equal(allowedAssignment(t, worker, entry), false);
  assert.equal(allowedMessage(t, entry, solWorker), false);
  t.communicationEdges.push({ id: 'independent', from: worker, to: solWorker });
  assert.equal(allowedMessage(t, worker, solWorker), true);
  assert.equal(allowedMessage(t, solWorker, worker), false);
  assert.equal(allowedAssignment(t, worker, solWorker), false);
});

test('legacy Luna/Chat IDs and non-Authority communication survive deterministic copy-only migration', () => {
  const source = createTemplate().definition, legacy = structuredClone(source);
  legacy.schemaVersion = 1;
  legacy.lunas = source.chats.map(chat => ({
    id: chat.lunaId, kind: 'luna-bridge', chatNodeId: chat.id,
    displayName: source.agents.find(a => a.id === chat.lunaId).displayName
  }));
  legacy.agents = legacy.agents.filter(a => a.slot !== LUNA_SLOT);
  legacy.authorityEdges = legacy.authorityEdges.filter(e =>
    legacy.agents.some(a => a.id === e.to));
  legacy.communicationEdges = legacy.authorityEdges.flatMap(e => [
    { id: 'forward:' + e.id, from: e.from, to: e.to },
    { id: 'reverse:' + e.id, from: e.to, to: e.from }
  ]);
  const [a, b] = legacy.agents.filter(a => a.slot.startsWith('worker-')).map(a => a.id);
  legacy.communicationEdges.push({ id: 'independent', from: a, to: b });
  delete legacy.chats; delete legacy.chatConnections;
  const saved = clone(legacy);
  const migrated = normalizeTeam(legacy);
  assert.deepEqual(legacy, saved, 'read does not mutate persisted v1');
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.agents.length, SLOTS.length + 3);
  assert.deepEqual(migrated.agents.filter(a => a.slot === LUNA_SLOT).map(a => a.id),
    saved.lunas.map(l => l.id));
  assert.deepEqual(migrated.chats.map(c => c.id), saved.lunas.map(l => l.chatNodeId));
  assert.deepEqual(migrated.communicationEdges.map(e => e.id), ['independent']);
  assert.deepEqual(normalizeTeam(migrated), migrated, 'migration is idempotent');
  assert.deepEqual(validateTeam(migrated, catalog), []);
});

test('invalid chat connection or cross-node identity fails validation', () => {
  const source = createTemplate().definition;
  const missing = clone(source); missing.chatConnections.push({
    id: 'fake', agentId: 'foreign-agent', chatNodeId: source.chats[0].id
  });
  assert(validateTeam(missing, catalog).some(e => e.code === 'CHAT_CONNECTION_INVALID'));
  const dup = clone(source); dup.chats[1].id = dup.chats[0].id;
  assert(validateTeam(dup, catalog).some(e => e.code === 'CHAT_INVALID'));
});
