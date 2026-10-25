/**
 * The AI decision engine. It only ever picks from the engine's own list of
 * legal moves (and passes only when that list is empty), so it can never
 * play an illegal move; the chosen action is checked once more by the same
 * validateAction used for human moves.
 *
 * Levels:
 *  - easy:   own squares + own corner anchors, plus seeded noise. Picks a
 *            reasonable move, ignores everyone else.
 *  - normal: one-ply team evaluation of every legal move: squares placed,
 *            corner anchors, and territory (squares a seat reaches first),
 *            for the AI team minus the human team. Blocking an opponent and
 *            sparing the teammate both fall out of that sum.
 *  - hard:   normal's evaluation shortlists the best few moves; each is then
 *            played out for one full round (opponent, teammate, opponent,
 *            each answering with its own best normal move) and the result
 *            is judged with real mobility (legal-move counts) added.
 *
 * Determinism: given the same state, seat, level and seed the decision is
 * the same. Work is bounded by counts (shortlist size); the wall-clock limit
 * is only a safety net and, if it ever cuts in, the best move found so far
 * is returned.
 */

import { SEAT_COUNT, teamOf, type Seat, type Team } from '../engine/constants';
import { actionFromMove, positionOf, validateAction, type Action, type GameState } from '../engine/game';
import { PIECES, pieceById } from '../engine/pieces';
import { movePiece, type MoveCode, type Position } from '../engine/position';
import { createRng, mixSeed, type Rng } from '../util/rng';
import { features, phaseOf, teamValue, type Weights } from './evaluate';

export type Level = 'easy' | 'normal' | 'hard';
export const LEVELS: readonly Level[] = ['easy', 'normal', 'hard'];

export function isLevel(v: unknown): v is Level {
  return v === 'easy' || v === 'normal' || v === 'hard';
}

export interface AiOptions {
  readonly level: Level;
  readonly seed: number;
  /** Safety cap on thinking time; default per level. */
  readonly timeLimitMs?: number;
  /** Clock, injectable for tests. */
  readonly now?: () => number;
  /** Overrides for experiments (the evaluation harness). */
  readonly tuning?: Partial<Tuning>;
}

export interface AiDecision {
  readonly action: Action;
  /** Candidate moves scored. */
  readonly evaluated: number;
  readonly elapsedMs: number;
  /** True when the time cap stopped the search early. */
  readonly timedOut: boolean;
}

export interface Tuning {
  anchors: number;
  territory: number;
  mobility: number;
  monominoPenalty: number;
  noise: number;
  shortlist: number;
}

const DEFAULT_TIME_LIMIT: Record<Level, number> = { easy: 400, normal: 1200, hard: 2500 };

const TUNING: Record<Level, Tuning> = {
  easy: { anchors: 0.35, territory: 0, mobility: 0, monominoPenalty: 0, noise: 2.5, shortlist: 1 },
  normal: { anchors: 0.6, territory: 0.12, mobility: 0, monominoPenalty: 2.5, noise: 0.01, shortlist: 1 },
  hard: { anchors: 0.6, territory: 0.12, mobility: 0.9, monominoPenalty: 2.5, noise: 0.01, shortlist: 10 },
};

const MONOMINO = pieceById('I1').index;

interface Scored {
  code: MoveCode;
  score: number;
}

function weightsFor(t: Tuning, phase: number): Weights {
  return {
    squares: 1,
    anchors: t.anchors * (1 - 0.4 * phase),
    territory: t.territory * (1 - phase),
  };
}

/** Keeping the monomino for last is worth +5 at the end. */
function piecePenalty(pos: Position, seat: Seat, code: MoveCode, t: Tuning): number {
  if (t.monominoPenalty === 0 || movePiece(code) !== MONOMINO) return 0;
  return (pos.remaining[seat] & ~(1 << MONOMINO)) !== 0 ? t.monominoPenalty : 0;
}

function scoreEasy(pos: Position, seat: Seat, moves: MoveCode[], t: Tuning, rng: Rng): Scored[] {
  return moves.map((code) => {
    const p = pos.clone();
    p.placeCode(seat, code);
    const size = PIECES[movePiece(code)].size;
    return { code, score: size + t.anchors * p.anchorCount(seat) + t.noise * rng() };
  });
}

/** Moves that get the full evaluation (with territory) after the cheap pass. */
const PRESELECT = 30;

/**
 * Normal's evaluation, in two passes: every move gets an exact but cheap
 * score (squares and corner anchors for all four seats, from local anchor
 * deltas, no copying); the best PRESELECT of those are then played on a copy
 * and scored with territory as well. Returns only the fully scored moves.
 */
