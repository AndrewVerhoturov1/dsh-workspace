import type { GameState, TileInstance, TileRegion } from './types';
import { definitionsById, getTileCatalog } from './catalog';
import { boardKey, edgeAt, oppositeSide, SIDES, SIDE_VECTORS } from './geometry';

function validInstance(instance: TileInstance): boolean {
  if (!instance || typeof instance.id !== 'string' || typeof instance.defId !== 'string') return false;
  const match = /^tile-([A-X])-(\d{2})$/.exec(instance.id);
  const def = definitionsById.get(instance.defId);
  return Boolean(match && def && match[1] === def.id
    && Number(match[2]) >= 1 && Number(match[2]) <= def.copies);
}

/** Defensive trust boundary for public transition on runtime-corrupt in-memory states. */
export function isValidGameState(state: GameState): boolean {
  try {
    if (!state || state.rulesetId !== 'base72' || state.catalogVersion !== getTileCatalog().version
      || typeof state.seed !== 'string' || !state.seed.trim()
      || !['tile', 'meeple', 'finished'].includes(state.phase)
      || !Number.isInteger(state.turn) || state.turn < 1 || state.turn > 72
      || !Array.isArray(state.players) || state.players.length < 2 || state.players.length > 5
      || !Array.isArray(state.board) || !Array.isArray(state.bag)
      || !Array.isArray(state.meeples) || !Array.isArray(state.discardedIds)
      || !Array.isArray(state.history)
      || !state.scores || !state.meeplesLeft) return false;

    const ids = new Set<string>();
    const counts = new Map<string, number>();
    const addInstance = (instance: TileInstance): boolean => {
      if (!validInstance(instance) || ids.has(instance.id)) return false;
      ids.add(instance.id);
      counts.set(instance.defId, (counts.get(instance.defId) ?? 0) + 1);
      return true;
    };
    for (const tile of state.board) {
      if (!addInstance(tile)) return false;
      if (!Number.isSafeInteger(tile.x) || !Number.isSafeInteger(tile.z)
        || ![0, 1, 2, 3].includes(tile.rotation)) return false;
    }
    for (const tile of state.bag) if (!addInstance(tile)) return false;
    if (state.pendingTile && !addInstance(state.pendingTile)) return false;
    for (const discardedId of state.discardedIds) {
      if (typeof discardedId !== 'string') return false;
      const defId = /^tile-([A-X])-\d{2}$/.exec(discardedId)?.[1];
      if (!defId || !addInstance({ id: discardedId as TileInstance['id'], defId })) return false;
    }
    if (ids.size !== 72) return false;
    for (const def of getTileCatalog().definitions) if (counts.get(def.id) !== def.copies) return false;

    if (state.board.length === 0 || state.board.length > 72) return false;
    const start = state.board.find((tile) => tile.x === 0 && tile.z === 0);
    if (!start || start.id !== 'tile-D-01' || start.rotation !== 0) return false;
    const positions = new Map(state.board.map((tile) => [boardKey(tile.x, tile.z), tile]));
    if (positions.size !== state.board.length) return false;
    const reached = new Set<string>();
    const pending = [start];
    while (pending.length) {
      const tile = pending.pop()!;
      if (reached.has(tile.id)) continue;
      reached.add(tile.id);
      const def = definitionsById.get(tile.defId)!;
      for (const side of SIDES) {
        const vector = SIDE_VECTORS[side];
        const neighbor = positions.get(boardKey(tile.x + vector.x, tile.z + vector.z));
        if (!neighbor) continue;
        const otherDef = definitionsById.get(neighbor.defId)!;
        if (edgeAt(def, side, tile.rotation) !== edgeAt(otherDef, oppositeSide(side), neighbor.rotation)) return false;
        pending.push(neighbor);
      }
    }
    if (reached.size !== state.board.length) return false;

    const playerIds = new Set<string>();
    for (const [index, player] of state.players.entries()) {
      if (!player || player.id !== 'p' + (index + 1) || playerIds.has(player.id)
        || typeof player.name !== 'string' || !player.name.trim()
        || typeof player.color !== 'string' || !/^#[0-9A-F]{6}$/.test(player.color)
        || !['lion', 'eagle', 'tower', 'sun', 'oak'].includes(player.heraldicSymbol)) return false;
      playerIds.add(player.id);
    }
    if (state.phase === 'finished') {
      if (state.activePlayerId !== null || state.pendingTile !== null || state.currentPlacedId !== null
        || state.bag.length > 0) return false;
    } else if (!state.activePlayerId || !playerIds.has(state.activePlayerId)
      || (state.phase === 'tile' && (!state.pendingTile || state.currentPlacedId !== null))
      || (state.phase === 'meeple' && (state.pendingTile !== null || !state.currentPlacedId
        || !state.board.some((tile) => tile.id === state.currentPlacedId)))) return false;

    const meepleIds = new Set<string>();
    const counted = new Map<string, number>();
    for (const meeple of state.meeples) {
      if (!meeple || typeof meeple.id !== 'string' || !meeple.id.startsWith('meeple-')
        || meepleIds.has(meeple.id) || !playerIds.has(meeple.playerId)) return false;
      meepleIds.add(meeple.id);
      const pieces = /^region:(-?\d+),(-?\d+):([a-z][a-z0-9-]*)$/.exec(meeple.targetId);
      if (!pieces) return false;
      const tile = positions.get(boardKey(Number(pieces[1]), Number(pieces[2])));
      const definition = tile && definitionsById.get(tile.defId);
      if (!definition || !definition.regions.some((region: TileRegion) => region.id === pieces[3])) return false;
      counted.set(meeple.playerId, (counted.get(meeple.playerId) ?? 0) + 1);
    }
    for (const id of playerIds) {
      const left = state.meeplesLeft[id];
      if (typeof left !== 'number' || !Number.isInteger(left) || left < 0 || left > 7 || left + (counted.get(id) ?? 0) !== 7) return false;
      const points = state.scores[id];
      if (typeof points !== 'number' || !Number.isSafeInteger(points) || points < 0) return false;
    }
    if (state.history.length > 200 || state.history.some((cmd) =>
      !cmd || !['PLACE_TILE', 'PLACE_MEEPLE', 'SKIP_MEEPLE'].includes(cmd.type))) return false;
    return true;
  } catch {
    return false;
  }
}
