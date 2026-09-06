/**
 * A level move is swept once per cell, not stamped along its length.
 *
 * The sampling sweep steps every half cell and stamps the cutter's whole disc at
 * each step, so every cell under the band is recomputed about `2 * (2r/cs)`
 * times — eighty times each for a Ø10 cutter on a 0.25 mm grid. That measured 41
 * ms of carving per playback tick against playback's 40 ms budget, and
 * `carveToPlayhead` drops every tick that arrives while the last is still
 * running: the material came off visibly later than the tool that was cutting it.
 *
 * What this file pins is the **contract that made replacing it safe**. The
 * one-pass sweep evaluates the cutter's surface at the perpendicular distance to
 * the path, which is a closed form for a solid of revolution — so it must agree
 * with sampling, and where it differs it must be *deeper*, never shallower.
 * Sampling can only ever approach the true minimum from above.
 */
import { describe, it, expect } from 'vitest';
import { createStock, cutSegment, stamp } from './dexel.js';

const CS = 0.25;
const mk = () => createStock({
  xMin: -20, yMin: -20, xMax: 60, yMax: 30, top: 0, base: -20, cellSize: CS,
});

/** The sampling sweep, kept here as the reference the fast path must match. */
function sampled(stock, a, b, tool) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(1, Math.ceil(len / Math.max(stock.cellSize * 0.5, 1e-6)));
  let removed = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    removed += stamp(stock, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t, tool);
  }
  return removed;
}

/** Cell-by-cell comparison of the two sweeps over the same move. */
function compare(tool, a, b) {
  const fast = mk();
  const ref = mk();
  const vFast = cutSegment(fast, a, b, tool);
  const vRef = sampled(ref, a, b, tool);
  let worst = 0;
  let shallower = 0;
  for (let i = 0; i < fast.heights.length; i++) {
    const d = fast.heights[i] - ref.heights[i];   // negative = fast cut deeper
    if (Math.abs(d) > Math.abs(worst)) worst = d;
    if (d > 1e-9) shallower++;
  }
  return { worst, shallower, vFast, vRef };
}

const TOOLS = [
  { radius: 5, type: 'flat' },
  { radius: 1, type: 'flat' },
  { radius: 4, type: 'ball' },
  { radius: 3, type: 'cone', angle: 90 },
  { radius: 3, type: 'cone', angle: 60 },
];

describe('the one-pass sweep against the sampling sweep', () => {
  it.each(TOOLS)('never leaves material sampling removed — $type r$radius', (tool) => {
    for (const [a, b] of [
      [[0, 0, -3], [40, 5, -3]],       // a long diagonal pass
      [[0, 0, -3], [40, 0, -3]],       // straight along X
      [[0, 0, -3], [0, 20, -3]],       // straight along Y
      [[0, 0, -3], [0.1, 0, -3]],      // shorter than one cell
      [[0, 0, -3], [0, 0, -3]],        // zero length: a plunge's footprint
    ]) {
      const { shallower } = compare(tool, a, b);
      expect(shallower).toBe(0);
    }
  });

  it('is exact for a flat cutter — the surface is a plane either way', () => {
    const { worst, vFast, vRef } = compare({ radius: 5, type: 'flat' }, [0, 0, -3], [40, 5, -3]);
    expect(worst).toBe(0);
    expect(vFast).toBeCloseTo(vRef, 6);
  });

  it('reaches the true surface a curved cutter only approaches by sampling', () => {
    // Deeper, and by less than the grid can show — this is sampling error being
    // removed, not a change of shape.
    const ball = compare({ radius: 4, type: 'ball' }, [0, 0, -3], [40, 5, -3]);
    expect(ball.worst).toBeLessThan(0);
    expect(Math.abs(ball.worst)).toBeLessThan(CS);

    const cone = compare({ radius: 3, type: 'cone', angle: 90 }, [0, 0, -3], [40, 5, -3]);
    expect(cone.worst).toBeLessThan(0);
    expect(Math.abs(cone.worst)).toBeLessThan(CS);
  });

  it('carves the same floor depth as the tip, for a flat cutter', () => {
    const s = mk();
    cutSegment(s, [0, 0, -3], [30, 0, -3], { radius: 5, type: 'flat' });
    const at = (x, y) => s.heights[
      Math.floor((y - s.yMin) / CS) * s.nx + Math.floor((x - s.xMin) / CS)
    ];
    expect(at(15, 0)).toBeCloseTo(-3, 6);
    expect(at(15, 4)).toBeCloseTo(-3, 6);   // still inside the Ø10 band
    expect(at(15, 8)).toBeCloseTo(0, 6);    // clear of it
  });
});

describe('a move that changes height keeps the sampling sweep', () => {
  it('ramps down to the depth of its lower end', () => {
    // The fast path is level-only on purpose: with the tip moving in Z the
    // deepest reach over a cell can be further along the move than its nearest
    // point, which needs the search sampling performs.
    const s = mk();
    cutSegment(s, [0, 0, 0], [30, 0, -4], { radius: 5, type: 'flat' });
    const at = (x) => s.heights[
      Math.floor((0 - s.yMin) / CS) * s.nx + Math.floor((x - s.xMin) / CS)
    ];
    // A ramp leaves a slope, deepest at the end it finished on.
    expect(at(29)).toBeLessThan(at(15));
    expect(at(15)).toBeLessThan(at(1));
    expect(at(29)).toBeCloseTo(-4, 1);
  });

  it('plunges to its own tip depth', () => {
    const s = mk();
    cutSegment(s, [10, 0, 0], [10, 0, -5], { radius: 3, type: 'flat' });
    const at = (x) => s.heights[
      Math.floor((0 - s.yMin) / CS) * s.nx + Math.floor((x - s.xMin) / CS)
    ];
    expect(at(10)).toBeCloseTo(-5, 6);
  });
});
