import { describe, it, expect } from 'vitest';
import {
  // eslint-disable-next-line no-unused-vars
  simMethodFor, undercutting, voxelSizeFor, thinnestCut, VOXEL_LAYERS, MAX_VOXELS,
  cutterSpan, cellSizeFor, CIRCLE_CELLS, MIN_CELL, MAX_CELLS, MAX_STAMPS,
} from './method.js';

describe('undercutting — what a height field cannot hold', () => {
  it('is a cutter that only cuts near its tip', () => {
    expect(undercutting({ radius: 10, thickness: 3 })).toBe(true);
  });

  it('is not a plain cutter, whatever its size or shape', () => {
    for (const tool of [
      { radius: 10, type: 'flat' },
      { radius: 25, type: 'ball' },
      { radius: 5, type: 'cone', angle: 60 },
      { radius: 10, thickness: 0 },
      null,
      undefined,
    ]) {
      // eslint-disable-next-line jest/valid-expect
      expect(undercutting(tool), JSON.stringify(tool)).toBe(false);
    }
  });
});

describe('simMethodFor — the model that can show this cut', () => {
  it('keeps the scrub-able height field for ordinary 3-axis work', () => {
    expect(simMethodFor({ rotaryIndices: [0], fallbackTool: { radius: 5 } }))
      .toEqual({ method: 'height', why: null });
    expect(simMethodFor()).toEqual({ method: 'height', why: null });
  });

  it('routes a multi-index program to the voxel block', () => {
    // A Z-up column can only be carved from above, so the other faces would
    // come back looking uncut.
    const r = simMethodFor({ rotaryIndices: [0, 90, 270] });
    expect(r.method).toBe('voxel');
    expect(r.why).toMatch(/rotary/i);
  });

  it('routes a cutter that leaves a roof over its groove', () => {
    // The complaint this answers: a slot cutter simulated to a full-depth
    // channel, because the height field cannot keep the material above it.
    const r = simMethodFor({ fallbackTool: { radius: 10, thickness: 3 } });
    expect(r.method).toBe('voxel');
    expect(r.why).toMatch(/3 mm/);
  });

  it('finds an undercutting tool in the tool table too', () => {
    const r = simMethodFor({
      fallbackTool: { radius: 5 },
      overrides: { 1: { diameter: 12 }, 4: { cutter: 'slot', thickness: 6 } },
    });
    expect(r.method).toBe('voxel');
    expect(r.why).toMatch(/6 mm/);
  });

  it('always says why it changed the model', () => {
    // A run that silently switches simulators — losing playback scrubbing with
    // it — owes the operator a sentence.
    for (const args of [
      { rotaryIndices: [0, 90] },
      { fallbackTool: { thickness: 2 } },
    ]) {
      const r = simMethodFor(args);
      expect(r.method).toBe('voxel');
      // eslint-disable-next-line jest/valid-expect
      expect(r.why.length, JSON.stringify(args)).toBeGreaterThan(20);
    }
  });
});

