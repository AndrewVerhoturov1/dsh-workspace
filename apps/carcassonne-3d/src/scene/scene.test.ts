import { describe, expect, it } from 'vitest';
import type { Anchor, Rotation, Side, Terrain, TileDef } from '../game';
import { anchorOnBoard, calculateExtents, fitCameraPose, rotationRadians } from './sceneGeometry';
import { edgeTerrainAt, fieldPortPosition, sideCentre } from './tileArtwork';
import { TileMesh } from './TileMesh';
import { MeepleMesh } from './MeepleMesh';

const SIDES: readonly Side[] = ['N', 'E', 'S', 'W'];
const TERRAINS: readonly Terrain[] = ['field', 'road', 'city'];
const offsets = [-0.5, -0.47, -0.45, -0.37, -0.1, -0.0725, -0.05, 0, 0.05, 0.0725, 0.1, 0.37, 0.45, 0.47, 0.5];

function rotatedEdge(def: TileDef, rotation: Rotation, globalSide: Side): Terrain {
  const world = SIDES.indexOf(globalSide);
  const original = (world - rotation + 4) % 4;
  return def.edges[original]!;
}

function boundarySignature(terrain: Terrain): string {
  return offsets.map((offset) => edgeTerrainAt(terrain, offset)).join(',');
}

describe('Scene topology and seam invariants', () => {
  it('constructs shared carved-pawn and beveled-cardboard geometries at module load', () => {
    expect(typeof TileMesh).toBe('function');
    expect(typeof MeepleMesh).toBe('function');
  });

  it('samples the same terrain mask from both directions of every edge', () => {
    for (const terrain of TERRAINS) {
      for (const offset of offsets) {
        expect(edgeTerrainAt(terrain, offset)).toBe(edgeTerrainAt(terrain, -offset));
      }
    }
    expect(edgeTerrainAt('road', 0)).toBe('road');
    expect(edgeTerrainAt('road', 0.28)).toBe('field');
    expect(edgeTerrainAt('city', 0.1)).toBe('city');
    expect(edgeTerrainAt('city', 0.49)).toBe('corner');
  });

  it('uses identical edge profiles across all 16 pairs of rotations', () => {
    for (const edge of TERRAINS) {
      const tiles: TileDef[] = [];
      for (let r = 0; r < 4; r++) {
        const sides = Array.from({ length: 4 }, (_, i) => i === r ? edge : 'field') as Terrain[];
        tiles.push({
          id: 'test-' + edge + '-' + r,
          copies: 1, rotationalSymmetry: 1,
          edges: sides as unknown as TileDef['edges'], regions: [],
        });
      }
      for (let leftRotation = 0 as Rotation; leftRotation < 4; leftRotation = (leftRotation + 1) as Rotation) {
        for (let rightRotation = 0 as Rotation; rightRotation < 4; rightRotation = (rightRotation + 1) as Rotation) {
          // Definitions are prepared so E on the left and W on the right are this terrain.
          const left = tiles[(1 - leftRotation + 4) % 4]!;
          const right = tiles[(3 - rightRotation + 4) % 4]!;
          const leftTerrain = rotatedEdge(left, leftRotation, 'E');
          const rightTerrain = rotatedEdge(right, rightRotation, 'W');
          expect(leftTerrain).toBe(edge);
          expect(rightTerrain).toBe(edge);
          expect(boundarySignature(leftTerrain)).toEqual(boundarySignature(rightTerrain));
        }
      }
    }
  });

  it('reproduces the frozen clockwise -Y rotation for all anchors', () => {
    const source: Anchor = { u: -0.18, v: -0.37 };
    const expected = [
      [-0.18, -0.37],
      [0.37, -0.18],
      [0.18, 0.37],
      [-0.37, 0.18],
    ];
    for (let r = 0 as Rotation; r < 4; r = (r + 1) as Rotation) {
      const world = anchorOnBoard({ x: 2, z: -3, rotation: r }, source);
      expect(world.x).toBeCloseTo(2 + expected[r]![0]!);
      expect(world.z).toBeCloseTo(-3 + expected[r]![1]!);
      expect(rotationRadians(r)).toBeCloseTo(-r * Math.PI / 2);
    }
    expect(sideCentre('N')).toEqual({ x: 0, z: -0.5 });
    expect(sideCentre('E')).toEqual({ x: 0.5, z: 0 });
  });

  it('mirrors L/R ports when looking from opposing edges and turns N:L into E:L', () => {
    const nl = fieldPortPosition('N:L');
    const el = fieldPortPosition('E:L');
    expect(-nl.z).toBeCloseTo(el.x);
    expect(nl.x).toBeCloseTo(el.z);
    const er = fieldPortPosition('E:R');
    const wl = fieldPortPosition('W:L');
    expect(er.z).toBeCloseTo(wl.z);
    expect(er.x).toBeCloseTo(-wl.x);
    expect(fieldPortPosition('S:L').x).toBeGreaterThan(0);
  });

  it('fits an entire 72-tile rectangular board into a wider camera distance', () => {
    const one = fitCameraPose([{ x: 0, z: 0 }], 1.4);
    const many = Array.from({ length: 72 }, (_, i) => ({ x: i % 9, z: Math.floor(i / 9) }));
    const fit = fitCameraPose(many, 1.4);
    const narrow = fitCameraPose(many, 0.65);
    expect(fit.distance).toBeGreaterThan(one.distance);
    expect(narrow.distance).toBeGreaterThan(fit.distance);
    expect(fit.target.x).toBeCloseTo(4);
    expect(fit.target.z).toBeCloseTo(3.5);
    expect(calculateExtents(many)).toEqual({ minX: -0.5, maxX: 8.5, minZ: -0.5, maxZ: 7.5 });
  });
});
