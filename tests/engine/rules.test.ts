import { describe, expect, it } from 'vitest';
import {
  ALL_PIECES_MASK,
  BOARD_SIZE,
  CELL_COUNT,
  SEATS,
  START_CORNERS,
  applyAction,
  legalActions,
  newGame,
  positionOf,
  replayHistory,
  teamOf,
  teammateOf,
  tryApplyAction,
  validateAction,
  type Action,
  type GameState,
  type PlaceAction,
  type PieceId,
  type Seat,
} from '../../src/engine';
import { craft, orientationOf, playRandomGame } from '../helpers';

const H = (piece: PieceId, art: string) => orientationOf(piece, art);
const I5_ACROSS = H('I5', '#####');
const I5_DOWN = H('I5', '#\n#\n#\n#\n#');

function place(state: GameState, seat: Seat, piece: PieceId, o: number, x: number, y: number): PlaceAction {
  return { type: 'place', seat, piece, o, x, y, n: state.n };
}

/** Each seat puts its I5 along the top or bottom edge from its corner. */
function openingRound(): GameState {
  let s = newGame();
  s = applyAction(s, place(s, 0, 'I5', I5_ACROSS, 0, 0));
  s = applyAction(s, place(s, 1, 'I5', I5_ACROSS, 15, 0));
  s = applyAction(s, place(s, 2, 'I5', I5_ACROSS, 15, 19));
  s = applyAction(s, place(s, 3, 'I5', I5_ACROSS, 0, 19));
  return s;
}

/**
 * Seat 0 has only the monomino in its corner and seat 1 has walled off the
 * one square diagonal to it, so seat 0 can never move again.
 */
function seatZeroTrapped(turn: Seat): GameState {
  return craft(
    [
      [0, 'I1', 0, 0, 0],
      [1, 'I5', I5_ACROSS, 15, 0],
      [1, 'I4', H('I4', '####'), 11, 1],
      [1, 'I3', H('I3', '###'), 8, 2],
      [1, 'I2', H('I2', '##'), 6, 3],
      [1, 'L5', H('L5', '####\n#...'), 2, 2],
      // The only square diagonal to seat 0's monomino.
      [1, 'I1', 0, 1, 1],
    ],
    turn,
  );
}

/** Seat 0 has run a staircase up to (14,2), right below seat 1's corner piece. */
function staircase(): GameState {
  return craft(
    [
      [0, 'I5', I5_ACROSS, 0, 0],
      [0, 'I4', H('I4', '####'), 5, 1],
      [0, 'I3', H('I3', '###'), 9, 2],
      [0, 'I2', H('I2', '##'), 12, 3],
      [0, 'I1', 0, 14, 2],
      [1, 'I5', I5_ACROSS, 15, 0],
    ],
    1,
  );
}

describe('board and setup', () => {
  it('is a 20 × 20 board, empty, with seat 0 to move', () => {
    const s = newGame();
    expect(BOARD_SIZE).toBe(20);
    expect(CELL_COUNT).toBe(400);
    expect(s.board).toHaveLength(400);
    expect(s.board).toMatch(/^\.{400}$/);
    expect(s.turn).toBe(0);
    expect(s.status).toBe('playing');
  });

  it('gives all four seats their own full set of 21 pieces', () => {
    const s = newGame();
    expect(s.remaining).toEqual([ALL_PIECES_MASK, ALL_PIECES_MASK, ALL_PIECES_MASK, ALL_PIECES_MASK]);
  });

  it('seats teammates in diagonally opposite corners and alternates teams', () => {
    expect(START_CORNERS).toEqual([
      [0, 0],
      [19, 0],
      [19, 19],
      [0, 19],
    ]);
    for (const seat of SEATS) {
      const mate = teammateOf(seat);
      expect(teamOf(mate)).toBe(teamOf(seat));
      const [ax, ay] = START_CORNERS[seat];
      const [bx, by] = START_CORNERS[mate];
      expect(Math.abs(ax - bx)).toBe(19);
      expect(Math.abs(ay - by)).toBe(19);
      expect(teamOf(((seat + 1) % 4) as Seat)).not.toBe(teamOf(seat));
    }
  });

  it('keeps the inventories independent', () => {
    let s = newGame();
    s = applyAction(s, place(s, 0, 'I5', I5_ACROSS, 0, 0));
    expect(s.remaining[0]).not.toBe(ALL_PIECES_MASK);
    expect(s.remaining[1]).toBe(ALL_PIECES_MASK);
    // Seat 1 can still play its own I5.
    expect(validateAction(s, place(s, 1, 'I5', I5_ACROSS, 15, 0))).toBeNull();
  });
});

