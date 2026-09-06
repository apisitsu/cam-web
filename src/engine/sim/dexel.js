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
import { cutFootprint } from '../cam/cutters.js';

/**
 * @typedef {Object} Tool
 * @property {number} radius   cutter radius (mm)
 * @property {'flat'|'ball'} [type]  endmill profile (default 'flat')
 */

/**
 * How far outside the cut, in cell widths, a cell still records its distance to
 * the boundary. Two is enough for the mesher to find a zero crossing between any
 * pair of neighbouring cells, and every cell beyond that is untouched work.
 */
const EDGE_BAND_CELLS = 2;

/** The distance recorded for a cell no cut has come near — "far outside". */
export const EDGE_FAR = 1e9;

/**
 * A cut narrower than this many cells does not record its edge.
 *
 * The field is sampled at cell centres, so it can only describe a boundary the
 * grid resolves: a tool narrower than a cell leaves a distance that reads like
 * *"0.1 mm inside"* on one cell and *"0.4 mm outside"* on its neighbour, and the
 * zero crossing between those two is nowhere near the real wall. Interpolating it
 * moves the node further than the lattice error it was meant to remove.
 *
 * In the running app this never triggers: `cellSizeFor` refines the grid to
 * `CIRCLE_CELLS` (24) across the smallest cutter, so a real cut spans a dozen
 * cells either side of its axis. It is the guard for a height field assembled by
 * hand — a fixture, a test, a caller stamping a sub-cell tool — where trusting
 * the field would make the mesh worse than leaving the nodes where they are.
 */
const EDGE_MIN_RADIUS_CELLS = 1;

/** Create a rectangular block of stock discretised into an nx×ny height grid. */
export function createStock({ xMin, yMin, xMax, yMax, top, base = top - 10, cellSize = 1 }) {
  const nx = Math.max(1, Math.ceil((xMax - xMin) / cellSize));
  const ny = Math.max(1, Math.ceil((yMax - yMin) / cellSize));
  const heights = new Float32Array(nx * ny).fill(top);
  // Signed horizontal distance from the cell's centre to the nearest cut
  // boundary: negative inside a cut, positive outside, `EDGE_FAR` where no cut
  // has come near. It is what lets the mesher put a wall where the wall really
  // is instead of on the cell boundary it happens to fall in — see
  // `heightmapToSolidMesh`. Without it a bore is a staircase one cell deep,
  // whatever its diameter, which is what "the circle is not smooth" is.
  const edge = new Float32Array(nx * ny).fill(EDGE_FAR);
  // `base` is the solid bottom of the billet (used only for rendering a closed box).
  return {
    xMin, yMin, xMax, yMax, top, base: Math.min(base, top - 0.001),
    cellSize, nx, ny, heights, edge,
  };
}

