/**
 * A mutable board position built for speed: typed arrays, incremental
 * updates and fast legal-move generation. The AI copies and mutates these;
 * the immutable GameState in game.ts builds one when it needs to.
 *
 * Moves are encoded as integers: ((piece * 8 + orientation) * 400) + cell,
 * where cell = y * 20 + x is the top-left of the orientation's bounding box.
 */

import {
  BOARD_SIZE,
  CELL_COUNT,
  DIAGONALS,
  ORTHOGONALS,
  SEAT_COUNT,
  START_CORNERS,
  START_CORNER_DIAGONAL,
  cellIndex,
  inBounds,
  type Seat,
} from './constants';
import { ALL_PIECES_MASK, PIECES, PIECE_COUNT } from './pieces';

export type MoveCode = number;

const ORIENT_SLOTS = 8;
const MOVE_SPACE = PIECE_COUNT * ORIENT_SLOTS * CELL_COUNT;

export function encodeMove(piece: number, o: number, x: number, y: number): MoveCode {
  return (piece * ORIENT_SLOTS + o) * CELL_COUNT + y * BOARD_SIZE + x;
}

export interface DecodedMove {
  piece: number;
  o: number;
  x: number;
  y: number;
}

export function decodeMove(code: MoveCode): DecodedMove {
  const cell = code % CELL_COUNT;
  const po = (code - cell) / CELL_COUNT;
  return { piece: Math.floor(po / ORIENT_SLOTS), o: po % ORIENT_SLOTS, x: cell % BOARD_SIZE, y: Math.floor(cell / BOARD_SIZE) };
}

export function movePiece(code: MoveCode): number {
  return Math.floor(code / (CELL_COUNT * ORIENT_SLOTS));
}

/** Absolute board cells covered by a move. */
export function moveCells(code: MoveCode): number[] {
  const m = decodeMove(code);
  const orient = PIECES[m.piece].orientations[m.o];
  return orient.cells.map(([cx, cy]) => cellIndex(m.x + cx, m.y + cy));
}

/** Flattened orientation data for the hot loops. */
interface FastOrientation {
  size: number;
  width: number;
  height: number;
  xs: Int8Array;
  ys: Int8Array;
  offsets: Int16Array; // y * 20 + x for each cell
  open: Uint8Array; // openDiagonals per cell
}

const FAST: FastOrientation[][] = PIECES.map((p) =>
  p.orientations.map((o) => ({
    size: o.cells.length,
    width: o.width,
    height: o.height,
    xs: Int8Array.from(o.cells.map((c) => c[0])),
    ys: Int8Array.from(o.cells.map((c) => c[1])),
    offsets: Int16Array.from(o.cells.map(([x, y]) => y * BOARD_SIZE + x)),
    open: Uint8Array.from(o.openDiagonals),
  })),
);

// Scratch marks for anchorDeltas.
const pieceMark = new Uint32Array(CELL_COUNT);
const nearMark = new Uint32Array(CELL_COUNT);
let markStamp = 0;

// Duplicate filter for move generation: a placement can be reached from
// several anchors, so each is stamped once per generation run.
const seen = new Uint32Array(MOVE_SPACE);
let stamp = 0;
function nextStamp(): number {
  stamp++;
  if (stamp === 0xffffffff) {
    seen.fill(0);
    stamp = 1;
  }
  return stamp;
}

export type PlacementProblem =
  | 'piece-used'
  | 'bad-orientation'
  | 'out-of-bounds'
  | 'overlap'
  | 'edge-contact'
  | 'must-cover-corner'
  | 'no-corner-contact';

export class Position {
  /** -1 for empty, otherwise the seat that owns the square. */
  readonly board: Int8Array;
  /** Per seat: 1 where that seat may not place (occupied, or shares an edge with its colour). */
  readonly forbidden: Uint8Array[];
  /** Per seat: bitmask of diagonal directions leading to a square of its colour. */
  readonly anchorDirs: Uint8Array[];
  /** Per seat: bitmask of pieces not yet placed. */
  readonly remaining: Int32Array;
  /** Per seat: squares placed so far. */
  readonly squares: Int32Array;
  /** Per seat: pieces placed so far. */
  readonly placed: Int32Array;

  private constructor(
    board: Int8Array,
    forbidden: Uint8Array[],
    anchorDirs: Uint8Array[],
    remaining: Int32Array,
    squares: Int32Array,
    placed: Int32Array,
  ) {
    this.board = board;
    this.forbidden = forbidden;
    this.anchorDirs = anchorDirs;
    this.remaining = remaining;
    this.squares = squares;
    this.placed = placed;
  }