describe('first placements', () => {
  it('accept a piece covering the seat start corner', () => {
    const s = openingRound();
    expect(s.board.slice(0, 5)).toBe('00000');
    expect(s.board.slice(15, 20)).toBe('11111');
    expect(s.board.slice(395, 400)).toBe('22222');
    expect(s.board.slice(380, 385)).toBe('33333');
    expect(s.turn).toBe(0);
  });

  it('accept any orientation that covers the corner', () => {
    const s = newGame();
    expect(validateAction(s, place(s, 0, 'I5', I5_DOWN, 0, 0))).toBeNull();
    expect(validateAction(s, place(s, 0, 'X5', 0, 0, 0))).toBe('must-cover-corner'); // X cannot cover a corner
    expect(validateAction(s, place(s, 0, 'V5', H('V5', '###\n#..\n#..'), 0, 0))).toBeNull();
  });

  it('reject a first piece that misses the corner', () => {
    const s = newGame();
    expect(validateAction(s, place(s, 0, 'I5', I5_ACROSS, 1, 0))).toBe('must-cover-corner');
    expect(validateAction(s, place(s, 0, 'I1', 0, 10, 10))).toBe('must-cover-corner');
    // Another seat's corner does not count.
    expect(validateAction(s, place(s, 0, 'I5', I5_ACROSS, 15, 0))).toBe('must-cover-corner');
  });

  it('generates exactly the corner-covering first moves', () => {
    const s = newGame();
    const moves = legalActions(s, 0);
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect(validateAction(s, m)).toBeNull();
  });
});

describe('later placements', () => {
  it('accept a piece that touches its own colour only at a corner', () => {
    const s = openingRound();
    expect(validateAction(s, place(s, 0, 'I1', 0, 5, 1))).toBeNull();
    const next = applyAction(s, place(s, 0, 'I1', 0, 5, 1));
    expect(next.board[1 * 20 + 5]).toBe('0');
  });

  it('reject a piece that shares an edge with its own colour', () => {
    const s = openingRound();
    expect(validateAction(s, place(s, 0, 'I1', 0, 5, 0))).toBe('edge-contact');
    expect(validateAction(s, place(s, 0, 'I2', H('I2', '##'), 0, 1))).toBe('edge-contact');
  });

  it('reject a piece that does not touch its own colour', () => {
    const s = openingRound();
    expect(validateAction(s, place(s, 0, 'I1', 0, 10, 10))).toBe('no-corner-contact');
    // Touching only an opponent at a corner is not enough.
    expect(validateAction(s, place(s, 0, 'I1', 0, 14, 1))).toBe('no-corner-contact');
  });

  it('allow edge contact with opponents', () => {
    const s = staircase();
    // (14,1) touches seat 1's own (15,0) at a corner and shares an edge with seat 0's (14,2).
    expect(s.board[2 * 20 + 14]).toBe('0');
    expect(validateAction(s, place(s, 1, 'I1', 0, 14, 1))).toBeNull();
    const after = applyAction(s, place(s, 1, 'I1', 0, 14, 1));
    expect(after.board[1 * 20 + 14]).toBe('1');
  });

  it('reject overlapping placements', () => {
    const s = staircase();
    expect(validateAction(s, place(s, 1, 'I2', H('I2', '#\n#'), 14, 1))).toBe('overlap');
    expect(validateAction(s, place(s, 1, 'I1', 0, 15, 0))).toBe('overlap');
  });

  it('reject placements off the board', () => {
    const s = newGame();
    expect(validateAction(s, place(s, 0, 'I5', I5_ACROSS, -1, 0))).toBe('out-of-bounds');
    expect(validateAction(s, place(s, 0, 'I5', I5_DOWN, 0, 16))).toBe('out-of-bounds');
    const t = openingRound();
    expect(validateAction(t, place(t, 0, 'I2', H('I2', '##'), 19, 5))).toBe('out-of-bounds');
    expect(validateAction(t, place(t, 0, 'I1', 0, 20, 0))).toBe('out-of-bounds');
  });

  it('reject an orientation index the piece does not have', () => {
    const s = newGame();
    expect(validateAction(s, place(s, 0, 'O4', 1, 0, 0))).toBe('bad-orientation');
    expect(validateAction(s, place(s, 0, 'I5', 2, 0, 0))).toBe('bad-orientation');
    expect(validateAction(s, place(s, 0, 'I5', 0.5, 0, 0))).toBe('bad-action');
  });
});