/** Reset a stock's height field back to its original solid top (for scrubbing back). */
export function resetStock(stock) {
  stock.heights.fill(stock.top);
  if (stock.edge) stock.edge.fill(EDGE_FAR);
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
 * The surface comes from `cutFootprint` in `cam/cutters.js`, shared with the
 * voxel carver — so a flat, a ball and a chamfer cone are one formula with
 * three cases, and the two simulators cannot disagree about the shape of a
 * tool.
 */
export function stamp(stock, x, y, z, tool) {
  const r = tool.radius;
  const cs = stock.cellSize;
  const edge = r >= cs * EDGE_MIN_RADIUS_CELLS ? stock.edge : null;
  const band = r + EDGE_BAND_CELLS * cs;
  const ci0 = Math.max(0, cellX(stock, x - band));
  const ci1 = Math.min(stock.nx - 1, cellX(stock, x + band));
  const cj0 = Math.max(0, cellY(stock, y - band));
  const cj1 = Math.min(stock.ny - 1, cellY(stock, y + band));
  const cellArea = cs * cs;
  let removed = 0;

  for (let j = cj0; j <= cj1; j++) {
    const cy = stock.yMin + (j + 0.5) * cs;
    const dy = cy - y;
    for (let i = ci0; i <= ci1; i++) {
      const cx = stock.xMin + (i + 0.5) * cs;
      const dx = cx - x;

      // The horizontal edge record, kept for the same reason as in
      // `sweepLevel` — it is the only thing that knows where the wall is.
      if (edge) {
        const signed = Math.hypot(dx, dy) - r;
        const e0 = j * stock.nx + i;
        if (signed < edge[e0]) edge[e0] = signed;
      }

      // Surface height of the tool over this cell, or null when it is clear of
      // the cutter altogether.
      const rise = cutFootprint(tool, dx, dy);
      if (rise === null) continue;
      // **Clamped to the bottom of the billet.** A drill that goes deeper than
      // the plate is thick removes the plate, not more than the plate: without
      // this the column recorded a height below `base`, and two things followed.
      // The volume readout counted material that was never there, and — because
      // the mesh takes its floor from the *lowest* column — the underside of the
      // whole block dropped to the depth of the deepest hole, which reads on
      // screen as the stock growing a thicker bottom out of nowhere.
      //
      // A height field cannot express "no material at all here", so a through
      // hole leaves the 0.001 mm skin `base` is offset by. That is the model's
      // limit, not a fudge: representing a real void needs the multi-dexel
      // upgrade this file's header describes.
      const surfZ = Math.max(z + rise, stock.base);

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
 * A **level** move, swept in one pass: each cell in the swept band is visited
 * once, and the cutter surface over it is evaluated at the nearest point on the
 * path rather than sampled along it.
 *
 * ## Why this exists
 *
 * The sampling sweep below steps every half cell and stamps the whole disc at
 * each step, so every cell under the band is recomputed about `2 * (2r/cs)`
 * times — for a Ø10 cutter on a 0.25 mm grid, **eighty times each**. Measured at
 * 41 ms of carving per playback tick against playback's 40 ms budget, which is
 * exactly "the material comes off later than the tool": `carveToPlayhead` drops
 * every tick that arrives while the last one is still carving.
 *
 * Visiting each cell once removes that factor outright. It is also *more*
 * accurate, not less: the tool is a solid of revolution, so the deepest it
 * reaches over a cell is its surface at the perpendicular distance to the path —
 * a closed form, where sampling only ever approaches it.
 *
 * **Level only, deliberately.** With the tip height fixed, the deepest cut over
 * a cell is at the nearest point on the path, full stop. On a ramp or a plunge
 * the tip is moving in Z, so the lowest reach can be at a point further away
 * along the move, and that needs the search the sampling sweep already performs.
 * Those moves are short and few; the cutting passes that dominate a program are
 * level, and they are where the time goes.
 */
function sweepLevel(stock, a, b, tool) {
  const r = tool.radius;
  const cs = stock.cellSize;
  const ax = a[0];
  const ay = a[1];
  const vx = b[0] - ax;
  const vy = b[1] - ay;
  const len2 = vx * vx + vy * vy;
  const z = a[2];
  // Only a cut the grid can actually resolve records its edge — see
  // `EDGE_MIN_RADIUS_CELLS`.
  const edge = r >= cs * EDGE_MIN_RADIUS_CELLS ? stock.edge : null;
  // The band reaches past the cutter so cells just OUTSIDE the cut record their
  // distance too — a zero crossing needs a value on both sides of it.
  const band = r + EDGE_BAND_CELLS * cs;

  const ci0 = Math.max(0, cellX(stock, Math.min(ax, b[0]) - band));
  const ci1 = Math.min(stock.nx - 1, cellX(stock, Math.max(ax, b[0]) + band));
  const cj0 = Math.max(0, cellY(stock, Math.min(ay, b[1]) - band));
  const cj1 = Math.min(stock.ny - 1, cellY(stock, Math.max(ay, b[1]) + band));
  const cellArea = cs * cs;
  let removed = 0;

  for (let j = cj0; j <= cj1; j++) {
    const cy = stock.yMin + (j + 0.5) * cs;
    const wy = cy - ay;
    const rowBase = j * stock.nx;
    for (let i = ci0; i <= ci1; i++) {
      const cx = stock.xMin + (i + 0.5) * cs;
      const wx = cx - ax;
      // Nearest point on the segment, clamped to its ends — a zero-length move
      // (a plunge's XY footprint) collapses to its start, which is correct.
      let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const ex = wx - vx * t;
      const ey = wy - vy * t;

      // Distance to THIS cut's boundary. `min` over cuts is the union of them,
      // which is what a signed distance field wants and what the swept stock is.
      if (edge) {
        const signed = Math.hypot(ex, ey) - r;
        const idx0 = rowBase + i;
        if (signed < edge[idx0]) edge[idx0] = signed;
      }

      const rise = cutFootprint(tool, ex, ey);
      if (rise === null) continue;
      // Clamped to the bottom of the billet, for the reasons `stamp` sets out.
      const surfZ = Math.max(z + rise, stock.base);
      const idx = rowBase + i;
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
 * Sweep the cutter along a straight move a→b. Returns volume removed.
 *
 * A level move goes through `sweepLevel` — one visit per cell. A move that
 * changes height falls back to stamping at intervals no coarser than half a
 * cell, so nothing is skipped along it.
 */
export function cutSegment(stock, a, b, tool) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  // "Level" to well inside the height field's own resolution: a move that
  // descends by less than a thousandth of a cell cannot be told from a flat one
  // in the grid it is being carved into.
  if (Math.abs(dz) <= stock.cellSize * 1e-3) return sweepLevel(stock, a, b, tool);

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
