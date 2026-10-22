import { describe, expect, it } from 'vitest';
import { BASE72 } from '../game/catalog/base72';
import type { Anchor, Side, TileDef } from '../game';
import { sideCentre } from './tileArtwork';

const TILE_EXPECTATIONS = [
  { id: 'D', fieldIndex: 1, anchor: { u: 0.22, v: -0.22 }, ports: ['N:R', 'S:L'], copies: 4 },
  { id: 'L', fieldIndex: 1, anchor: { u: 0.22, v: -0.22 }, ports: ['N:R', 'S:L'], copies: 3 },
  { id: 'O', fieldIndex: 0, anchor: { u: 0.22, v: -0.10 }, ports: ['E:L', 'S:R'], copies: 2 },
  { id: 'P', fieldIndex: 0, anchor: { u: 0.22, v: -0.10 }, ports: ['E:L', 'S:R'], copies: 3 },
] as const;

type Point = { x: number; z: number };
const point = (anchor: Anchor): Point => ({ x: anchor.u, z: anchor.v });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);

function roadCurvePoint(center: Point, side: Side, t: number): Point {
  const edge = sideCentre(side);
  const inner = { x: edge.x * 0.76, z: edge.z * 0.76 };
  const control = {
    x: inner.x * 0.51 + center.x * 0.49,
    z: inner.z * 0.51 + center.z * 0.49,
  };
  const s = 1 - t;
  return {
    x: s * s * inner.x + 2 * s * t * control.x + t * t * center.x,
    z: s * s * inner.z + 2 * s * t * control.z + t * t * center.z,
  };
}

function distanceToPaintedRoad(def: TileDef, anchor: Anchor): number {
  const roads = def.regions.filter((region) => region.kind === 'road');
  let minimum = Infinity;
  for (const road of roads) {
    const center = point(road.anchor);
    // The widest painted road stroke is 0.174; sample the actual quadratic
    // centerline used by roadPath, plus its round endpoint cap.
    minimum = Math.min(minimum, distance(point(anchor), center) - 0.174 / 2);
    for (const side of road.sides) {
      for (let step = 0; step <= 500; step++) {
        minimum = Math.min(minimum, distance(point(anchor), roadCurvePoint(center, side, step / 500)) - 0.174 / 2);
      }
    }
  }
  return minimum;
}

describe('corrected D/L/O/P farm anchors', () => {
  it.each(TILE_EXPECTATIONS)('$id field anchor is in clear pasture', ({ id, fieldIndex, anchor, ports, copies }) => {
    const tile = BASE72.find((candidate) => candidate.id === id)!;
    const field = tile.regions.filter((region) => region.kind === 'field')[fieldIndex]!;
    const city = tile.regions.find((region) => region.kind === 'city')!;

    expect(tile.copies).toBe(copies);
    expect(field.ports).toEqual(ports);
    expect(field.touchingCities).toEqual(['city-1']);
    expect(field.anchor).toEqual(anchor);
    if (id === 'D' || id === 'L') {
      expect(field.anchor.u).toBeGreaterThan(0);
      expect(field.anchor.v).toBeLessThan(0);
    } else {
      // cf is the city-adjacent field at E:L, on the negative-v side of ES.
      expect(field.anchor.v).toBeLessThan(0);
      expect(field.anchor.u).toBeGreaterThan(0);
    }

    // cityPath paints a filled circle of radius 0.20 around the city anchor.
    expect(distance(point(field.anchor), point(city.anchor))).toBeGreaterThan(0.20);
    // paintRoads uses round strokes with maximum width 0.174.
    expect(distanceToPaintedRoad(tile, field.anchor)).toBeGreaterThan(0);

    const formerAnchor = id === 'D' || id === 'L' ? { u: 0.32, v: 0 } : { u: 0.07, v: 0.07 };
    if (id === 'D' || id === 'L') {
      expect(distance(point(formerAnchor), point(city.anchor))).toBeLessThan(0.20);
    } else {
      expect(distanceToPaintedRoad(tile, formerAnchor)).toBeLessThan(0);
      // The rejected (.30,.30) candidate lies on the opposite side of ES.
      expect(formerAnchor.v).toBeGreaterThan(0);
      expect(field.anchor.v).toBeLessThan(0);
    }
  });
});
