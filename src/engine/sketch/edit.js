/**
 * Phase 2 — sketch editing operations (dependency-free).
 *
 * The pure "brain" of the interactive sketcher: the geometry/selection logic any
 * UI needs, independent of how the sketch is rendered or how clicks arrive.
 * Screen→sketch coordinate mapping and event handling live in the view layer;
 * everything here is testable under plain Node.
 */
import { addPoint, addLine, addCircle, addArc, addConstraint } from './model.js';

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

/** Point ids referenced by a line/circle/arc (endpoints / centre), else []. */
function refPoints(e) {
  if (!e) return [];
  if (e.type === 'line') return [e.p1, e.p2];
  if (e.type === 'circle') return [e.center];
  if (e.type === 'arc') return [e.center, e.start, e.end];
  return [];
}

/**
 * Delete an entity and everything that depends on it: a point takes its lines
 * and circles with it, and any constraint that referenced a removed entity is
 * dropped. Returns the set of removed entity ids.
 *
 * With `prune`, deleting a line/circle/arc also removes any of its endpoint/centre
 * points left dangling (no other geometry uses them, and they're not the origin) —
 * SolidWorks drops those stray points instead of leaving them behind.
 */
export function deleteEntity(sk, id, prune = false) {
  if (!sk.entities.has(id)) return new Set();
  const orphanCandidates = prune ? refPoints(sk.entities.get(id)) : [];
  const removed = new Set([id]);
  // A point can orphan geometry; collect that geometry too (one level is enough —
  // lines/circles are not referenced by other geometry).
  for (const depId of dependents(sk, id)) removed.add(depId);
  for (const rid of removed) sk.entities.delete(rid);
  sk.constraints = sk.constraints.filter((c) => !c.refs.some((r) => removed.has(r)));
  for (const pid of orphanCandidates) removeIfOrphan(sk, pid);
  return removed;
}

/** Remove a constraint by index. Returns true if one was removed. */
export function removeConstraint(sk, index) {
  if (index < 0 || index >= sk.constraints.length) return false;
  sk.constraints.splice(index, 1);
  return true;
}

/**
 * Current numeric value of a dimensional constraint measured from live geometry,
 * or null for a non-dimensional kind / bad refs. Used to refresh a dimension's
 * value after its corner is chamfered/filleted so the sketch doesn't jump on the
 * next solve (the number then measures the shortened edge). `angle` is returned
 * in radians — the model's angle unit.
 */
export function measureConstraint(sk, kind, refs) {
  const P = (id) => sk.entities.get(id);
  if (kind === 'distance') {
    const a = P(refs[0]);
    const b = P(refs[1]);
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
  }
  if (kind === 'distanceX' || kind === 'distanceY') {
    const a = P(refs[0]);
    const b = P(refs[1]);
    if (!a || !b) return null;
    return kind === 'distanceX' ? b.x - a.x : b.y - a.y; // signed, matches planegcs
  }
  if (kind === 'pointLineDistance') return distancePointToLine(sk, refs[0], refs[1]);
  if (kind === 'radius' || kind === 'arcRadius') {
    const c = P(refs[0]);
    return c && (c.type === 'circle' || c.type === 'arc') ? c.r : null;
  }
  if (kind === 'diameter') {
    const c = P(refs[0]);
    return c && c.type === 'circle' ? c.r * 2 : null;
  }
  if (kind === 'lockX') {
    const p = P(refs[0]);
    return p ? p.x : null;
  }
  if (kind === 'lockY') {
    const p = P(refs[0]);
    return p ? p.y : null;
  }
  if (kind === 'angle') {
    const l1 = P(refs[0]);
    const l2 = P(refs[1]);
    if (!l1 || !l2) return null;
    const dir = (l) => {
      const a = P(l.p1);
      const b = P(l.p2);
      return Math.atan2(b.y - a.y, b.x - a.x);
    };
    return dir(l2) - dir(l1);
  }
  return null;
}

/**
 * Which orientation a point-to-point dimension should take, inferred from where
 * the user placed it — SolidWorks picks horizontal/vertical/aligned from the
 * drag direction, and the placement click is our equivalent of that drag.
 *
 * A dimension line always sits roughly *perpendicular* to the offset from the
 * geometry it measures. So of the three candidate line directions — the pair's
 * own direction (aligned), the x axis (dX), the y axis (dY) — the right one is
 * whichever is most perpendicular to the placement offset. Drag below a pair and
 * the x axis wins (dX); drag out to the side and the y axis wins (dY); drag
 * square off the line itself and aligned wins.
 *
 * Ties (e.g. an already-horizontal pair, where aligned and dX coincide) resolve
 * to 'aligned', which is the simpler constraint and measures the same thing.
 * Returns 'aligned' | 'x' | 'y'.
 */
export function axisFromPlacement(sk, aId, bId, at) {
  const a = sk.entities.get(aId);
  const b = sk.entities.get(bId);
  if (!a || !b || !at) return 'aligned';
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  let vx = at.x - mx;
  let vy = at.y - my;
  const vlen = Math.hypot(vx, vy);
  if (vlen < 1e-9) return 'aligned'; // placed on the midpoint — no direction to read
  vx /= vlen;
  vy /= vlen;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dlen = Math.hypot(dx, dy) || 1;
  // |cos| between the placement offset and each candidate dimension-line
  // direction; smaller = more perpendicular = better fit.
  const cands = [
    { axis: 'aligned', dot: Math.abs((dx / dlen) * vx + (dy / dlen) * vy) },
    { axis: 'x', dot: Math.abs(vx) }, // x-axis direction (1,0)
    { axis: 'y', dot: Math.abs(vy) }, // y-axis direction (0,1)
  ];
  const EPS = 1e-6; // ties → the earlier (aligned-first) candidate
  return cands.reduce((best, c) => (c.dot < best.dot - EPS ? c : best)).axis;
}

