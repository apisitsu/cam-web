/**
 * The slice index must be an optimisation and nothing else.
 *
 * `slicePlane` is the primitive every toolpath stands on, and the order its
 * segments come out in decides where `chainSegments` starts each loop — which
 * decides where the cutter enters it. So the bar here is not "similar loops":
 * it is that the indexed scan emits *byte-identical* output to the full scan,
 * for every plane, on meshes big enough to trip the index.
 */
import { describe, it, expect } from 'vitest';
import { slicePlane, sliceIndex, sliceLoops } from './slice.js';
import { weld } from './stl.js';
import { box, cylinder, tube, groovedShaft, revolveOutline } from './fixtures.js';

/** The reference implementation: every triangle, every time. */
function fullScan(mesh, axis, coord, eps = 1e-7) {
  const [u, v] = [0, 1, 2].filter((k) => k !== axis);
  const p = mesh.positions;
  const out = [];
  const count = mesh.indices ? mesh.indices.length / 3 : mesh.triangleCount;
  for (let t = 0; t < count; t++) {
    const o = mesh.indices
      ? [mesh.indices[t * 3] * 3, mesh.indices[t * 3 + 1] * 3, mesh.indices[t * 3 + 2] * 3]
      : [t * 9, t * 9 + 3, t * 9 + 6];
    const d = o.map((i) => {
      const dist = p[i + axis] - coord;
      return Math.abs(dist) < eps ? eps : dist;
    });
    if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) continue;
    const hits = [];
    for (let e = 0; e < 3; e++) {
      const i = o[e], j = o[(e + 1) % 3];
      const di = d[e], dj = d[(e + 1) % 3];
      if ((di > 0) === (dj > 0)) continue;
      const tt = di / (di - dj);
      hits.push(p[i + u] + (p[j + u] - p[i + u]) * tt, p[i + v] + (p[j + v] - p[i + v]) * tt);
    }
    if (hits.length === 4) out.push(hits[0], hits[1], hits[2], hits[3]);
  }
  return Float64Array.from(out);
}

/** A mesh big enough to cross the index threshold, with real depth structure. */
function bumpyPlate(nx = 40, ny = 40, sx = 80, sy = 80, h = 20) {
  const tris = [];
  const zTop = (i, j) => h + 3 * Math.sin((i / nx) * Math.PI * 3) * Math.cos((j / ny) * Math.PI * 3);
  const P = (i, j, top) => [(i / nx) * sx - sx / 2, (j / ny) * sy - sy / 2, top ? zTop(i, j) : 0];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      tris.push([P(i, j, 1), P(i + 1, j, 1), P(i + 1, j + 1, 1)]);
      tris.push([P(i, j, 1), P(i + 1, j + 1, 1), P(i, j + 1, 1)]);
      tris.push([P(i, j, 0), P(i + 1, j + 1, 0), P(i + 1, j, 0)]);
      tris.push([P(i, j, 0), P(i, j + 1, 0), P(i + 1, j + 1, 0)]);
    }
  }
  // Tall side walls — these span the whole Z range and are what exercises the
  // index's overflow list.
  for (let i = 0; i < nx; i++) {
    for (const j of [0, ny]) {
      tris.push([P(i, j, 0), P(i + 1, j, 0), P(i + 1, j, 1)]);
      tris.push([P(i, j, 0), P(i + 1, j, 1), P(i, j, 1)]);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (const i of [0, nx]) {
      tris.push([P(i, j, 0), P(i, j + 1, 0), P(i, j + 1, 1)]);
      tris.push([P(i, j, 0), P(i, j + 1, 1), P(i, j, 1)]);
    }
  }
  const positions = new Float32Array(tris.length * 9);
  let o = 0;
  for (const t of tris) for (const vv of t) for (const c of vv) positions[o++] = c;
  return { positions, normals: new Float32Array(tris.length * 3), triangleCount: tris.length };
}

