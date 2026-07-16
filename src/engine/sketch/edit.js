/**
 * Phase 2 — sketch editing operations (dependency-free).
 *
 * The pure "brain" of the interactive sketcher: the geometry/selection logic any
 * UI needs, independent of how the sketch is rendered or how clicks arrive.
 * Screen→sketch coordinate mapping and event handling live in the view layer;
 * everything here is testable under plain Node.
 */
import { addPoint, addLine, addArc } from './model.js';

const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

/** Unit vector from point `from` to point `to` (falls back to +x if degenerate). */
function unit(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: 1, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** Perpendicular distance from (px, py) to the infinite line through a and b. */
function pointLineDist(px, py, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len = Math.hypot(abx, aby);
  if (len < 1e-9) return Math.hypot(px - a.x, py - a.y);
  return Math.abs((px - a.x) * aby - (py - a.y) * abx) / len;
}

/**
 * Nearest point entity to (x, y) within `tol`, or null. Used for click snapping
 * and hover highlight.
 */
export function hitTestPoint(sk, x, y, tol = 1e-6) {
  const t2 = tol * tol;
  let best = null;
  let bestD = t2;
  for (const e of sk.entities.values()) {
    if (e.type !== 'point') continue;
    const d = dist2(e.x, e.y, x, y);
    if (d <= bestD) {
      bestD = d;
      best = e.id;
    }
  }
  return best;
}

/**
 * Point-to-segment squared distance from (px, py) to segment (ax,ay)-(bx,by).
 */
function segDist2(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return dist2(px, py, cx, cy);
}

/**
 * Nearest line entity to (x, y) within `tol` (point-to-segment distance), or
 * null. Mirrors `hitTestPoint` but for line geometry — used to let select mode
 * pick lines for the line constraints (parallel/perpendicular/equal length/
 * point-on-line).
 */
export function hitTestLine(sk, x, y, tol = 1e-6) {
  const t2 = tol * tol;
  let best = null;
  let bestD = t2;
  for (const e of sk.entities.values()) {
    if (e.type !== 'line') continue;
    const a = sk.entities.get(e.p1);
    const b = sk.entities.get(e.p2);
    if (!a || !b) continue;
    const d = segDist2(x, y, a.x, a.y, b.x, b.y);
    if (d <= bestD) {
      bestD = d;
      best = e.id;
    }
  }
  return best;
}

/**
 * Nearest circle entity to (x, y) whose *ring* passes within `tol` — i.e.
 * |dist(center, point) - r| <= tol — or null. Used for click selection of a
 * circle (for the radius dimension), distinct from hitTestPoint's centre-only
 * point picking.
 */
export function hitTestCircle(sk, x, y, tol = 1e-6) {
  let best = null;
  let bestErr = tol;
  for (const e of sk.entities.values()) {
    if (e.type !== 'circle') continue;
    const c = sk.entities.get(e.center);
    if (!c) continue;
    const d = Math.hypot(c.x - x, c.y - y);
    const err = Math.abs(d - e.r);
    if (err <= bestErr) {
      bestErr = err;
      best = e.id;
    }
  }
  return best;
}

/**
 * Nearest arc entity whose drawn sweep passes within `tol` of (x, y), or null.
 * Like `hitTestCircle` but only counts the point if it also falls within the
 * arc's angular span — planegcs sweeps counter-clockwise from start to end, so
 * that is the span we test against.
 */
export function hitTestArc(sk, x, y, tol = 1e-6) {
  let best = null;
  let bestErr = tol;
  for (const e of sk.entities.values()) {
    if (e.type !== 'arc') continue;
    const c = sk.entities.get(e.center);
    const s = sk.entities.get(e.start);
    const en = sk.entities.get(e.end);
    if (!c || !s || !en) continue;
    const err = Math.abs(Math.hypot(c.x - x, c.y - y) - e.r);
    if (err > bestErr) continue;
    const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const a0 = norm(Math.atan2(s.y - c.y, s.x - c.x));
    const a1 = norm(Math.atan2(en.y - c.y, en.x - c.x));
    const at = norm(Math.atan2(y - c.y, x - c.x));
    const span = norm(a1 - a0);
    if (norm(at - a0) <= span) {
      bestErr = err;
      best = e.id;
    }
  }
  return best;
}

/**
 * Return the id of an existing point within `tol` of (x, y), or create one.
 * This is what makes clicking a shared corner reuse the same point — the whole
 * reason the model is point-based — so closed profiles are coincident for free.
 */
export function getOrCreatePoint(sk, x, y, tol = 1e-6) {
  const hit = hitTestPoint(sk, x, y, tol);
  return hit ?? addPoint(sk, x, y);
}

/**
 * Entity ids that reference `id` directly: lines via endpoints, circles via
 * centre, arcs via centre or either endpoint.
 */
function dependents(sk, id) {
  const out = [];
  for (const e of sk.entities.values()) {
    if (e.type === 'line' && (e.p1 === id || e.p2 === id)) out.push(e.id);
    else if (e.type === 'circle' && e.center === id) out.push(e.id);
    else if (e.type === 'arc' && (e.center === id || e.start === id || e.end === id)) out.push(e.id);
  }
  return out;
}

/**
 * Delete an entity and everything that depends on it: a point takes its lines
 * and circles with it, and any constraint that referenced a removed entity is
 * dropped. Returns the set of removed entity ids.
 */
export function deleteEntity(sk, id) {
  if (!sk.entities.has(id)) return new Set();
  const removed = new Set([id]);
  // A point can orphan geometry; collect that geometry too (one level is enough —
  // lines/circles are not referenced by other geometry).
  for (const depId of dependents(sk, id)) removed.add(depId);
  for (const rid of removed) sk.entities.delete(rid);
  sk.constraints = sk.constraints.filter((c) => !c.refs.some((r) => removed.has(r)));
  return removed;
}

/** Remove a constraint by index. Returns true if one was removed. */
export function removeConstraint(sk, index) {
  if (index < 0 || index >= sk.constraints.length) return false;
  sk.constraints.splice(index, 1);
  return true;
}

/**
 * Chamfer the corner where two lines meet: find the point they share, pull each
 * line's shared endpoint back by `dist` along its own direction to a new point,
 * drop the old corner (and any constraint on it), and join the two new points
 * with a chamfer line. Returns the chamfer line id, or null if the lines don't
 * share a corner or `dist` is not usable. All done on the point-based model, so
 * no arc primitive is needed.
 */
export function chamfer(sk, l1Id, l2Id, dist) {
  const l1 = sk.entities.get(l1Id);
  const l2 = sk.entities.get(l2Id);
  if (!l1 || l1.type !== 'line' || !l2 || l2.type !== 'line') return null;
  if (!(dist > 0)) return null;
  const shared = [l1.p1, l1.p2].find((id) => id === l2.p1 || id === l2.p2);
  if (shared == null) return null;
  const P = sk.entities.get(shared);
  const far1 = sk.entities.get(l1.p1 === shared ? l1.p2 : l1.p1);
  const far2 = sk.entities.get(l2.p1 === shared ? l2.p2 : l2.p1);
  // Don't chamfer past either line's far end.
  if (dist >= Math.hypot(far1.x - P.x, far1.y - P.y)) return null;
  if (dist >= Math.hypot(far2.x - P.x, far2.y - P.y)) return null;
  const u1 = unit(P, far1);
  const u2 = unit(P, far2);
  const c1 = addPoint(sk, P.x + u1.x * dist, P.y + u1.y * dist);
  const c2 = addPoint(sk, P.x + u2.x * dist, P.y + u2.y * dist);
  // Re-point the two lines off the old corner and onto the new chamfer points.
  if (l1.p1 === shared) l1.p1 = c1; else l1.p2 = c1;
  if (l2.p1 === shared) l2.p1 = c2; else l2.p2 = c2;
  const line = addLine(sk, c1, c2);
  deleteEntity(sk, shared); // orphaned corner + any constraint referencing it
  return line;
}

/**
 * Perpendicular distance from a point entity to a line entity's infinite line,
 * or null if either id is wrong. Used to seed dimension prompts (line↔point,
 * line↔circle-centre) with the current geometric value.
 */
export function distancePointToLine(sk, pointId, lineId) {
  const p = sk.entities.get(pointId);
  const l = sk.entities.get(lineId);
  if (!p || p.type !== 'point' || !l || l.type !== 'line') return null;
  const a = sk.entities.get(l.p1);
  const b = sk.entities.get(l.p2);
  if (!a || !b) return null;
  return pointLineDist(p.x, p.y, a, b);
}

/**
 * Of line `lineId`'s two endpoints, the id of the one farther (perpendicular)
 * from the infinite line through `refLineId`. Used to dimension the gap between
 * two lines robustly: if the lines share a corner that endpoint sits at distance
 * 0, so the *other* endpoint is picked and the dimension stays meaningful. For
 * parallel lines both endpoints are equidistant and p1 is returned.
 */
export function farEndpointFromLine(sk, lineId, refLineId) {
  const l = sk.entities.get(lineId);
  const r = sk.entities.get(refLineId);
  if (!l || l.type !== 'line' || !r || r.type !== 'line') return null;
  const ra = sk.entities.get(r.p1);
  const rb = sk.entities.get(r.p2);
  const p1 = sk.entities.get(l.p1);
  const p2 = sk.entities.get(l.p2);
  const d1 = pointLineDist(p1.x, p1.y, ra, rb);
  const d2 = pointLineDist(p2.x, p2.y, ra, rb);
  return d2 > d1 ? l.p2 : l.p1;
}

/** Intersection of segment a-b with segment c-d, or null if they don't cross
 *  within both spans (also null when parallel/collinear). `t` is the parameter
 *  along a-b in [0, 1]. */
function segIntersect(a, b, c, d) {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel or collinear
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, x: a.x + t * rx, y: a.y + t * ry };
}

