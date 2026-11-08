/**
 * The part's edges as seen on a sketch plane, so a dimension can be taken to them.
 *
 * Picking one does not teach the solver about meshes: it places a fixed
 * construction point or line in the sketch (`placePartRef`), and from there it is
 * ordinary sketch geometry to every dimension.
 *
 * A mesh has no stable edge names, so when the part changes a reference is carried
 * across by comparing the edges before and after (`followPartRefs`): what did not
 * move matches exactly, and what is left is paired by position among the edges
 * running the same way. That order survives any change of size. Where the part's
 * shape changed so that an edge has no counterpart, the reference stays put and
 * is counted as lost.
 */
import { detectSharpEdges } from '../mesh/features.js';
import { fitCircle } from '../mesh/circlePick.js';
import { addPoint, addLine } from './model.js';
import { worldToPlane } from './plane.js';

const SAME = 1e-4; // mm — two projected points this close are one point
const STRAIGHT = 1e-3; // sine of the bend still counted as one straight edge
const RIM_SAME = 0.01; // mm

const keyOf = (x, y) => `${x.toFixed(3)},${y.toFixed(3)}`;

/** Split a projected polyline at its corners into straight runs. */
function straightRuns(pts) {
  const runs = [];
  let start = 0;
  const dir = (i) => {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const len = Math.hypot(dx, dy);
    return { x: dx / len, y: dy / len };
  };
  for (let i = 1; i < pts.length - 1; i += 1) {
    const a = dir(i - 1);
    const b = dir(i);
    if (Math.abs(a.x * b.y - a.y * b.x) > STRAIGHT || a.x * b.x + a.y * b.y < 0) {
      runs.push([pts[start], pts[i]]);
      start = i;
    }
  }
  runs.push([pts[start], pts[pts.length - 1]]);
  return runs;
}

/**
 * Sharp edges of `mesh` projected onto `plane`: straight segments, round rims and
 * every segment end. An edge running along the plane's normal projects to a point
 * and leaves only its end; the near and far edges of a prism project to one line.
 *
 * @returns {{segments:{a:object,b:object}[], circles:{x:number,y:number,r:number}[], points:object[]}}
 */
export function partReferences(mesh, plane) {
  const segments = new Map();
  const circles = [];
  const points = new Map();
  const addEnd = (p) => points.set(keyOf(p.x, p.y), { x: p.x, y: p.y });

  for (const edge of detectSharpEdges(mesh)) {
    const projected = [];
    for (const p of edge.points) {
      const q = worldToPlane(plane, p);
      const last = projected[projected.length - 1];
      if (!last || Math.hypot(q.x - last.x, q.y - last.y) > SAME) projected.push(q);
    }
    if (projected.length >= 2) {
      const round = edge.closed && projected.length > 8
        ? fitCircle(projected.flatMap((p) => [p.x, p.y]))
        : null;
      if (round) {
        const [x, y] = round.center;
        // A bore's two rims fit to within a few microns of each other, and are one circle here.
        const seen = circles.some((c) => Math.hypot(c.x - x, c.y - y) < RIM_SAME && Math.abs(c.r - round.radius) < RIM_SAME);
        if (!seen) circles.push({ x, y, r: round.radius });
      } else {
        for (const [a, b] of straightRuns(projected)) {
          const [k1, k2] = [keyOf(a.x, a.y), keyOf(b.x, b.y)].sort();
          segments.set(`${k1}|${k2}`, { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } });
          addEnd(a);
          addEnd(b);
        }
      }
    }
  }
  return { segments: [...segments.values()], circles, points: [...points.values()] };
}

function distanceToSegment({ a, b }, x, y) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/**
 * What a click at (x, y) means on these references. A corner wins over the edges
 * it ends, and a round rim or its centre both mean the centre.
 *
 * @returns {{kind:'point',x:number,y:number}|{kind:'line',a:object,b:object}|null}
 */
