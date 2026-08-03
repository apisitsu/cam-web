/**
 * Does the cutter type reach the material?
 *
 * `cam/cutters.test.js` proves `profileRise` describes each shape. That is the
 * formula, not the cut. What matters on screen is that choosing a chamfer mill
 * leaves a cone in the stock rather than a square-shouldered pocket — and that
 * the height field and the voxel block agree about it, since the app picks
 * between them on its own depending on the program.
 */
import { describe, it, expect } from 'vitest';
import { createStock, stamp } from './dexel.js';
import { createVoxelStock, carveVoxelMove } from './voxel.js';

const CS = 0.5;
const stockAt = () => createStock({
  xMin: -10, yMin: -10, xMax: 10, yMax: 10, top: 0, base: -20, cellSize: CS,
});
/** Remaining stock height on the X axis, `x` mm out from the tool centre. */
const heightAt = (s, x) =>
  s.heights[Math.floor((0 - s.yMin) / CS) * s.nx + Math.floor((x - s.xMin) / CS)];

/** One plunge to Z-5 with the given cutter, sampled across its radius. */
function plunge(tool) {
  const s = stockAt();
  stamp(s, 0, 0, -5, tool);
  return [0, 1, 2, 3, 4].map((x) => heightAt(s, x));
}

describe('each cutter type leaves its own shape in the stock', () => {
  it('a flat endmill leaves a flat floor', () => {
    const p = plunge({ radius: 5, type: 'flat' });
    for (const h of p) expect(h).toBeCloseTo(-5, 6);
  });

  it('a ball nose leaves a sphere, deepest on centre', () => {
    const p = plunge({ radius: 5, type: 'ball' });
    expect(p[0]).toBeCloseTo(-5, 1);
    // Rises monotonically toward the rim, and reaches the equator at r.
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeGreaterThan(p[i - 1]);
    expect(p[4]).toBeGreaterThan(-3);
  });

  it('a 90° chamfer mill leaves a 45° cone, NOT a flat floor', () => {
    // The failure this guards: carving a chamfer as flat draws a square
    // shoulder where the part has a chamfer, which is the one thing the
    // simulation is there to show.
    const p = plunge({ radius: 5, type: 'cone', angle: 90 });
    const flat = plunge({ radius: 5, type: 'flat' });
    expect(p[3]).toBeGreaterThan(flat[3] + 2);
    // 1 mm of rise per 1 mm out — measured across whole millimetres so the
    // cell quantisation cancels.
    expect(p[3] - p[1]).toBeCloseTo(2, 1);
  });

  it('a sharper cone is steeper, so it cuts a narrower notch', () => {
    const wide = plunge({ radius: 5, type: 'cone', angle: 90 });
    const sharp = plunge({ radius: 5, type: 'cone', angle: 60 });
    // Steeper flank → back to the original surface sooner.
    expect(sharp[3]).toBeGreaterThan(wide[3]);
    expect(sharp[3]).toBeCloseTo(0, 6);
  });
});

describe('the voxel carver agrees with the height field', () => {
  /** How deep a plunge reaches on the tool axis, in the voxel block. */
  function voxelDepth(tool) {
    const v = createVoxelStock(
      { min: [-10, -10, -20], max: [10, 10, 0] }, { margin: 0, cellSize: CS },
    );
    carveVoxelMove(v, [0, 0, 0], [0, 0, -5], [0, 0, 1], { ...tool, length: 20 });
    // Walk up the centre column and find the lowest cleared cell.
    const i = Math.floor((0 - v.ox) / v.cs);
    const j = Math.floor((0 - v.oy) / v.cs);
    for (let k = 0; k < v.nz; k++) {
      if (!v.solid[k * v.nx * v.ny + j * v.nx + i]) return v.oz + (k + 0.5) * v.cs;
    }
    return null;
  }

  it('reaches the same depth on centre for a flat cutter', () => {
    expect(voxelDepth({ radius: 5, type: 'flat' })).toBeCloseTo(-5, 0);
  });

  it('reaches the same depth on centre for a ball nose', () => {
    expect(voxelDepth({ radius: 5, type: 'ball' })).toBeCloseTo(-5, 0);
  });

  it('very nearly reaches it for a cone, and a sharper one gets closer', () => {
    // The point of a chamfer mill is on the axis, so a plunge to Z-5 reaches
    // Z-5 *there*. The sampled column is not quite there — its cell centre sits
    // ~0.35 mm off-axis, where a 90° cone has already risen 0.35 mm — so this
    // reads a hair shallow by construction. The tell that the cone is real is
    // the comparison: the steeper 60° flank rises faster, so it reads shallower
    // still, and both stay within a cell or so of the flat cutter.
    const wide = voxelDepth({ radius: 5, type: 'cone', angle: 90 });
    const sharp = voxelDepth({ radius: 5, type: 'cone', angle: 60 });
    expect(wide).toBeLessThan(-4);
    expect(sharp).toBeLessThan(-3.5);
    expect(sharp).toBeGreaterThanOrEqual(wide);
  });

  it('leaves material out at the rim that a flat cutter would have taken', () => {
    const v = createVoxelStock(
      { min: [-10, -10, -20], max: [10, 10, 0] }, { margin: 0, cellSize: CS },
    );
    carveVoxelMove(v, [0, 0, 0], [0, 0, -5], [0, 0, 1],
      { radius: 5, type: 'cone', angle: 90, length: 20 });
    // 4 mm out, the 45° flank is still 4 mm above the tip (Z-1), so the cell
    // just under the tip depth must survive.
    const i = Math.floor((4 - v.ox) / v.cs);
    const j = Math.floor((0 - v.oy) / v.cs);
    const k = Math.floor((-4.5 - v.oz) / v.cs);
    expect(v.solid[k * v.nx * v.ny + j * v.nx + i]).toBe(1);
  });
});
