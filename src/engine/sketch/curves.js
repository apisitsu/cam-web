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
  const knot = (a, b) => Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-9);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const lerp = (a, b, ta, tb, t) => [
    ((tb - t) / (tb - ta)) * a[0] + ((t - ta) / (tb - ta)) * b[0],
    ((tb - t) / (tb - ta)) * a[1] + ((t - ta) / (tb - ta)) * b[1],
  ];
  for (let s = 1; s <= steps; s++) {
    const t = t1 + ((t2 - t1) * s) / steps;
    const A1 = lerp(p0, p1, t0, t1, t); const A2 = lerp(p1, p2, t1, t2, t); const A3 = lerp(p2, p3, t2, t3, t);
    const B1 = lerp(A1, A2, t0, t2, t); const B2 = lerp(A2, A3, t1, t3, t);
    const C = lerp(B1, B2, t1, t2, t);
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

/** An ellipse or spline entity as `{ points, closed }`, or null when it cannot be drawn. */
export function curveOf(sk, e) {
  const P = (id) => sk.entities.get(id);
  if (e.type === 'ellipse') {
    const c = P(e.center); const m = P(e.major);
    if (!c || !m) return null;
    const points = ellipsePoints(c, m, e.rb);
    return points.length ? { points, closed: true } : null;
  }
  if (e.type === 'spline') {
    const pts = e.pts.map(P);
    if (pts.some((p) => !p)) return null;
    const points = splinePoints(pts.map((p) => [p.x, p.y]), !!e.closed);
    return points.length ? { points, closed: !!e.closed } : null;
  }
  return null;
}

/** Points an ellipse or spline is drawn through. */
export const curveRefs = (e) => (e.type === 'ellipse' ? [e.center, e.major] : e.type === 'spline' ? e.pts : []);

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
    if (e.type !== 'ellipse' && e.type !== 'spline') continue;
    const c = curveOf(sk, e);
    if (!c) continue;
    const d = polylineDistance(c.points, c.closed, x, y);
    if (d <= bestD) { bestD = d; best = e.id; }
  }
  return best;
}
