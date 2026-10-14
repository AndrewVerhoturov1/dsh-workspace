import type { BoardView, FollowerTarget, GameState, PlacementOption, PlacedTile } from './types';
import { definitionsById } from './catalog';
import { buildFeatureGraph } from './connectivity';
import { regionTarget } from './geometry';
import { findPlacements } from './legal';

export function getLegalPlacements(state: GameState): readonly PlacementOption[] {
  if (state.phase !== 'tile' || !state.pendingTile) return [];
  const def = definitionsById.get(state.pendingTile.defId);
  return def ? findPlacements(state.board, def, definitionsById) : [];
}

export function getLegalFollowerTargets(state: GameState): readonly FollowerTarget[] {
  if (state.phase !== 'meeple' || !state.activePlayerId || !state.currentPlacedId
    || (state.meeplesLeft[state.activePlayerId] ?? 0) <= 0) return [];
  const placed = state.board.find((tile) => tile.id === state.currentPlacedId);
  if (!placed) return [];
  const def = definitionsById.get(placed.defId);
  if (!def) return [];
  const graph = buildFeatureGraph(state.board, definitionsById);
  const occupied = new Set(state.meeples.map((meeple) => graph.byTarget.get(meeple.targetId)?.key));
  return def.regions.filter((region) => {
    const component = graph.byTarget.get(regionTarget(placed.x, placed.z, region.id));
    return Boolean(component && !occupied.has(component.key));
  }).map((region) => ({
    id: regionTarget(placed.x, placed.z, region.id),
    tileInstanceId: placed.id,
    regionId: region.id, kind: region.kind, anchor: region.anchor,
  }));
}

export function selectBoardView(state: GameState): BoardView {
  return {
    phase: state.phase,
    tiles: state.board as readonly PlacedTile[],
    meeples: state.meeples,
    pendingTile: state.pendingTile,
    players: state.players,
    activePlayerId: state.activePlayerId,
  };
}