/**
 * Geometry for drawing an axis-locked (distanceX / distanceY) dimension: the
 * on-axis dimension line, the two witness lines dropped perpendicular from the
 * measured points, and where the value label sits. Pure so the annotation can be
 * tested without a renderer — `SketchLayer` just maps this to lines.
 *
 * The dimension line stands off past the lower (dX) / right (dY) side of the
 * pair, which is why it never reads as the slanted true distance.
 */
export function axisDimensionGeometry(sk, kind, refs) {
  const a = sk.entities.get(refs[0]);
  const b = sk.entities.get(refs[1]);
  if (!a || !b) return null;
  const horiz = kind === 'distanceX';
  const span = Math.abs(horiz ? b.x - a.x : b.y - a.y);
  const off = Math.max(span * 0.14, 4);
  const level = horiz ? Math.min(a.y, b.y) - off : Math.max(a.x, b.x) + off;
  const at = (p) => (horiz ? { x: p.x, y: level } : { x: level, y: p.y });
  const a2 = at(a);
  const b2 = at(b);
  return {
    horiz,
    line: [a2, b2], // the dimension line itself — constant y (dX) or x (dY)
    witness: [[{ x: a.x, y: a.y }, a2], [{ x: b.x, y: b.y }, b2]],
    label: { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 },
    span,
  };
}

/**
 * Re-point every constraint that referenced a chamfered/filleted corner `shared`
 * onto the matching setback point (c1 on leg l1, c2 on leg l2) *before* the
 * corner is deleted — otherwise `deleteEntity` drops those constraints and the
 * dimensions/relations the user placed on the corner vanish. A constraint that
 * also names l1's far end (or l1 itself) follows c1; one that names l2's follows
 * c2; anything ambiguous defaults to c1. Dimensional values are refreshed to the
 * post-setback geometry so the sketch stays put on the next solve. Non-dimensional
 * relations (horizontal/vertical/…) stay satisfied for free because c1/c2 lie on
 * the original legs.
 */
function repointCorner(sk, shared, c1, c2, l1Id, l2Id, far1Id, far2Id) {
  for (const con of sk.constraints) {
    if (!con.refs.includes(shared)) continue;
    const onL1 = con.refs.includes(far1Id) || con.refs.includes(l1Id);
    const onL2 = con.refs.includes(far2Id) || con.refs.includes(l2Id);
    const target = onL2 && !onL1 ? c2 : c1;
    con.refs = con.refs.map((r) => (r === shared ? target : r));
    if (con.value != null) {
      const v = measureConstraint(sk, con.kind, con.refs);
      if (Number.isFinite(v)) con.value = v;
    }
  }
}

/**
 * Chamfer the corner where two lines meet: pull each line's shared endpoint back
 * by `dist` to a new point and join them with a chamfer line. Like SolidWorks, the
 * old corner is **kept as a construction "virtual sharp"**: the two edges are
 * re-pointed onto the setback points, and the corner is pinned at their
 * intersection (`pointOnLine` to each edge) with its setbacks locked
 * (`distance` = dist). So any dimension placed on that corner stays at its original
 * value (the corner doesn't recede inward), and the chamfer is fully defined.
 * Returns the chamfer line id, or null if the lines don't share a corner or `dist`
 * doesn't fit.
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
  // Re-point the two edges off the old corner and onto the new chamfer points.
  if (l1.p1 === shared) l1.p1 = c1; else l1.p2 = c1;
  if (l2.p1 === shared) l2.p1 = c2; else l2.p2 = c2;
  const line = addLine(sk, c1, c2);
  // Keep the corner as a virtual sharp and pin the chamfer parametrically.
  P.construction = true;
  try {
    addConstraint(sk, 'pointOnLine', [shared, l1Id]);
    addConstraint(sk, 'pointOnLine', [shared, l2Id]);
    addConstraint(sk, 'distance', [shared, c1], dist);
    addConstraint(sk, 'distance', [shared, c2], dist);
  } catch { /* best-effort parametric lock; geometry is placed regardless */ }
  return line;
}

/**
 * Fillet (round) the corner where two lines meet: like `chamfer`, but joins the
 * two setback points with a **tangent arc of radius `radius`** instead of a
 * straight cut. The arc is tangent to both legs — its centre sits on the corner's
 * angle bisector at `radius / sin(θ/2)` and the tangent points are `radius /
 * tan(θ/2)` back from the corner along each leg (θ = the corner angle). Returns
 * the new arc id, or null if the lines don't share a corner, are collinear, or
 * the radius doesn't fit on either leg. Start/end are ordered so planegcs' CCW
 * sweep traces the minor (rounded-corner) arc.
 */
