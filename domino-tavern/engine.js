(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.TavernDomino = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PLAYER = 'player';
  const COMPUTER = 'computer';
  const SIDES = Object.freeze({ PLAYER, COMPUTER });

  function otherSide(side) {
    return side === PLAYER ? COMPUTER : PLAYER;
  }

  function buildSet() {
    const tiles = [];
    for (let a = 0; a <= 6; a += 1) {
      for (let b = a; b <= 6; b += 1) {
        tiles.push({ id: `${a}-${b}`, a, b });
      }
    }
    return tiles;
  }

  function cloneTile(tile) {
    return { id: tile.id, a: tile.a, b: tile.b };
  }

  function pipSum(tile) {
    return tile.a + tile.b;
  }

  function handPipSum(hand) {
    return hand.reduce((sum, tile) => sum + pipSum(tile), 0);
  }

  function shuffleTiles(tiles, rng) {
    const random = typeof rng === 'function' ? rng : Math.random;
    const result = tiles.map(cloneTile);
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      const safeIndex = Math.max(0, Math.min(index, swapIndex));
      [result[index], result[safeIndex]] = [result[safeIndex], result[index]];
    }
    return result;
  }

  function compareStarterTiles(left, right) {
    const leftDouble = left.a === left.b;
    const rightDouble = right.a === right.b;
    if (leftDouble !== rightDouble) {
      return leftDouble ? 1 : -1;
    }
    if (leftDouble && rightDouble) {
      return left.a - right.a;
    }
    const sumDifference = pipSum(left) - pipSum(right);
    if (sumDifference !== 0) {
      return sumDifference;
    }
    const highDifference = Math.max(left.a, left.b) - Math.max(right.a, right.b);
    if (highDifference !== 0) {
      return highDifference;
    }
    return left.id.localeCompare(right.id);
  }

  function chooseStartingTile(hands) {
    const candidates = [];
    for (const side of [PLAYER, COMPUTER]) {
      for (const tile of hands[side]) {
        candidates.push({ side, tile });
      }
    }
    if (candidates.length === 0) {
      throw new Error('Cannot choose a starting tile from empty hands.');
    }

    const hasDouble = candidates.some(({ tile }) => tile.a === tile.b);
    const pool = hasDouble
      ? candidates.filter(({ tile }) => tile.a === tile.b)
      : candidates;

    return pool.reduce((best, current) => {
      if (!best || compareStarterTiles(current.tile, best.tile) > 0) {
        return current;
      }
      return best;
    }, null);
  }

  function chainEnds(chain) {
    if (!chain.length) {
      return { left: null, right: null };
    }
    return {
      left: chain[0].left,
      right: chain[chain.length - 1].right,
    };
  }

  function legalSides(tile, chain) {
    if (!chain.length) {
      return ['right'];
    }
    const ends = chainEnds(chain);
    const sides = [];
    if (tile.a === ends.left || tile.b === ends.left) {
      sides.push('left');
    }
    if (tile.a === ends.right || tile.b === ends.right) {
      sides.push('right');
    }
    return sides;
  }

  function orientForSide(tile, side, chain) {
    if (!chain.length) {
      return { id: tile.id, left: tile.a, right: tile.b };
    }

    const ends = chainEnds(chain);
    if (side === 'left') {
      if (tile.b === ends.left) {
        return { id: tile.id, left: tile.a, right: tile.b };
      }
      if (tile.a === ends.left) {
        return { id: tile.id, left: tile.b, right: tile.a };
      }
    }

    if (side === 'right') {
      if (tile.a === ends.right) {
        return { id: tile.id, left: tile.a, right: tile.b };
      }
      if (tile.b === ends.right) {
        return { id: tile.id, left: tile.b, right: tile.a };
      }
    }

    throw new Error(`Tile ${tile.id} cannot be placed on ${side}.`);
  }

  function hasLegalMove(hand, chain) {
    return hand.some((tile) => legalSides(tile, chain).length > 0);
  }

  function listMoves(hand, chain) {
    const moves = [];
    for (const tile of hand) {
      for (const side of legalSides(tile, chain)) {
        moves.push({ tileId: tile.id, side });
      }
    }
    return moves;
  }

  function drawUntilPlayableFrom(hand, boneyard, chain) {
    const nextHand = hand.map(cloneTile);
    const nextBoneyard = boneyard.map(cloneTile);
    const drawn = [];

    while (!hasLegalMove(nextHand, chain) && nextBoneyard.length > 0) {
      const tile = nextBoneyard.shift();
      nextHand.push(tile);
      drawn.push(tile);
    }

    return {
      hand: nextHand,
      boneyard: nextBoneyard,
      drawn,
      playable: hasLegalMove(nextHand, chain),
    };
  }

  function resolveFish(hands) {
    const playerPips = handPipSum(hands[PLAYER]);
    const computerPips = handPipSum(hands[COMPUTER]);
    let winner = 'draw';
    if (playerPips < computerPips) {
      winner = PLAYER;
    } else if (computerPips < playerPips) {
      winner = COMPUTER;
    }
    return {
      winner,
      playerPips,
      computerPips,
    };
  }

  function tileMatchesOriented(tile, oriented) {
    return (
      (tile.a === oriented.left && tile.b === oriented.right) ||
      (tile.a === oriented.right && tile.b === oriented.left)
    );
  }

  function validateState(state) {
    const expectedIds = new Set(buildSet().map((tile) => tile.id));
    const seen = new Set();
    const inventory = [];

    for (const tile of state.hands[PLAYER]) inventory.push(tile);
    for (const tile of state.hands[COMPUTER]) inventory.push(tile);
    for (const tile of state.boneyard) inventory.push(tile);

    for (const oriented of state.chain) {
      const parts = oriented.id.split('-').map(Number);
      const tile = { id: oriented.id, a: parts[0], b: parts[1] };
      if (!tileMatchesOriented(tile, oriented)) {
        throw new Error(`Chain orientation does not match tile ${oriented.id}.`);
      }
      inventory.push(tile);
    }

    if (inventory.length !== 28) {
      throw new Error(`Domino inventory must contain 28 tiles, got ${inventory.length}.`);
    }

    for (const tile of inventory) {
      if (!expectedIds.has(tile.id)) {
        throw new Error(`Unknown domino tile ${tile.id}.`);
      }
      if (seen.has(tile.id)) {
        throw new Error(`Duplicate domino tile ${tile.id}.`);
      }
      seen.add(tile.id);
    }

    if (seen.size !== 28) {
      throw new Error('Domino inventory is incomplete.');
    }

    for (let index = 0; index < state.chain.length - 1; index += 1) {
      if (state.chain[index].right !== state.chain[index + 1].left) {
        throw new Error(`Broken chain between positions ${index} and ${index + 1}.`);
      }
    }

    return true;
  }

  function scoreComputerMove(state, move) {
    const hand = state.hands[COMPUTER];
    const tile = hand.find((candidate) => candidate.id === move.tileId);
    const oriented = orientForSide(tile, move.side, state.chain);
    const nextChain = state.chain.map((item) => ({ ...item }));
    if (move.side === 'left') {
      nextChain.unshift(oriented);
    } else {
      nextChain.push(oriented);
    }

    const remaining = hand.filter((candidate) => candidate.id !== tile.id);
    const ends = chainEnds(nextChain);
    const exposed = move.side === 'left' ? ends.left : ends.right;
    const exposedMatches = remaining.reduce((count, candidate) => {
      return count + (candidate.a === exposed || candidate.b === exposed ? 1 : 0);
    }, 0);
    const flexibility = remaining.reduce((count, candidate) => {
      const matchesLeft = candidate.a === ends.left || candidate.b === ends.left;
      const matchesRight = candidate.a === ends.right || candidate.b === ends.right;
      return count + (matchesLeft || matchesRight ? 1 : 0);
    }, 0);

    let score = pipSum(tile) * 4 + exposedMatches * 3 + flexibility * 2;
    if (tile.a === tile.b) score += 5;
    if (remaining.length === 0) score += 1000;
    if (state.boneyard.length === 0) score += pipSum(tile) * 2;
    return score;
  }

  function chooseComputerMove(state) {
    const moves = listMoves(state.hands[COMPUTER], state.chain);
    if (!moves.length) return null;
    return moves
      .map((move) => ({ ...move, score: scoreComputerMove(state, move) }))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        const tileOrder = left.tileId.localeCompare(right.tileId);
        if (tileOrder !== 0) return tileOrder;
        return left.side.localeCompare(right.side);
      })[0];
  }

  function createGame(options) {
    const config = options || {};
    const rng = typeof config.rng === 'function' ? config.rng : Math.random;
    let state;

    function snapshot() {
      return {
        hands: {
          [PLAYER]: state.hands[PLAYER].map(cloneTile),
          [COMPUTER]: state.hands[COMPUTER].map(cloneTile),
        },
        boneyard: state.boneyard.map(cloneTile),
        chain: state.chain.map((item) => ({ ...item })),
        turn: state.turn,
        phase: state.phase,
        winner: state.winner,
        endReason: state.endReason,
        consecutivePasses: state.consecutivePasses,
        starter: state.starter ? { ...state.starter } : null,
        fish: state.fish ? { ...state.fish } : null,
      };
    }

    function reset() {
      const deck = shuffleTiles(buildSet(), rng);
      const hands = {
        [PLAYER]: deck.slice(0, 7),
        [COMPUTER]: deck.slice(7, 14),
      };
      const boneyard = deck.slice(14);
      const starter = chooseStartingTile(hands);
      const starterIndex = hands[starter.side].findIndex((tile) => tile.id === starter.tile.id);
      const [startingTile] = hands[starter.side].splice(starterIndex, 1);

      state = {
        hands,
        boneyard,
        chain: [{ id: startingTile.id, left: startingTile.a, right: startingTile.b }],
        turn: otherSide(starter.side),
        phase: 'playing',
        winner: null,
        endReason: null,
        consecutivePasses: 0,
        starter: { side: starter.side, tileId: startingTile.id },
        fish: null,
      };

      validateState(state);
      return snapshot();
    }

    function requireTurn(side) {
      if (state.phase !== 'playing') {
        throw new Error('The game is already finished.');
      }
      if (state.turn !== side) {
        throw new Error(`It is not ${side}'s turn.`);
      }
    }

    function getMoves(side) {
      return listMoves(state.hands[side], state.chain);
    }

    function play(side, tileId, placement) {
      requireTurn(side);
      const hand = state.hands[side];
      const tileIndex = hand.findIndex((tile) => tile.id === tileId);
      if (tileIndex < 0) {
        throw new Error(`Tile ${tileId} is not in ${side}'s hand.`);
      }

      const tile = hand[tileIndex];
      const allowed = legalSides(tile, state.chain);
      if (!allowed.length) {
        throw new Error(`Tile ${tileId} has no legal placement.`);
      }
      if (!placement && allowed.length > 1) {
        throw new Error('Placement side is required for a tile that fits both ends.');
      }
      const chosenSide = placement || allowed[0];
      if (!allowed.includes(chosenSide)) {
        throw new Error(`Tile ${tileId} cannot be placed on ${chosenSide}.`);
      }

      const oriented = orientForSide(tile, chosenSide, state.chain);
      hand.splice(tileIndex, 1);
      if (chosenSide === 'left') {
        state.chain.unshift(oriented);
      } else {
        state.chain.push(oriented);
      }
      state.consecutivePasses = 0;

      if (hand.length === 0) {
        state.phase = 'finished';
        state.winner = side;
        state.endReason = 'empty-hand';
      } else {
        state.turn = otherSide(side);
      }

      validateState(state);
      return {
        type: 'play',
        side,
        tileId,
        placement: chosenSide,
        state: snapshot(),
      };
    }

    function drawUntilPlayable(side) {
      requireTurn(side);
      if (hasLegalMove(state.hands[side], state.chain)) {
        return { type: 'draw', side, drawn: [], playable: true, state: snapshot() };
      }

      const result = drawUntilPlayableFrom(state.hands[side], state.boneyard, state.chain);
      state.hands[side] = result.hand;
      state.boneyard = result.boneyard;
      validateState(state);
      return {
        type: 'draw',
        side,
        drawn: result.drawn.map(cloneTile),
        playable: result.playable,
        state: snapshot(),
      };
    }

    function pass(side) {
      requireTurn(side);
      if (state.boneyard.length > 0) {
        throw new Error('Cannot pass while the boneyard still has tiles.');
      }
      if (hasLegalMove(state.hands[side], state.chain)) {
        throw new Error('Cannot pass while a legal move exists.');
      }

      state.consecutivePasses += 1;
      if (state.consecutivePasses >= 2) {
        const fish = resolveFish(state.hands);
        state.phase = 'finished';
        state.winner = fish.winner;
        state.endReason = 'fish';
        state.fish = fish;
      } else {
        state.turn = otherSide(side);
      }

      validateState(state);
      return { type: 'pass', side, state: snapshot() };
    }

    function computerStep() {
      requireTurn(COMPUTER);
      const events = [];

      if (!hasLegalMove(state.hands[COMPUTER], state.chain)) {
        const drawEvent = drawUntilPlayable(COMPUTER);
        if (drawEvent.drawn.length > 0) {
          events.push(drawEvent);
        }
      }

      if (state.phase !== 'playing') {
        return { type: 'computer-step', events, state: snapshot() };
      }

      if (!hasLegalMove(state.hands[COMPUTER], state.chain)) {
        if (state.boneyard.length !== 0) {
          throw new Error('Computer has no move but boneyard is not exhausted.');
        }
        events.push(pass(COMPUTER));
        return { type: 'computer-step', events, state: snapshot() };
      }

      const move = chooseComputerMove(state);
      events.push(play(COMPUTER, move.tileId, move.side));
      return { type: 'computer-step', events, state: snapshot() };
    }

    reset();

    return {
      getState: snapshot,
      reset,
      getMoves,
      play,
      drawUntilPlayable,
      pass,
      computerStep,
    };
  }

  return Object.freeze({
    SIDES,
    buildSet,
    pipSum,
    handPipSum,
    shuffleTiles,
    chooseStartingTile,
    chainEnds,
    legalSides,
    orientForSide,
    hasLegalMove,
    listMoves,
    drawUntilPlayableFrom,
    resolveFish,
    validateState,
    chooseComputerMove,
    createGame,
  });
});
