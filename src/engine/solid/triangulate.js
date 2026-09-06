/**
 * Triangulate a polygon with holes — the flat faces of an extruded solid.
 *
 * `three.js` ships `ShapeUtils.triangulateShape`, and this is not that, because
 * nothing under `engine/` imports three: the whole engine is plain arrays so it
 * runs identically in a worker, in Node and under the test runner. Ear clipping
 * is a hundred lines and does not need a rendering library.
 *
 * Two steps, the standard pair:
 *
 * 1. **Bridge the holes into the outer loop.** A hole is cut into the boundary
 *    by a doubled-back seam between one hole vertex and one outer vertex that
 *    can see it. That turns a polygon-with-holes into one simple polygon whose
 *    boundary walks into each hole and back out.
 * 2. **Clip ears.** Repeatedly remove a convex vertex whose triangle contains no
 *    other vertex.
 *
 * Input follows the convention the rest of the engine uses (`sliceLoops`,
 * `sketchLoops`): the outer boundary counter-clockwise, holes clockwise, each a
 * flat `[x0,y0,x1,y1,...]` with the first point not repeated.
 */

const EPS = 1e-12;

const cross2 = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/**
 * Whether p is **strictly** inside triangle abc, for a counter-clockwise abc.
 *
 * Strictly matters. A bridged ring walks into each hole and back out along the
 * same seam, so it deliberately contains duplicated vertices — the seam's two
 * ends are the same two points. An "inside or on" test sees one copy sitting
 * exactly on the other's corner, calls every nearby triangle blocked, and no ear
 * can ever be clipped; the clipper then falls back to dropping vertices and the
 * holes disappear from the cap. Points on the boundary are not in the interior,
 * and treating them that way is what lets a bridged ring clip at all.
 */
function inTriangle(ax, ay, bx, by, cx, cy, px, py) {
  return cross2(ax, ay, bx, by, px, py) > EPS
    && cross2(bx, by, cx, cy, px, py) > EPS
    && cross2(cx, cy, ax, ay, px, py) > EPS;
}

/** A loop as [{x, y}], dropping any point identical to the one before it. */
function toVerts(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    const x = flat[i];
    const y = flat[i + 1];
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev.x - x) > EPS || Math.abs(prev.y - y) > EPS) out.push({ x, y });
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && Math.abs(first.x - last.x) < EPS && Math.abs(first.y - last.y) < EPS) {
    out.pop();
  }
  return out;
}

const signedArea = (v) => {
  let a = 0;
  for (let i = 0, n = v.length; i < n; i++) {
    const j = (i + 1) % n;
    a += v[i].x * v[j].y - v[j].x * v[i].y;
  }
  return a / 2;
};

/**
 * Fold every hole into `outer`, returning one simple polygon.
 *
 * The bridge is found by **ray cast**, the classic Eberly construction that
 * earcut and three.js both use, and it is worth saying why rather than searching
 * for any pair of mutually visible vertices. The seam starts at the hole's
 * *leftmost* vertex and runs in −x. Nothing of the hole lies to the left of its
 * own leftmost point at that height, so the seam cannot re-enter the hole it
 * came from — which is the entire class of bug that a "try pairs until one looks
 * clear" search walks into. A seam that crosses its own hole makes a
 * self-intersecting ring, ear clipping cannot detect that, and the bore silently
 * fills back in with nothing on screen to say so.
 *
 * Holes are taken leftmost-first for the matching reason: each seam runs left
 * into boundary that is already settled, so two seams cannot cross.
 */
function bridgeHoles(outer, holes) {
  let poly = outer.slice();
  const queue = holes
    .filter((h) => h.length >= 3)
    .map((h) => ({ verts: h, minX: Math.min(...h.map((p) => p.x)) }))
    .sort((a, b) => a.minX - b.minX);

  for (const { verts } of queue) {
    const bridge = findBridge(poly, verts);
    if (!bridge) continue; // unreachable hole: the cap loses it rather than tearing
    const { outerAt, holeAt } = bridge;
    // Walk in along the seam, round the hole, and back out: the boundary now
    // includes the hole, wound so its interior stays outside the polygon.
    const spliced = [];
    for (let i = 0; i <= outerAt; i++) spliced.push(poly[i]);
    for (let i = 0; i < verts.length; i++) spliced.push(verts[(holeAt + i) % verts.length]);
    spliced.push(verts[holeAt]);
    for (let i = outerAt; i < poly.length; i++) spliced.push(poly[i]);
    poly = spliced;
  }
  return poly;
}

