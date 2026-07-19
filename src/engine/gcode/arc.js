/**
 * Arc tessellation for G2 (CW) / G3 (CCW) moves.
 *
 * Works in an abstract plane defined by axis indices [u, v, w] where u,v are
 * the in-plane axes and w is the helical (out-of-plane) axis:
 *   G17 XY -> [0, 1, 2]   (arc in XY, helix along Z)
 *   G18 ZX -> [2, 0, 1]   (arc in ZX, helix along Y)
 *   G19 YZ -> [1, 2, 0]   (arc in YZ, helix along X)
 *
 * Centre is given either as incremental offsets (i,j on the u,v axes) or as a
 * radius r (arc.R). Radius sign selects minor (R>0) vs major (R<0) arc, per
 * RS-274. Full circles (start == end with i/j offsets) sweep a full turn.
 */

const TWO_PI = Math.PI * 2;
const EPS = 1e-6;
/** Max sagitta (mm) between an arc and its chords — the tessellation tolerance. */
const CHORD_TOL = 0.002;
/** Floor on the chord angle, so a huge radius can't explode the segment count. */
const MIN_STEP = Math.PI / 360; // 0.5°

/** Solve arc centre from a radius value (R word). */
function centreFromRadius(su, sv, eu, ev, r, cw) {
  const dx = eu - su;
  const dy = ev - sv;
  const q = Math.hypot(dx, dy);
  if (q < EPS) return null; // start == end, radius form is undefined

  const rAbs = Math.abs(r);
  let hSq = rAbs * rAbs - (q / 2) * (q / 2);
  if (hSq < 0) hSq = 0; // clamp: radius too small for chord
  const h = Math.sqrt(hSq);

  const mx = (su + eu) / 2;
  const my = (sv + ev) / 2;
  const ux = -dy / q; // unit perpendicular to the chord
  const uy = dx / q;

  // Side of the chord the centre sits on. Validated against known quarter arcs.
  let s = cw ? -1 : 1;
  if (r < 0) s = -s;

  return [mx + s * h * ux, my + s * h * uy];
}

/**
 * Tessellate an arc into a list of [x,y,z] points (includes start and end).
 *
 * @param {number[]} start  machine XYZ at arc start
 * @param {number[]} end    machine XYZ at arc end
 * @param {{i?:number,j?:number,r?:number}} arc  centre offsets or radius (scaled to mm)
 * @param {number[]} plane  axis index triple [u, v, w]
 * @param {boolean} cw      true for G2, false for G3
 * @param {number} maxStep  max chord angle in radians (tessellation density)
 * @returns {{points:number[][], warning?:string}}
 */
export function tessellateArc(start, end, arc, plane, cw, maxStep = Math.PI / 32) {
  const [u, v, w] = plane;
  const su = start[u];
  const sv = start[v];
  const eu = end[u];
  const ev = end[v];

  let cu;
  let cv;
  if (arc.r !== undefined) {
    const c = centreFromRadius(su, sv, eu, ev, arc.r, cw);
    if (!c) return { points: [start.slice(), end.slice()], warning: 'degenerate radius arc' };
    [cu, cv] = c;
  } else {
    cu = su + (arc.i || 0);
    cv = sv + (arc.j || 0);
  }

  const radius = Math.hypot(su - cu, sv - cv);
  if (radius < EPS) return { points: [start.slice(), end.slice()], warning: 'zero-radius arc' };

  const a0 = Math.atan2(sv - cv, su - cu);
  let a1 = Math.atan2(ev - cv, eu - cu);

  const fullCircle =
    arc.r === undefined && Math.hypot(eu - su, ev - sv) < EPS;

  let sweep;
  if (fullCircle) {
    sweep = cw ? -TWO_PI : TWO_PI;
  } else {
    sweep = a1 - a0;
    if (cw && sweep > EPS) sweep -= TWO_PI;
    if (!cw && sweep < -EPS) sweep += TWO_PI;
    if (Math.abs(sweep) < EPS) sweep = cw ? -TWO_PI : TWO_PI;
  }

  // Chord density from a **sagitta tolerance**, not a fixed angle: a fixed angle
  // over-tessellates small arcs and under-tessellates big ones, and on a turned
  // R or spherical end the radial error near a vertical tangent is the chord
  // error amplified by the slope — which is what made those surfaces look
  // faceted. `maxStep` stays as the coarse bound.
  const byTol = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - CHORD_TOL / radius)));
  const step = Math.min(maxStep, Math.max(byTol, MIN_STEP));
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / step));
  const wStart = start[w];
  const wEnd = end[w];

  const points = [];
  for (let n = 0; n <= steps; n++) {
    const t = n / steps;
    const ang = a0 + sweep * t;
    const p = [0, 0, 0];
    p[u] = cu + radius * Math.cos(ang);
    p[v] = cv + radius * Math.sin(ang);
    p[w] = wStart + (wEnd - wStart) * t;
    points.push(p);
  }
  return { points };
}
