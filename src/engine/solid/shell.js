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
 * through it. The middle of the first such inner face, or null. A tree of
 * boxes over the faces keeps each look to the faces near the point (a grid
 * does not: the long thin triangles of a round cap fill thousands of cells).
 */
export function thinWallAt(soup, inner, reach) {
  const P = soup.positions;
  const ids = [];
  for (let t = 0; t < soup.triangleCount; t++) if (!inner.open[t]) ids.push(t);
  if (!ids.length) return null;
  const box = new Float64Array(soup.triangleCount * 6);
  const mid = new Float64Array(soup.triangleCount * 3);
  const plane = new Float64Array(soup.triangleCount * 4); // unit normal and offset, for a quick miss
  for (const t of ids) {
    const o = t * 9;
    const ux = P[o + 3] - P[o]; const uy = P[o + 4] - P[o + 1]; const uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o]; const vy = P[o + 7] - P[o + 1]; const vz = P[o + 8] - P[o + 2];
    let nx = uy * vz - uz * vy; let ny = uz * vx - ux * vz; let nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    plane.set([nx, ny, nz, nx * P[o] + ny * P[o + 1] + nz * P[o + 2]], t * 4);
    for (let k = 0; k < 3; k++) {
      const a = P[o + k]; const b = P[o + 3 + k]; const c = P[o + 6 + k];
      box[t * 6 + k] = Math.min(a, b, c);
      box[t * 6 + 3 + k] = Math.max(a, b, c);
      mid[t * 3 + k] = (a + b + c) / 3;
    }
  }
  // Nodes: [min x,y,z, max x,y,z] and either two children or a run of `ids`.
  const nodes = [];
  const build = (lo, hi) => {
    const nb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const t = ids[i];
      for (let k = 0; k < 3; k++) {
        if (box[t * 6 + k] < nb[k]) nb[k] = box[t * 6 + k];
        if (box[t * 6 + 3 + k] > nb[k + 3]) nb[k + 3] = box[t * 6 + 3 + k];
      }
    }
    const node = { b: nb, lo, hi, l: null, r: null };
    nodes.push(node);
    if (hi - lo > 8) {
      const ax = [0, 1, 2].reduce((m, k) => (nb[k + 3] - nb[k] > nb[m + 3] - nb[m] ? k : m), 0);
      const part = ids.slice(lo, hi).sort((x, y) => mid[x * 3 + ax] - mid[y * 3 + ax]);
      for (let i = lo; i < hi; i++) ids[i] = part[i - lo];
      const m = (lo + hi) >> 1;
      node.l = build(lo, m);
      node.r = build(m, hi);
    }
    return node;
  };
  const root = build(0, ids.length);
  const r2 = reach * reach;
  const Q = inner.positions;
  const tri = (t) => { const o = t * 9; return [[P[o], P[o + 1], P[o + 2]], [P[o + 3], P[o + 4], P[o + 5]], [P[o + 6], P[o + 7], P[o + 8]]]; };
  const near = (node, c) => {
    const b = node.b;
    let d2 = 0;
    for (let k = 0; k < 3; k++) {
      const e = c[k] < b[k] ? b[k] - c[k] : c[k] > b[k + 3] ? c[k] - b[k + 3] : 0;
      d2 += e * e;
    }
    if (d2 >= r2) return false;
    if (node.l) return near(node.l, c) || near(node.r, c);
    for (let i = node.lo; i < node.hi; i++) {
      const t = ids[i];
      const off = plane[t * 4] * c[0] + plane[t * 4 + 1] * c[1] + plane[t * 4 + 2] * c[2] - plane[t * 4 + 3];
      if (off * off >= r2) continue;
      const [a, bb, cc] = tri(t);
      if (pointTriangleDist2(c, a, bb, cc) < r2) return true;
    }
    return false;
  };
  for (let t = 0; t < inner.triangleCount; t++) {
    if (inner.open[t]) continue;
    const o = t * 9;
    const c = [(Q[o] + Q[o + 3] + Q[o + 6]) / 3, (Q[o + 1] + Q[o + 4] + Q[o + 7]) / 3, (Q[o + 2] + Q[o + 5] + Q[o + 8]) / 3];
    if (near(root, c)) return c;
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
