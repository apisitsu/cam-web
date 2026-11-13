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
  return { positions, triangleCount: nt, format: 'shell', opened };
}

/** The part hollowed to `thickness`, open where `openFaces` say. */
export function shellSolid(soup, { thickness, openFaces = [] }, meshBoolean) {
  if (!(thickness > 0)) throw new Error('a shell needs a wall thickness');
  if (!meshBoolean) throw new Error('no solid boolean is available to hollow the part');
  const inner = innerBody(soup, thickness, openFaces);
  return meshBoolean(soup, inner, 'cut', 'shell');
}
