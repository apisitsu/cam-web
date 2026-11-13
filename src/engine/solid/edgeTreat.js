/**
 * Chamfer and fillet on the edges of a built part.
 *
 * The kernel is a triangle soup with a mesh boolean, not a B-rep, so an edge
 * cannot be "rounded" in place. What it can do is build the **piece of material
 * the treatment removes** (or, on an inside corner, adds) and boolean it with the
 * part. That piece is a cross-section swept along the edge:
 *
 * - a **straight edge** — the section extruded the edge's length;
 * - a **round edge** (the rim of a bore or a boss) — the section revolved about
 *   the circle's axis, with the facet count and phase of the rim itself, so the
 *   tool's facets run along the part's.
 *
 * The section is worked out in a 2D frame square to the edge, from the two faces
 * that meet there: their outward normals `n1`, `n2` and the directions `t1`, `t2`
 * that run away from the edge along each face. A convex edge (an outside corner)
 * is cut; a concave one (an inside corner) is filled.
 *
 * Edges are stored as **geometry**, never as indices — the same rule the feature
 * tree keeps for faces. A straight edge is re-found on replay along its stored
 * line, so a block made longer gets its whole edge chamfered; a rim is re-found
 * by centre and radius. An edge that is not there any more fails the feature
 * with that reason.
 *
 * Where three treated edges meet at a corner the pieces simply overlap: a
 * chamfered corner comes out mitred, a filleted one with a sharp seam rather
 * than a rolling-ball blend. Stated, not hidden.
 *
 * Pure: plain arrays, no three.js.
 */
import { extrudeRegion, revolveRegion } from './extrude.js';
import { detectSharpEdges } from '../mesh/features.js';
import { edgeAtPoint } from '../mesh/pickEdge.js';
import { fitCircle } from '../mesh/circlePick.js';

export const EDGE_TREATMENTS = {
  chamfer: { label: 'Chamfer', size: 'Distance' },
  fillet: { label: 'Fillet', size: 'Radius' },
};

