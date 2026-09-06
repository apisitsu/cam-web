import { describe, it, expect } from 'vitest';
import {
  PLANE_PRESETS, DEFAULT_PLANE, planeBasis, planeToWorld, worldToPlane,
  planeMatrix, planeLabel, parsePlane, planeFromFace,
} from './plane.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

describe('plane presets', () => {
  it('are right-handed, so a CCW profile stays CCW seen from the front', () => {
    for (const [name, p] of Object.entries(PLANE_PRESETS)) {
      const n = cross(p.u, p.v);
      expect(near(n[0], p.n[0]) && near(n[1], p.n[1]) && near(n[2], p.n[2]))
        .toBe(true, `${name} is left-handed`);
    }
  });

  it('put the default sketch on the machine table, unrotated', () => {
    expect(planeMatrix(DEFAULT_PLANE)).toEqual([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
  });
});

describe('planeToWorld / worldToPlane', () => {
  it('maps the table plane straight through, as the layer always assumed', () => {
    expect(planeToWorld({ preset: 'XY', offset: 0 }, 12, -4)).toEqual([12, -4, 0]);
  });

  it('stands the front plane up: sketch y becomes world Z', () => {
    expect(planeToWorld({ preset: 'XZ', offset: 0 }, 12, 30)).toEqual([12, 0, 30]);
  });

  it('stands the right plane up along +X', () => {
    expect(planeToWorld({ preset: 'YZ', offset: 0 }, 12, 30)).toEqual([0, 12, 30]);
  });

  it('offsets along the normal — a sketch 12 mm above the table', () => {
    expect(planeToWorld({ preset: 'XY', offset: 12 }, 3, 4)).toEqual([3, 4, 12]);
  });

  it('round-trips any point on any preset', () => {
    for (const preset of ['XY', 'XZ', 'YZ']) {
      for (const offset of [0, 7.5, -3]) {
        const plane = { preset, offset };
        const p = planeToWorld(plane, 13.25, -8.5);
        const back = worldToPlane(plane, p);
        expect(near(back.x, 13.25)).toBe(true);
        expect(near(back.y, -8.5)).toBe(true);
        expect(near(back.off, 0)).toBe(true);
      }
    }
  });

  it('reports how far off the plane a point in space sits', () => {
    const { off } = worldToPlane({ preset: 'XY', offset: 0 }, [1, 2, 9]);
    expect(off).toBeCloseTo(9);
  });
});

describe('planeBasis', () => {
  it('squares up a custom plane whose axes arrived out of square', () => {
    // v leans into u by 20°; the basis must come back orthonormal anyway.
    const { u, v, n } = planeBasis({ origin: [0, 0, 0], u: [1, 0, 0], v: [0.34, 0.94, 0] });
    expect(near(u[0] * v[0] + u[1] * v[1] + u[2] * v[2], 0, 1e-12)).toBe(true);
    expect(near(Math.hypot(...v), 1, 1e-12)).toBe(true);
    expect(near(Math.hypot(...n), 1, 1e-12)).toBe(true);
  });

  it('falls back to the table for a preset it does not know', () => {
    // A sketch that opens on the wrong plane can be moved; one that throws is lost.
    expect(planeBasis({ preset: 'BANANA', offset: 0 }).n).toEqual([0, 0, 1]);
  });
});

describe('planeMatrix', () => {
  it('is column-major with u, v, n, origin as its columns', () => {
    const m = planeMatrix({ preset: 'XZ', offset: 5 });
    expect(m.slice(0, 3)).toEqual([1, 0, 0]); // u
    expect(m.slice(4, 7)).toEqual([0, 0, 1]); // v
    expect(m.slice(8, 11)).toEqual([0, -1, 0]); // n
    expect(m.slice(12, 15)).toEqual([0, -5, 0]); // origin, offset along n
  });

  it('places a local point exactly where planeToWorld says it goes', () => {
    const plane = { preset: 'YZ', offset: -4 };
    const m = planeMatrix(plane);
    const [x, y] = [6, 7];
    // Column-major multiply of (x, y, 0, 1).
    const world = [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[12 + r]);
    expect(world).toEqual(planeToWorld(plane, x, y));
  });
});

describe('parsePlane', () => {
  it('keeps a valid preset and offset', () => {
    expect(parsePlane({ preset: 'XZ', offset: 12 })).toEqual({ preset: 'XZ', offset: 12 });
  });

  it('replaces junk with the default rather than failing the open', () => {
    expect(parsePlane(null)).toEqual(DEFAULT_PLANE);
    expect(parsePlane({ preset: 'nope', offset: 'x' })).toEqual({ preset: 'XY', offset: 0 });
  });

  it('keeps a custom frame when both axes are real vectors', () => {
    const p = parsePlane({ origin: [1, 2, 3], u: [0, 1, 0], v: [0, 0, 1] });
    expect(p.origin).toEqual([1, 2, 3]);
    expect(p.u).toEqual([0, 1, 0]);
  });
});

describe('planeLabel', () => {
  it('names the standard planes and shows a signed offset', () => {
    expect(planeLabel({ preset: 'XY', offset: 0 })).toBe('Top (XY)');
    expect(planeLabel({ preset: 'XZ', offset: 12 })).toBe('Front (XZ) +12');
    expect(planeLabel({ preset: 'YZ', offset: -3 })).toBe('Right (YZ) -3');
    expect(planeLabel({ origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] })).toBe('Custom');
  });
});

describe('planeFromFace', () => {
  const face = (normal, centroid, facing) => ({ normal, centroid, facing });

  it('gives a standard preset back for an axis-aligned face, with its offset', () => {
    // A pocket floor 12 mm up must read as the machine's own Top plane, so a
    // dimension typed on it means what it meant on the table.
    expect(planeFromFace(face([0, 0, 1], [5, 7, 12], 'up')))
      .toEqual({ preset: 'XY', offset: 12 });
    expect(planeFromFace(face([1, 0, 0], [8, 1, 2], 'right')))
      .toEqual({ preset: 'YZ', offset: 8 });
    expect(planeFromFace(face([0, -1, 0], [1, -4, 2], 'front')))
      .toEqual({ preset: 'XZ', offset: 4 });
  });

  it('rounds the offset, because a centroid carries float noise', () => {
    const p = planeFromFace(face([0, 0, 1], [0, 0, 11.9999999997], 'up'));
    expect(p.offset).toBe(12);
  });

  it('builds an orthonormal right-handed frame for an angled face', () => {
    const n = [0, Math.SQRT1_2, Math.SQRT1_2];
    const p = planeFromFace(face(n, [1, 2, 3], 'angled'));
    expect(p.preset).toBeUndefined();
    const { u, v, n: got } = planeBasis(p);
    expect(near(Math.hypot(...u), 1)).toBe(true);
    expect(near(Math.hypot(...v), 1)).toBe(true);
    expect(near(u[0] * v[0] + u[1] * v[1] + u[2] * v[2], 0)).toBe(true);
    // The frame's normal is the face's normal — extruding a positive depth
    // leaves the material, which is what a boss on that face means.
    for (let i = 0; i < 3; i++) expect(near(got[i], n[i], 1e-9)).toBe(true);
  });

  it('puts the sketch origin on the face, not at the world origin', () => {
    const p = planeFromFace(face([0, Math.SQRT1_2, Math.SQRT1_2], [1, 2, 3], 'angled'));
    expect(planeToWorld(p, 0, 0)).toEqual([1, 2, 3]);
  });

  it('does not fall over on a face pointing down the other way', () => {
    // −Z is not a preset (presets are +normal only), so it becomes a custom
    // frame whose normal really is −Z.
    const p = planeFromFace(face([0, 0, -1], [0, 0, 0], 'down'));
    expect(planeBasis(p).n[2]).toBeCloseTo(-1);
  });

  it('names a custom plane after the face it came from, and keeps it through a save', () => {
    const p = planeFromFace(face([0, Math.SQRT1_2, Math.SQRT1_2], [0, 0, 0], 'angled'));
    expect(planeLabel(p)).toBe('On face · angled');
    expect(planeLabel(parsePlane(JSON.parse(JSON.stringify(p))))).toBe('On face · angled');
  });

  it('falls back to the table for a face with nothing usable on it', () => {
    expect(planeFromFace(null)).toEqual(DEFAULT_PLANE);
    expect(planeFromFace({ normal: [0, 0, 1] })).toEqual(DEFAULT_PLANE);
  });
});