  static empty(): Position {
    const remaining = new Int32Array(SEAT_COUNT).fill(ALL_PIECES_MASK);
    return new Position(
      new Int8Array(CELL_COUNT).fill(-1),
      Array.from({ length: SEAT_COUNT }, () => new Uint8Array(CELL_COUNT)),
      Array.from({ length: SEAT_COUNT }, () => new Uint8Array(CELL_COUNT)),
      remaining,
      new Int32Array(SEAT_COUNT),
      new Int32Array(SEAT_COUNT),
    );
  }

  clone(): Position {
    return new Position(
      this.board.slice(),
      this.forbidden.map((a) => a.slice()),
      this.anchorDirs.map((a) => a.slice()),
      this.remaining.slice(),
      this.squares.slice(),
      this.placed.slice(),
    );
  }

  hasPiece(seat: Seat, piece: number): boolean {
    return (this.remaining[seat] & (1 << piece)) !== 0;
  }

  /**
   * Bitmask of diagonal directions in which a piece covering `cell` could
   * touch the seat's colour (or the board edge, for the start corner).
   * Zero when the cell is not a legal anchor for the seat.
   */
  anchorMask(seat: Seat, cell: number): number {
    if (this.forbidden[seat][cell]) return 0;
    if (this.placed[seat] === 0) {
      const [cx, cy] = START_CORNERS[seat];
      return cell === cellIndex(cx, cy) ? 1 << START_CORNER_DIAGONAL[seat] : 0;
    }
    return this.anchorDirs[seat][cell];
  }

  anchorCount(seat: Seat): number {
    if (this.placed[seat] === 0) {
      const [cx, cy] = START_CORNERS[seat];
      return this.forbidden[seat][cellIndex(cx, cy)] ? 0 : 1;
    }
    const forb = this.forbidden[seat];
    const dirs = this.anchorDirs[seat];
    let n = 0;
    for (let c = 0; c < CELL_COUNT; c++) if (dirs[c] !== 0 && forb[c] === 0) n++;
    return n;
  }

