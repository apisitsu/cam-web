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
 * - a **chain** — straight runs and arcs that follow on from one another round a
 *   flat face (the top edge of a part whose corners are filleted): a section
 *   extruded along each segment and run on past each joint so the pieces meet
 *   without a gap. All pieces are joined into one tool first.
 *
 * Where three treated edges meet at a corner the pieces simply overlap: a
 * chamfered corner comes out mitred, a filleted one with a sharp seam rather
 * than a rolling-ball blend. Stated, not hidden.
 *
 * Pure: plain arrays, no three.js.
 */
import { extrudeRegion, revolveRegion } from './extrude.js';
import { triangulate } from './triangulate.js';
import { detectSharpEdges } from '../mesh/features.js';
import { weld } from '../mesh/stl.js';
import { edgeAtPoint, distanceSqToEdge } from '../mesh/pickEdge.js';
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
}, kind, size, reach = Infinity, arcSteps = null) {
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
    // A fixed count when asked: the sections of one variable fillet must match
    // point for point, and a count from the angle can tip over by one.
    const steps = arcSteps ?? Math.max(4, Math.ceil(Math.abs(d) / ARC_STEP));
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
export function lineEdgeFrame(soup, ref, { strict = false } = {}) {
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
    else if (strict) throw new Error('that edge is no longer on the part');
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

/**
 * Where a straight edge went when the part changed under it: the nearest
 * straight sharp edge running the same way between faces facing the same ways
 * as the stored ones. Null if there is none.
 */
function relocateLine(soup, ref) {
  if (!ref.n1 || !ref.n2) return null;
  const d = unit(sub(ref.b, ref.a));
  const mid = scale(add(ref.a, ref.b), 0.5);
  const cands = [];
  for (const chain of detectSharpEdges(weld(soup))) {
    const pts = chainCorners(chain.points, chain.closed);
    const segs = chain.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const dir = unit(sub(b, a));
      if (Math.abs(dot(dir, d)) < 0.9999) continue;
      cands.push({ a, b, dist: len(sub(scale(add(a, b), 0.5), mid)) });
    }
  }
  cands.sort((x, y) => x.dist - y.dist);
  for (const c of cands) {
    try {
      const f = lineEdgeFrame(soup, {
        type: 'line', a: c.a, b: c.b, n1: ref.n1, n2: ref.n2,
      }, { strict: true });
      return {
        type: 'line', a: f.a, b: f.b, n1: f.n1, n2: f.n2,
      };
    } catch {
      // not this one
    }
  }
  return null;
}

/**
 * The size a variable fillet has at `f` (0–1) of the way along its edge: a
 * straight run from `a` to `b` on an open edge; round a closed one, which has
 * no ends, `a` at its start rising to `b` half-way and back, smoothly.
 */
const ARC_STEPS_VARIABLE = 16;

function varying(a, b, f, closed) {
  if (b == null || b === a) return a;
  if (!closed) return a + (b - a) * f;
  return a + ((b - a) * (1 - Math.cos(2 * Math.PI * f))) / 2;
}

/**
 * A tool whose section changes linearly along the edge: `loopA` at `pa`,
 * `loopB` at `pb` (2D loops in the frame u, v, the same number of points),
 * joined point to point. A fillet whose radius runs linearly is exactly this:
 * its section's centre and every arc point move linearly with the radius.
 */
function ruledTool(loopA, loopB, pa, pb, u, v) {
  return stationTool([loopA, loopB], [pa, pb], u, v);
}

/**
 * The same through several sections in a row: `loops[k]` at `at[k]`, joined
 * each to the next, capped at the two ends.
 */
function stationTool(loops, at, u, v) {
  const n = loops[0].length / 2;
  const pt = (loop, o, i) => [0, 1, 2].map((k) => o[k] + loop[i * 2] * u[k] + loop[i * 2 + 1] * v[k]);
  const tris = [];
  const cap = (loop, o, flip) => {
    const { vertices, indices } = triangulate(loop, []);
    const V = (i) => [0, 1, 2].map((k) => o[k] + vertices[i * 2] * u[k] + vertices[i * 2 + 1] * v[k]);
    for (let k = 0; k < indices.length; k += 3) {
      const t = [V(indices[k]), V(indices[k + 1]), V(indices[k + 2])];
      tris.push(flip ? [t[0], t[2], t[1]] : t);
    }
  };
  // u × v points along the stations, so the first cap faces back and the last on.
  cap(loops[0], at[0], true);
  cap(loops[loops.length - 1], at[at.length - 1], false);
  for (let s = 0; s + 1 < loops.length; s++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a0 = pt(loops[s], at[s], i); const a1 = pt(loops[s], at[s], j);
      const b0 = pt(loops[s + 1], at[s + 1], i); const b1 = pt(loops[s + 1], at[s + 1], j);
      tris.push([a0, a1, b1], [a0, b1, b0]);
    }
  }
  const positions = new Float32Array(tris.length * 9);
  tris.forEach((t, q) => t.forEach((p, m) => positions.set(p, q * 9 + m * 3)));
  return { positions, triangleCount: tris.length, format: 'extrude' };
}

