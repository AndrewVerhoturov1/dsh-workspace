import { describe, expect, it } from 'vitest';
import type { GameState, PlacedMeeple, PlacedTile, Rotation } from './types';
import { createGame } from './reducer';
import { definitionsById } from './catalog';
import {
  buildFeatureGraph, completedCitiesAroundFarm, participants,
} from './connectivity';
import { getLegalFollowerTargets } from './selectors';
import { majorityPlayers, scoreFinalFeatures, settleCompletedFeatures } from './scoring';

function tile(id: string, x: number, z: number, rotation: Rotation = 0): PlacedTile {
  return { id: ('tile-' + id + '-' + x + '-' + z) as PlacedTile['id'], defId: id, x, z, rotation };
}
const follower = (id: string, playerId: 'p1' | 'p2' | 'p3', placed: PlacedTile, regionId: string): PlacedMeeple => ({
  id: ('meeple-' + id) as PlacedMeeple['id'],
  playerId,
  targetId: ('region:' + placed.x + ',' + placed.z + ':' + regionId) as PlacedMeeple['targetId'],
});
function fixture(placed: readonly PlacedTile[], meeples: readonly PlacedMeeple[] = []): GameState {
  const start = createGame({
    seed: 'SCORING-FIXTURE',
    players: [
      { name: 'Красный', color: '#AA2233', heraldicSymbol: 'lion' },
      { name: 'Синий', color: '#2233AA', heraldicSymbol: 'eagle' },
      { name: 'Зелёный', color: '#337722', heraldicSymbol: 'oak' },
    ],
  });
  const counts: Record<string, number> = { p1: 7, p2: 7, p3: 7 };
  for (const m of meeples) counts[m.playerId] = (counts[m.playerId] ?? 0) - 1;
  return {
    ...start,
    phase: 'meeple', board: placed, meeples,
    scores: { p1: 0, p2: 0, p3: 0 },
    meeplesLeft: counts, bag: [], pendingTile: null,
    currentPlacedId: placed[placed.length - 1]?.id ?? null,
  };
}

