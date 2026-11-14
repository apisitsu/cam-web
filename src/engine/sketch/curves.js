/**
 * Ellipse and spline — the two sketch curves defined by their own points rather
 * than by a solver primitive.
 *
 * Both are drawn through sketch **points** the solver already moves (an
 * ellipse's centre and the end of its major axis; a spline's through-points), so
 * dragging, dimensioning and relating those points works as for any other
 * geometry. The curve itself carries only what the points cannot say — an
 * ellipse's minor radius — and is turned into a polyline here for everything
 * downstream: the profile finder, the drawing, picking, DXF.
 *
 * - **Ellipse**: `{ type: 'ellipse', center, major, rb }` — `major` is the point
 *   at one end of the major axis (it sets the size and the rotation), `rb` the
 *   minor radius.
 * - **Spline**: `{ type: 'spline', pts: [ids…], closed }` — a centripetal
 *   Catmull-Rom curve through every point, in order; it does not overshoot
 *   or loop at uneven spacing the way a uniform one does.
 *
 * Pure.
 */

/** Pieces per spline span, and the most an ellipse is cut into. */
const SPAN_STEPS = 24;
const ELLIPSE_STEPS = 96;

/** The ellipse as a closed polyline, flat [x,y,…] (the first point not repeated). */
export function ellipsePoints(c, m, rb, steps = ELLIPSE_STEPS) {
  const ra = Math.hypot(m.x - c.x, m.y - c.y);
  if (!(ra > 0) || !(rb > 0)) return [];
  const ux = (m.x - c.x) / ra; const uy = (m.y - c.y) / ra;
  const out = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const a = ra * Math.cos(t); const b = rb * Math.sin(t);
    out.push(c.x + a * ux - b * uy, c.y + a * uy + b * ux);
  }
  return out;
}

/** One centripetal Catmull-Rom span from p1 to p2, `steps` points after p1. */
function span(p0, p1, p2, p3, steps, out) {
  for (let s = 1; s <= steps; s++) {
    const C = spanPoint(p0, p1, p2, p3, s / steps);
    out.push(C[0], C[1]);
  }
}

/**
 * The spline through `pts` ([x,y] each) as a polyline, flat. Open, it starts and
 * ends on the end points exactly; closed, it runs back to the first point (which
 * is then not repeated at the end).
 */
export function splinePoints(pts, closed = false, steps = SPAN_STEPS) {
  const n = pts.length;
  if (n < 2) return [];
  const at = (i) => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return pts[i];
  };
  const out = [pts[0][0], pts[0][1]];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) span(at(i - 1), at(i), at(i + 1), at(i + 2), steps, out);
  if (closed) out.length -= 2; // the last step landed back on the first point
  return out;
}

/** Is `e` an ellipse or a spline? */
export const isCurve = (e) => e?.type === 'ellipse' || e?.type === 'spline';

/**
 * A trimmed curve keeps its defining points and gains `range: [t0, t1]` — the
 * piece of its own parameter it still covers — and `ends: [a, b]`, the sketch
 * points at those two parameters, which lines join to. An ellipse's parameter is
 * its angle (0–2π from the major axis), a spline's the span count (span i runs
 * from i to i + 1). A closed curve's range may run past its period.
 */
export function curvePeriod(sk, e) {
  if (e.type === 'ellipse') return 2 * Math.PI;
  const n = e.pts.length;
  return e.closed ? n : n - 1;
}

/** Is the curve a ring (no ends)? */
export const curveIsClosed = (e) => !e.range && (e.type === 'ellipse' || !!e.closed);

/** The parameter interval a curve covers. */
export function curveSpan(sk, e) {
  return e.range ? e.range.slice() : [0, curvePeriod(sk, e)];
}

