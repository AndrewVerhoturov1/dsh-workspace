import { describe, expect, it } from 'vitest';
import type { GameEvent, Player, PlayerId } from '../game';
import {
  HERALDRY, ROTATIONS, degrees, describeRegion, eventDescription,
  formatCoordinate, playerLabel, rankPlayers,
} from './presentation';

const players: readonly Player[] = [
  { id: 'p1', name: 'Рада', color: '#A42F30', heraldicSymbol: 'lion' },
  { id: 'p2', name: 'Мир', color: '#2B6081', heraldicSymbol: 'tower' },
  { id: 'p3', name: 'Яр', color: '#67904F', heraldicSymbol: 'oak' },
];

describe('UI presentation reads engine state without making game rules', () => {
  it('renders a stable four-rotation selector', () => {
    expect(ROTATIONS).toEqual([0, 1, 2, 3]);
    expect(ROTATIONS.map(degrees)).toEqual([0, 90, 180, 270]);
  });

  it('uses player names and five distinct heraldic labels beyond color', () => {
    expect(Object.keys(HERALDRY)).toHaveLength(5);
    expect(new Set(Object.values(HERALDRY).map((symbol) => symbol.label)).size).toBe(5);
    expect(playerLabel(players[1]!)).toContain('Мир');
    expect(playerLabel(players[1]!)).toContain('Башня');
  });

  it('declares every tied leader a winner, without inventing missing scores', () => {
    const table = rankPlayers(players, { p1: 14, p2: 21, p3: 21 });
    expect(table.map((row) => [row.player.id, row.points, row.rank, row.winning])).toEqual([
      ['p2', 21, 1, true],
      ['p3', 21, 1, true],
      ['p1', 14, 3, false],
    ]);
    expect(rankPlayers(players, {})).toHaveLength(3);
    expect(rankPlayers(players, {}).every((row) => row.points === 0 && row.winning)).toBe(true);
  });

  it('describes scoring results only from delivered game events', () => {
    const event: GameEvent = {
      type: 'FEATURE_SCORED', kind: 'city', winnerIds: ['p1', 'p3'],
      pointsEach: 8, completed: true,
    };
    const message = eventDescription(event, players);
    expect(message).toContain('Рада');
    expect(message).toContain('Яр');
    expect(message).toContain('8 очк.');
    expect(message).toContain('Завершена');
    expect(describeRegion('monastery')).toBe('Монастырь');
  });

  it('describes accepted commands, auto discards, turns, returned followers and final events', () => {
    const entries: readonly GameEvent[] = [
      { type: 'TILE_PLACED', tileInstanceId: 'tile-example', placementId: 'place:-1,2:r3' },
      { type: 'TILE_DISCARDED', tileInstanceId: 'tile-unused' },
      { type: 'MEEPLE_PLACED', playerId: 'p1', meepleId: 'meeple-001', targetId: 'region:1,2:field-west' },
      { type: 'MEEPLES_RETURNED', ids: ['meeple-001'] },
      { type: 'TURN_ADVANCED', turn: 2, activePlayerId: 'p2' },
      { type: 'GAME_FINISHED', scores: { p1: 5, p2: 7 } },
    ];
    expect(entries.map((event) => eventDescription(event, players)).every((entry) => entry.length > 12)).toBe(true);
    expect(eventDescription(entries[0]!, players)).toContain('-1,2:r3');
    expect(eventDescription(entries[4]!, players)).toContain('Мир');
    expect(eventDescription(entries[5]!, players)).toContain('движком');
  });

  it('shows negative and positive grid coordinates unambiguously', () => {
    expect(formatCoordinate(-11, 2)).toBe('-11 / +2');
    expect(formatCoordinate(0, 0)).toBe('0 / 0');
  });

  it('keeps all PlayerId variants type-compatible', () => {
    const ids: readonly PlayerId[] = ['p1', 'p2', 'p3', 'p4', 'p5'];
    expect(new Set(ids).size).toBe(5);
  });
});
