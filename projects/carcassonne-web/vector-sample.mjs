export const TILE_SIZE = 1000;
export const ROAD_START = 410;
export const ROAD_END = 590;
export const CONTROL_DEPTH = 80;

const P = (...points) => points;
const rect = (x1, y1, x2, y2) => P([x1, y1], [x2, y1], [x2, y2], [x1, y2]);

const kindLabel = Object.freeze({
  city: 'город',
  road: 'дорога',
  field: 'поле',
  monastery: 'монастырь',
  junction: 'место окончания дорог',
});

const D = {
  id: 'D',
  title: 'Город, прямая дорога и два поля',
  summary: 'Справа расположен город, дорога проходит с севера на юг, а два поля остаются раздельными.',
  regions: [
    { id: 'R1', kind: 'road', outer: rect(410, 0, 590, 1000), holes: [] },
    { id: 'C1', kind: 'city', outer: P([1000, 0], [1000, 1000], [920, 920], [720, 700], [720, 300], [920, 80]), holes: [] },
    { id: 'F1', kind: 'field', outer: rect(0, 0, 410, 1000), holes: [] },
    { id: 'F2', kind: 'field', outer: P([590, 0], [1000, 0], [920, 80], [720, 300], [720, 700], [920, 920], [1000, 1000], [590, 1000]), holes: [] },
  ],
  relationships: {
    endsAt: [],
    fieldCityContacts: [{ field: 'F2', city: 'C1' }],
    shields: [],
  },
  layout: {
    walls: [
      { id: 'D_WALL', city: 'C1', fields: ['F2'], path: P([920, 80], [720, 300], [720, 700], [920, 920]), safeInset: 80 },
    ],
    allowedZones: [
      { id: 'D_TREE_1_ZONE', owner: 'F1', outer: rect(140, 180, 220, 260) },
      { id: 'D_TREE_2_ZONE', owner: 'F1', outer: rect(180, 720, 260, 800) },
    ],
    objects: [
      { id: 'D_TREE_1', type: 'tree', owner: 'F1', center: [180, 220], direction: null, footprint: rect(160, 200, 200, 240), allowedZone: 'D_TREE_1_ZONE' },
      { id: 'D_TREE_2', type: 'tree', owner: 'F1', center: [220, 760], direction: null, footprint: rect(200, 740, 240, 780), allowedZone: 'D_TREE_2_ZONE' },
    ],
  },
  meepleZones: [
    { id: 'D_M_C1', owner: 'C1', outer: rect(780, 400, 900, 600) },
    { id: 'D_M_R1', owner: 'R1', outer: rect(445, 680, 555, 840) },
    { id: 'D_M_F1', owner: 'F1', outer: rect(120, 400, 300, 600) },
    { id: 'D_M_F2', owner: 'F2', outer: rect(610, 400, 690, 600) },
  ],
};

const U = {
  id: 'U',
  title: 'Одна прямая дорога',
  summary: 'Одна дорога соединяет север и юг, а слева и справа находятся два независимых поля.',
  regions: [
    { id: 'R1', kind: 'road', outer: rect(410, 0, 590, 1000), holes: [] },
    { id: 'F1', kind: 'field', outer: rect(0, 0, 410, 1000), holes: [] },
    { id: 'F2', kind: 'field', outer: rect(590, 0, 1000, 1000), holes: [] },
  ],
  relationships: { endsAt: [], fieldCityContacts: [], shields: [] },
  layout: { walls: [], allowedZones: [], objects: [] },
  meepleZones: [
    { id: 'U_M_R1', owner: 'R1', outer: rect(445, 400, 555, 600) },
    { id: 'U_M_F1', owner: 'F1', outer: rect(120, 400, 300, 600) },
    { id: 'U_M_F2', owner: 'F2', outer: rect(700, 400, 880, 600) },
  ],
};