/** The point of a centripetal Catmull-Rom span p1→p2 at fraction f. */
function spanPoint(p0, p1, p2, p3, f) {
  const knot = (a, b) => Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-9);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const lerp = (a, b, ta, tb, t) => [
    ((tb - t) / (tb - ta)) * a[0] + ((t - ta) / (tb - ta)) * b[0],
    ((tb - t) / (tb - ta)) * a[1] + ((t - ta) / (tb - ta)) * b[1],
  ];
  const t = t1 + (t2 - t1) * f;
  const A1 = lerp(p0, p1, t0, t1, t); const A2 = lerp(p1, p2, t1, t2, t); const A3 = lerp(p2, p3, t2, t3, t);
  const B1 = lerp(A1, A2, t0, t2, t); const B2 = lerp(A2, A3, t1, t3, t);
  return lerp(B1, B2, t1, t2, t);
}

/**
 * The curve as a function of its parameter, its points read once — what every
 * sampling loop wants rather than a lookup of the points per sample. Null when
 * a point it needs is missing.
 */
export function curveEvaluator(sk, e) {
  const P = (id) => sk.entities.get(id);
  if (e.type === 'ellipse') {
    const c = P(e.center); const m = P(e.major);
    if (!c || !m) return null;
    const ra = Math.hypot(m.x - c.x, m.y - c.y) || 1e-12;
    const ux = (m.x - c.x) / ra; const uy = (m.y - c.y) / ra;
    const { rb } = e;
    return (t) => {
      const a = ra * Math.cos(t); const b = rb * Math.sin(t);
      return { x: c.x + a * ux - b * uy, y: c.y + a * uy + b * ux };
    };
  }
  if (e.type !== 'spline') return null;
  const pts = e.pts.map(P);
  if (pts.some((p) => !p) || pts.length < 2) return null;
  const xy = pts.map((p) => [p.x, p.y]);
  const n = xy.length;
  const spans = e.closed ? n : n - 1;
  const at = (k) => {
    if (e.closed) return xy[((k % n) + n) % n];
    if (k < 0) return [2 * xy[0][0] - xy[1][0], 2 * xy[0][1] - xy[1][1]];
    if (k >= n) return [2 * xy[n - 1][0] - xy[n - 2][0], 2 * xy[n - 1][1] - xy[n - 2][1]];
    return xy[k];
  };
  return (t) => {
    let i = Math.floor(t);
    let f = t - i;
    if (e.closed) i = ((i % n) + n) % n;
    else if (i >= spans) { i = spans - 1; f = 1; } else if (i < 0) { i = 0; f = 0; }
    if (f === 0) return { x: at(i)[0], y: at(i)[1] };
    if (f === 1) return { x: at(i + 1)[0], y: at(i + 1)[1] };
    const [x, y] = spanPoint(at(i - 1), at(i), at(i + 1), at(i + 2), f);
    return { x, y };
  };
}

/** Point of curve `e` at parameter `t`, or null when its points are missing. */
export function curveAt(sk, e, t) {
  const f = curveEvaluator(sk, e);
  return f ? f(t) : null;
}

/**
 * The parameters a curve is drawn at, start to end (a ring's first is not
 * repeated): 96 round a whole ellipse, 24 per spline span, in proportion for a
 * trimmed piece.
 */
export function curveParams(sk, e) {
  const [t0, t1] = curveSpan(sk, e);
  const perUnit = e.type === 'ellipse' ? ELLIPSE_STEPS / (2 * Math.PI) : SPAN_STEPS;
  const steps = Math.max(2, Math.ceil((t1 - t0) * perUnit - 1e-9));
  const closed = curveIsClosed(e);
  const out = [];
  for (let i = 0; i < (closed ? steps : steps + 1); i++) out.push(t0 + ((t1 - t0) * i) / steps);
  return out;
}

/**
 * The drawn polylines, kept per entity until its points or its own values
 * change: hovering over a sketch of hundreds of curves would otherwise sample
 * every one of them on every mouse move.
 */
const polyCache = new WeakMap();

function curveKey(sk, e) {
  let k = `${e.rb}|${e.closed}|${e.range}|`;
  for (const id of e.type === 'ellipse' ? [e.center, e.major] : e.pts) {
    const p = sk.entities.get(id);
    k += p ? `${p.x},${p.y};` : 'x;';
  }
  return k;
}

