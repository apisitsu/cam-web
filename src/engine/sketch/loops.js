/**
 * Closed regions of a sketch — the step between drawing a profile and making a
 * solid out of it.
 *
 * A sketch is a bag of lines, arcs and circles; an extrude needs *closed loops*
 * with the outer boundary and its holes told apart. This module is that
 * conversion, and nothing else: it is pure, takes a sketch document (`model.js`)
 * and returns flat `[x0,y0,x1,y1,...]` loops in the same outer-CCW / hole-CW
 * convention `sliceLoops` produces, so everything already written against slice
 * output — Clipper offsetting, the CAM planner — reads these unchanged.
 *
 * Three steps, in this order, and the order is the design:
 *
 * 1. **Weld the points.** A sketch is point-based (`model.js`), so a shared
 *    corner *is* one point id and two entities are connected exactly when they
 *    name the same point. `coincident` constraints and points sitting within
 *    `weldTol` of each other are folded in with a union-find, so a corner the
 *    user drew twice still counts once.
 * 2. **Arrange.** Topology alone is not enough, because two things people
 *    actually do share no point at all: a divider whose ends land *on* an edge,
 *    and two shapes overlapping without a common vertex. `arrangeCurves` cuts
 *    every curve where it crosses another, and vertices are assigned *after*
 *    that — which is what turns a crossing into a junction instead of two curves
 *    passing through one another unaware.
 * 3. **Trace faces.** Dangling geometry is pruned, then the planar graph's faces
 *    are traced; a line across a rectangle gives two regions, as it does in any
 *    CAD. `branches` still reports the junctions, but as information rather than
 *    a refusal.
 *
 * Construction geometry is reference only and never contributes.
 */
// `reversed` is the same flat-polyline reverse `sliceLoops` needs; one copy.
import { normalizeLoops, loopArea, reversed as reversePoints } from '../mesh/slice.js';

const TAU = Math.PI * 2;

/** Chord tolerance for tessellating arcs and circles, in mm. */
export const CHORD_TOL = 0.01;
/** Points closer than this are the same vertex (a solve settles well under it). */
export const WELD_TOL = 1e-6;

const norm = (a) => ((a % TAU) + TAU) % TAU;

/**
 * Segment count for an arc of radius `r` sweeping `span` radians, chosen so no
 * chord sits further than `chordTol` from the true arc. Below ~2 segments a
 * half-circle collapses to a straight line, and the cap keeps a hairline-radius
 * fillet from producing tens of thousands of points.
 */
export function arcSegments(r, span, chordTol = CHORD_TOL) {
  if (!(r > 0) || !(span > 0)) return 1;
  // Sagitta of a chord subtending `a`: r(1 - cos(a/2)). Invert for a = the
  // widest angle whose sagitta is still within tolerance.
  const maxAngle = chordTol >= r ? span : 2 * Math.acos(1 - chordTol / r);
  const n = Math.ceil(span / (maxAngle || span));
  return Math.min(720, Math.max(2, Number.isFinite(n) ? n : 2));
}

/**
 * Tessellate a counter-clockwise sweep as a flat point list, inclusive of both
 * ends. The caller drops the duplicate when appending to a running polyline.
 */
export function tessellateArc(cx, cy, r, a0, a1, chordTol = CHORD_TOL) {
  const span = norm(a1 - a0) || TAU;
  const segs = arcSegments(r, span, chordTol);
  const out = new Array((segs + 1) * 2);
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (span * i) / segs;
    out[i * 2] = cx + r * Math.cos(a);
    out[i * 2 + 1] = cy + r * Math.sin(a);
  }
  return out;
}

/** Union-find over point ids. */
function makeUnion() {
  const parent = new Map();
  const find = (a) => {
    let root = a;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root);
    let cur = a;
    while (parent.has(cur) && parent.get(cur) !== cur) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  return {
    add(a) { if (!parent.has(a)) parent.set(a, a); },
    find,
    union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    },
  };
}

