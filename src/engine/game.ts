/**
 * The pure rules engine: an immutable, JSON-friendly GameState and the
 * functions that check and apply actions. No UI, networking or AI here.
 *
 * Turn handling: after every action the turn passes clockwise to the next
 * seat that can still move. A seat with no legal placement is passed
 * automatically (recorded in the history) and is out for the rest of the
 * game: the board only fills up, so it can never move again. The game is
 * over when every seat is out. One seat being out never ends the game.
 *
 * Every action quotes the ply number `n` of the state it was made for, so a
 * stale or replayed action is refused instead of being applied twice.
 */

import { CELL_COUNT, SEATS, SEAT_COUNT, cellIndex, isSeat, teamOf, type Seat, type Team } from './constants';
import { ALL_PIECES_MASK, PIECES, isPieceId, pieceById, squaresInMask, type PieceId } from './pieces';
import { Position, decodeMove, type MoveCode, type PlacementProblem } from './position';

export interface PlaceAction {
  readonly type: 'place';
  readonly seat: Seat;
  readonly piece: PieceId;
  /** Index into the piece's unique orientations. */
  readonly o: number;
  /** Top-left of the orientation's bounding box. */
  readonly x: number;
  readonly y: number;
  /** Ply number of the state this action was made for. */
  readonly n: number;
}

export interface PassAction {
  readonly type: 'pass';
  readonly seat: Seat;
  readonly n: number;
}

export type Action = PlaceAction | PassAction;

export type HistoryEntry =
  | { readonly type: 'place'; readonly seat: Seat; readonly piece: PieceId; readonly o: number; readonly x: number; readonly y: number }
  | { readonly type: 'pass'; readonly seat: Seat; readonly auto: boolean };

export type GameStatus = 'playing' | 'over';

export interface GameState {
  /** Number of actions accepted so far. */
  readonly n: number;
  readonly status: GameStatus;
  /** Seat to move (when playing). */
  readonly turn: Seat;
  /** 400 characters, row by row: '.' empty or '0'-'3' for a seat. */
  readonly board: string;
  /** Per seat: bitmask of unplayed pieces (bit i = PIECES[i]). */
  readonly remaining: readonly number[];
  /** Per seat: true once the seat can never move again. */
  readonly out: readonly boolean[];
  /** Per seat: the last piece placed, or null. */
  readonly last: readonly (PieceId | null)[];
  readonly history: readonly HistoryEntry[];
}

export type ActionError =
  | 'game-over'
  | 'bad-action'
  | 'not-your-turn'
  | 'stale'
  | 'unknown-piece'
  | 'pass-not-allowed'
  | PlacementProblem;

export const ERROR_TEXT: Record<ActionError, string> = {
  'game-over': 'The game is over.',
  'bad-action': 'That move could not be understood.',
  'not-your-turn': 'It is not your turn.',
  stale: 'The board changed before that move arrived. Please try again.',
  'unknown-piece': 'That piece does not exist.',
  'pass-not-allowed': 'You can only pass when no piece fits.',
  'piece-used': 'That piece has already been played.',
  'bad-orientation': 'That piece cannot be turned that way.',
  'out-of-bounds': 'The piece must be completely on the board.',
  overlap: 'The piece overlaps squares that are already taken.',
  'edge-contact': 'A piece may not share an edge with your own colour.',
  'must-cover-corner': 'Your first piece must cover your starting corner.',
  'no-corner-contact': 'The piece must touch your own colour at a corner.',
};

export type ApplyResult = { ok: true; state: GameState } | { ok: false; error: ActionError };

export function newGame(): GameState {
  return {
    n: 0,
    status: 'playing',
    turn: 0,
    board: '.'.repeat(CELL_COUNT),
    remaining: SEATS.map(() => ALL_PIECES_MASK),
    out: SEATS.map(() => false),
    last: SEATS.map(() => null),
    history: [],
  };
}

const positions = new WeakMap<GameState, Position>();

/**
 * The fast Position for a state (cached; do not mutate it - clone first).
 * Built from the history so it does not depend on the redundant fields.
 */
