import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { RESEARCH_CATALOGUE } from '../research-data.mjs';
import {
  CONTROL_DEPTH,
  HOLE_SAMPLE_B,
  ROAD_END,
  ROAD_START,
  TILE_SIZE,
  VECTOR_TILE_IDS,
  VECTOR_TILES,
  compareNeighbourPair,
  getControlStripSignature,
  getEdgeProfile,
  getRegion,
  rotateTile,
  rotateVector,
} from '../vector-sample.mjs';

const EPS = 1e-9;
const sides = ['N', 'E', 'S', 'W'];
const cornerPoints = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];

function signedArea(points) {
  return points.reduce((sum, [x1, y1], index) => {
    const [x2, y2] = points[(index + 1) % points.length];
    return sum + x1 * y2 - x2 * y1;
  }, 0) / 2;
}

function polygonArea(points) {
  return Math.abs(signedArea(points));
}

function regionArea(tile, region) {
  return polygonArea(region.outer) - region.holes.reduce((sum, holeId) => sum + polygonArea(getRegion(tile, holeId).outer), 0);
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointOnSegment(point, a, b) {
  if (Math.abs(cross(a, b, point)) > EPS) return false;
  return point[0] >= Math.min(a[0], b[0]) - EPS && point[0] <= Math.max(a[0], b[0]) + EPS
    && point[1] >= Math.min(a[1], b[1]) - EPS && point[1] <= Math.max(a[1], b[1]) + EPS;
}

function polygonEdges(points) {
  return points.map((point, index) => [point, points[(index + 1) % points.length]]);
}

function pointInPolygon(point, polygon, includeBoundary = true) {
  if (polygonEdges(polygon).some(([a, b]) => pointOnSegment(point, a, b))) return includeBoundary;
  let inside = false;
  const [x, y] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses = (yi > y) !== (yj > y);
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInRegion(tile, region, point, strict = false) {
  if (!pointInPolygon(point, region.outer, !strict)) return false;
  for (const holeId of region.holes) {
    const hole = getRegion(tile, holeId);
    if (pointInPolygon(point, hole.outer, true)) return false;
  }
  return true;
}

function orientation(a, b, c) {
  const value = cross(a, b, c);
  if (Math.abs(value) <= EPS) return 0;
  return value > 0 ? 1 : -1;
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && pointOnSegment(c, a, b)) return true;
  if (o2 === 0 && pointOnSegment(d, a, b)) return true;
  if (o3 === 0 && pointOnSegment(a, c, d)) return true;
  if (o4 === 0 && pointOnSegment(b, c, d)) return true;
  return false;
}

function properIntersection(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function isSimplePolygon(points) {
  const edges = polygonEdges(points);
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      if (j === i + 1 || (i === 0 && j === edges.length - 1)) continue;
      if (segmentsIntersect(...edges[i], ...edges[j])) return false;
    }
  }
  return true;
}

function scanIntervals(polygon, x) {
  const ys = [];
  for (const [[x1, y1], [x2, y2]] of polygonEdges(polygon)) {
    if ((x1 < x && x < x2) || (x2 < x && x < x1)) {
      ys.push(y1 + ((x - x1) * (y2 - y1)) / (x2 - x1));
    }
  }
  ys.sort((a, b) => a - b);
  assert.equal(ys.length % 2, 0, `odd scanline intersection count at x=${x}`);
  const intervals = [];
  for (let index = 0; index < ys.length; index += 2) intervals.push([ys[index], ys[index + 1]]);
  return intervals;
}

function subtractIntervals(base, cuts) {
  let result = [...base];
  for (const [cutStart, cutEnd] of cuts) {
    const next = [];
    for (const [start, end] of result) {
      if (cutEnd <= start + EPS || cutStart >= end - EPS) {
        next.push([start, end]);
        continue;
      }
      if (cutStart > start + EPS) next.push([start, Math.min(cutStart, end)]);
      if (cutEnd < end - EPS) next.push([Math.max(cutEnd, start), end]);
    }
    result = next;
  }
  return result;
}

function regionScanIntervals(tile, region, x) {
  let intervals = scanIntervals(region.outer, x);
  for (const holeId of region.holes) intervals = subtractIntervals(intervals, scanIntervals(getRegion(tile, holeId).outer, x));
  return intervals;
}