/**
 * Group the sketch's points into vertices: one per distinct location, merging
 * ids joined by a `coincident` constraint or sitting within `weldTol` of each
 * other. Returns a `vertexOf(pointId)` lookup.
 */
function weldPoints(sk, weldTol) {
  const uf = makeUnion();
  const pts = [];
  for (const e of sk.entities.values()) {
    if (e.type !== 'point') continue;
    uf.add(e.id);
    pts.push(e);
  }
  for (const c of sk.constraints) {
    if (c.kind === 'coincident') uf.union(c.refs[0], c.refs[1]);
  }
  // Positional merge. O(n²) on points, which a hand-drawn sketch has few of; the
  // sketches this runs on are dozens of points, not the thousands a slice chains.
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (Math.abs(pts[i].x - pts[j].x) <= weldTol && Math.abs(pts[i].y - pts[j].y) <= weldTol) {
        uf.union(pts[i].id, pts[j].id);
      }
    }
  }
  return (id) => uf.find(id);
}

/**
 * Where two segments cross, as the fraction along each. Null when they miss, or
 * are parallel — a collinear overlap has no single crossing point and splitting
 * at an arbitrary one of them would not help.
 */
function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [t, u];
}

/**
 * Cut every curve where it meets another — the **arrangement**.
 *
 * Without this the graph is joined by topology alone: two entities are connected
 * exactly when they name the same point. That is right for a profile drawn by
 * snapping corner to corner, and wrong for the two things people actually do —
 * dropping a divider whose ends land *on* an edge rather than on its endpoints,
 * and overlapping two shapes that share no vertex at all. Both used to come back
 * as geometry that visibly crosses and is treated as though it does not: the
 * divider pruned away as dangling, the overlap counted twice.
 *
 * Splitting is done on the **tessellated** polylines, so an arc is cut as
 * accurately as it is drawn and no curve-curve intersection maths is needed. The
 * pieces keep the id of the entity they came from, so a caller can still say
 * which geometry formed a loop.
 *
 * O(curves²) on segment pairs. A hand-drawn profile is tens of curves and a few
 * hundred segments; the cost that matters is bounded by the chord tolerance,
 * which is the same thing that bounds the drawing's accuracy.
 */
function arrangeCurves(curves, tol) {
  // splits[i] = list of { seg, t } cut points along curve i
  const splits = curves.map(() => []);
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const A = curves[i].points;
      const B = curves[j].points;
      for (let a = 0; a + 3 < A.length; a += 2) {
        for (let b = 0; b + 3 < B.length; b += 2) {
          const hit = segCross(
            A[a], A[a + 1], A[a + 2], A[a + 3],
            B[b], B[b + 1], B[b + 2], B[b + 3],
          );
          if (!hit) continue;
          splits[i].push({ seg: a / 2, t: hit[0] });
          splits[j].push({ seg: b / 2, t: hit[1] });
        }
      }
    }
  }

  const out = [];
  for (let i = 0; i < curves.length; i++) {
    const { id, points, closed } = curves[i];
    const lastSeg = points.length / 2 - 2;
    const raw = splits[i];
    // A crossing that lands on the curve's own **seam** — where a closed curve's
    // polyline begins and ends — is a real junction even though it is at t = 0
    // or t = 1 of a segment. It is what decides whether the two ends of a cut
    // ring join back up or stay two separate arcs.
    const seamCut = closed && raw.some((c) => (c.seg === 0 && c.t <= 1e-9)
      || (c.seg === lastSeg && c.t >= 1 - 1e-9));
    const cuts = raw
      .filter((c) => c.t > 1e-9 && c.t < 1 - 1e-9) // a cut on a joint is no cut
      .sort((p, q) => (p.seg - q.seg) || (p.t - q.t));
    if (!cuts.length && !seamCut) { out.push(curves[i]); continue; }

    // Walk the polyline, starting a new piece at every cut.
    const firstIndex = out.length;
    let piece = [points[0], points[1]];
    let at = 0;
    const emit = () => {
      if (piece.length >= 4) out.push({ id, points: piece });
    };
    for (let s = 0; s + 3 < points.length; s += 2) {
      const seg = s / 2;
      const [x0, y0, x1, y1] = [points[s], points[s + 1], points[s + 2], points[s + 3]];
      while (at < cuts.length && cuts[at].seg === seg) {
        const { t } = cuts[at];
        const px = x0 + (x1 - x0) * t;
        const py = y0 + (y1 - y0) * t;
        // Two crossings within tolerance of each other are one vertex.
        const lastX = piece[piece.length - 2];
        const lastY = piece[piece.length - 1];
        if (Math.abs(px - lastX) > tol || Math.abs(py - lastY) > tol) {
          piece.push(px, py);
          emit();
          piece = [px, py];
        }
        at += 1;
      }
      piece.push(x1, y1);
    }
    emit();

    // A closed curve's seam is an artefact of where its polyline happened to
    // start, not a vertex — unless something was actually cut there. Where it is
    // not, the last piece is joined back onto the first so the arc that spans
    // the seam is one arc and not two meeting at a point nothing created.
    const made = out.length - firstIndex;
    if (closed && !seamCut && made >= 2) {
      const head = out[firstIndex];
      const tail = out[out.length - 1];
      head.points = [...tail.points, ...head.points.slice(2)];
      out.pop();
    }
  }
  return out;
}

