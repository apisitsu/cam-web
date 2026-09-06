/**
 * The plane a sketch is drawn on.
 *
 * Until now there was one sketch and it lived on the machine table: the layer
 * mapped sketch (x, y) straight to world (x, y, 0) and said so. That is the only
 * thing standing between a 2D sketcher and a 3D one — a solid needs a profile on
 * the front, or on a face 12 mm up, not just on the table.
 *
 * A plane is **serializable data**, not a matrix: a named standard plane plus an
 * offset along its normal, or an explicit origin and two axes for anything else.
 * That keeps a saved project readable and lets a preset stay a preset when it is
 * reopened. The matrix is derived (`planeMatrix`) for the one consumer that
 * needs it, the R3F layer.
 *
 * Convention follows the scene: **Z-up, the machine table at Z = 0**, and each
 * preset is right-handed (u × v = n) so a profile wound counter-clockwise in
 * sketch coordinates stays counter-clockwise seen from the front of its plane.
 * Pure — no three.js, no DOM, plain arrays throughout.
 */

/**
 * The three standard planes, by the face they read as on a machine:
 * Top is the table, Front looks along −Y, Right looks along +X.
 */
export const PLANE_PRESETS = {
  XY: { label: 'Top (XY)', u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  XZ: { label: 'Front (XZ)', u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
  YZ: { label: 'Right (YZ)', u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] },
};

/** The plane a new sketch lands on: the machine table. */
export const DEFAULT_PLANE = { preset: 'XY', offset: 0 };

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => {
  const len = Math.hypot(a[0], a[1], a[2]);
  return len > 1e-12 ? scale(a, 1 / len) : [0, 0, 1];
};

/**
 * Resolve a plane to an orthonormal frame `{ origin, u, v, n }`.
 *
 * A custom plane's axes are re-orthonormalised rather than trusted: `v` is
 * squared up against `u` (Gram-Schmidt) and `n` recomputed from the pair, so a
 * hand-edited project file with axes a degree out of square cannot skew every
 * coordinate that passes through it. An unknown preset falls back to the table
 * instead of throwing — a sketch that opens on the wrong plane can be moved, one
 * that fails to open is gone.
 */
export function planeBasis(plane) {
  const p = plane || DEFAULT_PLANE;
  if (p.u && p.v) {
    const u = norm(p.u);
    const v = norm(sub(p.v, scale(u, dot(p.v, u))));
    return { origin: p.origin ? [...p.origin] : [0, 0, 0], u, v, n: cross(u, v) };
  }
  const preset = PLANE_PRESETS[p.preset] || PLANE_PRESETS.XY;
  const offset = Number.isFinite(p.offset) ? p.offset : 0;
  return {
    origin: p.origin ? [...p.origin] : scale(preset.n, offset),
    u: [...preset.u],
    v: [...preset.v],
    n: [...preset.n],
  };
}

/** Sketch (x, y) → world [X, Y, Z]. */
export function planeToWorld(plane, x, y) {
  const { origin, u, v } = planeBasis(plane);
  return add(origin, add(scale(u, x), scale(v, y)));
}

/**
 * World [X, Y, Z] → sketch { x, y, off }, where `off` is the signed distance off
 * the plane. Callers that pick on the plane can ignore `off`; one measuring a
 * point in space needs to know how far from the plane it was.
 */
export function worldToPlane(plane, p) {
  const { origin, u, v, n } = planeBasis(plane);
  const d = sub(p, origin);
  return { x: dot(d, u), y: dot(d, v), off: dot(d, n) };
}

/**
 * The plane's frame as a **column-major 16-element** array — the order
 * `THREE.Matrix4.fromArray` and `matrixAutoUpdate = false` want. Columns are
 * u, v, n, origin, so applying it to a group makes local (x, y, 0) render at
 * `planeToWorld(x, y)` and the whole existing 2D layer draw on the plane
 * untouched.
 */
export function planeMatrix(plane) {
  const { origin, u, v, n } = planeBasis(plane);
  return [
    u[0], u[1], u[2], 0,
    v[0], v[1], v[2], 0,
    n[0], n[1], n[2], 0,
    origin[0], origin[1], origin[2], 1,
  ];
}

/**
 * The plane of a picked face — "sketch on this face", the way any CAD starts a
 * feature on an existing part.
 *
 * Two outcomes, and the split matters to the operator rather than to the maths.
 * A face that lies along a **standard plane** comes back *as* that preset with
 * an offset: a pocket floor 12 mm up reads "Top (XY) +12", its axes are the
 * machine's, and a dimension typed on it means what the same dimension meant on
 * the table. Only a genuinely angled face becomes a custom frame.
 *
 * `u` for a custom frame is derived from the world axis **least** aligned with
 * the normal — any perpendicular is as good geometrically, and the least-aligned
 * one is the numerically stable choice (crossing with a nearly-parallel axis
 * gives a vector of almost no length, whose direction is then noise).
 *
 * @param {{normal:number[], centroid:number[], facing?:string}} face
 *   a merged face from `engine/mesh/features.js`
 */
export function planeFromFace(face, { snapTol = 1e-6 } = {}) {
  if (!face?.normal || !face?.centroid) return { ...DEFAULT_PLANE };
  const n = norm(face.normal);
  const o = face.centroid;

  for (const [preset, p] of Object.entries(PLANE_PRESETS)) {
    if (dot(n, p.n) > 1 - snapTol) {
      // Round the offset: a centroid carries float noise from the triangle
      // areas it was weighted by, and "Top (XY) +12" beats "+11.999999997".
      return { preset, offset: Math.round(dot(o, p.n) * 1e6) / 1e6 };
    }
  }

  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let ref = axes[0];
  let least = Infinity;
  for (const a of axes) {
    const d = Math.abs(dot(a, n));
    if (d < least) { least = d; ref = a; }
  }
  const u = norm(cross(ref, n));
  return {
    origin: [...o],
    u,
    v: cross(n, u),
    name: face.facing ? `On face · ${face.facing}` : 'On face',
  };
}

/** A short human label — what the sketch list and the plane picker show. */
export function planeLabel(plane) {
  const p = plane || DEFAULT_PLANE;
  if (p.u && p.v) return p.name || 'Custom';
  const preset = PLANE_PRESETS[p.preset] || PLANE_PRESETS.XY;
  const offset = Number.isFinite(p.offset) ? p.offset : 0;
  return offset ? `${preset.label} ${offset > 0 ? '+' : ''}${offset}` : preset.label;
}

/**
 * Validate a plane read from a file. Anything unrecognised comes back as the
 * default rather than as itself — see `planeBasis` on why a bad plane must not
 * be able to fail the open.
 */
export function parsePlane(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PLANE };
  const vec3 = (a) => (Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a.map(Number) : null);
  const u = vec3(raw.u);
  const v = vec3(raw.v);
  if (u && v) {
    const plane = { origin: vec3(raw.origin) || [0, 0, 0], u, v };
    // A custom plane may carry the name it was made under ("On face · up"), so
    // a reopened project still says where the sketch came from rather than
    // "Custom". Kept only when it is a string, like every other parsed field.
    if (typeof raw.name === 'string' && raw.name.trim()) plane.name = raw.name;
    return plane;
  }
  const preset = PLANE_PRESETS[raw.preset] ? raw.preset : 'XY';
  return { preset, offset: Number.isFinite(raw.offset) ? Number(raw.offset) : 0 };
}
