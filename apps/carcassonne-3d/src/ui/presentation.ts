import type {
  GameEvent, HeraldicSymbol, Player, PlayerId, Rotation, Terrain, TileRegion,
} from '../game';

export const HERALDRY: Record<HeraldicSymbol, { label: string; glyph: string }> = {
  lion: { label: 'Лев', glyph: '♌' },
  eagle: { label: 'Орёл', glyph: '◆' },
  tower: { label: 'Башня', glyph: '♜' },
  sun: { label: 'Солнце', glyph: '☼' },
  oak: { label: 'Дуб', glyph: '♣' },
};

export const TERRAIN_NAMES: Readonly<Record<Terrain, string>> = {
  city: 'Город', road: 'Дорога', field: 'Поле',
};

export const REGION_NAMES: Readonly<Record<TileRegion['kind'], string>> = {
  city: 'Город', road: 'Дорога', field: 'Поле', monastery: 'Монастырь',
};

export const ROTATIONS = [0, 1, 2, 3] as const satisfies readonly Rotation[];

export function degrees(rotation: Rotation): number {
  return rotation * 90;
}

export function describeRegion(kind: TileRegion['kind']): string {
  return REGION_NAMES[kind];
}

export function playerLabel(player: Pick<Player, 'name' | 'heraldicSymbol'>): string {
  return HERALDRY[player.heraldicSymbol].label + ' · ' + player.name;
}

export interface RankedPlayer {
  player: Player;
  points: number;
  rank: number;
  winning: boolean;
}

/** View-only ranking: all awarded points come from the immutable game state. */
export function rankPlayers(
  players: readonly Player[],
  scores: Readonly<Record<string, number>>,
): RankedPlayer[] {
  const rows = players.map((player) => ({ player, points: scores[player.id] ?? 0 }));
  rows.sort((a, b) => b.points - a.points || players.indexOf(a.player) - players.indexOf(b.player));
  return rows.map((row) => ({
    ...row,
    rank: 1 + rows.filter((other) => other.points > row.points).length,
    winning: rows.length > 0 && row.points === rows[0]!.points,
  }));
}

function names(ids: readonly PlayerId[], players: readonly Player[]): string {
  return ids.map((id) => players.find((p) => p.id === id)?.name ?? id).join(', ');
}

export function eventDescription(event: GameEvent, players: readonly Player[]): string {
  switch (event.type) {
    case 'TILE_PLACED':
      return 'Выложена плитка ' + event.placementId.replace('place:', '') + '.';
    case 'TILE_DISCARDED':
      return 'Плитка ' + event.tileInstanceId + ' сброшена: размещение невозможно.';
    case 'MEEPLE_PLACED':
      return (players.find((p) => p.id === event.playerId)?.name ?? event.playerId)
        + ' разместил(а) фигурку: ' + event.targetId.replace(/^region:/, '') + '.';
    case 'FEATURE_SCORED':
      return (event.completed ? 'Завершена область' : 'Итоговый подсчёт')
        + ' «' + describeRegion(event.kind) + '»: '
        + (event.winnerIds.length ? names(event.winnerIds, players) : 'без владельца')
        + ', ' + event.pointsEach + ' очк. каждому.';
    case 'MEEPLES_RETURNED':
      return 'Вернулись фигурки: ' + event.ids.length + '.';
    case 'TURN_ADVANCED':
      return 'Новый ход №' + event.turn + ' — '
        + (players.find((p) => p.id === event.activePlayerId)?.name ?? event.activePlayerId) + '.';
    case 'GAME_FINISHED':
      return 'Игра завершена. Окончательные результаты подтверждены движком.';
  }
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
}

export function formatCoordinate(x: number, z: number): string {
  return (x > 0 ? '+' : '') + x + ' / ' + (z > 0 ? '+' : '') + z;
}