/** Drop a point only if nothing references it and it is not the origin/fixed. */
function removeIfOrphan(sk, pointId) {
  const p = sk.entities.get(pointId);
  if (!p || p.type !== 'point' || p.origin || p.fixed) return;
  if (dependents(sk, pointId).length === 0) deleteEntity(sk, pointId);
}

const TAU = Math.PI * 2;
const normAngle = (x) => ((x % TAU) + TAU) % TAU;

/**
 * Parameters t (along segment a→b) where the segment meets the circle of radius
 * r centred at (cx, cy). Returns 0–2 roots (not yet clamped to [0, 1]).
 */
function lineCircleParams(a, b, cx, cy, r) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const A = dx * dx + dy * dy;
  if (A < 1e-12) return [];
  const fx = a.x - cx;
  const fy = a.y - cy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
}

/** Whether (px, py) lies within arc `e`'s CCW start→end angular span. */
function arcSpanContains(sk, e, px, py) {
  const c = sk.entities.get(e.center);
  const s = sk.entities.get(e.start);
  const en = sk.entities.get(e.end);
  if (!c || !s || !en) return false;
  const a0 = normAngle(Math.atan2(s.y - c.y, s.x - c.x));
  const a1 = normAngle(Math.atan2(en.y - c.y, en.x - c.x));
  const at = normAngle(Math.atan2(py - c.y, px - c.x));
  const span = normAngle(a1 - a0) || TAU;
  return normAngle(at - a0) <= span;
}

