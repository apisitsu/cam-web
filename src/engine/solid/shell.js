/**
 * Shell — hollow the part out to a wall `thickness`, leaving chosen faces open.
 *
 * On a triangle mesh there is no surface to offset, so the inside is made from the
 * part itself: every vertex is moved so that each **plane** it touches comes in by
 * the thickness (least squares over the distinct face planes at that vertex,
 * which is exact where three planes meet and close on a faceted curve). The faces
 * picked as open are moved *out* instead, so the inner body pokes through them.
 * The part minus that inner body is the shell.
 *
 * Stated limits: a wall thinner than twice the thickness, or a feature smaller
 * than it, folds the inner body over itself and the result is not to be trusted;
 * one thickness for every wall.
 *
 * Pure and three.js-free; the boolean is injected like everywhere in `solid/`.
 */
import { weld } from '../mesh/stl.js';

/** Normals closer than this (cosine) are one plane at a vertex. */
const SAME_PLANE = 0.99999;
/** How far an open face is pushed out past the part, beyond the thickness. */
const OPEN_PAST = 1;

/** A picked face, as kept on the feature: its plane, and where it was. */
export function openFaceRef(face) {
  if (!face?.normal) return null;
  return {
    normal: face.normal.map((v) => Number(v.toFixed(6))),
    plane: Number(face.plane.toFixed(6)),
    min: face.bounds?.min?.map((v) => Number(v.toFixed(4))) ?? null,
    max: face.bounds?.max?.map((v) => Number(v.toFixed(4))) ?? null,
  };
}

export function parseOpenFace(raw) {
  if (!raw || !Array.isArray(raw.normal) || raw.normal.length !== 3 || !Number.isFinite(raw.plane)) return null;
  return {
    normal: raw.normal.map(Number),
    plane: Number(raw.plane),
    min: Array.isArray(raw.min) ? raw.min.map(Number) : null,
    max: Array.isArray(raw.max) ? raw.max.map(Number) : null,
  };
}

function solve3(A, b) {
  const [a, c, d, e, f, g, h, i, j] = A;
  const det = a * (f * j - g * i) - c * (e * j - g * h) + d * (e * i - f * h);
  if (Math.abs(det) < 1e-18) return [0, 0, 0];
  const x = (b[0] * (f * j - g * i) - c * (b[1] * j - g * b[2]) + d * (b[1] * i - f * b[2])) / det;
  const y = (a * (b[1] * j - g * b[2]) - b[0] * (e * j - g * h) + d * (e * b[2] - b[1] * h)) / det;
  const z = (a * (f * b[2] - b[1] * i) - c * (e * b[2] - b[1] * h) + b[0] * (e * i - f * h)) / det;
  return [x, y, z];
}

/**
 * The inner body: the part with every face plane moved in by `thickness`, the
 * open ones moved out. Exported for tests; `shellSolid` is what the tree calls.
 */
export function innerBody(soup, thickness, openFaces = []) {
  const mesh = weld(soup, 1e-5);
  const P = mesh.positions;
  const I = mesh.indices;
  const nt = mesh.triangleCount;
  const tn = new Float64Array(nt * 3);
  const open = new Uint8Array(nt);
  let opened = 0;
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [I[t * 3], I[t * 3 + 1], I[t * 3 + 2]];
    const ux = P[b * 3] - P[a * 3]; const uy = P[b * 3 + 1] - P[a * 3 + 1]; const uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3]; const vy = P[c * 3 + 1] - P[a * 3 + 1]; const vz = P[c * 3 + 2] - P[a * 3 + 2];
    let nx = uy * vz - uz * vy; let ny = uz * vx - ux * vz; let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) continue;
    nx /= l; ny /= l; nz /= l;
    tn[t * 3] = nx; tn[t * 3 + 1] = ny; tn[t * 3 + 2] = nz;
    const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3;
    const cy = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3;
    const cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
    for (const f of openFaces) {
      const [fx, fy, fz] = f.normal;
      if (nx * fx + ny * fy + nz * fz < 0.999) continue;
      if (Math.abs(cx * fx + cy * fy + cz * fz - f.plane) > 0.01) continue;
      // Only the face that was picked, not every face on the same plane — unless an
      // earlier feature moved it so far its old box no longer meets it at all.
      if (f.min && f.max && ![cx, cy, cz].every((v, k) => v >= f.min[k] - 1 && v <= f.max[k] + 1)) continue;
      open[t] = 1;
      opened++;
      break;
    }
  }
  if (openFaces.length && !opened) {
    // The picked faces' boxes are stale: fall back to the whole plane.
    return innerBody(soup, thickness, openFaces.map((f) => ({ ...f, min: null, max: null })));
  }

  // Per vertex: its distinct planes and how far each moves (in = −thickness).
  const planes = Array.from({ length: mesh.vertexCount }, () => []);
  for (let t = 0; t < nt; t++) {
    const n = [tn[t * 3], tn[t * 3 + 1], tn[t * 3 + 2]];
    if (!n[0] && !n[1] && !n[2]) continue;
    const move = open[t] ? thickness + OPEN_PAST : -thickness;
    for (let k = 0; k < 3; k++) {
      const list = planes[I[t * 3 + k]];
      const same = list.find((q) => q.n[0] * n[0] + q.n[1] * n[1] + q.n[2] * n[2] > SAME_PLANE);
      if (same) { if (open[t]) same.move = move; } else list.push({ n, move });
    }
  }
  const moved = new Float64Array(P.length);
  for (let v = 0; v < mesh.vertexCount; v++) {
    const A = [1e-9, 0, 0, 0, 1e-9, 0, 0, 0, 1e-9];
    const b = [0, 0, 0];
    for (const { n, move } of planes[v]) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) A[r * 3 + c] += n[r] * n[c];
        b[r] += n[r] * move;
      }
    }
    const d = solve3(A, b);
    moved[v * 3] = P[v * 3] + d[0];
    moved[v * 3 + 1] = P[v * 3 + 1] + d[1];
    moved[v * 3 + 2] = P[v * 3 + 2] + d[2];
  }
  const positions = new Float32Array(nt * 9);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k];
      positions[t * 9 + k * 3] = moved[v * 3];
      positions[t * 9 + k * 3 + 1] = moved[v * 3 + 1];
      positions[t * 9 + k * 3 + 2] = moved[v * 3 + 2];
    }
  }
  return {
    positions, triangleCount: nt, format: 'shell', opened, open,
  };
}

