(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.MinesweeperLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({
    minRows: 5,
    maxRows: 24,
    minCols: 5,
    maxCols: 36,
    maxMines: 500,
  });

  function assertInteger(value, name) {
    if (!Number.isInteger(value)) {
      throw new TypeError(`${name} должен быть целым числом`);
    }
  }

  function validateConfig(rows, cols, mines) {
    assertInteger(rows, 'rows');
    assertInteger(cols, 'cols');
    assertInteger(mines, 'mines');

    if (rows < LIMITS.minRows || rows > LIMITS.maxRows) {
      throw new RangeError(`rows должен быть от ${LIMITS.minRows} до ${LIMITS.maxRows}`);
    }
    if (cols < LIMITS.minCols || cols > LIMITS.maxCols) {
      throw new RangeError(`cols должен быть от ${LIMITS.minCols} до ${LIMITS.maxCols}`);
    }

    const cells = rows * cols;
    const maxAllowed = Math.min(LIMITS.maxMines, cells - 1);
    if (mines < 1 || mines > maxAllowed) {
      throw new RangeError(`mines должен быть от 1 до ${maxAllowed}`);
    }
  }

  class MinesweeperGame {
    constructor(config, options = {}) {
      const { rows, cols, mines } = config;
      validateConfig(rows, cols, mines);

      this.rows = rows;
      this.cols = cols;
      this.mines = mines;
      this.rng = typeof options.rng === 'function' ? options.rng : Math.random;
      this.reset();
    }

    reset() {
      this.cells = Array.from({ length: this.rows * this.cols }, () => ({
        mine: false,
        adjacent: 0,
        revealed: false,
        flagged: false,
      }));
      this.state = 'ready';
      this.minesPlaced = false;
      this.revealedCount = 0;
      this.flaggedCount = 0;
      this.explodedIndex = -1;
    }

    inBounds(row, col) {
      return row >= 0 && row < this.rows && col >= 0 && col < this.cols;
    }

    index(row, col) {
      if (!this.inBounds(row, col)) {
        throw new RangeError(`Координаты вне поля: ${row}, ${col}`);
      }
      return row * this.cols + col;
    }

    coords(index) {
      if (!Number.isInteger(index) || index < 0 || index >= this.cells.length) {
        throw new RangeError(`Индекс вне поля: ${index}`);
      }
      return { row: Math.floor(index / this.cols), col: index % this.cols };
    }

    getCell(row, col) {
      return this.cells[this.index(row, col)];
    }

    neighborsOfIndex(index) {
      const { row, col } = this.coords(index);
      const result = [];
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const nextRow = row + dr;
          const nextCol = col + dc;
          if (this.inBounds(nextRow, nextCol)) {
            result.push(nextRow * this.cols + nextCol);
          }
        }
      }
      return result;
    }

    _placeMines(firstIndex) {
      const preferredSafe = new Set([firstIndex, ...this.neighborsOfIndex(firstIndex)]);
      const canProtectNeighborhood = this.cells.length - preferredSafe.size >= this.mines;
      const safe = canProtectNeighborhood ? preferredSafe : new Set([firstIndex]);

      const candidates = [];
      for (let i = 0; i < this.cells.length; i += 1) {
        if (!safe.has(i)) candidates.push(i);
      }

      for (let i = candidates.length - 1; i > 0; i -= 1) {
        const random = Number(this.rng());
        const normalized = Number.isFinite(random) ? Math.min(Math.max(random, 0), 0.999999999999) : 0;
        const j = Math.floor(normalized * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }

      for (let i = 0; i < this.mines; i += 1) {
        this.cells[candidates[i]].mine = true;
      }

      for (let i = 0; i < this.cells.length; i += 1) {
        if (this.cells[i].mine) continue;
        this.cells[i].adjacent = this.neighborsOfIndex(i).reduce(
          (count, neighborIndex) => count + (this.cells[neighborIndex].mine ? 1 : 0),
          0,
        );
      }

      this.minesPlaced = true;
    }

    _finishIfWon() {
      if (this.state === 'lost') return false;
      if (this.revealedCount === this.cells.length - this.mines) {
        this.state = 'won';
        return true;
      }
      return false;
    }

    reveal(row, col) {
      const startIndex = this.index(row, col);
      if (this.state === 'won' || this.state === 'lost') {
        return { changed: false, exploded: false, won: this.state === 'won', revealed: [] };
      }

      const startCell = this.cells[startIndex];
      if (startCell.revealed || startCell.flagged) {
        return { changed: false, exploded: false, won: false, revealed: [] };
      }

      if (!this.minesPlaced) {
        this._placeMines(startIndex);
      }

      if (this.state === 'ready') {
        this.state = 'playing';
      }

      if (startCell.mine) {
        startCell.revealed = true;
        this.revealedCount += 1;
        this.explodedIndex = startIndex;
        this.state = 'lost';
        return { changed: true, exploded: true, won: false, revealed: [startIndex] };
      }

      const queue = [startIndex];
      const queued = new Set([startIndex]);
      const revealed = [];

      while (queue.length > 0) {
        const index = queue.shift();
        const cell = this.cells[index];
        if (cell.revealed || cell.flagged || cell.mine) continue;

        cell.revealed = true;
        this.revealedCount += 1;
        revealed.push(index);

        if (cell.adjacent === 0) {
          for (const neighborIndex of this.neighborsOfIndex(index)) {
            const neighbor = this.cells[neighborIndex];
            if (!neighbor.revealed && !neighbor.flagged && !neighbor.mine && !queued.has(neighborIndex)) {
              queued.add(neighborIndex);
              queue.push(neighborIndex);
            }
          }
        }
      }

      const won = this._finishIfWon();
      return { changed: revealed.length > 0, exploded: false, won, revealed };
    }

    toggleFlag(row, col) {
      const index = this.index(row, col);
      if (this.state === 'won' || this.state === 'lost') {
        return { changed: false, flagged: this.cells[index].flagged };
      }

      const cell = this.cells[index];
      if (cell.revealed) {
        return { changed: false, flagged: false };
      }

      cell.flagged = !cell.flagged;
      this.flaggedCount += cell.flagged ? 1 : -1;
      return { changed: true, flagged: cell.flagged };
    }

    chord(row, col) {
      const index = this.index(row, col);
      if (this.state !== 'playing') {
        return { changed: false, exploded: false, won: this.state === 'won', revealed: [] };
      }

      const cell = this.cells[index];
      if (!cell.revealed || cell.adjacent === 0) {
        return { changed: false, exploded: false, won: false, revealed: [] };
      }

      const neighbors = this.neighborsOfIndex(index);
      const flagCount = neighbors.reduce((count, neighborIndex) => count + (this.cells[neighborIndex].flagged ? 1 : 0), 0);
      if (flagCount !== cell.adjacent) {
        return { changed: false, exploded: false, won: false, revealed: [] };
      }

      const revealed = [];
      let changed = false;
      for (const neighborIndex of neighbors) {
        const neighbor = this.cells[neighborIndex];
        if (neighbor.revealed || neighbor.flagged) continue;
        const { row: nextRow, col: nextCol } = this.coords(neighborIndex);
        const result = this.reveal(nextRow, nextCol);
        changed = changed || result.changed;
        revealed.push(...result.revealed);
        if (result.exploded) {
          return { changed: true, exploded: true, won: false, revealed };
        }
        if (result.won) {
          return { changed: true, exploded: false, won: true, revealed };
        }
      }

      return { changed, exploded: false, won: this.state === 'won', revealed };
    }

    remainingMines() {
      return this.mines - this.flaggedCount;
    }
  }

  return Object.freeze({ MinesweeperGame, LIMITS, validateConfig });
});
