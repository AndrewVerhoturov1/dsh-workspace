import type {
  FieldPort, PlacedMeeple, PlacedTile, Side, TileDef, TileRegion,
} from './types';
import { boardKey, facingPort, oppositeSide, rotateFieldPort, rotateSide, SIDE_VECTORS } from './geometry';

export interface FeatureNode {
  readonly key: string;
  readonly tile: PlacedTile;
  readonly def: TileDef;
  readonly region: TileRegion;
}

export interface Feature {
  readonly key: string;
  readonly kind: TileRegion['kind'];
  readonly nodes: readonly FeatureNode[];
  readonly tileIds: ReadonlySet<string>;
  readonly openEdges: number;
  readonly shields: number;
  readonly monasteryNeighbors: number;
  readonly complete: boolean;
}

export interface FeatureGraph {
  readonly features: readonly Feature[];
  readonly byNode: ReadonlyMap<string, Feature>;
  readonly byTarget: ReadonlyMap<string, Feature>;
}

export function nodeKey(tileId: string, regionId: string): string {
  return tileId + '/' + regionId;
}

function sidesToWorld(tile: PlacedTile, region: Extract<TileRegion, { kind: 'city' | 'road' }>): Side[] {
  return region.sides.map((side) => rotateSide(side, tile.rotation));
}

function regionAtSide(tile: PlacedTile, def: TileDef, side: Side, kind: 'city' | 'road'): TileRegion | undefined {
  return def.regions.find((region) => region.kind === kind
    && sidesToWorld(tile, region).includes(side));
}

function regionAtPort(tile: PlacedTile, def: TileDef, port: FieldPort): TileRegion | undefined {
  return def.regions.find((region) => region.kind === 'field'
    && region.ports.some((local) => rotateFieldPort(local, tile.rotation) === port));
}

function neighbors8(placed: PlacedTile, positions: ReadonlyMap<string, PlacedTile>): number {
  let count = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      if (positions.has(boardKey(placed.x + dx, placed.z + dz))) count++;
    }
  }
  return count;
}

/** Per-tile local pieces join only where their matching borders/half-ports meet. */
export function buildFeatureGraph(
  board: readonly PlacedTile[],
  definitions: ReadonlyMap<string, TileDef>,
): FeatureGraph {
  const positions = new Map<string, PlacedTile>(board.map((tile) => [boardKey(tile.x, tile.z), tile]));
  const nodes = new Map<string, FeatureNode>();
  const parent = new Map<string, string>();
  for (const tile of board) {
    const def = definitions.get(tile.defId);
    if (!def) continue;
    for (const region of def.regions) {
      const key = nodeKey(tile.id, region.id);
      nodes.set(key, { key, tile, def, region });
      parent.set(key, key);
    }
  }
  const root = (key: string): string => {
    let p = parent.get(key);
    if (!p) return key;
    while (p !== parent.get(p)) {
      const next = parent.get(p);
      if (!next) break;
      p = next;
    }
    return p;
  };
  const unite = (a: string, b: string): void => {
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb && parent.has(ra) && parent.has(rb)) parent.set(rb, ra);
  };

  // Only E/S to avoid duplicate edges; both L/R half-ports must mirror at seams.
  for (const tile of board) {
    const def = definitions.get(tile.defId);
    if (!def) continue;
    for (const side of ['E', 'S'] as const) {
      const v = SIDE_VECTORS[side];
      const other = positions.get(boardKey(tile.x + v.x, tile.z + v.z));
      if (!other) continue;
      const neighbor = definitions.get(other.defId);
      if (!neighbor) continue;
      const back = oppositeSide(side);
      for (const kind of ['city', 'road'] as const) {
        const one = regionAtSide(tile, def, side, kind);
        const two = regionAtSide(other, neighbor, back, kind);
        if (one && two) unite(nodeKey(tile.id, one.id), nodeKey(other.id, two.id));
      }
      for (const half of ['L', 'R'] as const) {
        const port = (side + ':' + half) as FieldPort;
        const from = regionAtPort(tile, def, port);
        const to = regionAtPort(other, neighbor, facingPort(port));
        if (from && to) unite(nodeKey(tile.id, from.id), nodeKey(other.id, to.id));
      }
    }
  }

  const groups = new Map<string, FeatureNode[]>();
  for (const [key, node] of nodes) {
    const component = root(key);
    const group = groups.get(component) ?? [];
    group.push(node);
    groups.set(component, group);
  }
  const features: Feature[] = [];
  const byNode = new Map<string, Feature>();
  const byTarget = new Map<string, Feature>();
  for (const [key, parts] of groups) {
    const first = parts[0]!;
    const kind = first.region.kind;
    const tileIds = new Set(parts.map((part) => part.tile.id));
    let openEdges = 0;
    let shields = 0;
    let monasteryNeighbors = 0;
    for (const part of parts) {
      if (part.region.kind === 'city') shields += part.region.shields;
      if (part.region.kind === 'city' || part.region.kind === 'road') {
        for (const side of sidesToWorld(part.tile, part.region)) {
          const v = SIDE_VECTORS[side];
          if (!positions.has(boardKey(part.tile.x + v.x, part.tile.z + v.z))) openEdges++;
        }
      }
      if (part.region.kind === 'monastery') {
        monasteryNeighbors = neighbors8(part.tile, positions);
      }
    }
    const complete = kind === 'monastery' ? monasteryNeighbors === 8
      : (kind === 'city' || kind === 'road') && openEdges === 0;
    const feature: Feature = {
      key, kind, nodes: parts, tileIds,
      openEdges, shields, monasteryNeighbors, complete,
    };
    features.push(feature);
    for (const node of parts) {
      byNode.set(node.key, feature);
      byTarget.set('region:' + node.tile.x + ',' + node.tile.z + ':' + node.region.id, feature);
    }
  }
  return { features, byNode, byTarget };
}

/** Stable representatives used exclusively for graph lookup, never public target IDs. */
export function participants(
  feature: Feature, followers: readonly PlacedMeeple[], graph: FeatureGraph,
): readonly PlacedMeeple[] {
  return followers.filter((follower) => graph.byTarget.get(follower.targetId) === feature);
}

/**
 * A farm's touching city references are LOCAL and must be resolved against
 * the final city union, so each distinct completed city contributes once.
 */
export function completedCitiesAroundFarm(field: Feature, graph: FeatureGraph): ReadonlySet<Feature> {
  const found = new Set<Feature>();
  if (field.kind !== 'field') return found;
  for (const node of field.nodes) {
    if (node.region.kind !== 'field') continue;
    for (const cityId of node.region.touchingCities) {
      const city = graph.byNode.get(nodeKey(node.tile.id, cityId));
      if (city?.kind === 'city' && city.complete) found.add(city);
    }
  }
  return found;
}

export function featureTouchesPlacedTile(feature: Feature, tile: PlacedTile): boolean {
  if (feature.kind === 'monastery') {
    const origin = feature.nodes[0]?.tile;
    return Boolean(origin && Math.abs(origin.x - tile.x) <= 1 && Math.abs(origin.z - tile.z) <= 1);
  }
  return feature.tileIds.has(tile.id);
}