/**
 * Trim a line at its intersections with the *other* geometry (lines, circles and
 * arcs), removing only the sub-segment the click (x, y) falls in — the CAD "trim"
 * gesture. Interior crossings split the line into pieces; the piece under the
 * click is removed and the rest kept:
 *   - click on an end piece   → shorten the line back to the nearest crossing;
 *   - click on a middle piece → split into two lines (original shortened + a new
 *     line for the far remainder).
 * A line with no crossings is left untouched (trim never deletes a whole entity —
 * use Delete for that). New endpoints are created at the cut points; endpoints
 * orphaned by re-pointing are cleaned up. Returns { line, added } describing what
 * changed, or null if `lineId` is not a usable line or nothing could be trimmed.
 */
export function trimLine(sk, lineId, x, y) {
  const l = sk.entities.get(lineId);
  if (!l || l.type !== 'line') return null;
  const a = sk.entities.get(l.p1);
  const b = sk.entities.get(l.p2);
  if (!a || !b) return null;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return null;

  // Parameters (0..1 along the line) where other geometry crosses it, strictly
  // interior so we never make a zero-length stub at an existing endpoint.
  const cuts = [];
  const interior = (t) => t > 1e-6 && t < 1 - 1e-6;
  for (const e of sk.entities.values()) {
    if (e.id === lineId) continue;
    if (e.type === 'line') {
      const c = sk.entities.get(e.p1);
      const d = sk.entities.get(e.p2);
      if (!c || !d) continue;
      const hit = segIntersect(a, b, c, d);
      if (hit && interior(hit.t)) cuts.push(hit.t);
    } else if (e.type === 'circle') {
      const c = sk.entities.get(e.center);
      if (!c) continue;
      for (const t of lineCircleParams(a, b, c.x, c.y, e.r)) if (interior(t)) cuts.push(t);
    } else if (e.type === 'arc') {
      const c = sk.entities.get(e.center);
      if (!c) continue;
      for (const t of lineCircleParams(a, b, c.x, c.y, e.r)) {
        if (!interior(t)) continue;
        if (arcSpanContains(sk, e, a.x + abx * t, a.y + aby * t)) cuts.push(t);
      }
    }
  }
  cuts.sort((p, q) => p - q);
  if (cuts.length === 0) return null; // nothing crosses this line → nothing to trim

  // Sub-interval [t0, t1] the click falls in (click projected onto the line).
  let tc = ((x - a.x) * abx + (y - a.y) * aby) / len2;
  tc = Math.max(0, Math.min(1, tc));
  const bounds = [0, ...cuts, 1];
  let i = 0;
  while (i < bounds.length - 1 && tc > bounds[i + 1]) i++;
  const t0 = bounds[i];
  const t1 = bounds[i + 1];

  const at = (t) => addPoint(sk, a.x + abx * t, a.y + aby * t);
  const keepLow = t0 > 1e-9; // segment [0, t0] survives
  const keepHigh = t1 < 1 - 1e-9; // segment [t1, 1] survives
  if (!keepLow && !keepHigh) return null; // defensive — cuts guarantee one side

  const oldP1 = l.p1;
  const oldP2 = l.p2;
  let added = null;
  if (keepLow && keepHigh) {
    // Interior click → split: original keeps [0, t0], a new line gets [t1, 1].
    l.p2 = at(t0);
    added = addLine(sk, at(t1), oldP2);
  } else if (keepLow) {
    l.p2 = at(t0); // click reached the b end → shorten to [0, t0]
  } else {
    l.p1 = at(t1); // click reached the a end → shorten to [t1, 1]
  }
  removeIfOrphan(sk, oldP1);
  removeIfOrphan(sk, oldP2);
  return { line: lineId, added };
}