const W = {
  id: 'W',
  title: 'Три дороги к одному месту',
  summary: 'Три самостоятельные дороги заканчиваются у центрального места V и не превращаются в одну дорогу.',
  regions: [
    { id: 'V', kind: 'junction', outer: rect(410, 410, 590, 590), holes: [] },
    { id: 'R1', kind: 'road', outer: rect(590, 410, 1000, 590), holes: [] },
    { id: 'R2', kind: 'road', outer: rect(410, 590, 590, 1000), holes: [] },
    { id: 'R3', kind: 'road', outer: rect(0, 410, 410, 590), holes: [] },
    { id: 'F1', kind: 'field', outer: rect(0, 0, 1000, 410), holes: [] },
    { id: 'F2', kind: 'field', outer: rect(590, 590, 1000, 1000), holes: [] },
    { id: 'F3', kind: 'field', outer: rect(0, 590, 410, 1000), holes: [] },
  ],
  relationships: {
    endsAt: [{ road: 'R1', target: 'V' }, { road: 'R2', target: 'V' }, { road: 'R3', target: 'V' }],
    fieldCityContacts: [],
    shields: [],
  },
  layout: {
    walls: [],
    allowedZones: [
      { id: 'W_TREE_ZONE', owner: 'F1', outer: rect(690, 150, 790, 250) },
    ],
    objects: [
      { id: 'W_TREE', type: 'tree', owner: 'F1', center: [740, 200], direction: null, footprint: rect(720, 180, 760, 220), allowedZone: 'W_TREE_ZONE' },
    ],
  },
  meepleZones: [
    { id: 'W_M_R1', owner: 'R1', outer: rect(700, 445, 860, 555) },
    { id: 'W_M_R2', owner: 'R2', outer: rect(445, 700, 555, 860) },
    { id: 'W_M_R3', owner: 'R3', outer: rect(140, 445, 300, 555) },
    { id: 'W_M_F1', owner: 'F1', outer: rect(420, 120, 580, 280) },
    { id: 'W_M_F2', owner: 'F2', outer: rect(700, 700, 860, 860) },
    { id: 'W_M_F3', owner: 'F3', outer: rect(140, 700, 300, 860) },
  ],
};

const F = {
  id: 'F',
  title: 'Один город на двух противоположных краях',
  summary: 'Западный и восточный выходы принадлежат одному C1; щит относится именно к этому городу.',
  regions: [
    { id: 'C1', kind: 'city', outer: P([0, 0], [80, 80], [300, 300], [700, 300], [920, 80], [1000, 0], [1000, 1000], [920, 920], [700, 700], [300, 700], [80, 920], [0, 1000]), holes: [] },
    { id: 'F1', kind: 'field', outer: P([0, 0], [1000, 0], [920, 80], [700, 300], [300, 300], [80, 80]), holes: [] },
    { id: 'F2', kind: 'field', outer: P([0, 1000], [80, 920], [300, 700], [700, 700], [920, 920], [1000, 1000]), holes: [] },
  ],
  relationships: {
    endsAt: [],
    fieldCityContacts: [{ field: 'F1', city: 'C1' }, { field: 'F2', city: 'C1' }],
    shields: [{ shield: 'F_SHIELD', city: 'C1' }],
  },
  layout: {
    walls: [
      { id: 'F_WALL_N', city: 'C1', fields: ['F1'], path: P([80, 80], [300, 300], [700, 300], [920, 80]), safeInset: 80 },
      { id: 'F_WALL_S', city: 'C1', fields: ['F2'], path: P([80, 920], [300, 700], [700, 700], [920, 920]), safeInset: 80 },
    ],
    allowedZones: [
      { id: 'F_BUILD_ZONE', owner: 'C1', outer: rect(350, 330, 520, 500) },
      { id: 'F_SHIELD_ZONE', owner: 'C1', outer: rect(550, 500, 680, 640) },
      { id: 'F_TREE_ZONE', owner: 'F1', outer: rect(430, 120, 530, 220) },
    ],
    objects: [
      { id: 'F_BUILDING', type: 'building', owner: 'C1', center: [430, 410], direction: [0, -1], footprint: rect(370, 350, 490, 470), allowedZone: 'F_BUILD_ZONE' },
      { id: 'F_SHIELD', type: 'shield', owner: 'C1', center: [610, 570], direction: null, footprint: P([610, 535], [635, 545], [645, 570], [635, 595], [610, 605], [585, 595], [575, 570], [585, 545]), allowedZone: 'F_SHIELD_ZONE' },
      { id: 'F_TREE', type: 'tree', owner: 'F1', center: [480, 170], direction: null, footprint: rect(460, 150, 500, 190), allowedZone: 'F_TREE_ZONE' },
    ],
  },
  meepleZones: [
    { id: 'F_M_C1', owner: 'C1', outer: rect(400, 500, 520, 620) },
    { id: 'F_M_F1', owner: 'F1', outer: rect(400, 110, 600, 230) },
    { id: 'F_M_F2', owner: 'F2', outer: rect(400, 770, 600, 890) },
  ],
};

