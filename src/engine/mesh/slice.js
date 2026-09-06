/**
 * Plane sectioning — cutting a mesh with a plane and chaining the result into
 * closed loops.
 *
 * This is the one geometric primitive the whole CAM side stands on, and it
 * serves both machines from the same code:
 *
 * - **Milling** sections perpendicular to the tool axis, at descending heights.
 *   Each Z gives the polygons a Z-level roughing pass has to clear.
 * - **Turning** sections *through* the spindle axis. Because the part is a solid
 *   of revolution, that one cut is the entire turned profile — bores, grooves
 *   and all.
 *
 * Writing it once means a bug shows up in both, which is the point: the loops
 * are what every later stage trusts.
 *
 * Pure functions over typed arrays. No three.js, no store, no DOM.
 */

/** Iterate triangles as corner offsets into `positions`, soup or indexed. */
function eachTriangle(mesh, fn) {
  const p = mesh.positions;
  if (mesh.indices) {
    for (let t = 0; t < mesh.indices.length; t += 3) {
      fn(mesh.indices[t] * 3, mesh.indices[t + 1] * 3, mesh.indices[t + 2] * 3, p);
    }
  } else {
    for (let t = 0; t < mesh.triangleCount; t++) {
      fn(t * 9, t * 9 + 3, t * 9 + 6, p);
    }
  }
}

/**
 * How many bins a triangle may span before it is parked in the overflow list
 * instead of being written into every one of them. A tall side wall spans the
 * whole part, and registering it per bin is what turns the index's memory from
 * O(triangles) into O(triangles × bins).
 */
const MAX_SPAN_BINS = 8;

/**
 * Triangles bucketed by the range they occupy along one axis, so sectioning a
 * plane only visits the triangles that can actually straddle it.
 *
 * `slicePlane` is called in **batches**, not once: contour finishing sections
 * every Z level down the wall, and hole probing sections up to forty times per
 * hole. Scanning all 15 000 triangles for each of those made the cost of a plan
 * O(levels × triangles) when the geometry only ever changes once — that was
 * ~62 ms of the ~70 ms every settings change spent rebuilding the program.
 *
 * Triangles are emitted in **ascending triangle order**, exactly as a full scan
 * would, because the order segments arrive in decides where `chainSegments`
 * starts each loop, and that in turn decides where the cutter enters it. A
 * faster slice that silently moved the entry point would be a different
 * toolpath, not an optimisation.
 *
 * Pure: derived entirely from the mesh, and memoised per (mesh, axis) by
 * `sliceIndexFor`, which is sound only because meshes here are immutable —
 * every transform (`weld`, `rotateAboutX`, `applyDatum`) returns new arrays
 * rather than writing through an existing one.
 */