/**
 * The sketch as a graph: `edges` are curves with their two end vertices and a
 * polyline running from `a` to `b`, `rings` are the ones that close on
 * themselves and meet nothing (a circle on its own).
 *
 * Vertices are assigned **after** the arrangement, by welding the endpoints of
 * the pieces — which is what makes a crossing a real junction rather than two
 * curves passing through the same coordinates unaware of each other. Coincident
 * constraints are folded in first by snapping each point to its group's
 * representative, so positional welding alone is then enough.
 */
function buildGraph(sk, { chordTol, weldTol }) {
  const vertexOf = weldPoints(sk, weldTol);
  const P = (id) => sk.entities.get(id);
  // Every point speaks for its welded group, so two points a constraint made one
  // produce identical coordinates and weld again after the arrangement.
  const rep = new Map();
  for (const e of sk.entities.values()) {
    if (e.type !== 'point') continue;
    const r = vertexOf(e.id);
    if (!rep.has(r)) rep.set(r, e);
  }
  const at2 = (id) => rep.get(vertexOf(id)) || P(id);

  const curves = [];
  for (const e of sk.entities.values()) {
    if (e.construction) continue;
    if (e.type === 'line') {
      const p1 = at2(e.p1);
      const p2 = at2(e.p2);
      if (!p1 || !p2) continue;
      if (Math.abs(p1.x - p2.x) <= weldTol && Math.abs(p1.y - p2.y) <= weldTol) continue;
      curves.push({ id: e.id, points: [p1.x, p1.y, p2.x, p2.y] });
    } else if (e.type === 'arc') {
      const c = P(e.center);
      const s = at2(e.start);
      const en = at2(e.end);
      if (!c || !s || !en) continue;
      const a0 = Math.atan2(s.y - c.y, s.x - c.x);
      const a1 = Math.atan2(en.y - c.y, en.x - c.x);
      const points = tessellateArc(c.x, c.y, e.r, a0, a1, chordTol);
      // Pin the ends to the points themselves: the rim projection is within
      // solver tolerance of them, and an exact match keeps a chained loop from
      // showing a hairline step where an arc meets the line it is tangent to.
      points[0] = s.x; points[1] = s.y;
      points[points.length - 2] = en.x; points[points.length - 1] = en.y;
      const closed = Math.abs(s.x - en.x) <= weldTol && Math.abs(s.y - en.y) <= weldTol;
      curves.push({ id: e.id, points, closed });
    } else if (e.type === 'circle') {
      const c = P(e.center);
      if (!c || !(e.r > 0)) continue;
      const points = tessellateArc(c.x, c.y, e.r, 0, TAU, chordTol);
      curves.push({ id: e.id, points, closed: true });
    }
  }

  const pieces = arrangeCurves(curves, weldTol);

  // Weld the pieces' endpoints into vertices. Anything still closing on itself
  // met nothing and stays a ring; everything else becomes an edge.
  const nodes = [];
  const nodeAt = (x, y) => {
    for (let i = 0; i < nodes.length; i++) {
      if (Math.abs(nodes[i][0] - x) <= weldTol && Math.abs(nodes[i][1] - y) <= weldTol) return i;
    }
    nodes.push([x, y]);
    return nodes.length - 1;
  };

  const edges = [];
  const rings = [];
  for (const piece of pieces) {
    const pts = piece.points;
    const n = pts.length / 2;
    if (n < 2) continue;
    const sameEnds = Math.abs(pts[0] - pts[n * 2 - 2]) <= weldTol
      && Math.abs(pts[1] - pts[n * 2 - 1]) <= weldTol;
    if (sameEnds) {
      if (n < 4) continue; // a hairline that closed on itself carries no area
      rings.push({ id: piece.id, points: pts.slice(0, -2) });
      continue;
    }
    const a = nodeAt(pts[0], pts[1]);
    const b = nodeAt(pts[n * 2 - 2], pts[n * 2 - 1]);
    if (a === b) continue;
    edges.push({ id: piece.id, a, b, points: pts });
  }

  const at = new Map(); // vertex -> edge indices touching it
  edges.forEach((edge, i) => {
    for (const v of [edge.a, edge.b]) {
      const list = at.get(v);
      if (list) list.push(i);
      else at.set(v, [i]);
    }
  });
  return { edges, rings, at, nodes };
}

