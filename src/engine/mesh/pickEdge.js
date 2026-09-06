/**
 * Which edge is the operator pointing at?
 *
 * A raycast against the part reports a triangle, and `faceOfTriangle` turns that
 * into the merged face — which is the right answer almost everywhere and the
 * wrong one within a millimetre of a corner. Someone hovering the rim of a pocket
 * means the rim, not the floor it happens to hit.
 *
 * So the hit point is measured against the detected edge chains, and an edge
 * close enough to it wins over the face under the cursor. "Close enough" has to
 * be a real distance in millimetres rather than a fraction of anything: the
 * cursor lands on the surface, and the surface is where the edge is, so the
 * tolerance is how precisely a hand can point — not how big the part is.
 *
 * Pure geometry. No three, no store, no React.
 */

/** How near the hit point an edge must pass to be what was meant, in mm. */
export const EDGE_PICK_TOLERANCE = 0.6;

/**
 * Squared distance from a point to a segment. Squared throughout — the ranking
 * only compares distances to each other and to one threshold, and a square root
 * per segment over every chain of a detected model is thousands of them per
 * mouse move.
 */
function distanceSqToSegment(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const len2 = abx * abx + aby * aby + abz * abz;
  // A degenerate segment is a point; the clamp below would divide by zero.
  let t = len2 > 0 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * The nearest point on an edge chain to `p`, as a squared distance.
 * A closed chain is treated as closed — its last point joins its first.
 */
export function distanceSqToEdge(edge, p) {
  const pts = edge?.points;
  if (!pts || pts.length === 0) return Infinity;
  if (pts.length === 1) {
    const dx = p[0] - pts[0][0];
    const dy = p[1] - pts[0][1];
    const dz = p[2] - pts[0][2];
    return dx * dx + dy * dy + dz * dz;
  }
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distanceSqToSegment(p, pts[i], pts[i + 1]);
    if (d < best) best = d;
  }
  if (edge.closed) {
    const d = distanceSqToSegment(p, pts[pts.length - 1], pts[0]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * The edge the point is on, or `null` when it is on open surface.
 *
 * Ties break towards the **shorter** chain: a long boundary loop and the short
 * chamfer edge crossing it both pass through the same corner, and the short one
 * is the more specific thing to have pointed at.
 *
 * @param {object[]} edges  detected chains — `{ id, points, closed, length }`
 * @param {number[]} point  the raycast hit, in the same frame as the points
 * @param {number} [tolerance] mm; how near counts as on it
 */
export function edgeAtPoint(edges, point, tolerance = EDGE_PICK_TOLERANCE) {
  if (!edges?.length || !point || point.length < 3) return null;
  const maxSq = tolerance * tolerance;
  let best = null;
  let bestSq = Infinity;
  for (const e of edges) {
    const d = distanceSqToEdge(e, point);
    if (d > maxSq) continue;
    if (d < bestSq || (d === bestSq && (e.length ?? Infinity) < (best?.length ?? Infinity))) {
      best = e;
      bestSq = d;
    }
  }
  return best;
}

/**
 * What the operator is pointing at: the edge if the cursor is on one, else the
 * face under it.
 *
 * One function so hover and click cannot disagree — a highlight that follows a
 * different rule from the click that follows it is worse than no highlight,
 * because it teaches the wrong thing about where to aim.
 */
export function featureAtPoint({ edges, face, point, tolerance } = {}) {
  return edgeAtPoint(edges, point, tolerance) ?? face ?? null;
}
