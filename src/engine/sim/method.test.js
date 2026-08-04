import { describe, it, expect } from 'vitest';
import {
  simMethodFor, undercutting, voxelSizeFor, thinnestCut, VOXEL_LAYERS, MAX_VOXELS,
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
      expect(Number.isFinite(r.size), JSON.stringify(args)).toBe(true);
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
