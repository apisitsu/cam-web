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
 * A frame whose X axis is a line drawn on the sketch — what a revolve about a
 * centerline needs. The revolve itself only knows how to turn about a frame's own
 * X axis, so the profile is re-expressed in this frame (`local`) and built on its
 * plane (`plane`), which is the sketch's plane turned in itself and moved to the
 * line. Same plane, same facing; only the in-plane axes differ.
 *
 * @param {object} plane  the sketch's plane
 * @param {number[]} a  the line's start, sketch (x, y)
 * @param {number[]} b  the line's end
 * @returns {{plane: object, local: (x:number, y:number) => number[]}}
 */
export function lineFrame(plane, a, b) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(len > 1e-12)) throw new Error('A centerline of no length is no axis.');
  const cx = (b[0] - a[0]) / len;
  const cy = (b[1] - a[1]) / len;
  const { u, v } = planeBasis(plane);
  return {
    plane: {
      origin: planeToWorld(plane, a[0], a[1]),
      u: add(scale(u, cx), scale(v, cy)),
      v: add(scale(u, -cy), scale(v, cx)),
    },
    local: (x, y) => [(x - a[0]) * cx + (y - a[1]) * cy, -(x - a[0]) * cy + (y - a[1]) * cx],
  };
}

/**
 * The world box round a box drawn in sketch (x, y), wherever its plane sits — what
 * a camera fit needs. `null` in, `null` out.
 *
 * @param {object} plane
 * @param {{min:number[], max:number[]}|null} box  sketch-space; only x and y are read
 */
export function boundsOnPlane(plane, box) {
  if (!box) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      const p = planeToWorld(plane, x, y);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
  }
  return { min, max };
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
      return { preset, offset: Math.round(dot(o, p.n) * 1e6) / 1e6, gap: 0 };
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
    gap: 0,
  };
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/**
 * A **face link**: "this plane is the `side` end of feature `featureId`'s own
 * solid along `axis`". It rides on the plane next to the resolved numbers, which
 * stay as the fallback — see `resolvePlaneRef`.
 *
 * Only axis-aligned faces can be linked. That is not a shortcut around the hard
 * problem, it is the part of it that is not hard: "the top of that extrude" and
 * "the floor of that pocket" name an end of a bounding box, which is stable under
 * every edit that moves the face, while "the seventh face of the body" is the
 * reference that silently re-binds to the wrong one. Angled faces keep the
 * numbers they always had.
 *
 * @typedef {{featureId:number, axis:'x'|'y'|'z', side:'min'|'max'}} PlaneRef
 */

const TOUCH_TOL = 1e-3; // mm — float noise from tessellation, not design tolerance

/**
 * Work out which feature's solid a picked face is an end of, if any.
 *
 * @param {{normal:number[], centroid:number[], bounds?:{min:number[],max:number[]}}} face
 * @param {{id:number, bounds:{min:number[],max:number[]}, cut?:boolean}[]} solids
 *   each feature's **own** solid (not the running part), in tree order
 * @returns {PlaneRef|null}
 *
 * Three rules that are not obvious:
 * - **A cut's faces point the other way.** A pocket floor faces up, but it is the
 *   *bottom* of the tool that carved it, so for a cut the normal's sign selects
 *   the opposite end of the tool's bounds.
 * - **The face must lie within the solid's extent** across the other two axes. A
 *   coplanar face of some other body is not this feature's face.
 * - **The latest feature that fits wins**: it is the one that most plausibly
 *   produced the surface the operator is looking at.
 */
export function linkFaceToSolids(face, solids, { tol = TOUCH_TOL } = {}) {
  if (!face?.normal || !face?.centroid || !Array.isArray(solids)) return null;
  const n = norm(face.normal);
  let axis = null;
  for (const a of ['x', 'y', 'z']) {
    if (Math.abs(n[AXIS_INDEX[a]]) > 1 - 1e-6) axis = a;
  }
  if (!axis) return null;
  const k = AXIS_INDEX[axis];
  const facesPositive = n[k] > 0;
  const fb = face.bounds;

  for (let i = solids.length - 1; i >= 0; i--) {
    const s = solids[i];
    if (!s?.bounds) continue;
    const side = (facesPositive !== !!s.cut) ? 'max' : 'min';
    if (Math.abs(face.centroid[k] - s.bounds[side][k]) > tol) continue;
    let inside = true;
    for (let j = 0; j < 3; j++) {
      if (j === k) continue;
      const lo = fb ? fb.min[j] : face.centroid[j];
      const hi = fb ? fb.max[j] : face.centroid[j];
      if (lo < s.bounds.min[j] - tol || hi > s.bounds.max[j] + tol) { inside = false; break; }
    }
    if (inside) return { featureId: s.id, axis, side };
  }
  return null;
}

