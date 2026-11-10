import { describe, it, expect } from 'vitest';
import { planJob } from './plan.js';
import { post } from './post/fanuc.js';
import { verifyCut } from './verify.js';
import { weld } from '../mesh/stl.js';
import { box, turnedShaft } from '../mesh/fixtures.js';

const planned = (soup, opts) => {
  const plan = planJob(soup, weld(soup), { material: 'aluminium', ...opts });
  const nc = post({
    name: 'part', mode: plan.mode, operations: plan.operations, stock: plan.stock,
  });
  return { plan, nc };
};

/** Add a plunge just before the program ends, with whatever tool was last loaded. */
const withExtraCut = (nc, blocks) => {
  const lines = nc.split('\n');
  const last = lines.findLastIndex((l) => /^M05/.test(l));
  lines.splice(last, 0, ...blocks);
  return lines.join('\n');
};

describe('verifyCut — milling', () => {
  it('says there is nothing to check in a plan with no operations', () => {
    const { plan, nc } = planned(box(40, 30, 10), { mode: 'mill', recipe: [] });
    expect(verifyCut(plan, nc)).toEqual({ ok: null, skipped: expect.stringMatching(/no operations/) });
  });

  it('finds no gouge in a planned box', () => {
    const { plan, nc } = planned(box(40, 30, 10), { mode: 'mill' });
    const result = verifyCut(plan, nc);
    expect(result.gouge.cells).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.excess.max).toBeLessThan(0.5);
  });

  it('catches a move that cuts into the part', () => {
    const { plan, nc } = planned(box(40, 30, 10), { mode: 'mill' });
    const cx = (plan.stock.minX + plan.stock.maxX) / 2;
    const cy = (plan.stock.minY + plan.stock.maxY) / 2;
    const z = plan.part.top - 2;
    const result = verifyCut(plan, withExtraCut(nc, [`G00 X${cx}. Y${cy}.`, `G01 Z${z} F100.`, 'G00 Z50.']));
    expect(result.ok).toBe(false);
    expect(result.gouge.max).toBeCloseTo(2, 1);
    expect(Math.hypot(result.gouge.at[0] - cx, result.gouge.at[1] - cy)).toBeLessThan(15);
  });

  it('reports material a program leaves behind', () => {
    const { plan, nc } = planned(box(40, 30, 10), { mode: 'mill' });
    const noCut = nc.split('\n').filter((l) => !/^G0?1\b|^X|^Y|^Z|^G0?[23]\b/.test(l)).join('\n');
    const result = verifyCut(plan, noCut);
    expect(result.excess.max).toBeGreaterThan(0.5);
  });
});

describe('verifyCut — turning', () => {
  it('finds no gouge in a planned shaft', () => {
    const { plan, nc } = planned(turnedShaft(), { mode: 'turn', partOff: false });
    const result = verifyCut(plan, nc);
    expect(result.gouge.cells).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('catches a pass that goes under the finished diameter', () => {
    const { plan, nc } = planned(turnedShaft(), { mode: 'turn', partOff: false });
    const lines = nc.split('\n');
    const last = lines.findLastIndex((l) => /^M09|^M05/.test(l));
    const z = (plan.profile.zMin + plan.profile.zMax) / 2;
    const r = plan.profile.maxRadius;
    lines.splice(
      last,
      0,
      `G00 X${(r + 3) * 2}. Z${z}`,
      'G01 X2. F0.1',
      `G00 X${(r + 3) * 2}.`,
    );
    const result = verifyCut(plan, lines.join('\n'));
    expect(result.ok).toBe(false);
    expect(result.gouge.max).toBeGreaterThan(1);
  });
});
