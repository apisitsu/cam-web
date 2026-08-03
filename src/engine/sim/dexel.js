/**
 * Phase 1 — material removal simulation (Z-heightmap dexel field).
 *
 * cam_web.txt §4 calls for a "multi-dexel" model. A full multi-dexel stores
 * several solid intervals per column (needed for undercuts / 5-axis). For
 * 3-axis milling the pragmatic first cut is a *single* top-down dexel per XY
 * cell — i.e. a height field: each cell records the top Z of remaining stock.
 * It is fast, allocation-light, trivially renderable as a grid mesh, and
 * correct for anything a 3-axis endmill can reach. Undercuts are the documented
 * upgrade path to true multi-dexel.
 *
 * The engine is pure JS (no three / no DOM) so it runs and tests under Node,
 * exactly like the Phase 0 G-code engine.
 */
import { billetBox } from './billet.js';
import { profileRise } from '../cam/cutters.js';

/**
 * @typedef {Object} Tool
 * @property {number} radius   cutter radius (mm)
 * @property {'flat'|'ball'} [type]  endmill profile (default 'flat')
 */

/** Create a rectangular block of stock discretised into an nx×ny height grid. */
export function createStock({ xMin, yMin, xMax, yMax, top, base = top - 10, cellSize = 1 }) {
  const nx = Math.max(1, Math.ceil((xMax - xMin) / cellSize));
  const ny = Math.max(1, Math.ceil((yMax - yMin) / cellSize));
  const heights = new Float32Array(nx * ny).fill(top);
  // `base` is the solid bottom of the billet (used only for rendering a closed box).
  return { xMin, yMin, xMax, yMax, top, base: Math.min(base, top - 0.001), cellSize, nx, ny, heights };
}

/** Reset a stock's height field back to its original solid top (for scrubbing back). */
export function resetStock(stock) {
  stock.heights.fill(stock.top);
}

/**
 * Build a stock block for a toolpath.
 *
 * `size` is the operator's billet — X × Y × Z in mm — and `origin` is its
 * minimum corner in work coordinates; see `billet.js` for why those are the
 * right two questions to ask. Any axis left blank falls back to wrapping the
 * toolpath: `margin` all round in XY, and `top` / `base` in Z (defaulting to
 * the highest move and just below the deepest), exactly as this always did.
 */
export function stockFromBounds(bounds, {
  margin = 5, cellSize = 1, top, base, size, origin,
} = {}) {
  const box = billetBox(bounds, size ?? {}, {
    margin, origin: origin ?? {}, autoTop: top, autoBase: base,
  });
  return createStock({
    xMin: box.xMin,
    yMin: box.yMin,
    xMax: box.xMax,
    yMax: box.yMax,
    top: box.top,
    base: box.base,
    cellSize,
  });
}

// Cell index helpers.
function cellX(stock, x) {
  return Math.floor((x - stock.xMin) / stock.cellSize);
}
function cellY(stock, y) {
  return Math.floor((y - stock.yMin) / stock.cellSize);
}

/**
 * Stamp the cutter at (x,y) with its tip at height z: every cell whose centre
 * lies under the tool is lowered to the cutter's own surface at that offset
 * from its axis. Returns the volume removed by this stamp.
 *
 * The surface comes from `profileRise` in `cam/cutters.js`, shared with the
 * voxel carver — so a flat, a ball and a chamfer cone are one formula with
 * three cases, and the two simulators cannot disagree about the shape of a
 * tool.
 */
export function stamp(stock, x, y, z, tool) {
  const r = tool.radius;
  const cs = stock.cellSize;
  const ci0 = Math.max(0, cellX(stock, x - r));
  const ci1 = Math.min(stock.nx - 1, cellX(stock, x + r));
  const cj0 = Math.max(0, cellY(stock, y - r));
  const cj1 = Math.min(stock.ny - 1, cellY(stock, y + r));
  const r2 = r * r;
  const cellArea = cs * cs;
  let removed = 0;

  for (let j = cj0; j <= cj1; j++) {
    const cy = stock.yMin + (j + 0.5) * cs;
    const dy = cy - y;
    for (let i = ci0; i <= ci1; i++) {
      const cx = stock.xMin + (i + 0.5) * cs;
      const dx = cx - x;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;

      // Surface height of the tool at this offset from its axis.
      const surfZ = z + profileRise(tool, Math.sqrt(d2));

      const idx = j * stock.nx + i;
      const h = stock.heights[idx];
      if (surfZ < h) {
        removed += (h - surfZ) * cellArea;
        stock.heights[idx] = surfZ;
      }
    }
  }
  return removed;
}

/**
 * Sweep the cutter along a straight move a→b, stamping at intervals no coarser
 * than the cell size so nothing is skipped. Returns volume removed.
 */
export function cutSegment(stock, a, b, tool) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  const step = Math.max(stock.cellSize * 0.5, 1e-6);
  const n = Math.max(1, Math.ceil(len / step));
  let removed = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    removed += stamp(stock, a[0] + dx * t, a[1] + dy * t, a[2] + dz * t, tool);
  }
  return removed;
}

/**
 * Simulate an ordered list of cutting moves against the stock.
 * Only cutting moves ('feed') remove material; rapids traverse above the part.
 * @param {object} stock
 * @param {{type:string, a:number[], b:number[], tool?:number}[]} segments
 * @param {Tool | ((seg:object)=>Tool)} tool  one cutter for every move, or a
 *   resolver that returns the cutter for a given segment (per-tool geometry).
 */
export function simulate(stock, segments, tool) {
  const pick = typeof tool === 'function' ? tool : () => tool;
  let removed = 0;
  for (const s of segments) {
    if (s.type === 'rapid') continue; // rapids don't cut
    removed += cutSegment(stock, s.a, s.b, pick(s));
  }
  return { removedVolume: removed };
}