describe('physical feature geometry, completion and followers', () => {
  it('counts a two-tile completed city as 4 points, with immediate follower return', () => {
    const d = tile('D', 0, 0);
    const e = tile('E', 1, 0, 3);
    const meeple = follower('one', 'p1', d, 'city-1');
    const state = fixture([d, e], [meeple]);
    const graph = buildFeatureGraph(state.board, definitionsById);
    const city = graph.byTarget.get(meeple.targetId)!;
    expect(city.complete).toBe(true);
    expect(city.tileIds.size).toBe(2);
    const settled = settleCompletedFeatures(state, e);
    expect(settled.state.scores.p1).toBe(4);
    expect(settled.state.meeples).toHaveLength(0);
    expect(settled.state.meeplesLeft.p1).toBe(7);
    expect(settled.events).toMatchObject([
      { type: 'FEATURE_SCORED', kind: 'city', pointsEach: 4, winnerIds: ['p1'] },
      { type: 'MEEPLES_RETURNED', ids: ['meeple-one'] },
    ]);
    // Scoring a completed unoccupied feature a second time cannot award points.
    expect(settleCompletedFeatures(settled.state, e).state.scores.p1).toBe(4);
  });

  it('merges previously separate occupied cities, awarding the full majority tie to each', () => {
    const lcap = tile('E', -2, 0, 1);
    const l = tile('H', -1, 0);
    const bridge = tile('F', 0, 0);
    const r = tile('H', 1, 0);
    const rcap = tile('E', 2, 0, 3);
    const first = follower('left', 'p1', l, 'city-2');
    const second = follower('right', 'p2', r, 'city-1');
    const before = buildFeatureGraph([lcap, l, r, rcap], definitionsById);
    expect(before.byTarget.get(first.targetId)).not.toBe(before.byTarget.get(second.targetId));
    const state = fixture([lcap, l, bridge, r, rcap], [first, second]);
    const graph = buildFeatureGraph(state.board, definitionsById);
    const combined = graph.byTarget.get(first.targetId)!;
    expect(combined).toBe(graph.byTarget.get(second.targetId));
    expect(combined.complete).toBe(true);
    // The H outer city stubs are separate; only the inward H halves join F.
    expect(combined.tileIds.size).toBe(3);
    expect(combined.shields).toBe(1);
    const result = settleCompletedFeatures(state, bridge);
    expect(result.state.scores).toEqual({ p1: 8, p2: 8, p3: 0 });
    expect(result.state.meeples).toEqual([]);
    expect(result.state.meeplesLeft).toEqual({ p1: 7, p2: 7, p3: 7 });
    expect(result.events.find((e) => e.type === 'FEATURE_SCORED')).toMatchObject({
      kind: 'city', pointsEach: 8, winnerIds: ['p1', 'p2'],
    });
  });

  it('keeps 3-way and 4-way road junctions disconnected locally', () => {
    const triple = tile('W', 0, 0);
    const cross = tile('X', 3, 3);
    const graph = buildFeatureGraph([triple, cross], definitionsById);
    const components = graph.features.filter((f) => f.kind === 'road');
    expect(components).toHaveLength(7);
    for (const region of ['road-1','road-2','road-3']) {
      expect(graph.byTarget.get('region:0,0:' + region)).toBeTruthy();
    }
    expect(graph.byTarget.get('region:0,0:road-1'))
      .not.toBe(graph.byTarget.get('region:0,0:road-2'));
  });

  it('recognizes a completed 4-corner loop as four physical tiles, not eight road sides', () => {
    const nw = tile('V', 0, 0, 3);
    const ne = tile('V', 1, 0, 0);
    const se = tile('V', 1, 1, 1);
    const sw = tile('V', 0, 1, 2);
    const token = follower('road', 'p2', nw, 'road-1');
    const state = fixture([nw, ne, se, sw], [token]);
    const road = buildFeatureGraph(state.board, definitionsById).byTarget.get(token.targetId)!;
    expect(road.kind).toBe('road');
    expect(road.openEdges).toBe(0);
    expect(road.tileIds.size).toBe(4);
    const scored = settleCompletedFeatures(state, sw);
    expect(scored.state.scores.p2).toBe(4);
    expect(scored.state.meeples).toHaveLength(0);
  });

  it('completes a monastery exactly at its eighth neighbor, returning the monk', () => {
    const center = tile('B', 0, 0);
    const all = [center];
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
      if (x !== 0 || z !== 0) all.push(tile('B', x, z));
    }
    const monk = follower('monk', 'p1', center, 'monastery-1');
    const graph = buildFeatureGraph(all, definitionsById);
    const feature = graph.byTarget.get(monk.targetId)!;
    expect(feature.monasteryNeighbors).toBe(8);
    expect(feature.complete).toBe(true);
    const scored = settleCompletedFeatures(fixture(all, [monk]), all[all.length - 1]!);
    expect(scored.state.scores.p1).toBe(9);
    expect(scored.state.meeplesLeft.p1).toBe(7);
  });

  it('blocks new meeples on the same occupied connected farm, but not a nearby cloister', () => {
    const old = tile('B', 0, 0);
    const fresh = tile('B', 1, 0);
    const state: GameState = {
      ...fixture([old, fresh], [follower('existing', 'p1', old, 'field-1')]),
      activePlayerId: 'p2', currentPlacedId: fresh.id,
    };
    const choices = getLegalFollowerTargets(state);
    expect(choices.some((t) => t.regionId === 'field-1')).toBe(false);
    expect(choices.some((t) => t.regionId === 'monastery-1')).toBe(true);
  });
});

