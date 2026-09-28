'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MinesweeperGame, validateConfig } = require('./minesweeper-logic.js');

function deterministicRng(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('first reveal is safe and protects its neighborhood when density allows it', () => {
  const game = new MinesweeperGame({ rows: 9, cols: 9, mines: 10 }, { rng: deterministicRng(42) });
  const result = game.reveal(4, 4);

  assert.equal(result.exploded, false);
  assert.equal(game.getCell(4, 4).mine, false);
  assert.equal(game.cells.filter((cell) => cell.mine).length, 10);

  const center = game.index(4, 4);
  for (const index of [center, ...game.neighborsOfIndex(center)]) {
    assert.equal(game.cells[index].mine, false);
  }
});


test('first reveal stays safe even at maximum mine density', () => {
  const game = new MinesweeperGame({ rows: 5, cols: 5, mines: 24 }, { rng: deterministicRng(5) });
  const result = game.reveal(2, 2);

  assert.equal(result.exploded, false);
  assert.equal(game.getCell(2, 2).mine, false);
  assert.equal(game.cells.filter((cell) => cell.mine).length, 24);
  assert.equal(game.state, 'won');
});

test('zero-valued cells expand a safe region', () => {
  const game = new MinesweeperGame({ rows: 5, cols: 5, mines: 1 }, { rng: deterministicRng(7) });
  game.reveal(2, 2);

  assert.ok(game.revealedCount > 1);
  assert.notEqual(game.state, 'lost');
});

test('flags update the mine counter and revealed cells cannot be flagged', () => {
  const game = new MinesweeperGame({ rows: 9, cols: 9, mines: 10 }, { rng: deterministicRng(3) });

  assert.equal(game.remainingMines(), 10);
  assert.equal(game.toggleFlag(0, 0).flagged, true);
  assert.equal(game.remainingMines(), 9);
  assert.equal(game.toggleFlag(0, 0).flagged, false);
  assert.equal(game.remainingMines(), 10);

  game.reveal(4, 4);
  assert.equal(game.toggleFlag(4, 4).changed, false);
});

test('a mine ends the game and all subsequent moves are locked', () => {
  const game = new MinesweeperGame({ rows: 9, cols: 9, mines: 10 }, { rng: deterministicRng(12) });
  game.reveal(4, 4);

  const mineIndex = game.cells.findIndex((cell) => cell.mine);
  const mine = game.coords(mineIndex);
  const result = game.reveal(mine.row, mine.col);

  assert.equal(result.exploded, true);
  assert.equal(game.state, 'lost');
  assert.equal(game.toggleFlag(0, 0).changed, false);
  assert.equal(game.reveal(0, 0).changed, false);
});

test('revealing every safe cell wins and locks the board', () => {
  const game = new MinesweeperGame({ rows: 5, cols: 5, mines: 3 }, { rng: deterministicRng(99) });
  game.reveal(0, 0);

  for (let index = 0; index < game.cells.length && game.state === 'playing'; index += 1) {
    if (!game.cells[index].mine && !game.cells[index].revealed) {
      const { row, col } = game.coords(index);
      game.reveal(row, col);
    }
  }

  assert.equal(game.state, 'won');
  assert.equal(game.revealedCount, game.cells.length - game.mines);
  assert.equal(game.toggleFlag(0, 1).changed, false);
});

test('custom configuration limits are enforced', () => {
  assert.doesNotThrow(() => validateConfig(16, 30, 99));
  assert.throws(() => validateConfig(4, 9, 10), /rows/);
  assert.throws(() => validateConfig(9, 37, 10), /cols/);
  assert.throws(() => validateConfig(5, 5, 25), /mines/);
});