export function sliceIndex(mesh, axis) {
  const p = mesh.positions;
  const count = mesh.indices ? mesh.indices.length / 3 : (mesh.triangleCount ?? 0);

  // Corner offsets resolved once, so the hot loop never branches on soup vs
  // indexed.
  const corners = new Int32Array(count * 3);
  if (mesh.indices) {
    for (let t = 0; t < count; t++) {
      corners[t * 3] = mesh.indices[t * 3] * 3;
      corners[t * 3 + 1] = mesh.indices[t * 3 + 1] * 3;
      corners[t * 3 + 2] = mesh.indices[t * 3 + 2] * 3;
    }
  } else {
    for (let t = 0; t < count; t++) {
      corners[t * 3] = t * 9;
      corners[t * 3 + 1] = t * 9 + 3;
      corners[t * 3 + 2] = t * 9 + 6;
    }
  }

  const lo = new Float64Array(count);
  const hi = new Float64Array(count);
  let gMin = Infinity;
  let gMax = -Infinity;
  for (let t = 0; t < count; t++) {
    const a = p[corners[t * 3] + axis];
    const b = p[corners[t * 3 + 1] + axis];
    const c = p[corners[t * 3 + 2] + axis];
    const mn = a < b ? (a < c ? a : c) : (b < c ? b : c);
    const mx = a > b ? (a > c ? a : c) : (b > c ? b : c);
    lo[t] = mn; hi[t] = mx;
    if (mn < gMin) gMin = mn;
    if (mx > gMax) gMax = mx;
  }

  const span = gMax - gMin;
  // Roughly √n bins keeps both the per-bin list and the bin count small; a mesh
  // with no extent along this axis degenerates to a single bin, which is the
  // full scan and still correct.
  const bins = (count > 0 && span > 0)
    ? Math.max(1, Math.min(2048, Math.round(Math.sqrt(count))))
    : 1;
  const invBin = bins > 0 && span > 0 ? bins / span : 0;
  // One bin either side of the triangle's true range, so a value landing exactly
  // on a bin boundary can never be missed to a rounding error.
  const binOf = (v) => {
    const b = Math.floor((v - gMin) * invBin);
    return b < 0 ? 0 : (b >= bins ? bins - 1 : b);
  };
  const first = new Int32Array(count);
  const last = new Int32Array(count);
  const overflow = [];
  const counts = new Int32Array(bins + 1);
  for (let t = 0; t < count; t++) {
    const b0 = Math.max(0, binOf(lo[t]) - 1);
    const b1 = Math.min(bins - 1, binOf(hi[t]) + 1);
    if (b1 - b0 + 1 > MAX_SPAN_BINS) {
      first[t] = -1;
      overflow.push(t);
      continue;
    }
    first[t] = b0; last[t] = b1;
    for (let b = b0; b <= b1; b++) counts[b]++;
  }

  // CSR: prefix-sum the per-bin counts, then fill in ascending triangle order so
  // each bin's list comes out sorted for free.
  const start = new Int32Array(bins + 1);
  for (let b = 0; b < bins; b++) start[b + 1] = start[b] + counts[b];
  const fill = start.slice(0, bins);
  const tris = new Int32Array(start[bins]);
  for (let t = 0; t < count; t++) {
    if (first[t] < 0) continue;
    for (let b = first[t]; b <= last[t]; b++) tris[fill[b]++] = t;
  }

  return {
    corners, count, bins, gMin, invBin, start, tris,
    overflow: Int32Array.from(overflow),
  };
}

/**
 * Visit the triangles that may straddle `coord`, in ascending triangle order.
 *
 * The bin list and the overflow list are each sorted, so they are merged rather
 * than concatenated — concatenating would reorder the segments and move every
 * loop's start point.
 */
function eachCandidate(index, coord, fn) {
  const { corners, bins, gMin, invBin, start, tris, overflow } = index;
  let b = Math.floor((coord - gMin) * invBin);
  if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
  let i = start[b];
  const iEnd = start[b + 1];
  let j = 0;
  const emit = (t) => fn(corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]);
  while (i < iEnd && j < overflow.length) {
    const ti = tris[i];
    const tj = overflow[j];
    if (ti < tj) { emit(ti); i++; } else { emit(tj); j++; }
  }
  while (i < iEnd) emit(tris[i++]);
  while (j < overflow.length) emit(overflow[j++]);
}

/**
 * The index for this mesh and axis, built on first use and kept.
 *
 * Keyed weakly on the mesh object, so an index dies with the mesh it describes
 * and a re-imported or re-oriented part never sees a stale one.
 */
const _sliceIndexCache = new WeakMap();
export function sliceIndexFor(mesh, axis) {
  let perAxis = _sliceIndexCache.get(mesh);
  if (!perAxis) _sliceIndexCache.set(mesh, perAxis = [null, null, null]);
  if (!perAxis[axis]) perAxis[axis] = sliceIndex(mesh, axis);
  return perAxis[axis];
}

/**
 * Intersect a mesh with the plane `axis = coord`.
 *
 * Returns flat segments `[u0, v0, u1, v1, ...]` in the two axes the plane spans,
 * in ascending axis order (a Z-plane yields X,Y; a Y-plane yields X,Z).
 *
 * Two degeneracies matter and are both handled by nudging rather than by special
 * cases. A vertex sitting *exactly* on the plane makes the crossing test
 * ambiguous — the triangle may register zero, one, or three crossings depending
 * on rounding — so distances within `eps` are pushed just off the plane. That
 * turns "a corner touches the plane" into "the corner is a hair above it",
 * which produces the same loops without any branching. Triangles lying flat in
 * the plane contribute nothing and are dropped: their edges are already carried
 * by the neighbouring triangles that cross it.
 *
 * Segment endpoints are emitted in the triangle's own winding order, so loops
 * chained from them inherit a consistent orientation from the mesh's normals.
 *
 * @param {{positions:Float32Array, indices?:Uint32Array, triangleCount?:number}} mesh
 * @param {0|1|2} axis   the axis the plane is perpendicular to
 * @param {number} coord where along that axis the plane sits
 * @returns {Float64Array} 4 numbers per segment
 */