/**
 * Intersection points of two circles (centres c0/c1, radii r0/r1), each lying on
 * *both* rims. Returns 0–2 points; empty for concentric, separate, or one-inside
 * -the-other circles (no tangent double-root special-case — a grazing touch
 * yields the single midpoint).
 */
function circleCircleInts(c0x, c0y, r0, c1x, c1y, r1) {
  const dx = c1x - c0x;
  const dy = c1y - c0y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return []; // concentric
  if (d > r0 + r1 + 1e-9) return []; // too far apart
  if (d < Math.abs(r0 - r1) - 1e-9) return []; // one inside the other
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h2 = r0 * r0 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const xm = c0x + (a * dx) / d;
  const ym = c0y + (a * dy) / d;
  const ox = (-dy / d) * h;
  const oy = (dx / d) * h;
  if (h < 1e-9) return [{ x: xm, y: ym }];
  return [{ x: xm + ox, y: ym + oy }, { x: xm - ox, y: ym - oy }];
}

/**
 * Points where the circle of radius `r` centred at (cx, cy) crosses every *other*
 * entity, respecting each other entity's real extent: line **segments**, full
 * circles, and an arc's swept **span**. `selfId` is skipped. Used by trimCircle /
 * trimArc to find the cut points on the curve being trimmed.
 */