/** Squared distance from point p to triangle abc (each [x,y,z]). */
function pointTriangleDist2(p, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a); const ac = sub(c, a); const ap = sub(p, a);
  const d1 = dot(ab, ap); const d2 = dot(ac, ap);
  const at = (q) => { const d = sub(p, q); return dot(d, d); };
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b); const d3 = dot(ab, bp); const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return at([a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]); }
  const cp = sub(p, c); const d5 = dot(ab, cp); const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return at([a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return at([b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom; const w = vc * denom;
  return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

/**
 * Where the inner wall comes closer than `reach` to the part's closed faces:
 * the part there is thinner than twice the wall, and the hollow would break
 * through it. The middle of the first such inner face, or null. A grid of
 * cells keeps it to the faces near each point.
 */
export function thinWallAt(soup, inner, reach) {
  const P = soup.positions;
  const T = soup.triangleCount;
  let lo = [Infinity, Infinity, Infinity]; let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    lo = lo.map((v, k) => Math.min(v, P[i + k])); hi = hi.map((v, k) => Math.max(v, P[i + k]));
  }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const cs = Math.max(reach, span / 64);
  const cell = (v, k) => Math.floor((v - lo[k]) / cs);
  const grid = new Map();
  const key = (i, j, k) => (i * 4096 + j) * 4096 + k;
  for (let t = 0; t < T; t++) {
    if (inner.open[t]) continue;
    const o = t * 9;
    const a = [0, 1, 2].map((k) => cell(Math.min(P[o + k], P[o + 3 + k], P[o + 6 + k]), k));
    const b = [0, 1, 2].map((k) => cell(Math.max(P[o + k], P[o + 3 + k], P[o + 6 + k]), k));
    for (let i = a[0]; i <= b[0]; i++) {
      for (let j = a[1]; j <= b[1]; j++) {
        for (let k = a[2]; k <= b[2]; k++) {
          const g = key(i, j, k);
          if (!grid.has(g)) grid.set(g, []);
          grid.get(g).push(t);
        }
      }
    }
  }
  const Q = inner.positions;
  const r2 = reach * reach;
  const seen = new Int32Array(T).fill(-1);
  for (let t = 0; t < inner.triangleCount; t++) {
    if (inner.open[t]) continue;
    const o = t * 9;
    const c = [0, 1, 2].map((k) => (Q[o + k] + Q[o + 3 + k] + Q[o + 6 + k]) / 3);
    const a = [0, 1, 2].map((k) => cell(c[k] - reach, k));
    const b = [0, 1, 2].map((k) => cell(c[k] + reach, k));
    for (let i = a[0]; i <= b[0]; i++) {
      for (let j = a[1]; j <= b[1]; j++) {
        for (let k = a[2]; k <= b[2]; k++) {
          for (const u of grid.get(key(i, j, k)) || []) {
            if (seen[u] === t) continue;
            seen[u] = t;
            const p = u * 9;
            const d2 = pointTriangleDist2(c, [P[p], P[p + 1], P[p + 2]], [P[p + 3], P[p + 4], P[p + 5]], [P[p + 6], P[p + 7], P[p + 8]]);
            if (d2 < r2) return c;
          }
        }
      }
    }
  }
  return null;
}

/** How close (a share of the wall) an inner face may come to a face before the wall is too thick. */
const THIN_WALL = 0.9;

/** The part hollowed to `thickness`, open where `openFaces` say. */
export function shellSolid(soup, { thickness, openFaces = [] }, meshBoolean) {
  if (!(thickness > 0)) throw new Error('a shell needs a wall thickness');
  if (!meshBoolean) throw new Error('no solid boolean is available to hollow the part');
  const inner = innerBody(soup, thickness, openFaces);
  // Every inner face stands a wall's thickness off its own face; nearer than
  // that to any face, the part is too thin there for this wall.
  const thin = thinWallAt(soup, inner, thickness * THIN_WALL);
  if (thin) {
    const at = thin.map((v) => Math.round(v * 10) / 10).join(', ');
    throw new Error(`the part is thinner than twice the wall near (${at}) — make the wall thinner than ${thickness} mm`);
  }
  return meshBoolean(soup, inner, 'cut', 'shell');
}
