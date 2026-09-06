import { describe, it, expect } from 'vitest';
import { weld } from '../../mesh/stl.js';
import { turningProfile } from '../../mesh/profile.js';
import { turnedShaft, groovedShaft, cylinder, tube } from '../../mesh/fixtures.js';
import {
  facingOp, roughingOp, finishingOp, groovingOp, boringOp, partingOp, cutLengthOf,
} from './turn.js';
import { toolById } from '../library.js';

const roughTool = toolById('cnmg-rough');
const finishTool = toolById('dnmg-finish');

function setup(mesh, margin = 1.5) {
  const profile = turningProfile(weld(mesh), 'z');
  const stock = { radius: profile.maxRadius + margin, zMin: profile.zMin, zMax: profile.zMax + 2 };
  return { profile, stock, base: { material: 'mild-steel', stock } };
}

/** Every radius a feed move touches. */
const feedRadii = (op) => op.moves.filter((m) => m.t === 'feed').map((m) => m.x);

describe('roughingOp', () => {
  it('reaches the finished size of every diameter on a stepped shaft', () => {
    // Regression: constant-radius passes skipped the large diameter entirely.
    // On Ø30 stepping to Ø16 out of Ø33 bar the passes land at r=12.5 and 8.5,
    // both inside the Ø30 body, so 1.5 mm of stock over it survived roughing
    // and was dumped on the finishing insert.
    const { profile, base } = setup(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 }));
    const op = roughingOp(profile, { ...base, tool: roughTool });
    const radii = feedRadii(op);
    const allowance = 0.4;
    // The big body must be roughed down to its finished size plus allowance.
    expect(radii.some((r) => Math.abs(r - (15 + allowance)) < 0.15)).toBe(true);
    // …and so must the small one.
    expect(radii.some((r) => Math.abs(r - (8 + allowance)) < 0.15)).toBe(true);
  });

  it('never cuts inside the finishing allowance', () => {
    const { profile, base } = setup(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 }));
    const op = roughingOp(profile, { ...base, tool: roughTool });
    for (const m of op.moves.filter((x) => x.t === 'feed')) {
      // At this Z the finished profile is at some radius; the rougher must stay
      // outside it by the allowance (minus a hair for sampling).
      const finished = radiusAt(profile.outer, m.z);
      if (finished == null) continue;
      expect(m.x).toBeGreaterThan(finished + 0.4 - 0.06);
    }
  });

  it('respects the insert depth of cut', () => {
    const { profile, base } = setup(cylinder(20, 40, 64), 8);
    const shallow = roughingOp(profile, { ...base, tool: roughTool, doc: 1 });
    const deep = roughingOp(profile, { ...base, tool: roughTool, doc: 4 });
    expect(shallow.notes[0]).toMatch(/pass/);
    expect(shallow.cutLength).toBeGreaterThan(deep.cutLength);
  });

  it('does nothing when the bar is already at size', () => {
    const { profile, base } = setup(cylinder(15, 30, 64), 0);
    expect(roughingOp(profile, { ...base, tool: roughTool })).toBeNull();
  });

  it('fills grooves so the profiling insert never drops into one', () => {
    const { profile, base } = setup(groovedShaft({
      radius: 15, length: 60, grooveZ: 30, grooveWidth: 4, grooveDepth: 3,
    }));
    const op = roughingOp(profile, { ...base, tool: roughTool });
    const g = profile.recesses[0];
    for (const m of op.moves) {
      // eslint-disable-next-line jest/no-conditional-expect
      if (m.z > g.zStart && m.z < g.zEnd) expect(m.x).toBeGreaterThan(g.minRadius + 1);
    }
  });
});

describe('finishingOp', () => {
  it('follows the profile from the free end toward the chuck', () => {
    const { profile, base } = setup(turnedShaft());
    const op = finishingOp(profile, { ...base, tool: finishTool });
    const feeds = op.moves.filter((m) => m.t === 'feed');
    expect(feeds[0].z).toBeGreaterThan(feeds[feeds.length - 1].z);
  });

  it('runs a lighter feed than roughing, and says what finish that buys', () => {
    const { profile, base } = setup(turnedShaft());
    const rough = roughingOp(profile, { ...base, tool: roughTool });
    const finish = finishingOp(profile, { ...base, tool: finishTool });
    expect(finish.speeds.fn).toBeLessThan(rough.speeds.fn);
    expect(finish.notes[0]).toMatch(/Ra/);
  });
});