function assertContinuousSurface(tile) {
  const xs = new Set([0, TILE_SIZE]);
  for (const region of tile.regions) for (const [x] of region.outer) xs.add(x);
  const sorted = [...xs].sort((a, b) => a - b);

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const left = sorted[index];
    const right = sorted[index + 1];
    if (right - left <= EPS) continue;
    const x = (left + right) / 2;
    const strips = [];
    for (const region of tile.regions) {
      for (const [start, end] of regionScanIntervals(tile, region, x)) strips.push({ start, end, region: region.id });
    }
    strips.sort((a, b) => a.start - b.start || a.end - b.end);
    let cursor = 0;
    for (const strip of strips) {
      assert.ok(Math.abs(strip.start - cursor) <= EPS, `${tile.id}: gap/overlap near x=${x}, y=${cursor}; next=${strip.start} (${strip.region})`);
      assert.ok(strip.end > strip.start + EPS, `${tile.id}: zero-area scan interval`);
      cursor = strip.end;
    }
    assert.ok(Math.abs(cursor - TILE_SIZE) <= EPS, `${tile.id}: uncovered scanline near x=${x}`);
  }
}

function assertNoBoundaryCrossings(tile) {
  const regions = tile.regions;
  for (let i = 0; i < regions.length; i += 1) {
    const aEdges = polygonEdges(regions[i].outer);
    for (let j = i + 1; j < regions.length; j += 1) {
      for (const [a, b] of aEdges) {
        for (const [c, d] of polygonEdges(regions[j].outer)) {
          assert.equal(properIntersection(a, b, c, d), false, `${tile.id}: ${regions[i].id}/${regions[j].id} boundaries cross`);
        }
      }
    }
  }
}

function intervalCoversSide(profile) {
  let cursor = 0;
  for (const interval of profile) {
    if (Math.abs(interval.start - cursor) > EPS || interval.end <= interval.start) return false;
    cursor = interval.end;
  }
  return Math.abs(cursor - TILE_SIZE) <= EPS;
}

function segmentOverlapLength(a, b, c, d) {
  const ab = [b[0] - a[0], b[1] - a[1]];
  const cd = [d[0] - c[0], d[1] - c[1]];
  if (Math.abs(ab[0] * cd[1] - ab[1] * cd[0]) > EPS) return 0;
  if (Math.abs(cross(a, b, c)) > EPS) return 0;
  const useX = Math.abs(ab[0]) >= Math.abs(ab[1]);
  const a0 = useX ? a[0] : a[1];
  const a1 = useX ? b[0] : b[1];
  const c0 = useX ? c[0] : c[1];
  const c1 = useX ? d[0] : d[1];
  const overlap = Math.max(0, Math.min(Math.max(a0, a1), Math.max(c0, c1)) - Math.max(Math.min(a0, a1), Math.min(c0, c1)));
  const axisLength = Math.abs(a1 - a0);
  if (axisLength <= EPS || overlap <= EPS) return 0;
  return overlap * (Math.hypot(ab[0], ab[1]) / axisLength);
}

function sharedBoundaryLength(aPolygon, bPolygon) {
  let length = 0;
  for (const [a, b] of polygonEdges(aPolygon)) {
    for (const [c, d] of polygonEdges(bPolygon)) length += segmentOverlapLength(a, b, c, d);
  }
  return length;
}

function polylineLength(path) {
  let length = 0;
  for (let i = 0; i < path.length - 1; i += 1) length += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  return length;
}

function boundaryOverlapWithPath(path, polygon) {
  let length = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    for (const [c, d] of polygonEdges(polygon)) length += segmentOverlapLength(path[i], path[i + 1], c, d);
  }
  return length;
}

function polygonStrictlyContained(inner, outer) {
  for (const point of inner) if (!pointInPolygon(point, outer, false)) return false;
  for (let index = 0; index < inner.length; index += 1) {
    const a = inner[index];
    const b = inner[(index + 1) % inner.length];
    const midpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!pointInPolygon(midpoint, outer, false)) return false;
    for (const [c, d] of polygonEdges(outer)) if (properIntersection(a, b, c, d)) return false;
  }
  return true;
}

function polygonContainedInRegion(tile, polygon, owner) {
  for (const point of polygon) if (!pointInRegion(tile, owner, point, true)) return false;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const midpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!pointInRegion(tile, owner, midpoint, true)) return false;
    for (const [c, d] of polygonEdges(owner.outer)) if (properIntersection(a, b, c, d)) return false;
    for (const holeId of owner.holes) {
      for (const [c, d] of polygonEdges(getRegion(tile, holeId).outer)) if (properIntersection(a, b, c, d)) return false;
    }
  }
  return true;
}