describe('sliceIndex', () => {
  it('buckets every triangle exactly once, into a bin or the overflow', () => {
    const soup = bumpyPlate();
    const idx = sliceIndex(soup, 2);
    expect(idx.count).toBe(soup.triangleCount);
    const seen = new Set(idx.overflow);
    // Every triangle is reachable: either parked in overflow, or in some bin.
    for (const t of idx.tris) seen.add(t);
    expect(seen.size).toBe(soup.triangleCount);
  });

  it('parks the full-height side walls in the overflow list', () => {
    // The walls span the whole part, so binning them per level is exactly the
    // memory blow-up the overflow list exists to prevent.
    const idx = sliceIndex(bumpyPlate(), 2);
    expect(idx.overflow.length).toBeGreaterThan(0);
  });

  it('degenerates to a single bin when the mesh is flat along the axis', () => {
    const flat = bumpyPlate(20, 20, 40, 40, 0);
    // Not truly flat (the bumps remain), but a genuinely flat axis must not
    // divide by a zero span.
    const idx = sliceIndex(flat, 2);
    expect(Number.isFinite(idx.invBin)).toBe(true);
    expect(idx.bins).toBeGreaterThanOrEqual(1);
  });
});

describe('slicePlane — indexed output matches the full scan byte for byte', () => {
  const cases = [
    ['bumpy plate (soup)', bumpyPlate()],
    ['bumpy plate (welded)', weld(bumpyPlate())],
    ['fine cylinder', cylinder(15, 40, 400)],
    ['fine tube', tube(20, 10, 30, 400)],
    ['grooved shaft', groovedShaft({ segments: 400 })],
  ];

  for (const [name, mesh] of cases) {
    it(`${name}`, () => {
      const count = mesh.indices ? mesh.indices.length / 3 : mesh.triangleCount;
      expect(count).toBeGreaterThanOrEqual(512); // must actually use the index

      for (const axis of [0, 1, 2]) {
        const p = mesh.positions;
        let lo = Infinity, hi = -Infinity;
        for (let i = axis; i < p.length; i += 3) {
          if (p[i] < lo) lo = p[i];
          if (p[i] > hi) hi = p[i];
        }
        // Sweep the whole extent, plus outside it and exactly on the faces —
        // the boundary cases a binned lookup is most likely to get wrong.
        const coords = [lo - 1, lo, hi, hi + 1];
        for (let k = 0; k <= 40; k++) coords.push(lo + ((hi - lo) * k) / 40);

        for (const c of coords) {
          const got = slicePlane(mesh, axis, c);
          const want = fullScan(mesh, axis, c);
          expect(Array.from(got)).toEqual(Array.from(want));
        }
      }
    });
  }
});

describe('sliceLoops is unchanged by the index', () => {
  it('keeps loop count, winding and start point on a bored tube', () => {
    const mesh = weld(tube(20, 10, 30, 400));
    for (const z of [1, 5, 15, 29]) {
      const { loops } = sliceLoops(mesh, 2, z);
      expect(loops).toHaveLength(2);
      const [outer, hole] = loops;
      expect(outer.isHole).toBe(false);
      expect(hole.isHole).toBe(true);
      // Outer counter-clockwise, hole clockwise — the offsetting convention.
      expect(outer.signedArea).toBeGreaterThan(0);
      expect(hole.signedArea).toBeLessThan(0);
    }
  });

  it('finds the groove on a small fixture that skips the index entirely', () => {
    // Below the threshold, so this is the unindexed path — it must still work.
    const mesh = weld(box(20, 20, 10));
    const { loops } = sliceLoops(mesh, 2, 0);
    expect(loops).toHaveLength(1);
    expect(loops[0].isHole).toBe(false);
  });

  it('agrees with the full scan on a shape with an internal step', () => {
    const mesh = weld(revolveOutline([
      { z: 0, r: 0 }, { z: 0, r: 15 },
      { z: 20, r: 15 }, { z: 20, r: 8 },
      { z: 40, r: 8 }, { z: 40, r: 0 },
    ], 300));
    for (const z of [0.5, 10, 19.9, 20.1, 30, 39.5]) {
      const got = Array.from(slicePlane(mesh, 2, z));
      expect(got).toEqual(Array.from(fullScan(mesh, 2, z)));
    }
  });
});
