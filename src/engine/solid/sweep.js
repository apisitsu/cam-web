/**
 * Sweep and Loft — solids from a profile moved along a path, or from one profile
 * blended into another.
 *
 * Both are built the same way: a series of 3D rings, one per section, joined
 * quad by quad and closed with the profile's own triangulation at each end. The
 * output is the usual soup, so the boolean and the CAM pipeline take it as they
 * take an extrude.
 *
 * - **Sweep**: the profile stays where it was drawn and is carried along the
 *   path by parallel transport (the frame turns only as much as the path does,
 *   never twisting about it). At each corner of the path the section is the cut
 *   of the incoming prism by the corner's bisecting plane — a mitre — so a sharp
 *   bend keeps its full wall. The profile should sit on a plane across the path's
 *   start; it is not moved there for you.
 * - **Loft**: two or more single-loop profiles, in the order given. Each is
 *   sampled at every corner of every other (by arc length), so the corners of all
 *   of them survive, and the start of each is turned to line up with the first.
 *
 * Pure: plain arrays, no three.js.
 */
import { triangulate } from './triangulate.js';
import { planeToWorld, planeBasis } from '../sketch/plane.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0]; };

/** Rotation taking unit `a` onto unit `b` (Rodrigues), as a function on vectors. */
function turn(a, b) {
  const axis = cross(a, b);
  const s = Math.hypot(...axis);
  const c = dot(a, b);
  if (s < 1e-12) {
    if (c > 0) return (v) => v;
    // Straight back: half a turn about any axis square to `a`.
    const k = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return (v) => sub(scale(k, 2 * dot(k, v)), v);
  }
  const k = scale(axis, 1 / s);
  return (v) => add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

const soupOf = (xs, format) => ({ positions: Float32Array.from(xs), triangleCount: xs.length / 9, format });

function signedVolume(xs) {
  let v = 0;
  for (let i = 0; i < xs.length; i += 9) {
    v += dot([xs[i], xs[i + 1], xs[i + 2]], cross([xs[i + 3], xs[i + 4], xs[i + 5]], [xs[i + 6], xs[i + 7], xs[i + 8]]));
  }
  return v / 6;
}

/** Turn every triangle round when the solid came out inside-out. */
function outward(xs) {
  if (signedVolume(xs) >= 0) return xs;
  for (let i = 0; i < xs.length; i += 9) {
    for (let k = 0; k < 3; k++) { const t = xs[i + 3 + k]; xs[i + 3 + k] = xs[i + 6 + k]; xs[i + 6 + k] = t; }
  }
  return xs;
}

/**
 * Join `rings` (each an array of [x,y,z], all the same length, in step) with
 * walls, and close the ends with `capStart` / `capEnd`: lists of [x,y,z]
 * triangles.
 */
function skin(ringSets, capStart, capEnd, format) {
  const xs = [];
  const tri = (a, b, c) => xs.push(...a, ...b, ...c);
  for (const rings of ringSets) {
    for (let s = 0; s + 1 < rings.length; s++) {
      const A = rings[s]; const B = rings[s + 1]; const n = A.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        tri(A[i], A[j], B[j]);
        tri(A[i], B[j], B[i]);
      }
    }
  }
  for (const [a, b, c] of capStart) tri(c, b, a);
  for (const [a, b, c] of capEnd) tri(a, b, c);
  return soupOf(outward(xs), format);
}

const pairs = (flat) => { const out = []; for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };

/** The triangles of a 2D region, through `place` into 3D. */
function capTriangles(outer, holes, place) {
  const { vertices, indices } = triangulate(outer, holes);
  const out = [];
  for (let k = 0; k < indices.length; k += 3) {
    out.push([0, 1, 2].map((m) => place(vertices[indices[k + m] * 2], vertices[indices[k + m] * 2 + 1])));
  }
  return out;
}

/**
 * Sweep a profile region along a path.
 *
 * @param {{outer:number[], holes?:number[][]}} region  in the profile sketch's plane
 * @param {object} profilePlane
 * @param {number[]} path  flat [x,y,…] polyline in the path sketch's plane
 * @param {object} pathPlane
 */
