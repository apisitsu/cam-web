/**
 * Wavefront OBJ reader.
 *
 * The second most common way a part arrives after STL, and unlike STL it can
 * carry more than one object, real vertex sharing, and polygons with more than
 * three sides. Only the geometry is read: materials, texture coordinates,
 * smoothing groups and object names describe how to *render* a model, and
 * nothing downstream of here renders anything.
 *
 * Two details that are easy to get wrong and expensive to get wrong:
 *
 * - **Indices are 1-based**, and may be **negative**, meaning "counted back
 *   from the most recent vertex". A negative index read as positive silently
 *   picks the wrong corner and produces a mesh that looks almost right.
 * - **Faces may be n-sided.** They are fanned into triangles, which is correct
 *   for the convex, planar faces a CAD export produces and is the same
 *   assumption every OBJ loader makes.
 *
 * Output matches `parseSTL`: an unshared triangle soup, so `weld` and
 * everything after it work unchanged.
 *
 * Pure functions. No three.js, no store, no DOM.
 */

/**
 * @param {ArrayBuffer|string} data
 * @returns {{positions: Float32Array, triangleCount: number}}
 */
export function parseOBJ(data) {
  const text = typeof data === 'string'
    ? data
    : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data));

  const vx = [];
  const vy = [];
  const vz = [];
  const out = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    // Comments and everything that is not geometry.
    if (line.length === 0 || line[0] === '#') continue;

    const space = line.indexOf(' ');
    if (space < 0) continue;
    const keyword = line.slice(0, space);

    if (keyword === 'v') {
      const parts = line.slice(space + 1).trim().split(/\s+/);
      // A `v` may carry w and colour after xyz; only the first three matter.
      vx.push(Number(parts[0]));
      vy.push(Number(parts[1]));
      vz.push(Number(parts[2]));
      continue;
    }

    if (keyword !== 'f') continue;

    const corners = line.slice(space + 1).trim().split(/\s+/);
    if (corners.length < 3) continue;

    // "v", "v/vt", "v//vn" and "v/vt/vn" all put the position index first.
    const resolve = (corner) => {
      const i = Number(corner.split('/')[0]);
      if (!Number.isFinite(i) || i === 0) return -1;
      return i > 0 ? i - 1 : vx.length + i;
    };

    const a = resolve(corners[0]);
    for (let k = 1; k + 1 < corners.length; k++) {
      const b = resolve(corners[k]);
      const c = resolve(corners[k + 1]);
      if (a < 0 || b < 0 || c < 0) continue;
      if (a >= vx.length || b >= vx.length || c >= vx.length) continue;
      out.push(
        vx[a], vy[a], vz[a],
        vx[b], vy[b], vz[b],
        vx[c], vy[c], vz[c],
      );
    }
  }

  return {
    positions: new Float32Array(out),
    triangleCount: out.length / 9,
  };
}

/** True when the bytes look like an OBJ rather than something binary. */
export function looksLikeOBJ(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const head = new TextDecoder().decode(bytes.subarray(0, 2048));
  // A vertex line is the one thing every OBJ has and no other format starts
  // with; checking for it beats checking the extension when both are available.
  return /^\s*v\s+-?[\d.]/m.test(head);
}
