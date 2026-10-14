import { describe, expect, it } from 'vitest';
import {
  createGame, getLegalFollowerTargets, getLegalPlacements, getTileCatalog,
  restoreSave, exportSave, transition,
} from '../src/game';
import type { GameCommand, GameState, PlayerSetup, Side } from '../src/game';
import { edgeAt, SIDE_VECTORS, SIDES, oppositeSide } from '../src/game/geometry';
import { definitionsById } from '../src/game/catalog';

const SYMBOLS = ['lion', 'eagle', 'tower', 'sun', 'oak'] as const;
const playersFor = (count: number): readonly PlayerSetup[] => Array.from({ length: count }, (_, index) => ({
  name: `Игрок ${index + 1}`,
  color: ['#AA3344', '#124A9D', '#BB5511', '#225544', '#996699'][index]!,
  heraldicSymbol: SYMBOLS[index]!,
}));

function accepted(state: GameState, command: GameCommand): GameState {
  const result = transition(state, command);
  if (!result.ok) throw new Error(`${state.seed} ${command.type}: ${result.error.code} ${result.error.message}`);
  return result.state;
}

function assertInvariants(state: GameState): void {
  const catalog = getTileCatalog();
  const catalogIds = new Set(catalog.definitions.flatMap((definition) =>
    Array.from({ length: definition.copies }, (_, copy) => `tile-${definition.id}-${String(copy + 1).padStart(2, '0')}`)));
  const accounted = [
    ...state.board.map((tile) => tile.id), ...state.bag.map((tile) => tile.id),
    ...(state.pendingTile ? [state.pendingTile.id] : []), ...state.discardedIds,
  ];
  expect(accounted, `${state.seed}: all physical tiles accounted`).toHaveLength(72);
  expect(new Set(accounted), `${state.seed}: physical tile IDs unique`).toHaveProperty('size', 72);
  expect(new Set(accounted), `${state.seed}: exact catalog IDs`).toEqual(catalogIds);

  const positions = new Set(state.board.map((tile) => `${tile.x},${tile.z}`));
  expect(positions.size, `${state.seed}: board positions unique`).toBe(state.board.length);
  const boardAt = new Map(state.board.map((tile) => [`${tile.x},${tile.z}`, tile]));
  for (const tile of state.board) {
    const definition = definitionsById.get(tile.defId)!;
    for (const side of SIDES) {
      const vector = SIDE_VECTORS[side];
      const neighbor = boardAt.get(`${tile.x + vector.x},${tile.z + vector.z}`);
      if (!neighbor) continue;
      const neighborDef = definitionsById.get(neighbor.defId)!;
      expect(edgeAt(definition, side, tile.rotation), `${state.seed}: ${tile.id} ${side} edge`).toBe(
        edgeAt(neighborDef, oppositeSide(side as Side), neighbor.rotation),
      );
    }
  }

  const placedMeeples = new Map<string, number>();
  for (const meeple of state.meeples) {
    const match = /^region:(-?\d+),(-?\d+):([a-z][a-z0-9-]*)$/.exec(meeple.targetId);
    expect(match, `${state.seed}: valid meeple target ${meeple.targetId}`).not.toBeNull();
    const tile = state.board.find((placed) => placed.x === Number(match![1]) && placed.z === Number(match![2]));
    expect(tile, `${state.seed}: target tile exists`).toBeDefined();
    expect(definitionsById.get(tile!.defId)!.regions.some((region) => region.id === match![3]),
      `${state.seed}: target region exists`).toBe(true);
    placedMeeples.set(meeple.playerId, (placedMeeples.get(meeple.playerId) ?? 0) + 1);
  }
  for (const player of state.players) {
    expect(state.meeplesLeft[player.id], `${state.seed}: ${player.id} reserve bounds`).toBeGreaterThanOrEqual(0);
    expect(state.meeplesLeft[player.id], `${state.seed}: ${player.id} reserve bounds`).toBeLessThanOrEqual(7);
    expect(state.meeplesLeft[player.id]! + (placedMeeples.get(player.id) ?? 0),
      `${state.seed}: ${player.id} reserve conservation`).toBe(7);
    expect(Number.isFinite(state.scores[player.id]), `${state.seed}: finite ${player.id} score`).toBe(true);
  }
}

describe('100 deterministic autonomous full-game invariant runs', () => {
  it('preserves game invariants, reproducibility, replay and terminal rejection', () => {
    for (let index = 0; index < 100; index++) {
      const seed = `AUTONOMOUS_${String(index).padStart(4, '0')}`;
      const playerCount = 2 + (index % 4);
      const input = { seed, players: playersFor(playerCount) };
      const untouchedInput = JSON.stringify(input);
      let state = createGame(input);
      const replay = createGame(input);
      expect(state, `${seed}: deterministic setup`).toEqual(replay);
      expect(JSON.stringify(input), `${seed}: input unchanged`).toBe(untouchedInput);
      let acceptedCommands = 0;
      assertInvariants(state);

      while (state.phase !== 'finished' && acceptedCommands < 142) {
        if (state.phase === 'tile') {
          const options = getLegalPlacements(state);
          expect(options.length, `${seed}: a legal placement exists`).toBeGreaterThan(0);
          state = accepted(state, { type: 'PLACE_TILE', placementId: options[(index + acceptedCommands) % options.length]!.id });
        } else {
          const targets = getLegalFollowerTargets(state);
          if (targets.length > 0 && (acceptedCommands + index) % 3 === 0) {
            const target = targets[(index + acceptedCommands) % targets.length]!;
            state = accepted(state, { type: 'PLACE_MEEPLE', targetId: target.id });
          } else {
            state = accepted(state, { type: 'SKIP_MEEPLE' });
          }
        }
        acceptedCommands++;
        assertInvariants(state);
      }

      expect(state.phase, `${seed}: finished within command bound`).toBe('finished');
      expect(acceptedCommands, `${seed}: accepted commands bounded`).toBeLessThanOrEqual(142);
      expect(state.bag).toHaveLength(0);
      expect(state.pendingTile).toBeNull();
      expect(state.board.length + state.discardedIds.length).toBe(72);
      expect(restoreSave(exportSave(state)), `${seed}: finished replay preserved`).toEqual({ ok: true, state });
      const beforeRejected = JSON.stringify(state);
      const rejected = transition(state, { type: 'SKIP_MEEPLE' });
      expect(rejected.ok, `${seed}: terminal command rejected`).toBe(false);
      expect(rejected.state, `${seed}: rejected terminal command preserves identity`).toBe(state);
      expect(JSON.stringify(state), `${seed}: rejected terminal command leaves state unchanged`).toBe(beforeRejected);
    }
  }, 180_000);
});