export function circleIntersections(sk, cx, cy, r, selfId) {
  const out = [];
  for (const e of sk.entities.values()) {
    if (e.id === selfId) continue;
    if (e.type === 'line') {
      const a = sk.entities.get(e.p1);
      const b = sk.entities.get(e.p2);
      if (!a || !b) continue;
      for (const t of lineCircleParams(a, b, cx, cy, r)) {
        if (t >= -1e-9 && t <= 1 + 1e-9) out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    } else if (e.type === 'circle') {
      const oc = sk.entities.get(e.center);
      if (!oc) continue;
      for (const p of circleCircleInts(cx, cy, r, oc.x, oc.y, e.r)) out.push(p);
    } else if (e.type === 'arc') {
      const oc = sk.entities.get(e.center);
      if (!oc) continue;
      for (const p of circleCircleInts(cx, cy, r, oc.x, oc.y, e.r)) {
        if (arcSpanContains(sk, e, p.x, p.y)) out.push(p);
      }
    }
  }
  return out;
}

/** Crossing angles of `pts` about (cx, cy), sorted CCW and de-duplicated. */
function sortedCutAngles(pts, cx, cy) {
  const angs = pts
    .map((p) => normAngle(Math.atan2(p.y - cy, p.x - cx)))
    .sort((u, v) => u - v);
  const uniq = [];
  for (const a of angs) {
    if (!uniq.length || normAngle(a - uniq[uniq.length - 1]) > 1e-6) uniq.push(a);
  }
  if (uniq.length >= 2 && normAngle(uniq[0] - uniq[uniq.length - 1]) < 1e-6) uniq.pop();
  return uniq;
}

/**
 * Trim a **circle** at its crossings with other geometry: remove the rim segment
 * the click (x, y) falls in and keep the rest, turning the circle into an arc that
 * sweeps CCW around the surviving portion. Needs ≥2 crossings (a full circle has
 * no free end to trim back to otherwise); fewer is a no-op. The circle's radius
 * constraints go with it. Returns { removed, added } (old circle id, new arc id),
 * or null if nothing could be trimmed.
 */
export function trimCircle(sk, circleId, x, y) {
  const circle = sk.entities.get(circleId);
  if (!circle || circle.type !== 'circle') return null;
  const c = sk.entities.get(circle.center);
  if (!c) return null;
  const r = circle.r;
  const cuts = sortedCutAngles(circleIntersections(sk, c.x, c.y, r, circleId), c.x, c.y);
  if (cuts.length < 2) return null;

  // Which gap between consecutive crossings (cyclic) does the click fall in?
  const ac = normAngle(Math.atan2(y - c.y, x - c.x));
  let i = 0;
  for (let k = 0; k < cuts.length; k++) {
    const span = normAngle(cuts[(k + 1) % cuts.length] - cuts[k]) || TAU;
    if (normAngle(ac - cuts[k]) <= span) { i = k; break; }
  }
  const lo = cuts[i]; // start of the removed segment (CCW)
  const hi = cuts[(i + 1) % cuts.length]; // end of the removed segment
  // Surviving arc sweeps CCW from hi back around to lo.
  const startId = addPoint(sk, c.x + r * Math.cos(hi), c.y + r * Math.sin(hi));
  const endId = addPoint(sk, c.x + r * Math.cos(lo), c.y + r * Math.sin(lo));
  const arc = addArc(sk, circle.center, startId, endId, r);
  deleteEntity(sk, circleId);
  return { removed: circleId, added: arc };
}

/**
 * Trim an **arc** at its crossings with other geometry — the arc analogue of
 * `trimLine`. Interior crossings split the arc's span; the sub-arc under the
 * click is removed:
 *   - click on an end sub-arc → shorten the arc to the nearest crossing;
 *   - click on a middle sub-arc → split into two arcs (original + a new one).
 * An arc with no interior crossings is left untouched. New endpoint points are
 * created at the cuts; endpoints orphaned by re-pointing are cleaned up. Returns
 * { arc, added } or null.
 */
export function trimArc(sk, arcId, x, y) {
  const arc = sk.entities.get(arcId);
  if (!arc || arc.type !== 'arc') return null;
  const c = sk.entities.get(arc.center);
  const s = sk.entities.get(arc.start);
  const en = sk.entities.get(arc.end);
  if (!c || !s || !en) return null;
  const r = arc.r;
  const a0 = normAngle(Math.atan2(s.y - c.y, s.x - c.x));
  const span = normAngle(normAngle(Math.atan2(en.y - c.y, en.x - c.x)) - a0) || TAU;

  const cuts = [];
  for (const p of circleIntersections(sk, c.x, c.y, r, arcId)) {
    const off = normAngle(normAngle(Math.atan2(p.y - c.y, p.x - c.x)) - a0);
    if (off > 1e-6 && off < span - 1e-6) cuts.push(off);
  }
  cuts.sort((u, v) => u - v);
  if (cuts.length === 0) return null;

  let tc = normAngle(normAngle(Math.atan2(y - c.y, x - c.x)) - a0);
  tc = Math.max(0, Math.min(span, tc));
  const bounds = [0, ...cuts, span];
  let i = 0;
  while (i < bounds.length - 1 && tc > bounds[i + 1]) i++;
  const o0 = bounds[i];
  const o1 = bounds[i + 1];

  const ptAt = (off) => addPoint(sk, c.x + r * Math.cos(a0 + off), c.y + r * Math.sin(a0 + off));
  const keepLow = o0 > 1e-9; // sub-arc [0, o0] survives
  const keepHigh = o1 < span - 1e-9; // sub-arc [o1, span] survives
  if (!keepLow && !keepHigh) return null; // defensive — cuts guarantee one side

  const oldStart = arc.start;
  const oldEnd = arc.end;
  let added = null;
  if (keepLow && keepHigh) {
    arc.end = ptAt(o0); // original keeps [start, o0]
    added = addArc(sk, arc.center, ptAt(o1), oldEnd, r); // new arc [o1, end]
  } else if (keepLow) {
    arc.end = ptAt(o0);
  } else {
    arc.start = ptAt(o1);
  }
  removeIfOrphan(sk, oldStart);
  removeIfOrphan(sk, oldEnd);
  return { arc: arcId, added };
}

/**
 * Axis-aligned XY bounds of the drawn sketch geometry as { min:[x,y,z],
 * max:[x,y,z] } (z = 0 — the sketch lies on the machine XY plane), or null when
 * there is nothing to frame. The lone origin point is ignored so an empty sketch
 * returns null (callers fall back to their default framing); every other point,
 * whole circle, and arc sweep is included. Used to fit the camera to the sketch.
 */
export function sketchBounds(sk) {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  let has = false;
  const acc = (px, py) => {
    if (px < minx) minx = px;
    if (py < miny) miny = py;
    if (px > maxx) maxx = px;
    if (py > maxy) maxy = py;
    has = true;
  };
  for (const e of sk.entities.values()) {
    if (e.type === 'point') {
      if (e.origin) continue; // origin alone shouldn't define the frame
      acc(e.x, e.y);
    } else if (e.type === 'circle') {
      const c = sk.entities.get(e.center);
      if (c) { acc(c.x - e.r, c.y - e.r); acc(c.x + e.r, c.y + e.r); }
    } else if (e.type === 'arc') {
      const c = sk.entities.get(e.center);
      const s = sk.entities.get(e.start);
      const en = sk.entities.get(e.end);
      if (!c || !s || !en) continue;
      acc(s.x, s.y);
      acc(en.x, en.y);
      const a0 = normAngle(Math.atan2(s.y - c.y, s.x - c.x));
      const sp = normAngle(normAngle(Math.atan2(en.y - c.y, en.x - c.x)) - a0) || TAU;
      // Add each axis extreme (0/90/180/270°) that the sweep actually passes.
      for (const ext of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
        if (normAngle(ext - a0) <= sp) acc(c.x + e.r * Math.cos(ext), c.y + e.r * Math.sin(ext));
      }
    }
  }
  if (!has) return null;
  return { min: [minx, miny, 0], max: [maxx, maxy, 0] };
}

/**
 * Nearest point on a circle or arc **rim** within `tol` of (x, y), or null. The
 * returned { id, type, x, y } gives the entity and the projected rim coordinate,
 * so a draw click can drop its point exactly on the ring (and be tied there with
 * a point-on-circle/arc constraint). Existing vertices take priority over this —
 * callers try `hitTestPoint` first.
 */
export function nearestRimPoint(sk, x, y, tol = 1e-6) {
  let best = null;
  let bestErr = tol;
  for (const e of sk.entities.values()) {
    if (e.type !== 'circle' && e.type !== 'arc') continue;
    const c = sk.entities.get(e.center);
    if (!c) continue;
    const d = Math.hypot(x - c.x, y - c.y);
    if (d < 1e-9) continue;
    const err = Math.abs(d - e.r);
    if (err > bestErr) continue;
    const px = c.x + ((x - c.x) / d) * e.r;
    const py = c.y + ((y - c.y) / d) * e.r;
    if (e.type === 'arc' && !arcSpanContains(sk, e, px, py)) continue;
    bestErr = err;
    best = { id: e.id, type: e.type, x: px, y: py };
  }
  return best;
}