export function pickPartRef(refs, x, y, tol) {
  const nearest = (items, dist) => {
    let best = null;
    let bestD = tol;
    for (const item of items) {
      const d = dist(item);
      if (d <= bestD) { best = item; bestD = d; }
    }
    return best;
  };
  const corner = nearest(refs.points, (p) => Math.hypot(p.x - x, p.y - y));
  if (corner) return { kind: 'point', x: corner.x, y: corner.y };
  const circle = nearest(refs.circles, (c) => {
    const off = Math.hypot(c.x - x, c.y - y);
    return Math.min(off, Math.abs(off - c.r));
  });
  if (circle) return { kind: 'point', x: circle.x, y: circle.y };
  const segment = nearest(refs.segments, (s) => distanceToSegment(s, x, y));
  return segment ? { kind: 'line', a: segment.a, b: segment.b } : null;
}

function refPoint(sk, x, y) {
  for (const e of sk.entities.values()) {
    if (e.type === 'point' && e.ref && Math.hypot(e.x - x, e.y - y) < SAME) return e.id;
  }
  const id = addPoint(sk, x, y, true);
  Object.assign(sk.entities.get(id), { ref: true, construction: true });
  return id;
}

/** Put a picked reference into the sketch, reusing one already there. @returns the entity id */
export function placePartRef(sk, ref) {
  if (ref.kind === 'point') return refPoint(sk, ref.x, ref.y);
  const p1 = refPoint(sk, ref.a.x, ref.a.y);
  const p2 = refPoint(sk, ref.b.x, ref.b.y);
  for (const e of sk.entities.values()) {
    if (e.type === 'line' && e.ref && ((e.p1 === p1 && e.p2 === p2) || (e.p1 === p2 && e.p2 === p1))) return e.id;
  }
  const id = addLine(sk, p1, p2);
  Object.assign(sk.entities.get(id), { ref: true, construction: true });
  return id;
}

const isAt = (p, x, y) => Math.hypot(p.x - x, p.y - y) < 1e-3;

/** The segment with its ends in a fixed order, its direction bucket and its place across/along that direction. */
function placed(seg) {
  const flip = seg.a.x > seg.b.x + 1e-3 || (Math.abs(seg.a.x - seg.b.x) <= 1e-3 && seg.a.y > seg.b.y);
  const [a, b] = flip ? [seg.b, seg.a] : [seg.a, seg.b];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  return {
    a,
    b,
    dir: Math.round((Math.atan2(u.y, u.x) * 180) / Math.PI),
    across: a.y * u.x - a.x * u.y,
    from: a.x * u.x + a.y * u.y,
    to: b.x * u.x + b.y * u.y,
  };
}

const sameSegment = (p, q) => isAt(p.a, q.a.x, q.a.y) && isAt(p.b, q.b.x, q.b.y);
const byPlace = (p, q) => (Math.abs(p.across - q.across) > 1e-3 ? p.across - q.across : p.from - q.from);

/** Pair each segment before with its counterpart after. @returns {Map} before → after, absent when none */
function matchSegments(before, after) {
  const pairs = new Map();
  const free = after.map(placed);
  const left = [];
  for (const old of before.map(placed)) {
    const at = free.findIndex((q) => sameSegment(old, q));
    if (at >= 0) pairs.set(old, free.splice(at, 1)[0]);
    else left.push(old);
  }
  for (const dir of new Set(left.map((s) => s.dir))) {
    const olds = left.filter((s) => s.dir === dir).sort(byPlace);
    const news = free.filter((s) => s.dir === dir).sort(byPlace);
    olds.forEach((old, i) => {
      if (olds.length === news.length) { pairs.set(old, news[i]); return; }
      // The shape changed, not just its size: only the closest edge alongside will do.
      const beside = news
        .filter((q) => q.from < old.to && q.to > old.from)
        .sort((p, q) => Math.abs(p.across - old.across) - Math.abs(q.across - old.across));
      if (beside.length) pairs.set(old, beside[0]);
    });
  }
  return pairs;
}

