/**
 * Position features and evaluation for the AI.
 *
 * All evaluations are from one team's point of view: the sum of its two
 * seats' features minus the opponents'. Counting the teammate like oneself
 * is what makes a seat avoid smothering its partner, and counting opponents
 * negatively is what makes it block them.
 */

import { BOARD_SIZE, CELL_COUNT, SEATS, SEAT_COUNT, teamOf, type Seat, type Team } from '../engine/constants';
import type { Position } from '../engine/position';

export interface Features {
  /** Squares placed (the score, up to a constant). */
  squares: number[];
  /** Corner anchors: squares where the seat could start a new piece. */
  anchors: number[];
  /** Empty squares the seat reaches strictly before any other seat. */
  territory: number[];
}

export interface Weights {
  squares: number;
  anchors: number;
  territory: number;
}

const NONE = -1;
const CONTESTED = 4;
const owner = new Int8Array(CELL_COUNT);
const claim = new Int8Array(CELL_COUNT);
let frontier = new Int16Array(CELL_COUNT * 2); // pairs (cell, seat)
let nextFrontier = new Int16Array(CELL_COUNT * 2);

/**
 * Fills `out` with each seat's territory: empty squares it can reach (by
 * edge steps through squares it may still use) strictly before any other
 * seat. All seats flood out from their corner anchors at the same time; a
 * square reached by two seats in the same step is contested and stops both.
 */
export function territory(pos: Position, out: number[]): void {
  owner.fill(NONE);
  claim.fill(NONE);
  out.fill(0);
  let size = 0;
  // Step 0: the anchors themselves.
  for (let s = 0 as Seat; s < SEAT_COUNT; s = (s + 1) as Seat) {
    const forb = pos.forbidden[s];
    const dirs = pos.anchorDirs[s];
    const first = pos.placed[s] === 0;
    for (let c = 0; c < CELL_COUNT; c++) {
      if (first ? pos.anchorMask(s, c) === 0 : dirs[c] === 0 || forb[c] !== 0) continue;
      if (claim[c] === NONE) claim[c] = s;
      else if (claim[c] !== s) claim[c] = CONTESTED;
      frontier[size++] = c;
      frontier[size++] = s;
    }
  }
  while (size > 0) {
    // Settle this step's claims.
    let nextSize = 0;
    for (let i = 0; i < size; i += 2) {
      const c = frontier[i];
      if (owner[c] === NONE) {
        owner[c] = claim[c];
        if (claim[c] !== CONTESTED) out[claim[c]]++;
      }
    }
    // Spread from squares this seat won in this step.
    for (let i = 0; i < size; i += 2) {
      const c = frontier[i];
      const s = frontier[i + 1];
      if (owner[c] !== s) continue;
      const forb = pos.forbidden[s];
      const x = c % BOARD_SIZE;
      for (let k = 0; k < 4; k++) {
        let n: number;
        if (k === 0) {
          if (x === 0) continue;
          n = c - 1;
        } else if (k === 1) {
          if (x === BOARD_SIZE - 1) continue;
          n = c + 1;
        } else if (k === 2) {
          if (c < BOARD_SIZE) continue;
          n = c - BOARD_SIZE;
        } else {
          if (c >= CELL_COUNT - BOARD_SIZE) continue;
          n = c + BOARD_SIZE;
        }
        if (owner[n] !== NONE || forb[n]) continue;
        // An unsettled square has only been claimed during this step, if at all.
        const prev = claim[n];
        if (prev === NONE) {
          claim[n] = s;
          nextFrontier[nextSize++] = n;
          nextFrontier[nextSize++] = s;
        } else if (prev !== s) {
          claim[n] = CONTESTED;
        }
      }
    }
    const t = frontier;
    frontier = nextFrontier;
    nextFrontier = t;
    size = nextSize;
  }
}

export function features(pos: Position, withTerritory: boolean): Features {
  const f: Features = { squares: [0, 0, 0, 0], anchors: [0, 0, 0, 0], territory: [0, 0, 0, 0] };
  for (const s of SEATS) {
    f.squares[s] = pos.squares[s];
    f.anchors[s] = pos.anchorCount(s);
  }
  if (withTerritory) territory(pos, f.territory);
  return f;
}

/** Game progress from 0 (empty board) to 1 (every square of every piece placed). */
export function phaseOf(pos: Position): number {
  let placed = 0;
  for (const s of SEATS) placed += pos.squares[s];
  return Math.min(1, placed / (89 * SEAT_COUNT));
}

/**
 * Team evaluation. `out` lets a seat that can no longer move count only
 * its squares: its anchors and territory are worthless.
 */
export function teamValue(f: Features, team: Team, w: Weights, out: readonly boolean[]): number {
  let v = 0;
  for (const s of SEATS) {
    const sign = teamOf(s) === team ? 1 : -1;
    const live = out[s] ? 0 : 1;
    v += sign * (w.squares * f.squares[s] + live * (w.anchors * f.anchors[s] + w.territory * f.territory[s]));
  }
  return v;
}
