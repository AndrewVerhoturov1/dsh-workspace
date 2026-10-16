import type { GameEvent, GameState, PlacedMeeple, PlacedTile, PlayerId } from './types';
import {
  buildFeatureGraph, completedCitiesAroundFarm, featureTouchesPlacedTile,
  participants,
} from './connectivity';
import type { Feature, FeatureGraph } from './connectivity';
import { definitionsById } from './catalog';

export function majorityPlayers(
  meeples: readonly PlacedMeeple[],
  players: GameState['players'],
): readonly PlayerId[] {
  if (!meeples.length) return [];
  const totals = new Map<PlayerId, number>();
  for (const meeple of meeples) totals.set(meeple.playerId, (totals.get(meeple.playerId) ?? 0) + 1);
  const most = Math.max(...totals.values());
  return players.filter((player) => (totals.get(player.id) ?? 0) === most).map((player) => player.id);
}

export function featurePoints(feature: Feature, completed: boolean): number {
  switch (feature.kind) {
    case 'road': return feature.tileIds.size;
    case 'city': return (feature.tileIds.size + feature.shields) * (completed ? 2 : 1);
    case 'monastery': return 1 + feature.monasteryNeighbors;
    case 'field': return 0;
  }
}

function award(
  scores: Record<string, number>,
  winners: readonly PlayerId[],
  amount: number,
): void {
  for (const winner of winners) scores[winner] = (scores[winner] ?? 0) + amount;
}

function graphFor(state: GameState): FeatureGraph {
  return buildFeatureGraph(state.board, definitionsById);
}

/**
 * Score newly closed features AFTER the meeple-placement decision; reclaim
 * all involved knights, travelers and monks, including losing minorities.
 * Farmers never enter this loop and cannot be reclaimed during play.
 */
export function settleCompletedFeatures(
  state: GameState,
  placed: PlacedTile,
): { state: GameState; events: readonly GameEvent[] } {
  const graph = graphFor(state);
  const scores = { ...state.scores };
  const returned = new Set<string>();
  const events: GameEvent[] = [];
  for (const feature of graph.features) {
    if (!feature.complete || feature.kind === 'field' || !featureTouchesPlacedTile(feature, placed)) continue;
    const all = participants(feature, state.meeples, graph);
    if (!all.length) continue;
    const winners = majorityPlayers(all, state.players);
    const pointsEach = featurePoints(feature, true);
    award(scores, winners, pointsEach);
    events.push({ type: 'FEATURE_SCORED', kind: feature.kind, winnerIds: winners, pointsEach, completed: true });
    for (const meeple of all) returned.add(meeple.id);
  }
  const reclaimed = state.meeples.filter((meeple) => returned.has(meeple.id));
  const available = { ...state.meeplesLeft };
  for (const meeple of reclaimed) available[meeple.playerId] = (available[meeple.playerId] ?? 0) + 1;
  if (reclaimed.length) events.push({ type: 'MEEPLES_RETURNED', ids: reclaimed.map((m) => m.id) });
  return {
    state: {
      ...state,
      scores,
      meeplesLeft: available,
      meeples: state.meeples.filter((meeple) => !returned.has(meeple.id)),
    },
    events,
  };
}

/** One terminal pass, only after the last drawable tile and regular scoring. */
export function scoreFinalFeatures(state: GameState): { state: GameState; events: readonly GameEvent[] } {
  const graph = graphFor(state);
  const scores: Record<string, number> = { ...state.scores };
  const events: GameEvent[] = [];

  for (const feature of graph.features) {
    if (feature.kind === 'field' || feature.complete) continue;
    const meeples = participants(feature, state.meeples, graph);
    if (!meeples.length) continue;
    const winners = majorityPlayers(meeples, state.players);
    const pointsEach = featurePoints(feature, false);
    award(scores, winners, pointsEach);
    events.push({
      type: 'FEATURE_SCORED', kind: feature.kind, winnerIds: winners, pointsEach, completed: false,
    });
  }

  for (const farm of graph.features) {
    if (farm.kind !== 'field') continue;
    const farmers = participants(farm, state.meeples, graph);
    if (!farmers.length) continue;
    const completedCities = completedCitiesAroundFarm(farm, graph);
    const pointsEach = completedCities.size * 3;
    if (!pointsEach) continue;
    const winners = majorityPlayers(farmers, state.players);
    award(scores, winners, pointsEach);
    events.push({ type: 'FEATURE_SCORED', kind: 'field', winnerIds: winners, pointsEach, completed: false });
  }

  const finished: GameState = {
    ...state, phase: 'finished', activePlayerId: null,
    pendingTile: null, currentPlacedId: null, bag: [], scores,
  };
  events.push({ type: 'GAME_FINISHED', scores: { ...scores } });
  return { state: finished, events };
}