/**
 * Move a linked plane to where its feature's face is now.
 *
 * Returns the **same object** when nothing needs to move — no link, no bounds
 * for that feature (it is suppressed, failed, or comes later in the tree), or
 * the face has not moved — so callers can tell "changed" by identity and a
 * rebuild that changed nothing writes nothing. An unresolvable link falls back to
 * the stored numbers, which is exactly what the plane did before links existed.
 *
 * @param {object} plane
 * @param {Map<number, {min:number[],max:number[]}>} boundsById
 */
export function resolvePlaneRef(plane, boundsById) {
  const ref = plane?.ref;
  const b = ref && boundsById?.get(ref.featureId);
  if (!b) return plane;
  const k = AXIS_INDEX[ref.axis];
  const coord = b[ref.side][k];
  if (!Number.isFinite(coord)) return plane;
  // An offset plane stays the same distance off the face (`withGap`).
  const gap = Number.isFinite(plane.gap) ? plane.gap : 0;

  if (plane.u && plane.v) {
    // A custom frame (a −Z/−X/+Y face, which no preset covers): slide its origin
    // along the axis; its u and v are already the face's own.
    const origin = plane.origin ? [...plane.origin] : [0, 0, 0];
    const at = coord + planeBasis(plane).n[k] * gap;
    if (Math.abs(origin[k] - at) < 1e-9) return plane;
    origin[k] = at;
    return { ...plane, origin };
  }
  const preset = PLANE_PRESETS[plane.preset];
  if (!preset || Math.abs(preset.n[k]) < 0.5) return plane; // link disagrees with the plane
  // The offset is measured along the preset's normal, which is −Y for Front.
  const offset = Math.round((preset.n[k] * coord + gap) * 1e6) / 1e6;
  if (Math.abs((plane.offset || 0) - offset) < 1e-9) return plane;
  return { ...plane, offset };
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
  // A face link is optional and additive: a file saved before links existed has
  // none and opens exactly as it did. A malformed one is dropped, not repaired —
  // the plane's own numbers are still right as of the last rebuild.
  const r = raw.ref;
  const ref = r && Number.isFinite(r.featureId) && AXIS_INDEX[r.axis] !== undefined
    && (r.side === 'min' || r.side === 'max')
    ? { featureId: Number(r.featureId), axis: r.axis, side: r.side }
    : null;
  // How far off the face a plane made from one sits (see `withGap`).
  const gap = Number.isFinite(raw.gap) ? Number(raw.gap) : null;
  if (u && v) {
    const plane = { origin: vec3(raw.origin) || [0, 0, 0], u, v };
    if (ref) plane.ref = ref;
    if (gap != null) plane.gap = gap;
    // A custom plane may carry the name it was made under ("On face · up"), so
    // a reopened project still says where the sketch came from rather than
    // "Custom". Kept only when it is a string, like every other parsed field.
    if (typeof raw.name === 'string' && raw.name.trim()) plane.name = raw.name;
    return plane;
  }
  const preset = PLANE_PRESETS[raw.preset] ? raw.preset : 'XY';
  const plane = { preset, offset: Number.isFinite(raw.offset) ? Number(raw.offset) : 0 };
  if (ref) plane.ref = ref;
  if (gap != null) plane.gap = gap;
  return plane;
}

/**
 * The plane `gap` mm off the face it was made from, along its normal — an offset
 * reference plane, as SolidWorks makes one from a face. Positive stands it off the
 * part, negative sinks it in.
 *
 * Only a plane made from a face has a gap (`planeFromFace` starts it at 0); the
 * plane's numbers move by the change, and the gap is kept beside them so a face
 * link that moves the face later moves the plane to the same distance off it
 * (`resolvePlaneRef`).
 */
export function withGap(plane, gap) {
  const was = Number.isFinite(plane?.gap) ? plane.gap : 0;
  const delta = (Number.isFinite(gap) ? gap : 0) - was;
  const out = { ...plane, gap: was + delta };
  if (plane.u && plane.v) {
    const { origin, n } = planeBasis(plane);
    out.origin = add(origin, scale(n, delta));
  } else {
    out.offset = Math.round(((plane.offset || 0) + delta) * 1e6) / 1e6;
  }
  return out;
}