const H = {
  id: 'H',
  title: 'Два раздельных города',
  summary: 'Западный C2 и восточный C1 имеют такие же виды внешних сторон, как F, но внутри не соединены.',
  regions: [
    { id: 'C2', kind: 'city', outer: P([0, 0], [80, 80], [330, 300], [330, 700], [80, 920], [0, 1000]), holes: [] },
    { id: 'C1', kind: 'city', outer: P([1000, 0], [1000, 1000], [920, 920], [670, 700], [670, 300], [920, 80]), holes: [] },
    { id: 'F1', kind: 'field', outer: P([0, 0], [1000, 0], [920, 80], [670, 300], [670, 700], [920, 920], [1000, 1000], [0, 1000], [80, 920], [330, 700], [330, 300], [80, 80]), holes: [] },
  ],
  relationships: {
    endsAt: [],
    fieldCityContacts: [{ field: 'F1', city: 'C1' }, { field: 'F1', city: 'C2' }],
    shields: [],
  },
  layout: {
    walls: [
      { id: 'H_WALL_W', city: 'C2', fields: ['F1'], path: P([80, 80], [330, 300], [330, 700], [80, 920]), safeInset: 80 },
      { id: 'H_WALL_E', city: 'C1', fields: ['F1'], path: P([920, 80], [670, 300], [670, 700], [920, 920]), safeInset: 80 },
    ],
    allowedZones: [],
    objects: [],
  },
  meepleZones: [
    { id: 'H_M_C2', owner: 'C2', outer: rect(100, 400, 250, 600) },
    { id: 'H_M_C1', owner: 'C1', outer: rect(750, 400, 900, 600) },
    { id: 'H_M_F1', owner: 'F1', outer: rect(410, 400, 590, 600) },
  ],
};