describe('voxelSizeFor — a grid fine enough to hold the cut', () => {
  const bounds = { min: [0, 0, -25], max: [50, 30, 0] };

  it('leaves an ordinary request alone', () => {
    expect(voxelSizeFor({ requested: 1, bounds }))
      .toEqual({ size: 1, sizeZ: 1, limited: false });
    expect(voxelSizeFor({ requested: 0.5 }).size).toBe(0.5);
  });

  it('refines the HEIGHT until the thinnest cut spans several voxels', () => {
    // The bug: a cut is rounded out to whole voxels, so a 3 mm cutting body on
    // a 1 mm grid comes back up to 4 mm tall. The dimension it is wrong in is
    // always Z, which is the one worth paying for.
    const r = voxelSizeFor({ requested: 1, thickness: 3, bounds });
    expect(r.sizeZ).toBeLessThanOrEqual(3 / VOXEL_LAYERS);
    expect(r.size).toBe(1);                    // the footprint is left alone
    const thin = voxelSizeFor({ requested: 1, thickness: 0.5, bounds });
    expect(thin.sizeZ <= 0.5 / VOXEL_LAYERS || thin.limited).toBe(true);
    expect(thin.size).toBe(1);
  });

  it('costs cells in proportion, not cubed — the reason Z alone is refined', () => {
    // An isotropic grid fine enough for a thin cutter is a browser tab that
    // never comes back, gets clamped by the budget, and lands back on a groove
    // that does not match the tool.
    const r = voxelSizeFor({ requested: 1, thickness: 0.4, bounds });
    const cells = (sx, sz) => Math.ceil(50 / sx) * Math.ceil(30 / sx) * Math.ceil(25 / sz);
    expect(cells(r.size, r.sizeZ)).toBeLessThan(cells(r.sizeZ, r.sizeZ) / 10);
  });

  it('never coarsens a request that was already finer', () => {
    const r = voxelSizeFor({ requested: 0.1, thickness: 8, bounds });
    expect(r.size).toBe(0.1);
    expect(r.sizeZ).toBe(0.1);
  });

  it('stops short of a grid that would never come back', () => {
    // A 0.2 mm cutter on a 300 mm billet is hundreds of millions of voxels.
    const big = { min: [0, 0, -150], max: [300, 300, 0] };
    const r = voxelSizeFor({ requested: 1, thickness: 0.2, bounds: big });
    expect(r.limited).toBe(true);
    expect(r.sizeZ).toBeGreaterThan(0.2 / VOXEL_LAYERS);
  });

  it('never coarsens past what was asked for, however big the part', () => {
    // The budget exists to bound the refinement this adds — not to overrule a
    // resolution the operator set for a part that is simply large.
    const big = { min: [0, 0, -150], max: [300, 300, 0] };
    for (const requested of [1, 2, 0.5]) {
      const r = voxelSizeFor({ requested, thickness: 0.2, bounds: big });
      // eslint-disable-next-line jest/valid-expect
      expect(r.sizeZ, String(requested)).toBeLessThanOrEqual(requested);
    }
    // A grid already over budget with no undercutting tool is left alone: it is
    // what the operator asked for and what they get today.
    expect(voxelSizeFor({ requested: 1, bounds: big }))
      .toEqual({ size: 1, sizeZ: 1, limited: false });
  });

  it('says when the budget, not the cutter, decided', () => {
    // The caller has to be able to tell the operator; a cut carved at a
    // resolution that cannot show it is the whole failure being prevented.
    expect(voxelSizeFor({ requested: 1, thickness: 3, bounds }).limited).toBe(false);
  });

  it('survives degenerate bounds and sizes', () => {
    for (const args of [
      { requested: 0, thickness: 0 },
      { requested: 1, thickness: -5, bounds },
      { requested: 1, thickness: 3, bounds: { min: [0, 0, 0], max: [0, 0, 0] } },
      {},
    ]) {
      const r = voxelSizeFor(args);
      // eslint-disable-next-line jest/valid-expect
      expect(Number.isFinite(r.size), JSON.stringify(args)).toBe(true);
      // eslint-disable-next-line jest/valid-expect
      expect(Number.isFinite(r.sizeZ), JSON.stringify(args)).toBe(true);
      expect(r.size).toBeGreaterThan(0);
      expect(r.sizeZ).toBeGreaterThan(0);
    }
  });
});

describe('thinnestCut — what the grid has to be able to hold', () => {
  it('is nothing when no tool states a cutting body', () => {
    expect(thinnestCut()).toBe(0);
    expect(thinnestCut({ fallbackTool: { radius: 5 }, overrides: { 1: { diameter: 8 } } })).toBe(0);
  });

  it('finds a thickness stated on a Tool table row', () => {
    // The bug: only the fallback picker was consulted, so a per-tool slot
    // cutter was carved on a grid coarser than its own groove.
    expect(thinnestCut({ overrides: { 3: { cutter: 'slot', thickness: 2 } } })).toBe(2);
  });

  it('takes the thinnest of all of them — that is the one at risk', () => {
    expect(thinnestCut({
      fallbackTool: { thickness: 6 },
      overrides: { 1: { thickness: 1.5 }, 2: { thickness: 4 } },
    })).toBe(1.5);
  });
});

describe('cutterSpan — the smallest and largest cutter in the cut', () => {
  const tool = (n, diameter, feeds = 10) => ({ n, diameter, feeds });

  it('reads both ends off the tools that actually cut', () => {
    expect(cutterSpan({ tools: [tool(1, 50), tool(2, 6), tool(3, 3)] }))
      .toEqual({ min: 3, max: 50 });
  });

  it('ignores a tool the program never calls', () => {
    // A tool table listing a Ø1 engraver that never cuts must not drive the
    // whole grid down to a tenth of a millimetre.
    expect(cutterSpan({ tools: [tool(1, 6), tool(2, 1, 0)] }).min).toBe(6);
  });

  it('takes the diameter the operator typed over the detected one', () => {
    expect(cutterSpan({
      tools: [tool(1, 20)],
      overrides: { 1: { diameter: 4 } },
    }).min).toBe(4);
  });

  it('counts an override for a tool the program never described', () => {
    expect(cutterSpan({ tools: [], overrides: { 7: { diameter: 2 } } }))
      .toEqual({ min: 2, max: 2 });
  });

  it('falls back to the picker, which covers every unnamed move', () => {
    expect(cutterSpan({ tools: [], fallbackTool: { radius: 1.5 } }))
      .toEqual({ min: 3, max: 3 });
  });

  it('says nothing rather than guessing when nothing is known', () => {
    expect(cutterSpan()).toEqual({ min: 0, max: 0 });
    expect(cutterSpan({ tools: [{ n: 1, diameter: null, feeds: 3 }] }))
      .toEqual({ min: 0, max: 0 });
  });
});

