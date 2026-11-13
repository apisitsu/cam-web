/**
 * Pattern and Mirror of features in 3D — SolidWorks' Linear Pattern, Circular
 * Pattern and Mirror, done the way the rest of this kernel does things: copy the
 * seed features' own solids (the triangle soup each was built from), move the
 * copies, and boolean them into the part with the seed's own merge (a boss adds,
 * a cut cuts).
 *
 * Pure and three.js-free. A transform is `{ m, t, flip }`: `p' = m·p + t` with
 * `m` a row-major 3×3, and `flip` set when it is a reflection, which turns every
 * triangle inside out unless its winding is reversed.
 */

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Pattern types, in the words on the buttons. */
export const PATTERN_TYPES = {
  linear: 'Linear Pattern',
  circular: 'Circular Pattern',
  mirror: 'Mirror',
};

/** Rotation by `a` radians about the unit axis `u` (Rodrigues). */
function rotation(u, a) {
  const [x, y, z] = u;
  const c = Math.cos(a); const s = Math.sin(a); const k = 1 - c;
  return [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
}

const mul = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
  m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
  m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
];

/**
 * Every copy a pattern feature makes, not counting the seed itself.
 *
 * - linear: `count` along `dir` every `spacing` mm (negative runs backwards), and
 *   optionally `count2` along `dir2` every `spacing2` — a grid.
 * - circular: `count` about `axis` through `center`, spread over `angle` degrees;
 *   360 spaces them equally all the way round, anything less puts the last on the end.
 * - mirror: one copy, reflected in the plane `mirrorPlane` (XY / XZ / YZ) at `mirrorOffset`.
 */
export function patternTransforms(f) {
  const out = [];
  if (f.pattern === 'mirror') {
    const n = { XY: AXES.z, XZ: AXES.y, YZ: AXES.x }[f.mirrorPlane] || AXES.x;
    const m = IDENTITY.map((v, i) => v - 2 * n[Math.floor(i / 3)] * n[i % 3]);
    const t = n.map((v) => 2 * f.mirrorOffset * v);
    out.push({ m, t, flip: true });
    return out;
  }
  if (f.pattern === 'circular') {
    const u = AXES[f.axis] || AXES.z;
    const c = f.center || [0, 0, 0];
    const full = Math.abs(Math.abs(f.angle) - 360) < 1e-9;
    const step = ((f.angle * Math.PI) / 180) / (full ? f.count : Math.max(1, f.count - 1));
    for (let k = 1; k < f.count; k++) {
      const m = rotation(u, k * step);
      const mc = mul(m, c);
      out.push({ m, t: [c[0] - mc[0], c[1] - mc[1], c[2] - mc[2]], flip: false });
    }
    return out;
  }
  const d1 = AXES[f.dir] || AXES.x;
  const d2 = f.dir2 ? AXES[f.dir2] : null;
  const n2 = d2 ? f.count2 : 1;
  for (let i = 0; i < f.count; i++) {
    for (let j = 0; j < n2; j++) {
      if (!i && !j) continue;
      const t = [0, 1, 2].map((k) => i * f.spacing * d1[k] + (d2 ? j * f.spacing2 * d2[k] : 0));
      out.push({ m: IDENTITY, t, flip: false });
    }
  }
  return out;
}

/** A soup moved by a transform; a reflection has its winding reversed so it stays outward. */
export function transformSoup(soup, { m, t, flip }) {
  const p = soup.positions;
  const q = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 9) {
    for (let v = 0; v < 3; v++) {
      const src = i + 3 * (flip && v ? 3 - v : v);
      const [x, y, z] = mul(m, [p[src], p[src + 1], p[src + 2]]);
      q[i + 3 * v] = x + t[0];
      q[i + 3 * v + 1] = y + t[1];
      q[i + 3 * v + 2] = z + t[2];
    }
  }
  return { ...soup, positions: q };
}

/** A Hole feature's CAM record moved with its copy. */
export function transformHole(h, { m, t }) {
  const at = mul(m, h.at);
  return { ...h, at: [at[0] + t[0], at[1] + t[1], at[2] + t[2]], axis: mul(m, h.axis) };
}