const A = {
  id: 'A',
  title: 'Монастырь, дорога и одно поле',
  summary: 'Дорога R1 заканчивается у M1, а поле остаётся одним связным контуром вокруг монастыря сверху.',
  regions: [
    { id: 'M1', kind: 'monastery', outer: rect(340, 280, 660, 580), holes: [] },
    { id: 'R1', kind: 'road', outer: rect(410, 580, 590, 1000), holes: [] },
    { id: 'F1', kind: 'field', outer: P([0, 0], [1000, 0], [1000, 1000], [590, 1000], [590, 580], [660, 580], [660, 280], [340, 280], [340, 580], [410, 580], [410, 1000], [0, 1000]), holes: [] },
  ],
  relationships: {
    endsAt: [{ road: 'R1', target: 'M1' }],
    fieldCityContacts: [],
    shields: [],
  },
  layout: {
    walls: [],
    allowedZones: [
      { id: 'A_MONASTERY_ZONE', owner: 'M1', outer: rect(380, 310, 620, 550) },
      { id: 'A_TREE_ZONE', owner: 'F1', outer: rect(740, 150, 840, 250) },
    ],
    objects: [
      { id: 'A_MONASTERY_BUILDING', type: 'monastery-building', owner: 'M1', center: [500, 430], direction: [0, -1], footprint: rect(400, 330, 600, 540), allowedZone: 'A_MONASTERY_ZONE' },
      { id: 'A_TREE', type: 'tree', owner: 'F1', center: [790, 200], direction: null, footprint: rect(770, 180, 810, 220), allowedZone: 'A_TREE_ZONE' },
    ],
  },
  meepleZones: [
    { id: 'A_M_M1', owner: 'M1', outer: rect(400, 330, 600, 520) },
    { id: 'A_M_R1', owner: 'R1', outer: rect(445, 680, 555, 840) },
    { id: 'A_M_F1', owner: 'F1', outer: rect(100, 400, 260, 600) },
  ],
};

export const VECTOR_TILE_IDS = Object.freeze(['D', 'U', 'W', 'F', 'H', 'A']);
export const VECTOR_TILES = deepFreeze({ D, U, W, F, H, A });

export const HOLE_SAMPLE_B = deepFreeze({
  id: 'B-hole-test',
  title: 'Проверка внутреннего отверстия поля',
  summary: 'Только тест представления: одно поле вокруг внутреннего монастыря.',
  regions: [
    { id: 'F1', kind: 'field', outer: rect(0, 0, 1000, 1000), holes: ['M1'] },
    { id: 'M1', kind: 'monastery', outer: rect(340, 320, 660, 640), holes: [] },
  ],
  relationships: { endsAt: [], fieldCityContacts: [], shields: [] },
  layout: { walls: [], allowedZones: [], objects: [] },
  meepleZones: [],
});

export function regionKindLabel(kind) {
  return kindLabel[kind] || kind;
}

export function getRegion(tile, id) {
  return tile.regions.find((region) => region.id === id) || null;
}

export function rotatePoint([x, y], turns = 1) {
  let point = [x, y];
  const count = ((turns % 4) + 4) % 4;
  for (let turn = 0; turn < count; turn += 1) point = [TILE_SIZE - point[1], point[0]];
  return point;
}

export function rotateVector([dx, dy], turns = 1) {
  let vector = [dx, dy];
  const count = ((turns % 4) + 4) % 4;
  for (let turn = 0; turn < count; turn += 1) vector = [-vector[1], vector[0]];
  return vector;
}

function rotatePolygon(points, turns) {
  return points.map((point) => rotatePoint(point, turns));
}

function rotateMaybeVector(vector, turns) {
  return vector ? rotateVector(vector, turns) : null;
}

export function rotateTile(tile, turns = 1) {
  const count = ((turns % 4) + 4) % 4;
  if (!count) return cloneTile(tile);
  return {
    ...tile,
    regions: tile.regions.map((region) => ({ ...region, outer: rotatePolygon(region.outer, count), holes: [...region.holes] })),
    relationships: cloneRelationships(tile.relationships),
    layout: {
      walls: tile.layout.walls.map((wall) => ({ ...wall, fields: [...wall.fields], path: rotatePolygon(wall.path, count) })),
      allowedZones: tile.layout.allowedZones.map((zone) => ({ ...zone, outer: rotatePolygon(zone.outer, count) })),
      objects: tile.layout.objects.map((object) => ({
        ...object,
        center: rotatePoint(object.center, count),
        direction: rotateMaybeVector(object.direction, count),
        footprint: rotatePolygon(object.footprint, count),
      })),
    },
    meepleZones: tile.meepleZones.map((zone) => ({ ...zone, outer: rotatePolygon(zone.outer, count) })),
  };
}

