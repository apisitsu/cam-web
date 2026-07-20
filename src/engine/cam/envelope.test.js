import { describe, it, expect } from 'vitest';
import {
  programAxes, checkEnvelope, fitWarnings, axisSummary,
} from './envelope.js';
import { machineById } from './machines.js';
import { planJob } from './plan.js';
import { weld } from '../mesh/stl.js';
import { box, turnedShaft } from '../mesh/fixtures.js';

const plan = (soup, opts) => planJob(soup, weld(soup), opts);
const millPlan = (opts) => plan(box(60, 40, 15), { material: 'aluminium', ...opts });
const turnPlan = (opts) => plan(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 }), { material: 'mild-steel', ...opts });

/** A one-operation stand-in, so axis reading can be tested without a planner. */
const op = (moves) => ({ moves });

describe('programAxes', () => {
  it('reports only the axes that actually move', () => {
    // Z alone: a plunge. The program does not "need" X and Y to hold still.
    const out = programAxes([op([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10 }])], 'mill');
    expect(out.letters).toEqual(['Z']);
    expect(out.extent.Z.range).toBeCloseTo(10, 6);
  });

  it('measures the span of each axis', () => {
    const out = programAxes([op([{ x: -30, y: -20, z: 5 }, { x: 30, y: 20, z: -15 }])], 'mill');
    expect(out.letters).toEqual(['X', 'Y', 'Z']);
    expect(out.extent.X.range).toBeCloseTo(60, 6);
    expect(out.extent.Y.range).toBeCloseTo(40, 6);
    expect(out.extent.Z.range).toBeCloseTo(20, 6);
  });

  it('reports turning X as diameter, not radius', () => {
    // Every number a turner reads is a diameter. Quietly halving it is how a
    // 300 mm bar gets reported as fitting a 200 mm lathe.
    const out = programAxes([op([{ x: 0, z: 0 }, { x: 25, z: -50 }])], 'turn');
    expect(out.extent.X.max).toBe(50);
    expect(out.letters).toEqual(['X', 'Z']);
  });

  it('never reports Y on a turning program', () => {
    const out = programAxes([op([{ x: 10, y: 999, z: 0 }, { x: 20, y: -999, z: -5 }])], 'turn');
    expect(out.letters).not.toContain('Y');
  });

  it('counts the Z a canned cycle commands without a motion block', () => {
    const out = programAxes([op([
      { x: 10, y: 10, z: 2 },
      { cycle: 'G83', x: 10, y: 10, z: -25, r: 2, peck: 6 },
    ])], 'mill');
    expect(out.extent.Z.min).toBe(-25);
    expect(out.extent.Z.range).toBeCloseTo(27, 6);
  });

  it('says nothing about an empty program', () => {
    expect(programAxes([], 'mill').letters).toEqual([]);
    expect(programAxes(undefined, 'mill').moveCount).toBe(0);
  });
});