/**
 * A closed ring of sections (each a closed loop of 3D points, all the same
 * count) joined loop to loop and round to the first: a solid with no ends.
 * Wound outward whichever way the rings run.
 */
function ringSolid(rings) {
  const n = rings.length;
  const m = rings[0].length;
  const tris = [];
  for (let k = 0; k < n; k++) {
    const A = rings[k]; const B = rings[(k + 1) % n];
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      tris.push([A[i], B[i], B[j]], [A[i], B[j], A[j]]);
    }
  }
  let vol = 0;
  for (const [a, b, c] of tris) vol += dot(a, cross(b, c));
  const positions = new Float32Array(tris.length * 9);
  tris.forEach((t, q) => (vol < 0 ? [t[0], t[2], t[1]] : t).forEach((p, mm) => positions.set(p, q * 9 + mm * 3)));
  return { positions, triangleCount: tris.length, format: 'revolve' };
}

function lineTool(soup, ref, kind, size, sizeEnd = null) {
  let f;
  try {
    f = lineEdgeFrame(soup, ref);
  } catch (e) {
    const moved = relocateLine(soup, ref);
    if (!moved) throw e;
    f = lineEdgeFrame(soup, moved);
  }
  const u = f.n1;
  const v = cross(f.d, u);
  const to2 = (w) => [dot(w, u), dot(w, v)];
  const { loop, convex } = treatmentSection({
    P: [0, 0], n1: to2(f.n1), n2: to2(f.n2), t1: to2(f.t1), t2: to2(f.t2),
  }, kind, size);
  const L = len(sub(f.b, f.a));
  if (sizeEnd != null && sizeEnd !== size) {
    // Variable: the size runs from `size` at the edge's start to `sizeEnd` at
    // its end, carried on past both ends at the same rate.
    const start = len(sub(f.a, ref.a)) <= len(sub(f.b, ref.a)) ? f.a : f.b;
    const sAt = (p) => size + ((sizeEnd - size) * (dot(sub(p, start), f.d) * (start === f.a ? 1 : -1))) / L;
    const pa = sub(f.a, scale(f.d, PAST_END));
    const pb = add(f.b, scale(f.d, PAST_END));
    const ra = sAt(pa); const rb = sAt(pb);
    if (!(ra > 0) || !(rb > 0)) throw new Error('a variable fillet needs both sizes greater than zero');
    const sec = (r) => treatmentSection({
      P: [0, 0], n1: to2(f.n1), n2: to2(f.n2), t1: to2(f.t1), t2: to2(f.t2),
    }, kind, r, Infinity, ARC_STEPS_VARIABLE).loop;
    return {
      solid: ruledTool(sec(ra), sec(rb), pa, pb, u, v), merge: convex ? 'cut' : 'add', frame: { ...f, convex },
    };
  }
  const solid = extrudeRegion({ outer: loop }, {
    plane: { origin: sub(f.a, scale(f.d, PAST_END)), u, v },
    depth: L + 2 * PAST_END,
  });
  return { solid, merge: convex ? 'cut' : 'add', frame: { ...f, convex } };
}

// ---------------------------------------------------------------------------
// Chains: straight runs and arcs round a flat face

