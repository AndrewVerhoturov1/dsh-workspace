import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createGame, exportSave, getLegalFollowerTargets, getLegalPlacements, getTileCatalog,
  restoreSave, rotateFieldPort, rotateSide, selectBoardView, toBoardAnchor, transition,
  validateTileDef,
} from './index';
import type {
  CreateGameInput, GameCommand, GameState, PlayerSetup,
} from './types';
import { catalogDigest, definitionsById } from './catalog';
import { isValidGameState } from './invariant';
import { drawPlaceable, seededShuffle } from './reducer';

const players: readonly PlayerSetup[] = [
  { name: 'Рада', color: '#aa3344', heraldicSymbol: 'lion' },
  { name: 'Яр', color: '#124a9d', heraldicSymbol: 'oak' },
];
const setup: CreateGameInput = { seed: 'POSTMAN_TEST_0042', players };

function accepted(state: GameState, command: GameCommand): GameState {
  const result = transition(state, command);
  if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message);
  return result.state;
}

describe('frozen catalog A-X', () => {
  it('contains exactly 24 IDs, 72 physical copies, 10 shields and one D start', () => {
    const catalog = getTileCatalog();
    expect(catalog.rulesetId).toBe('base72');
    expect(catalog.startTileId).toBe('D');
    expect(catalog.definitions.map((d) => d.id)).toEqual('ABCDEFGHIJKLMNOPQRSTUVWX'.split(''));
    expect(catalog.definitions.map((d) => d.copies)).toEqual([
      2,4,1,4,5,2,1,3,2,3,3,3,2,3,2,3,1,3,2,1,8,9,4,1,
    ]);
    expect(catalog.definitions.reduce((sum, d) => sum + d.copies, 0)).toBe(72);
    expect(catalog.definitions.reduce((sum, d) => sum
      + d.copies * d.regions.reduce((n, r) => n + (r.kind === 'city' ? r.shields : 0), 0), 0)).toBe(10);
    expect(catalog.definitions.every((tile) => validateTileDef(tile).length === 0)).toBe(true);
    expect(typeof catalogDigest).toBe('string');
    expect(catalogDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.isFrozen(catalog.definitions)).toBe(true);
  });

  it('preserves split farmland, independent cities, junction roads and monastery', () => {
    for (const id of ['F', 'G']) {
      const tile = definitionsById.get(id)!;
      expect(tile.regions.filter((r) => r.kind === 'field')).toHaveLength(2);
      expect(tile.regions.filter((r) => r.kind === 'city')).toHaveLength(1);
    }
    for (const id of ['H', 'I']) {
      const tile = definitionsById.get(id)!;
      expect(tile.regions.filter((r) => r.kind === 'field')).toHaveLength(1);
      expect(tile.regions.filter((r) => r.kind === 'city')).toHaveLength(2);
    }
    expect(definitionsById.get('L')!.regions.filter((r) => r.kind === 'road')).toHaveLength(3);
    expect(definitionsById.get('W')!.regions.filter((r) => r.kind === 'road')).toHaveLength(3);
    expect(definitionsById.get('X')!.regions.filter((r) => r.kind === 'road')).toHaveLength(4);
    expect(definitionsById.get('A')!.regions.filter((r) => r.kind === 'field')).toHaveLength(1);
    expect(definitionsById.get('A')!.regions.filter((r) => r.kind === 'monastery')).toHaveLength(1);
    expect(definitionsById.get('B')!.regions.filter((r) => r.kind === 'monastery')).toHaveLength(1);
  });

  it('rotates all 4 directions, never loses mirrored half-port identity', () => {
    for (const r of [0, 1, 2, 3] as const) {
      expect(rotateSide('N', r)).toBe(['N','E','S','W'][r]);
      expect(rotateFieldPort('N:L', r)).toBe((['N','E','S','W'][r] as string) + ':L');
    }
    const p = { u: 0.2, v: -0.35 };
    expect(toBoardAnchor({ x: 3, z: -1, rotation: 1 }, p)).toEqual({ x: 3.35, z: -0.8 });
    expect(toBoardAnchor({ x: 3, z: -1, rotation: 3 }, p)).toEqual({ x: 2.65, z: -1.2 });
  });

  it('detects missing/duplicate ports, invalid fields and claimed symmetry', () => {
    const tile = definitionsById.get('U')!;
    expect(validateTileDef({ ...tile, rotationalSymmetry: 4 }).some((e) => e.code === 'INVALID_SYMMETRY')).toBe(true);
    const fields = tile.regions.map((r) => r.kind === 'field'
      ? { ...r, ports: r.ports.filter((p) => p !== 'N:L') } : r);
    expect(validateTileDef({ ...tile, regions: fields }).some((e) => e.code === 'MISSING_PORT')).toBe(true);
    const repeated = tile.regions.map((r) => r.kind === 'field'
      ? { ...r, ports: [...r.ports, 'N:L'] as typeof r.ports } : r);
    expect(validateTileDef({ ...tile, regions: repeated }).some((e) => e.code === 'DUPLICATE_PORT')).toBe(true);
  });
});

