/**
 * Can a sketch go on this face?
 *
 * A mesh has no curved faces, only flat facets, so the wall of a bore is a ring
 * of narrow flat strips and `detectPlanarFaces` reports each strip as a face of
 * its own. Offered to Sketch on Face, a click on the bore lit one strip and
 * opened a sketch on its plane — which no CAD would do: a cylinder is not a
 * plane to sketch on.
 *
 * What gives a strip away is its outline. A real face is bounded by edges — the
 * part turns a corner there. A strip of a curved surface is bounded mostly by
 * its neighbouring strips, a few degrees round. So a face is sketchable when
 * most of its outline (by length) is a real edge: at least `SHARP` between it
 * and the face beyond. A flat side running into a fillet still is — only one of
 * its four sides is tangent.
 *
 * Pure, plain arrays. The adjacency is built once per mesh.
 */

/** A turn at least this sharp (degrees) is an edge — `detectSharpEdges`' line. */
const SHARP = 30;

const _adjacency = new WeakMap();

/** Edge "i,j" (low index first) → triangles that have it. */
function adjacency(mesh) {
  const hit = _adjacency.get(mesh);
  if (hit) return hit;
  const map = new Map();
  const ix = mesh.indices;
  for (let t = 0; t < mesh.triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = ix[t * 3 + k];
      const b = ix[t * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let list = map.get(key);
      if (!list) { list = []; map.set(key, list); }
      list.push(t);
    }
  }
  _adjacency.set(mesh, map);
  return map;
}

function normalOf(mesh, t) {
  const p = mesh.positions;
  const ix = mesh.indices;
  const [a, b, c] = [ix[t * 3] * 3, ix[t * 3 + 1] * 3, ix[t * 3 + 2] * 3];
  const ux = p[b] - p[a]; const uy = p[b + 1] - p[a + 1]; const uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a]; const vy = p[c + 1] - p[a + 1]; const vz = p[c + 2] - p[a + 2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

/**
 * Whether `face` (from `detectPlanarFaces` on this welded `mesh`) is a face a
 * sketch can go on, rather than one strip of a curved surface.
 *
 * @param {{positions:Float32Array, indices:Uint32Array, triangleCount:number}} mesh
 * @param {{triangles:number[], normal:number[]}} face
 */
export function isSketchableFace(mesh, face) {
  if (!face?.triangles?.length || !face.normal) return false;
  const adj = adjacency(mesh);
  const inFace = new Set(face.triangles);
  const cosSharp = Math.cos((SHARP * Math.PI) / 180);
  const p = mesh.positions;
  const ix = mesh.indices;
  let edgeLen = 0;
  let smoothLen = 0;
  for (const t of face.triangles) {
    for (let k = 0; k < 3; k++) {
      const a = ix[t * 3 + k];
      const b = ix[t * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const beyond = (adj.get(key) || []).filter((u) => !inFace.has(u));
      if (!beyond.length) continue; // inside the face, or an open boundary
      const len = Math.hypot(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]);
      const n = normalOf(mesh, beyond[0]);
      const cos = n[0] * face.normal[0] + n[1] * face.normal[1] + n[2] * face.normal[2];
      if (cos > cosSharp) smoothLen += len; else edgeLen += len;
    }
  }
  return edgeLen >= smoothLen;
}