function polygonsOverlapPositive(a, b) {
  for (const [a1, a2] of polygonEdges(a)) for (const [b1, b2] of polygonEdges(b)) if (properIntersection(a1, a2, b1, b2)) return true;
  if (a.some((point) => pointInPolygon(point, b, false))) return true;
  if (b.some((point) => pointInPolygon(point, a, false))) return true;
  return false;
}

function researchById(id) {
  return RESEARCH_CATALOGUE.find((tile) => tile.id === id);
}

function mainEdgeKind(profile) {
  if (profile.some((interval) => interval.kind === 'road')) return 'R';
  if (profile.some((interval) => interval.kind === 'city')) return 'C';
  return 'F';
}

function semanticSnapshot(tile) {
  return {
    regions: tile.regions,
    relationships: tile.relationships,
    profiles: Object.fromEntries(sides.map((side) => [side, getEdgeProfile(tile, side)])),
  };
}

test('six exact vector samples partition the whole square without crossings, gaps or area overlaps', () => {
  for (const id of VECTOR_TILE_IDS) {
    const tile = VECTOR_TILES[id];
    assert.equal(tile.regions.length > 0, true, id);
    for (const region of tile.regions) {
      assert.ok(region.outer.length >= 3, `${id}/${region.id}: outer contour`);
      assert.equal(isSimplePolygon(region.outer), true, `${id}/${region.id}: self intersection`);
      assert.ok(region.outer.every(([x, y]) => x >= 0 && x <= TILE_SIZE && y >= 0 && y <= TILE_SIZE), `${id}/${region.id}: outside tile`);
      assert.equal(new Set(region.holes).size, region.holes.length, `${id}/${region.id}: duplicate holes`);
    }
    assertNoBoundaryCrossings(tile);
    assertContinuousSurface(tile);
    assert.equal(tile.regions.reduce((sum, region) => sum + regionArea(tile, region), 0), TILE_SIZE * TILE_SIZE, `${id}: area cross-check`);
    for (const corner of cornerPoints) assert.ok(tile.regions.some((region) => pointInRegion(tile, region, corner, false)), `${id}: uncovered corner ${corner}`);
    for (const side of sides) assert.equal(intervalCoversSide(getEdgeProfile(tile, side)), true, `${id}.${side}: open edge not fully covered`);
  }
});

test('inner-hole representation proves one connected field around an internal monastery without duplicated hole coordinates', () => {
  const tile = HOLE_SAMPLE_B;
  const field = getRegion(tile, 'F1');
  const monastery = getRegion(tile, 'M1');
  assert.deepEqual(field.holes, ['M1']);
  assert.equal(Object.hasOwn(field, 'holeContours'), false);
  assert.equal(polygonStrictlyContained(monastery.outer, field.outer), true);
  assert.equal(regionArea(tile, field), 1_000_000 - 102_400);
  assert.equal(regionArea(tile, monastery), 102_400);
  assertContinuousSurface(tile);
  const xs = monastery.outer.map(([x]) => x);
  const ys = monastery.outer.map(([, y]) => y);
  assert.ok(Math.min(...xs) > 0 && Math.max(...xs) < TILE_SIZE && Math.min(...ys) > 0 && Math.max(...ys) < TILE_SIZE, 'positive field corridor exists on every side of the hole');
  let rotated = tile;
  for (let i = 0; i < 4; i += 1) rotated = rotateTile(rotated, 1);
  assert.deepEqual(rotated, tile);
});

