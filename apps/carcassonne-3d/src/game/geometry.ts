import type { Anchor, FieldPort, PlacedTile, Rotation, Side, Terrain, TileDef } from './types';

export const SIDES = ['N', 'E', 'S', 'W'] as const satisfies readonly Side[];
export const ROTATIONS = [0, 1, 2, 3] as const satisfies readonly Rotation[];

export const SIDE_VECTORS: Readonly<Record<Side, { readonly x: number; readonly z: number }>> = {
  N: { x: 0, z: -1 }, E: { x: 1, z: 0 },
  S: { x: 0, z: 1 }, W: { x: -1, z: 0 },
};

export function rotateSide(side: Side, rotation: Rotation): Side {
  return SIDES[(SIDES.indexOf(side) + rotation) % 4]!;
}

export function rotateFieldPort(port: FieldPort, rotation: Rotation): FieldPort {
  const [side, half] = port.split(':') as [Side, 'L' | 'R'];
  return (rotateSide(side, rotation) + ':' + half) as FieldPort;
}

export function oppositeSide(side: Side): Side {
  return rotateSide(side, 2);
}

export function facingPort(port: FieldPort): FieldPort {
  const [side, half] = port.split(':') as [Side, 'L' | 'R'];
  return (oppositeSide(side) + ':' + (half === 'L' ? 'R' : 'L')) as FieldPort;
}

export function toBoardAnchor(
  tile: Pick<PlacedTile, 'x' | 'z' | 'rotation'>,
  anchor: Anchor,
): { readonly x: number; readonly z: number } {
  const { u, v } = anchor;
  switch (tile.rotation) {
    case 0: return { x: tile.x + u, z: tile.z + v };
    case 1: return { x: tile.x - v, z: tile.z + u };
    case 2: return { x: tile.x - u, z: tile.z - v };
    case 3: return { x: tile.x + v, z: tile.z - u };
  }
}

export function edgeAt(tile: TileDef, worldSide: Side, rotation: Rotation): Terrain {
  const local = rotateSide(worldSide, ((4 - rotation) % 4) as Rotation);
  return tile.edges[SIDES.indexOf(local)]!;
}

export function boardKey(x: number, z: number): string {
  return x + ',' + z;
}

export function regionTarget(x: number, z: number, regionId: string): `region:${number},${number}:${string}` {
  return ('region:' + x + ',' + z + ':' + regionId) as `region:${number},${number}:${string}`;
}

export function fieldPortAnchor(port: FieldPort): Anchor {
  const side = port[0] as Side;
  const offset = port[2] === 'L' ? -0.32 : 0.32;
  switch (side) {
    case 'N': return { u: offset, v: -0.46 };
    case 'E': return { u: 0.46, v: offset };
    case 'S': return { u: -offset, v: 0.46 };
    case 'W': return { u: -0.46, v: -offset };
  }
}