export function sweepSolid(region, profilePlane, path, pathPlane) {
  const pts = pairs(path).map(([x, y]) => planeToWorld(pathPlane, x, y))
    .filter((p, i, a) => i === 0 || Math.hypot(...sub(p, a[i - 1])) > 1e-9);
  if (pts.length < 2) throw new Error('the path is too short to sweep along');
  const loops = [region.outer, ...(region.holes || [])].map(pairs);
  const P0 = pts[0];
  const t0 = norm(sub(pts[1], pts[0]));
  const { n: pn } = planeBasis(profilePlane);
  if (Math.abs(dot(pn, t0)) < 0.2) throw new Error('the profile lies along the path — draw it on a plane across the start of the path');
  // Each section as a function of a profile point: start where it was drawn.
  const base = (x, y) => sub(planeToWorld(profilePlane, x, y), P0);
  let R = (v) => v; // the frame carried so far
  let t = t0;
  const sections = [(x, y) => add(P0, base(x, y))];
  for (let k = 1; k < pts.length; k++) {
    const P = pts[k];
    const Rk = R;
    const tk = t;
    if (k === pts.length - 1) {
      sections.push((x, y) => add(P, Rk(base(x, y))));
      break;
    }
    const tout = norm(sub(pts[k + 1], P));
    const nb = norm(add(tk, tout));
    const denom = dot(nb, tk);
    if (denom < 0.05) throw new Error('the path doubles back on itself too sharply to sweep');
    sections.push((x, y) => {
      const q = add(P, Rk(base(x, y)));
      return add(q, scale(tk, -dot(nb, sub(q, P)) / denom));
    });
    const step = turn(tk, tout);
    R = (v) => step(Rk(v));
    t = tout;
  }
  const ringSets = loops.map((loop) => sections.map((f) => loop.map(([x, y]) => f(x, y))));
  const first = sections[0];
  const last = sections[sections.length - 1];
  return skin(
    ringSets,
    capTriangles(region.outer, region.holes || [], first),
    capTriangles(region.outer, region.holes || [], last),
    'sweep',
  );
}

/** Arc-length positions (0…1) of a closed loop's corners. */
function corners(loop) {
  const n = loop.length;
  const len = [0];
  for (let i = 1; i <= n; i++) len.push(len[i - 1] + Math.hypot(...sub(loop[i % n], loop[i - 1])));
  const total = len[n];
  return { at: len.slice(0, n).map((l) => l / total), total, len };
}

function sampleAt(loop, { len, total }, s) {
  const target = s * total;
  let i = 0;
  while (i < loop.length - 1 && len[i + 1] < target) i++;
  const a = loop[i]; const b = loop[(i + 1) % loop.length];
  const seg = len[i + 1] - len[i];
  const f = seg > 0 ? (target - len[i]) / seg : 0;
  return add(a, scale(sub(b, a), f));
}

/**
 * Triangles closing a 2D ring whose sides carry extra points in line with its
 * corners (a loft samples every profile at the corners of the others). The
 * corners alone are triangulated; a triangle with such points on its sides is
 * fanned from its own centre through them, so the cap meets every point of the
 * ring and the solid stays closed.
 */