test('local contacts, endings and shield ownership match the approved semantics with non-zero boundary length', () => {
  const d = VECTOR_TILES.D;
  assert.ok(sharedBoundaryLength(getRegion(d, 'F2').outer, getRegion(d, 'C1').outer) > 0);
  assert.equal(sharedBoundaryLength(getRegion(d, 'F1').outer, getRegion(d, 'C1').outer), 0);

  const f = VECTOR_TILES.F;
  assert.ok(sharedBoundaryLength(getRegion(f, 'F1').outer, getRegion(f, 'C1').outer) > 0);
  assert.ok(sharedBoundaryLength(getRegion(f, 'F2').outer, getRegion(f, 'C1').outer) > 0);
  assert.deepEqual(f.relationships.shields, [{ shield: 'F_SHIELD', city: 'C1' }]);
  const shield = f.layout.objects.find((object) => object.id === 'F_SHIELD');
  assert.equal(polygonContainedInRegion(f, shield.footprint, getRegion(f, 'C1')), true);

  const h = VECTOR_TILES.H;
  assert.ok(sharedBoundaryLength(getRegion(h, 'F1').outer, getRegion(h, 'C1').outer) > 0);
  assert.ok(sharedBoundaryLength(getRegion(h, 'F1').outer, getRegion(h, 'C2').outer) > 0);
  assert.equal(sharedBoundaryLength(getRegion(h, 'C1').outer, getRegion(h, 'C2').outer), 0);

  const w = VECTOR_TILES.W;
  assert.deepEqual(w.relationships.endsAt, [
    { road: 'R1', target: 'V' }, { road: 'R2', target: 'V' }, { road: 'R3', target: 'V' },
  ]);
  for (const relation of w.relationships.endsAt) assert.ok(sharedBoundaryLength(getRegion(w, relation.road).outer, getRegion(w, relation.target).outer) > 0, relation.road);
  assert.equal(sharedBoundaryLength(getRegion(w, 'R1').outer, getRegion(w, 'R2').outer), 0, 'roads touching only at a corner are not connected');

  const a = VECTOR_TILES.A;
  assert.deepEqual(a.relationships.endsAt, [{ road: 'R1', target: 'M1' }]);
  assert.ok(sharedBoundaryLength(getRegion(a, 'R1').outer, getRegion(a, 'M1').outer) > 0);
});

test('exact edge profiles come from contours and agree with research-side kinds for the six samples', () => {
  for (const id of VECTOR_TILE_IDS) {
    const tile = VECTOR_TILES[id];
    const research = researchById(id);
    for (const [index, side] of sides.entries()) {
      const profile = getEdgeProfile(tile, side);
      assert.equal(mainEdgeKind(profile), research.nesw[index], `${id}.${side}`);
      const road = profile.find((interval) => interval.kind === 'road');
      if (road) {
        assert.deepEqual(profile.map(({ start, end, kind }) => ({ start, end, kind })), [
          { start: 0, end: ROAD_START, kind: 'field' },
          { start: ROAD_START, end: ROAD_END, kind: 'road' },
          { start: ROAD_END, end: TILE_SIZE, kind: 'field' },
        ], `${id}.${side}: road profile`);
      }
      const strip = getControlStripSignature(tile, side);
      assert.equal(strip.stable, true, `${id}.${side}: control strip changes within ${CONTROL_DEPTH}`);
    }
  }
  assert.ok(VECTOR_TILES.D.regions.filter((region) => pointOnSegment([1000, 0], region.outer[0], region.outer.at(-1)) || region.outer.some((point) => point[0] === 1000 && point[1] === 0)).length >= 1);
  assert.deepEqual(getEdgeProfile(VECTOR_TILES.D, 'N').at(-1), { start: 590, end: 1000, kind: 'field', regionId: 'F2' });
  assert.deepEqual(getEdgeProfile(VECTOR_TILES.D, 'E'), [{ start: 0, end: 1000, kind: 'city', regionId: 'C1' }]);
});

test('neighbour seams use rotated world geometry, normalized 80-unit strips and explicit positive-length region connections', () => {
  const road = compareNeighbourPair({ aId: 'D', bId: 'U', side: 'S' });
  assert.equal(road.seamAxis, 'worldX');
  assert.equal(road.match, true);
  assert.deepEqual(road.connections, [
    { start: 0, end: 410, kind: 'field', aRegion: 'F1', bRegion: 'F1' },
    { start: 410, end: 590, kind: 'road', aRegion: 'R1', bRegion: 'R1' },
    { start: 590, end: 1000, kind: 'field', aRegion: 'F2', bRegion: 'F2' },
  ]);
  assert.ok(road.connections.every((row) => row.end > row.start));

  const city = compareNeighbourPair({ aId: 'F', bId: 'H', side: 'E' });
  assert.equal(city.seamAxis, 'worldY');
  assert.equal(city.match, true);
  assert.deepEqual(city.connections, [{ start: 0, end: 1000, kind: 'city', aRegion: 'C1', bRegion: 'C2' }]);

  const field = compareNeighbourPair({ aId: 'A', aRotation: 2, bId: 'H', side: 'S' });
  assert.equal(field.match, true);
  assert.deepEqual(field.connections, [{ start: 0, end: 1000, kind: 'field', aRegion: 'F1', bRegion: 'F1' }]);

  const wrong = compareNeighbourPair({ aId: 'D', bId: 'U', side: 'E' });
  assert.equal(wrong.edgeMatch, false);
  assert.equal(wrong.stripMatch, false);
  assert.equal(wrong.match, false);
  assert.deepEqual(wrong.connections, []);

  const reversedWorldOrder = compareNeighbourPair({ aId: 'D', aRotation: 2, bId: 'U', bRotation: 0, side: 'S' });
  assert.equal(reversedWorldOrder.match, true);
  assert.deepEqual(reversedWorldOrder.connections.map(({ aRegion, bRegion }) => [aRegion, bRegion]), [['F2', 'F1'], ['R1', 'R1'], ['F1', 'F2']]);
  assert.equal(reversedWorldOrder.controlA.stable && reversedWorldOrder.controlB.stable, true);
});