/** Corner key at the weld grid, so a soup and its welded mesh agree. */
const cornerKey = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
const pairKey = (a, b) => {
  const ka = cornerKey(a);
  const kb = cornerKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

/**
 * Triangles by the edges they have, for a soup or a welded mesh. Kept per mesh:
 * a hover asks again on every pointer move over the same part.
 */
const _edgeTriangles = new WeakMap();
function edgeTriangles(mesh) {
  const hit = _edgeTriangles.get(mesh);
  if (hit) return hit;
  const map = new Map();
  _edgeTriangles.set(mesh, map);
  for (let t = 0; t < mesh.triangleCount; t++) {
    const tri = triangle(mesh, t);
    for (let k = 0; k < 3; k++) {
      const key = pairKey(tri[k], tri[(k + 1) % 3]);
      let list = map.get(key);
      if (!list) { list = []; map.set(key, list); }
      list.push(tri);
    }
  }
  return map;
}

/** A chain's corners without the closing repeat, and whether it closes. */
function chainCorners(points, closed) {
  const pts = points.map((q) => [...q]);
  if (closed && pts.length > 2 && cornerKey(pts[0]) === cornerKey(pts[pts.length - 1])) pts.pop();
  return pts;
}

/**
 * The two faces at every segment of a chain, with the one they all share — the
 * flat face the chain runs round — as face 1. Throws if they share none.
 */
export function chainFrames(mesh, points, closed) {
  const pts = chainCorners(points, closed);
  const byEdge = edgeTriangles(mesh);
  const n = closed ? pts.length : pts.length - 1;
  const segs = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const tris = byEdge.get(pairKey(a, b)) || [];
    if (tris.length !== 2) throw new Error('that edge is no longer on the part');
    const d = unit(sub(b, a));
    const faces = tris.map((tri) => {
      const w = sub(centroid(tri), a);
      return { n: normalOf(tri), t: unit(sub(w, scale(d, dot(w, d)))) };
    });
    segs.push({ a, b, d, faces });
  }
  // The shared face: one of the first segment's two that every segment has.
  const N = segs[0].faces.map((f) => f.n)
    .find((cand) => segs.every((sg) => sg.faces.some((f) => dot(f.n, cand) > 0.999)));
  if (!N) throw new Error('that run of edges does not go round one flat face');
  return {
    N,
    closed,
    segs: segs.map(({ a, b, d, faces }) => {
      const [f1, f2] = dot(faces[0].n, N) > 0.999 ? faces : [faces[1], faces[0]];
      return { a, b, d, n1: f1.n, n2: f2.n, t1: f1.t, t2: f2.t };
    }),
  };
}

/** The sharpest turn a chain may take at a joint and still be one edge. */
const MAX_JOINT_TURN = (30 * Math.PI) / 180;

/** Angle between two segment directions. */
const turnOf = (d0, d1) => Math.acos(Math.max(-1, Math.min(1, dot(d0, d1))));

/**
 * The run of edges a chain reference names on this part: the one under its seed,
 * or — when the part changed and moved it — the nearest run round a face facing
 * the same way, open or closed as it was.
 */
function findChain(welded, ref) {
  const chains = detectSharpEdges(welded);
  const framesOf = (chain) => {
    try {
      return chainFrames(welded, chain.points, chain.closed);
    } catch {
      return null;
    }
  };
  const under = edgeAtPoint(chains, ref.seed, 0.5);
  if (under) {
    const f = framesOf(under);
    if (f && (!ref.n || dot(f.N, ref.n) > 0.999)) return f;
  }
  const near = chains
    .filter((c) => !!c.closed === !!ref.closed)
    .map((c) => ({ c, d: distanceSqToEdge(c, ref.seed) }))
    .sort((x, y) => x.d - y.d);
  for (const { c } of near) {
    const f = framesOf(c);
    if (f && ref.n && dot(f.N, ref.n) > 0.999) return f;
  }
  throw new Error('that run of edges is no longer on the part');
}

/**
 * Tool pieces for a chain. A run that goes from an outside corner to an inside
 * one (a boss whose rounded outline meets a pocket's) is split where it changes:
 * the outside stretches are cut, the inside ones filled.
 *
 * @returns {{solids:object[], merge:'cut'|'add'}[]}
 */
