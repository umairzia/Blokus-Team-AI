/**
 * The 21 Blokus pieces and their orientations.
 *
 * Each piece is drawn as ASCII art ('#' = square). Its orientations are the
 * 8 rotations and reflections, each normalised so its top-left bounding-box
 * corner is (0, 0) and its cells are sorted, then de-duplicated by that
 * canonical form. Symmetric pieces therefore have fewer than 8 orientations
 * (91 across the set), and two placements are the same move exactly when
 * they share piece, orientation index and position.
 */

import { DIAGONALS } from './constants';

export const PIECE_IDS = [
  'I1',
  'I2',
  'I3',
  'V3',
  'I4',
  'L4',
  'T4',
  'O4',
  'Z4',
  'F5',
  'I5',
  'L5',
  'N5',
  'P5',
  'T5',
  'U5',
  'V5',
  'W5',
  'X5',
  'Y5',
  'Z5',
] as const;

export type PieceId = (typeof PIECE_IDS)[number];
export const PIECE_COUNT = PIECE_IDS.length;

const SHAPES: Record<PieceId, { name: string; art: string }> = {
  I1: { name: 'Monomino', art: '#' },
  I2: { name: 'Domino', art: '##' },
  I3: { name: 'Straight tromino', art: '###' },
  V3: { name: 'Corner tromino', art: '#.\n##' },
  I4: { name: 'Straight tetromino', art: '####' },
  L4: { name: 'L tetromino', art: '#..\n###' },
  T4: { name: 'T tetromino', art: '###\n.#.' },
  O4: { name: 'Square tetromino', art: '##\n##' },
  Z4: { name: 'S tetromino', art: '##.\n.##' },
  F5: { name: 'F pentomino', art: '.##\n##.\n.#.' },
  I5: { name: 'I pentomino', art: '#####' },
  L5: { name: 'L pentomino', art: '#...\n####' },
  N5: { name: 'N pentomino', art: '##..\n.###' },
  P5: { name: 'P pentomino', art: '##\n##\n#.' },
  T5: { name: 'T pentomino', art: '###\n.#.\n.#.' },
  U5: { name: 'U pentomino', art: '#.#\n###' },
  V5: { name: 'V pentomino', art: '#..\n#..\n###' },
  W5: { name: 'W pentomino', art: '#..\n##.\n.##' },
  X5: { name: 'X pentomino', art: '.#.\n###\n.#.' },
  Y5: { name: 'Y pentomino', art: '.#..\n####' },
  Z5: { name: 'Z pentomino', art: '##.\n.#.\n.##' },
};

export type Cell = readonly [number, number];

export interface Orientation {
  /** Cells relative to the top-left of the bounding box, sorted by (y, x). */
  readonly cells: readonly Cell[];
  readonly width: number;
  readonly height: number;
  /** Canonical form, e.g. "0,0;1,0;1,1". Equal keys = identical shapes. */
  readonly key: string;
  /**
   * For each cell, a bitmask of the diagonal directions (see DIAGONALS) in
   * which the cell is a true outer corner: the diagonal neighbour and both
   * edge neighbours towards it are outside the piece. Only such a cell can
   * be the one that touches the same colour at a corner.
   */
  readonly openDiagonals: readonly number[];
}

export interface PieceDef {
  readonly id: PieceId;
  readonly index: number;
  readonly name: string;
  readonly size: number;
  readonly orientations: readonly Orientation[];
}

function parseArt(art: string): Cell[] {
  const cells: Cell[] = [];
  art.split('\n').forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') cells.push([x, y]);
  });
  return cells;
}

/** Translates cells to the origin and sorts them; returns a new array. */
export function normalizeCells(cells: readonly Cell[]): Cell[] {
  let minX = Infinity;
  let minY = Infinity;
  for (const [x, y] of cells) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }
  return cells
    .map(([x, y]) => [x - minX, y - minY] as Cell)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

export function cellsKey(cells: readonly Cell[]): string {
  return normalizeCells(cells)
    .map(([x, y]) => `${x},${y}`)
    .join(';');
}

/** Rotates 90° clockwise on screen (y grows downwards). */
export function rotateCells(cells: readonly Cell[]): Cell[] {
  return normalizeCells(cells.map(([x, y]) => [-y, x] as Cell));
}

/** Mirrors left-right. */
export function flipCells(cells: readonly Cell[]): Cell[] {
  return normalizeCells(cells.map(([x, y]) => [-x, y] as Cell));
}

function makeOrientation(cells: readonly Cell[]): Orientation {
  const norm = normalizeCells(cells);
  const has = new Set(norm.map(([x, y]) => `${x},${y}`));
  const inPiece = (x: number, y: number) => has.has(`${x},${y}`);
  let width = 0;
  let height = 0;
  for (const [x, y] of norm) {
    width = Math.max(width, x + 1);
    height = Math.max(height, y + 1);
  }
  const openDiagonals = norm.map(([x, y]) => {
    let mask = 0;
    DIAGONALS.forEach(([dx, dy], d) => {
      if (!inPiece(x + dx, y + dy) && !inPiece(x + dx, y) && !inPiece(x, y + dy)) mask |= 1 << d;
    });
    return mask;
  });
  return { cells: norm, width, height, key: cellsKey(norm), openDiagonals };
}

/**
 * All distinct orientations, in a fixed order: rotations 0-3 of the shape as
 * drawn, then rotations 0-3 of its mirror image, skipping repeats.
 */
export function uniqueOrientations(cells: readonly Cell[]): Orientation[] {
  const out: Orientation[] = [];
  const seen = new Set<string>();
  let current = normalizeCells(cells);
  for (let flip = 0; flip < 2; flip++) {
    for (let rot = 0; rot < 4; rot++) {
      const o = makeOrientation(current);
      if (!seen.has(o.key)) {
        seen.add(o.key);
        out.push(o);
      }
      current = rotateCells(current);
    }
    current = flipCells(current);
  }
  return out;
}

export const PIECES: readonly PieceDef[] = PIECE_IDS.map((id, index) => {
  const cells = parseArt(SHAPES[id].art);
  return {
    id,
    index,
    name: SHAPES[id].name,
    size: cells.length,
    orientations: uniqueOrientations(cells),
  };
});

const BY_ID = new Map<string, PieceDef>(PIECES.map((p) => [p.id, p]));

export function isPieceId(value: unknown): value is PieceId {
  return typeof value === 'string' && BY_ID.has(value);
}

export function pieceById(id: PieceId): PieceDef {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`Unknown piece ${id}`);
  return p;
}

/** Bitmask with every piece available. */
export const ALL_PIECES_MASK = (1 << PIECE_COUNT) - 1;

export const TOTAL_SQUARES = PIECES.reduce((sum, p) => sum + p.size, 0);

/** Squares in the pieces of a remaining-pieces bitmask. */
export function squaresInMask(mask: number): number {
  let total = 0;
  for (let i = 0; i < PIECE_COUNT; i++) if (mask & (1 << i)) total += PIECES[i].size;
  return total;
}

export function piecesInMask(mask: number): PieceDef[] {
  return PIECES.filter((p) => mask & (1 << p.index));
}

/** The orientation index whose shape equals `cells`, or -1. */
export function orientationIndexOf(id: PieceId, cells: readonly Cell[]): number {
  const key = cellsKey(cells);
  return pieceById(id).orientations.findIndex((o) => o.key === key);
}