describe('majority, fields and end-game scoring', () => {
  it('majority awards only players tied at the highest follower count', () => {
    const a = tile('B', 0, 0);
    const b = tile('B', 1, 0);
    const followers = [
      follower('one', 'p1', a, 'field-1'),
      follower('two', 'p1', b, 'field-1'),
      follower('three', 'p2', a, 'field-1'),
    ];
    expect(majorityPlayers(followers, fixture([a,b]).players)).toEqual(['p1']);
    expect(majorityPlayers(followers.slice(0,2), fixture([a,b]).players)).toEqual(['p1']);
    expect(majorityPlayers([], fixture([a,b]).players)).toEqual([]);
  });

  it('counts a completed city once per farm even if touched by multiple local field regions', () => {
    const b0 = tile('B', 0, 0);
    const b1 = tile('B', 1, 0);
    const bn = tile('B', 1, -1);
    const e1 = tile('E', 2, 0);
    const e2 = tile('E', 2, -1, 2);
    const participantsOnFarm = [
      follower('farmer-a', 'p1', b0, 'field-1'),
      follower('farmer-b', 'p2', b1, 'field-1'),
    ];
    const state = fixture([b0, b1, bn, e1, e2], participantsOnFarm);
    const graph = buildFeatureGraph(state.board, definitionsById);
    const farm = graph.byTarget.get(participantsOnFarm[0]!.targetId)!;
    expect(farm).toBe(graph.byTarget.get(participantsOnFarm[1]!.targetId));
    const city1 = graph.byTarget.get('region:2,0:city-1')!;
    const city2 = graph.byTarget.get('region:2,-1:city-1')!;
    expect(city1).toBe(city2);
    expect(city1.complete).toBe(true);
    expect(completedCitiesAroundFarm(farm, graph).size).toBe(1);
    expect(participants(farm, state.meeples, graph)).toHaveLength(2);
    const final = scoreFinalFeatures(state);
    expect(final.state.scores.p1).toBe(3);
    expect(final.state.scores.p2).toBe(3);
    expect(final.events.filter((e) => e.type === 'FEATURE_SCORED' && e.kind === 'field')).toHaveLength(1);
    expect(final.state.meeples).toEqual(participantsOnFarm); // farmers never reclaimed
  });

  it('scores independent farms around the same completed city separately', () => {
    const d = tile('D', 0, 0);
    const e = tile('E', 1, 0, 3);
    const l = follower('western', 'p1', d, 'field-2');
    const r = follower('eastern', 'p2', e, 'field-1');
    const state = fixture([d, e], [l, r]);
    const graph = buildFeatureGraph(state.board, definitionsById);
    expect(graph.byTarget.get(l.targetId)).not.toBe(graph.byTarget.get(r.targetId));
    expect(scoreFinalFeatures(state).state.scores).toEqual({ p1: 3, p2: 3, p3: 0 });
  });

  it('scores uncompleted city with shield and unfinished cloister at one per tile', () => {
    const city = tile('C', 0, 0);
    const knight = follower('knight', 'p1', city, 'city-1');
    const cityResult = scoreFinalFeatures(fixture([city], [knight]));
    expect(cityResult.state.scores.p1).toBe(2); // 1 tile + 1 pennant
    expect(cityResult.events).toContainEqual(expect.objectContaining({
      type: 'FEATURE_SCORED', kind: 'city', completed: false, pointsEach: 2,
    }));
    const cloister = tile('B', 0, 0);
    const adjacent = tile('B', 1, 0);
    const diagonal = tile('B', 1, 1);
    const monk = follower('cloister', 'p2', cloister, 'monastery-1');
    const partial = scoreFinalFeatures(fixture([cloister, adjacent, diagonal], [monk]));
    expect(partial.state.scores.p2).toBe(3);
    expect(partial.events.at(-1)?.type).toBe('GAME_FINISHED');
  });

  it('only scores farmers for closed cities, never a city with an open edge', () => {
    const d = tile('D', 0, 0);
    const farmer = follower('farmer', 'p1', d, 'field-2');
    const state = fixture([d], [farmer]);
    expect(scoreFinalFeatures(state).state.scores.p1).toBe(0);
  });
});