export function fillet(sk, l1Id, l2Id, radius) {
  const l1 = sk.entities.get(l1Id);
  const l2 = sk.entities.get(l2Id);
  if (!l1 || l1.type !== 'line' || !l2 || l2.type !== 'line') return null;
  if (!(radius > 0)) return null;
  const shared = [l1.p1, l1.p2].find((id) => id === l2.p1 || id === l2.p2);
  if (shared == null) return null;
  const P = sk.entities.get(shared);
  const far1 = sk.entities.get(l1.p1 === shared ? l1.p2 : l1.p1);
  const far2 = sk.entities.get(l2.p1 === shared ? l2.p2 : l2.p1);
  const u1 = unit(P, far1);
  const u2 = unit(P, far2);
  let cos = u1.x * u2.x + u1.y * u2.y;
  cos = Math.max(-1, Math.min(1, cos));
  const alpha = Math.acos(cos); // corner angle at P
  if (alpha < 1e-4 || alpha > Math.PI - 1e-4) return null; // collinear → no fillet
  const half = alpha / 2;
  const setback = radius / Math.tan(half); // tangent-point distance from P along each leg
  // The rounding must fit within both legs.
  if (setback >= Math.hypot(far1.x - P.x, far1.y - P.y)) return null;
  if (setback >= Math.hypot(far2.x - P.x, far2.y - P.y)) return null;
  const t1x = P.x + u1.x * setback;
  const t1y = P.y + u1.y * setback;
  const t2x = P.x + u2.x * setback;
  const t2y = P.y + u2.y * setback;
  // Arc centre along the bisector, distance radius/sin(half) from the corner.
  let bx = u1.x + u2.x;
  let by = u1.y + u2.y;
  const bl = Math.hypot(bx, by) || 1;
  bx /= bl; by /= bl;
  const cDist = radius / Math.sin(half);
  const cx = P.x + bx * cDist;
  const cy = P.y + by * cDist;
  const c1 = addPoint(sk, t1x, t1y);
  const c2 = addPoint(sk, t2x, t2y);
  const center = addPoint(sk, cx, cy);
  // Re-point the legs off the old corner onto the tangent points.
  if (l1.p1 === shared) l1.p1 = c1; else l1.p2 = c1;
  if (l2.p1 === shared) l2.p1 = c2; else l2.p2 = c2;
  // Order start/end so the CCW sweep is the minor arc (the rounded corner).
  const a1 = normAngle(Math.atan2(t1y - cy, t1x - cx));
  const a2 = normAngle(Math.atan2(t2y - cy, t2x - cx));
  const [start, end] = normAngle(a2 - a1) <= Math.PI ? [c1, c2] : [c2, c1];
  const arc = addArc(sk, center, start, end, radius);
  repointCorner(sk, shared, c1, c2, l1Id, l2Id, far1.id, far2.id);
  deleteEntity(sk, shared);
  // Keep the fillet tangent to both legs (SolidWorks fillets carry tangent
  // relations) so editing the radius stays tangent instead of tilting a leg.
  try {
    addConstraint(sk, 'tangentArc', [l1Id, arc]);
    addConstraint(sk, 'tangentArc', [l2Id, arc]);
  } catch { /* geometry is already tangent; skip if the relation can't be added */ }
  return arc;
}

/**
 * Pick the corner-rounding fillet from a set of tangent-solution candidates and
 * rebuild the geometry. Each candidate carries the fillet centre `F` and the two
 * tangent points (`t1` on the first element, `t2` on the second) plus a `setback`
 * (how far the tangent points sit from the old corner). The smallest-setback
 * candidate — the fillet that hugs the corner — is chosen. Shared with
 * `filletLineArc` / `filletArcArc`; returns the new arc id or null.
 */
function buildFillet(sk, cands, radius, repoint, finalize) {
  if (!cands.length) return null;
  cands.sort((a, b) => a.setback - b.setback);
  const { F, t1, t2 } = cands[0];
  const c1 = addPoint(sk, t1.x, t1.y);
  const c2 = addPoint(sk, t2.x, t2.y);
  const center = addPoint(sk, F.x, F.y);
  repoint(c1, c2); // re-point / split the two elements onto the tangent points c1/c2
  // Order start/end so the CCW sweep traces the minor (rounded-corner) arc.
  const a1 = normAngle(Math.atan2(t1.y - F.y, t1.x - F.x));
  const a2 = normAngle(Math.atan2(t2.y - F.y, t2.x - F.x));
  const [start, end] = normAngle(a2 - a1) <= Math.PI ? [c1, c2] : [c2, c1];
  const filletArc = addArc(sk, center, start, end, radius);
  if (finalize) finalize(c1, c2); // corner cleanup (shared-corner case only)
  return filletArc;
}

// How close an arc endpoint must sit to a line to count as meeting it for a fillet.
// The caller passes the pick tolerance (screen-constant) so "close enough to click
// as one" == "close enough to fillet"; this default covers direct engine calls and
// is forgiving of the sub-mm gaps left when two endpoints weren't merged on draw.
const FILLET_TOUCH_TOL = 1.0;

/**
 * Whether a line and an arc meet at a corner a fillet could round: a shared
 * endpoint, an arc endpoint coincident with a line endpoint (drawn to the same
 * spot but not merged), or an arc endpoint lying on the line's span. Pure detection
 * (no mutation) so the UI can give an accurate reason when a fillet can't be made.
 */
export function lineArcMeet(sk, lineId, arcId, touchTol) {
  const line = sk.entities.get(lineId);
  const arc = sk.entities.get(arcId);
  if (!line || line.type !== 'line' || !arc || arc.type !== 'arc') return false;
  if ([line.p1, line.p2].some((id) => id === arc.start || id === arc.end)) return true;
  const la = sk.entities.get(line.p1);
  const lb = sk.entities.get(line.p2);
  if (!la || !lb) return false;
  const TOL = touchTol ?? FILLET_TOUCH_TOL;
  for (const aep of [arc.start, arc.end]) {
    const ap = sk.entities.get(aep);
    if (!ap) continue;
    if (Math.hypot(ap.x - la.x, ap.y - la.y) <= TOL || Math.hypot(ap.x - lb.x, ap.y - lb.y) <= TOL) return true;
    if (pointOnSegmentInterior(ap, la, lb, TOL)) return true;
  }
  return false;
}

/** Whether point `p` lies within `tol` of the *interior* of segment a-b. */
function pointOnSegmentInterior(p, a, b, tol) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby || 1;
  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  if (t <= 1e-6 || t >= 1 - 1e-6) return false; // interior only, not the endpoints
  const fx = a.x + abx * t;
  const fy = a.y + aby * t;
  return Math.hypot(p.x - fx, p.y - fy) <= tol;
}

/**
 * Fillet the corner where a **line and an arc** meet at a shared endpoint: round
 * it with a tangent arc of radius `radius` that touches both. The fillet centre
 * sits at perpendicular distance `radius` from the line **and** at distance
 * R∓radius from the arc's centre (internal or external tangency), so it is found
 * by intersecting each parallel offset of the line with each offset circle of the
 * arc; the candidate hugging the corner (whose tangent points fall on the drawn
 * segment and within the arc's span) is used. Returns the new fillet-arc id, or
 * null if the two don't share a corner or no radius fits. Companion to `fillet`
 * (line↔line) for the line↔arc case.
 */
