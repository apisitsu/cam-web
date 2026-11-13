import { describe, it, expect } from 'vitest';
import { sectionCap } from './sectionCap.js';
import { weld } from './stl.js';
import { extrudeRegion } from '../solid/extrude.js';

const area = (pos) => {
  let a = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const u = [pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2]];
    const v = [pos[i + 6] - pos[i], pos[i + 7] - pos[i + 1], pos[i + 8] - pos[i + 2]];
    a += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return a;
};

describe('sectionCap', () => {
  it('fills the section of a block, on the plane', () => {
    const mesh = weld(extrudeRegion({ outer: [0, 0, 40, 0, 40, 20, 0, 20] }, { depth: 10 }));
    const cap = sectionCap(mesh, 1, 7);
    expect(area(cap)).toBeCloseTo(40 * 10, 3);
    for (let i = 1; i < cap.length; i += 3) expect(cap[i]).toBe(7);
  });

  it('leaves the hole of a bored plate open', () => {
    const n = 64;
    const ring = Array.from({ length: n }, (_, i) => [
      20 + 5 * Math.cos((2 * Math.PI * i) / n), 20 + 5 * Math.sin((2 * Math.PI * i) / n),
    ]).flat().reverse();
    // An outline with a hole, extruded 10: cut across Z at mid height.
    const mesh = weld(extrudeRegion({ outer: [0, 0, 40, 0, 40, 40, 0, 40], holes: [ring] }, { depth: 10 }));
    const a = area(sectionCap(mesh, 2, 5));
    expect(a).toBeLessThan(1600 - 75);
    expect(a).toBeGreaterThan(1600 - 80);
  });

  it('is empty where the plane misses the part', () => {
    const mesh = weld(extrudeRegion({ outer: [0, 0, 40, 0, 40, 20, 0, 20] }, { depth: 10 }));
    expect(sectionCap(mesh, 2, 50)).toHaveLength(0);
  });
});