/**
 * An ellipse or spline entity as `{ points, closed, box }` (`box` is
 * [xmin, ymin, xmax, ymax]), or null when it cannot be drawn. Shared: not to be
 * changed by the caller.
 */
export function curveOf(sk, e) {
  if (!isCurve(e)) return null;
  const key = curveKey(sk, e);
  const hit = polyCache.get(e);
  if (hit && hit.key === key) return hit.val;
  const f = curveEvaluator(sk, e);
  let val = null;
  if (f) {
    const points = [];
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const t of curveParams(sk, e)) {
      const p = f(t);
      points.push(p.x, p.y);
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    if (points.length >= 4) val = { points, closed: curveIsClosed(e), box: [x0, y0, x1, y1] };
  }
  polyCache.set(e, { key, val });
  return val;
}

/** The end points of an open curve, start then end, or null for a ring. */
export function curveEnds(e) {
  if (e.range) return e.ends || null;
  if (e.type === 'spline' && !e.closed) return [e.pts[0], e.pts[e.pts.length - 1]];
  return null;
}

/** Points an ellipse or spline is drawn through, and the ends of a trimmed one. */
export const curveRefs = (e) => {
  const own = e.type === 'ellipse' ? [e.center, e.major] : e.type === 'spline' ? e.pts : [];
  return e.range && e.ends ? [...own, ...e.ends.filter((id) => !own.includes(id))] : own;
};

/**
 * Keep what is derived from a curve in step with it: the end points of every
 * trimmed curve sit at its range ends, and an ellipse's minor-radius dimension
 * sets its minor radius (or, driven, reads it). The solver knows neither, so
 * this runs after every edit. Returns whether anything moved.
 */
export function syncCurves(sk) {
  let moved = false;
  for (const c of sk.constraints) {
    if (c.kind !== 'ellipseMinor') continue;
    const e = sk.entities.get(c.refs[0]);
    if (!e) continue;
    if (c.driven) c.value = e.rb;
    else if (c.value > 0 && e.rb !== c.value) { e.rb = c.value; moved = true; }
  }
  for (const e of sk.entities.values()) {
    if (!isCurve(e) || !e.range || !e.ends) continue;
    e.ends.forEach((id, k) => {
      const p = sk.entities.get(id);
      const q = curveAt(sk, e, e.range[k]);
      if (!p || !q) return;
      if (Math.abs(p.x - q.x) > 1e-12 || Math.abs(p.y - q.y) > 1e-12) { p.x = q.x; p.y = q.y; moved = true; }
    });
  }
  return moved;
}

/** Parameter on curve `e` nearest (x, y), from its drawn polyline. */
export function curveParamNear(sk, e, x, y) {
  const ts = curveParams(sk, e);
  const ev = curveEvaluator(sk, e);
  if (!ev) return 0;
  const ps = ts.map(ev);
  const closed = curveIsClosed(e);
  const period = curvePeriod(sk, e);
  let best = ts[0];
  let bestD = Infinity;
  const segs = closed ? ps.length : ps.length - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % ps.length;
    const a = ps[i]; const b = ps[j];
    const dx = b.x - a.x; const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const f = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(x - a.x - f * dx, y - a.y - f * dy);
    const tj = j === 0 && closed ? ts[0] + period : ts[j];
    if (d < bestD) { bestD = d; best = ts[i] + (tj - ts[i]) * f; }
  }
  return best;
}

/** [xmin, ymin, xmax, ymax] of a line, circle, arc (its whole circle) or curve; null if it has none. */
function otherBox(sk, o) {
  const P = (id) => sk.entities.get(id);
  if (o.type === 'line') {
    const a = P(o.p1); const b = P(o.p2);
    return a && b ? [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)] : null;
  }
  if (o.type === 'circle' || o.type === 'arc') {
    const c = o.cx != null ? { x: o.cx, y: o.cy } : P(o.center);
    return c ? [c.x - o.r, c.y - o.r, c.x + o.r, c.y + o.r] : null;
  }
  if (isCurve(o)) return curveOf(sk, o)?.box ?? null;
  return null;
}