test('four mathematical rotations preserve IDs, relations, holes and handedness while rotating geometry, placements and directions', () => {
  for (const source of [...VECTOR_TILE_IDS.map((id) => VECTOR_TILES[id]), HOLE_SAMPLE_B]) {
    const sourceBefore = JSON.stringify(source);
    const areaSigns = source.regions.map((region) => Math.sign(signedArea(region.outer)));
    const once = rotateTile(source, 1);
    assert.deepEqual(once.regions.map((region) => region.id), source.regions.map((region) => region.id));
    assert.deepEqual(once.regions.map((region) => region.holes), source.regions.map((region) => region.holes));
    assert.deepEqual(once.relationships, source.relationships);
    assert.deepEqual(once.regions.map((region) => Math.sign(signedArea(region.outer))), areaSigns, `${source.id}: reflection detected`);
    let rotated = source;
    for (let count = 0; count < 4; count += 1) rotated = rotateTile(rotated, 1);
    assert.deepEqual(rotated, source, `${source.id}: T^4`);
    assert.equal(JSON.stringify(source), sourceBefore, `${source.id}: source mutated`);
  }
  assert.deepEqual(rotateVector([0, -1], 1), [1, 0]);
  assert.deepEqual(rotateTile(VECTOR_TILES.F, 1).layout.objects.find((object) => object.id === 'F_BUILDING').direction, [1, 0]);
});

test('manual decoration footprints and future meeple zones are wholly contained and do not alter semantics', () => {
  for (const id of VECTOR_TILE_IDS) {
    const tile = VECTOR_TILES[id];
    const before = semanticSnapshot(tile);
    const zones = new Map(tile.layout.allowedZones.map((zone) => [zone.id, zone]));
    for (const zone of tile.layout.allowedZones) {
      const owner = getRegion(tile, zone.owner);
      assert.ok(owner, `${id}/${zone.id}: missing owner`);
      assert.equal(polygonContainedInRegion(tile, zone.outer, owner), true, `${id}/${zone.id}: allowed zone outside owner`);
    }
    for (const object of tile.layout.objects) {
      const owner = getRegion(tile, object.owner);
      const zone = zones.get(object.allowedZone);
      assert.ok(owner && zone, `${id}/${object.id}: owner/zone`);
      assert.equal(polygonStrictlyContained(object.footprint, zone.outer), true, `${id}/${object.id}: footprint outside allowed zone`);
      assert.equal(polygonContainedInRegion(tile, object.footprint, owner), true, `${id}/${object.id}: footprint outside owner`);
      if (object.type === 'tree') {
        for (const [x, y] of object.footprint) assert.ok(Math.min(x, y, TILE_SIZE - x, TILE_SIZE - y) >= CONTROL_DEPTH, `${id}/${object.id}: tree enters control strip`);
      }
    }
    for (const zone of tile.meepleZones) {
      const owner = getRegion(tile, zone.owner);
      assert.ok(owner, `${id}/${zone.id}: missing meeple owner`);
      assert.equal(polygonContainedInRegion(tile, zone.outer, owner), true, `${id}/${zone.id}: meeple zone outside owner`);
    }
    assert.equal(tile.meepleZones.some((zone) => zone.owner === 'V'), false, `${id}: V must not be a meeple target`);
    for (const wall of tile.layout.walls) {
      assert.ok(wall.path.every(([x, y]) => Math.min(x, y, TILE_SIZE - x, TILE_SIZE - y) >= wall.safeInset), `${id}/${wall.id}: wall enters protected edge strip`);
      const city = getRegion(tile, wall.city);
      assert.ok(Math.abs(boundaryOverlapWithPath(wall.path, city.outer) - polylineLength(wall.path)) <= EPS, `${id}/${wall.id}: wall leaves city boundary`);
      let fieldOverlap = 0;
      for (const fieldId of wall.fields) fieldOverlap += boundaryOverlapWithPath(wall.path, getRegion(tile, fieldId).outer);
      assert.ok(Math.abs(fieldOverlap - polylineLength(wall.path)) <= EPS, `${id}/${wall.id}: wall is not on city-field boundary`);
    }
    const withoutLayout = { ...tile, layout: { walls: [], allowedZones: [], objects: [] }, meepleZones: [] };
    assert.deepEqual(semanticSnapshot(withoutLayout), before, `${id}: layout changed mathematical semantics`);
  }

  const f = VECTOR_TILES.F;
  const building = f.layout.objects.find((object) => object.id === 'F_BUILDING');
  const shield = f.layout.objects.find((object) => object.id === 'F_SHIELD');
  assert.deepEqual(building.center, [430, 410]);
  assert.deepEqual(building.footprint, [[370, 350], [490, 350], [490, 470], [370, 470]]);
  assert.deepEqual(shield.center, [610, 570]);
  assert.equal(polygonsOverlapPositive(building.footprint, shield.footprint), false);
  const monasteryBuilding = VECTOR_TILES.A.layout.objects.find((object) => object.id === 'A_MONASTERY_BUILDING');
  assert.equal(monasteryBuilding.owner, 'M1');
});

