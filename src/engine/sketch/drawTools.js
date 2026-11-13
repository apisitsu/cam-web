/**
 * The geometry behind the sketch tools added beside Line / Rectangle / Arc:
 * Center Rectangle, 3-Point Arc, Tangent Arc and Extend.
 *
 * Each builds into a sketch document through the model's own add functions, so
 * what it makes is ordinary lines, arcs and constraints — the solver, trim,
 * dimensions and the build all treat it like anything drawn by hand.
 *
 * Pure: plain arrays and the sketch document, no store, no React.
 */
import { addPoint, addLine, addArc, addConstraint } from './model.js';

const TAU = Math.PI * 2;
const norm = (a) => ((a % TAU) + TAU) % TAU;

/**
 * A rectangle about its centre: the click sets the centre, the second a corner.
 * The centre stays the rectangle's centre through edits: it is the midpoint of a
 * construction diagonal, which is how SolidWorks holds it.
 *
 * @returns {{lines:number[], center:number}|null} null if it has no size
 */
export function buildCenterRectangle(sk, centerId, x, y) {
  const c = sk.entities.get(centerId);
  const hx = Math.abs(x - c.x);
  const hy = Math.abs(y - c.y);
  if (hx < 1e-6 || hy < 1e-6) return null;
  const p = [
    addPoint(sk, c.x - hx, c.y - hy),
    addPoint(sk, c.x + hx, c.y - hy),
    addPoint(sk, c.x + hx, c.y + hy),
    addPoint(sk, c.x - hx, c.y + hy),
  ];
  const lines = p.map((a, i) => addLine(sk, a, p[(i + 1) % 4]));
  addConstraint(sk, 'horizontal', [p[0], p[1]]);
  addConstraint(sk, 'horizontal', [p[3], p[2]]);
  addConstraint(sk, 'vertical', [p[1], p[2]]);
  addConstraint(sk, 'vertical', [p[0], p[3]]);
  const diagonal = addLine(sk, p[0], p[2]);
  sk.entities.get(diagonal).construction = true;
  addConstraint(sk, 'midpoint', [centerId, diagonal]);
  return { lines, center: centerId, diagonal };
}

/** The circle through three points, or null if they are in a line. */
export function circleThrough3(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}

/** Whether angle `t` lies on the counter-clockwise sweep from `a0` to `a1`. */
const onSweep = (a0, a1, t) => norm(t - a0) <= norm(a1 - a0) + 1e-12;

/**
 * A 3-Point Arc: the two ends, then a point the arc passes through. The arc
 * model always sweeps counter-clockwise from start to end, so the ends are
 * swapped when the third point is on the clockwise side.
 *
 * @returns {number|null} the arc id, or null when the three are in a line
 */
export function buildArc3(sk, startId, endId, x, y) {
  const s = sk.entities.get(startId);
  const e = sk.entities.get(endId);
  const c = circleThrough3(s, e, { x, y });
  if (!c || c.r > 1e6) return null;
  const a0 = Math.atan2(s.y - c.y, s.x - c.x);
  const a1 = Math.atan2(e.y - c.y, e.x - c.x);
  const t = Math.atan2(y - c.y, x - c.x);
  const center = addPoint(sk, c.x, c.y);
  return onSweep(a0, a1, t)
    ? addArc(sk, center, startId, endId, c.r)
    : addArc(sk, center, endId, startId, c.r);
}

/**
 * Where a curve leaves one of its ends, as a unit direction: along a line away
 * from its other end, along an arc's tangent in the direction it was running.
 */
export function leavingDirection(sk, entityId, pointId) {
  const ent = sk.entities.get(entityId);
  const P = (id) => sk.entities.get(id);
  if (ent.type === 'line') {
    const other = P(ent.p1 === pointId ? ent.p2 : ent.p1);
    const at = P(pointId);
    const dx = at.x - other.x;
    const dy = at.y - other.y;
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }
  if (ent.type === 'arc') {
    const c = P(ent.center);
    const at = P(pointId);
    // CCW tangent at a point is (-ry, rx); at the end the arc runs on that way,
    // at the start it arrived from it, so leaving the start goes the other way.
    const rx = at.x - c.x;
    const ry = at.y - c.y;
    const l = Math.hypot(rx, ry) || 1;
    const sign = pointId === ent.end ? 1 : -1;
    return [(-ry / l) * sign, (rx / l) * sign];
  }
  return null;
}

/**
 * A Tangent Arc from the end of a line or arc to a clicked point, leaving that
 * end in the direction the curve was going, and held tangent by a relation.
 *
 * @returns {number|null} the arc id; null if the point is straight ahead
 */
