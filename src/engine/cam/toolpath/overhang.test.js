import { describe, it, expect } from 'vitest';
import { roughingOp, contourOp, stockFor } from './mill.js';
import { planJob } from '../plan.js';
import { post } from '../post/fanuc.js';
import { verifyCut } from '../verify.js';
import { weld } from '../../mesh/stl.js';
import { boundsOf } from '../../mesh/analyze.js';
import { extrudeRegion, mergeSoups } from '../../solid/extrude.js';

const square = (h) => [-h, -h, h, -h, h, h, -h, h];

/** A 40 mm cap, z 15–20, on a 20 mm stem, z 0–15: the cap overhangs the stem. */
function tee() {
  return mergeSoups([
    extrudeRegion({ outer: square(10) }, { depth: 15 }),
    extrudeRegion({ outer: square(20) }, { depth: 5, base: 15 }),
  ], 'extrude');
}

const opts = {
  material: 'aluminium',
  tool: {
    diameter: 6, flutes: 3, type: 'endmill', label: 'EM6',
  },
};

function setup(soup) {
  const mesh = weld(soup);
  const b = boundsOf(mesh);
  const bounds = { ...b, size: [0, 1, 2].map((i) => b.max[i] - b.min[i]) };
  return { mesh, stock: stockFor(bounds), part: { top: b.max[2], bottom: b.min[2] } };
}

/** Distance from (x, y) to the cap's 40 mm square; 0 anywhere under it. */
const clearOfCap = (x, y) => Math.hypot(Math.max(Math.abs(x) - 20, 0), Math.max(Math.abs(y) - 20, 0));

describe('a cutter below an overhang', () => {
  it('roughing keeps the whole tool clear of the cap under it', () => {
    const { mesh, stock, part } = setup(tee());
    const op = roughingOp(mesh, stock, part, opts);
    const below = op.moves.filter((m) => m.t === 'feed' && m.z < 15 - 1e-6);
    expect(below.length).toBeGreaterThan(0);
    for (const m of below) expect(clearOfCap(m.x, m.y)).toBeGreaterThanOrEqual(3 - 0.02);
    expect(op.notes.join(' ')).toMatch(/overhang/i);
  });

  it('finishing does not run the tool along the stem under the cap', () => {
    const { mesh, part } = setup(tee());
    const op = contourOp(mesh, part, opts);
    for (const m of op.moves.filter((x) => x.t === 'feed' && x.z < 15 - 1e-6)) {
      expect(clearOfCap(m.x, m.y)).toBeGreaterThanOrEqual(3 - 0.02);
    }
    expect(op.notes.join(' ')).toMatch(/overhang/i);
  });

  it('a whole plan on it verifies with no gouge', () => {
    const soup = tee();
    const plan = planJob(soup, weld(soup), { material: 'aluminium', mode: 'mill' });
    const nc = post({
      name: 'tee', mode: 'mill', operations: plan.operations, stock: plan.stock,
    });
    const result = verifyCut(plan, nc);
    expect(result.gouge.cells).toBe(0);
  });

  it('adds no overhang note to a part without one', () => {
    const soup = extrudeRegion({ outer: square(20) }, { depth: 10 });
    const { mesh, stock, part } = setup(soup);
    expect(roughingOp(mesh, stock, part, opts).notes.join(' ')).not.toMatch(/overhang/i);
    expect(contourOp(mesh, part, opts).notes.join(' ')).not.toMatch(/overhang/i);
  });
});
