/**
 * Phase 2 — sketch editing operations (dependency-free).
 *
 * The pure "brain" of the interactive sketcher: the geometry/selection logic any
 * UI needs, independent of how the sketch is rendered or how clicks arrive.
 * Screen→sketch coordinate mapping and event handling live in the view layer;
 * everything here is testable under plain Node.
 */
import { addPoint, addLine } from './model.js';

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