/** Bisect g over [a, b] (g(a), g(b) of opposite sign) to a root. */
function bisect(g, a, b) {
  let ga = g(a);
  for (let k = 0; k < 60; k++) {
    const m = (a + b) / 2;
    const gm = g(m);
    if ((gm < 0) === (ga < 0)) { a = m; ga = gm; } else b = m;
  }
  return (a + b) / 2;
}

/**
 * Where curve `e` crosses another entity `o`: `[{ t, x, y }]`, `t` on `e`.
 * Against a line, circle or arc each crossing is solved exactly (bisection on
 * the signed distance); against another curve it is refined by Newton on both
 * parameters. `o` as a line counts only within its segment, as an arc only
 * within its sweep (`arcHas(x, y)` answers that).
 */
export function curveCrossings(sk, e, o, arcHas = null) {
  const P = (id) => sk.entities.get(id);
  const drawn = curveOf(sk, e);
  const at = curveEvaluator(sk, e);
  if (!drawn || !at) return [];
  // Nothing to do where the two are nowhere near each other.
  const other = otherBox(sk, o);
  const [ex0, ey0, ex1, ey1] = drawn.box;
  const m = 1e-6;
  if (!other || other[0] > ex1 + m || other[2] < ex0 - m || other[1] > ey1 + m || other[3] < ey0 - m) return [];
  const ts = curveParams(sk, e);
  const closed = curveIsClosed(e);
  if (closed) ts.push(ts[0] + curvePeriod(sk, e));
  const out = [];
  const push = (t) => {
    const p = at(t);
    if (p && !out.some((q) => Math.abs(q.t - t) < 1e-9)) out.push({ t, x: p.x, y: p.y });
  };
  let g = null;
  let keep = () => true;
  if (o.type === 'line') {
    const a = P(o.p1); const b = P(o.p2);
    if (!a || !b) return [];
    const dx = b.x - a.x; const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (!(l2 > 0)) return [];
    const len = Math.sqrt(l2);
    g = (t) => { const p = at(t); return ((p.x - a.x) * dy - (p.y - a.y) * dx) / len; };
    keep = (p) => { const s = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2; return s >= -1e-9 && s <= 1 + 1e-9; };
  } else if (o.type === 'circle' || o.type === 'arc') {
    const c = o.cx != null ? { x: o.cx, y: o.cy } : P(o.center);
    if (!c) return [];
    g = (t) => { const p = at(t); return Math.hypot(p.x - c.x, p.y - c.y) - o.r; };
    if (o.type === 'arc' && arcHas) keep = (p) => arcHas(p.x, p.y);
  }
  if (g) {
    // A sample within a micron-thousandth of the other counts as on it: the end
    // of a curve trimmed there lands on it only to rounding.
    const ON = 1e-9;
    const gs = ts.map(g).map((v) => (Math.abs(v) <= ON ? 0 : v));
    for (let i = 0; i < ts.length; i++) {
      if (gs[i] === 0) { if (keep(at(ts[i]))) push(ts[i]); continue; }
      if (i + 1 >= ts.length || gs[i + 1] === 0 || (gs[i] < 0) === (gs[i + 1] < 0)) continue;
      const t = bisect(g, ts[i], ts[i + 1]);
      if (keep(at(t))) push(t);
    }
    return out;
  }
  if (!isCurve(o)) return [];
  // Curve against curve: crossing chords first, then Newton on both parameters.
  const us = curveParams(sk, o);
  if (curveIsClosed(o)) us.push(us[0] + curvePeriod(sk, o));
  const bt = curveEvaluator(sk, o);
  if (!bt) return [];
  const A = ts.map(at); const B = us.map(bt);
  for (let i = 0; i + 1 < A.length; i++) {
    for (let j = 0; j + 1 < B.length; j++) {
      const p = A[i]; const r = { x: A[i + 1].x - p.x, y: A[i + 1].y - p.y };
      const q = B[j]; const s = { x: B[j + 1].x - q.x, y: B[j + 1].y - q.y };
      const den = r.x * s.y - r.y * s.x;
      if (Math.abs(den) < 1e-15) continue;
      const f = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / den;
      const h = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / den;
      if (f < 0 || f >= 1 || h < 0 || h > 1) continue;
      let t = ts[i] + (ts[i + 1] - ts[i]) * f;
      let u = us[j] + (us[j + 1] - us[j]) * h;
      const dt = (ts[i + 1] - ts[i]) * 1e-4; const du = (us[j + 1] - us[j]) * 1e-4;
      for (let k = 0; k < 8; k++) {
        const pa = at(t); const pb = bt(u);
        const fx = pa.x - pb.x; const fy = pa.y - pb.y;
        if (Math.hypot(fx, fy) < 1e-12) break;
        const ta = at(t + dt); const ub = bt(u + du);
        const j11 = (ta.x - pa.x) / dt; const j21 = (ta.y - pa.y) / dt;
        const j12 = -(ub.x - pb.x) / du; const j22 = -(ub.y - pb.y) / du;
        const det = j11 * j22 - j12 * j21;
        if (Math.abs(det) < 1e-15) break;
        t -= (fx * j22 - fy * j12) / det;
        u -= (j11 * fy - j21 * fx) / det;
      }
      push(t);
    }
  }
  return out;
}