describe('deterministic immutable engine and replay', () => {
  it('validates setup inputs with TypeError/RangeError and normalizes colors', () => {
    expect(() => createGame({ seed: '', players })).toThrow(TypeError);
    expect(() => createGame({ seed: 'okay', players: [players[0]!] })).toThrow(RangeError);
    expect(() => createGame({ seed: 'okay', players: [{ ...players[0]!, color: 'red' as PlayerSetup['color'] }] })).toThrow(RangeError);
    expect(() => createGame({ seed: 'okay', players: [players[0]!, { ...players[1]!, heraldicSymbol: 'dragon' as PlayerSetup['heraldicSymbol'] }] })).toThrow(TypeError);
    const valid = createGame(setup);
    expect(valid.players[0]!.color).toBe('#AA3344');
    expect(valid.board[0]).toMatchObject({ defId: 'D', x: 0, z: 0, rotation: 0 });
    expect(valid.players.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(valid.meeplesLeft).toEqual({ p1: 7, p2: 7 });
    expect(isValidGameState(valid)).toBe(true);
  });

  it('property: every placed tile is edge compatible for arbitrary seeded first turns', () => {
    fc.assert(fc.property(
      fc.string({ minLength: 1, maxLength: 28 }).filter((seed) => Boolean(seed.trim())),
      fc.integer({ min: 0, max: 25 }),
      (seed, pick) => {
        const original = createGame({ ...setup, seed });
        const options = getLegalPlacements(original);
        if (!options.length) return false;
        const placement = options[pick % options.length]!;
        const result = transition(original, { type: 'PLACE_TILE', placementId: placement.id });
        return result.ok && result.state.board.length === 2 && isValidGameState(result.state)
          && JSON.stringify(original) === JSON.stringify(createGame({ ...setup, seed }));
      },
    ), { numRuns: 40 });
  });

  it('shuffles UTF16 seeds reproducibly and differs for different strings', () => {
    const numbers = Array.from({ length: 20 }, (_, i) => i);
    const a = seededShuffle(numbers, 'игра🌿');
    expect(a).toEqual(seededShuffle(numbers, 'игра🌿'));
    expect(a).not.toEqual(seededShuffle(numbers, 'игра🌾'));
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(createGame(setup)).toEqual(createGame(setup));
    expect(createGame(setup).bag.map((t) => t.id)).not.toEqual(
      createGame({ ...setup, seed: 'different' }).bag.map((t) => t.id),
    );
  });

  it('supplies all rotations sorted z/x/r and blocks invalid commands by identity', () => {
    const initial = createGame(setup);
    const legal = getLegalPlacements(initial);
    expect(legal.length).toBeGreaterThan(0);
    for (const placement of legal) {
      expect(placement.id).toBe('place:' + placement.x + ',' + placement.z + ':r' + placement.rotation);
    }
    expect(legal).toEqual([...legal].sort((a,b) => a.z - b.z || a.x - b.x || a.rotation - b.rotation));
    expect(getLegalPlacements({ ...initial, phase: 'meeple' })).toEqual([]);
    for (const command of [
      { type: 'SKIP_MEEPLE' },
      { type: 'PLACE_MEEPLE', targetId: 'region:0,0:field-1' },
      { type: 'PLACE_TILE', placementId: 'place:999,999:r0' },
      { type: 'UNLISTED' },
    ] as unknown as GameCommand[]) {
      const before = JSON.stringify(initial);
      const rejected = transition(initial, command);
      expect(rejected.ok).toBe(false);
      expect(rejected.state).toBe(initial);
      expect(JSON.stringify(initial)).toBe(before);
    }
    const broken = { ...initial, board: [...initial.board, initial.board[0]!] };
    const invalid = transition(broken, { type: 'SKIP_MEEPLE' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('CORRUPT_STATE');
  });

  it('discards impossible draws and continues the SAME turn with a placeable tile', () => {
    const normal = createGame(setup);
    // Pure draw-unit fixture: every frontier edge is city, so U (only roads
    // and fields) is unplaceable, but E has a city edge and is placeable.
    const constructed: GameState = {
      ...normal,
      board: [{ id: 'tile-C-01', defId: 'C', x: 0, z: 0, rotation: 0 }],
      pendingTile: null,
      bag: [
        { id: 'tile-U-01', defId: 'U' },
        { id: 'tile-E-01', defId: 'E' },
      ],
    };
    const result = drawPlaceable(constructed);
    expect(result.state.pendingTile?.defId).toBe('E');
    expect(result.state.discardedIds).toContain('tile-U-01');
    expect(result.events).toEqual([{ type: 'TILE_DISCARDED', tileInstanceId: 'tile-U-01' }]);
    expect(result.state.activePlayerId).toBe(normal.activePlayerId);
    expect(result.state.turn).toBe(normal.turn);
    expect(constructed.bag).toHaveLength(2);
  });

  it('moves from tile to follower; saves/restores in mid-followers and rejects bad replays', () => {
    const initial = createGame(setup);
    const option = getLegalPlacements(initial)[0]!;
    const tileState = accepted(initial, { type: 'PLACE_TILE', placementId: option.id });
    expect(tileState.phase).toBe('meeple');
    expect(tileState.history).toHaveLength(1);
    expect(tileState.board).toHaveLength(2);
    expect(getLegalPlacements(tileState)).toHaveLength(0);
    expect(selectBoardView(tileState).tiles).toEqual(tileState.board);
    expect(JSON.stringify(initial)).not.toBe(JSON.stringify(tileState));

    const copied = exportSave(tileState);
    const payload = JSON.parse(copied) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'catalogDigest', 'catalogVersion', 'commands', 'players', 'rulesetId', 'schemaVersion', 'seed',
    ].sort());
    expect(restoreSave(copied)).toEqual({ ok: true, state: tileState });
    expect(restoreSave('}{')).toMatchObject({ ok: false, error: { code: 'INVALID_JSON' } });
    expect(restoreSave(JSON.stringify({ ...payload, schemaVersion: 2 })))
      .toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_VERSION' } });
    expect(restoreSave(JSON.stringify({ ...payload, catalogDigest: 'tampered' })))
      .toMatchObject({ ok: false, error: { code: 'CATALOG_MISMATCH' } });
    expect(restoreSave(JSON.stringify({ ...payload, board: [] })))
      .toMatchObject({ ok: false, error: { code: 'INVALID_STATE' } });
    const badCommand = { type: 'PLACE_TILE', placementId: 'place:100,100:r0' };
    expect(restoreSave(JSON.stringify({ ...payload, commands: [badCommand] })))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REPLAY' } });

    const target = getLegalFollowerTargets(tileState)[0];
    const after = target ? accepted(tileState, { type: 'PLACE_MEEPLE', targetId: target.id })
      : accepted(tileState, { type: 'SKIP_MEEPLE' });
    expect(after.phase === 'tile' || after.phase === 'finished').toBe(true);
    expect(after.history).toHaveLength(2);
    expect(restoreSave(exportSave(after))).toEqual({ ok: true, state: after });
  });

  it('finishes a complete 72-tile seeded game exactly once with immutable inputs', () => {
    for (const seed of ['POSTMAN_TEST_0042', 'PROPERTY-SEED-217', 'FIVE-PLAYERS']) {
      const seats: readonly PlayerSetup[] = seed === 'FIVE-PLAYERS' ? [
        ...players,
        { name: 'П3', color: '#BB5511', heraldicSymbol: 'sun' as const },
        { name: 'П4', color: '#225544', heraldicSymbol: 'tower' as const },
        { name: 'П5', color: '#996699', heraldicSymbol: 'eagle' as const },
      ] : players;
      let state = createGame({ seed, players: seats });
      let steps = 0;
      while (state.phase !== 'finished' && steps < 150) {
        steps++;
        if (state.phase === 'tile') {
          const placements = getLegalPlacements(state);
          expect(placements.length).toBeGreaterThan(0);
          const chosen = placements[(steps * 7) % placements.length]!;
          const oldState = state;
          state = accepted(state, { type: 'PLACE_TILE', placementId: chosen.id });
          expect(oldState.phase).toBe('tile');
          expect(oldState.history).toHaveLength(state.history.length - 1);
        } else {
          const targets = getLegalFollowerTargets(state);
          const command: GameCommand = targets.length > 0 && steps % 3 === 0
            ? { type: 'PLACE_MEEPLE', targetId: targets[0]!.id }
            : { type: 'SKIP_MEEPLE' };
          state = accepted(state, command);
        }
        expect(isValidGameState(state)).toBe(true);
      }
      expect(steps).toBeLessThan(150);
      expect(state.phase).toBe('finished');
      expect(state.board.length + state.discardedIds.length).toBe(72);
      expect(state.bag).toHaveLength(0);
      expect(state.pendingTile).toBeNull();
      expect(state.activePlayerId).toBeNull();
      const terminal = transition(state, { type: 'SKIP_MEEPLE' });
      expect(terminal.ok).toBe(false);
      expect(terminal.state).toBe(state);
      expect(restoreSave(exportSave(state))).toEqual({ ok: true, state });
    }
  }, 180_000);
});