export function slicePlane(mesh, axis, coord, eps = 1e-7) {
  const [u, v] = [0, 1, 2].filter((k) => k !== axis);
  const out = [];
  const p = mesh.positions;

  // Below this the index costs more to build than the scan it saves, and a
  // fixture-sized mesh is sliced once rather than in a batch.
  const INDEX_MIN_TRIANGLES = 512;
  const count = mesh.indices ? mesh.indices.length / 3 : (mesh.triangleCount ?? 0);
  const visit = count >= INDEX_MIN_TRIANGLES
    ? (fn) => eachCandidate(sliceIndexFor(mesh, axis), coord, fn)
    : (fn) => eachTriangle(mesh, fn);

  visit((a, b, c) => {
    const o = [a, b, c];
    const d = o.map((i) => {
      const dist = p[i + axis] - coord;
      // Nudge on-plane vertices off it so the crossing count is never ambiguous.
      return Math.abs(dist) < eps ? eps : dist;
    });
    // All on one side: no intersection.
    if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) return;

    const hits = [];
    for (let e = 0; e < 3; e++) {
      const i = o[e], j = o[(e + 1) % 3];
      const di = d[e], dj = d[(e + 1) % 3];
      if ((di > 0) === (dj > 0)) continue; // edge does not cross
      const t = di / (di - dj);
      hits.push(p[i + u] + (p[j + u] - p[i + u]) * t, p[i + v] + (p[j + v] - p[i + v]) * t);
    }
    // A clean crossing produces exactly two points; anything else is degenerate.
    if (hits.length === 4) out.push(hits[0], hits[1], hits[2], hits[3]);
  });

  return Float64Array.from(out);
}

/** Signed area of a loop given as [x0,y0,x1,y1,...]; positive is counter-clockwise. */
export function loopArea(loop) {
  let a = 0;
  const n = loop.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += loop[i * 2] * loop[j * 2 + 1] - loop[j * 2] * loop[i * 2 + 1];
  }
  return a / 2;
}

/** Total length of a loop or open polyline. */
export function loopLength(pts, closed = true) {
  let len = 0;
  const n = pts.length / 2;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n;
    len += Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
  }
  return len;
}

/**
 * Chain loose segments into polylines by joining endpoints that coincide.
 *
 * Segments come out of `slicePlane` in triangle order, which is effectively
 * random, so they have to be stitched. Endpoints are hashed onto a grid of
 * `tol` and probed across neighbouring cells, the same trick `weld` uses — a
 * plain exact-match lookup would strand segments whose shared point differs in
 * the last float bit.
 *
 * A chain that returns to its start is closed and reported as a loop. An open
 * chain means the mesh had a hole along this plane; those are still returned,
 * flagged, rather than dropped, because a half-open profile is far more useful
 * to show an operator than silence.
 *
 * @returns {{closed: number[][], open: number[][]}} each entry is [x0,y0,x1,y1,...]
 */