function chainTools(soup, ref, kind, size, sizeEnd = null) {
  const welded = weld(soup);
  const { N, segs, closed } = findChain(welded, ref);
  const big = sizeEnd != null ? Math.max(size, sizeEnd) : size;

  const sections = segs.map((sg) => {
    const u = N;
    const v = cross(sg.d, u);
    const to2 = (w) => [dot(w, u), dot(w, v)];
    const at = (r) => treatmentSection({
      P: [0, 0], n1: to2(sg.n1), n2: to2(sg.n2), t1: to2(sg.t1), t2: to2(sg.t2),
    }, kind, r, Infinity, sizeEnd != null ? ARC_STEPS_VARIABLE : null);
    const sec = { ...at(big), at };
    let reach = 0;
    for (let i = 0; i < sec.loop.length; i += 2) reach = Math.max(reach, Math.hypot(sec.loop[i], sec.loop[i + 1]));
    return { ...sec, u, v, reach };
  });

  // Each segment's piece runs on past its joints far enough to close the gap the
  // turn opens between it and the next: reach·tan(turn/2). Where the gap is on
  // the outside of the turn that is air; on the inside the overlap is a little
  // deeper than a true rolling sweep, by (1 − cos(turn/2)) — a few thousandths at
  // the five-degree turns of a faceted fillet.
  const n = segs.length;
  const pastJoint = (i) => {
    const j = (i + 1) % n;
    const turn = turnOf(segs[i].d, segs[j].d);
    if (turn > MAX_JOINT_TURN) throw new Error('that run of edges has a sharp corner in it — pick the straight edges either side');
    return Math.max(sections[i].reach, sections[j].reach) * Math.tan(turn / 2) + 1e-3;
  };
  // Where the run changes from cut to fill the two sides must not reach into each
  // other: they meet with only a hair of overlap.
  const after = segs.map((_, i) => {
    if (!closed && i === n - 1) return PAST_END;
    if (sections[i].convex !== sections[(i + 1) % n].convex) return 1e-3;
    return pastJoint(i);
  });
  const before = segs.map((_, i) => (!closed && i === 0 ? PAST_END : after[(i + n - 1) % n]));

  // A variable size runs along the chain: from `size` at its start to `sizeEnd`
  // at its end, or — round a closed chain, which has neither — from `size` at
  // its first corner to `sizeEnd` half-way round and back (`varying`).
  const lens = segs.map((sg) => len(sub(sg.b, sg.a)));
  const total = lens.reduce((s, l) => s + l, 0);
  const startAt = [];
  lens.reduce((s, l, i) => { startAt[i] = s; return s + l; }, 0);
  const sizeAt = (s) => varying(size, sizeEnd, s / total, closed);
  const groups = { cut: [], add: [] };
  segs.forEach((sg, i) => {
    const {
      loop, u, v, convex,
    } = sections[i];
    const pa = sub(sg.a, scale(sg.d, before[i]));
    if (sizeEnd != null && sizeEnd !== size) {
      // Sections no further apart than a 64th of the run, so the size follows
      // its curve rather than a straight line across a long edge.
      const from = -before[i];
      const to = lens[i] + after[i];
      const k = Math.max(1, Math.ceil((to - from) / (total / 64)));
      const loops = [];
      const at = [];
      for (let q = 0; q <= k; q++) {
        const t = from + ((to - from) * q) / k;
        const r = sizeAt(startAt[i] + t);
        if (!(r > 0)) throw new Error('a variable fillet needs both sizes greater than zero');
        loops.push(sections[i].at(r).loop);
        at.push(add(sg.a, scale(sg.d, t)));
      }
      groups[convex ? 'cut' : 'add'].push(stationTool(loops, at, u, v));
      return;
    }
    groups[convex ? 'cut' : 'add'].push(extrudeRegion({ outer: loop }, {
      plane: { origin: pa, u, v },
      depth: lens[i] + before[i] + after[i],
    }));
  });
  return Object.entries(groups)
    .filter(([, solids]) => solids.length)
    .map(([merge, solids]) => ({ solids, merge }));
}

// ---------------------------------------------------------------------------
// Round edges

const AXIS_VEC = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * A rim's frame: its axis `k` and two directions `e1`, `e2` across it. A rim
 * about X, Y or Z keeps the other two axes in order (what the faceting phase is
 * measured from); one about a tilted axis — a bore drilled square to an angled
 * face — carries its axis as `n`.
 */