test('exact six-type semantics remain a cross-check of the accepted 24/72 research catalogue, not a replacement for it', () => {
  assert.equal(RESEARCH_CATALOGUE.length, 24);
  assert.equal(VECTOR_TILE_IDS.length, 6);
  for (const id of VECTOR_TILE_IDS) {
    const research = researchById(id);
    const exact = VECTOR_TILES[id];
    assert.deepEqual(exact.regions.filter((region) => region.kind === 'city').map((region) => region.id).sort(), research.cities.map((region) => region.id).sort(), `${id}: cities`);
    assert.deepEqual(exact.regions.filter((region) => region.kind === 'road').map((region) => region.id).sort(), research.roads.map((region) => region.id).sort(), `${id}: roads`);
    assert.deepEqual(exact.regions.filter((region) => region.kind === 'field').map((region) => region.id).sort(), research.fields.map((region) => region.id).sort(), `${id}: fields`);
    assert.deepEqual(exact.relationships.endsAt.map(({ road, target }) => [road, target]).sort(), research.roads.filter((road) => road.endsAt).map((road) => [road.id, road.endsAt]).sort(), `${id}: road endings`);
    assert.deepEqual(exact.relationships.fieldCityContacts.map(({ field, city }) => [field, city]).sort(), research.fields.flatMap((field) => field.touches.map((city) => [field.id, city])).sort(), `${id}: field-city contacts`);
  }
  assert.equal(VECTOR_TILES.F.relationships.shields[0].city, 'C1');
  assert.equal(researchById('F').shields[0], 'C1');
});


test('browser section exposes exactly six samples, three views, four mathematical rotations and four computed seam examples after the accepted four lessons', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

  assert.ok(html.indexOf('id="step-4"') < html.indexOf('id="vector-sample"'));
  assert.ok(html.indexOf('id="vector-sample"') < html.indexOf('class="details-zone"'));
  assert.equal((html.match(/data-vector-tile=/g) || []).length, 6);
  assert.equal((html.match(/data-vector-mode=/g) || []).length, 3);
  assert.equal((html.match(/data-vector-rotation=/g) || []).length, 4);
  assert.equal((html.match(/data-vector-pair=/g) || []).length, 4);
  assert.match(html, /Устройство/);
  assert.match(html, /Точные контуры/);
  assert.match(html, /Места оформления/);
  assert.match(html, /Математический подход проверен на шести репрезентативных типах/);
  assert.match(html, /классический базовый набор: 24 типа, 72 плитки, включая одну стартовую/);
  assert.doesNotMatch(html, /data-vector-tile="B"/);
  assert.match(app, /compareNeighbourPair\(scenario\)/);
  assert.match(app, /rotateTile\(source, state\.vectorRotation\)/);
  assert.doesNotMatch(css, /transform\s*:\s*rotate\s*\(/i);
});
