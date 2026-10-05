import { RESEARCH_CATALOGUE } from './research-data.mjs';
import { VECTOR_TILES, compareNeighbourPair, getRegion } from './vector-sample.mjs';

export const BOARD_SIDES = Object.freeze(['N', 'E', 'S', 'W']);
export const BOARD_OFFSETS = Object.freeze({
  N: Object.freeze([0, -1]), E: Object.freeze([1, 0]), S: Object.freeze([0, 1]), W: Object.freeze([-1, 0]),
});

const START_TILE_ID = 'D';
const START_POSITION = Object.freeze({ x: 0, y: 0 });

function key(x, y) { return `${x},${y}`; }
function normalizedRotation(rotation = 0) { return ((Number(rotation) % 4) + 4) % 4; }

export function catalogueQuantities() {
  return Object.fromEntries(RESEARCH_CATALOGUE.map((tile) => [tile.id, tile.quantity]));
}

export function totalRemaining(state) {
  return Object.values(state.remaining).reduce((sum, value) => sum + value, 0);
}

export function createInitialBoardState() {
  const remaining = catalogueQuantities();
  remaining[START_TILE_ID] -= 1;
  return {
    placements: [{ x: START_POSITION.x, y: START_POSITION.y, tileId: START_TILE_ID, rotation: 0, start: true }],
    remaining,
    history: [],
  };
}

export function placementAt(state, x, y) {
  return state.placements.find((placement) => placement.x === x && placement.y === y) || null;
}

export function occupiedBounds(state) {
  const xs = state.placements.map((p) => p.x);
  const ys = state.placements.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

export function candidateCells(state) {
  const occupied = new Set(state.placements.map((p) => key(p.x, p.y)));
  const result = new Map();
  for (const placement of state.placements) {
    for (const side of BOARD_SIDES) {
      const [dx, dy] = BOARD_OFFSETS[side];
      const x = placement.x + dx;
      const y = placement.y + dy;
      if (!occupied.has(key(x, y))) result.set(key(x, y), { x, y });
    }
  }
  return [...result.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

export function evaluatePlacement(state, { tileId, rotation = 0, x, y }) {
  if (!VECTOR_TILES[tileId]) return { ok: false, reason: 'Неизвестный тип плитки.' };
  if ((state.remaining[tileId] || 0) <= 0) return { ok: false, reason: 'Плитки этого типа закончились.' };
  if (placementAt(state, x, y)) return { ok: false, reason: 'Эта клетка уже занята.' };

  const checks = [];
  for (const side of BOARD_SIDES) {
    const [dx, dy] = BOARD_OFFSETS[side];
    const neighbour = placementAt(state, x + dx, y + dy);
    if (!neighbour) continue;
    const seam = compareNeighbourPair({
      aId: tileId,
      aRotation: normalizedRotation(rotation),
      bId: neighbour.tileId,
      bRotation: neighbour.rotation,
      side,
    });
    checks.push({ side, neighbour, seam });
  }

  if (!checks.length) return { ok: false, reason: 'Новая плитка должна касаться поля стороной, а не только углом.' };
  const failed = checks.find((check) => !check.seam.match);
  if (failed) {
    const sideName = { N: 'сверху', E: 'справа', S: 'снизу', W: 'слева' }[failed.side];
    return { ok: false, reason: `Не совпадает край ${sideName}.`, checks };
  }
  return { ok: true, reason: checks.length > 1 ? `Подходит ко всем соседям (${checks.length}).` : 'Плитка подходит.', checks };
}

export function placeTile(state, placement) {
  const verdict = evaluatePlacement(state, placement);
  if (!verdict.ok) return { state, verdict };
  const normalized = {
    x: placement.x,
    y: placement.y,
    tileId: placement.tileId,
    rotation: normalizedRotation(placement.rotation),
    start: false,
  };
  const next = {
    placements: [...state.placements, normalized],
    remaining: { ...state.remaining, [placement.tileId]: state.remaining[placement.tileId] - 1 },
    history: [...state.history, normalized],
  };
  return { state: next, verdict };
}

export function undoLast(state) {
  const last = state.history.at(-1);
  if (!last) return state;
  return {
    placements: state.placements.filter((placement) => !(placement.x === last.x && placement.y === last.y)),
    remaining: { ...state.remaining, [last.tileId]: state.remaining[last.tileId] + 1 },
    history: state.history.slice(0, -1),
  };
}

export function resetBoard() {
  return createInitialBoardState();
}

export function connectedRegionComponent(state, seed) {
  const startPlacement = placementAt(state, seed.x, seed.y);
  if (!startPlacement) return [];
  const startTile = VECTOR_TILES[startPlacement.tileId];
  const startRegion = getRegion(startTile, seed.regionId);
  if (!startRegion || startRegion.kind === 'junction') return [];

  const queue = [{ x: seed.x, y: seed.y, regionId: seed.regionId }];
  const seen = new Set();
  const result = [];

  while (queue.length) {
    const node = queue.shift();
    const nodeKey = `${node.x},${node.y}:${node.regionId}`;
    if (seen.has(nodeKey)) continue;
    seen.add(nodeKey);
    const placement = placementAt(state, node.x, node.y);
    if (!placement) continue;
    const region = getRegion(VECTOR_TILES[placement.tileId], node.regionId);
    if (!region || region.kind !== startRegion.kind) continue;
    result.push({ ...node, tileId: placement.tileId, rotation: placement.rotation, kind: region.kind });

    for (const side of BOARD_SIDES) {
      const [dx, dy] = BOARD_OFFSETS[side];
      const neighbour = placementAt(state, node.x + dx, node.y + dy);
      if (!neighbour) continue;
      const seam = compareNeighbourPair({
        aId: placement.tileId,
        aRotation: placement.rotation,
        bId: neighbour.tileId,
        bRotation: neighbour.rotation,
        side,
      });
      if (!seam.match) continue;
      for (const connection of seam.connections) {
        if (connection.kind === region.kind && connection.aRegion === node.regionId) {
          queue.push({ x: neighbour.x, y: neighbour.y, regionId: connection.bRegion });
        }
      }
    }
  }
  return result;
}
