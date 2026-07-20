import { describe, it, expect } from 'vitest';
import { weld } from './stl.js';
import {
  axialSection, radialIntervalsAt, turningProfile, findRecesses, simplify,
} from './profile.js';
import { meshVolume } from './analyze.js';
import {
  cylinder, tube, groovedShaft, turnedShaft, revolveOutline,
} from './fixtures.js';

describe('revolveOutline fixture', () => {
  it('builds a solid with the volume the outline implies', () => {
    // A plain cylinder r=10 h=20 revolved from its outline.
    const m = weld(revolveOutline([
      { z: 0, r: 0 }, { z: 0, r: 10 }, { z: 20, r: 10 }, { z: 20, r: 0 },
    ], 256));
    // Inscribed faceting under-reports; check the shortfall is under 0.05%.
    const exact = Math.PI * 100 * 20;
    expect((exact - Math.abs(meshVolume(m))) / exact).toBeLessThan(5e-4);
  });

  it('builds a tube whose volume is the annulus', () => {
    const v = Math.abs(meshVolume(weld(tube(20, 10, 30, 256))));
    expect(v).toBeCloseTo(Math.PI * (400 - 100) * 30, -1);
  });
});

describe('radialIntervalsAt', () => {
  it('reports a solid bar as material from the axis outward', () => {
    const { loops } = axialSection(weld(cylinder(10, 20, 64)), 'z');
    const iv = radialIntervalsAt(loops, 10);
    expect(iv).toHaveLength(1);
    expect(iv[0][0]).toBeCloseTo(0, 6);
    expect(iv[0][1]).toBeCloseTo(10, 1);
  });

  it('reports a bore as an annulus, not a solid', () => {
    const { loops } = axialSection(weld(tube(20, 10, 30, 64)), 'z');
    const iv = radialIntervalsAt(loops, 15);
    expect(iv).toHaveLength(1);
    expect(iv[0][0]).toBeCloseTo(10, 1); // bore wall
    expect(iv[0][1]).toBeCloseTo(20, 1); // outside
  });

  it('reports nothing past the end of the part', () => {
    const { loops } = axialSection(weld(cylinder(10, 20, 64)), 'z');
    expect(radialIntervalsAt(loops, 50)).toEqual([]);
  });
});

