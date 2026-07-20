import { describe, it, expect } from 'vitest';
import { parseSTL, isBinarySTL, weld } from './stl.js';

/** A unit tetrahedron's worth of triangles, as [normal, v0, v1, v2] tuples. */
const TRIS = [
  [[0, 0, -1], [0, 0, 0], [1, 0, 0], [0, 1, 0]],
  [[0, -1, 0], [0, 0, 0], [0, 0, 1], [1, 0, 0]],
  [[-1, 0, 0], [0, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[0.577, 0.577, 0.577], [1, 0, 0], [0, 0, 1], [0, 1, 0]],
];

function asciiSTL(tris, name = 'test') {
  const facets = tris.map(([n, a, b, c]) => `  facet normal ${n.join(' ')}
    outer loop
      vertex ${a.join(' ')}
      vertex ${b.join(' ')}
      vertex ${c.join(' ')}
    endloop
  endfacet`).join('\n');
  return `solid ${name}\n${facets}\nendsolid ${name}\n`;
}

/** @param {string} header 80-byte header text — used to plant a "solid" trap. */
function binarySTL(tris, header = 'binary') {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  bytes.set(new TextEncoder().encode(header).slice(0, 80));
  view.setUint32(80, tris.length, true);
  let o = 84;
  for (const [n, ...vs] of tris) {
    for (const c of n) { view.setFloat32(o, c, true); o += 4; }
    for (const v of vs) for (const c of v) { view.setFloat32(o, c, true); o += 4; }
    o += 2;
  }
  return buf;
}

describe('isBinarySTL', () => {
  it('accepts a well-formed binary buffer', () => {
    expect(isBinarySTL(binarySTL(TRIS))).toBe(true);
  });

  it('is not fooled by a binary file whose header starts with "solid"', () => {
    // The classic STL trap: exporters write "solid" into the 80-byte binary
    // header, so a keyword sniff misreads the file as ASCII.
    const buf = binarySTL(TRIS, 'solid exported-by-some-cad');
    expect(isBinarySTL(buf)).toBe(true);
    expect(parseSTL(buf).triangleCount).toBe(4);
  });

  it('rejects ASCII text', () => {
    const bytes = new TextEncoder().encode(asciiSTL(TRIS));
    expect(isBinarySTL(bytes.buffer)).toBe(false);
  });

  it('rejects a truncated buffer', () => {
    expect(isBinarySTL(new ArrayBuffer(40))).toBe(false);
  });
});

describe('parseSTL', () => {
  it('reads ASCII triangles and normals', () => {
    const m = parseSTL(asciiSTL(TRIS));
    expect(m.triangleCount).toBe(4);
    expect(m.positions).toHaveLength(4 * 9);
    // First facet's three corners, in order.
    expect(Array.from(m.positions.slice(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(m.normals.slice(0, 3))).toEqual([0, 0, -1]);
  });

  it('reads binary triangles identically to ASCII', () => {
    const a = parseSTL(asciiSTL(TRIS));
    const b = parseSTL(binarySTL(TRIS));
    expect(b.triangleCount).toBe(a.triangleCount);
    for (let i = 0; i < a.positions.length; i++) {
      expect(b.positions[i]).toBeCloseTo(a.positions[i], 5);
    }
  });

  it('accepts a Uint8Array view as well as an ArrayBuffer', () => {
    const buf = binarySTL(TRIS);
    expect(parseSTL(new Uint8Array(buf)).triangleCount).toBe(4);
  });

  it('tolerates an ASCII file with no endsolid and odd indentation', () => {
    const text = asciiSTL(TRIS).replace(/endsolid.*/, '').replace(/^ +/gm, '');
    expect(parseSTL(text).triangleCount).toBe(4);
  });

  it('throws when the vertex count is not a whole number of triangles', () => {
    const text = 'solid x\nvertex 0 0 0\nvertex 1 0 0\nendsolid x';
    expect(() => parseSTL(text)).toThrow(/multiple of 3/);
  });

  it('handles an empty solid', () => {
    expect(parseSTL('solid empty\nendsolid empty').triangleCount).toBe(0);
  });
});

describe('weld', () => {
  it('shares corners between adjacent triangles', () => {
    // The tetrahedron has 4 distinct corners across 12 soup vertices.
    const m = weld(parseSTL(asciiSTL(TRIS)));
    expect(m.vertexCount).toBe(4);
    expect(m.triangleCount).toBe(4);
    expect(m.indices).toHaveLength(12);
  });

  it('leaves genuinely distinct corners alone', () => {
    // Two triangles far apart share nothing.
    const far = [
      [[0, 0, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0]],
      [[0, 0, 1], [50, 0, 0], [51, 0, 0], [50, 1, 0]],
    ];
    expect(weld(parseSTL(asciiSTL(far))).vertexCount).toBe(6);
  });

  it('merges corners that straddle a hash-cell boundary', () => {
    // Snapping alone would put these two copies of "the same" point in
    // different cells; the neighbour probe is what rescues them.
    const eps = 3e-5;
    const pair = [
      [[0, 0, 1], [1, 1, 1], [2, 0, 0], [0, 2, 0]],
      [[0, 0, 1], [1 + eps, 1 - eps, 1 + eps], [5, 0, 0], [0, 5, 0]],
    ];
    const m = weld(parseSTL(asciiSTL(pair)), 1e-4);
    expect(m.vertexCount).toBe(5); // not 6
  });

  it('keeps points apart when they are further than the tolerance', () => {
    const pair = [
      [[0, 0, 1], [1, 1, 1], [2, 0, 0], [0, 2, 0]],
      [[0, 0, 1], [1.01, 1, 1], [5, 0, 0], [0, 5, 0]],
    ];
    expect(weld(parseSTL(asciiSTL(pair)), 1e-4).vertexCount).toBe(6);
  });

  it('indices reconstruct the original triangle positions', () => {
    const soup = parseSTL(asciiSTL(TRIS));
    const m = weld(soup);
    for (let c = 0; c < soup.triangleCount * 3; c++) {
      const v = m.indices[c] * 3;
      expect(m.positions[v]).toBeCloseTo(soup.positions[c * 3], 6);
      expect(m.positions[v + 1]).toBeCloseTo(soup.positions[c * 3 + 1], 6);
      expect(m.positions[v + 2]).toBeCloseTo(soup.positions[c * 3 + 2], 6);
    }
  });
});