/**
 * Strip the geometry that cannot bound a region.
 *
 * Anything hanging by one end — a line drawn and left, a chain that stops short
 * — is peeled off, repeatedly, because removing an edge can leave its neighbour
 * hanging in turn. What survives has every vertex on at least two edges, which
 * is the precondition for face traversal and, more usefully, means a dangling
 * line lying *inside* a profile no longer puts a zero-width spike into it.
 */
function pruneDangling(edges, at) {
  const degree = new Map();
  for (const [v, list] of at) degree.set(v, list.length);
  const alive = new Uint8Array(edges.length).fill(1);
  const queue = [...degree.entries()].filter(([, d]) => d === 1).map(([v]) => v);

  while (queue.length) {
    const v = queue.pop();
    if (degree.get(v) !== 1) continue;
    const i = (at.get(v) || []).find((k) => alive[k]);
    if (i === undefined) { degree.set(v, 0); continue; }
    alive[i] = 0;
    for (const u of [edges[i].a, edges[i].b]) {
      const d = (degree.get(u) || 1) - 1;
      degree.set(u, d);
      if (d === 1) queue.push(u);
    }
  }
  return { alive, degree };
}

/**
 * Trace the faces of the planar graph — the regions the geometry encloses.
 *
 * This replaced a walk that followed each edge to the next unused one and gave
 * up at any vertex with three edges on it, calling the profile ambiguous. It is
 * not ambiguous: a line across a rectangle makes two regions, and every CAD
 * shows them. What the old walk lacked was a rule for *which* way to turn.
 *
 * The rule is the standard one. Arriving along a half-edge, take its reverse and
 * step to the next half-edge **clockwise** around the vertex. Following it
 * always turns as sharply left as possible, so a bounded face comes out
 * counter-clockwise and the one unbounded face comes out clockwise — which is
 * exactly how it is told apart and dropped, by the sign of its area.
 *
 * Departure angles are taken from the **tessellated polyline's first step**, not
 * from the straight line between a curve's endpoints: at a vertex where an arc
 * meets a line the ordering has to follow the arc's tangent, and its chord can
 * point the other side of the line entirely.
 */
