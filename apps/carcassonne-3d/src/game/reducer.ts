import type {
  CreateGameInput, GameCommand, GameEvent, GameState, Player, PlayerId,
  PlayerSetup, TileInstance, TransitionResult,
} from './types';
import { definitionsById, getTileCatalog } from './catalog';
import { findPlacements } from './legal';
import { isValidGameState } from './invariant';
import { getLegalFollowerTargets, getLegalPlacements } from './selectors';
import { scoreFinalFeatures, settleCompletedFeatures } from './scoring';

const SYMBOLS = ['lion', 'eagle', 'tower', 'sun', 'oak'] as const;

function requireCreateInput(input: CreateGameInput): readonly Player[] {
  if (!input || typeof input.seed !== 'string' || !input.seed.trim()
    || !Array.isArray(input.players)) {
    throw new TypeError('Нужны непустая строка seed и массив участников.');
  }
  if (input.players.length < 2 || input.players.length > 5) {
    throw new RangeError('Количество участников должно быть от 2 до 5.');
  }
  return input.players.map((setup: PlayerSetup, index): Player => {
    if (!setup || typeof setup.name !== 'string' || !setup.name.trim()
      || typeof setup.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(setup.color)
      || !SYMBOLS.includes(setup.heraldicSymbol)) {
      throw new TypeError('Проверьте имя, цвет #RRGGBB и геральдический знак участника.');
    }
    return {
      id: ('p' + (index + 1)) as PlayerId,
      name: setup.name.trim(),
      color: setup.color.toUpperCase() as Player['color'],
      heraldicSymbol: setup.heraldicSymbol,
    };
  });
}

/** FNV-1a over UTF-16 code units, Mulberry32 and unbiased Fisher-Yates. */
export function seededShuffle<T>(values: readonly T[], seed: string): T[] {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const shuffled = [...values];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
}

function catalogueInstances(): TileInstance[] {
  return getTileCatalog().definitions.flatMap((definition) =>
    Array.from({ length: definition.copies }, (_, copy) => ({
      id: ('tile-' + definition.id + '-' + String(copy + 1).padStart(2, '0')) as TileInstance['id'],
      defId: definition.id,
    })));
}

export function drawPlaceable(
  state: GameState,
): { state: GameState; events: readonly GameEvent[] } {
  let remaining = [...state.bag];
  const discards = [...state.discardedIds];
  const events: GameEvent[] = [];
  while (remaining.length) {
    const tile = remaining[0]!;
    remaining = remaining.slice(1);
    const def = definitionsById.get(tile.defId);
    if (def && findPlacements(state.board, def, definitionsById, 1).length) {
      return {
        state: { ...state, bag: remaining, pendingTile: tile, discardedIds: discards, phase: 'tile' },
        events,
      };
    }
    discards.push(tile.id);
    events.push({ type: 'TILE_DISCARDED', tileInstanceId: tile.id });
  }
  return {
    state: { ...state, bag: [], pendingTile: null, discardedIds: discards },
    events,
  };
}

export function createGame(input: CreateGameInput): GameState {
  const players = requireCreateInput(input);
  const all = catalogueInstances();
  const start = all.find((tile) => tile.id === 'tile-D-01');
  if (!start) throw new Error('В подтверждённом каталоге отсутствует стартовая плитка D.');
  const scores: Record<string, number> = {};
  const meeplesLeft: Record<string, number> = {};
  for (const player of players) {
    scores[player.id] = 0;
    meeplesLeft[player.id] = 7;
  }
  const base: GameState = {
    rulesetId: 'base72', catalogVersion: getTileCatalog().version,
    seed: input.seed, phase: 'tile', turn: 1,
    activePlayerId: players[0]!.id, players,
    scores, meeplesLeft,
    board: [{ ...start, x: 0, z: 0, rotation: 0 }],
    meeples: [], bag: seededShuffle(all.filter((tile) => tile.id !== start.id), input.seed),
    pendingTile: null, currentPlacedId: null, discardedIds: [], history: [],
  };
  const drawn = drawPlaceable(base);
  return drawn.state.pendingTile ? drawn.state : scoreFinalFeatures(drawn.state).state;
}

function rejected(
  state: GameState, code: 'GAME_FINISHED' | 'INVALID_PHASE' | 'INVALID_COMMAND' |
    'UNKNOWN_PLACEMENT' | 'UNKNOWN_TARGET' | 'NO_MEEPLES' | 'CORRUPT_STATE',
  message: string,
): TransitionResult {
  return { ok: false, state, error: { code, message } };
}

