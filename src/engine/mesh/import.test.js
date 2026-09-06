import { describe, it, expect } from 'vitest';
import {
  parsePart, detectFormat, extensionOf, PART_FORMATS, PART_ACCEPT,
} from './import.js';
import { parseOBJ, looksLikeOBJ } from './obj.js';
import { parsePLY, looksLikePLY } from './ply.js';
import { boundsOf } from './analyze.js';
import { weld } from './stl.js';
import { detectPlanarFaces } from './features.js';
import { box } from './fixtures.js';

/** The fixture box, written out as each format, so all three describe one part. */
const BOX = box(60, 40, 20);

function binarySTL(soup) {
  const buf = new ArrayBuffer(84 + soup.triangleCount * 50);
  const view = new DataView(buf);
  view.setUint32(80, soup.triangleCount, true);
  let o = 84;
  for (let t = 0; t < soup.triangleCount; t++) {
    o += 12;
    for (let v = 0; v < 9; v++) { view.setFloat32(o, soup.positions[t * 9 + v], true); o += 4; }
    o += 2;
  }
  return buf;
}

function asciiSTL(soup) {
  let out = 'solid fixture\n';
  for (let t = 0; t < soup.triangleCount; t++) {
    out += 'facet normal 0 0 0\n  outer loop\n';
    for (let v = 0; v < 3; v++) {
      const b = t * 9 + v * 3;
      out += `    vertex ${soup.positions[b]} ${soup.positions[b + 1]} ${soup.positions[b + 2]}\n`;
    }
    out += '  endloop\nendfacet\n';
  }
  return `${out}endsolid fixture\n`;
}

/** OBJ with shared vertices, which is the whole point of the format. */
function objText(soup) {
  const keys = new Map();
  const verts = [];
  const faces = [];
  for (let t = 0; t < soup.triangleCount; t++) {
    const corner = [];
    for (let v = 0; v < 3; v++) {
      const b = t * 9 + v * 3;
      const p = [soup.positions[b], soup.positions[b + 1], soup.positions[b + 2]];
      const key = p.join(',');
      if (!keys.has(key)) { keys.set(key, verts.length + 1); verts.push(p); }
      corner.push(keys.get(key));
    }
    faces.push(corner);
  }
  return [
    '# fixture',
    ...verts.map((p) => `v ${p[0]} ${p[1]} ${p[2]}`),
    ...faces.map((f) => `f ${f[0]}// ${f[1]}// ${f[2]}//`),
  ].join('\n');
}

function asciiPLY(soup) {
  const keys = new Map();
  const verts = [];
  const faces = [];
  for (let t = 0; t < soup.triangleCount; t++) {
    const corner = [];
    for (let v = 0; v < 3; v++) {
      const b = t * 9 + v * 3;
      const p = [soup.positions[b], soup.positions[b + 1], soup.positions[b + 2]];
      const key = p.join(',');
      if (!keys.has(key)) { keys.set(key, verts.length); verts.push(p); }
      corner.push(keys.get(key));
    }
    faces.push(corner);
  }
  return [
    'ply', 'format ascii 1.0',
    `element vertex ${verts.length}`,
    'property float x', 'property float y', 'property float z',
    `element face ${faces.length}`,
    'property list uchar int vertex_indices',
    'end_header',
    ...verts.map((p) => p.join(' ')),
    ...faces.map((f) => `3 ${f.join(' ')}`),
  ].join('\n');
}

