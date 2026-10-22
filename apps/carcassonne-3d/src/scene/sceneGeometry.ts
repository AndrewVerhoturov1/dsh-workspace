import * as runtimeGame from '../game';
import type { Anchor, PlacedTile, Rotation } from '../game';
import type { CameraPose } from './types';

type TileCoords = Pick<PlacedTile, 'x' | 'z' | 'rotation'>;
const optionalGeometry = runtimeGame as typeof runtimeGame & {
  toBoardAnchor?: (tile: TileCoords, anchor: Anchor) => { readonly x: number; readonly z: number };
};

export function anchorOnBoard(tile: TileCoords, anchor: Anchor): { x: number; z: number } {
  // G has only type exports in the frozen foundation. Prefer its pure helper as
  // soon as the independently developed runtime publishes it.
  if (typeof optionalGeometry.toBoardAnchor === 'function') {
    return optionalGeometry.toBoardAnchor(tile, anchor);
  }
  switch (tile.rotation) {
    case 0: return { x: tile.x + anchor.u, z: tile.z + anchor.v };
    case 1: return { x: tile.x - anchor.v, z: tile.z + anchor.u };
    case 2: return { x: tile.x - anchor.u, z: tile.z - anchor.v };
    case 3: return { x: tile.x + anchor.v, z: tile.z - anchor.u };
  }
}

export function rotationRadians(rotation: Rotation): number {
  return -rotation * Math.PI / 2;
}

export interface BoardExtents {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function calculateExtents(tiles: readonly { x: number; z: number }[]): BoardExtents {
  if (tiles.length === 0) return { minX: -1.5, maxX: 1.5, minZ: -1.5, maxZ: 1.5 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const tile of tiles) {
    minX = Math.min(minX, tile.x - 0.5);
    maxX = Math.max(maxX, tile.x + 0.5);
    minZ = Math.min(minZ, tile.z - 0.5);
    maxZ = Math.max(maxZ, tile.z + 0.5);
  }
  return { minX, maxX, minZ, maxZ };
}

/** Perspective fit with conservative depth margin, used by main scene and UI. */
export function fitCameraPose(
  tiles: readonly { x: number; z: number }[],
  aspect: number,
  azimuth = Math.PI / 5,
  elevation = Math.PI * 0.365,
): CameraPose {
  const bounds = calculateExtents(tiles);
  const width = bounds.maxX - bounds.minX + 1.0;
  const depth = bounds.maxZ - bounds.minZ + 1.0;
  const c = Math.abs(Math.cos(azimuth));
  const s = Math.abs(Math.sin(azimuth));
  const visibleWidth = width * c + depth * s;
  const visibleHeight = (width * s + depth * c) * Math.sin(elevation);
  const tanHalfFov = Math.tan(43 * Math.PI / 360);
  const safeAspect = Math.max(0.4, Math.min(4, aspect || 1));
  const distance = Math.max(
    3.3,
    Math.max(visibleWidth / safeAspect, visibleHeight) / (2 * tanHalfFov) * 1.34,
  );
  return {
    target: { x: (bounds.minX + bounds.maxX) / 2, y: 0, z: (bounds.minZ + bounds.maxZ) / 2 },
    distance: Math.min(90, distance),
    azimuth,
    elevation,
  };
}

export function clampPose(pose: CameraPose, bounds: BoardExtents): CameraPose {
  const centerX = (bounds.maxX + bounds.minX) / 2;
  const centerZ = (bounds.maxZ + bounds.minZ) / 2;
  const spanX = Math.max(2, bounds.maxX - bounds.minX);
  const spanZ = Math.max(2, bounds.maxZ - bounds.minZ);
  return {
    target: {
      x: Math.max(centerX - spanX * 0.8 - 1.4, Math.min(centerX + spanX * 0.8 + 1.4, pose.target.x)),
      y: Math.max(-0.5, Math.min(1.4, pose.target.y)),
      z: Math.max(centerZ - spanZ * 0.8 - 1.4, Math.min(centerZ + spanZ * 0.8 + 1.4, pose.target.z)),
    },
    distance: Math.max(1.65, Math.min(90, pose.distance)),
    azimuth: pose.azimuth,
    elevation: Math.max(Math.PI / 7, Math.min(Math.PI * 0.46, pose.elevation)),
  };
}