describe('checkEnvelope — which axes', () => {
  it('reads a milling program as 3-axis', () => {
    const p = millPlan({ machineId: 'haas-vf2' });
    expect(p.envelope.axes.required).toEqual(['X', 'Y', 'Z']);
    expect(p.envelope.axes.missing).toEqual([]);
    expect(p.envelope.axes.machineCount).toBe(3);
  });

  it('reads a turning program as 2-axis', () => {
    const p = turnPlan({ machineId: 'haas-st20' });
    expect(p.envelope.axes.required).toEqual(['X', 'Z']);
    expect(p.envelope.axes.missing).toEqual([]);
  });

  it('names the axes a 5-axis machine has spare', () => {
    const p = millPlan({ machineId: 'dmgmori-dmu50' });
    expect(p.envelope.axes.unused).toEqual(['B', 'C']);
    expect(axisSummary(p.envelope)).toMatch(/3-axis program \(XYZ\).*machine has 5.*B, C unused/);
  });

  it('says plainly when the program matches the machine', () => {
    expect(axisSummary(millPlan({ machineId: 'haas-vf2' }).envelope))
      .toBe('3-axis program (XYZ) · matches the machine');
  });

  it('says plainly that a rotary machine is getting a 3-axis program', () => {
    // The mismatch that quietly disappoints. Someone who picks a 4-axis machine
    // expects 4-axis output; a silent 3-axis program reads as a broken rotary
    // rather than an unimplemented one.
    const p = millPlan({ machineId: 'mazak-vcn530c-4th' });
    expect(p.envelope.axes.unused).toEqual(['A']);
    const note = p.warnings.find((w) => /rotary/.test(w));
    expect(note).toMatch(/rotary on A/);
    expect(note).toMatch(/this program is 3-axis/);
    expect(note).toMatch(/Index it by hand/);
  });

  it('says the same of a 5-axis machine', () => {
    const p = millPlan({ machineId: 'dmgmori-dmu50' });
    expect(p.warnings.some((w) => /rotary on B\/C/.test(w))).toBe(true);
  });

  it('stays quiet about rotaries on a machine that has none', () => {
    const p = millPlan({ machineId: 'haas-vf2' });
    expect(p.warnings.some((w) => /rotary/.test(w))).toBe(false);
  });

  it('does not nag about a rotary when there is no program yet', () => {
    const check = checkEnvelope(machineById('mazak-vcn530c-4th'), { mode: 'mill', operations: [] });
    expect(check.warnings).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('catches a program the machine cannot run', () => {
    // A 3-axis milling toolpath on a 2-axis lathe: the Y is not there.
    const check = checkEnvelope(machineById('fanuc-generic-lathe'), {
      mode: 'mill',
      operations: [op([{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: -5 }])],
    });
    expect(check.axes.missing).toEqual(['Y']);
    expect(check.ok).toBe(false);
    expect(check.warnings[0]).toMatch(/commands Y.*does not have.*2-axis/);
    expect(axisSummary(check)).toMatch(/cannot do Y/);
  });

  it('tolerates a bare envelope with no catalogue entry', () => {
    // The planner's default machine is a set of limits, not a machine.
    const check = checkEnvelope({ maxRpm: 12000 }, {
      mode: 'mill',
      operations: [op([{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: -5 }])],
    });
    expect(check.axes.missing).toEqual([]);
    expect(check.travel).toEqual([]);
    expect(check.ok).toBe(true);
  });
});

describe('checkEnvelope — stroke', () => {
  it('reports how much of each stroke the toolpath uses', () => {
    const p = millPlan({ machineId: 'haas-vf2' });
    const x = p.envelope.travel.find((t) => t.axis === 'X');
    expect(x.stroke).toBe(762);
    expect(x.need).toBeGreaterThan(60);   // the stock is wider than the part
    expect(x.used).toBeLessThan(20);      // ...and nowhere near the limit
    expect(x.over).toBe(false);
  });

  it('catches a toolpath that runs the machine out of travel', () => {
    // A 500 mm plate on a Mini Mill with 406 mm of X.
    const p = plan(box(500, 200, 10), { material: 'aluminium', machineId: 'haas-minimill', mode: 'mill' });
    const x = p.envelope.travel.find((t) => t.axis === 'X');
    expect(x.over).toBe(true);
    expect(p.warnings.some((w) => /X travel/.test(w))).toBe(true);
  });

  it('the same plate fits the long-table VCS-530C', () => {
    // The reason to have a machine list at all: this is a "no" on one machine
    // and a "yes" on another, and the operator should not have to work it out.
    const p = plan(box(500, 200, 10), { material: 'aluminium', machineId: 'mazak-vcs530c', mode: 'mill' });
    expect(p.envelope.travel.every((t) => !t.over)).toBe(true);
    expect(p.warnings.some((w) => /travel/.test(w))).toBe(false);
  });

  it('measures lathe X against the cross-slide, in radius', () => {
    // The program is written on diameter; the slide moves in radius. Comparing
    // the diameter span against the slide stroke would halve the machine.
    const p = turnPlan({ machineId: 'haas-st20' });
    const x = p.envelope.travel.find((t) => t.axis === 'X');
    const dia = p.envelope.travel && programAxes(p.operations, 'turn').extent.X.range;
    expect(x.need).toBeCloseTo(dia / 2, 6);
    expect(x.over).toBe(false);
  });

  it('catches a bar too long for the lathe', () => {
    const long = turnedShaft({ r1: 15, z1: 400, r2: 8, z2: 900 });
    const p = plan(long, { material: 'mild-steel', machineId: 'fanuc-generic-lathe' });
    expect(p.warnings.some((w) => /Z travel|mm long/.test(w))).toBe(true);
  });

  it('catches a bar too fat to swing', () => {
    const fat = turnedShaft({ r1: 60, z1: 25, r2: 40, z2: 45 });
    const p = plan(fat, { material: 'mild-steel', machineId: 'citizen-l20' });
    expect(p.warnings.some((w) => /capacity/.test(w))).toBe(true);
  });
});

describe('fitWarnings — the cheap check, before a toolpath exists', () => {
  const bounds = (x, y, z) => ({ size: [x, y, z] });

  it('says nothing about a part that fits', () => {
    expect(fitWarnings(machineById('haas-vf2'), bounds(200, 150, 60))).toEqual([]);
  });

  it('catches a part bigger than the table travel', () => {
    expect(fitWarnings(machineById('haas-minimill'), bounds(600, 200, 50))
      .some((w) => /travel/.test(w))).toBe(true);
  });

  it('allows a part that fits once turned on the table', () => {
    // 380 × 290 does not fit 305 × 406 as modelled, but does rotated — and the
    // setter is free to rotate it.
    expect(fitWarnings(machineById('haas-minimill'), bounds(380, 290, 50))).toEqual([]);
  });

  it('catches a bar too big for the lathe to swing', () => {
    expect(fitWarnings(machineById('citizen-l20'), bounds(60, 60, 200))
      .some((w) => /capacity/.test(w))).toBe(true);
  });

  it('catches a bar longer than the lathe bed', () => {
    expect(fitWarnings(machineById('fanuc-generic-lathe'), bounds(40, 40, 900))
      .some((w) => /Z travel/.test(w))).toBe(true);
  });

  it('is quiet when there is nothing to check', () => {
    expect(fitWarnings(machineById('haas-vf2'), null)).toEqual([]);
    expect(fitWarnings({ kind: 'mill' }, bounds(10, 10, 10))).toEqual([]);
  });
});