function traceFaces(edges, alive) {
  // Half-edge h: edge h>>1, travelled forwards when h is even. Its twin is h^1.
  const originOf = (h) => (h % 2 === 0 ? edges[h >> 1].a : edges[h >> 1].b);
  const pointsOf = (h) => (h % 2 === 0 ? edges[h >> 1].points : reversePoints(edges[h >> 1].points));

  const around = new Map(); // vertex -> half-edges leaving it, sorted CCW
  const angle = new Float64Array(edges.length * 2);
  for (let i = 0; i < edges.length; i++) {
    if (!alive[i]) continue;
    for (const h of [i * 2, i * 2 + 1]) {
      const p = pointsOf(h);
      angle[h] = Math.atan2(p[3] - p[1], p[2] - p[0]);
      const v = originOf(h);
      const list = around.get(v);
      if (list) list.push(h); else around.set(v, [h]);
    }
  }
  for (const list of around.values()) {
    // Ties (two curves leaving in the same direction) are broken by index, so
    // the order is at least deterministic where the geometry cannot decide.
    list.sort((x, y) => (angle[x] - angle[y]) || (x - y));
  }
  const slot = new Map(); // half-edge -> its position in its origin's list
  for (const [, list] of around) list.forEach((h, k) => slot.set(h, k));

  const seen = new Uint8Array(edges.length * 2);
  const faces = [];
  for (let start = 0; start < edges.length * 2; start++) {
    if (!alive[start >> 1] || seen[start]) continue;
    const points = [];
    const entities = [];
    let h = start;
    // A face cannot be longer than every half-edge there is.
    for (let guard = edges.length * 2 + 1; guard > 0; guard--) {
      seen[h] = 1;
      const seg = pointsOf(h);
      // Each half-edge starts where the last one ended; skip the repeat.
      for (let k = points.length ? 2 : 0; k < seg.length; k++) points.push(seg[k]);
      entities.push(edges[h >> 1].id);

      const twin = h ^ 1;
      const list = around.get(originOf(twin));
      const k = slot.get(twin);
      const next = list[(k - 1 + list.length) % list.length];
      if (next === start) break;
      h = next;
      if (seen[h]) break; // cannot happen for a well-formed graph; never spin
    }
    points.length -= 2; // the last point closed back onto the first
    faces.push({ points, entities });
  }
  return faces;
}

/**
 * Closed loops of the graph, plus the geometry that bounds nothing.
 *
 * Rings (a circle, or an arc closing on itself) never enter the graph — they are
 * already loops. Everything else is pruned, traced, and the unbounded face
 * dropped by the sign of its area.
 */
function chainGraph({ edges, rings, at, nodes }) {
  const closed = [];
  for (const ring of rings) closed.push({ points: ring.points, entities: [ring.id] });

  const { alive, degree } = pruneDangling(edges, at);
  for (const face of traceFaces(edges, alive)) {
    // The one clockwise face is the outside of the component, not a region.
    if (loopArea(face.points) > 0) closed.push(face);
  }

  // What was pruned is reported, not silently dropped: geometry left out of the
  // solid has to be visible to whoever drew it.
  const open = [];
  const used = new Uint8Array(edges.length);
  /** Extend a chain from `vertex`, appending to `out`. Only pruned edges. */
  const walk = (vertex, prev, out, ids) => {
    let at2 = vertex;
    let last = prev;
    for (;;) {
      const from = last;
      const next = (at.get(at2) || []).filter((i) => i !== from && !alive[i] && !used[i]);
      if (next.length !== 1) return;
      const i = next[0];
      used[i] = 1;
      ids.push(edges[i].id);
      const forward = edges[i].a === at2;
      const seg = forward ? edges[i].points : reversePoints(edges[i].points);
      for (let k = 2; k < seg.length; k++) out.push(seg[k]);
      at2 = forward ? edges[i].b : edges[i].a;
      last = i;
    }
  };
  for (let s = 0; s < edges.length; s++) {
    if (alive[s] || used[s]) continue;
    used[s] = 1;
    // Grown in both directions from the seed and spliced, the same way an open
    // chain was assembled before: forwards from b, then backwards from a with
    // the seed reversed, so the two halves overlap on the seed and line up.
    const points = edges[s].points.slice();
    const entities = [edges[s].id];
    walk(edges[s].b, s, points, entities);
    const tail = reversePoints(edges[s].points);
    const tailIds = [];
    walk(edges[s].a, s, tail, tailIds);
    const front = reversePoints(tail); // … → a → b
    open.push({
      points: [...front, ...points.slice(4)],
      entities: [...tailIds.reverse(), ...entities],
    });
  }

  // Reported for information now rather than as a failure: face traversal
  // resolves a junction rather than giving up at it. Given as **coordinates**
  // rather than ids — a junction can now be a crossing the arrangement created,
  // which is not any point the user drew and has no id to name it by.
  const branches = [...degree.entries()]
    .filter(([, d]) => d > 2)
    .map(([v]) => nodes[v])
    .filter(Boolean);
  return { closed, open, branches };
}

