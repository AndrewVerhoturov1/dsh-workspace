import assert from 'node:assert/strict';
import test from 'node:test';
import { createTemplate, SLOTS, validateTeam, effectiveTools, allowedMessage, allowedAssignment } from '../lib/domain.js';

const catalog = {
  models: [{ provider: 'codex', models: [...new Set(SLOTS.map(s => s.model))].map(id => ({ id, reasoningEfforts: ['low','xhigh','max'] })) }],
  skills: { supported: true, items: [{ name: 'sample-skill' }, { name: 'postman-worker' }] },
  nativeSlots: SLOTS.map(s => ({ id:s.id, requiredTools:['report','notify_parent'], deniedTools:[] })),
  tools: [{ name: 'read' }, { name: 'write' }, { name: 'report' }, { name: 'notify_parent' }]
};
const clone = value => structuredClone(value);

test('native Postman template is one seven-slot authority/communication graph', () => {
  const team = createTemplate();
  assert.equal(team.definition.agents.length, SLOTS.length);
  assert.equal(team.definition.authorityEdges.length, 6);
  assert.equal(team.definition.communicationEdges.length, 12);
  assert.equal(team.definition.agents.find(a => a.id === team.definition.entryAgentId)?.slot, 'entry');
  assert.deepEqual(validateTeam(team.definition, catalog), []);
  assert.equal(team.layout.teamId, team.definition.id);
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
});

test('directed Communication never confers Task authority', () => {
  const t = createTemplate().definition;
  const entry = t.entryAgentId;
  const worker = t.agents.find(a => a.slot === 'worker-1').id;
  assert.equal(allowedMessage(t, entry, worker), true);
  assert.equal(allowedAssignment(t, entry, worker), true);
  assert.equal(allowedAssignment(t, worker, entry), false);
  assert.equal(allowedMessage(t, worker, entry), true);
});
