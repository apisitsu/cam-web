import { describe, it, expect } from 'vitest';
import { creaseNormals } from './creaseNormals.js';
import { extrudeRegion } from '../solid/extrude.js';

const normalAt = (normals, soup, point, faceNormal) => {
  // The corner at `point` on a facet whose own normal is `faceNormal`.
  const p = soup.positions;
  for (let t = 0; t < soup.triangleCount; t++) {
    const o = t * 9;
    const ux = p[o + 3] - p[o]; const uy = p[o + 4] - p[o + 1]; const uz = p[o + 5] - p[o + 2];
    const vx = p[o + 6] - p[o]; const vy = p[o + 7] - p[o + 1]; const vz = p[o + 8] - p[o + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(...n);
    if (n.some((v, i) => Math.abs(v / l - faceNormal[i]) > 0.05)) continue;
    for (let k = 0; k < 3; k++) {
      const c = o + k * 3;
      if (Math.hypot(p[c] - point[0], p[c + 1] - point[1], p[c + 2] - point[2]) < 1e-6) {
        return [normals[c], normals[c + 1], normals[c + 2]];
      }
    }
  }
  return null;
};

describe('creaseNormals', () => {
  it('keeps a block\'s corners sharp: each face keeps its own normal', () => {
    const block = extrudeRegion({ outer: [0, 0, 10, 0, 10, 10, 0, 10] }, { depth: 10 });
    const normals = creaseNormals(block);
    expect(normals.length).toBe(block.triangleCount * 9);
    const top = normalAt(normals, block, [10, 10, 10], [0, 0, 1]);
    expect(top[2]).toBeCloseTo(1, 6);
    const side = normalAt(normals, block, [10, 10, 10], [1, 0, 0]);
    expect(side[0]).toBeCloseTo(1, 6);
  });

  it('blends a cylinder\'s facets into one round wall', () => {
    const n = 64;
    const loop = Array.from({ length: n }, (_, i) => [
      5 * Math.cos((2 * Math.PI * i) / n), 5 * Math.sin((2 * Math.PI * i) / n),
    ]).flat();
    const rod = extrudeRegion({ outer: loop }, { depth: 10 });
    const normals = creaseNormals(rod);
    // At the corner on the +X axis, between two facets, the wall's normal points
    // straight out along X — not along either facet's own normal.
    const mid = normalAt(normals, rod, [5, 0, 10], [Math.cos(Math.PI / n), Math.sin(Math.PI / n), 0]);
    // (Near enough: each facet is two triangles of unequal share at this corner.)
    expect(mid[0]).toBeGreaterThan(0.9995);
    expect(Math.abs(mid[1])).toBeLessThan(0.02);
    expect(Math.abs(mid[2])).toBeLessThan(1e-4);
    // A facet's own normal is 2.8° off X; the blend is well inside that.
    expect(mid[0]).toBeGreaterThan(Math.cos(Math.PI / n));
  });
});