/** Whether the polygon turns inward at vertex `i` (interior angle over 180°). */
function isReflex(poly, i) {
  const n = poly.length;
  const a = poly[(i + n - 1) % n];
  const b = poly[i];
  const c = poly[(i + 1) % n];
  return cross2(a.x, a.y, b.x, b.y, c.x, c.y) < 0;
}

/** Point-in-triangle that does not care which way the triangle is wound. */
function inTriangleEither(ax, ay, bx, by, cx, cy, px, py) {
  const d1 = cross2(ax, ay, bx, by, px, py);
  const d2 = cross2(bx, by, cx, cy, px, py);
  const d3 = cross2(cx, cy, ax, ay, px, py);
  const neg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const pos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(neg && pos);
}

/**
 * The outer vertex the hole's leftmost vertex should be seamed to.
 *
 * Step one casts −x and takes the nearest edge it meets, whose right-hand
 * endpoint is the first candidate. Step two exists for concave boundaries: if
 * any *reflex* vertex sits inside the triangle formed by the hole point, the
 * ray hit and that candidate, the direct seam would cut across the boundary, so
 * the reflex vertex at the shallowest angle to the ray is taken instead.
 */
function findBridge(poly, verts) {
  let hi = 0;
  for (let i = 1; i < verts.length; i++) if (verts[i].x < verts[hi].x) hi = i;
  const hx = verts[hi].x;
  const hy = verts[hi].y;

  let qx = -Infinity;
  let m = -1;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    // Downward-crossing edges only. On a counter-clockwise outer these are the
    // left-hand side, which is where a −x ray has to land.
    if (hy <= a.y && hy >= b.y && b.y !== a.y) {
      const x = a.x + ((hy - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = a.x < b.x ? i : (i + 1) % n;
        if (x === hx) return { outerAt: m, holeAt: hi }; // the hole touches the boundary
      }
    }
  }
  if (m < 0) return null;

  const mx = poly[m].x;
  const my = poly[m].y;
  let best = m;
  let tanMin = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    if (i === m) continue;
    const p = poly[i];
    if (hx < p.x || p.x < mx || hx === p.x) continue;
    if (!inTriangleEither(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) continue;
    if (!isReflex(poly, i)) continue;
    const tan = Math.abs(hy - p.y) / (hx - p.x);
    if (tan < tanMin || (tan === tanMin && p.x > poly[best].x)) {
      best = i;
      tanMin = tan;
    }
  }
  return { outerAt: best, holeAt: hi };
}

/**
 * Triangulate one region.
 *
 * @param {number[]} outer  boundary, counter-clockwise
 * @param {number[][]} [holes]  holes, clockwise
 * @returns {{vertices: number[], indices: number[]}}
 *   `vertices` is flat [x,y,...] (the bridged polygon, so holes appear in it);
 *   `indices` are triples into it, every triangle counter-clockwise.
 */
export function triangulate(outer, holes = []) {
  let ring = toVerts(outer);
  if (ring.length < 3) return { vertices: [], indices: [] };
  // Force the input's stated winding, so the ear test's sign is meaningful even
  // if a caller hands over a loop the other way round.
  if (signedArea(ring) < 0) ring.reverse();
  const holeRings = holes
    .map(toVerts)
    .filter((h) => h.length >= 3)
    .map((h) => (signedArea(h) > 0 ? h.slice().reverse() : h));

  ring = holeRings.length ? bridgeHoles(ring, holeRings) : ring;

  const vertices = [];
  for (const p of ring) vertices.push(p.x, p.y);

  const indices = [];
  const live = ring.map((_, i) => i);
  let guard = live.length * live.length + 16; // ear clipping cannot need more

  while (live.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < live.length; i++) {
      const ia = live[(i + live.length - 1) % live.length];
      const ib = live[i];
      const ic = live[(i + 1) % live.length];
      const a = ring[ia];
      const b = ring[ib];
      const c = ring[ic];
      if (cross2(a.x, a.y, b.x, b.y, c.x, c.y) <= EPS) continue; // reflex or flat

      let clear = true;
      for (const j of live) {
        if (j === ia || j === ib || j === ic) continue;
        const p = ring[j];
        if (inTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y)) { clear = false; break; }
      }
      if (!clear) continue;

      indices.push(ia, ib, ic);
      live.splice(i, 1);
      clipped = true;
      break;
    }
    // No ear anywhere means the ring is degenerate (a seam folded back on
    // itself, usually). Drop the sharpest vertex and carry on rather than spin.
    if (!clipped) live.splice(1, 1);
  }
  if (live.length === 3) indices.push(live[0], live[1], live[2]);

  return { vertices, indices };
}
