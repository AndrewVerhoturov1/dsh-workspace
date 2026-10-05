import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  DECLARED_PORTS,
  EARLY_C2_SHIELD_DELTA,
  RESEARCH_CATALOGUE,
  catalogueQuantitySum,
  regionIds,
  rotateNESW,
  rotatePort,
  rotateResearchTile,
} from '../research-data.mjs';

const byId = (id) => RESEARCH_CATALOGUE.find((tile) => tile.id === id);

test('research catalogue has 24 types and 72 total tiles including one start', () => {
  assert.equal(RESEARCH_CATALOGUE.length, 24);
  assert.equal(catalogueQuantitySum(), 72);
  assert.equal(RESEARCH_CATALOGUE.reduce((sum, tile) => sum + tile.startCount, 0), 1);
  assert.equal(byId('D').quantity, 4);
  assert.equal(byId('D').startCount, 1);
});

test('all declared component ports are from the research notation', () => {
  const allowed = new Set(DECLARED_PORTS);
  for (const tile of RESEARCH_CATALOGUE) {
    for (const region of [...tile.cities, ...tile.roads, ...tile.fields]) {
      for (const port of region.ports) assert.ok(allowed.has(port), `${tile.id}/${region.id}: ${port}`);
    }
  }
});

test('four clockwise rotations return NESW and all component ports to origin', () => {
  for (const tile of RESEARCH_CATALOGUE) {
    const original = JSON.parse(JSON.stringify(tile));
    let rotated = tile;
    for (let turn = 0; turn < 4; turn += 1) rotated = rotateResearchTile(rotated, 1);

    assert.equal(rotated.nesw, original.nesw, tile.id);
    assert.deepEqual(rotated.cities, original.cities, `${tile.id}: city components`);
    assert.deepEqual(rotated.roads, original.roads, `${tile.id}: road components`);
    assert.deepEqual(rotated.fields, original.fields, `${tile.id}: field components`);
    assert.deepEqual(rotated.shields, original.shields, `${tile.id}: shields`);
    assert.equal(rotated.monastery, original.monastery, `${tile.id}: monastery`);
    assert.deepEqual(rotated.targets, original.targets, `${tile.id}: targets`);
    assert.deepEqual(tile, original, `${tile.id}: source tile mutated`);
  }
  assert.equal(rotateNESW('RCRF', 1), 'FRCR');
});

test('half-edge rotation follows the declared clockwise mapping', () => {
  assert.equal(rotatePort('Nw', 1), 'En');
  assert.equal(rotatePort('Ne', 1), 'Es');
  assert.equal(rotatePort('En', 1), 'Se');
  assert.equal(rotatePort('Es', 1), 'Sw');
  assert.equal(rotatePort('Se', 1), 'Ws');
  assert.equal(rotatePort('Sw', 1), 'Wn');
  assert.equal(rotatePort('Ws', 1), 'Nw');
  assert.equal(rotatePort('Wn', 1), 'Ne');
});

test('every meeple target refers to a real local research region', () => {
  for (const tile of RESEARCH_CATALOGUE) {
    const ids = regionIds(tile);
    for (const target of tile.targets) assert.ok(ids.has(target), `${tile.id}: missing ${target}`);
  }
});

test('critical joined vs separate city case is represented structurally', () => {
  const joined = byId('F');
  const separate = byId('H');
  assert.equal(joined.nesw, separate.nesw);
  assert.equal(joined.cities.length, 1);
  assert.deepEqual(joined.cities[0].ports, ['E', 'W']);
  assert.equal(separate.cities.length, 2);
  assert.deepEqual(separate.cities.map((city) => city.ports), [['E'], ['W']]);
  assert.equal(joined.fields.length, 2);
  assert.equal(separate.fields.length, 1);
});

test('crossroads keep independent road branches ending at village', () => {
  for (const [id, expectedRoads] of [['L', 3], ['W', 3], ['X', 4]]) {
    const tile = byId(id);
    assert.equal(tile.roads.length, expectedRoads, id);
    assert.ok(tile.roads.every((road) => road.ports.length === 1 && road.endsAt === 'V'), id);
  }
});

test('classic and documented early-C2 CFCF shield counts remain distinct and modern is unresolved', () => {
  assert.deepEqual(EARLY_C2_SHIELD_DELTA.classicC1, { joinedCfcfWithShield: 2, joinedCfcfWithoutShield: 1 });
  assert.deepEqual(EARLY_C2_SHIELD_DELTA.documentedEarlyC2, { joinedCfcfWithShield: 1, joinedCfcfWithoutShield: 2 });
  assert.equal(EARLY_C2_SHIELD_DELTA.modernC2C3, 'unresolved-per-print');
});


test('concept C gallery references the three byte-identical supplied PNG assets', async () => {
  const expected = new Map([
    ['roads-fields-c.png', '5ef09539b4806b0b5959c3f033908f7d8aa5f7407baf558e771e7ece0d1c9f93'],
    ['cities-c.png', '3590dab3b51ea1dc2f0ed58220a913a83e751297df299761869f7b0eb8824fb3'],
    ['monastery-c.png', '0678a57ab50d11e683fcb7681f37720df80e142e7f0cc9c297b0a6827dded09f'],
  ]);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const pageSources = `${html}\n${app}`;

  for (const [name, sha256] of expected) {
    const bytes = await readFile(new URL(`../references/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, name);
    assert.ok(pageSources.includes(`./references/${name}`), `${name}: missing page reference`);
  }
});

test('new beginner lessons are supported by the existing structural data', () => {
  const d = byId('D');
  const u = byId('U');
  const w = byId('W');
  const b = byId('B');

  assert.equal(d.nesw, 'RCRF');
  assert.equal(d.cities.length, 1);
  assert.deepEqual(d.roads.map((road) => road.ports), [['N', 'S']]);
  assert.equal(d.fields.length, 2);

  assert.equal(u.roads.length, 1);
  assert.deepEqual(u.roads[0].ports, ['N', 'S']);
  assert.equal(w.roads.length, 3);
  assert.ok(w.roads.every((road) => road.endsAt === 'V' && road.ports.length === 1));

  assert.equal(b.fields.length, 1);
  assert.equal(b.monastery, 'M1');
  assert.equal(u.fields.length, 2);

  assert.equal(u.nesw[2], d.nesw[0], 'U south road should meet D north road in the fitting example');
  assert.equal(d.nesw[1], 'C');
  assert.equal(u.nesw[3], 'F');
  assert.notEqual(d.nesw[1], u.nesw[3], 'D east city should not match U west field');
});