  /**
   * The change in every seat's anchor count that playing `code` for `seat`
   * would cause, computed locally without playing it (much cheaper than
   * clone + place + anchorCount). Written into out[0..3].
   */
  anchorDeltas(seat: Seat, code: MoveCode, out: Int32Array | number[]): void {
    const m = decodeMove(code);
    const f = FAST[m.piece][m.o];
    markStamp++;
    if (markStamp === 0xffffffff) {
      pieceMark.fill(0);
      nearMark.fill(0);
      markStamp = 1;
    }
    const st = markStamp;
    for (let s = 0; s < SEAT_COUNT; s++) out[s] = 0;
    const first = this.placed[seat] === 0;
    for (let k = 0; k < f.size; k++) {
      const c = cellIndex(m.x + f.xs[k], m.y + f.ys[k]);
      pieceMark[c] = st;
      // Covered squares stop being anchors for everyone.
      for (let s = 0 as Seat; s < SEAT_COUNT; s = (s + 1) as Seat) if (this.anchorMask(s, c)) out[s]--;
    }
    const forb = this.forbidden[seat];
    const dirs = this.anchorDirs[seat];
    for (let k = 0; k < f.size; k++) {
      const px = m.x + f.xs[k];
      const py = m.y + f.ys[k];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ax = px + dx;
          const ay = py + dy;
          if (!inBounds(ax, ay)) continue;
          const a = cellIndex(ax, ay);
          if (pieceMark[a] === st || nearMark[a] === st) continue;
          nearMark[a] = st;
          const before = !first && this.anchorMask(seat, a) !== 0 ? 1 : 0;
          let blocked = forb[a] !== 0;
          let diag = !first && dirs[a] !== 0;
          for (let i = 0; i < 4 && !blocked; i++) {
            const nx = ax + ORTHOGONALS[i][0];
            const ny = ay + ORTHOGONALS[i][1];
            if (inBounds(nx, ny) && pieceMark[cellIndex(nx, ny)] === st) blocked = true;
          }
          for (let i = 0; i < 4 && !diag; i++) {
            const nx = ax + DIAGONALS[i][0];
            const ny = ay + DIAGONALS[i][1];
            if (inBounds(nx, ny) && pieceMark[cellIndex(nx, ny)] === st) diag = true;
          }
          out[seat] += (!blocked && diag ? 1 : 0) - before;
        }
      }
    }
  }

  /** Places a piece without checking it. Use validate() or legalMoves() first. */
  place(seat: Seat, piece: number, o: number, x: number, y: number): void {
    const f = FAST[piece][o];
    const board = this.board;
    const own = this.forbidden[seat];
    const dirs = this.anchorDirs[seat];
    for (let k = 0; k < f.size; k++) {
      const c = cellIndex(x + f.xs[k], y + f.ys[k]);
      board[c] = seat;
      for (let s = 0; s < SEAT_COUNT; s++) this.forbidden[s][c] = 1;
    }
    for (let k = 0; k < f.size; k++) {
      const px = x + f.xs[k];
      const py = y + f.ys[k];
      for (let i = 0; i < 4; i++) {
        const nx = px + ORTHOGONALS[i][0];
        const ny = py + ORTHOGONALS[i][1];
        if (inBounds(nx, ny)) own[cellIndex(nx, ny)] = 1;
      }
      for (let d = 0; d < 4; d++) {
        const nx = px + DIAGONALS[d][0];
        const ny = py + DIAGONALS[d][1];
        // Seen from the neighbour, this square lies in the opposite direction.
        if (inBounds(nx, ny)) dirs[cellIndex(nx, ny)] |= 1 << ((d + 2) & 3);
      }
    }
    this.remaining[seat] &= ~(1 << piece);
    this.squares[seat] += f.size;
    this.placed[seat]++;
  }

  placeCode(seat: Seat, code: MoveCode): void {
    const m = decodeMove(code);
    this.place(seat, m.piece, m.o, m.x, m.y);
  }

  /**
   * Checks a placement from first principles (independently of the anchor
   * bookkeeping used by move generation). Returns null when it is legal.
   */
  validate(seat: Seat, piece: number, o: number, x: number, y: number): PlacementProblem | null {
    if (piece < 0 || piece >= PIECE_COUNT || !this.hasPiece(seat, piece)) return 'piece-used';
    const orients = PIECES[piece].orientations;
    if (!Number.isInteger(o) || o < 0 || o >= orients.length) return 'bad-orientation';
    const cells = orients[o].cells.map(([cx, cy]) => [x + cx, y + cy] as const);
    for (const [px, py] of cells) if (!inBounds(px, py)) return 'out-of-bounds';
    for (const [px, py] of cells) if (this.board[cellIndex(px, py)] !== -1) return 'overlap';
    const ownAt = (px: number, py: number) => inBounds(px, py) && this.board[cellIndex(px, py)] === seat;
    for (const [px, py] of cells) {
      for (const [dx, dy] of ORTHOGONALS) if (ownAt(px + dx, py + dy)) return 'edge-contact';
    }
    if (this.placed[seat] === 0) {
      const [cx, cy] = START_CORNERS[seat];
      return cells.some(([px, py]) => px === cx && py === cy) ? null : 'must-cover-corner';
    }
    for (const [px, py] of cells) {
      for (const [dx, dy] of DIAGONALS) if (ownAt(px + dx, py + dy)) return null;
    }
    return 'no-corner-contact';
  }

  /** Every distinct legal placement for the seat. */
  legalMoves(seat: Seat): MoveCode[] {
    const out: MoveCode[] = [];
    this.generate(seat, out, false);
    return out;
  }

  /** Legal placements of one piece only. */
  legalMovesForPiece(seat: Seat, piece: number): MoveCode[] {
    const out: MoveCode[] = [];
    this.generate(seat, out, false, 1 << piece);
    return out;
  }

  hasMove(seat: Seat): boolean {
    return this.generate(seat, null, true) > 0;
  }

  countMoves(seat: Seat): number {
    return this.generate(seat, null, false);
  }

  private generate(seat: Seat, out: MoveCode[] | null, stopAtFirst: boolean, pieceFilter = -1): number {
    const rem = this.remaining[seat] & pieceFilter;
    if (rem === 0) return 0;
    const forb = this.forbidden[seat];
    const st = stopAtFirst ? 0 : nextStamp();
    let count = 0;
    for (let c = 0; c < CELL_COUNT; c++) {
      const mask = this.anchorMask(seat, c);
      if (mask === 0) continue;
      const ax = c % BOARD_SIZE;
      const ay = (c - ax) / BOARD_SIZE;
      for (let p = 0; p < PIECE_COUNT; p++) {
        if ((rem & (1 << p)) === 0) continue;
        const orients = FAST[p];
        for (let o = 0; o < orients.length; o++) {
          const f = orients[o];
          for (let k = 0; k < f.size; k++) {
            if ((f.open[k] & mask) === 0) continue;
            const x0 = ax - f.xs[k];
            const y0 = ay - f.ys[k];
            if (x0 < 0 || y0 < 0 || x0 + f.width > BOARD_SIZE || y0 + f.height > BOARD_SIZE) continue;
            const base = y0 * BOARD_SIZE + x0;
            const id = (p * ORIENT_SLOTS + o) * CELL_COUNT + base;
            if (!stopAtFirst) {
              if (seen[id] === st) continue;
              seen[id] = st;
            }
            let ok = true;
            for (let j = 0; j < f.size; j++) {
              if (forb[base + f.offsets[j]]) {
                ok = false;
                break;
              }
            }
            if (!ok) continue;
            count++;
            if (stopAtFirst) return count;
            if (out) out.push(id);
          }
        }
      }
    }
    return count;
  }
}
