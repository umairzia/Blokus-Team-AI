import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BOARD_SIZE,
  ORTHOGONALS,
  PIECES,
  SEATS,
  applyAction,
  encodeMove,
  inBounds,
  legalActions,
  positionOf,
  validateAction,
  type GameState,
  type Seat,
} from '../../src/engine';
import { playRandomGame } from '../helpers';

/** Every legal placement found by checking all piece/orientation/position combinations. */
function bruteForce(state: GameState, seat: Seat): Set<number> {
  const pos = positionOf(state);
  const out = new Set<number>();
  for (const p of PIECES) {
    if (!pos.hasPiece(seat, p.index)) continue;
    p.orientations.forEach((_o, oi) => {
      for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
          if (pos.validate(seat, p.index, oi, x, y) === null) out.add(encodeMove(p.index, oi, x, y));
        }
      }
    });
  }
  return out;
}

/** Placed pieces of one seat never share an edge with each other. */
function noOwnEdgeContact(state: GameState): boolean {
  const owner = new Map<number, number>(); // cell -> history index of the piece
  state.history.forEach((h, i) => {
    if (h.type !== 'place') return;
    for (const [cx, cy] of PIECES.find((p) => p.id === h.piece)!.orientations[h.o].cells) {
      owner.set((h.y + cy) * BOARD_SIZE + h.x + cx, i);
    }
  });
  for (const [cell, i] of owner) {
    const x = cell % BOARD_SIZE;
    const y = Math.floor(cell / BOARD_SIZE);
    for (const [dx, dy] of ORTHOGONALS) {
      if (!inBounds(x + dx, y + dy)) continue;
      const j = owner.get((y + dy) * BOARD_SIZE + x + dx);
      if (j !== undefined && j !== i && state.history[j].seat === state.history[i].seat) return false;
    }
  }
  return true;
}

describe('move generation (property-based)', () => {
  it('equals the brute-force set of legal placements, for every seat, in random positions', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: 60 }), (seed, ply) => {
        const states = playRandomGame(seed);
        const state = states[Math.min(ply, states.length - 1)];
        for (const seat of SEATS) {
          const fast = positionOf(state).legalMoves(seat);
          expect(new Set(fast).size).toBe(fast.length); // no duplicates
          expect(new Set(fast)).toEqual(bruteForce(state, seat));
        }
      }),
      { numRuns: 12 },
    );
  });

  it('accepts exactly the generated moves when validating arbitrary placements', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 50 }),
        fc.array(
          fc.record({
            piece: fc.integer({ min: 0, max: PIECES.length - 1 }),
            o: fc.integer({ min: 0, max: 7 }),
            x: fc.integer({ min: -2, max: 21 }),
            y: fc.integer({ min: -2, max: 21 }),
          }),
          { minLength: 50, maxLength: 200 },
        ),
        (seed, ply, tries) => {
          const states = playRandomGame(seed);
          const state = states[Math.min(ply, states.length - 1)];
          if (state.status !== 'playing') return;
          const seat = state.turn;
          const legal = new Set(positionOf(state).legalMoves(seat));
          for (const t of tries) {
            const p = PIECES[t.piece];
            const err = validateAction(state, { type: 'place', seat, piece: p.id, o: t.o, x: t.x, y: t.y, n: state.n });
            const inRange = t.o < p.orientations.length && t.x >= 0 && t.y >= 0 && t.x < BOARD_SIZE && t.y < BOARD_SIZE;
            const isLegal = inRange && legal.has(encodeMove(t.piece, t.o, t.x, t.y));
            expect(err === null).toBe(isLegal);
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it('keeps the invariants through whole random games', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const states = playRandomGame(seed);
        for (const st of states) {
          expect(noOwnEdgeContact(st)).toBe(true);
          const used = st.history.filter((h) => h.type === 'place');
          for (const seat of SEATS) {
            const pieces = used.filter((h) => h.seat === seat).map((h) => h.piece);
            expect(new Set(pieces).size).toBe(pieces.length); // each piece at most once
          }
        }
        // Each seat's first piece covers its own corner.
        const end = states.at(-1)!;
        expect(end.board[0]).toBe('0');
        expect(end.board[19]).toBe('1');
        expect(end.board[399]).toBe('2');
        expect(end.board[380]).toBe('3');
      }),
      { numRuns: 15 },
    );
  });

  it('every generated action applies cleanly', () => {
    const state = playRandomGame(4242)[12];
    for (const action of legalActions(state, state.turn)) {
      const next = applyAction(state, action);
      expect(next.n).toBe(state.n + 1);
    }
  });
});