function circleBasis(ref) {
  if (Array.isArray(ref.n)) {
    const k = unit(ref.n);
    const helper = Math.abs(k[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = unit(cross(k, helper));
    return { k, e1, e2: cross(k, e1) };
  }
  const [iu, iv] = [0, 1, 2].filter((i) => i !== ref.axis);
  return { k: AXIS_VEC[ref.axis], e1: AXIS_VEC[iu], e2: AXIS_VEC[iv] };
}

/**
 * The faces at a circular rim: the flat one square to the axis and the round
 * wall, read off the triangles that touch the rim. Also the rim's own facets —
 * count and phase — so the tool can be faceted to match.
 */
export function circleEdgeFrame(soup, ref) {
  const { center, radius: R } = ref;
  const { k, e1, e2 } = circleBasis(ref);
  const tol = Math.max(ON, R * 2e-3);
  const axial = (p) => dot(sub(p, center), k);
  const across = (p) => { const w = sub(p, center); return sub(w, scale(k, dot(w, k))); };
  const radial = (p) => len(across(p));
  const onRim = (p) => Math.abs(axial(p)) < tol && Math.abs(radial(p) - R) < tol;

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
      const rdir = unit(across(c));
      wall = wall || { nr: Math.sign(dot(n, rdir)), tz: Math.sign(axial(c)) };
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
    const w = across(p);
    const a = Math.atan2(dot(w, e2), dot(w, e1));
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
    e1,
    e2,
    n1: [0, flat.nk],
    t1: [flat.tr, 0],
    n2: [wall.nr, 0],
    t2: [0, wall.tz],
    radius: even ? rCorner : R,
    segments: even ? angles.length : null,
    phase: even ? angles[0] : 0,
  };
}


/**
 * Where a rim went when the part changed under it: the nearest round closed edge
 * of the same size about the same axis. Null if there is none.
 */
function relocateCircle(soup, ref) {
  const { k } = circleBasis(ref);
  let best = null;
  for (const chain of detectSharpEdges(weld(soup))) {
    if (!chain.closed) continue;
    const c = roundChain(chain);
    if (!c || Math.abs(Math.abs(dot(circleBasis(c).k, k)) - 1) > 1e-3) continue;
    if (Math.abs(c.radius - ref.radius) > Math.max(0.02, ref.radius * 0.01)) continue;
    const d = len(sub(c.center, ref.center));
    if (!best || d < best.d) best = { c, d };
  }
  return best ? best.c : null;
}

function circleTool(soup, ref, kind, size, sizeEnd = null) {
  let f;
  try {
    f = circleEdgeFrame(soup, ref);
  } catch (e) {
    const moved = relocateCircle(soup, ref);
    if (!moved) throw e;
    // eslint-disable-next-line no-param-reassign
    ref = moved;
    f = circleEdgeFrame(soup, ref);
  }
  const R = f.radius;
  const { loop, convex } = treatmentSection({
    P: [R, 0], n1: f.n1, n2: f.n2, t1: f.t1, t2: f.t2,
  }, kind, size, R * 0.5);
  for (let i = 0; i < loop.length; i += 2) {
    if (loop[i] <= 0) throw new Error(`a ${size} mm ${kind} does not fit a Ø${(2 * R).toFixed(2)} rim`);
  }
  const u = add(scale(f.e1, Math.cos(f.phase)), scale(f.e2, Math.sin(f.phase)));
  if (sizeEnd != null && sizeEnd !== size) {
    // Variable round the rim: the section is worked out afresh at every step,
    // sized by `varying`, and the steps joined into one ring.
    const steps = f.segments ?? 96;
    const sec = (r) => treatmentSection({
      P: [R, 0], n1: f.n1, n2: f.n2, t1: f.t1, t2: f.t2,
    }, kind, r, R * 0.5, ARC_STEPS_VARIABLE).loop;
    const w = cross(f.k, u);
    const rings = [];
    for (let k = 0; k < steps; k++) {
      const th = (2 * Math.PI * k) / steps;
      const r = varying(size, sizeEnd, k / steps, true);
      if (!(r > 0)) throw new Error('a variable fillet needs both sizes greater than zero');
      const l = sec(r);
      for (let i = 0; i < l.length; i += 2) {
        if (l[i] <= 0) throw new Error(`a ${Math.max(size, sizeEnd)} mm ${kind} does not fit a Ø${(2 * R).toFixed(2)} rim`);
      }
      const dir = add(scale(u, Math.cos(th)), scale(w, Math.sin(th)));
      const ring = [];
      for (let i = 0; i < l.length; i += 2) ring.push(add(add(ref.center, scale(dir, l[i])), scale(f.k, l[i + 1])));
      rings.push(ring);
    }
    return { solid: ringSolid(rings), merge: convex ? 'cut' : 'add' };
  }
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
  const out = [];
  const lines = [];
  const variable = feature.kind === 'fillet' && feature.sizeEnd != null && feature.sizeEnd !== feature.size;
  const end = variable ? feature.sizeEnd : null;
  for (const ref of feature.edges) {
    if (ref.type === 'chain') { out.push(...chainTools(soup, ref, feature.kind, feature.size, end)); continue; }
    if (ref.type === 'circle') {
      const { solid, merge } = circleTool(soup, ref, feature.kind, feature.size, end);
      out.push({ solids: [solid], merge });
      continue;
    }
    const { solid, merge, frame } = lineTool(soup, ref, feature.kind, feature.size, variable ? feature.sizeEnd : null);
    out.push({ solids: [solid], merge });
    lines.push(frame);
  }
  if (feature.kind === 'fillet' && !variable) out.push(...ballCorners(lines, feature.size));
  return out;
}

/** Points closer than this (mm) are one corner. */
const CORNER_TOL = 1e-3;

/** Solve the 3×3 system with rows `m` (each [x,y,z]) for right-hand side `r`. */
function solve3(m, r) {
  const det = dot(m[0], cross(m[1], m[2]));
  if (Math.abs(det) < 1e-12) return null;
  const c0 = cross(m[1], m[2]); const c1 = cross(m[2], m[0]); const c2 = cross(m[0], m[1]);
  return [0, 1, 2].map((k) => (r[0] * c0[k] + r[1] * c1[k] + r[2] * c2[k]) / det);
}

/** A convex six-sided block from its eight corners, `v[i*4 + j*2 + k]` for the three pairs of opposite sides. */
function hexBlock(v) {
  const mid = scale(v.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / 8);
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const tris = [];
  for (const q of quads) {
    for (const t of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
      const [A, B, C] = t.map((i) => v[i]);
      const n = cross(sub(B, A), sub(C, A));
      tris.push(dot(n, sub(A, mid)) < 0 ? [A, C, B] : [A, B, C]);
    }
  }
  const positions = new Float32Array(tris.length * 9);
  tris.forEach((t, q) => t.forEach((p, m) => positions.set(p, q * 9 + m * 3)));
  return { positions, triangleCount: tris.length, format: 'extrude' };
}

/**
 * Where three filleted straight edges meet at an outside corner, the three
 * round faces are joined by a ball, as a rolling ball would leave it. The ball
 * sits a radius in from all three faces; it meets each edge's round face along
 * the circle in the plane through its centre square to that edge. So the
 * material cut is the corner block — bounded by the three faces and those
 * three planes — less the ball. Any angles, not only a block's square corner.
 * Corners where the edges do not all run outward from one point keep the
 * edges' own meeting.
 *
 * @returns {{corner:{cube:object, ball:object}}[]}
 */
function ballCorners(frames, r) {
  const ends = [];
  for (const f of frames) {
    if (!f.convex) continue;
    ends.push({ p: f.a, e: unit(sub(f.b, f.a)) });
    ends.push({ p: f.b, e: unit(sub(f.a, f.b)) });
  }
  const used = new Set();
  const out = [];
  for (let i = 0; i < ends.length; i++) {
    if (used.has(i)) continue;
    const at = [i];
    for (let j = i + 1; j < ends.length; j++) {
      if (!used.has(j) && len(sub(ends[j].p, ends[i].p)) < CORNER_TOL) at.push(j);
    }
    if (at.length !== 3) continue;
    const [a, b, c] = at.map((k) => ends[k].e);
    // The three faces, each holding two of the edges, normals pointing out
    // (away from the third edge).
    const face = (u, w, away) => {
      const n = unit(cross(u, w));
      return dot(n, away) > 0 ? scale(n, -1) : n;
    };
    const nAB = face(a, b, c); const nAC = face(a, c, b); const nBC = face(b, c, a);
    if (Math.abs(dot(a, cross(b, c))) < 0.05) continue; // the edges nearly in one plane
    const P = ends[i].p;
    // Ball centre: a radius in from all three faces.
    const off = solve3([nAB, nAC, nBC], [-r, -r, -r]);
    if (!off) continue;
    const C = add(P, off);
    // It must lie between the edges, ahead of the corner along each.
    if (dot(off, a) <= 0 || dot(off, b) <= 0 || dot(off, c) <= 0) continue;
    at.forEach((k) => used.add(k));
    const eps = Math.min(0.05, r * 0.1);
    // Planes as [n, d] with n·X ≤ d inside. Each pair: the face away from an
    // edge's direction, and the plane square to that edge through the centre.
    const pairs = [
      [[nBC, dot(nBC, P) + eps], [a, dot(a, C)]],
      [[nAC, dot(nAC, P) + eps], [b, dot(b, C)]],
      [[nAB, dot(nAB, P) + eps], [c, dot(c, C)]],
    ];
    const v = [];
    let ok = true;
    for (let x = 0; x < 2 && ok; x++) {
      for (let y = 0; y < 2 && ok; y++) {
        for (let z = 0; z < 2 && ok; z++) {
          const [p0, p1, p2] = [pairs[0][x], pairs[1][y], pairs[2][z]];
          const q = solve3([p0[0], p1[0], p2[0]], [p0[1], p1[1], p2[1]]);
          if (!q) ok = false; else v[x * 4 + y * 2 + z] = q;
        }
      }
    }
    if (!ok) continue;
    const cube = hexBlock(v);
    // The ball: a half disc turned about an axis through its centre.
    const half = [];
    const steps = 24;
    for (let k = 0; k <= steps; k++) {
      const t = -Math.PI / 2 + (Math.PI * k) / steps;
      half.push(r * Math.cos(t), r * Math.sin(t));
    }
    const ball = revolveRegion({ outer: half }, {
      axis: 'y', plane: { origin: C, u: a, v: unit(cross(a, b)) }, segments: 48,
    });
    out.push({ corner: { cube, ball } });
  }
  return out;
}

/**
 * Apply a Chamfer or Fillet feature to a part. `meshBoolean` as the tree has it;
 * when it offers `many` (manifold does), an edge's pieces are joined and applied
 * in one pass, so a chain of a hundred segments is one boolean with the part.
 */
export function applyEdgeTreatment(soup, feature, meshBoolean) {
  if (!meshBoolean) throw new Error('no solid boolean is available to cut the part with');
  let out = soup;
  for (const entry of edgeTreatmentTools(soup, feature)) {
    if (entry.corner) {
      const shell = meshBoolean(entry.corner.cube, entry.corner.ball, 'cut', feature.kind);
      out = meshBoolean(out, shell, 'cut', feature.kind);
      continue;
    }
    const { solids, merge } = entry;
    const once = solids.length > 1 ? meshBoolean.many?.(out, solids, merge, feature.kind) : null;
    if (once) { out = once; continue; }
    for (const tool of solids) out = meshBoolean(out, tool, merge, feature.kind);
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
  if (raw?.type === 'chain' && vec(raw.seed) && vec(raw.n)) {
    const ref = {
      type: 'chain', seed: [...raw.seed], n: [...raw.n], length: Number(raw.length) || 0, closed: !!raw.closed,
    };
    if (Array.isArray(raw.points) && raw.points.every(vec)) ref.points = raw.points.map((q) => [...q]);
    return ref;
  }
  if (raw?.type === 'circle' && vec(raw.center) && raw.radius > 0
    && ([0, 1, 2].includes(raw.axis) || vec(raw.n))) {
    const ref = {
      type: 'circle', axis: [0, 1, 2].includes(raw.axis) ? raw.axis : -1, center: [...raw.center], radius: raw.radius,
    };
    if (vec(raw.n)) ref.n = [...raw.n];
    return ref;
  }
  return null;
}

/** Same edge? Used to toggle a pick off again. */
export function sameEdge(a, b) {
  const near = (p, q) => len(sub(p, q)) < 0.01;
  if (a?.type !== b?.type) return false;
  if (a.type === 'circle') {
    return Math.abs(Math.abs(dot(circleBasis(a).k, circleBasis(b).k)) - 1) < 1e-6
      && near(a.center, b.center) && Math.abs(a.radius - b.radius) < 0.01;
  }
  if (a.type === 'chain') {
    // Two clicks on one run of edges: same length, and each seed on the other's run.
    const on = (pts, q) => pts?.some((p, i) => i > 0 && len(sub(q, nearestOnSegment(pts[i - 1], p, q))) < 0.05);
    return Math.abs(a.length - b.length) < 0.05 && (on(a.points, b.seed) || on(b.points, a.seed));
  }
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
    const circle = roundChain(chain);
    if (circle) return circle;
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
  // The run is not the whole chain: it carries on round arcs or bends, as the top
  // edge of a part with filleted corners does — take all of it, as SolidWorks'
  // tangent propagation would.
  if (chain.closed || first > 0 || last + 2 < pts.length) {
    try {
      const { N, segs } = chainFrames(welded, pts, chain.closed);
      const joints = chain.closed ? segs.length : segs.length - 1;
      for (let i = 0; i < joints; i++) {
        if (turnOf(segs[i].d, segs[(i + 1) % segs.length].d) > MAX_JOINT_TURN) throw new Error('sharp corner');
      }
      return {
        type: 'chain',
        seed: nearestOnSegment(pts[best], pts[best + 1], point),
        n: N,
        length: chain.length,
        closed: chain.closed,
        points: pts.map((q) => [...q]),
      };
    } catch {
      // Not round one flat face: fall back to the straight run under the click.
    }
  }
  // The two faces from the run's own first segment — looked up, not searched for:
  // this runs on every pointer move over the part.
  const tris = edgeTriangles(welded).get(pairKey(pts[first], pts[first + 1])) || [];
  if (tris.length !== 2) return null;
  const [n1, n2] = tris.map(normalOf);
  if (dot(n1, n2) > 0.985) return null;
  return {
    type: 'line', a: [...pts[first]], b: [...pts[last + 1]], n1, n2,
  };
}

function nearestOnSegment(a, b, q) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(q, a), ab) / (dot(ab, ab) || 1)));
  return add(a, scale(ab, t));
}

