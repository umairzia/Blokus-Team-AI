import { describe, expect, it } from 'vitest';
import { LEVELS, chooseAction, type Level } from '../../src/ai/decide';
import { territory } from '../../src/ai/evaluate';
import { lineup, playMatch } from '../../src/ai/match';
import { createInlineRunner } from '../../src/ai/runner';
import {
  SEATS,
  applyAction,
  inBounds,
  newGame,
  pieceById,
  positionOf,
  validateAction,
  type GameState,
  type PieceId,
  type Seat,
} from '../../src/engine';
import { craft, orientationOf, playRandomGame } from '../helpers';

const I5 = orientationOf('I5', '#####');

/** Seat 0 is walled in (see the engine tests): it has no legal move. */
function trapped(): GameState {
  return craft(
    [
      [0, 'I1', 0, 0, 0],
      [1, 'I5', I5, 15, 0],
      [1, 'I4', orientationOf('I4', '####'), 11, 1],
      [1, 'I3', orientationOf('I3', '###'), 8, 2],
      [1, 'I2', orientationOf('I2', '##'), 6, 3],
      [1, 'L5', orientationOf('L5', '####\n#...'), 2, 2],
      [1, 'I1', 0, 1, 1],
    ],
    0,
  );
}

/** Plays a whole game with every seat at `level`, checking each AI decision. */
function checkedGame(level: Level, seed: number): { end: GameState; maxMs: number } {
  let state = newGame();
  let maxMs = 0;
  const used: Set<PieceId>[] = SEATS.map(() => new Set());
  while (state.status === 'playing') {
    const seat = state.turn;
    const d = chooseAction(state, seat, { level, seed: seed * 10 + seat });
    maxMs = Math.max(maxMs, d.elapsedMs);
    expect(validateAction(state, d.action)).toBeNull();
    expect(d.action.seat).toBe(seat);
    if (d.action.type === 'place') {
      const a = d.action;
      expect(used[seat].has(a.piece)).toBe(false);
      used[seat].add(a.piece);
      for (const [cx, cy] of pieceById(a.piece).orientations[a.o].cells) expect(inBounds(a.x + cx, a.y + cy)).toBe(true);
    }
    state = applyAction(state, d.action);
  }
  return { end: state, maxMs };
}

describe('AI decisions', () => {
  it.each(LEVELS)('%s plays only legal moves through complete games', (level) => {
    for (const seed of [1, 2]) {
      const { end } = checkedGame(level, seed);
      expect(end.status).toBe('over');
      for (const seat of SEATS) expect(positionOf(end).hasMove(seat)).toBe(false);
    }
  });

  it.each(LEVELS)('%s passes when no legal move exists', (level) => {
    const s = trapped();
    const d = chooseAction(s, 0, { level, seed: 5 });
    expect(d.action).toEqual({ type: 'pass', seat: 0, n: s.n });
    expect(validateAction(s, d.action)).toBeNull();
  });

  it.each(LEVELS)('%s is reproducible for the same seed and state', (level) => {
    const states = playRandomGame(77);
    for (const st of [states[0], states[9], states[30]]) {
      const a = chooseAction(st, st.turn, { level, seed: 123 });
      const b = chooseAction(st, st.turn, { level, seed: 123 });
      expect(a.action).toEqual(b.action);
    }
  });

  it('easy varies with the seed (it is meant to be imperfect)', () => {
    const st = playRandomGame(5)[8];
    const picks = new Set<string>();
    for (let seed = 0; seed < 20; seed++) picks.add(JSON.stringify(chooseAction(st, st.turn, { level: 'easy', seed }).action));
    expect(picks.size).toBeGreaterThan(1);
  });

  it.each(LEVELS)('%s decides within its time budget', (level) => {
    const budget = { easy: 400, normal: 1200, hard: 2500 }[level];
    const { maxMs } = checkedGame(level, 3);
    expect(maxMs).toBeLessThan(budget);
  });

  it('hard stops at the time cap and still returns a legal move', () => {
    const st = playRandomGame(11)[12];
    let t = 0;
    // A clock that jumps 1 s per reading: the cap is passed after the first candidate.
    const d = chooseAction(st, st.turn, { level: 'hard', seed: 1, timeLimitMs: 50, now: () => (t += 1000) });
    expect(d.timedOut).toBe(true);
    expect(validateAction(st, d.action)).toBeNull();
  });

  it('takes a starting move that covers its own corner', () => {
    let s = newGame();
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const d = chooseAction(s, seat, { level: 'hard', seed: 9 });
      s = applyAction(s, d.action);
    }
    expect([s.board[0], s.board[19], s.board[399], s.board[380]]).toEqual(['0', '1', '2', '3']);
  });

  it('prefers big pieces early', () => {
    const d = chooseAction(newGame(), 0, { level: 'normal', seed: 1 });
    expect(d.action.type === 'place' && pieceById(d.action.piece).size).toBe(5);
  });

  it('runs through the inline runner', async () => {
    const runner = createInlineRunner();
    const st = playRandomGame(3)[4];
    const d = await runner.decide(st, st.turn, 'normal', 1);
    expect(validateAction(st, d.action)).toBeNull();
    runner.dispose();
  });
});

describe('evaluation features', () => {
  it('splits the empty board evenly between the four corners', () => {
    const out = [0, 0, 0, 0];
    territory(positionOf(newGame()), out);
    expect(out[0]).toBeGreaterThan(50);
    expect(new Set(out).size).toBe(1);
  });

  it('local anchor deltas equal the real change after placing', () => {
    for (const seed of [21, 22, 23]) {
      for (const st of playRandomGame(seed).filter((_, i) => i % 7 === 0)) {
        if (st.status !== 'playing') continue;
        const pos = positionOf(st);
        const seat = st.turn;
        const before = SEATS.map((s) => pos.anchorCount(s));
        const delta = [0, 0, 0, 0];
        for (const code of pos.legalMoves(seat).slice(0, 60)) {
          pos.anchorDeltas(seat, code, delta);
          const p = pos.clone();
          p.placeCode(seat, code);
          expect(SEATS.map((s) => p.anchorCount(s) - before[s])).toEqual(delta);
        }
      }
    }
  });
});

describe('strength (small deterministic paired series)', () => {
  // The full experiment is `npm run ai:eval` (see docs/AI_EVALUATION.md). This
  // short series is deterministic, so it guards against regressions without
  // being flaky; on its own it is too small to support a strength claim.
  function pairedMargin(a: Level, b: Level, seeds: number[]): number {
    let total = 0;
    for (const seed of seeds) {
      const g1 = playMatch({ players: lineup({ level: a }, { level: b }), seed, randomOpeningPlies: 4 });
      const g2 = playMatch({ players: lineup({ level: b }, { level: a }), seed, randomOpeningPlies: 4 });
      total += g1.score.teams[0] - g1.score.teams[1] + (g2.score.teams[1] - g2.score.teams[0]);
    }
    return total / (2 * seeds.length);
  }

  it('hard outscores normal over paired games', () => {
    expect(pairedMargin('hard', 'normal', [501, 502, 503, 504])).toBeGreaterThan(0);
  });

  it('normal outscores easy over paired games', () => {
    expect(pairedMargin('normal', 'easy', [601, 602, 603, 604])).toBeGreaterThan(0);
  });
});