const sub = (a, b) => a.map((v, i) => v - b[i]);
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, k) => a.map((v) => v * k);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const len = (a) => Math.sqrt(dot(a, a));
const unit = (a) => { const l = len(a) || 1; return scale(a, 1 / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** How near a vertex must be to an edge to be on it, mm. The soup is float32. */
const ON = 2e-3;
/** How far a straight tool runs past each end of its edge, mm. */
const PAST_END = 0.05;
/** Arc facets for a fillet: one per this many radians, at least four. */
const ARC_STEP = Math.PI / 36;

/** Triangle `t` of a soup, or of a welded (indexed) mesh. */
function triangle(mesh, t) {
  const p = mesh.positions;
  const ix = mesh.indices;
  const at = (c) => {
    const o = (ix ? ix[t * 3 + c] : t * 3 + c) * 3;
    return [p[o], p[o + 1], p[o + 2]];
  };
  return [at(0), at(1), at(2)];
}

function normalOf(tri) {
  return unit(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
}

const centroid = (tri) => scale(add(add(tri[0], tri[1]), tri[2]), 1 / 3);

/** Group directions that agree to within ~2.5°. */
function cluster(items, key) {
  const groups = [];
  for (const it of items) {
    const n = key(it);
    const g = groups.find((x) => dot(x.n, n) > 0.999);
    if (g) g.items.push(it); else groups.push({ n, items: [it] });
  }
  return groups.sort((a, b) => b.items.length - a.items.length);
}

/**
 * The 2D cross-section of the treatment at one edge.
 *
 * Everything is in a plane square to the edge: `P` the edge, `n1`/`n2` the two
 * faces' outward normals, `t1`/`t2` the way each face runs away from the edge.
 * Returns the loop (counter-clockwise, flat `[x0,y0,…]`) and whether it cuts.
 */
export function treatmentSection({
  P, n1, n2, t1, t2,
}, kind, size, reach = Infinity) {
  if (!(size > 0)) throw new Error(`a ${kind} needs a size greater than zero`);
  const cosPhi = Math.max(-1, Math.min(1, dot(t1, t2)));
  const phi = Math.acos(cosPhi);
  if (phi < (10 * Math.PI) / 180 || phi > (170 * Math.PI) / 180) {
    throw new Error('the faces at that edge are too nearly flat (or folded back) to treat');
  }
  const convex = dot(t1, n2) < 0;
  const s = convex ? 1 : -1;
  const out = Math.min(size, reach);
  const eps = Math.min(0.05, size * 0.1);

  let A;
  let B;
  const arc = [];
  if (kind === 'chamfer') {
    A = add(P, scale(t1, size));
    B = add(P, scale(t2, size));
  } else {
    const L = size / Math.tan(phi / 2);
    A = add(P, scale(t1, L));
    B = add(P, scale(t2, L));
    const C = add(P, scale(unit(add(t1, t2)), size / Math.sin(phi / 2)));
    const a0 = Math.atan2(A[1] - C[1], A[0] - C[0]);
    let a1 = Math.atan2(B[1] - C[1], B[0] - C[0]);
    // The short way round, which is the side facing the corner.
    let d = a1 - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    a1 = a0 + d;
    const steps = Math.max(4, Math.ceil(Math.abs(d) / ARC_STEP));
    for (let k = 1; k < steps; k++) {
      const a = a0 + (d * k) / steps;
      arc.push([C[0] + size * Math.cos(a), C[1] + size * Math.sin(a)]);
    }
  }
  // The tool has to cross each face, not stop on it: a ring of tool corners
  // lying exactly on the part's surface is what a mesh boolean cannot split
  // cleanly. A chamfer's flat simply runs on past both faces; a fillet's arc
  // meets its faces tangentially, so it is stepped off them along the normals.
  const Q = add(P, scale(add(n1, n2), s * out));
  const pts = kind === 'chamfer'
    ? [add(A, scale(unit(sub(A, B)), eps)), add(B, scale(unit(sub(B, A)), eps)), Q]
    : [add(A, scale(n1, s * eps)), A, ...arc, B, add(B, scale(n2, s * eps)), Q];
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    area += x0 * y1 - x1 * y0;
  }
  if (area < 0) pts.reverse();
  return { loop: pts.flat(), convex };
}

// ---------------------------------------------------------------------------
// Straight edges

/**
 * The faces either side of a straight edge, and how far along its line the edge
 * runs in this mesh. `ref.a`/`ref.b` say where it was; the run returned is the
 * stretch of the line where both faces still meet, overlapping that.
 */
export function lineEdgeFrame(soup, ref) {
  const d = unit(sub(ref.b, ref.a));
  const L0 = len(sub(ref.b, ref.a));
  if (!(L0 > 1e-6)) throw new Error('that edge has no length');
  const offLine = (p) => {
    const w = sub(p, ref.a);
    return len(sub(w, scale(d, dot(w, d))));
  };
  const along = (p) => dot(sub(p, ref.a), d);

  const hits = [];
  for (let t = 0; t < soup.triangleCount; t++) {
    const tri = triangle(soup, t);
    const on = tri.filter((p) => offLine(p) < ON);
    if (on.length !== 2) continue;
    const s0 = along(on[0]);
    const s1 = along(on[1]);
    hits.push({
      tri, n: normalOf(tri), lo: Math.min(s0, s1), hi: Math.max(s0, s1),
    });
  }
  let groups = cluster(hits, (h) => h.n);
  if (ref.n1 && ref.n2) {
    // Stored normals pick out the same two faces again, if the line has more.
    const pick = (n) => groups.find((g) => dot(g.n, n) > 0.999);
    const g1 = pick(ref.n1);
    const g2 = pick(ref.n2);
    if (g1 && g2 && g1 !== g2) groups = [g1, g2];
  }
  if (groups.length < 2) throw new Error('that edge is no longer on the part');
  const [f1, f2] = groups;
  if (dot(f1.n, f2.n) > 0.985) throw new Error('the faces at that edge are too nearly flat to treat');

  // Merge each face's stretches along the line, then keep where both are.
  const runs = (g) => {
    const xs = g.items.map((h) => [h.lo, h.hi]).sort((a, b) => a[0] - b[0]);
    const outRuns = [];
    for (const [lo, hi] of xs) {
      const last = outRuns[outRuns.length - 1];
      if (last && lo <= last[1] + ON) last[1] = Math.max(last[1], hi);
      else outRuns.push([lo, hi]);
    }
    return outRuns;
  };
  const both = [];
  for (const [a0, a1] of runs(f1)) {
    for (const [b0, b1] of runs(f2)) {
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (hi - lo > ON) both.push([lo, hi]);
    }
  }
  const run = both.find(([lo, hi]) => hi > -ON && lo < L0 + ON);
  if (!run) throw new Error('that edge is no longer on the part');

  const inFace = (g) => {
    const h = g.items[0];
    const w = sub(centroid(h.tri), ref.a);
    return unit(sub(w, scale(d, dot(w, d))));
  };
  return {
    a: add(ref.a, scale(d, run[0])),
    b: add(ref.a, scale(d, run[1])),
    d,
    n1: f1.n,
    n2: f2.n,
    t1: inFace(f1),
    t2: inFace(f2),
  };
}

function lineTool(soup, ref, kind, size) {
  const f = lineEdgeFrame(soup, ref);
  const u = f.n1;
  const v = cross(f.d, u);
  const to2 = (w) => [dot(w, u), dot(w, v)];
  const { loop, convex } = treatmentSection({
    P: [0, 0], n1: to2(f.n1), n2: to2(f.n2), t1: to2(f.t1), t2: to2(f.t2),
  }, kind, size);
  const L = len(sub(f.b, f.a));
  const solid = extrudeRegion({ outer: loop }, {
    plane: { origin: sub(f.a, scale(f.d, PAST_END)), u, v },
    depth: L + 2 * PAST_END,
  });
  return { solid, merge: convex ? 'cut' : 'add' };
}

// ---------------------------------------------------------------------------
// Round edges

const AXIS_VEC = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * The faces at a circular rim: the flat one square to the axis and the round
 * wall, read off the triangles that touch the rim. Also the rim's own facets —
 * count and phase — so the tool can be faceted to match.
 */
export function circleEdgeFrame(soup, ref) {
  const { axis, center, radius: R } = ref;
  const k = AXIS_VEC[axis];
  const [iu, iv] = [0, 1, 2].filter((i) => i !== axis);
  const tol = Math.max(ON, R * 2e-3);
  const radial = (p) => Math.hypot(p[iu] - center[iu], p[iv] - center[iv]);
  const onRim = (p) => Math.abs(p[axis] - center[axis]) < tol && Math.abs(radial(p) - R) < tol;

  let flat = null;
  let wall = null;
  const rim = [];
  for (let t = 0; t < soup.triangleCount; t++) {
    const tri = triangle(soup, t);
    const on = tri.filter(onRim);
    if (on.length < 2) continue;
    rim.push(...on);
    const n = normalOf(tri);
    const c = centroid(tri);
    const nk = dot(n, k);
    if (Math.abs(nk) > 0.99) {
      flat = flat || { nk: Math.sign(nk), tr: Math.sign(radial(c) - R) || -1 };
    } else if (Math.abs(nk) < 0.2) {
      const rdir = unit([...[0, 1, 2]].map((i) => (i === axis ? 0 : c[i] - center[i])));
      wall = wall || { nr: Math.sign(dot(n, rdir)), tz: Math.sign(c[axis] - center[axis]) };
    }
  }
  if (!flat || !wall) throw new Error(`the Ø${(2 * R).toFixed(2)} rim is no longer on the part`);

  // The rim's corners, for the facet count and where the first one sits. A
  // boolean leaves extra vertices part-way along the facets, and those sit
  // inside the circle the corners lie on; so the corners are the most common
  // radius among the outer points (a stray vertex or two can sit further out).
  // Kept only if they are evenly spaced — otherwise the tool gets its own
  // default faceting.
  const band = R * 2e-5;
  const radii = rim.map((p) => ({ p, r: radial(p) }));
  let rCorner = R;
  let best = -1;
  for (const { r } of radii) {
    if (r < R - band) continue;
    const count = radii.filter((q) => Math.abs(q.r - r) < band).length;
    if (count > best || (count === best && r > rCorner)) { best = count; rCorner = r; }
  }
  const angles = [];
  for (const { p, r } of radii) {
    if (Math.abs(r - rCorner) >= band) continue;
    const a = Math.atan2(p[iv] - center[iv], p[iu] - center[iu]);
    if (!angles.some((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 2e-3)) angles.push(a);
  }
  angles.sort((a, b) => a - b);
  const step = (2 * Math.PI) / angles.length;
  const even = angles.length >= 8 && angles.every((a, i) => {
    const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI;
    return Math.abs(next - a - step) < step * 0.05;
  });

  return {
    k,
    n1: [0, flat.nk],
    t1: [flat.tr, 0],
    n2: [wall.nr, 0],
    t2: [0, wall.tz],
    radius: even ? rCorner : R,
    segments: even ? angles.length : null,
    phase: even ? angles[0] : 0,
  };
}


function circleTool(soup, ref, kind, size) {
  const f = circleEdgeFrame(soup, ref);
  const R = f.radius;
  const { loop, convex } = treatmentSection({
    P: [R, 0], n1: f.n1, n2: f.n2, t1: f.t1, t2: f.t2,
  }, kind, size, R * 0.5);
  for (let i = 0; i < loop.length; i += 2) {
    if (loop[i] <= 0) throw new Error(`a ${size} mm ${kind} does not fit a Ø${(2 * R).toFixed(2)} rim`);
  }
  const [iu, iv] = [0, 1, 2].filter((i) => i !== ref.axis);
  const u = [0, 0, 0];
  u[iu] = Math.cos(f.phase);
  u[iv] = Math.sin(f.phase);
  const solid = revolveRegion({ outer: loop }, {
    axis: 'y',
    plane: { origin: [...ref.center], u, v: f.k },
    segments: f.segments ?? undefined,
  });
  return { solid, merge: convex ? 'cut' : 'add' };
}

/**
 * The pieces a Chamfer or Fillet feature booleans with the part, one per edge,
 * all worked out on the part as it was before the feature.
 *
 * @returns {{solid:object, merge:'cut'|'add'}[]}
 */
export function edgeTreatmentTools(soup, feature) {
  if (!soup?.triangleCount) throw new Error(`a ${feature.kind} needs a part to work on`);
  if (!feature.edges?.length) throw new Error('no edges are picked');
  return feature.edges.map((ref) => (ref.type === 'circle'
    ? circleTool(soup, ref, feature.kind, feature.size)
    : lineTool(soup, ref, feature.kind, feature.size)));
}

/**
 * Apply a Chamfer or Fillet feature to a part. `meshBoolean` as the tree has it.
 */
export function applyEdgeTreatment(soup, feature, meshBoolean) {
  if (!meshBoolean) throw new Error('no solid boolean is available to cut the part with');
  let out = soup;
  for (const { solid, merge } of edgeTreatmentTools(soup, feature)) {
    out = meshBoolean(out, solid, merge, feature.kind);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Picking

/** Read an edge reference off a project file, or null. */
export function parseEdgeRef(raw) {
  const vec = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (raw?.type === 'line' && vec(raw.a) && vec(raw.b)) {
    const ref = { type: 'line', a: [...raw.a], b: [...raw.b] };
    if (vec(raw.n1) && vec(raw.n2)) { ref.n1 = [...raw.n1]; ref.n2 = [...raw.n2]; }
    return ref;
  }
  if (raw?.type === 'circle' && [0, 1, 2].includes(raw.axis) && vec(raw.center) && raw.radius > 0) {
    return {
      type: 'circle', axis: raw.axis, center: [...raw.center], radius: raw.radius,
    };
  }
  return null;
}

/** Same edge? Used to toggle a pick off again. */
export function sameEdge(a, b) {
  const near = (p, q) => len(sub(p, q)) < 0.01;
  if (a?.type !== b?.type) return false;
  if (a.type === 'circle') return a.axis === b.axis && near(a.center, b.center) && Math.abs(a.radius - b.radius) < 0.01;
  return (near(a.a, b.a) && near(a.b, b.b)) || (near(a.a, b.b) && near(a.b, b.a));
}

/**
 * The edge a click on the part means, as a reference a feature can keep: the
 * straight run of the sharp edge under the cursor, or — for a closed round chain —
 * the circle. `null` when there is no sharp edge there, or it is neither.
 *
 * @param {object} welded  the part as built (the Sketch page's frame), welded
 * @param {number[]} point  the click, same frame
 * @param {object[]} [edges] its detected sharp edges, if the caller has them
 */
export function pickTreatEdge(welded, point, tolerance, edges) {
  const chains = edges || detectSharpEdges(welded);
  const chain = edgeAtPoint(chains, point, tolerance);
  if (!chain) return null;
  const pts = chain.points;
  if (chain.closed && pts.length >= 8) {
    const { min, max } = chain.bounds;
    const axis = [0, 1, 2].find((i) => max[i] - min[i] < 1e-3);
    if (axis != null) {
      const [iu, iv] = [0, 1, 2].filter((i) => i !== axis);
      const circle = fitCircle(pts.flatMap((p) => [p[iu], p[iv]]));
      if (circle) {
        const center = [0, 0, 0];
        center[axis] = (min[axis] + max[axis]) / 2;
        [center[iu], center[iv]] = circle.center;
        return {
          type: 'circle', axis, center, radius: circle.radius,
        };
      }
    }
  }
  // The straight run containing the segment nearest the click.
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ab = sub(pts[i + 1], pts[i]);
    const t = Math.max(0, Math.min(1, dot(sub(point, pts[i]), ab) / (dot(ab, ab) || 1)));
    const dd = len(sub(point, add(pts[i], scale(ab, t))));
    if (dd < bestD) { bestD = dd; best = i; }
  }
  const dir = (i) => unit(sub(pts[i + 1], pts[i]));
  const along = dir(best);
  const straight = (i) => dot(dir(i), along) > 0.9999;
  let first = best;
  let last = best;
  while (first > 0 && straight(first - 1)) first -= 1;
  while (last + 2 < pts.length && straight(last + 1)) last += 1;
  const ref = { type: 'line', a: [...pts[first]], b: [...pts[last + 1]] };
  try {
    const f = lineEdgeFrame(welded, ref);
    return {
      ...ref, a: f.a, b: f.b, n1: f.n1, n2: f.n2,
    };
  } catch {
    return null;
  }
}

/** A short label for a picked edge. */
export function describeEdgeRef(ref) {
  if (ref.type === 'circle') return `Rim Ø${(2 * ref.radius).toFixed(2)}`;
  return `Edge ${len(sub(ref.b, ref.a)).toFixed(1)} mm`;
}