export function positionOf(state: GameState): Position {
  let pos = positions.get(state);
  if (!pos) {
    pos = Position.empty();
    for (const h of state.history) {
      if (h.type === 'place') pos.place(h.seat, pieceById(h.piece).index, h.o, h.x, h.y);
    }
    positions.set(state, pos);
  }
  return pos;
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Returns why an action is illegal in this state, or null if it is legal. */
export function validateAction(state: GameState, action: Action): ActionError | null {
  if (!action || typeof action !== 'object' || !isSeat(action.seat) || !isInt(action.n)) return 'bad-action';
  if (state.status !== 'playing') return 'game-over';
  if (action.seat !== state.turn) return 'not-your-turn';
  if (action.n !== state.n) return 'stale';
  const pos = positionOf(state);
  if (action.type === 'pass') return pos.hasMove(action.seat) ? 'pass-not-allowed' : null;
  if (action.type !== 'place') return 'bad-action';
  if (!isPieceId(action.piece)) return 'unknown-piece';
  if (!isInt(action.o) || !isInt(action.x) || !isInt(action.y)) return 'bad-action';
  return pos.validate(action.seat, pieceById(action.piece).index, action.o, action.x, action.y);
}

/** Applies a legal action; returns the error instead when it is not legal. */
export function tryApplyAction(state: GameState, action: Action): ApplyResult {
  const error = validateAction(state, action);
  if (error) return { ok: false, error };
  const seat = action.seat;
  const pos = positionOf(state).clone();
  const board = state.board.split('');
  const remaining = state.remaining.slice();
  const out = state.out.slice();
  const last = state.last.slice();
  const history: HistoryEntry[] = state.history.slice();

  if (action.type === 'place') {
    const piece = pieceById(action.piece);
    pos.place(seat, piece.index, action.o, action.x, action.y);
    for (const [cx, cy] of piece.orientations[action.o].cells) board[cellIndex(action.x + cx, action.y + cy)] = String(seat);
    remaining[seat] &= ~(1 << piece.index);
    last[seat] = piece.id;
    history.push({ type: 'place', seat, piece: piece.id, o: action.o, x: action.x, y: action.y });
    if (remaining[seat] === 0) out[seat] = true;
  } else {
    out[seat] = true;
    history.push({ type: 'pass', seat, auto: false });
  }

  // Hand the turn clockwise to the next seat that can move, passing (and
  // retiring) seats that cannot.
  let turn: Seat = seat;
  let status: GameStatus = 'over';
  for (let i = 1; i <= SEAT_COUNT; i++) {
    const s = ((seat + i) % SEAT_COUNT) as Seat;
    if (out[s]) continue;
    if (!pos.hasMove(s)) {
      out[s] = true;
      history.push({ type: 'pass', seat: s, auto: true });
      continue;
    }
    turn = s;
    status = 'playing';
    break;
  }

  const next: GameState = { n: state.n + 1, status, turn, board: board.join(''), remaining, out, last, history };
  positions.set(next, pos);
  return { ok: true, state: next };
}

export class IllegalActionError extends Error {
  readonly code: ActionError;
  constructor(code: ActionError) {
    super(ERROR_TEXT[code]);
    this.code = code;
    this.name = 'IllegalActionError';
  }
}

/** Applies a legal action; throws IllegalActionError otherwise. */
export function applyAction(state: GameState, action: Action): GameState {
  const res = tryApplyAction(state, action);
  if (!res.ok) throw new IllegalActionError(res.error);
  return res.state;
}

/** Every legal placement for the seat, as actions for this state. */
export function legalActions(state: GameState, seat: Seat): PlaceAction[] {
  if (state.status !== 'playing') return [];
  return positionOf(state)
    .legalMoves(seat)
    .map((code) => actionFromMove(state, seat, code));
}

export function hasLegalMove(state: GameState, seat: Seat): boolean {
  return state.status === 'playing' && !state.out[seat] && positionOf(state).hasMove(seat);
}

export function actionFromMove(state: GameState, seat: Seat, code: MoveCode): PlaceAction {
  const m = decodeMove(code);
  return { type: 'place', seat, piece: PIECES[m.piece].id, o: m.o, x: m.x, y: m.y, n: state.n };
}

/**
 * Rebuilds a state from its history (the non-automatic entries are the
 * actions; automatic passes are re-derived). Used to check a state received
 * over the network. Throws if any action is illegal.
 */
export function replayHistory(history: readonly HistoryEntry[]): GameState {
  let state = newGame();
  for (const h of history) {
    if (h.type === 'pass' && h.auto) continue;
    const action: Action =
      h.type === 'place'
        ? { type: 'place', seat: h.seat, piece: h.piece, o: h.o, x: h.x, y: h.y, n: state.n }
        : { type: 'pass', seat: h.seat, n: state.n };
    state = applyAction(state, action);
  }
  return state;
}

// ---- Scoring -------------------------------------------------------------

export const ALL_PIECES_BONUS = 15;
export const MONOMINO_LAST_BONUS = 5;

export interface SeatScore {
  readonly seat: Seat;
  readonly remainingSquares: number;
  readonly piecesLeft: number;
  readonly allPlaced: boolean;
  readonly monominoLast: boolean;
  /** −remainingSquares, or +15 (+5 more if the monomino went last) when all are placed. */
  readonly score: number;
}

export interface GameScore {
  readonly seats: readonly SeatScore[];
  /** Team totals: [team 0 (seats 0 + 2), team 1 (seats 1 + 3)]. */
  readonly teams: readonly [number, number];
  /** The winning team, or null for a tie. */
  readonly leader: Team | null;
}

export function scoreSeat(state: GameState, seat: Seat): SeatScore {
  const mask = state.remaining[seat];
  const remainingSquares = squaresInMask(mask);
  const allPlaced = mask === 0;
  const monominoLast = allPlaced && state.last[seat] === 'I1';
  const score = allPlaced ? ALL_PIECES_BONUS + (monominoLast ? MONOMINO_LAST_BONUS : 0) : -remainingSquares;
  let piecesLeft = 0;
  for (let i = 0; i < PIECES.length; i++) if (mask & (1 << i)) piecesLeft++;
  return { seat, remainingSquares, piecesLeft, allPlaced, monominoLast, score };
}

/** Scores as they stand (final once the game is over). */
export function scoreGame(state: GameState): GameScore {
  const seats = SEATS.map((s) => scoreSeat(state, s));
  const teams: [number, number] = [0, 0];
  for (const s of seats) teams[teamOf(s.seat)] += s.score;
  const leader: Team | null = teams[0] === teams[1] ? null : teams[0] > teams[1] ? 0 : 1;
  return { seats, teams, leader };
}
