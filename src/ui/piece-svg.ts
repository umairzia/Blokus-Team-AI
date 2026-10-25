/** Small SVG drawings of pieces for the tray and the inventories. */

import type { Seat } from '../engine/constants';
import type { Cell } from '../engine/pieces';

const NS = 'http://www.w3.org/2000/svg';

/** Draws cells centred in a square box of `box` units (5 fits every piece). */
export function pieceSvg(cells: readonly Cell[], seat: Seat, box = 5): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  let w = 0;
  let h = 0;
  for (const [x, y] of cells) {
    w = Math.max(w, x + 1);
    h = Math.max(h, y + 1);
  }
  const size = Math.max(box, w, h);
  const ox = (size - w) / 2;
  const oy = (size - h) / 2;
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', `mini pc${seat}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [x, y] of cells) {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', String(ox + x + 0.06));
    r.setAttribute('y', String(oy + y + 0.06));
    r.setAttribute('width', '0.88');
    r.setAttribute('height', '0.88');
    r.setAttribute('rx', '0.12');
    svg.append(r);
  }
  return svg;
}
