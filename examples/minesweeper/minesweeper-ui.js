(function () {
  'use strict';

  const { MinesweeperGame, LIMITS } = window.MinesweeperLogic;

  const PRESETS = Object.freeze({
    beginner: { label: 'Новичок', rows: 9, cols: 9, mines: 10 },
    intermediate: { label: 'Опытный', rows: 16, cols: 16, mines: 40 },
    expert: { label: 'Эксперт', rows: 16, cols: 30, mines: 99 },
  });

  const els = {
    board: document.querySelector('[data-board]'),
    boardShell: document.querySelector('[data-board-shell]'),
    status: document.querySelector('[data-status]'),
    statusDot: document.querySelector('[data-status-dot]'),
    mineCount: document.querySelector('[data-mine-count]'),
    timer: document.querySelector('[data-timer]'),
    restart: document.querySelector('[data-restart]'),
    presetButtons: Array.from(document.querySelectorAll('[data-preset]')),
    toolButtons: Array.from(document.querySelectorAll('[data-tool]')),
    customForm: document.querySelector('[data-custom-form]'),
    rows: document.querySelector('[name="rows"]'),
    cols: document.querySelector('[name="cols"]'),
    mines: document.querySelector('[name="mines"]'),
    customHint: document.querySelector('[data-custom-hint]'),
    modeText: document.querySelector('[data-mode-text]'),
  };

  let currentConfig = { ...PRESETS.beginner };
  let game = null;
  let activeTool = 'reveal';
  let focusedIndex = 0;
  let elapsedSeconds = 0;
  let timerId = null;
  let lastState = 'ready';

  function icon(type) {
    if (type === 'flag') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 21V3.5m.2 1h10.6l-2.2 3 2.2 3H6.7M4 21h6"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="5.4"/><path d="M12 2.7v3M12 20.3v1M2.8 13h3M18.2 13h3M5.4 6.4l2.1 2.1m9-2.1-2.1 2.1M5.4 19.6l2.1-2.1m9 2.1-2.1-2.1M14.8 5.7l1.8-2.2 1.4 1.1"/></svg>';
  }

  function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function formatCounter(value) {
    if (value < 0) return `−${String(Math.min(99, Math.abs(value))).padStart(2, '0')}`;
    return String(Math.min(999, value)).padStart(3, '0');
  }

  function startTimer() {
    if (timerId !== null) return;
    timerId = window.setInterval(() => {
      elapsedSeconds += 1;
      els.timer.textContent = formatTime(elapsedSeconds);
    }, 1000);
  }

  function stopTimer() {
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
  }

  function resetTimer() {
    stopTimer();
    elapsedSeconds = 0;
    els.timer.textContent = '00:00';
  }

  function stateCopy() {
    if (game.state === 'won') return `Поле очищено за ${formatTime(elapsedSeconds)}. Отличная работа.`;
    if (game.state === 'lost') return 'Мина сработала. Поле заблокировано — начните новую партию.';
    if (game.state === 'playing') return 'Игра идёт. Двойной щелчок по числу открывает соседей при верных флажках.';
    return 'Поле готово. Первый раскрытый квадрат всегда безопасен.';
  }

  function setStatus() {
    els.status.textContent = stateCopy();
    els.statusDot.dataset.state = game.state;
    els.boardShell.dataset.state = game.state;
  }

  function cellLabel(index) {
    const cell = game.cells[index];
    const { row, col } = game.coords(index);
    const prefix = `Строка ${row + 1}, столбец ${col + 1}.`;

    if (game.state === 'lost' && cell.mine) {
      return `${prefix} Мина${index === game.explodedIndex ? ', сработала' : ''}.`;
    }
    if (game.state === 'won' && cell.mine) {
      return `${prefix} Мина, обезврежена.`;
    }
    if (cell.flagged) return `${prefix} Флажок.`;
    if (!cell.revealed) return `${prefix} Закрытая клетка.`;
    if (cell.adjacent === 0) return `${prefix} Открытая пустая клетка.`;
    return `${prefix} Открытая клетка, мин рядом: ${cell.adjacent}.`;
  }

  function renderCell(button, index) {
    const cell = game.cells[index];
    const showMine = (game.state === 'lost' || game.state === 'won') && cell.mine;
    const wrongFlag = game.state === 'lost' && cell.flagged && !cell.mine;
    const classes = ['cell'];

    button.replaceChildren();
    button.removeAttribute('data-number');

    if (cell.revealed) classes.push('cell--revealed');
    if (cell.flagged) classes.push('cell--flagged');
    if (showMine) classes.push('cell--mine');
    if (index === game.explodedIndex) classes.push('cell--exploded');
    if (wrongFlag) classes.push('cell--wrong-flag');

    if (cell.revealed && !cell.mine && cell.adjacent > 0) {
      classes.push(`cell--n${cell.adjacent}`);
      button.dataset.number = String(cell.adjacent);
      const number = document.createElement('span');
      number.className = 'cell__number';
      number.textContent = String(cell.adjacent);
      button.append(number);
    } else if (showMine) {
      button.innerHTML = `<span class="cell__icon cell__icon--mine">${icon('mine')}</span>`;
    } else if (cell.flagged) {
      button.innerHTML = `<span class="cell__icon cell__icon--flag">${icon('flag')}</span>`;
    }

    if (wrongFlag) {
      const mark = document.createElement('span');
      mark.className = 'cell__wrong-mark';
      mark.textContent = '×';
      mark.setAttribute('aria-hidden', 'true');
      button.append(mark);
    }

    button.className = classes.join(' ');
    button.setAttribute('aria-label', cellLabel(index));
    button.setAttribute('aria-pressed', cell.flagged ? 'true' : 'false');
    button.tabIndex = index === focusedIndex ? 0 : -1;
    button.disabled = game.state === 'won' || game.state === 'lost';
  }

  function render() {
    els.mineCount.textContent = formatCounter(game.remainingMines());
    setStatus();

    const cells = els.board.querySelectorAll('.cell');
    cells.forEach((button, index) => renderCell(button, index));

    if (lastState !== game.state) {
      if (game.state === 'won' || game.state === 'lost') stopTimer();
      lastState = game.state;
    }
  }

  function buildBoard() {
    els.board.replaceChildren();
    els.board.style.setProperty('--cols', String(game.cols));
    els.board.setAttribute('aria-rowcount', String(game.rows));
    els.board.setAttribute('aria-colcount', String(game.cols));

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < game.cells.length; index += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cell';
      button.dataset.index = String(index);
      button.setAttribute('role', 'gridcell');
      const { row, col } = game.coords(index);
      button.setAttribute('aria-rowindex', String(row + 1));
      button.setAttribute('aria-colindex', String(col + 1));
      fragment.append(button);
    }
    els.board.append(fragment);
  }

  function syncPresetButtons(presetKey) {
    els.presetButtons.forEach((button) => {
      const active = button.dataset.preset === presetKey;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function updateModeText() {
    const preset = Object.values(PRESETS).find(
      (candidate) => candidate.rows === currentConfig.rows && candidate.cols === currentConfig.cols && candidate.mines === currentConfig.mines,
    );
    els.modeText.textContent = preset
      ? `${preset.label} · ${currentConfig.rows}×${currentConfig.cols} · ${currentConfig.mines} мин`
      : `Своя игра · ${currentConfig.rows}×${currentConfig.cols} · ${currentConfig.mines} мин`;
  }

  function newGame(config, presetKey = null) {
    currentConfig = { ...config };
    game = new MinesweeperGame(currentConfig);
    focusedIndex = 0;
    lastState = 'ready';
    resetTimer();
    syncPresetButtons(presetKey);
    updateModeText();
    buildBoard();
    render();
    els.boardShell.scrollTo({ left: 0, top: 0, behavior: 'auto' });
  }

  function actOnIndex(index, action) {
    if (game.state === 'won' || game.state === 'lost') return;
    const { row, col } = game.coords(index);
    const beforeState = game.state;

    if (action === 'flag') {
      game.toggleFlag(row, col);
    } else if (action === 'chord') {
      game.chord(row, col);
    } else {
      game.reveal(row, col);
    }

    if (beforeState === 'ready' && game.state === 'playing') startTimer();
    render();
  }

  function primaryAction(index) {
    actOnIndex(index, activeTool === 'flag' ? 'flag' : 'reveal');
  }

  function setTool(tool) {
    activeTool = tool;
    els.toolButtons.forEach((button) => {
      const active = button.dataset.tool === tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function moveFocus(index, key) {
    const { row, col } = game.coords(index);
    let nextRow = row;
    let nextCol = col;

    if (key === 'ArrowUp') nextRow = Math.max(0, row - 1);
    if (key === 'ArrowDown') nextRow = Math.min(game.rows - 1, row + 1);
    if (key === 'ArrowLeft') nextCol = Math.max(0, col - 1);
    if (key === 'ArrowRight') nextCol = Math.min(game.cols - 1, col + 1);
    if (key === 'Home') nextCol = 0;
    if (key === 'End') nextCol = game.cols - 1;

    const nextIndex = game.index(nextRow, nextCol);
    if (nextIndex === focusedIndex) return;

    const previous = els.board.querySelector(`[data-index="${focusedIndex}"]`);
    const next = els.board.querySelector(`[data-index="${nextIndex}"]`);
    if (previous) previous.tabIndex = -1;
    focusedIndex = nextIndex;
    if (next) {
      next.tabIndex = 0;
      next.focus({ preventScroll: false });
    }
  }

  function updateCustomHint() {
    const rows = Number(els.rows.value);
    const cols = Number(els.cols.value);
    const cells = Number.isFinite(rows * cols) ? rows * cols : 0;
    const maxMines = Math.max(1, Math.min(LIMITS.maxMines, cells - 1));
    els.mines.max = String(maxMines);
    els.customHint.textContent = `Предел: ${LIMITS.minRows}–${LIMITS.maxRows} строк, ${LIMITS.minCols}–${LIMITS.maxCols} столбцов, до ${maxMines} мин для этого поля.`;
  }

  els.presetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.preset;
      newGame(PRESETS[key], key);
    });
  });

  els.toolButtons.forEach((button) => {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  });

  els.restart.addEventListener('click', () => {
    const key = Object.keys(PRESETS).find((presetKey) => {
      const preset = PRESETS[presetKey];
      return preset.rows === currentConfig.rows && preset.cols === currentConfig.cols && preset.mines === currentConfig.mines;
    });
    newGame(currentConfig, key || null);
  });

  els.customForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const rows = Number(els.rows.value);
    const cols = Number(els.cols.value);
    const mines = Number(els.mines.value);

    try {
      const custom = new MinesweeperGame({ rows, cols, mines });
      newGame({ rows: custom.rows, cols: custom.cols, mines: custom.mines }, null);
      els.customHint.textContent = 'Своя игра создана. Первый ход безопасен.';
    } catch (error) {
      els.customHint.textContent = error.message;
      els.customHint.dataset.error = 'true';
      window.setTimeout(() => {
        delete els.customHint.dataset.error;
        updateCustomHint();
      }, 3200);
    }
  });

  [els.rows, els.cols].forEach((input) => input.addEventListener('input', updateCustomHint));

  els.board.addEventListener('click', (event) => {
    const button = event.target.closest('.cell');
    if (!button) return;
    focusedIndex = Number(button.dataset.index);
    primaryAction(focusedIndex);
  });

  els.board.addEventListener('contextmenu', (event) => {
    const button = event.target.closest('.cell');
    if (!button) return;
    event.preventDefault();
    focusedIndex = Number(button.dataset.index);
    actOnIndex(focusedIndex, 'flag');
  });

  els.board.addEventListener('dblclick', (event) => {
    const button = event.target.closest('.cell');
    if (!button) return;
    event.preventDefault();
    focusedIndex = Number(button.dataset.index);
    actOnIndex(focusedIndex, 'chord');
  });

  els.board.addEventListener('focusin', (event) => {
    const button = event.target.closest('.cell');
    if (!button) return;
    const index = Number(button.dataset.index);
    if (index !== focusedIndex) {
      const previous = els.board.querySelector(`[data-index="${focusedIndex}"]`);
      if (previous) previous.tabIndex = -1;
      focusedIndex = index;
      button.tabIndex = 0;
    }
  });

  els.board.addEventListener('keydown', (event) => {
    const button = event.target.closest('.cell');
    if (!button) return;
    const index = Number(button.dataset.index);

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      moveFocus(index, event.key);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      primaryAction(index);
      return;
    }

    if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      actOnIndex(index, 'flag');
      return;
    }

    if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      actOnIndex(index, 'reveal');
    }
  });

  updateCustomHint();
  setTool('reveal');
  newGame(PRESETS.beginner, 'beginner');
})();
