/**
 * Arc fitting — runs of short feed moves written out as G02/G03.
 *
 * Toolpaths are polylines, because that is what offsetting a section produces. A
 * circle then reaches the control as hundreds of tiny G01 blocks. This finds the
 * runs that are really arcs, for the post only: `op.moves` stay polylines, so cycle
 * time, the envelope check and everything else that reads them are unaffected.
 *
 * Deliberately cautious. A run becomes an arc only when every vertex is within `tol`
 * of the circle and no chord strays far from it, so a real polygon stays a polygon.
 *
 * Pure functions. No React, no store, no DOM.
 */

const DEFAULTS = {
  tol: 0.01,
  minSegments: 4,
  maxStep: (25 * Math.PI) / 180,
  maxSagitta: 0.05,
  maxRadius: 5000,
};

/** In-plane axes [u, v] and the axis that must stay constant along an arc. */
const PLANES = {
  xy: { u: 'x', v: 'y', w: 'z' },
  zx: { u: 'z', v: 'x', w: null },
};

function circleThrough(ax, ay, bx, by, cx, cy) {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
}

/** The circle moves `i`..`e` lie on, or null if they are not an arc. */
function fitRun(moves, i, e, { u, v }, o) {
  const a = moves[i];
  const m = moves[Math.floor((i + e) / 2)];
  const b = moves[e];
  const c = circleThrough(a[u], a[v], m[u], m[v], b[u], b[v]);
  if (!c || c.r > o.maxRadius) return null;

  // Vertices that are all on the chord are a straight line, whatever `c` says.
  const chordX = b[u] - a[u];
  const chordY = b[v] - a[v];
  const chord = Math.hypot(chordX, chordY);
  let bulge = 0;
  let sweep = 0;
  let sign = 0;
  let angle = Math.atan2(a[v] - c.cy, a[u] - c.cx);
  for (let k = i + 1; k <= e; k++) {
    const p = moves[k];
    if (Math.abs(Math.hypot(p[u] - c.cx, p[v] - c.cy) - c.r) > o.tol) return null;
    if (chord > 0) {
      bulge = Math.max(bulge, Math.abs((p[u] - a[u]) * chordY - (p[v] - a[v]) * chordX) / chord);
    }
    const next = Math.atan2(p[v] - c.cy, p[u] - c.cx);
    let delta = next - angle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    angle = next;
    if (delta === 0) return null;
    const s = Math.sign(delta);
    if (sign && s !== sign) return null;
    sign = s;
    if (Math.abs(delta) > o.maxStep) return null;
    if (c.r * (1 - Math.cos(delta / 2)) > o.maxSagitta) return null;
    sweep += delta;
  }
  if (bulge <= o.tol || Math.abs(sweep) > Math.PI) return null;
  return { ...c, cw: sweep < 0 };
}

const isPoint = (m, { u, v }) => m && !m.cycle && Number.isFinite(m[u]) && Number.isFinite(m[v]);

/** The longest arc starting at point `i`, as `{circle, end}`, or null. */
function growArc(moves, i, plane, o) {
  if (!isPoint(moves[i], plane)) return null;
  const inRun = (k) => {
    const m = moves[k];
    return m?.t === 'feed' && isPoint(m, plane)
      && (plane.w === null || Math.abs(m[plane.w] - moves[i][plane.w]) < 1e-6);
  };
  for (let k = i + 1; k <= i + o.minSegments; k++) if (!inRun(k)) return null;

  let best = null;
  for (let e = i + o.minSegments; inRun(e); e++) {
    const circle = fitRun(moves, i, e, plane, o);
    if (!circle) break;
    best = { circle, end: e };
  }
  return best;
}

/**
 * Replace the runs of `moves` that are arcs with single `{t:'arc', cw, ...}` moves.
 * An arc carries its end point plus the centre as an offset from its start: `i`,`j`
 * in the XY plane, `i` (radial) and `k` in ZX.
 *
 * @param {object[]} moves  `{t, x, y?, z}` and canned-cycle moves, which end a run
 * @param {{plane?:'xy'|'zx', tol?:number}} [opts]
 */
export function fitArcs(moves, opts = {}) {
  const planeName = opts.plane ?? 'xy';
  const plane = PLANES[planeName];
  const o = { ...DEFAULTS, ...opts };
  if (moves.length === 0) return [];
  const out = [moves[0]];
  let i = 0;
  while (i < moves.length - 1) {
    const arc = growArc(moves, i, plane, o);
    if (!arc) {
      i += 1;
      out.push(moves[i]);
      continue;
    }
    const start = moves[i];
    const { cx, cy, cw } = arc.circle;
    const offsets = planeName === 'xy'
      ? { i: cx - start.x, j: cy - start.y }
      : { k: cx - start.z, i: cy - start.x };
    out.push({ ...moves[arc.end], t: 'arc', cw, ...offsets });
    i = arc.end;
  }
  return out;
}