describe('facingOp', () => {
  it('takes the end stock off in passes and feeds past centre', () => {
    const { profile, base } = setup(turnedShaft());
    const op = facingOp(profile, { ...base, tool: roughTool });
    const minX = Math.min(...op.moves.map((m) => m.x));
    expect(minX).toBeLessThanOrEqual(0); // the nose radius overshoots the axis
    expect(op.notes[0]).toMatch(/end stock/);
  });
});

describe('groovingOp', () => {
  const { profile, base } = setup(groovedShaft({
    radius: 15, length: 60, grooveZ: 30, grooveWidth: 4, grooveDepth: 3,
  }));
  const recess = profile.recesses[0];

  it('plunges to the groove floor', () => {
    const op = groovingOp(recess, { ...base, tool: toolById('groove-3') });
    expect(Math.min(...feedRadii(op))).toBeCloseTo(recess.minRadius, 2);
  });

  it('keeps the blade inside the groove walls', () => {
    const tool = toolById('groove-2');
    const op = groovingOp(recess, { ...base, tool });
    for (const m of op.moves) {
      expect(m.z).toBeGreaterThanOrEqual(recess.zStart + tool.width / 2 - 1e-6);
      expect(m.z).toBeLessThanOrEqual(recess.zEnd - tool.width / 2 + 1e-6);
    }
  });

  it('refuses a blade wider than the groove', () => {
    expect(groovingOp({ ...recess, width: 1.5 }, { ...base, tool: toolById('groove-3') })).toBeNull();
  });
});

describe('boringOp', () => {
  it('opens a bore outward to size', () => {
    const { profile, base } = setup(tube(25, 12, 40, 64));
    const op = boringOp(profile, { ...base, tool: toolById('ccmt-bore') });
    expect(op).toBeTruthy();
    // Passes grow toward the finished bore radius, stopping short by the allowance.
    expect(Math.max(...feedRadii(op))).toBeLessThan(12);
    expect(Math.max(...feedRadii(op))).toBeGreaterThan(10);
  });

  it('does nothing on a solid bar', () => {
    const { profile, base } = setup(cylinder(15, 30, 64));
    expect(boringOp(profile, { ...base, tool: toolById('ccmt-bore') })).toBeNull();
  });
});

describe('partingOp', () => {
  it('cuts in to near centre and warns about the feed', () => {
    const { profile, base } = setup(turnedShaft());
    const op = partingOp(profile, { ...base, tool: toolById('part-3') });
    expect(Math.min(...feedRadii(op))).toBeLessThan(0.5);
    expect(op.speeds.fn).toBeLessThan(0.12);
    expect(op.notes.join(' ')).toMatch(/surface speed collapses/);
  });
});

describe('cutLengthOf and time estimates', () => {
  it('estimates minutes from feed per revolution and rpm', () => {
    const { profile, base } = setup(turnedShaft());
    const op = finishingOp(profile, { ...base, tool: finishTool });
    const expected = op.cutLength / (op.speeds.fn * op.speeds.rpm);
    expect(op.estMinutes).toBeCloseTo(expected, 1);
  });

  it('ignores rapids', () => {
    expect(cutLengthOf([
      { t: 'rapid', x: 0, z: 0 },
      { t: 'rapid', x: 50, z: 0 },
      { t: 'feed', x: 50, z: -10 },
    ])).toBeCloseTo(10, 6);
  });
});

/** Finished radius at an axial station, or null when off the part. */
function radiusAt(outer, z) {
  const pts = [...outer].sort((a, b) => a.z - b.z);
  if (z < pts[0].z || z > pts[pts.length - 1].z) return null;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].z >= z) {
      const a = pts[i - 1], b = pts[i];
      const t = b.z === a.z ? 0 : (z - a.z) / (b.z - a.z);
      return a.r + (b.r - a.r) * t;
    }
  }
  return pts[pts.length - 1].r;
}