function matchCircles(before, after) {
  const pairs = new Map();
  const free = [...after];
  const take = (old, pick) => { pairs.set(old, pick); free.splice(free.indexOf(pick), 1); };
  const left = before.filter((old) => {
    const same = free.find((c) => isAt(c, old.x, old.y) && Math.abs(c.r - old.r) < 1e-3);
    if (same) take(old, same);
    return !same;
  });
  const anyRadius = left.length === free.length;
  for (const old of left) {
    const near = free
      .filter((c) => anyRadius || Math.abs(c.r - old.r) < 1e-3)
      .sort((p, q) => Math.hypot(p.x - old.x, p.y - old.y) - Math.hypot(q.x - old.x, q.y - old.y))[0];
    if (near) take(old, near);
  }
  return pairs;
}

/**
 * Move a sketch's references from where the edges were to where they are.
 *
 * @param {object} sk  the sketch; its reference points are moved in place
 * @param {object} before `partReferences` of the part they were picked on
 * @param {object} after  `partReferences` of the part now
 * @returns {{moved:boolean, lost:number}}
 */
export function followPartRefs(sk, before, after) {
  const segments = matchSegments(before.segments, after.segments);
  const circles = matchCircles(before.circles, after.circles);
  const target = new Map();
  let lost = 0;

  for (const e of sk.entities.values()) {
    if (e.type === 'line' && e.ref) {
      const [p1, p2] = [sk.entities.get(e.p1), sk.entities.get(e.p2)];
      const old = [...segments.keys()].find((s) => (isAt(s.a, p1.x, p1.y) && isAt(s.b, p2.x, p2.y))
        || (isAt(s.a, p2.x, p2.y) && isAt(s.b, p1.x, p1.y)));
      if (old) {
        const now = segments.get(old);
        const forward = isAt(old.a, p1.x, p1.y);
        target.set(p1.id, forward ? now.a : now.b);
        target.set(p2.id, forward ? now.b : now.a);
      } else lost += 1;
    }
  }
  for (const e of sk.entities.values()) {
    if (e.type === 'point' && e.ref && !target.has(e.id)) {
      const ring = [...circles.keys()].find((c) => isAt(c, e.x, e.y));
      const end = ring ? null : [...segments.keys()].find((s) => isAt(s.a, e.x, e.y) || isAt(s.b, e.x, e.y));
      if (ring) target.set(e.id, circles.get(ring));
      else if (end) target.set(e.id, isAt(end.a, e.x, e.y) ? segments.get(end).a : segments.get(end).b);
      else if (![...sk.entities.values()].some((l) => l.type === 'line' && l.ref && (l.p1 === e.id || l.p2 === e.id))) lost += 1;
    }
  }

  let moved = false;
  for (const [id, to] of target) {
    const p = sk.entities.get(id);
    if (!isAt(p, to.x, to.y)) moved = true;
    p.x = to.x;
    p.y = to.y;
  }
  return { moved, lost };
}

/** Remove references no dimension ended up using. @returns whether any went */
export function dropUnusedPartRefs(sk) {
  const used = new Set(sk.constraints.flatMap((c) => c.refs));
  const lines = [...sk.entities.values()].filter((e) => e.type === 'line' && e.ref);
  const staleLines = lines.filter((l) => !used.has(l.id));
  for (const l of staleLines) sk.entities.delete(l.id);
  for (const e of sk.entities.values()) {
    if (e.type === 'line') { used.add(e.p1); used.add(e.p2); }
  }
  const stalePoints = [...sk.entities.values()].filter((e) => e.type === 'point' && e.ref && !used.has(e.id));
  for (const p of stalePoints) sk.entities.delete(p.id);
  return staleLines.length + stalePoints.length > 0;
}