describe('turningProfile', () => {
  it('recovers a plain cylinder', () => {
    const p = turningProfile(weld(cylinder(10, 20, 64)), 'z');
    expect(p.maxDiameter).toBeCloseTo(20, 1);
    expect(p.length).toBeCloseTo(20, 2);
    expect(p.hasBore).toBe(false);
    expect(p.recesses).toEqual([]);
    // A constant radius simplifies down to almost nothing.
    expect(p.outer.length).toBeLessThan(8);
    for (const pt of p.outer) expect(pt.r).toBeCloseTo(10, 1);
  });

  it('recovers both diameters of a stepped shaft, and the step between them', () => {
    const p = turningProfile(weld(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 })), 'z');
    expect(p.maxDiameter).toBeCloseTo(30, 1);
    expect(p.length).toBeCloseTo(45, 1);
    const radii = p.outer.map((q) => q.r);
    expect(Math.max(...radii)).toBeCloseTo(15, 1);
    expect(Math.min(...radii)).toBeCloseTo(8, 1);
    expect(p.recesses).toEqual([]); // a step is not an undercut
  });

  it('runs from the free end toward the chuck', () => {
    // Cutting direction matters to the toolpath, so the order is part of the API.
    const p = turningProfile(weld(turnedShaft()), 'z');
    expect(p.outer[0].z).toBeGreaterThan(p.outer[p.outer.length - 1].z);
  });

  it('finds the bore of a tube and reports its diameter', () => {
    const p = turningProfile(weld(tube(20, 10, 30, 64)), 'z');
    expect(p.hasBore).toBe(true);
    expect(p.boreDiameter).toBeCloseTo(20, 1);
    expect(p.maxDiameter).toBeCloseTo(40, 1);
    expect(p.bore.length).toBeGreaterThan(0);
  });

  it('flags a groove as a recess and warns about it', () => {
    const p = turningProfile(
      weld(groovedShaft({ radius: 15, length: 60, grooveZ: 30, grooveWidth: 4, grooveDepth: 3 })),
      'z',
    );
    expect(p.recesses).toHaveLength(1);
    const g = p.recesses[0];
    expect(g.width).toBeCloseTo(4, 0);
    expect(g.depth).toBeGreaterThan(2);
    expect(g.minRadius).toBeCloseTo(12, 0);
    expect(p.warnings.some((w) => /recess/.test(w))).toBe(true);
  });

  it('does not mistake a plain step for a recess', () => {
    const p = turningProfile(weld(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 })), 'z');
    expect(p.recesses).toHaveLength(0);
    expect(p.warnings).toEqual([]);
  });

  it('finds two grooves when there are two', () => {
    const m = revolveOutline([
      { z: 0, r: 0 }, { z: 0, r: 15 },
      { z: 10, r: 15 }, { z: 10, r: 12 }, { z: 14, r: 12 }, { z: 14, r: 15 },
      { z: 30, r: 15 }, { z: 30, r: 12 }, { z: 34, r: 12 }, { z: 34, r: 15 },
      { z: 50, r: 15 }, { z: 50, r: 0 },
    ], 64);
    expect(turningProfile(weld(m), 'z').recesses).toHaveLength(2);
  });

  it('works when the part lies along X instead of Z', () => {
    const m = cylinder(10, 20, 64);
    for (let i = 0; i < m.positions.length; i += 3) {
      const z = m.positions[i + 2]; m.positions[i + 2] = m.positions[i]; m.positions[i] = z;
    }
    const p = turningProfile(weld(m), 'x');
    expect(p.maxDiameter).toBeCloseTo(20, 1);
    expect(p.length).toBeCloseTo(20, 2);
  });

  it('rejects an unknown axis', () => {
    expect(() => turningProfile(weld(cylinder()), 'w')).toThrow(/bad axis/);
  });
});

describe('findRecesses', () => {
  it('ignores a monotonically falling profile', () => {
    const p = [10, 10, 8, 8, 6, 6].map((r, i) => ({ z: i, r }));
    expect(findRecesses(p)).toEqual([]);
  });

  it('catches a dip bounded by larger radii on both sides', () => {
    const p = [10, 10, 7, 7, 10, 10].map((r, i) => ({ z: i, r }));
    const rec = findRecesses(p);
    expect(rec).toHaveLength(1);
    expect(rec[0].minRadius).toBeCloseTo(7, 6);
  });

  it('catches a recess that runs to the end of the profile', () => {
    const p = [10, 10, 7, 7].map((r, i) => ({ z: i, r }));
    // Nothing larger to the right, so this is a step, not a recess.
    expect(findRecesses(p)).toEqual([]);
  });
});

describe('simplify', () => {
  it('collapses a straight run to its endpoints', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ z: i, r: 10 }));
    expect(simplify(pts, 0.01)).toHaveLength(2);
  });

  it('keeps a corner', () => {
    const pts = [
      ...Array.from({ length: 20 }, (_, i) => ({ z: i, r: 10 })),
      ...Array.from({ length: 20 }, (_, i) => ({ z: 20 + i, r: 5 })),
    ];
    const s = simplify(pts, 0.01);
    expect(s.length).toBeGreaterThan(2);
    expect(s.length).toBeLessThan(8);
  });

  it('honours the tolerance', () => {
    const pts = Array.from({ length: 100 }, (_, i) => ({ z: i, r: 10 + Math.sin(i / 5) }));
    expect(simplify(pts, 0.5).length).toBeLessThan(simplify(pts, 0.01).length);
  });

  it('passes short inputs straight through', () => {
    expect(simplify([{ z: 0, r: 1 }])).toHaveLength(1);
  });
});
