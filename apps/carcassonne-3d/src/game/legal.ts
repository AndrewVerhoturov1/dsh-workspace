import type { PlacementOption, PlacedTile, TileDef } from './types';
import { boardKey, edgeAt, oppositeSide, ROTATIONS, SIDES, SIDE_VECTORS } from './geometry';

export function findPlacements(
  board: readonly PlacedTile[],
  definition: TileDef,
  definitions: ReadonlyMap<string, TileDef>,
  limit = Infinity,
): PlacementOption[] {
  if (board.length === 0) return [];
  const occupied = new Map(board.map((tile) => [boardKey(tile.x, tile.z), tile]));
  const candidates = new Map<string, { x: number; z: number }>();
  for (const tile of board) {
    for (const side of SIDES) {
      const delta = SIDE_VECTORS[side];
      const x = tile.x + delta.x;
      const z = tile.z + delta.z;
      const key = boardKey(x, z);
      if (!occupied.has(key)) candidates.set(key, { x, z });
    }
  }
  const results: PlacementOption[] = [];
  for (const position of candidates.values()) {
    for (const rotation of ROTATIONS) {
      let connects = 0;
      let compatible = true;
      for (const side of SIDES) {
        const step = SIDE_VECTORS[side];
        const adjacent = occupied.get(boardKey(position.x + step.x, position.z + step.z));
        if (!adjacent) continue;
        connects++;
        const neighborDef = definitions.get(adjacent.defId);
        if (!neighborDef || edgeAt(definition, side, rotation)
          !== edgeAt(neighborDef, oppositeSide(side), adjacent.rotation)) {
          compatible = false;
          break;
        }
      }
      if (compatible && connects > 0) {
        results.push({
          x: position.x, z: position.z, rotation,
          id: ('place:' + position.x + ',' + position.z + ':r' + rotation) as PlacementOption['id'],
        });
        if (results.length >= limit && Number.isFinite(limit)) return results;
      }
    }
  }
  return results.sort((a, b) => a.z - b.z || a.x - b.x || a.rotation - b.rotation);
}