export function buildTangentArc(sk, fromEntityId, fromPointId, x, y) {
  const d = leavingDirection(sk, fromEntityId, fromPointId);
  if (!d) return null;
  const s = sk.entities.get(fromPointId);
  const ex = x - s.x;
  const ey = y - s.y;
  // Centre on the normal through the start, equally far from start and end.
  const n = [-d[1], d[0]];
  const dn = ex * n[0] + ey * n[1];
  if (Math.abs(dn) < 1e-9) return null;
  const t = (ex * ex + ey * ey) / (2 * dn);
  const cx = s.x + n[0] * t;
  const cy = s.y + n[1] * t;
  const r = Math.abs(t);
  const center = addPoint(sk, cx, cy);
  const end = addPoint(sk, x, y);
  // Turning left (centre on the left, t > 0) the arc runs CCW from the start.
  const arc = t > 0 ? addArc(sk, center, fromPointId, end, r) : addArc(sk, center, end, fromPointId, r);
  const from = sk.entities.get(fromEntityId);
  try {
    addConstraint(sk, from.type === 'line' ? 'tangentArc' : 'tangentArcArc', from.type === 'line' ? [fromEntityId, arc] : [fromEntityId, arc]);
  } catch {
    // Left untied rather than refusing the arc.
  }
  return arc;
}

/** Distances along a ray to where it meets one sketch entity (t > 0). */
function rayHits(sk, ox, oy, dx, dy, ent) {
  const P = (id) => sk.entities.get(id);
  const out = [];
  if (ent.type === 'line') {
    const a = P(ent.p1);
    const b = P(ent.p2);
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) return out;
    const t = ((a.x - ox) * ey - (a.y - oy) * ex) / den;
    const u = ((a.x - ox) * dy - (a.y - oy) * dx) / den;
    if (u >= -1e-9 && u <= 1 + 1e-9) out.push(t);
    return out;
  }
  if (ent.type === 'circle' || ent.type === 'arc') {
    const c = P(ent.center);
    const r = ent.r;
    const fx = ox - c.x;
    const fy = oy - c.y;
    const b = fx * dx + fy * dy;
    const disc = b * b - (fx * fx + fy * fy - r * r);
    if (disc < 0) return out;
    const sq = Math.sqrt(disc);
    for (const t of [-b - sq, -b + sq]) {
      if (ent.type === 'arc') {
        const s = P(ent.start);
        const e = P(ent.end);
        const ang = Math.atan2(oy + dy * t - c.y, ox + dx * t - c.x);
        if (!onSweep(Math.atan2(s.y - c.y, s.x - c.x), Math.atan2(e.y - c.y, e.x - c.x), ang)) continue;
      }
      out.push(t);
    }
  }
  return out;
}

/**
 * Extend a line from its end nearer (x, y) to the first thing it meets.
 *
 * @returns {{point:number, x:number, y:number}|{error:string}}
 */
export function extendLine(sk, lineId, x, y) {
  const line = sk.entities.get(lineId);
  const a = sk.entities.get(line.p1);
  const b = sk.entities.get(line.p2);
  const nearP1 = Math.hypot(x - a.x, y - a.y) < Math.hypot(x - b.x, y - b.y);
  const endId = nearP1 ? line.p1 : line.p2;
  const end = nearP1 ? a : b;
  const other = nearP1 ? b : a;
  const len = Math.hypot(end.x - other.x, end.y - other.y);
  if (len < 1e-9) return { error: 'That line has no length.' };
  const dx = (end.x - other.x) / len;
  const dy = (end.y - other.y) / len;
  // An end shared with another curve is a corner: moving it would drag that too.
  for (const ent of sk.entities.values()) {
    if (ent.id === lineId) continue;
    if ((ent.type === 'line' && (ent.p1 === endId || ent.p2 === endId))
      || (ent.type === 'arc' && (ent.start === endId || ent.end === endId))) {
      return { error: 'That end is joined to another line — Extend works on a free end.' };
    }
  }
  let best = Infinity;
  for (const ent of sk.entities.values()) {
    if (ent.id === lineId || ent.type === 'point' || ent.construction) continue;
    for (const t of rayHits(sk, end.x, end.y, dx, dy, ent)) {
      if (t > 1e-6 && t < best) best = t;
    }
  }
  if (!Number.isFinite(best)) return { error: 'Nothing lies ahead of that end to extend it to.' };
  const nx = end.x + dx * best;
  const ny = end.y + dy * best;
  end.x = nx;
  end.y = ny;
  return { point: endId, x: nx, y: ny };
}