/** Unit direction of travel of curve `e` at parameter `t`. */
export function curveTangent(sk, e, t) {
  const [t0, t1] = curveSpan(sk, e);
  const closed = curveIsClosed(e);
  const h = (t1 - t0) * 1e-6;
  const a = curveAt(sk, e, closed ? t - h : Math.max(t0, t - h));
  const b = curveAt(sk, e, closed ? t + h : Math.min(t1, t + h));
  if (!a || !b) return null;
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  return l > 0 ? { x: (b.x - a.x) / l, y: (b.y - a.y) / l } : null;
}

/**
 * Offset of curve `e` by `dist` (left of its direction of travel) as the points
 * of a spline through it: the true offset is no ellipse or spline, so it is
 * sampled finely enough — 64 round an ellipse, 6 per spline span — for the
 * spline through those samples to stay close to it. `{ pts: [[x, y]…], closed }`
 * or null.
 */
export function offsetCurvePoints(sk, e, dist) {
  const [t0, t1] = curveSpan(sk, e);
  const closed = curveIsClosed(e);
  const perUnit = e.type === 'ellipse' ? 64 / (2 * Math.PI) : 6;
  const steps = Math.max(2, Math.ceil((t1 - t0) * perUnit - 1e-9));
  const pts = [];
  for (let i = 0; i < (closed ? steps : steps + 1); i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const p = curveAt(sk, e, t);
    const d = curveTangent(sk, e, t);
    if (!p || !d) return null;
    pts.push([p.x - d.y * dist, p.y + d.x * dist]);
  }
  return { pts, closed };
}

/** Distance from (x, y) to a polyline (closed or not). */
export function polylineDistance(points, closed, x, y) {
  const n = points.length / 2;
  let best = Infinity;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const ax = points[i * 2]; const ay = points[i * 2 + 1];
    const dx = points[j * 2] - ax; const dy = points[j * 2 + 1] - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/** The ellipse or spline nearest (x, y) within `tol`, else null. */
export function hitTestCurve(sk, x, y, tol = 1e-6) {
  let best = null;
  let bestD = tol;
  for (const e of sk.entities.values()) {
    if (!isCurve(e)) continue;
    const c = curveOf(sk, e);
    if (!c) continue;
    const [x0, y0, x1, y1] = c.box;
    if (x < x0 - bestD || x > x1 + bestD || y < y0 - bestD || y > y1 + bestD) continue;
    const d = polylineDistance(c.points, c.closed, x, y);
    if (d <= bestD) { bestD = d; best = e.id; }
  }
  return best;
}
