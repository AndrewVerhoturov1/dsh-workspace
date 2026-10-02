'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine.js');

const { SIDES } = engine;

function tile(a, b) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return { id: `${low}-${high}`, a: low, b: high };
}

test('double-six set contains 28 unique canonical tiles', () => {
  const set = engine.buildSet();
  assert.equal(set.length, 28);
  assert.equal(new Set(set.map((item) => item.id)).size, 28);
  assert.ok(set.every((item) => item.a <= item.b));
  assert.ok(set.some((item) => item.id === '0-0'));
  assert.ok(set.some((item) => item.id === '6-6'));
});

test('starting tile prefers the highest double across both hands', () => {
  const result = engine.chooseStartingTile({
    [SIDES.PLAYER]: [tile(6, 6), tile(5, 6)],
    [SIDES.COMPUTER]: [tile(4, 4), tile(6, 5)],
  });
  assert.equal(result.side, SIDES.PLAYER);
  assert.equal(result.tile.id, '6-6');
});

test('starting tile falls back to highest pip sum when there is no double', () => {
  const result = engine.chooseStartingTile({
    [SIDES.PLAYER]: [tile(0, 6), tile(2, 5)],
    [SIDES.COMPUTER]: [tile(5, 6), tile(3, 4)],
  });
  assert.equal(result.side, SIDES.COMPUTER);
  assert.equal(result.tile.id, '5-6');
});

test('orientation preserves matching ends on both sides of the chain', () => {
  const chain = [{ id: '2-5', left: 2, right: 5 }];
  const left = engine.orientForSide(tile(2, 6), 'left', chain);
  const right = engine.orientForSide(tile(1, 5), 'right', chain);
  assert.deepEqual(left, { id: '2-6', left: 6, right: 2 });
  assert.deepEqual(right, { id: '1-5', left: 5, right: 1 });

  const extended = [left, chain[0], right];
  assert.deepEqual(engine.chainEnds(extended), { left: 6, right: 1 });
  assert.equal(extended[0].right, extended[1].left);
  assert.equal(extended[1].right, extended[2].left);
});

test('draw-until-playable stops at the first tile that creates a legal move', () => {
  const chain = [{ id: '2-3', left: 2, right: 3 }];
  const result = engine.drawUntilPlayableFrom(
    [tile(5, 6)],
    [tile(0, 1), tile(3, 6), tile(2, 2)],
    chain,
  );

  assert.deepEqual(result.drawn.map((item) => item.id), ['0-1', '3-6']);
  assert.equal(result.playable, true);
  assert.deepEqual(result.boneyard.map((item) => item.id), ['2-2']);
  assert.ok(engine.hasLegalMove(result.hand, chain));
});

test('fish resolution uses remaining pip sums and supports a draw', () => {
  const playerWin = engine.resolveFish({
    [SIDES.PLAYER]: [tile(0, 1), tile(1, 1)],
    [SIDES.COMPUTER]: [tile(5, 6)],
  });
  assert.equal(playerWin.winner, SIDES.PLAYER);
  assert.equal(playerWin.playerPips, 3);
  assert.equal(playerWin.computerPips, 11);

  const draw = engine.resolveFish({
    [SIDES.PLAYER]: [tile(1, 5)],
    [SIDES.COMPUTER]: [tile(2, 4)],
  });
  assert.equal(draw.winner, 'draw');
});

test('new game keeps all 28 tiles exactly once after automatic opening move', () => {
  const game = engine.createGame({ rng: () => 0.37 });
  const state = game.getState();
  assert.equal(state.chain.length, 1);
  assert.equal(state.hands[SIDES.PLAYER].length + state.hands[SIDES.COMPUTER].length, 13);
  assert.equal(state.boneyard.length, 14);
  assert.equal(engine.validateState(state), true);
});

test('every player move offered by the engine is legal and preserves inventory', () => {
  const game = engine.createGame({ rng: () => 0.63 });
  let state = game.getState();

  if (state.turn === SIDES.COMPUTER) {
    game.computerStep();
    state = game.getState();
  }

  if (state.phase === 'playing' && state.turn === SIDES.PLAYER) {
    let moves = game.getMoves(SIDES.PLAYER);
    if (!moves.length && state.boneyard.length) {
      game.drawUntilPlayable(SIDES.PLAYER);
      state = game.getState();
      moves = game.getMoves(SIDES.PLAYER);
    }
    if (moves.length) {
      const move = moves[0];
      game.play(SIDES.PLAYER, move.tileId, move.side);
      assert.equal(engine.validateState(game.getState()), true);
    }
  }
});

test('computer strategy always selects one of its legal placements', () => {
  const game = engine.createGame({ rng: () => 0.11 });
  let state = game.getState();

  if (state.turn === SIDES.PLAYER) {
    let moves = game.getMoves(SIDES.PLAYER);
    if (!moves.length && state.boneyard.length) {
      game.drawUntilPlayable(SIDES.PLAYER);
      moves = game.getMoves(SIDES.PLAYER);
    }
    if (moves.length) {
      game.play(SIDES.PLAYER, moves[0].tileId, moves[0].side);
    } else if (game.getState().boneyard.length === 0) {
      game.pass(SIDES.PLAYER);
    }
  }

  state = game.getState();
  if (state.phase === 'playing' && state.turn === SIDES.COMPUTER) {
    const legalBefore = game.getMoves(SIDES.COMPUTER);
    const result = game.computerStep();
    const play = result.events.find((event) => event.type === 'play');
    if (legalBefore.length && play) {
      assert.ok(legalBefore.some((move) => move.tileId === play.tileId && move.side === play.placement));
    }
    assert.equal(engine.validateState(game.getState()), true);
  }
});

test('reset starts a fresh valid game without retaining previous chain state', () => {
  let call = 0;
  const game = engine.createGame({ rng: () => (call++ % 7) / 7 });
  const first = game.getState();
  game.reset();
  const second = game.getState();

  assert.equal(first.chain.length, 1);
  assert.equal(second.chain.length, 1);
  assert.equal(second.consecutivePasses, 0);
  assert.equal(second.phase, 'playing');
  assert.equal(engine.validateState(second), true);
});
