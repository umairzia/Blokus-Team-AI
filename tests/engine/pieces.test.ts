import { describe, expect, it } from 'vitest';
import {
  ALL_PIECES_MASK,
  PIECES,
  PIECE_IDS,
  TOTAL_SQUARES,
  cellsKey,
  flipCells,
  normalizeCells,
  orientationIndexOf,
  pieceById,
  rotateCells,
  uniqueOrientations,
  type Cell,
} from '../../src/engine';

/** Canonical form of a free polyomino: the smallest key over all 8 transforms. */
function freeKey(cells: readonly Cell[]): string {
  return uniqueOrientations(cells)
    .map((o) => o.key)
    .sort()[0];
}

function isEdgeConnected(cells: readonly Cell[]): boolean {
  const keys = new Set(cells.map(([x, y]) => `${x},${y}`));
  const start = cells[0];
  const seen = new Set([`${start[0]},${start[1]}`]);
  const queue: Cell[] = [start];
  while (queue.length) {
    const [x, y] = queue.pop()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const k = `${x + dx},${y + dy}`;
      if (keys.has(k) && !seen.has(k)) {
        seen.add(k);
        queue.push([x + dx, y + dy]);
      }
    }
  }
  return seen.size === cells.length;
}

describe('piece set', () => {
  it('has the 21 standard pieces', () => {
    expect(PIECES).toHaveLength(21);
    expect(new Set(PIECE_IDS).size).toBe(21);
    expect(ALL_PIECES_MASK.toString(2)).toBe('1'.repeat(21));
  });

  it('has 1 monomino, 1 domino, 2 trominoes, 5 tetrominoes and 12 pentominoes (89 squares)', () => {
    const bySize = [1, 2, 3, 4, 5].map((n) => PIECES.filter((p) => p.size === n).length);
    expect(bySize).toEqual([1, 1, 2, 5, 12]);
    expect(TOTAL_SQUARES).toBe(89);
  });

  it('pieces are edge-connected and pairwise different shapes', () => {
    const keys = new Set<string>();
    for (const p of PIECES) {
      expect(isEdgeConnected(p.orientations[0].cells), p.id).toBe(true);
      keys.add(freeKey(p.orientations[0].cells));
    }
    expect(keys.size).toBe(21);
  });

  it('declares the right size in each id', () => {
    for (const p of PIECES) expect(p.size, p.id).toBe(Number(p.id[1]));
  });

  it('has the expected number of distinct orientations (91 in total)', () => {
    const expected: Record<string, number> = {
      I1: 1, I2: 2, I3: 2, V3: 4, I4: 2, L4: 8, T4: 4, O4: 1, Z4: 4,
      F5: 8, I5: 2, L5: 8, N5: 8, P5: 8, T5: 4, U5: 4, V5: 4, W5: 4, X5: 1, Y5: 8, Z5: 4,
    };
    for (const p of PIECES) expect(p.orientations.length, p.id).toBe(expected[p.id]);
    expect(PIECES.reduce((n, p) => n + p.orientations.length, 0)).toBe(91);
  });
});

describe('orientations', () => {
  it('preserve the cell count and the shape', () => {
    for (const p of PIECES) {
      const shape = freeKey(p.orientations[0].cells);
      for (const o of p.orientations) {
        expect(o.cells.length).toBe(p.size);
        expect(new Set(o.cells.map((c) => `${c[0]},${c[1]}`)).size).toBe(p.size);
        expect(freeKey(o.cells)).toBe(shape);
        expect(isEdgeConnected(o.cells)).toBe(true);
      }
    }
  });

  it('are normalised to the top-left with correct bounding boxes', () => {
    for (const p of PIECES) {
      for (const o of p.orientations) {
        expect(Math.min(...o.cells.map((c) => c[0]))).toBe(0);
        expect(Math.min(...o.cells.map((c) => c[1]))).toBe(0);
        expect(o.width).toBe(Math.max(...o.cells.map((c) => c[0])) + 1);
        expect(o.height).toBe(Math.max(...o.cells.map((c) => c[1])) + 1);
        expect(o.key).toBe(cellsKey(o.cells));
      }
    }
  });

  it('are never duplicated', () => {
    for (const p of PIECES) expect(new Set(p.orientations.map((o) => o.key)).size).toBe(p.orientations.length);
  });

  it('rotating four times or flipping twice gives the original', () => {
    for (const p of PIECES) {
      for (const o of p.orientations) {
        let c = normalizeCells(o.cells);
        for (let i = 0; i < 4; i++) c = rotateCells(c);
        expect(cellsKey(c)).toBe(o.key);
        expect(cellsKey(flipCells(flipCells(o.cells)))).toBe(o.key);
      }
    }
  });

  it('every rotation or reflection maps to one of the listed orientations', () => {
    for (const p of PIECES) {
      for (const o of p.orientations) {
        expect(orientationIndexOf(p.id, rotateCells(o.cells))).toBeGreaterThanOrEqual(0);
        expect(orientationIndexOf(p.id, flipCells(o.cells))).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('does not accept the shape of a different piece', () => {
    expect(orientationIndexOf('L4', pieceById('T4').orientations[0].cells)).toBe(-1);
    expect(orientationIndexOf('I5', pieceById('I4').orientations[0].cells)).toBe(-1);
  });

  it('marks outer corners of each cell correctly', () => {
    // The monomino is open in all four diagonal directions.
    expect(pieceById('I1').orientations[0].openDiagonals).toEqual([0b1111]);
    // The centre of the X pentomino has no outer corner; each arm has two.
    const x = pieceById('X5').orientations[0];
    const centre = x.cells.findIndex(([cx, cy]) => cx === 1 && cy === 1);
    expect(x.openDiagonals[centre]).toBe(0);
    for (let i = 0; i < x.cells.length; i++) if (i !== centre) expect(x.openDiagonals[i].toString(2).replace(/0/g, '').length).toBe(2);
  });
});
