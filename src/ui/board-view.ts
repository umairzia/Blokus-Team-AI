/**
 * The 20 × 20 board: 400 cells whose classes are updated in place (only the
 * cells that change are touched). Pointer, touch and keyboard input are
 * reported to the app as cell indexes.
 */

import { BOARD_SIZE, CELL_COUNT, START_CORNERS, cellIndex, type Seat } from '../engine/constants';

export interface Preview {
  readonly cells: readonly number[];
  readonly ok: boolean;
  readonly seat: Seat;
  readonly pinned: boolean;
}

export interface BoardHandlers {
  onHover(cell: number | null): void;
  onActivate(cell: number, pointerType: string): void;
  onKey(e: KeyboardEvent): void;
}

export interface BoardModel {
  readonly board: string;
  readonly last: ReadonlySet<number>;
  /** Seats that have not placed yet (their start corner is marked). */
  readonly unstarted: readonly Seat[];
  readonly preview: Preview | null;
  readonly hints: ReadonlySet<number>;
  /** Corner anchors to mark, and in which seat's colour. */
  readonly anchors: ReadonlySet<number>;
  readonly anchorSeat: Seat | null;
  readonly cursor: number | null;
}

export class BoardView {
  readonly root: HTMLElement;
  private readonly cells: HTMLElement[] = [];
  private readonly classes: string[] = new Array(CELL_COUNT).fill('');
  private pointerType = 'mouse';

  constructor(root: HTMLElement, handlers: BoardHandlers) {
    this.root = root;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < CELL_COUNT; i++) {
      const c = document.createElement('div');
      c.className = 'cell';
      c.dataset.i = String(i);
      this.cells.push(c);
      frag.append(c);
    }
    root.append(frag);
    const cellOf = (e: Event): number | null => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('.cell');
      return t && t.dataset.i !== undefined ? Number(t.dataset.i) : null;
    };
    root.addEventListener('pointerdown', (e) => {
      this.pointerType = e.pointerType || 'mouse';
    });
    root.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') handlers.onHover(cellOf(e));
    });
    root.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') handlers.onHover(null);
    });
    root.addEventListener('click', (e) => {
      const i = cellOf(e);
      if (i !== null) handlers.onActivate(i, this.pointerType);
    });
    root.addEventListener('keydown', (e) => handlers.onKey(e));
  }

  render(m: BoardModel): void {
    const preview = new Map<number, Preview>();
    if (m.preview) for (const c of m.preview.cells) preview.set(c, m.preview);
    const starts = new Map<number, Seat>();
    for (const s of m.unstarted) {
      const [x, y] = START_CORNERS[s];
      starts.set(cellIndex(x, y), s);
    }
    for (let i = 0; i < CELL_COUNT; i++) {
      const owner = m.board[i];
      let cls = 'cell';
      if (owner !== '.') cls += ` p${owner}`;
      else if (starts.has(i)) cls += ` start-${starts.get(i)}`;
      if (m.last.has(i)) cls += ' last';
      const p = preview.get(i);
      if (p) cls += ` pv pc${p.seat} ${p.ok ? 'ok' : 'bad'}${p.pinned ? ' pinned' : ''}`;
      if (owner === '.' && !p) {
        if (m.hints.has(i)) cls += ' hint';
        else if (m.anchors.has(i) && m.anchorSeat !== null && !starts.has(i)) cls += ` anchor start-${m.anchorSeat}`;
      }
      if (m.cursor === i) cls += ' cursor';
      if (cls !== this.classes[i]) {
        this.classes[i] = cls;
        this.cells[i].className = cls;
      }
    }
  }

  static coords(cell: number): string {
    const x = cell % BOARD_SIZE;
    const y = Math.floor(cell / BOARD_SIZE);
    return `column ${x + 1}, row ${y + 1}`;
  }
}
