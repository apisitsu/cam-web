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

  eachTriangle(mesh, (a, b, c, p) => {
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
  const buckets = new Map();
  const keyOf = (x, y) => `${Math.round(x * inv)},${Math.round(y * inv)}`;
  /** endpoints: for each segment end, the list of (segment, end) sharing a point */
  const add = (x, y, ref) => {
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const k = `${Math.round(x * inv) + di},${Math.round(y * inv) + dj}`;
        const b = buckets.get(k);
        if (!b) continue;
        for (const r of b) {
          if (Math.abs(r.x - x) <= tol && Math.abs(r.y - y) <= tol) { r.refs.push(ref); return r; }
        }
      }
    }
    const rec = { x, y, refs: [ref] };
    const k = keyOf(x, y);
    let b = buckets.get(k);
    if (!b) buckets.set(k, b = []);
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

/** Reverse a loop's winding in place-free fashion. */
function reversed(pts) {
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

  const raw = [];
  for (const pts of closed) {
    const signedArea = loopArea(pts);
    if (Math.abs(signedArea) < minArea) continue;
    raw.push({ pts, area: Math.abs(signedArea), signedArea });
  }
  // Biggest first, so a containing loop is always tested before what it holds.
  raw.sort((a, b) => b.area - a.area);

  const loops = raw.map((r, i) => {
    let depth = 0;
    for (let j = 0; j < i; j++) {
      if (pointInLoop(raw[j].pts, r.pts[0], r.pts[1])) depth++;
    }
    const isHole = depth % 2 === 1;
    // Force the convention: outer counter-clockwise, hole clockwise.
    const wantPositive = !isHole;
    const points = (r.signedArea > 0) === wantPositive ? r.pts : reversed(r.pts);
    return { points, area: r.area, isHole, depth, signedArea: wantPositive ? r.area : -r.area };
  });

  return { loops, openCount: open.length, open };
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