/** Binary little-endian PLY, with a colour per vertex to exercise the stride. */
function binaryPLY(soup) {
  const keys = new Map();
  const verts = [];
  const faces = [];
  for (let t = 0; t < soup.triangleCount; t++) {
    const corner = [];
    for (let v = 0; v < 3; v++) {
      const b = t * 9 + v * 3;
      const p = [soup.positions[b], soup.positions[b + 1], soup.positions[b + 2]];
      const key = p.join(',');
      if (!keys.has(key)) { keys.set(key, verts.length); verts.push(p); }
      corner.push(keys.get(key));
    }
    faces.push(corner);
  }
  const header = [
    'ply', 'format binary_little_endian 1.0',
    `element vertex ${verts.length}`,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue',
    `element face ${faces.length}`,
    'property list uchar int vertex_indices',
    'end_header', '',
  ].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const body = new ArrayBuffer(verts.length * 15 + faces.length * 13);
  const view = new DataView(body);
  let o = 0;
  for (const p of verts) {
    view.setFloat32(o, p[0], true); o += 4;
    view.setFloat32(o, p[1], true); o += 4;
    view.setFloat32(o, p[2], true); o += 4;
    view.setUint8(o, 200); o += 1;
    view.setUint8(o, 100); o += 1;
    view.setUint8(o, 50); o += 1;
  }
  for (const f of faces) {
    view.setUint8(o, 3); o += 1;
    for (const i of f) { view.setInt32(o, i, true); o += 4; }
  }
  const out = new Uint8Array(headerBytes.length + body.byteLength);
  out.set(headerBytes);
  out.set(new Uint8Array(body), headerBytes.length);
  return out;
}

const FILES = {
  'binary STL': { data: binarySTL(BOX), name: 'part.stl', format: 'stl' },
  'ASCII STL': { data: asciiSTL(BOX), name: 'part.stl', format: 'stl' },
  OBJ: { data: objText(BOX), name: 'part.obj', format: 'obj' },
  'ASCII PLY': { data: asciiPLY(BOX), name: 'part.ply', format: 'ply' },
  'binary PLY': { data: binaryPLY(BOX), name: 'part.ply', format: 'ply' },
};

const asBytes = (d) => (typeof d === 'string' ? new TextEncoder().encode(d) : d);

describe('every format describes the same part', () => {
  for (const [label, file] of Object.entries(FILES)) {
    it(`reads ${label} as the same 60 × 40 × 20 box`, () => {
      const soup = parsePart(asBytes(file.data), file.name);
      expect(soup.format).toBe(file.format);
      expect(soup.triangleCount).toBe(12);
      const size = boundsOf(soup).size;
      expect(size[0]).toBeCloseTo(60, 3);
      expect(size[1]).toBeCloseTo(40, 3);
      expect(size[2]).toBeCloseTo(20, 3);
    });

    it(`gives ${label} a mesh the rest of the engine can use`, () => {
      // The real contract: whatever the format, the CAM side must not be able
      // to tell. Six faces recovered means welding and features both worked.
      const soup = parsePart(asBytes(file.data), file.name);
      const { faces } = detectPlanarFaces(weld(soup));
      expect(faces).toHaveLength(6);
      expect(faces.some((f) => f.facing === 'up')).toBe(true);
    });
  }
});

describe('detectFormat', () => {
  it('identifies each format from its content', () => {
    for (const file of Object.values(FILES)) {
      expect(detectFormat(asBytes(file.data), file.name)).toBe(file.format);
    }
  });

  it('believes the bytes over the extension', () => {
    // People rename files. An OBJ called .stl is still an OBJ, and reading it
    // as a binary STL would produce coordinates out of the header bytes.
    expect(detectFormat(asBytes(objText(BOX)), 'actually-an-obj.stl')).toBe('obj');
    expect(detectFormat(asBytes(asciiPLY(BOX)), 'mislabelled.stl')).toBe('ply');
  });

  it('returns null for something that is not a mesh at all', () => {
    expect(detectFormat(new TextEncoder().encode('hello world'), 'notes.txt')).toBeNull();
    expect(detectFormat(new Uint8Array(0), 'empty.stl')).toBeNull();
  });
});

describe('parsePart', () => {
  it('names the formats it can read when it refuses one', () => {
    expect(() => parsePart(new TextEncoder().encode('nope'), 'drawing.step'))
      .toThrow(/\.step is not a part format/);
    expect(() => parsePart(new TextEncoder().encode('nope'), 'drawing.step'))
      .toThrow(/\.stl/);
  });

  it('refuses an empty mesh rather than returning one', () => {
    const empty = 'ply\nformat ascii 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nelement face 0\nproperty list uchar int vertex_indices\nend_header\n';
    expect(() => parsePart(new TextEncoder().encode(empty), 'empty.ply')).toThrow(/point cloud|no triangles/);
  });
});

