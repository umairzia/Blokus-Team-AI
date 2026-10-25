/**
 * Plays complete AI-versus-AI games. Used by the AI tests and by the
 * evaluation harness (scripts/ai-eval.ts).
 */

import { SEATS, teamOf, type Seat, type Team } from '../engine/constants';
import { applyAction, legalActions, newGame, scoreGame, type GameScore, type GameState } from '../engine/game';
import { pieceById } from '../engine/pieces';
import { createRng, mixSeed } from '../util/rng';
import { chooseAction, type Level, type Tuning } from './decide';

export interface SeatPlayer {
  readonly level: Level;
  readonly tuning?: Partial<Tuning>;
}

export interface MatchOptions {
  /** One player per seat, in seat order. */
  readonly players: readonly [SeatPlayer, SeatPlayer, SeatPlayer, SeatPlayer];
  readonly seed: number;
  /**
   * Plies at the start chosen at random among pentomino placements (seeded),
   * so that a series of games covers different openings.
   */
  readonly randomOpeningPlies?: number;
  readonly timeLimitMs?: number;
}

export interface MatchResult {
  readonly final: GameState;
  readonly score: GameScore;
  /** Winning team, or null for a tie. */
  readonly winner: Team | null;
  /** Thinking time per seat (ms), summed over the game. */
  readonly thinkMs: number[];
  /** Longest single decision (ms). */
  readonly maxDecisionMs: number;
  readonly plies: number;
  readonly timeouts: number;
}

export function playMatch(opts: MatchOptions): MatchResult {
  const rng = createRng(mixSeed(opts.seed, 0x5eed));
  let state = newGame();
  const thinkMs = [0, 0, 0, 0];
  let maxDecisionMs = 0;
  let plies = 0;
  let timeouts = 0;
  const opening = opts.randomOpeningPlies ?? 0;
  while (state.status === 'playing') {
    const seat = state.turn as Seat;
    if (plies < opening) {
      const moves = legalActions(state, seat);
      const big = moves.filter((m) => pieceById(m.piece).size === 5);
      const pool = big.length ? big : moves;
      state = applyAction(state, pool[Math.floor(rng() * pool.length)]);
    } else {
      const p = opts.players[seat];
      const d = chooseAction(state, seat, {
        level: p.level,
        tuning: p.tuning,
        seed: mixSeed(opts.seed, seat),
        timeLimitMs: opts.timeLimitMs,
      });
      thinkMs[seat] += d.elapsedMs;
      maxDecisionMs = Math.max(maxDecisionMs, d.elapsedMs);
      if (d.timedOut) timeouts++;
      state = applyAction(state, d.action);
    }
    plies++;
  }
  const score = scoreGame(state);
  return { final: state, score, winner: score.leader, thinkMs, maxDecisionMs, plies, timeouts };
}

/** Team-0 seats get `a`, team-1 seats get `b`. */
export function lineup(a: SeatPlayer, b: SeatPlayer): [SeatPlayer, SeatPlayer, SeatPlayer, SeatPlayer] {
  return SEATS.map((s) => (teamOf(s) === 0 ? a : b)) as [SeatPlayer, SeatPlayer, SeatPlayer, SeatPlayer];
}