/**
 * A closed chain read as a circle — about X, Y or Z, or about whatever axis its
 * plane faces (a rim on an angled face) — or null when it is not round and flat.
 */
export function roundChain(chain) {
  const pts = chain.points;
  if (!chain.closed || pts.length < 8) return null;
  const { min, max } = chain.bounds;
  const axis = [0, 1, 2].find((i) => max[i] - min[i] < 1e-3);
  if (axis != null) {
    const [iu, iv] = [0, 1, 2].filter((i) => i !== axis);
    const circle = fitCircle(pts.flatMap((p) => [p[iu], p[iv]]));
    if (!circle) return null;
    const center = [0, 0, 0];
    center[axis] = (min[axis] + max[axis]) / 2;
    [center[iu], center[iv]] = circle.center;
    return {
      type: 'circle', axis, center, radius: circle.radius,
    };
  }
  // Tilted: the plane of the loop from its area vector (Newell), then the fit in it.
  const nrm = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    nrm[0] += (a[1] - b[1]) * (a[2] + b[2]);
    nrm[1] += (a[2] - b[2]) * (a[0] + b[0]);
    nrm[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  if (!(len(nrm) > 1e-9)) return null;
  const k = unit(nrm);
  const o = pts[0];
  if (pts.some((q) => Math.abs(dot(sub(q, o), k)) > 1e-3)) return null;
  const { e1, e2 } = circleBasis({ n: k });
  const circle = fitCircle(pts.flatMap((q) => { const w = sub(q, o); return [dot(w, e1), dot(w, e2)]; }));
  if (!circle) return null;
  const center = add(o, add(scale(e1, circle.center[0]), scale(e2, circle.center[1])));
  return {
    type: 'circle', axis: -1, n: k, center, radius: circle.radius,
  };
}

/** A short label for a picked edge. */
export function describeEdgeRef(ref) {
  if (ref.type === 'circle') return `Rim Ø${(2 * ref.radius).toFixed(2)}`;
  if (ref.type === 'chain') return `Edge chain ${ref.length.toFixed(1)} mm`;
  return `Edge ${len(sub(ref.b, ref.a)).toFixed(1)} mm`;
}
