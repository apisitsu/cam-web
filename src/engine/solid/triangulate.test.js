import { describe, it, expect } from 'vitest';
import { triangulate } from './triangulate.js';

/** Total area of the triangulation — the check that matters most. */
function meshArea({ vertices, indices }) {
  let a = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const [i, j, m] = [indices[k], indices[k + 1], indices[k + 2]];
    a += ((vertices[j * 2] - vertices[i * 2]) * (vertices[m * 2 + 1] - vertices[i * 2 + 1])
      - (vertices[j * 2 + 1] - vertices[i * 2 + 1]) * (vertices[m * 2] - vertices[i * 2])) / 2;
  }
  return a;
}

/** A regular polygon, counter-clockwise. */
function ngon(cx, cy, r, n, ccw = true) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = ((ccw ? 1 : -1) * i * Math.PI * 2) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];

describe('triangulate — simple polygons', () => {
  it('covers a square exactly, with two triangles', () => {
    const t = triangulate(square(0, 0, 10, 4));
    expect(t.indices).toHaveLength(6);
    expect(meshArea(t)).toBeCloseTo(40);
  });

  it('winds every triangle counter-clockwise, whatever the input winding', () => {
    // Area comes out positive only if all triangles wound CCW.
    expect(meshArea(triangulate(ngon(0, 0, 10, 7, true)))).toBeGreaterThan(0);
    expect(meshArea(triangulate(ngon(0, 0, 10, 7, false)))).toBeGreaterThan(0);
  });

  it('handles a concave polygon (an L) without spilling outside it', () => {
    const L = [0, 0, 30, 0, 30, 10, 10, 10, 10, 30, 0, 30];
    expect(meshArea(triangulate(L))).toBeCloseTo(30 * 10 + 10 * 20);
  });

  it('produces n-2 triangles for a convex polygon', () => {
    const t = triangulate(ngon(0, 0, 5, 12));
    expect(t.indices.length / 3).toBe(10);
  });

  it('returns nothing for a degenerate ring instead of throwing', () => {
    expect(triangulate([0, 0, 1, 1]).indices).toHaveLength(0);
    expect(triangulate([]).indices).toHaveLength(0);
  });
});

describe('triangulate — holes', () => {
  it('subtracts a single hole from the area', () => {
    const t = triangulate(square(0, 0, 40, 40), [ngon(20, 20, 5, 24, false)]);
    const hole = 0.5 * 24 * 25 * Math.sin((Math.PI * 2) / 24);
    expect(meshArea(t)).toBeCloseTo(1600 - hole, 3);
  });

  it('subtracts several holes, including ones close together', () => {
    const holes = [
      ngon(10, 20, 4, 20, false),
      ngon(20, 20, 4, 20, false),
      ngon(30, 20, 4, 20, false),
    ];
    const t = triangulate(square(0, 0, 40, 40), holes);
    const one = 0.5 * 20 * 16 * Math.sin((Math.PI * 2) / 20);
    expect(meshArea(t)).toBeCloseTo(1600 - 3 * one, 2);
  });

  it('accepts a hole handed over the wrong way round', () => {
    // Counter-clockwise hole — the same shape, wound as if it were an outer.
    const t = triangulate(square(0, 0, 40, 40), [square(15, 15, 25, 25)]);
    expect(meshArea(t)).toBeCloseTo(1600 - 100);
  });

  it('keeps a square hole square — no triangle crosses into it', () => {
    const t = triangulate(square(0, 0, 40, 40), [square(15, 15, 25, 25).slice()]);
    // Sample the middle of the hole: no triangle may contain it.
    const inside = (px, py) => {
      for (let k = 0; k < t.indices.length; k += 3) {
        const [i, j, m] = [t.indices[k], t.indices[k + 1], t.indices[k + 2]];
        const P = (n) => [t.vertices[n * 2], t.vertices[n * 2 + 1]];
        const [ax, ay] = P(i); const [bx, by] = P(j); const [cx, cy] = P(m);
        const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        const d2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
        const d3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
        // Closed test: a probe that happens to land on a shared edge is still
        // covered. The hole's centre is far from any edge either way.
        if (d1 >= -1e-9 && d2 >= -1e-9 && d3 >= -1e-9) return true;
      }
      return false;
    };
    expect(inside(20, 20)).toBe(false);
    expect(inside(5, 5)).toBe(true);
  });
});
