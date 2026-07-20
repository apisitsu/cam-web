/**
 * STL reader — ASCII and binary, into a plain triangle soup.
 *
 * STL is the only geometry format the CAM side ingests: it is a bag of
 * independent triangles with no topology, no units, and no features. Everything
 * downstream (slicing, silhouette profiles, drop-cutter) needs *adjacency*, so
 * `weld()` turns the soup into an indexed mesh by snapping coincident corners
 * together. That weld is what makes a watertight check — and therefore a
 * trustworthy slice — possible at all.
 *
 * Output is plain typed arrays: no three.js, no DOM. The viewport builds a
 * BufferGeometry from these; the CAM engine reads them directly.
 */

/**
 * Binary STL is 80 bytes of header, a uint32 triangle count, then 50 bytes per
 * triangle. Sniffing the leading "solid" keyword is *not* enough — plenty of
 * exporters write that word into the binary header — so the size arithmetic is
 * the real test, and it only ever matches for a genuine binary file.
 */
export function isBinarySTL(buffer) {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  return buffer.byteLength === 84 + count * 50;
}

/** Parse binary STL. Facet normals are read but recomputed by `weld`/`analyze`. */
function parseBinary(buffer) {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 3);
  let o = 84;
  for (let t = 0; t < count; t++) {
    normals[t * 3] = view.getFloat32(o, true);
    normals[t * 3 + 1] = view.getFloat32(o + 4, true);
    normals[t * 3 + 2] = view.getFloat32(o + 8, true);
    o += 12;
    for (let v = 0; v < 9; v++) {
      positions[t * 9 + v] = view.getFloat32(o, true);
      o += 4;
    }
    o += 2; // attribute byte count, unused
  }
  return { positions, normals, triangleCount: count };
}

/**
 * Parse ASCII STL. Scanning for bare `vertex` lines rather than matching the
 * full facet/loop grammar keeps this tolerant of the many hand-rolled writers
 * that indent oddly or omit `endsolid`.
 */
function parseAscii(text) {
  const verts = [];
  const norms = [];
  const RE = /\b(vertex|facet\s+normal)\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  let m;
  while ((m = RE.exec(text)) !== null) {
    const target = m[1].toLowerCase() === 'vertex' ? verts : norms;
    target.push(Number(m[2]), Number(m[3]), Number(m[4]));
  }
  if (verts.length % 9 !== 0) {
    throw new Error(`STL: vertex count ${verts.length / 3} is not a multiple of 3`);
  }
  const triangleCount = verts.length / 9;
  const normals = new Float32Array(triangleCount * 3);
  normals.set(norms.slice(0, triangleCount * 3));
  return { positions: new Float32Array(verts), normals, triangleCount };
}

/**
 * @param {ArrayBuffer|Uint8Array|string} data
 * @returns {{positions: Float32Array, normals: Float32Array, triangleCount: number}}
 *   `positions` is 9 floats per triangle (a soup — corners are not shared).
 */
export function parseSTL(data) {
  if (typeof data === 'string') return parseAscii(data);
  const buffer = data instanceof Uint8Array
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    : data;
  if (isBinarySTL(buffer)) return parseBinary(buffer);
  return parseAscii(new TextDecoder().decode(buffer));
}

/**
 * Weld a triangle soup into an indexed mesh.
 *
 * Corners are quantised onto a grid of `tol` and hashed, so vertices that STL
 * wrote as separate copies of the same point collapse to one index. `tol`
 * defaults to 1e-4 mm — far below any machining tolerance, but coarse enough to
 * absorb the float32 round-off that STL writers leave behind.
 *
 * Snapping to a grid alone would split a pair of points that straddle a cell
 * boundary, so each corner also probes the 26 neighbouring cells and reuses a
 * vertex already found within `tol`.
 *
 * @returns {{positions: Float32Array, indices: Uint32Array, vertexCount: number,
 *   triangleCount: number}}
 */
export function weld(mesh, tol = 1e-4) {
  const { positions, triangleCount } = mesh;
  const inv = 1 / tol;
  const map = new Map();
  const out = [];
  const indices = new Uint32Array(triangleCount * 3);

  const keyOf = (i, j, k) => `${i},${j},${k}`;

  for (let c = 0; c < triangleCount * 3; c++) {
    const x = positions[c * 3], y = positions[c * 3 + 1], z = positions[c * 3 + 2];
    const ci = Math.round(x * inv), cj = Math.round(y * inv), ck = Math.round(z * inv);
    let found = -1;
    for (let di = -1; di <= 1 && found < 0; di++) {
      for (let dj = -1; dj <= 1 && found < 0; dj++) {
        for (let dk = -1; dk <= 1 && found < 0; dk++) {
          const hit = map.get(keyOf(ci + di, cj + dj, ck + dk));
          if (hit === undefined) continue;
          const p = hit * 3;
          if (Math.abs(out[p] - x) <= tol
            && Math.abs(out[p + 1] - y) <= tol
            && Math.abs(out[p + 2] - z) <= tol) found = hit;
        }
      }
    }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      map.set(keyOf(ci, cj, ck), found);
    }
    indices[c] = found;
  }

  return {
    positions: new Float32Array(out),
    indices,
    vertexCount: out.length / 3,
    triangleCount,
  };
}