export function chainSegments(segments, tol = 1e-4) {
  const count = segments.length / 4;
  if (count === 0) return { closed: [], open: [] };

  const inv = 1 / tol;
  // Grid cells are held as a Map of column -> Map of row -> endpoints, rather
  // than one Map keyed on `"gx,gy"`. Same cells, same probe order, but the
  // 3×3 neighbourhood scan no longer builds nine strings per endpoint — that
  // string churn, not the geometry, was most of the cost of chaining a slice,
  // and a contour pass chains one per Z level.
  const buckets = new Map();
  /** endpoints: for each segment end, the list of (segment, end) sharing a point */
  const add = (x, y, ref) => {
    const gx = Math.round(x * inv);
    const gy = Math.round(y * inv);
    for (let di = -1; di <= 1; di++) {
      const col = buckets.get(gx + di);
      if (!col) continue;
      for (let dj = -1; dj <= 1; dj++) {
        const b = col.get(gy + dj);
        if (!b) continue;
        for (const r of b) {
          if (Math.abs(r.x - x) <= tol && Math.abs(r.y - y) <= tol) { r.refs.push(ref); return r; }
        }
      }
    }
    const rec = { x, y, refs: [ref] };
    let col = buckets.get(gx);
    if (!col) buckets.set(gx, col = new Map());
    let b = col.get(gy);
    if (!b) col.set(gy, b = []);
    b.push(rec);
    return rec;
  };

  // Node per segment end, so walking is a lookup rather than a search.
  const startNode = new Array(count);
  const endNode = new Array(count);
  for (let s = 0; s < count; s++) {
    startNode[s] = add(segments[s * 4], segments[s * 4 + 1], { s, end: 0 });
    endNode[s] = add(segments[s * 4 + 2], segments[s * 4 + 3], { s, end: 1 });
  }

  const used = new Uint8Array(count);
  const closed = [];
  const open = [];

  /** The unused segment attached to `node`, other than `from`. */
  const nextFrom = (node, from) => {
    for (const r of node.refs) {
      if (r.s !== from && !used[r.s]) return r;
    }
    return null;
  };

  for (let s0 = 0; s0 < count; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const pts = [segments[s0 * 4], segments[s0 * 4 + 1], segments[s0 * 4 + 2], segments[s0 * 4 + 3]];

    // Walk forward from the segment's end.
    let node = endNode[s0];
    let prev = s0;
    for (;;) {
      const ref = nextFrom(node, prev);
      if (!ref) break;
      used[ref.s] = 1;
      // Enter the segment at `ref.end`, so we leave by the other end.
      const far = ref.end === 0 ? 1 : 0;
      pts.push(segments[ref.s * 4 + far * 2], segments[ref.s * 4 + far * 2 + 1]);
      node = far === 1 ? endNode[ref.s] : startNode[ref.s];
      prev = ref.s;
      if (node === startNode[s0]) break; // closed the loop
    }

    if (node === startNode[s0]) {
      pts.length -= 2; // drop the duplicated closing point
      closed.push(pts);
      continue;
    }

    // Not closed going forward — extend backwards from the start too.
    node = startNode[s0];
    prev = s0;
    for (;;) {
      const ref = nextFrom(node, prev);
      if (!ref) break;
      used[ref.s] = 1;
      const far = ref.end === 0 ? 1 : 0;
      pts.unshift(segments[ref.s * 4 + far * 2], segments[ref.s * 4 + far * 2 + 1]);
      node = far === 1 ? endNode[ref.s] : startNode[ref.s];
      prev = ref.s;
    }
    open.push(pts);
  }

  return { closed, open };
}

