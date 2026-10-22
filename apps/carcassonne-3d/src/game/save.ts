import type {
  CreateGameInput, GameCommand, GameState, PlayerSetup, RestoreErrorCode, RestoreResult,
  SavedGameV1,
} from './types';
import { catalogDigest, getTileCatalog } from './catalog';
import { createGame, transition } from './reducer';
import { isValidGameState } from './invariant';

const MAX_SAVE_SIZE = 2_000_000;
const MAX_COMMANDS = 150;

type JsonRecord = Record<string, unknown>;
function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(object: JsonRecord, required: readonly string[]): boolean {
  return Object.keys(object).length === required.length && required.every((key) => key in object);
}

function validPlayer(value: unknown): value is PlayerSetup {
  return record(value) && sameKeys(value, ['name', 'color', 'heraldicSymbol'])
    && typeof value.name === 'string' && Boolean(value.name.trim())
    && typeof value.color === 'string' && /^#[A-Fa-f0-9]{6}$/.test(value.color)
    && ['lion', 'eagle', 'tower', 'sun', 'oak'].includes(value.heraldicSymbol as string);
}

function validCommand(value: unknown): value is GameCommand {
  if (!record(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'PLACE_TILE':
      return sameKeys(value, ['type', 'placementId']) && typeof value.placementId === 'string'
        && /^place:-?(?:0|[1-9][0-9]*),-?(?:0|[1-9][0-9]*):r[0-3]$/.test(value.placementId);
    case 'PLACE_MEEPLE':
      return sameKeys(value, ['type', 'targetId']) && typeof value.targetId === 'string'
        && /^region:-?(?:0|[1-9][0-9]*),-?(?:0|[1-9][0-9]*):[a-z][a-z0-9-]*$/.test(value.targetId);
    case 'SKIP_MEEPLE':
      return sameKeys(value, ['type']);
    default:
      return false;
  }
}

function error(code: RestoreErrorCode, message: string, detail?: string): RestoreResult {
  return { ok: false, error: { code, message, ...(detail ? { detail } : {}) } };
}

export function exportSave(state: GameState): string {
  if (!isValidGameState(state)) throw new TypeError('Невозможно сохранить повреждённое состояние партии.');
  const result: SavedGameV1 = {
    schemaVersion: 1,
    rulesetId: 'base72',
    catalogVersion: getTileCatalog().version,
    catalogDigest,
    seed: state.seed,
    players: state.players.map((player) => ({
      name: player.name, color: player.color, heraldicSymbol: player.heraldicSymbol,
    })),
    commands: [...state.history],
  };
  return JSON.stringify(result);
}

/**
 * Only INPUTS and accepted command history are deserialized. Board, scores,
 * queue and occupied regions are rebuilt deterministically from a fresh game.
 */
export function restoreSave(json: string): RestoreResult {
  if (typeof json !== 'string' || json.length === 0 || json.length > MAX_SAVE_SIZE) {
    return error('INVALID_STATE', 'Пустой либо слишком большой файл сохранения.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return error('INVALID_JSON', 'Файл не является правильным JSON.');
  }
  if (!record(parsed) || !sameKeys(parsed, [
    'schemaVersion', 'rulesetId', 'catalogVersion', 'catalogDigest', 'seed', 'players', 'commands',
  ])) return error('INVALID_STATE', 'Неизвестная структура сохранения.');
  if (parsed.schemaVersion !== 1) return error('UNSUPPORTED_VERSION', 'Эта версия сохранения не поддерживается.');
  if (parsed.rulesetId !== 'base72' || parsed.catalogVersion !== getTileCatalog().version
    || parsed.catalogDigest !== catalogDigest) {
    return error('CATALOG_MISMATCH', 'Версия или отпечаток каталога не совпадают.');
  }
  if (typeof parsed.seed !== 'string' || !parsed.seed.trim() || !Array.isArray(parsed.players)
    || parsed.players.length < 2 || parsed.players.length > 5
    || !parsed.players.every(validPlayer)
    || !Array.isArray(parsed.commands) || parsed.commands.length > MAX_COMMANDS
    || !parsed.commands.every(validCommand)) {
    return error('INVALID_STATE', 'Неверный seed, участники либо формат команд.');
  }
  try {
    const input: CreateGameInput = { seed: parsed.seed, players: parsed.players as PlayerSetup[] };
    let state = createGame(input);
    for (let i = 0; i < parsed.commands.length; i++) {
      const cmd = parsed.commands[i] as GameCommand;
      const result = transition(state, cmd);
      if (!result.ok) {
        return error('INVALID_REPLAY', 'История ходов содержит недопустимый шаг.',
          'Команда ' + (i + 1) + ': ' + result.error.code + '.');
      }
      state = result.state;
    }
    return { ok: true, state };
  } catch (cause) {
    return error('INVALID_STATE', 'Не удалось восстановить партию.',
      cause instanceof Error ? cause.message : 'Ошибка структуры данных.');
  }
}
