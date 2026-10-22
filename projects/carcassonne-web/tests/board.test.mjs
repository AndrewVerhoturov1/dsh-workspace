import test from 'node:test';
import assert from 'node:assert/strict';

import { RESEARCH_CATALOGUE } from '../research-data.mjs';
import {
  candidateCells,
  connectedRegionComponent,
  createInitialBoardState,
  evaluatePlacement,
  placeTile,
  resetBoard,
  totalRemaining,
  undoLast,
} from '../board.mjs';

test('initial board contains exactly one start D and 71 tiles remain', () => {
  const state = createInitialBoardState();
  assert.deepEqual(state.placements, [{ x: 0, y: 0, tileId: 'D', rotation: 0, start: true }]);
  assert.equal(totalRemaining(state), 71);
  assert.equal(state.remaining.D, 3);
  assert.equal(Object.keys(state.remaining).length, 24);
  for (const tile of RESEARCH_CATALOGUE) assert.equal(state.remaining[tile.id], tile.quantity - (tile.id === 'D' ? 1 : 0), tile.id);
  assert.deepEqual(candidateCells(state), [{ x: 0, y: -1 }, { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]);
});

test('placement checks every occupied orthogonal neighbour and leaves state unchanged on refusal', () => {
  let state = createInitialBoardState();
  state = placeTile(state, { tileId: 'H', rotation: 0, x: 1, y: 0 }).state;
  state = placeTile(state, { tileId: 'B', rotation: 0, x: 1, y: 1 }).state;

  const before = JSON.stringify(state);
  const conflict = placeTile(state, { tileId: 'D', rotation: 0, x: 0, y: 1 });
  assert.equal(conflict.verdict.ok, false);
  assert.equal(conflict.verdict.checks.length, 2);
  assert.match(conflict.verdict.reason, /Не совпадает край справа/);
  assert.equal(JSON.stringify(conflict.state), before);

  const valid = placeTile(state, { tileId: 'U', rotation: 0, x: 0, y: 1 });
  assert.equal(valid.verdict.ok, true);
  assert.equal(valid.verdict.checks.length, 2);
  assert.equal(valid.state.placements.length, 4);
  assert.equal(totalRemaining(valid.state), 68);
});

test('occupied, detached and exhausted placements are rejected without changing counts', () => {
  const state = createInitialBoardState();
  assert.match(evaluatePlacement(state, { tileId: 'U', rotation: 0, x: 0, y: 0 }).reason, /занята/);
  assert.match(evaluatePlacement(state, { tileId: 'U', rotation: 0, x: 9, y: 9 }).reason, /должна касаться/);
  const emptyB = { ...state, remaining: { ...state.remaining, B: 0 } };
  assert.match(evaluatePlacement(emptyB, { tileId: 'B', rotation: 0, x: -1, y: 0 }).reason, /закончились/);
  assert.equal(totalRemaining(state), 71);
});

test('undo and reset restore per-type and total counts while preserving the one fixed start tile', () => {
  const start = createInitialBoardState();
  const placed = placeTile(start, { tileId: 'U', rotation: 0, x: 0, y: 1 }).state;
  assert.equal(placed.remaining.U, 7);
  assert.equal(totalRemaining(placed), 70);
  const undone = undoLast(placed);
  assert.deepEqual(undone, start);
  assert.deepEqual(resetBoard(), start);
  assert.equal(undoLast(start), start);
});

test('connected component follows valid shared-edge region IDs without scoring logic', () => {
  let state = createInitialBoardState();
  state = placeTile(state, { tileId: 'U', rotation: 0, x: 0, y: 1 }).state;
  const road = connectedRegionComponent(state, { x: 0, y: 0, regionId: 'R1' });
  assert.deepEqual(road.map(({ x, y, tileId, regionId, kind }) => ({ x, y, tileId, regionId, kind })), [
    { x: 0, y: 0, tileId: 'D', regionId: 'R1', kind: 'road' },
    { x: 0, y: 1, tileId: 'U', regionId: 'R1', kind: 'road' },
  ]);
});
