import { describe, it, expect } from 'vitest';
import { weld } from './stl.js';

// Two triangles sharing an edge, written as a soup (each corner stored separately).
const soup = (corners) => ({
  positions: Float32Array.from(corners.flat()),
  normals: new Float32Array(corners.length / 3 * 3),
  triangleCount: corners.length / 3,
});

describe('weld', () => {
  it('collapses exact copies of a corner to one vertex', () => {
    const w = weld(soup([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]));
    expect(w.vertexCount).toBe(4);
    expect(w.indices[1]).toBe(w.indices[3]); // (1,0,0) written twice
    expect(w.indices[2]).toBe(w.indices[5]); // (0,1,0) written twice
  });

  it('collapses corners that differ by less than the tolerance, even across a grid-cell boundary', () => {
    // 5e-5 apart with tol 1e-4: they quantise into different cells but are one point.
    const a = 0.49995e-4;
    const w = weld(soup([[a, 0, 0], [1, 0, 0], [0, 1, 0], [a + 5e-5, 0, 0], [1, 1, 0], [0, 1, 0]]));
    expect(w.indices[0]).toBe(w.indices[3]);
  });

  it('keeps corners that are further apart than the tolerance', () => {
    const w = weld(soup([[0, 0, 0], [1, 0, 0], [0, 1, 0], [3e-4, 0, 0], [1, 1, 0], [0, 1, 0]]));
    expect(w.indices[0]).not.toBe(w.indices[3]);
  });

  it('welds a large soup quickly and the same way every time', () => {
    const n = 400;
    const corners = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      corners.push([i, j, 0], [i + 1, j, 0], [i, j + 1, 0], [i + 1, j, 0], [i + 1, j + 1, 0], [i, j + 1, 0]);
    }
    const a = weld(soup(corners));
    const b = weld(soup(corners));
    expect(a.vertexCount).toBe((n + 1) * (n + 1));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });
});