export function ringCap(ring) {
  const n = ring.length;
  const crossAt = (i) => {
    const a = ring[(i + n - 1) % n]; const b = ring[i]; const c = ring[(i + 1) % n];
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  };
  const scaleSq = ring.reduce((m, p) => Math.max(m, p[0] * p[0] + p[1] * p[1]), 1);
  const cornerIdx = [];
  for (let i = 0; i < n; i++) if (Math.abs(crossAt(i)) > 1e-10 * scaleSq) cornerIdx.push(i);
  const { vertices, indices } = triangulate(cornerIdx.flatMap((i) => ring[i]), []);
  const key = (x, y) => `${x},${y}`;
  const ringAt = new Map(cornerIdx.map((i) => [key(ring[i][0], ring[i][1]), i]));
  const between = (i, j) => {
    // Ring points strictly between corner i and the next corner j, going forwards.
    const pos = cornerIdx.indexOf(i);
    if (cornerIdx[(pos + 1) % cornerIdx.length] === j) {
      const out = [];
      for (let k = (i + 1) % n; k !== j; k = (k + 1) % n) out.push(ring[k]);
      return out;
    }
    if (cornerIdx[(pos - 1 + cornerIdx.length) % cornerIdx.length] === j) return between(j, i).reverse();
    return [];
  };
  const out = [];
  for (let k = 0; k < indices.length; k += 3) {
    const id = [0, 1, 2].map((m) => ringAt.get(key(vertices[indices[k + m] * 2], vertices[indices[k + m] * 2 + 1])));
    const poly = [];
    for (let m = 0; m < 3; m++) {
      const a = id[m]; const b = id[(m + 1) % 3];
      poly.push(ring[a], ...between(a, b));
    }
    if (poly.length === 3) { out.push(poly); continue; }
    const c = [0, 1].map((d) => poly.reduce((s, p) => s + p[d], 0) / poly.length);
    for (let m = 0; m < poly.length; m++) out.push([c, poly[m], poly[(m + 1) % poly.length]]);
  }
  return out;
}

/**
 * Loft through profiles in order. Each is `{ outer, plane }`: one closed loop
 * on its sketch plane. Holes are lofted separately and cut out of this
 * (`makeLoft` in featureTree.js).
 */
export function loftSolid(profiles) {
  if (profiles.length < 2) throw new Error('a loft needs two profiles or more');
  // 3D loops, all running the same way round as seen along the loft.
  const loops3 = profiles.map(({ outer, plane }) => pairs(outer).map(([x, y]) => planeToWorld(plane, x, y)));
  const centre = (l) => scale(l.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / l.length);
  const dir = norm(sub(centre(loops3[loops3.length - 1]), centre(loops3[0])));
  if (!dir.some(Boolean)) throw new Error('the profiles are all in one place — put them on different planes');
  const areaVec = (l) => l.reduce((s, p, i) => add(s, cross(p, l[(i + 1) % l.length])), [0, 0, 0]);
  for (const l of loops3) if (dot(areaVec(l), dir) < 0) l.reverse();

  // Sample every loop at the corners of all of them, so no corner is cut.
  const meta = loops3.map(corners);
  const params = [...new Set(meta.flatMap((m) => m.at.map((s) => Math.round(s * 1e9) / 1e9)))].sort((a, b) => a - b);
  // Line each loop's start up with the first loop's: try every start corner.
  const rings = [];
  loops3.forEach((loop, li) => {
    if (li === 0) { rings.push(params.map((s) => sampleAt(loop, meta[0], s))); return; }
    let best = null;
    for (const shift of meta[li].at) {
      const ring = params.map((s) => sampleAt(loop, meta[li], (s + shift) % 1));
      const off = sub(centre(loop), centre(loops3[0]));
      const cost = ring.reduce((c, p, i) => c + Math.hypot(...sub(sub(p, off), rings[0][i])), 0);
      if (!best || cost < best.cost) best = { cost, ring };
    }
    rings.push(best.ring);
  });

  // Caps: triangulate each end ring in its own plane (`ringCap`).
  const cap = (ring, plane) => {
    const { origin, u, v } = planeBasis(plane);
    return ringCap(ring.map((p) => [dot(sub(p, origin), u), dot(sub(p, origin), v)]))
      .map((t) => t.map(([x, y]) => planeToWorld(plane, x, y)));
  };
  const first = cap(rings[0], profiles[0].plane);
  const last = cap(rings[rings.length - 1], profiles[profiles.length - 1].plane);
  // Each cap faces back along / on along the loft: orient by the loft direction.
  const facing = (tris, want) => tris.map((t) => (dot(cross(sub(t[1], t[0]), sub(t[2], t[0])), dir) * want < 0 ? [t[0], t[2], t[1]] : t));
  return skin([rings], facing(first, 1), facing(last, 1), 'loft');
}