function cloneRelationships(relationships) {
  return {
    endsAt: relationships.endsAt.map((row) => ({ ...row })),
    fieldCityContacts: relationships.fieldCityContacts.map((row) => ({ ...row })),
    shields: relationships.shields.map((row) => ({ ...row })),
  };
}

function cloneTile(tile) {
  return {
    ...tile,
    regions: tile.regions.map((region) => ({ ...region, outer: region.outer.map(([x, y]) => [x, y]), holes: [...region.holes] })),
    relationships: cloneRelationships(tile.relationships),
    layout: {
      walls: tile.layout.walls.map((wall) => ({ ...wall, fields: [...wall.fields], path: wall.path.map(([x, y]) => [x, y]) })),
      allowedZones: tile.layout.allowedZones.map((zone) => ({ ...zone, outer: zone.outer.map(([x, y]) => [x, y]) })),
      objects: tile.layout.objects.map((object) => ({
        ...object,
        center: [...object.center],
        direction: object.direction ? [...object.direction] : null,
        footprint: object.footprint.map(([x, y]) => [x, y]),
      })),
    },
    meepleZones: tile.meepleZones.map((zone) => ({ ...zone, outer: zone.outer.map(([x, y]) => [x, y]) })),
  };
}

function polygonSegments(points) {
  return points.map((point, index) => [point, points[(index + 1) % points.length]]);
}

function isBoundarySegment([a, b], side, offset = [0, 0]) {
  const x = side === 'E' ? TILE_SIZE + offset[0] : offset[0];
  const y = side === 'S' ? TILE_SIZE + offset[1] : offset[1];
  if (side === 'N' || side === 'S') return a[1] === y && b[1] === y;
  return a[0] === x && b[0] === x;
}

function segmentCoordinate(point, side) {
  return side === 'N' || side === 'S' ? point[0] : point[1];
}

function translated([x, y], [dx, dy]) {
  return [x + dx, y + dy];
}

function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end || a.regionId.localeCompare(b.regionId));
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && previous.end === interval.start && previous.regionId === interval.regionId && previous.kind === interval.kind) {
      previous.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function edgeProfileFromWorldContours(tile, side, offset) {
  const intervals = [];
  for (const region of tile.regions) {
    for (const segment of polygonSegments(region.outer)) {
      const world = [translated(segment[0], offset), translated(segment[1], offset)];
      if (!isBoundarySegment(world, side, offset)) continue;
      const a = segmentCoordinate(world[0], side);
      const b = segmentCoordinate(world[1], side);
      if (a === b) continue;
      intervals.push({ start: Math.min(a, b), end: Math.max(a, b), kind: region.kind, regionId: region.id });
    }
  }
  return mergeIntervals(intervals);
}

export function getEdgeProfile(tile, side) {
  return edgeProfileFromWorldContours(tile, side, [0, 0]);
}

function clippedProfile(profile, start = CONTROL_DEPTH, end = TILE_SIZE - CONTROL_DEPTH) {
  return profile
    .map((interval) => ({ ...interval, start: Math.max(interval.start, start), end: Math.min(interval.end, end) }))
    .filter((interval) => interval.end > interval.start);
}

function toStripPoint([x, y], side) {
  if (side === 'N') return [x, y];
  if (side === 'S') return [x, TILE_SIZE - y];
  if (side === 'W') return [y, x];
  return [y, TILE_SIZE - x];
}

function clipSegmentToRect(a, b, minX, maxX, minY, maxY) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const checks = [
    [-dx, a[0] - minX], [dx, maxX - a[0]], [-dy, a[1] - minY], [dy, maxY - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0 && q < 0) return null;
    if (p === 0) continue;
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [
    [a[0] + dx * t0, a[1] + dy * t0],
    [a[0] + dx * t1, a[1] + dy * t1],
  ];
}

function onStripFrame([a, b]) {
  const values = [CONTROL_DEPTH, TILE_SIZE - CONTROL_DEPTH];
  if (a[1] === 0 && b[1] === 0) return true;
  if (a[1] === CONTROL_DEPTH && b[1] === CONTROL_DEPTH) return true;
  if (values.includes(a[0]) && a[0] === b[0]) return true;
  return false;
}

export function getControlStripSignature(tile, side) {
  const internalSegments = [];
  let stable = true;
  for (const region of tile.regions) {
    for (const [a, b] of polygonSegments(region.outer)) {
      const clipped = clipSegmentToRect(
        toStripPoint(a, side),
        toStripPoint(b, side),
        CONTROL_DEPTH,
        TILE_SIZE - CONTROL_DEPTH,
        0,
        CONTROL_DEPTH,
      );
      if (!clipped) continue;
      const [c, d] = clipped;
      if (c[0] === d[0] && c[1] === d[1]) continue;
      if (onStripFrame(clipped)) continue;
      if (c[0] !== d[0]) stable = false;
      internalSegments.push([c, d]);
    }
  }
  const boundaries = [...new Set(internalSegments.filter(([a, b]) => a[0] === b[0]).map(([a]) => a[0]))].sort((a, b) => a - b);
  return {
    stable,
    boundaries,
    profile: clippedProfile(getEdgeProfile(tile, side)).map(({ start, end, kind, regionId }) => ({ start, end, kind, regionId })),
  };
}

const OPPOSITE = Object.freeze({ N: 'S', E: 'W', S: 'N', W: 'E' });
const OFFSETS = Object.freeze({ N: [0, -1000], E: [1000, 0], S: [0, 1000], W: [-1000, 0] });

function profileKindsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((left, index) => left.start === b[index].start && left.end === b[index].end && left.kind === b[index].kind);
}

