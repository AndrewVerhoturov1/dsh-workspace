(function () {
  'use strict';

  const { SIDES, createGame, legalSides, chainEnds, handPipSum } = window.TavernDomino;

  const ui = {
    newGameButton: document.getElementById('newGameButton'),
    turnMessage: document.getElementById('turnMessage'),
    starterMessage: document.getElementById('starterMessage'),
    computerCount: document.getElementById('computerCount'),
    computerHand: document.getElementById('computerHand'),
    boneyardCount: document.getElementById('boneyardCount'),
    leftEnd: document.getElementById('leftEnd'),
    rightEnd: document.getElementById('rightEnd'),
    chainViewport: document.getElementById('chainViewport'),
    chain: document.getElementById('chain'),
    sideChoice: document.getElementById('sideChoice'),
    playerActions: document.getElementById('playerActions'),
    playerHand: document.getElementById('playerHand'),
    handHint: document.getElementById('handHint'),
    resultCard: document.getElementById('resultCard'),
    dominoTemplate: document.getElementById('dominoTemplate'),
  };

  const PIP_POSITIONS = {
    0: [],
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9],
  };

  let game = createGame();
  let selectedTileId = null;
  let busy = false;
  let epoch = 0;
  let timers = [];
  let lastPlacement = 'right';
  let lastChainLength = 1;
  let transientMessage = '';

  function clearTimers() {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  }

  function schedule(callback, delay) {
    const token = epoch;
    const timer = window.setTimeout(() => {
      timers = timers.filter((entry) => entry !== timer);
      if (token !== epoch) return;
      callback();
    }, delay);
    timers.push(timer);
  }

  function tileLabel(tile) {
    return `${tile.a}–${tile.b}`;
  }

  function fillPips(container, value) {
    container.replaceChildren();
    for (const position of PIP_POSITIONS[value]) {
      const pip = document.createElement('span');
      pip.className = `pip pip--${position}`;
      container.appendChild(pip);
    }
  }

  function makeDomino(left, right, options) {
    const config = options || {};
    const node = ui.dominoTemplate.content.firstElementChild.cloneNode(true);
    fillPips(node.querySelector('.domino__half--a'), left);
    fillPips(node.querySelector('.domino__half--b'), right);
    node.setAttribute('aria-label', config.label || `Фишка ${left}–${right}`);
    if (config.hand) node.classList.add('domino--hand');
    if (config.newTile) node.classList.add('is-new');
    return node;
  }

  function renderOpponent(state) {
    ui.computerCount.textContent = String(state.hands[SIDES.COMPUTER].length);
    ui.computerHand.replaceChildren();
    state.hands[SIDES.COMPUTER].forEach(() => {
      const back = document.createElement('span');
      back.className = 'domino-back';
      back.setAttribute('aria-hidden', 'true');
      ui.computerHand.appendChild(back);
    });
  }

  function renderChain(state) {
    const ends = chainEnds(state.chain);
    ui.leftEnd.textContent = ends.left ?? '—';
    ui.rightEnd.textContent = ends.right ?? '—';
    ui.boneyardCount.textContent = String(state.boneyard.length);
    ui.chain.replaceChildren();

    const chainGrew = state.chain.length > lastChainLength;
    state.chain.forEach((tile, index) => {
      const isNew = chainGrew && (
        (lastPlacement === 'left' && index === 0) ||
        (lastPlacement === 'right' && index === state.chain.length - 1)
      );
      const node = makeDomino(tile.left, tile.right, {
        label: `В цепочке: ${tile.left}–${tile.right}`,
        newTile: isNew,
      });
      node.disabled = true;
      ui.chain.appendChild(node);
    });

    if (chainGrew) {
      requestAnimationFrame(() => {
        const target = lastPlacement === 'left' ? 0 : ui.chainViewport.scrollWidth;
        ui.chainViewport.scrollTo({ left: target, behavior: 'smooth' });
      });
    }
    lastChainLength = state.chain.length;
  }

  function statusText(state) {
    if (transientMessage) return transientMessage;
    if (state.phase === 'finished') {
      if (state.endReason === 'fish') return 'Партия завершена: рыба.';
      return 'Партия завершена.';
    }
    if (state.turn === SIDES.COMPUTER) return 'Соперник обдумывает ход…';

    const moves = game.getMoves(SIDES.PLAYER);
    if (moves.length > 0) return 'Ваш ход — выберите подсвеченную фишку.';
    if (state.boneyard.length > 0) return 'Подходящих фишек нет — возьмите из базара.';
    return 'Подходящих фишек нет и базар пуст — пропустите ход.';
  }

  function renderStatus(state) {
    ui.turnMessage.textContent = statusText(state);
    if (state.starter) {
      const starterOwner = state.starter.side === SIDES.PLAYER ? 'у вас' : 'у соперника';
      ui.starterMessage.textContent = `Старт: ${state.starter.tileId.replace('-', '–')} — ${starterOwner}`;
    }
  }

  function renderSideChoice(state) {
    ui.sideChoice.replaceChildren();
    ui.sideChoice.hidden = true;
    if (!selectedTileId || busy || state.turn !== SIDES.PLAYER || state.phase !== 'playing') return;

    const tile = state.hands[SIDES.PLAYER].find((candidate) => candidate.id === selectedTileId);
    if (!tile) {
      selectedTileId = null;
      return;
    }

    const sides = legalSides(tile, state.chain);
    if (sides.length < 2) return;

    const label = document.createElement('span');
    label.className = 'side-choice__label';
    label.textContent = `Фишка ${tileLabel(tile)} подходит с двух сторон:`;
    ui.sideChoice.appendChild(label);

    const ends = chainEnds(state.chain);
    for (const side of ['left', 'right']) {
      if (!sides.includes(side)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button--gold';
      button.textContent = side === 'left'
        ? `Поставить слева к ${ends.left}`
        : `Поставить справа к ${ends.right}`;
      button.addEventListener('click', () => playPlayerTile(tile.id, side));
      ui.sideChoice.appendChild(button);
    }
    ui.sideChoice.hidden = false;
  }

  function renderPlayerActions(state) {
    ui.playerActions.replaceChildren();
    if (state.phase !== 'playing' || state.turn !== SIDES.PLAYER || busy) return;
    const moves = game.getMoves(SIDES.PLAYER);
    if (moves.length > 0) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button--gold';
    if (state.boneyard.length > 0) {
      button.textContent = 'Взять из базара';
      button.addEventListener('click', drawPlayerTiles);
    } else {
      button.textContent = 'Пропустить ход';
      button.classList.add('button--danger');
      button.addEventListener('click', passPlayerTurn);
    }
    ui.playerActions.appendChild(button);
  }

  function renderPlayerHand(state) {
    ui.playerHand.replaceChildren();
    const playerTurn = state.phase === 'playing' && state.turn === SIDES.PLAYER && !busy;
    const legalTileIds = new Set(game.getMoves(SIDES.PLAYER).map((move) => move.tileId));

    for (const tile of state.hands[SIDES.PLAYER]) {
      const playable = playerTurn && legalTileIds.has(tile.id);
      const node = makeDomino(tile.a, tile.b, {
        hand: true,
        label: playable
          ? `Фишка ${tileLabel(tile)}, подходит. Нажмите, чтобы сыграть.`
          : `Фишка ${tileLabel(tile)}, сейчас не подходит.`,
      });
      node.dataset.tileId = tile.id;
      node.disabled = !playable;
      if (playable) node.classList.add('is-playable');
      if (selectedTileId === tile.id) node.classList.add('is-selected');
      node.addEventListener('click', () => selectPlayerTile(tile.id));
      ui.playerHand.appendChild(node);
    }

    if (state.phase === 'finished') {
      ui.handHint.textContent = `На руке осталось ${state.hands[SIDES.PLAYER].length} фишек · ${handPipSum(state.hands[SIDES.PLAYER])} очков.`;
    } else if (busy || state.turn === SIDES.COMPUTER) {
      ui.handHint.textContent = 'Дождитесь хода соперника.';
    } else if (legalTileIds.size > 0) {
      ui.handHint.textContent = 'Подходящие фишки подсвечены. Для выбора используйте Tab и Enter.';
    } else {
      ui.handHint.textContent = state.boneyard.length > 0
        ? 'Хода нет: действие «Взять из базара» возьмёт фишки до первой подходящей.'
        : 'Хода нет: базар пуст, можно пропустить ход.';
    }
  }

  function renderResult(state) {
    ui.resultCard.replaceChildren();
    ui.resultCard.hidden = state.phase !== 'finished';
    if (state.phase !== 'finished') return;

    const heading = document.createElement('h2');
    const copy = document.createElement('p');

    if (state.winner === SIDES.PLAYER) {
      heading.textContent = 'Вы выиграли партию';
    } else if (state.winner === SIDES.COMPUTER) {
      heading.textContent = 'Соперник выиграл партию';
    } else {
      heading.textContent = 'Ничья';
    }

    if (state.endReason === 'fish' && state.fish) {
      copy.textContent = `Рыба: у вас ${state.fish.playerPips} очков, у соперника ${state.fish.computerPips}.`;
    } else {
      const loser = state.winner === SIDES.PLAYER ? SIDES.COMPUTER : SIDES.PLAYER;
      const remaining = state.winner === 'draw' ? 0 : handPipSum(state.hands[loser]);
      copy.textContent = state.winner === 'draw'
        ? 'Обе стороны завершили партию с равным результатом.'
        : `Победа за пустую руку. У проигравшей стороны осталось ${remaining} очков.`;
    }

    const replay = document.createElement('button');
    replay.type = 'button';
    replay.className = 'button button--gold';
    replay.textContent = 'Сыграть ещё раз';
    replay.addEventListener('click', startNewGame);

    ui.resultCard.append(heading, copy, replay);
  }

  function render() {
    const state = game.getState();
    renderStatus(state);
    renderOpponent(state);
    renderChain(state);
    renderPlayerActions(state);
    renderPlayerHand(state);
    renderSideChoice(state);
    renderResult(state);
    ui.newGameButton.disabled = false;
  }

  function setTransient(message, milliseconds) {
    transientMessage = message;
    render();
    if (milliseconds) {
      schedule(() => {
        transientMessage = '';
        render();
      }, milliseconds);
    }
  }

  function selectPlayerTile(tileId) {
    if (busy) return;
    const state = game.getState();
    if (state.turn !== SIDES.PLAYER || state.phase !== 'playing') return;
    const tile = state.hands[SIDES.PLAYER].find((candidate) => candidate.id === tileId);
    if (!tile) return;
    const sides = legalSides(tile, state.chain);
    if (!sides.length) return;

    if (sides.length === 1) {
      playPlayerTile(tileId, sides[0]);
      return;
    }

    selectedTileId = selectedTileId === tileId ? null : tileId;
    render();
    if (selectedTileId) {
      requestAnimationFrame(() => {
        const firstChoice = ui.sideChoice.querySelector('button');
        if (firstChoice) firstChoice.focus({ preventScroll: true });
      });
    }
  }

  function playPlayerTile(tileId, side) {
    if (busy) return;
    try {
      selectedTileId = null;
      transientMessage = '';
      lastPlacement = side;
      game.play(SIDES.PLAYER, tileId, side);
      render();
      scheduleComputerIfNeeded();
    } catch (error) {
      setTransient('Этот ход сейчас недоступен.', 1600);
      console.error(error);
    }
  }

  function drawPlayerTiles() {
    if (busy) return;
    try {
      const event = game.drawUntilPlayable(SIDES.PLAYER);
      const count = event.drawn.length;
      if (event.playable) {
        transientMessage = count === 1 ? 'Взята 1 фишка — теперь есть ход.' : `Взято фишек: ${count}. Теперь есть ход.`;
        render();
        schedule(() => {
          transientMessage = '';
          render();
        }, 1800);
      } else {
        transientMessage = count ? `Базар исчерпан: взято фишек ${count}, хода всё ещё нет.` : 'Базар пуст.';
        render();
      }
    } catch (error) {
      setTransient('Сейчас нельзя брать из базара.', 1600);
      console.error(error);
    }
  }

  function passPlayerTurn() {
    if (busy) return;
    try {
      selectedTileId = null;
      transientMessage = '';
      game.pass(SIDES.PLAYER);
      render();
      scheduleComputerIfNeeded();
    } catch (error) {
      setTransient('Пропуск доступен только без хода при пустом базаре.', 1800);
      console.error(error);
    }
  }

  function scheduleComputerIfNeeded() {
    const state = game.getState();
    if (state.phase !== 'playing' || state.turn !== SIDES.COMPUTER) return;
    busy = true;
    selectedTileId = null;
    render();

    schedule(() => {
      try {
        const before = game.getState();
        const result = game.computerStep();
        const playEvent = result.events.find((event) => event.type === 'play');
        if (playEvent) lastPlacement = playEvent.placement;

        const drawEvent = result.events.find((event) => event.type === 'draw');
        const passEvent = result.events.find((event) => event.type === 'pass');
        if (drawEvent && drawEvent.drawn.length) {
          transientMessage = `Соперник добрал фишек: ${drawEvent.drawn.length}.`;
        } else if (passEvent) {
          transientMessage = 'Соперник пропускает ход.';
        } else {
          transientMessage = '';
        }

        busy = false;
        render();

        if (transientMessage && game.getState().phase === 'playing') {
          schedule(() => {
            transientMessage = '';
            render();
          }, 1400);
        }

        if (before.turn === SIDES.COMPUTER && game.getState().turn === SIDES.COMPUTER && game.getState().phase === 'playing') {
          scheduleComputerIfNeeded();
        }
      } catch (error) {
        busy = false;
        transientMessage = 'Не удалось завершить ход соперника. Начните новую партию.';
        render();
        console.error(error);
      }
    }, 560);
  }

  function startNewGame() {
    epoch += 1;
    clearTimers();
    busy = false;
    selectedTileId = null;
    transientMessage = '';
    lastPlacement = 'right';
    game.reset();
    lastChainLength = 1;
    render();
    scheduleComputerIfNeeded();
  }

  ui.newGameButton.addEventListener('click', startNewGame);
  ui.chainViewport.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      ui.chainViewport.scrollBy({ left: -180, behavior: 'smooth' });
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      ui.chainViewport.scrollBy({ left: 180, behavior: 'smooth' });
      event.preventDefault();
    }
  });

  render();
  scheduleComputerIfNeeded();
})();
