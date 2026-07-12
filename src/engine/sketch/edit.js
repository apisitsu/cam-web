/**
 * Phase 2 — sketch editing operations (dependency-free).
 *
 * The pure "brain" of the interactive sketcher: the geometry/selection logic any
 * UI needs, independent of how the sketch is rendered or how clicks arrive.
 * Screen→sketch coordinate mapping and event handling live in the view layer;
 * everything here is testable under plain Node.
 */
import { addPoint } from './model.js';

const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

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
 * Return the id of an existing point within `tol` of (x, y), or create one.
 * This is what makes clicking a shared corner reuse the same point — the whole
 * reason the model is point-based — so closed profiles are coincident for free.
 */
export function getOrCreatePoint(sk, x, y, tol = 1e-6) {
  const hit = hitTestPoint(sk, x, y, tol);
  return hit ?? addPoint(sk, x, y);
}

/** Entity ids that reference `id` directly (lines via endpoints, circles via centre). */
function dependents(sk, id) {
  const out = [];
  for (const e of sk.entities.values()) {
    if (e.type === 'line' && (e.p1 === id || e.p2 === id)) out.push(e.id);
    else if (e.type === 'circle' && e.center === id) out.push(e.id);
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