describe('cellSizeFor — how fine the height field is carved', () => {
  const bounds = { min: [0, 0, 0], max: [100, 100, 20] };

  it('refines to the smallest cutter, so a small bore comes out round', () => {
    // A Ø3 centre drill on the ½ mm grid the setting asks for is six cells
    // across — a hexagon. This is the whole fix.
    const { size } = cellSizeFor({
      requested: 0.5, span: { min: 3, max: 3 }, bounds, cutLength: 50,
    });
    expect(size).toBeCloseTo(3 / CIRCLE_CELLS, 6);
  });

  it('treats the setting as a ceiling, never as a floor to climb to', () => {
    // A Ø50 face mill needs nothing finer than what was asked for.
    const { size, limited } = cellSizeFor({
      requested: 0.5, span: { min: 50, max: 50 }, bounds, cutLength: 2000,
    });
    expect(size).toBe(0.5);
    expect(limited).toBe(false);
  });

  it('respects a setting finer than the tooling needs — that is a choice', () => {
    const { size } = cellSizeFor({
      requested: 0.1, span: { min: 50, max: 50 }, bounds, cutLength: 10,
    });
    expect(size).toBe(0.1);
  });

  it('coarsens back when the grid would be too big to scan', () => {
    const big = { min: [0, 0, 0], max: [400, 400, 20] };
    const { size, limited, wanted } = cellSizeFor({
      requested: 0.5, span: { min: 2, max: 2 }, bounds: big, cutLength: 1,
    });
    expect(wanted).toBeCloseTo(2 / CIRCLE_CELLS, 6);
    expect(limited).toBe(true);
    expect(size).toBeGreaterThan(wanted);
    const cells = Math.ceil(400 / size) * Math.ceil(400 / size);
    expect(cells).toBeLessThanOrEqual(MAX_CELLS);
  });

  it('coarsens back when the CARVING would be too expensive', () => {
    // A stamp covers (2r/cs)^2 cells, so the biggest tool in the program decides
    // what a fine grid costs. A Ø3 drill wants 0.125 mm; sharing the job with a
    // Ø8 cutter and 20 m of cutting, it settles for less.
    const wanted = 3 / CIRCLE_CELLS;
    const { size, limited } = cellSizeFor({
      requested: 0.5, span: { min: 3, max: 8 }, bounds, cutLength: 20000,
    });
    expect(limited).toBe(true);
    expect(size).toBeGreaterThan(wanted);
    expect(size).toBeLessThan(0.5);
    const stamps = (20000 / (size / 2)) * Math.PI * (4 / size) ** 2;
    expect(stamps).toBeLessThanOrEqual(MAX_STAMPS);
  });

  it('gives the refinement up entirely rather than going past the setting', () => {
    // A Ø3 drill next to a Ø50 face mill: no grid fine enough for the drill is
    // affordable with that cutter on it, so the answer is the setting itself.
    // The budget bounds *refinement* — it does not overrule what was asked for,
    // which is the operator's call and the behaviour every job had before.
    const { size, limited } = cellSizeFor({
      requested: 0.5, span: { min: 3, max: 50 }, bounds, cutLength: 20000,
    });
    expect(size).toBe(0.5);
    expect(limited).toBe(true);
  });

  it('never goes below the floor, whatever the tool', () => {
    const { size } = cellSizeFor({
      requested: 1, span: { min: 0.2, max: 0.2 }, bounds: null, cutLength: 0,
    });
    expect(size).toBe(MIN_CELL);
  });

  it('leaves the setting alone when nothing is known about the tooling', () => {
    expect(cellSizeFor({ requested: 0.4 }).size).toBe(0.4);
    expect(cellSizeFor({}).size).toBe(0.5);
    expect(cellSizeFor({ requested: 0 }).size).toBe(0.5);
  });
});