function controlSignaturesEqual(a, b) {
  return a.stable && b.stable
    && profileKindsEqual(a.profile, b.profile)
    && a.boundaries.length === b.boundaries.length
    && a.boundaries.every((value, index) => value === b.boundaries[index]);
}

function connectionsAcross(a, b) {
  const rows = [];
  for (const left of a) {
    for (const right of b) {
      const start = Math.max(left.start, right.start);
      const end = Math.min(left.end, right.end);
      if (end <= start || left.kind !== right.kind) continue;
      rows.push({ start, end, kind: left.kind, aRegion: left.regionId, bRegion: right.regionId });
    }
  }
  return rows;
}

export function compareNeighbourPair({ aId, aRotation = 0, bId, bRotation = 0, side = 'E' }) {
  const sourceA = VECTOR_TILES[aId];
  const sourceB = VECTOR_TILES[bId];
  if (!sourceA || !sourceB) throw new Error('Unknown vector sample tile');
  if (!OPPOSITE[side]) throw new Error(`Unknown neighbour side: ${side}`);

  const a = rotateTile(sourceA, aRotation);
  const b = rotateTile(sourceB, bRotation);
  const aOffset = [0, 0];
  const bOffset = OFFSETS[side];
  const aProfile = edgeProfileFromWorldContours(a, side, aOffset);
  const bProfile = edgeProfileFromWorldContours(b, OPPOSITE[side], bOffset);
  const aStrip = getControlStripSignature(a, side);
  const bStrip = getControlStripSignature(b, OPPOSITE[side]);
  const edgeMatch = profileKindsEqual(aProfile, bProfile);
  const stripMatch = controlSignaturesEqual(aStrip, bStrip);

  return {
    match: edgeMatch && stripMatch,
    edgeMatch,
    stripMatch,
    seamAxis: side === 'N' || side === 'S' ? 'worldX' : 'worldY',
    sideA: side,
    sideB: OPPOSITE[side],
    tileA: a,
    tileB: b,
    offsetA: aOffset,
    offsetB: bOffset,
    profileA: aProfile,
    profileB: bProfile,
    controlA: aStrip,
    controlB: bStrip,
    connections: connectionsAcross(aProfile, bProfile),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