export function transition(state: GameState, command: GameCommand): TransitionResult {
  if (!isValidGameState(state)) return rejected(state, 'CORRUPT_STATE', 'Состояние партии повреждено или несовместимо с каталогом.');
  if (state.phase === 'finished') return rejected(state, 'GAME_FINISHED', 'Партия уже завершена.');
  if (!command || !['PLACE_TILE', 'PLACE_MEEPLE', 'SKIP_MEEPLE'].includes(command.type)) {
    return rejected(state, 'INVALID_COMMAND', 'Команда неизвестна.');
  }
  if (command.type === 'PLACE_TILE') {
    if (state.phase !== 'tile') return rejected(state, 'INVALID_PHASE', 'Сейчас выбирают фигурку, а не плитку.');
    if (typeof command.placementId !== 'string') return rejected(state, 'INVALID_COMMAND', 'Неверный ID размещения.');
    const option = getLegalPlacements(state).find((entry) => entry.id === command.placementId);
    if (!option || !state.pendingTile) return rejected(state, 'UNKNOWN_PLACEMENT', 'Такого разрешённого размещения нет.');
    const placed = { ...state.pendingTile, x: option.x, z: option.z, rotation: option.rotation };
    const next: GameState = {
      ...state,
      phase: 'meeple', board: [...state.board, placed], pendingTile: null,
      currentPlacedId: placed.id,
      history: [...state.history, { type: 'PLACE_TILE', placementId: command.placementId }],
    };
    return {
      ok: true, state: next,
      events: [{ type: 'TILE_PLACED', tileInstanceId: placed.id, placementId: command.placementId }],
    };
  }
  if (state.phase !== 'meeple') {
    return rejected(state, 'INVALID_PHASE', 'Сначала нужно расположить плитку.');
  }

  let afterChoice: GameState = state;
  const events: GameEvent[] = [];
  if (command.type === 'PLACE_MEEPLE') {
    if (!state.activePlayerId || (state.meeplesLeft[state.activePlayerId] ?? 0) === 0) {
      return rejected(state, 'NO_MEEPLES', 'У игрока не осталось свободных фигурок.');
    }
    if (typeof command.targetId !== 'string') {
      return rejected(state, 'INVALID_COMMAND', 'Неверный идентификатор области.');
    }
    const target = getLegalFollowerTargets(state).find((entry) => entry.id === command.targetId);
    if (!target) return rejected(state, 'UNKNOWN_TARGET', 'Эта область уже занята или недоступна.');
    const playerId = state.activePlayerId;
    const number = state.history.filter((entry) => entry.type === 'PLACE_MEEPLE').length + 1;
    const meepleId = ('meeple-' + String(number).padStart(4, '0')) as `meeple-${string}`;
    afterChoice = {
      ...state,
      meeples: [...state.meeples, { id: meepleId, playerId, targetId: target.id }],
      meeplesLeft: { ...state.meeplesLeft, [playerId]: state.meeplesLeft[playerId]! - 1 },
      history: [...state.history, { type: 'PLACE_MEEPLE', targetId: target.id }],
    };
    events.push({ type: 'MEEPLE_PLACED', meepleId, playerId, targetId: target.id });
  } else {
    afterChoice = { ...state, history: [...state.history, { type: 'SKIP_MEEPLE' }] };
  }

  const current = afterChoice.board.find((tile) => tile.id === afterChoice.currentPlacedId);
  if (!current) return rejected(state, 'CORRUPT_STATE', 'Отсутствует установленная на ходе плитка.');
  const settled = settleCompletedFeatures(afterChoice, current);
  events.push(...settled.events);
  const nextIndex = (state.players.findIndex((player) => player.id === state.activePlayerId) + 1) % state.players.length;
  const nextPlayer = state.players[nextIndex]!;
  const intermediate: GameState = {
    ...settled.state, currentPlacedId: null, pendingTile: null,
  };
  const drawn = drawPlaceable(intermediate);
  events.push(...drawn.events);
  if (!drawn.state.pendingTile) {
    const final = scoreFinalFeatures(drawn.state);
    return { ok: true, state: final.state, events: [...events, ...final.events] };
  }
  const advanced: GameState = {
    ...drawn.state,
    phase: 'tile', activePlayerId: nextPlayer.id, turn: state.turn + 1,
  };
  events.push({ type: 'TURN_ADVANCED', turn: advanced.turn, activePlayerId: nextPlayer.id });
  return { ok: true, state: advanced, events };
}