describe('OBJ specifics', () => {
  it('handles negative (relative) indices', () => {
    // -1 means "the vertex most recently defined". Read as positive it picks
    // the wrong corner and the mesh looks almost right.
    const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n';
    const soup = parseOBJ(obj);
    expect(soup.triangleCount).toBe(1);
    expect(Array.from(soup.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('fans an n-sided face into triangles', () => {
    const quad = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n';
    expect(parseOBJ(quad).triangleCount).toBe(2);
  });

  it('reads every index form', () => {
    for (const f of ['f 1 2 3', 'f 1/1 2/2 3/3', 'f 1//1 2//2 3//3', 'f 1/1/1 2/2/2 3/3/3']) {
      const soup = parseOBJ(`v 0 0 0\nv 1 0 0\nv 0 1 0\n${f}\n`);
      // eslint-disable-next-line jest/valid-expect
      expect(soup.triangleCount, f).toBe(1);
    }
  });

  it('ignores comments, blank lines and everything that is not geometry', () => {
    const obj = [
      '# a comment', '', 'mtllib part.mtl', 'o Cube', 'usemtl steel',
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
      'vt 0 0', 'vn 0 0 1', 's off',
      'f 1 2 3',
    ].join('\n');
    expect(parseOBJ(obj).triangleCount).toBe(1);
  });

  it('drops a face that points outside the vertex list', () => {
    // A truncated download should lose a triangle, not crash or emit NaN.
    const soup = parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\nf 1 2 99\n');
    expect(soup.triangleCount).toBe(1);
    expect(Array.from(soup.positions).every(Number.isFinite)).toBe(true);
  });

  it('is not fooled into claiming a binary file', () => {
    expect(looksLikeOBJ(new Uint8Array(binarySTL(BOX)))).toBe(false);
  });
});

describe('PLY specifics', () => {
  it('reads coordinates correctly past other vertex properties', () => {
    // A vertex with colours has six properties; reading it as three shears the
    // whole model, and it still looks like a model.
    const soup = parsePLY(binaryPLY(BOX));
    const size = boundsOf(soup).size;
    expect(size[0]).toBeCloseTo(60, 3);
    expect(size[2]).toBeCloseTo(20, 3);
  });

  it('refuses big-endian rather than reading it as little-endian', () => {
    // Read the wrong way round these become 1e38-scale coordinates, which would
    // pass as "a very large part".
    const bad = 'ply\nformat binary_big_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n';
    expect(() => parsePLY(new TextEncoder().encode(bad))).toThrow(/big-endian/i);
  });

  it('refuses a point cloud by name', () => {
    const cloud = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 1 1\n';
    expect(() => parsePLY(new TextEncoder().encode(cloud))).toThrow(/point cloud/);
  });

  it('complains about a header it cannot find the end of', () => {
    expect(() => parsePLY(new TextEncoder().encode('ply\nformat ascii 1.0\n'))).toThrow(/end_header/);
  });

  it('recognises its own magic', () => {
    expect(looksLikePLY(new TextEncoder().encode('ply\n'))).toBe(true);
    expect(looksLikePLY(new Uint8Array(binarySTL(BOX)))).toBe(false);
  });
});

describe('the advertised format list', () => {
  it('offers only extensions something can actually read', () => {
    for (const f of PART_FORMATS) {
      expect(f.extensions.length).toBeGreaterThan(0);
      expect(f.note.length).toBeGreaterThan(10);
    }
    expect(PART_ACCEPT).toBe('.stl,.obj,.ply');
  });

  it('extracts an extension the way the dispatcher does', () => {
    expect(extensionOf('part.STL')).toBe('.stl');
    expect(extensionOf('my.part.v2.obj')).toBe('.obj');
    expect(extensionOf('noextension')).toBe('');
  });
});
