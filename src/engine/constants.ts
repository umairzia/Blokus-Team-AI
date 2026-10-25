/**
 * Board size, seats, teams and start corners. Everything else in the engine
 * is derived from these.
 */

export const BOARD_SIZE = 20;
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
export const SEAT_COUNT = 4;

/** Seats in clockwise turn order. */
export type Seat = 0 | 1 | 2 | 3;
export const SEATS: readonly Seat[] = [0, 1, 2, 3];

/** Team 0 plays seats 0 and 2; team 1 plays seats 1 and 3. */
export type Team = 0 | 1;

export function teamOf(seat: Seat): Team {
  return (seat % 2) as Team;
}

export function teammateOf(seat: Seat): Seat {
  return ((seat + 2) % SEAT_COUNT) as Seat;
}

export function isSeat(value: unknown): value is Seat {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/**
 * Start corners, clockwise from the top-left, so teammates (seats 0/2 and
 * 1/3) start in diagonally opposite corners.
 */
export const START_CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [BOARD_SIZE - 1, 0],
  [BOARD_SIZE - 1, BOARD_SIZE - 1],
  [0, BOARD_SIZE - 1],
];

export function cellIndex(x: number, y: number): number {
  return y * BOARD_SIZE + x;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;
}

/**
 * Diagonal directions, indexed 0-3: up-left, up-right, down-right,
 * down-left. Bit `1 << d` in a mask stands for direction `d`.
 */
export const DIAGONALS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

export const ORTHOGONALS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * The diagonal direction that points off the board from each start corner.
 * A piece covering the corner must have its corner cell "open" that way.
 */
export const START_CORNER_DIAGONAL: readonly number[] = [0, 1, 2, 3];