describe('ownership and reuse', () => {
  it('rejects moves for a seat whose turn it is not', () => {
    const s = newGame();
    expect(validateAction(s, place(s, 1, 'I5', I5_ACROSS, 15, 0))).toBe('not-your-turn');
    expect(validateAction(s, place(s, 2, 'I5', I5_ACROSS, 15, 19))).toBe('not-your-turn');
  });

  it('rejects unknown pieces and malformed actions', () => {
    const s = newGame();
    expect(validateAction(s, { ...place(s, 0, 'I5', 0, 0, 0), piece: 'Q9' as PieceId })).toBe('unknown-piece');
    expect(validateAction(s, { ...place(s, 0, 'I5', 0, 0, 0), seat: 7 as Seat })).toBe('bad-action');
    expect(validateAction(s, { type: 'jump', seat: 0, n: 0 } as unknown as Action)).toBe('bad-action');
  });

  it('does not let a piece be played twice', () => {
    const s = openingRound();
    expect(validateAction(s, place(s, 0, 'I5', I5_DOWN, 5, 1))).toBe('piece-used');
    expect(legalActions(s, 0).some((m) => m.piece === 'I5')).toBe(false);
  });

  it('refuses to apply an accepted move a second time', () => {
    const s0 = newGame();
    const first = place(s0, 0, 'I5', I5_ACROSS, 0, 0);
    const s1 = applyAction(s0, first);
    // The same action again (same ply number) is stale...
    expect(tryApplyAction(s1, first)).toEqual({ ok: false, error: 'not-your-turn' });
    const s4 = openingRound();
    expect(tryApplyAction(s4, first)).toEqual({ ok: false, error: 'stale' });
    // ...and even re-stamped with the current ply number the piece is used up.
    expect(tryApplyAction(s4, { ...first, n: s4.n })).toEqual({ ok: false, error: 'piece-used' });
    expect(s4.board.slice(0, 5)).toBe('00000');
  });

  it('never mutates the input state', () => {
    const s = openingRound();
    const copy = JSON.parse(JSON.stringify(s));
    applyAction(s, place(s, 0, 'I1', 0, 5, 1));
    expect(JSON.parse(JSON.stringify(s))).toEqual(copy);
  });
});

describe('passing and the end of the game', () => {
  it('lets a seat with no legal move pass, and only then', () => {
    const s = seatZeroTrapped(0);
    expect(positionOf(s).hasMove(0)).toBe(false);
    expect(validateAction(s, { type: 'pass', seat: 0, n: s.n })).toBeNull();
    const after = applyAction(s, { type: 'pass', seat: 0, n: s.n });
    expect(after.out[0]).toBe(true);
    expect(after.status).toBe('playing');
    expect(after.turn).toBe(1);
    const fresh = newGame();
    expect(validateAction(fresh, { type: 'pass', seat: 0, n: 0 })).toBe('pass-not-allowed');
  });

  it('passes a stuck seat automatically without ending the game', () => {
    const s = seatZeroTrapped(3);
    const after = applyAction(s, place(s, 3, 'I5', I5_DOWN, 0, 15));
    expect(after.status).toBe('playing');
    expect(after.out).toEqual([true, false, false, false]);
    expect(after.turn).toBe(1);
    expect(after.history.at(-1)).toEqual({ type: 'pass', seat: 0, auto: true });
    // Play continues for everyone else.
    const next = legalActions(after, 1)[0];
    const later = applyAction(after, next);
    expect(later.turn).toBe(2);
    expect(later.status).toBe('playing');
  });

  it('ends only when no seat can move, for many random games', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const states = playRandomGame(seed);
      const end = states.at(-1)!;
      expect(end.status).toBe('over');
      expect(end.out).toEqual([true, true, true, true]);
      for (const seat of SEATS) expect(positionOf(end).hasMove(seat)).toBe(false);
      // Before the end somebody could always move.
      for (const st of states.slice(0, -1)) {
        expect(st.status).toBe('playing');
        expect(positionOf(st).hasMove(st.turn)).toBe(true);
      }
      expect(validateAction(end, { type: 'pass', seat: end.turn, n: end.n })).toBe('game-over');
    }
  });

  it('can be rebuilt from its history', () => {
    const end = playRandomGame(99).at(-1)!;
    const again = replayHistory(end.history);
    expect(again).toEqual(end);
  });
});