/**
 * Closed loops of a sketch, outer-CCW / hole-CW and biggest first.
 *
 * @param {object} sk  sketch document (`model.js`)
 * @param {{chordTol?:number, weldTol?:number, minArea?:number}} [opts]
 * @returns {{loops: object[], open: object[], branches: number[]}}
 *   `loops[i]` is `{ points, area, isHole, depth, signedArea, entities }`;
 *   `open` holds the chains that never closed, so a caller can say which
 *   geometry is dangling; `branches` names the ambiguous vertices.
 */
export function sketchLoops(sk, opts = {}) {
  const { chordTol = CHORD_TOL, weldTol = WELD_TOL, minArea = 1e-6 } = opts;
  if (!sk?.entities) return { loops: [], open: [], branches: [] };
  const graph = buildGraph(sk, { chordTol, weldTol });
  const { closed, open, branches } = chainGraph(graph);
  const loops = normalizeLoops(closed.map((c) => c.points), { minArea })
    .map((loop) => ({ ...loop, entities: closed[loop.sourceIndex].entities }));
  return { loops, open, branches };
}

/**
 * Group loops into the regions a solid is actually made from: each outer
 * boundary with the holes that belong to it.
 *
 * Nesting depth already says which is which — `sliceLoops`' convention is that
 * an even depth is solid and an odd one is a hole — so a hole is assigned to the
 * *nearest* enclosing solid, which is the last loop before it whose depth is one
 * less. Loops arrive biggest-first, so that loop has always been seen already.
 * An island standing inside a pocket comes back as its own region, which is what
 * extruding it should produce.
 *
 * @returns {{outer:number[], holes:number[][], area:number, entities:number[]}[]}
 */
export function sketchRegions(sk, opts = {}) {
  const { loops, open, branches } = sketchLoops(sk, opts);
  return { regions: groupRegions(loops), open, branches };
}

/**
 * Group normalized loops into regions.
 *
 * Split from `sketchRegions` because a boolean produces loops too
 * (`engine/solid/regionBoolean.js`), and "which hole belongs to which outer" has
 * to be decided the same way for both or a subtracted pocket comes back as a
 * separate body sitting inside its own plate.
 *
 * @param {object[]} loops  `normalizeLoops` output — biggest first, depth set
 */
export function groupRegions(loops) {
  const regions = [];
  const openAt = []; // region index most recently opened at each depth
  for (const loop of loops) {
    if (!loop.isHole) {
      openAt[loop.depth] = regions.length;
      regions.push({
        outer: loop.points, holes: [], area: loop.area, entities: [...(loop.entities || [])],
      });
    } else {
      const owner = regions[openAt[loop.depth - 1]];
      // A hole with no enclosing solid cannot happen — depth is what made it a
      // hole — but a caller passing hand-built loops in could produce one.
      if (!owner) continue;
      owner.holes.push(loop.points);
      owner.area -= loop.area;
      owner.entities.push(...(loop.entities || []));
    }
  }
  return regions;
}