export function filletLineArc(sk, lineId, arcId, radius, touchTol) {
  const line = sk.entities.get(lineId);
  const arc = sk.entities.get(arcId);
  if (!line || line.type !== 'line' || !arc || arc.type !== 'arc') return null;
  if (!(radius > 0)) return null;
  const la = sk.entities.get(line.p1);
  const lb = sk.entities.get(line.p2);
  const C = sk.entities.get(arc.center);
  const R = arc.r;
  if (!la || !lb || !C) return null;
  const TOL = touchTol ?? FILLET_TOUCH_TOL;

  // Where the two meet, in three flavours (SolidWorks fillets any of them):
  //   'shared'     — the arc endpoint IS a line endpoint (same point id);
  //   'coincident' — arc endpoint sits on a line endpoint but is a *different*
  //                  point (drawn to the same spot, never merged);
  //   'interior'   — arc endpoint lies on the line's span (e.g. after trimming a
  //                  circle against the edge) → the line is split at that point.
  let arcCornerId = null;   // arc endpoint at the corner
  let lineCornerId = null;  // line endpoint at the corner (shared/coincident), else null
  let mode = null;
  for (const aep of [arc.start, arc.end]) {
    if (aep === line.p1 || aep === line.p2) { arcCornerId = aep; lineCornerId = aep; mode = 'shared'; break; }
  }
  if (mode == null) {
    for (const aep of [arc.start, arc.end]) {
      const ap = sk.entities.get(aep);
      if (!ap) continue;
      for (const lep of [line.p1, line.p2]) {
        const lp = sk.entities.get(lep);
        if (Math.hypot(ap.x - lp.x, ap.y - lp.y) <= TOL) { arcCornerId = aep; lineCornerId = lep; mode = 'coincident'; break; }
      }
      if (mode) break;
      if (pointOnSegmentInterior(ap, la, lb, TOL)) { arcCornerId = aep; lineCornerId = null; mode = 'interior'; break; }
    }
  }
  if (mode == null) return null;
  const Pc = sk.entities.get(arcCornerId);
  const farArcId = arc.start === arcCornerId ? arc.end : arc.start;

  // The line endpoint(s) the fillet leg may run toward: a line-endpoint corner
  // (shared/coincident) fixes the far end; an interior meet can go toward either
  // end, so try both and take the tightest fillet. Candidate centres = each
  // parallel line offset ∩ each arc offset circle (internal/external), kept when
  // the tangent points fall on the leg and within the arc span.
  const legEnds = lineCornerId != null
    ? [line.p1 === lineCornerId ? line.p2 : line.p1]
    : [line.p1, line.p2];
  const cands = [];
  for (const legEndId of legEnds) {
    const far = sk.entities.get(legEndId);
    const uL = unit(Pc, far);
    const n = { x: -uL.y, y: uL.x };
    const segLen = Math.hypot(far.x - Pc.x, far.y - Pc.y);
    for (const off of [radius, -radius]) {
      const o0 = { x: Pc.x + n.x * off, y: Pc.y + n.y * off };
      const o1 = { x: far.x + n.x * off, y: far.y + n.y * off };
      for (const arcOff of radius < R ? [R - radius, R + radius] : [R + radius]) {
        for (const t of lineCircleParams(o0, o1, C.x, C.y, arcOff)) {
          const F = { x: o0.x + (o1.x - o0.x) * t, y: o0.y + (o1.y - o0.y) * t };
          const tl = (F.x - Pc.x) * uL.x + (F.y - Pc.y) * uL.y; // foot along the leg from the corner
          if (!(tl > 1e-6 && tl < segLen - 1e-6)) continue;
          const t1 = { x: Pc.x + uL.x * tl, y: Pc.y + uL.y * tl };
          const dCF = Math.hypot(F.x - C.x, F.y - C.y) || 1;
          const t2 = { x: C.x + ((F.x - C.x) / dCF) * R, y: C.y + ((F.y - C.y) / dCF) * R };
          if (!arcSpanContains(sk, arc, t2.x, t2.y)) continue;
          cands.push({ F, t1, t2, setback: tl + Math.hypot(t2.x - Pc.x, t2.y - Pc.y), legEndId });
        }
      }
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.setback - b.setback);
  const legEndId = cands[0].legEndId;

  const repoint = (c1, c2) => {
    if (mode === 'interior') {
      // Split the line at the corner: it keeps [otherEnd, corner]; a new leg runs
      // from the tangent point c1 to the far end.
      if (line.p1 === legEndId) line.p1 = arcCornerId; else line.p2 = arcCornerId;
      addLine(sk, c1, legEndId);
    } else {
      // Shared or coincident corner: shorten the line's corner endpoint onto c1.
      if (line.p1 === lineCornerId) line.p1 = c1; else line.p2 = c1;
    }
    if (arc.start === arcCornerId) arc.start = c2; else arc.end = c2;
  };
  const finalize = (c1, c2) => {
    if (mode === 'shared') {
      repointCorner(sk, arcCornerId, c1, c2, lineId, arcId, legEndId, farArcId);
      deleteEntity(sk, arcCornerId);
    } else if (mode === 'coincident') {
      // Two distinct coincident points: move their constraints onto the tangent
      // points and drop each if nothing else uses it.
      repointCorner(sk, lineCornerId, c1, c1, lineId, lineId, legEndId, legEndId);
      repointCorner(sk, arcCornerId, c2, c2, arcId, arcId, farArcId, farArcId);
      removeIfOrphan(sk, lineCornerId);
      removeIfOrphan(sk, arcCornerId);
    }
    // interior: the corner point stays as the split line's endpoint — nothing to do.
  };
  const filletArc = buildFillet(sk, cands, radius, repoint, finalize);
  if (filletArc != null) {
    try {
      addConstraint(sk, 'tangentArc', [lineId, filletArc]);
      addConstraint(sk, 'tangentArcArc', [arcId, filletArc]);
    } catch { /* already tangent; skip if unaddable */ }
  }
  return filletArc;
}

/**
 * Where two arcs meet at a corner a fillet could round: a shared endpoint id, or
 * two distinct endpoints sitting within `touchTol` of each other (what trimming
 * two overlapping circles leaves behind — the endpoints coincide on screen but
 * were never merged).
 *
 * Two trimmed circles usually meet at **both** of their intersections (a lens),
 * so this returns every corner found; `hint` — where the user clicked — selects
 * the nearest one, which is what makes "R at the corner I picked" behave. With
 * no hint the first corner wins. Returns { mode, c1Id, c2Id } or null. Pure.
 */
function arcArcCorners(sk, arc1, arc2, tol) {
  const out = [];
  for (const e1 of [arc1.start, arc1.end]) {
    const p1 = sk.entities.get(e1);
    if (!p1) continue;
    for (const e2 of [arc2.start, arc2.end]) {
      if (e1 === e2) { out.push({ mode: 'shared', c1Id: e1, c2Id: e1, at: p1 }); continue; }
      const p2 = sk.entities.get(e2);
      if (!p2) continue;
      if (Math.hypot(p1.x - p2.x, p1.y - p2.y) <= tol) {
        out.push({ mode: 'coincident', c1Id: e1, c2Id: e2, at: p1 });
      }
    }
  }
  return out;
}

function arcArcCorner(sk, arc1, arc2, tol, hint) {
  const cs = arcArcCorners(sk, arc1, arc2, tol);
  if (!cs.length) return null;
  // Prefer a shared-id corner over a merely coincident one at the same spot.
  const rank = (c) => (c.mode === 'shared' ? 0 : 1);
  if (!hint) return cs.sort((a, b) => rank(a) - rank(b))[0];
  const d = (c) => Math.hypot(c.at.x - hint.x, c.at.y - hint.y);
  return cs.sort((a, b) => d(a) - d(b) || rank(a) - rank(b))[0];
}

/**
 * Whether two arcs meet at a corner a fillet could round. Pure detection (no
 * mutation) so the UI can say *why* a fillet failed — too big a radius versus
 * the two curves not actually touching. The arc↔arc twin of `lineArcMeet`.
 */
export function arcArcMeet(sk, arc1Id, arc2Id, touchTol) {
  const arc1 = sk.entities.get(arc1Id);
  const arc2 = sk.entities.get(arc2Id);
  if (!arc1 || arc1.type !== 'arc' || !arc2 || arc2.type !== 'arc') return false;
  return arcArcCorner(sk, arc1, arc2, touchTol ?? FILLET_TOUCH_TOL) != null;
}

/**
 * Fillet the corner where **two arcs** meet with a tangent arc of radius
 * `radius`. The fillet centre lies at distance R1∓radius from the first arc's
 * centre and R2∓radius from the second's, so it is a circle-circle intersection
 * over the internal/external tangency combinations; the candidate whose tangent
 * points fall within both arcs' spans and hugs the corner is used.
 *
 * Handles both corner flavours `filletLineArc` does — a shared endpoint id, and
 * two coincident-but-distinct endpoints (the normal result of trimming two
 * overlapping circles, which is how most arc↔arc corners get made).
 * Returns the new fillet-arc id or null. The arc↔arc companion to `filletLineArc`.
 */
export function filletArcArc(sk, arc1Id, arc2Id, radius, touchTol, hint) {
  const arc1 = sk.entities.get(arc1Id);
  const arc2 = sk.entities.get(arc2Id);
  if (!arc1 || arc1.type !== 'arc' || !arc2 || arc2.type !== 'arc') return null;
  if (!(radius > 0)) return null;
  const corner = arcArcCorner(sk, arc1, arc2, touchTol ?? FILLET_TOUCH_TOL, hint);
  if (corner == null) return null;
  const { mode, c1Id: corner1, c2Id: corner2 } = corner;
  const P = sk.entities.get(corner1);
  const C1 = sk.entities.get(arc1.center);
  const C2 = sk.entities.get(arc2.center);
  const R1 = arc1.r;
  const R2 = arc2.r;
  if (!P || !C1 || !C2) return null;
  const farArc1Id = arc1.start === corner1 ? arc1.end : arc1.start;
  const farArc2Id = arc2.start === corner2 ? arc2.end : arc2.start;

  const cands = [];
  for (const s1 of radius < R1 ? [R1 - radius, R1 + radius] : [R1 + radius]) {
    for (const s2 of radius < R2 ? [R2 - radius, R2 + radius] : [R2 + radius]) {
      for (const F of circleCircleInts(C1.x, C1.y, s1, C2.x, C2.y, s2)) {
        const d1 = Math.hypot(F.x - C1.x, F.y - C1.y) || 1;
        const d2 = Math.hypot(F.x - C2.x, F.y - C2.y) || 1;
        const t1 = { x: C1.x + ((F.x - C1.x) / d1) * R1, y: C1.y + ((F.y - C1.y) / d1) * R1 };
        const t2 = { x: C2.x + ((F.x - C2.x) / d2) * R2, y: C2.y + ((F.y - C2.y) / d2) * R2 };
        if (!arcSpanContains(sk, arc1, t1.x, t1.y)) continue;
        if (!arcSpanContains(sk, arc2, t2.x, t2.y)) continue;
        cands.push({ F, t1, t2, setback: Math.hypot(t1.x - P.x, t1.y - P.y) + Math.hypot(t2.x - P.x, t2.y - P.y) });
      }
    }
  }
  const repoint = (c1, c2) => {
    if (arc1.start === corner1) arc1.start = c1; else arc1.end = c1;
    if (arc2.start === corner2) arc2.start = c2; else arc2.end = c2;
  };
  const finalize = (c1, c2) => {
    if (mode === 'shared') {
      repointCorner(sk, corner1, c1, c2, arc1Id, arc2Id, farArc1Id, farArc2Id);
      deleteEntity(sk, corner1);
    } else {
      // Two distinct coincident corners: move each one's constraints onto its own
      // tangent point, then drop the old points if nothing else references them.
      repointCorner(sk, corner1, c1, c1, arc1Id, arc1Id, farArc1Id, farArc1Id);
      repointCorner(sk, corner2, c2, c2, arc2Id, arc2Id, farArc2Id, farArc2Id);
      removeIfOrphan(sk, corner1);
      removeIfOrphan(sk, corner2);
    }
  };
  const filletArc = buildFillet(sk, cands, radius, repoint, finalize);
  if (filletArc != null) {
    try {
      addConstraint(sk, 'tangentArcArc', [arc1Id, filletArc]);
      addConstraint(sk, 'tangentArcArc', [arc2Id, filletArc]);
    } catch { /* already tangent; skip if unaddable */ }
  }
  return filletArc;
}

/** The point on the circle (C, R) in the direction of F. */
function projectToCircle(F, C, R) {
  const d = Math.hypot(F.x - C.x, F.y - C.y) || 1;
  return { x: C.x + ((F.x - C.x) / d) * R, y: C.y + ((F.y - C.y) / d) * R };
}

/** Whether the CCW arc from angle `a0` to `a1` (about C) covers point `p`. */
function ccwCovers(C, a0, a1, p) {
  const at = normAngle(Math.atan2(p.y - C.y, p.x - C.x));
  const span = normAngle(a1 - a0) || TAU;
  return normAngle(at - a0) <= span;
}

/**
 * Re-attach a size dimension from a deleted circle onto the arc that replaced it,
 * so auto-trimming doesn't silently drop the user's Ø/R. A circle's `diameter`
 * becomes the arc's `arcRadius` (half the value); `radius` carries over as-is.
 */
function migrateCircleSize(sk, circleId, arcId) {
  for (const c of sk.constraints) {
    if (c.refs.length !== 1 || c.refs[0] !== circleId) continue;
    if (c.kind === 'diameter') { c.kind = 'arcRadius'; c.value /= 2; c.refs = [arcId]; }
    else if (c.kind === 'radius') { c.kind = 'arcRadius'; c.refs = [arcId]; }
  }
}

/**
 * Fillet two **whole circles** that cross each other, rounding the notch at one
 * crossing and **auto-trimming** both circles into arcs — SolidWorks' sketch
 * fillet does this, so you don't have to trim them by hand first.
 *
 * Two crossing circles cut each other into two arcs apiece, so *which* halves to
 * keep is a real choice (lens, blob, or either crescent). SolidWorks resolves it
 * from what you clicked, and so does this: `picks` maps each circle id to where
 * it was picked, and the half containing that point survives. `hint` (the last
 * click) chooses which of the two crossings gets rounded; the other one, `Q`,
 * stays sharp and anchors both trims. The result is a closed profile:
 * arc1 → fillet → arc2. With no picks, the halves facing away from the other
 * circle are kept (the blob outline), which is the common intent.
 *
 * Returns { fillet, arcs: [id, id] } or null when the circles don't genuinely
 * cross or no fillet of that radius fits.
 */
export function filletCircleCircle(sk, c1Id, c2Id, radius, hint, picks) {
  const c1 = sk.entities.get(c1Id);
  const c2 = sk.entities.get(c2Id);
  if (!c1 || c1.type !== 'circle' || !c2 || c2.type !== 'circle') return null;
  if (!(radius > 0)) return null;
  const C1 = sk.entities.get(c1.center);
  const C2 = sk.entities.get(c2.center);
  if (!C1 || !C2) return null;
  const xs = circleCircleInts(C1.x, C1.y, c1.r, C2.x, C2.y, c2.r);
  if (xs.length < 2) return null; // tangent or apart → no notch to round

  // Round the crossing nearest the pick; the other one anchors the trims.
  let [P, Q] = xs;
  if (hint) {
    const d = (p) => Math.hypot(p.x - hint.x, p.y - hint.y);
    if (d(xs[1]) < d(xs[0])) [P, Q] = [xs[1], xs[0]];
  }

  // Which half of each circle survives. The crossings P and Q split a circle
  // into the CCW arc P→Q and the CCW arc Q→P; keep whichever covers the pick.
  // Default pick = the point facing away from the other circle (blob outline).
  const keepDir = (C, R, otherC, pick) => {
    const aP = normAngle(Math.atan2(P.y - C.y, P.x - C.x));
    const aQ = normAngle(Math.atan2(Q.y - C.y, Q.x - C.x));
    const away = { x: C.x - (otherC.x - C.x), y: C.y - (otherC.y - C.y) };
    const probe = pick ?? projectToCircle(away, C, R);
    // true → the kept arc runs CCW from P to Q (so trimming moves the P end).
    return ccwCovers(C, aP, aQ, probe);
  };
  const keep1PtoQ = keepDir(C1, c1.r, C2, picks?.[c1Id]);
  const keep2PtoQ = keepDir(C2, c2.r, C1, picks?.[c2Id]);

  // Fillet centre: R∓radius from each circle centre (internal/external tangency).
  // Only combinations whose tangent points land on the *kept* halves are usable;
  // among those the one hugging the chosen crossing wins.
  const onKept = (C, t, keepPtoQ) => {
    const aP = normAngle(Math.atan2(P.y - C.y, P.x - C.x));
    const aQ = normAngle(Math.atan2(Q.y - C.y, Q.x - C.x));
    return keepPtoQ ? ccwCovers(C, aP, aQ, t) : ccwCovers(C, aQ, aP, t);
  };
  const cands = [];
  for (const s1 of [c1.r + radius, c1.r - radius]) {
    if (!(s1 > 0)) continue;
    for (const s2 of [c2.r + radius, c2.r - radius]) {
      if (!(s2 > 0)) continue;
      for (const F of circleCircleInts(C1.x, C1.y, s1, C2.x, C2.y, s2)) {
        const t1 = projectToCircle(F, C1, c1.r);
        const t2 = projectToCircle(F, C2, c2.r);
        if (!onKept(C1, t1, keep1PtoQ) || !onKept(C2, t2, keep2PtoQ)) continue;
        cands.push({
          F, t1, t2,
          setback: Math.hypot(t1.x - P.x, t1.y - P.y) + Math.hypot(t2.x - P.x, t2.y - P.y),
        });
      }
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.setback - b.setback);
  const { F, t1, t2 } = cands[0];

  const qPt = addPoint(sk, Q.x, Q.y);
  const t1Pt = addPoint(sk, t1.x, t1.y);
  const t2Pt = addPoint(sk, t2.x, t2.y);
  const fCentre = addPoint(sk, F.x, F.y);

  // Trim: the kept half, with its P end pulled back to the tangent point.
  const arc1 = keep1PtoQ
    ? addArc(sk, c1.center, t1Pt, qPt, c1.r)
    : addArc(sk, c1.center, qPt, t1Pt, c1.r);
  const arc2 = keep2PtoQ
    ? addArc(sk, c2.center, t2Pt, qPt, c2.r)
    : addArc(sk, c2.center, qPt, t2Pt, c2.r);
  migrateCircleSize(sk, c1Id, arc1);
  migrateCircleSize(sk, c2Id, arc2);
  deleteEntity(sk, c1Id);
  deleteEntity(sk, c2Id);

  // The fillet itself: the minor sweep between the two tangent points.
  const a1 = normAngle(Math.atan2(t1.y - F.y, t1.x - F.x));
  const a2 = normAngle(Math.atan2(t2.y - F.y, t2.x - F.x));
  const [fs, fe] = normAngle(a2 - a1) <= Math.PI ? [t1Pt, t2Pt] : [t2Pt, t1Pt];
  const filletArc = addArc(sk, fCentre, fs, fe, radius);
  try {
    addConstraint(sk, 'tangentArcArc', [arc1, filletArc]);
    addConstraint(sk, 'tangentArcArc', [arc2, filletArc]);
  } catch { /* already tangent; skip if unaddable */ }
  return { fillet: filletArc, arcs: [arc1, arc2] };
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
 * Angle-dimension model for two lines. planegcs measures the **directed angle
 * between the lines' point-order directions** (p1→p2), which for a corner is often
 * the *supplement* of the angle you'd read with a protractor there (e.g. a 60°
 * corner shows as 120° if one line points into the vertex). This returns the
 * intuitive **interior angle at the shared vertex** (0–180°, `interiorDeg`) for
 * display, plus the `sign`/`offsetDeg` to convert a user-entered interior angle θ
 * back to the value planegcs must store: `norm180(sign*θ + offsetDeg)`. With no
 * shared vertex it falls back to the directed angle's magnitude.
 */
export function angleSpec(sk, l1Id, l2Id) {
  const l1 = sk.entities.get(l1Id);
  const l2 = sk.entities.get(l2Id);
  if (!l1 || l1.type !== 'line' || !l2 || l2.type !== 'line') return null;
  const norm180 = (d) => { const m = ((d % 360) + 360) % 360; return m > 180 ? m - 360 : m; };
  const dirOf = (l) => {
    const a = sk.entities.get(l.p1);
    const b = sk.entities.get(l.p2);
    return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  };
  const parametric = norm180(dirOf(l2) - dirOf(l1));
  const shared = [l1.p1, l1.p2].find((id) => id === l2.p1 || id === l2.p2);
  if (shared == null) {
    return { shared: null, interiorDeg: Math.abs(parametric), sign: parametric < 0 ? -1 : 1, offsetDeg: 0, parametric };
  }
  const V = sk.entities.get(shared);
  const f1 = sk.entities.get(l1.p1 === shared ? l1.p2 : l1.p1);
  const f2 = sk.entities.get(l2.p1 === shared ? l2.p2 : l2.p1);
  const ray1 = (Math.atan2(f1.y - V.y, f1.x - V.x) * 180) / Math.PI;
  const ray2 = (Math.atan2(f2.y - V.y, f2.x - V.x) * 180) / Math.PI;
  const interiorSigned = norm180(ray2 - ray1);
  const offsetDeg = Math.round((parametric - interiorSigned) / 180) * 180; // multiple of 180
  return { shared, interiorDeg: Math.abs(interiorSigned), sign: interiorSigned < 0 ? -1 : 1, offsetDeg, parametric };
}

/** The planegcs angle value (radians) for a desired interior angle θ° on this pair. */
export function interiorAngleToModel(spec, thetaDeg) {
  const d = spec.sign * thetaDeg + spec.offsetDeg;
  const m = ((d % 360) + 360) % 360;
  return ((m > 180 ? m - 360 : m) * Math.PI) / 180;
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

/**
 * The point on circle/arc `curveId`'s rim where a line drawn from the external
 * point (ax, ay) is **tangent** to the curve — choosing, of the two tangents, the
 * one nearer the cursor hint (hx, hy). Returns { x, y } or null when (ax, ay) is
 * inside/on the circle (no external tangent exists) or, for an arc, the tangent
 * point falls outside the drawn span. Geometry: the tangent points sit at C→A
 * bearing ± acos(r/d) around the centre, where d = |A − C|.
 */
export function tangentPoint(sk, curveId, ax, ay, hx, hy) {
  const e = sk.entities.get(curveId);
  if (!e || (e.type !== 'circle' && e.type !== 'arc')) return null;
  const c = sk.entities.get(e.center);
  if (!c) return null;
  const r = e.r;
  const dx = ax - c.x;
  const dy = ay - c.y;
  const d = Math.hypot(dx, dy);
  if (d <= r + 1e-9) return null; // point inside/on the circle → no tangent
  const beta = Math.atan2(dy, dx);
  const gamma = Math.acos(Math.max(-1, Math.min(1, r / d)));
  const cand = [beta + gamma, beta - gamma]
    .map((ang) => ({ x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) }))
    .sort((p, q) => dist2(p.x, p.y, hx, hy) - dist2(q.x, q.y, hx, hy));
  for (const p of cand) {
    if (e.type === 'arc' && !arcSpanContains(sk, e, p.x, p.y)) continue;
    return { x: p.x, y: p.y };
  }
  return null;
}

/**
 * Of every circle/arc whose rim passes within `tol` of the cursor (x, y), the
 * tangent target for a line being drawn from the anchor (ax, ay): { id, type, x,
 * y } with (x, y) the tangent point, or null. Drives the tangent snap while
 * drawing a line — hover near a ring and the endpoint suggestion jumps to where
 * the line would touch it tangentially.
 */
export function nearestTangent(sk, ax, ay, x, y, tol = 1e-6) {
  let best = null;
  let bestErr = tol;
  for (const e of sk.entities.values()) {
    if (e.type !== 'circle' && e.type !== 'arc') continue;
    const c = sk.entities.get(e.center);
    if (!c) continue;
    const err = Math.abs(Math.hypot(x - c.x, y - c.y) - e.r);
    if (err > bestErr) continue;
    if (e.type === 'arc' && !arcSpanContains(sk, e, x, y)) continue;
    const tp = tangentPoint(sk, e.id, ax, ay, x, y);
    if (!tp) continue;
    bestErr = err;
    best = { id: e.id, type: e.type, x: tp.x, y: tp.y };
  }
  return best;
}

/** Reflect point (px, py) across the infinite line through a and b. */
function reflectPoint(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = ((px - a.x) * dx + (py - a.y) * dy) / len2; // projection onto the line
  const fx = a.x + dx * t;
  const fy = a.y + dy * t; // foot of the perpendicular
  return { x: 2 * fx - px, y: 2 * fy - py };
}

/**
 * Mirror the entities `ids` across the axis line `axisLineId`, creating reflected
 * copies (SolidWorks "Mirror Entities"). Shared points among the mirrored set map
 * to the same reflected point, so a mirrored chain stays connected. Reflection is
 * orientation-reversing, so an arc's start/end are swapped to keep the copy's CCW
 * sweep. The axis line itself is never mirrored. Construction flags carry over.
 *
 * Like SolidWorks, the copy is kept **parametric**: each original↔mirror point pair
 * gets a `symmetric` relation about the axis, and mirrored circles/arcs get an
 * `equalRadius` to their source — so editing the original updates the mirror. (Any
 * link that can't be added is skipped, never aborting the mirror.) Returns the new
 * entity ids, or null if the axis is bad or nothing to mirror.
 */
export function mirror(sk, ids, axisLineId) {
  const axis = sk.entities.get(axisLineId);
  if (!axis || axis.type !== 'line') return null;
  const a = sk.entities.get(axis.p1);
  const b = sk.entities.get(axis.p2);
  if (!a || !b) return null;
  const targets = ids.filter((id) => id !== axisLineId && sk.entities.has(id));
  if (!targets.length) return null;
  const map = new Map(); // old point id → reflected point id (reused for shared corners)
  const mp = (pid) => {
    if (map.has(pid)) return map.get(pid);
    const p = sk.entities.get(pid);
    const r = reflectPoint(p.x, p.y, a, b);
    const nid = addPoint(sk, r.x, r.y);
    map.set(pid, nid);
    return nid;
  };
  const created = [];
  const radiusLinks = []; // [origCurveId, mirrorCurveId] to tie with equalRadius
  for (const id of targets) {
    const e = sk.entities.get(id);
    let nid = null;
    if (e.type === 'point') nid = mp(id);
    else if (e.type === 'line') nid = addLine(sk, mp(e.p1), mp(e.p2));
    else if (e.type === 'circle') { nid = addCircle(sk, mp(e.center), e.r); radiusLinks.push([id, nid]); }
    else if (e.type === 'arc') { nid = addArc(sk, mp(e.center), mp(e.end), mp(e.start), e.r); radiusLinks.push([id, nid]); } // swap → CCW
    if (nid != null) {
      if (e.construction) sk.entities.get(nid).construction = true;
      created.push(nid);
    }
  }
  // Parametric links (SW keeps a mirror driven by its source).
  for (const [oldPid, newPid] of map) {
    const op = sk.entities.get(oldPid);
    if (op?.origin || op?.fixed) continue; // don't tie a fixed datum to its image
    try { addConstraint(sk, 'symmetric', [oldPid, newPid, axisLineId]); } catch { /* skip unlinkable pair */ }
  }
  for (const [oldId, newId] of radiusLinks) {
    try { addConstraint(sk, 'equalRadius', [oldId, newId]); } catch { /* skip */ }
  }
  return created.length ? created : null;
}

/**
 * Offset one line/circle/arc by signed distance `dist`, creating a parallel /
 * concentric copy (SolidWorks "Offset Entities"). A line is shifted along its left
 * normal (negative `dist` → right); a circle/arc keeps its centre and takes radius
 * r + dist (must stay positive). The construction flag carries over. Returns the
 * new entity id, or null if it can't be offset.
 */
export function offsetEntity(sk, id, dist) {
  const e = sk.entities.get(id);
  if (!e || !Number.isFinite(dist) || dist === 0) return null;
  let nid = null;
  if (e.type === 'line') {
    const a = sk.entities.get(e.p1);
    const b = sk.entities.get(e.p2);
    if (!a || !b) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len; // left normal
    const p1 = addPoint(sk, a.x + nx * dist, a.y + ny * dist);
    const p2 = addPoint(sk, b.x + nx * dist, b.y + ny * dist);
    nid = addLine(sk, p1, p2);
  } else if (e.type === 'circle') {
    const c = sk.entities.get(e.center);
    const nr = e.r + dist;
    if (!c || !(nr > 1e-6)) return null;
    nid = addCircle(sk, addPoint(sk, c.x, c.y), nr);
  } else if (e.type === 'arc') {
    const c = sk.entities.get(e.center);
    const s = sk.entities.get(e.start);
    const en = sk.entities.get(e.end);
    const nr = e.r + dist;
    if (!c || !s || !en || !(nr > 1e-6)) return null;
    const a0 = Math.atan2(s.y - c.y, s.x - c.x);
    const a1 = Math.atan2(en.y - c.y, en.x - c.x);
    const nc = addPoint(sk, c.x, c.y);
    const ns = addPoint(sk, c.x + nr * Math.cos(a0), c.y + nr * Math.sin(a0));
    const ne = addPoint(sk, c.x + nr * Math.cos(a1), c.y + nr * Math.sin(a1));
    nid = addArc(sk, nc, ns, ne, nr);
  }
  if (nid != null && e.construction) sk.entities.get(nid).construction = true;
  return nid;
}
