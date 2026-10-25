/** Names and labels shared by the views. */

import type { Seat, Team } from '../engine/constants';

export const COLOR_NAMES: readonly string[] = ['Blue', 'Yellow', 'Red', 'Green'];
export const TEAM_NAMES: readonly string[] = ['Team Human', 'Team AI'];
export const LEVEL_NAMES = { easy: 'Easy', normal: 'Normal', hard: 'Hard' } as const;
export const CORNER_NAMES: readonly string[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

export function seatClass(seat: Seat): string {
  return `seat-${seat}`;
}

export function teamName(team: Team): string {
  return TEAM_NAMES[team];
}

export function formatScore(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0';
}
