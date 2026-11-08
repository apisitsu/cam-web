import { describe, it, expect } from 'vitest';
import { repairSoup } from './repair.js';

const soupOf = (tris) => ({ positions: new Float32Array(tris.flat(2)), triangleCount: tris.length });

/** Directed edges with no partner running the other way: the open edges of a surface. */
function unmatched(soup) {
  const p = soup.positions;
  const key = (i) => `${p[i]},${p[i + 1]},${p[i + 2]}`;
  const edges = new Map();
  for (let t = 0; t < soup.triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const e = `${key(t * 9 + k * 3)}|${key(t * 9 + ((k + 1) % 3) * 3)}`;
      edges.set(e, (edges.get(e) || 0) + 1);
    }
  }
  let n = 0;
  for (const [e, c] of edges) {
    const [a, b] = e.split('|');
    if ((edges.get(`${b}|${a}`) || 0) !== c) n++;
  }
  return n;
}

// A 2×2 square: one triangle on the left of the diagonal, and on the right two
// triangles that meet at the diagonal's midpoint — a T-junction, as a mesh
// boolean leaves them.
const tJunction = [
  [[0, 0, 0], [2, 0, 0], [0, 2, 0]],
  [[2, 0, 0], [2, 2, 0], [1, 1, 0]],
  [[1, 1, 0], [2, 2, 0], [0, 2, 0]],
];

describe('repairSoup', () => {
  it('splits a triangle at a corner left on its edge, closing the crack', () => {
    expect(unmatched(soupOf(tJunction))).toBe(4 + 3); // the rim, and the crack along the diagonal
    const fixed = repairSoup(soupOf(tJunction));
    expect(unmatched(fixed)).toBe(4); // only the square's own rim is open
    expect(fixed.triangleCount).toBe(4);
  });

  it('keeps the area and the facing of what it splits', () => {
    const fixed = repairSoup(soupOf(tJunction));
    let area = 0;
    const p = fixed.positions;
    for (let t = 0; t < fixed.triangleCount; t++) {
      const [ax, ay, , bx, by, , cx, cy] = p.subarray(t * 9, t * 9 + 9);
      const z = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
      expect(z).toBeGreaterThan(0); // still counter-clockwise, still facing +Z
      area += z;
    }
    expect(area).toBeCloseTo(4, 9);
  });

  it('drops a triangle with no area', () => {
    const fixed = repairSoup(soupOf([[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, 0], [1, 0, 0], [2, 0, 0]]]));
    expect(fixed.triangleCount).toBe(1);
  });

  it('leaves a sound mesh as it was', () => {
    const quad = [[[0, 0, 0], [1, 0, 0], [1, 1, 0]], [[0, 0, 0], [1, 1, 0], [0, 1, 0]]];
    const fixed = repairSoup(soupOf(quad));
    expect(Array.from(fixed.positions)).toEqual(quad.flat(2));
  });
});
