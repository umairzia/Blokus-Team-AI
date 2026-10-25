import {
  CELL_COUNT,
  PIECES,
  Position,
  SEATS,
  cellIndex,
  legalActions,
  applyAction,
  newGame,
  pieceById,
  type GameState,
  type HistoryEntry,
  type PieceId,
  type Seat,
} from '../src/engine';
import { createRng } from '../src/util/rng';

export type Placement = readonly [seat: Seat, piece: PieceId, o: number, x: number, y: number];

/**
 * Builds a state from placements in any order (ignoring turn order), for
 * setting up positions that are awkward to reach by normal play. Each
 * placement must still be legal where it is put.
 */
export function craft(placements: readonly Placement[], turn: Seat = 0): GameState {
  const pos = Position.empty();
  const board = '.'.repeat(CELL_COUNT).split('');
  const remaining = SEATS.map(() => (1 << PIECES.length) - 1);
  const last: (PieceId | null)[] = SEATS.map(() => null);
  const history: HistoryEntry[] = [];
  for (const [seat, piece, o, x, y] of placements) {
    const def = pieceById(piece);
    const problem = pos.validate(seat, def.index, o, x, y);
    if (problem) throw new Error(`craft: ${seat} ${piece}/${o} at ${x},${y}: ${problem}`);
    pos.place(seat, def.index, o, x, y);
    for (const [cx, cy] of def.orientations[o].cells) board[cellIndex(x + cx, y + cy)] = String(seat);
    remaining[seat] &= ~(1 << def.index);
    last[seat] = piece;
    history.push({ type: 'place', seat, piece, o, x, y });
  }
  return {
    n: placements.length,
    status: 'playing',
    turn,
    board: board.join(''),
    remaining,
    out: SEATS.map(() => false),
    last,
    history,
  };
}

/** Plays uniformly random legal moves until the game ends. */
export function playRandomGame(seed: number, maxPlies = 400): GameState[] {
  const rng = createRng(seed);
  let state = newGame();
  const states = [state];
  for (let i = 0; i < maxPlies && state.status === 'playing'; i++) {
    const moves = legalActions(state, state.turn);
    if (moves.length === 0) throw new Error('playing seat has no legal move');
    state = applyAction(state, moves[Math.floor(rng() * moves.length)]);
    states.push(state);
  }
  return states;
}

export function orientationOf(piece: PieceId, art: string): number {
  const cells: [number, number][] = [];
  art.split('\n').forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') cells.push([x, y]);
  });
  const key = cells
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([x, y]) => `${x},${y}`)
    .join(';');
  const o = pieceById(piece).orientations.findIndex((or) => or.key === key);
  if (o < 0) throw new Error(`no orientation of ${piece} looks like that`);
  return o;
}
