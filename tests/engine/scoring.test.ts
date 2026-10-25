import { describe, expect, it } from 'vitest';
import {
  ALL_PIECES_MASK,
  PIECES,
  SEATS,
  TOTAL_SQUARES,
  newGame,
  pieceById,
  scoreGame,
  scoreSeat,
  squaresInMask,
  type GameState,
  type PieceId,
} from '../../src/engine';
import { playRandomGame } from '../helpers';

function only(...ids: PieceId[]): number {
  return ids.reduce((m, id) => m | (1 << pieceById(id).index), 0);
}

function withInventories(remaining: number[], last: (PieceId | null)[]): GameState {
  return { ...newGame(), status: 'over', remaining, last, out: [true, true, true, true] };
}

describe('scoring', () => {
  it('starts every seat at −89', () => {
    const score = scoreGame(newGame());
    expect(score.seats.map((s) => s.score)).toEqual([-89, -89, -89, -89]);
    expect(score.teams).toEqual([-178, -178]);
    expect(score.leader).toBeNull();
  });

  it('subtracts one point per unplayed square', () => {
    const s = withInventories([only('I5', 'V3'), only('I1'), only('X5', 'O4', 'I2'), ALL_PIECES_MASK], [null, null, null, null]);
    expect(scoreSeat(s, 0).score).toBe(-8);
    expect(scoreSeat(s, 1).score).toBe(-1);
    expect(scoreSeat(s, 2).score).toBe(-11);
    expect(scoreSeat(s, 3).score).toBe(-89);
    expect(scoreSeat(s, 2).piecesLeft).toBe(3);
  });

  it('awards +15 for placing all 21 pieces, +5 more when the monomino went last', () => {
    const s = withInventories([0, 0, only('I1'), 0], ['I1', 'Z5', 'X5', 'I1']);
    expect(scoreSeat(s, 0)).toMatchObject({ score: 20, allPlaced: true, monominoLast: true });
    expect(scoreSeat(s, 1)).toMatchObject({ score: 15, allPlaced: true, monominoLast: false });
    expect(scoreSeat(s, 2)).toMatchObject({ score: -1, allPlaced: false, monominoLast: false });
    expect(scoreSeat(s, 3).score).toBe(20);
  });

  it('adds the two seats of each team', () => {
    const s = withInventories([0, only('I5'), only('I1'), 0], ['I1', 'L4', 'X5', 'T4']);
    const score = scoreGame(s);
    // Team 0 = seats 0 and 2: 20 + (−1). Team 1 = seats 1 and 3: −5 + 15.
    expect(score.teams).toEqual([19, 10]);
    expect(score.leader).toBe(0);
  });

  it('reports a tie when the totals are equal', () => {
    const s = withInventories([only('I2'), only('I1'), only('I1'), only('I2')], [null, null, null, null]);
    expect(scoreGame(s).teams).toEqual([-3, -3]);
    expect(scoreGame(s).leader).toBeNull();
  });

  it('matches the squares left on the board in finished games', () => {
    for (let seed = 200; seed < 210; seed++) {
      const end = playRandomGame(seed).at(-1)!;
      const score = scoreGame(end);
      for (const seat of SEATS) {
        const onBoard = end.board.split('').filter((c) => c === String(seat)).length;
        expect(onBoard).toBe(TOTAL_SQUARES - squaresInMask(end.remaining[seat]));
        const expected = end.remaining[seat] === 0 ? (end.last[seat] === 'I1' ? 20 : 15) : -(TOTAL_SQUARES - onBoard);
        expect(score.seats[seat].score).toBe(expected);
      }
      expect(score.teams[0]).toBe(score.seats[0].score + score.seats[2].score);
      expect(score.teams[1]).toBe(score.seats[1].score + score.seats[3].score);
    }
  });

  it('counts squares in masks correctly', () => {
    expect(squaresInMask(ALL_PIECES_MASK)).toBe(89);
    expect(squaresInMask(0)).toBe(0);
    for (const p of PIECES) expect(squaresInMask(1 << p.index)).toBe(p.size);
  });
});