/** Crossing-number point-in-polygon test against a loop [x0,y0,x1,y1,...]. */
export function pointInLoop(loop, x, y) {
  let inside = false;
  const n = loop.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = loop[i * 2], yi = loop[i * 2 + 1];
    const xj = loop[j * 2], yj = loop[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A point that is **strictly inside** a loop, for containment tests.
 *
 * Nesting used to be tested with the loop's first *vertex*, which is on its own
 * boundary and can therefore be on another loop's boundary too — and a crossing
 * test through a point that lies exactly on the edge it is testing against
 * answers arbitrarily. Two loops that touch at a corner then come back as one
 * nested inside the other, and nesting is what decides solid from hole: a
 * boolean that produced two shapes meeting at a point had one of them silently
 * become a pocket in the other.
 *
 * The point is found the way ear clipping finds one: at a convex vertex whose
 * triangle holds no other vertex, the midpoint of the diagonal across it is
 * interior. Falls back to the first vertex for a degenerate ring, where there is
 * no interior to find.
 */
export function interiorPoint(pts) {
  const n = pts.length / 2;
  if (n < 3) return [pts[0], pts[1]];
  const sign = loopArea(pts) >= 0 ? 1 : -1;
  const at = (i) => { const k = ((i % n) + n) % n; return [pts[k * 2], pts[k * 2 + 1]]; };
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

  for (let i = 0; i < n; i++) {
    const a = at(i - 1);
    const v = at(i);
    const b = at(i + 1);
    if (cross(a, v, b) * sign <= 0) continue; // reflex or flat in this loop's own winding
    let clear = true;
    for (let j = 0; j < n && clear; j++) {
      if (j === ((i - 1) % n + n) % n || j === i || j === (i + 1) % n) continue;
      const p = at(j);
      if (cross(a, v, p) * sign >= 0 && cross(v, b, p) * sign >= 0 && cross(b, a, p) * sign >= 0) {
        clear = false;
      }
    }
    if (clear) return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  return [pts[0], pts[1]];
}

/** Reverse a loop's winding in place-free fashion. */
export function reversed(pts) {
  const out = new Array(pts.length);
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    out[i * 2] = pts[(n - 1 - i) * 2];
    out[i * 2 + 1] = pts[(n - 1 - i) * 2 + 1];
  }
  return out;
}

/**
 * Section a mesh and return closed loops, outers first.
 *
 * Loops are normalised so an **outer boundary runs counter-clockwise** and a
 * **hole runs clockwise** — the convention polygon offsetting needs downstream.
 *
 * Which is which is decided by **nesting, not by the mesh's winding**. Taking it
 * from the triangle normals would be cheaper, but `analyzeMesh` exists precisely
 * because STL files arrive inside-out often enough to warrant a warning, and a
 * pocket silently machined as an island is the worst possible way for that to
 * surface. Counting how many loops enclose each one costs an O(n²) containment
 * test on a handful of loops per slice, and is right regardless of what the
 * exporter did. Nesting also handles the deeper case correctly on its own: an
 * island standing inside a pocket is enclosed twice, so it comes back out as
 * solid.
 *
 * Slivers below `minArea` are dropped: a plane grazing a tangent face throws off
 * tiny degenerate loops that are noise, not geometry.
 */
export function sliceLoops(mesh, axis, coord, opts = {}) {
  const { tol = 1e-4, minArea = 1e-6 } = opts;
  const { closed, open } = chainSegments(slicePlane(mesh, axis, coord), tol);
  return { loops: normalizeLoops(closed, { minArea }), openCount: open.length, open };
}

/**
 * Sort closed loops biggest-first and force the outer-CCW / hole-CW convention
 * on them, deciding which is which by **nesting**.
 *
 * Split out of `sliceLoops` because the sketcher needs exactly the same rule for
 * the loops it chains out of sketch geometry (`engine/sketch/loops.js`), and the
 * convention has to be stated once: everything downstream — Clipper offsetting,
 * extrusion, the CAM planner — reads winding as the difference between solid and
 * hole, so two copies of this that drift produce a pocket machined as an island.
 * The reasoning behind nesting-over-winding is in `sliceLoops` above.
 *
 * `sourceIndex` is the loop's position in the input, so a caller that carries its
 * own metadata per loop (the sketcher tracks which entities formed each one) can
 * map back after the sort and the possible reversal.
 *
 * @param {number[][]} closed  loops as [x0,y0,x1,y1,...], first point not repeated
 */
export function normalizeLoops(closed, { minArea = 1e-6 } = {}) {
  const raw = [];
  for (let i = 0; i < closed.length; i++) {
    const pts = closed[i];
    const signedArea = loopArea(pts);
    if (Math.abs(signedArea) < minArea) continue;
    raw.push({
      pts, area: Math.abs(signedArea), signedArea, sourceIndex: i, probe: interiorPoint(pts),
    });
  }
  // Biggest first, so a containing loop is always tested before what it holds.
  raw.sort((a, b) => b.area - a.area);

  return raw.map((r, i) => {
    let depth = 0;
    for (let j = 0; j < i; j++) {
      if (pointInLoop(raw[j].pts, r.probe[0], r.probe[1])) depth++;
    }
    const isHole = depth % 2 === 1;
    // Force the convention: outer counter-clockwise, hole clockwise.
    const wantPositive = !isHole;
    const points = (r.signedArea > 0) === wantPositive ? r.pts : reversed(r.pts);
    return {
      points, area: r.area, isHole, depth, sourceIndex: r.sourceIndex,
      signedArea: wantPositive ? r.area : -r.area,
    };
  });
}

/**
 * Z-levels for a roughing pass: from just under the top down to the floor, no
 * step deeper than `stepdown`.
 *
 * The levels are spaced evenly rather than taking full steps with a thin
 * remainder at the bottom — an uneven last pass is where a cutter gets loaded
 * up unexpectedly. The floor itself is always included, since that is the
 * surface being made.
 */
export function zLevels(top, bottom, stepdown) {
  if (!(stepdown > 0)) throw new Error('zLevels: stepdown must be positive');
  const depth = top - bottom;
  if (depth <= 0) return [bottom];
  const steps = Math.ceil(depth / stepdown - 1e-9);
  const step = depth / steps;
  const levels = [];
  for (let i = 1; i <= steps; i++) levels.push(top - step * i);
  return levels;
}