function scoreNormal(pos: Position, seat: Seat, moves: MoveCode[], t: Tuning, out: readonly boolean[], rng: Rng): Scored[] {
  const team = teamOf(seat);
  const w = weightsFor(t, phaseOf(pos));
  const sign = [0, 1, 2, 3].map((s) => (teamOf(s as Seat) === team ? 1 : -1));
  const live = out.map((o) => (o ? 0 : 1));
  const baseAnchors = [0, 1, 2, 3].map((s) => pos.anchorCount(s as Seat));
  const delta = [0, 0, 0, 0];
  const cheap: Scored[] = moves.map((code) => {
    pos.anchorDeltas(seat, code, delta);
    let v = sign[seat] * w.squares * PIECES[movePiece(code)].size;
    for (let s = 0; s < SEAT_COUNT; s++) v += sign[s] * live[s] * w.anchors * (baseAnchors[s] + delta[s]);
    return { code, score: v - piecePenalty(pos, seat, code, t) + t.noise * rng() };
  });
  if (w.territory <= 0) return cheap;
  cheap.sort((a, b) => b.score - a.score);
  return cheap.slice(0, PRESELECT).map(({ code }) => {
    const p = pos.clone();
    p.placeCode(seat, code);
    const v = teamValue(features(p, true), team, w, out) - piecePenalty(pos, seat, code, t);
    return { code, score: v + t.noise * rng() };
  });
}

function best(scored: Scored[]): Scored {
  let top = scored[0];
  for (const s of scored) if (s.score > top.score) top = s;
  return top;
}

/** Value of a position after a simulated round, with real mobility. */
function deepValue(pos: Position, team: Team, t: Tuning, out: boolean[]): number {
  const w = weightsFor(t, phaseOf(pos));
  let v = teamValue(features(pos, w.territory > 0), team, w, out);
  for (let s = 0; s < SEAT_COUNT; s++) {
    if (out[s]) continue;
    const sign = teamOf(s as Seat) === team ? 1 : -1;
    v += sign * t.mobility * Math.sqrt(pos.countMoves(s as Seat));
  }
  return v;
}

function hardSearch(
  pos: Position,
  seat: Seat,
  moves: MoveCode[],
  t: Tuning,
  out: readonly boolean[],
  rng: Rng,
  deadline: number,
  now: () => number,
): { code: MoveCode; evaluated: number; timedOut: boolean } {
  const team = teamOf(seat);
  const normal = scoreNormal(pos, seat, moves, t, out, rng);
  const ranked = normal.slice().sort((a, b) => b.score - a.score);
  const shortlist = ranked.slice(0, Math.max(1, t.shortlist));
  let chosen = shortlist[0].code;
  let chosenValue = -Infinity;
  let evaluated = moves.length;
  let timedOut = false;
  for (let i = 0; i < shortlist.length; i++) {
    if (i > 0 && now() > deadline) {
      timedOut = true;
      break;
    }
    const p = pos.clone();
    p.placeCode(seat, shortlist[i].code);
    const simOut = out.slice();
    // One round of replies: opponent, teammate, opponent.
    for (let k = 1; k < SEAT_COUNT; k++) {
      const s = ((seat + k) % SEAT_COUNT) as Seat;
      if (simOut[s]) continue;
      const replies = p.legalMoves(s);
      if (replies.length === 0) {
        simOut[s] = true;
        continue;
      }
      const reply = best(scoreNormal(p, s, replies, t, simOut, rng));
      evaluated += replies.length;
      p.placeCode(s, reply.code);
    }
    const value = deepValue(p, team, t, simOut) - piecePenalty(pos, seat, shortlist[i].code, t);
    if (value > chosenValue) {
      chosenValue = value;
      chosen = shortlist[i].code;
    }
  }
  return { code: chosen, evaluated, timedOut };
}

/** Picks the AI's action for `seat` (which must be the seat to move). */
export function chooseAction(state: GameState, seat: Seat, options: AiOptions): AiDecision {
  const now = options.now ?? (() => performance.now());
  const start = now();
  const level = options.level;
  const t: Tuning = { ...TUNING[level], ...options.tuning };
  const deadline = start + (options.timeLimitMs ?? DEFAULT_TIME_LIMIT[level]);
  const rng = createRng(mixSeed(options.seed, state.n, seat));
  const pos = positionOf(state);
  const moves = pos.legalMoves(seat);

  if (moves.length === 0) {
    return { action: { type: 'pass', seat, n: state.n }, evaluated: 0, elapsedMs: now() - start, timedOut: false };
  }

  let code: MoveCode;
  let evaluated = moves.length;
  let timedOut = false;
  if (level === 'easy') {
    code = best(scoreEasy(pos, seat, moves, t, rng)).code;
  } else if (level === 'normal') {
    code = best(scoreNormal(pos, seat, moves, t, state.out, rng)).code;
  } else {
    const r = hardSearch(pos, seat, moves, t, state.out, rng, deadline, now);
    code = r.code;
    evaluated = r.evaluated;
    timedOut = r.timedOut;
  }

  let action: Action = actionFromMove(state, seat, code);
  if (validateAction(state, action) !== null) {
    // Cannot happen (the move came from the legal list); stay safe anyway.
    action = actionFromMove(state, seat, moves[0]);
  }
  return { action, evaluated, elapsedMs: now() - start, timedOut };
}
