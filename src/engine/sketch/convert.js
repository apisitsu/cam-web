/**
 * Convert Entities — the part's own edges brought into the sketch.
 *
 * A mesh has no lines or arcs, only chains of short segments, so a converted
 * edge has to be read back into what it was drawn as: straight runs become one
 * line each, runs of segments on one circle become an arc, and a closed round
 * chain a circle. Anything that is neither stays as short lines, which still
 * build and still machine.
 *
 * The chain is projected square onto the sketch plane: an edge lying in the
 * plane comes over exactly, one off it lands where it would be seen from in
 * front — what SolidWorks' Convert Entities does for an edge on the face the
 * sketch sits on.
 *
 * The result is a copy, not a link: change the part and the converted lines stay
 * where they were. Pure: plain arrays and the sketch document.
 */
import { worldToPlane } from './plane.js';
import { addPoint, addLine, addCircle, addArc } from './model.js';

/** How far (mm) a vertex may sit off a fitted line or circle and still be on it. */
const FIT_TOL = 0.01;
/** Corners closer than this (mm) are one. */
const SAME = 1e-6;
/** An arc needs at least this many segments; fewer are kept as lines. */
const MIN_ARC_SEGMENTS = 3;

const near = (a, b, tol = SAME) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

function circleThrough(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { x, y, r: Math.hypot(a[0] - x, a[1] - y) };
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Drop repeated corners (and, for a closed loop, a last one equal to the first). */
function clean(pts, closed) {
  const out = [];
  for (const p of pts) if (!out.length || !near(out[out.length - 1], p)) out.push(p);
  if (closed && out.length > 1 && near(out[0], out[out.length - 1])) out.pop();
  return out;
}

/** A facet of a drawn arc turns through at most this much; a polygon's corners turn more. */
const MAX_FACET_CHORD = 2 * Math.sin((Math.PI / 180) * 22.5);

/** Whether points i..j (inclusive) lie on the circle, all turning the same way. */
function onCircle(pts, i, j, c) {
  const turn = Math.sign(cross(pts[i], pts[i + 1], pts[i + 2]));
  if (!turn) return false;
  for (let k = i; k <= j; k++) {
    if (Math.abs(Math.hypot(pts[k][0] - c.x, pts[k][1] - c.y) - c.r) > FIT_TOL) return false;
    if (k < j && Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]) > MAX_FACET_CHORD * c.r) return false;
    if (k + 2 <= j && Math.sign(cross(pts[k], pts[k + 1], pts[k + 2])) !== turn) return false;
  }
  return true;
}

/** Whether points i..j lie on the line from i to j. */
function onLine(pts, i, j) {
  const [ax, ay] = pts[i];
  const [bx, by] = pts[j];
  const len = Math.hypot(bx - ax, by - ay);
  if (len < SAME) return false;
  for (let k = i + 1; k < j; k++) {
    const d = Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / len;
    if (d > FIT_TOL) return false;
  }
  return true;
}

/**
 * Read a 2D polyline as lines and arcs.
 *
 * @param {number[][]} pts  [x, y] corners
 * @param {boolean} closed
 * @returns {({type:'circle', c:number[], r:number}|{type:'line', a:number[], b:number[]}
 *   |{type:'arc', c:number[], r:number, a:number[], b:number[], ccw:boolean})[]}
 */
export function fitPolyline(pts, closed) {
  let p = clean(pts, closed);
  if (p.length < 2) return [];
  if (closed && p.length >= 8) {
    const c = circleThrough(p[0], p[Math.floor(p.length / 3)], p[Math.floor((2 * p.length) / 3)]);
    if (c && onCircle([...p, p[0], p[1]], 0, p.length + 1, c)) return [{ type: 'circle', c: [c.x, c.y], r: c.r }];
  }
  if (closed) {
    // Start the loop where no piece is split across the seam: at the start of
    // its longest segment — a straight side, never the middle of an arc's facets.
    let best = 0;
    let bestLen = -1;
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      const l = Math.hypot(q[0] - p[i][0], q[1] - p[i][1]);
      if (l > bestLen + 1e-9) { bestLen = l; best = i; }
    }
    p = [...p.slice(best), ...p.slice(0, best), p[best]];
  }
  const out = [];
  let i = 0;
  while (i < p.length - 1) {
    // Longest arc from i, then longest line; take whichever covers more.
    let arcEnd = -1;
    let arc = null;
    for (let j = i + MIN_ARC_SEGMENTS; j < p.length; j++) {
      const c = circleThrough(p[i], p[Math.floor((i + j) / 2)], p[j]);
      if (!c || c.r > 1e5 || !onCircle(p, i, j, c)) break;
      arcEnd = j;
      arc = c;
    }
    let lineEnd = i + 1;
    while (lineEnd + 1 < p.length && onLine(p, i, lineEnd + 1)) lineEnd += 1;
    if (arcEnd > lineEnd) {
      out.push({
        type: 'arc', c: [arc.x, arc.y], r: arc.r, a: p[i], b: p[arcEnd], ccw: cross(p[i], p[i + 1], p[i + 2]) > 0,
      });
      i = arcEnd;
    } else {
      out.push({ type: 'line', a: p[i], b: p[lineEnd] });
      i = lineEnd;
    }
  }
  return out;
}

/** 3D chain → sketch-plane polyline. */
export function projectChain(plane, points) {
  return points.map((q) => {
    const { x, y } = worldToPlane(plane, q);
    return [x, y];
  });
}

/**
 * Add fitted pieces to a sketch, sharing corner points where pieces meet.
 *
 * @returns {number[]} the ids of the lines, arcs and circles added
 */
export function addPieces(sk, pieces) {
  const corners = [];
  const pointAt = ([x, y]) => {
    const hit = corners.find((c) => near(c.p, [x, y], 1e-6));
    if (hit) return hit.id;
    const id = addPoint(sk, x, y);
    corners.push({ p: [x, y], id });
    return id;
  };
  const ids = [];
  for (const pc of pieces) {
    if (pc.type === 'circle') {
      ids.push(addCircle(sk, addPoint(sk, pc.c[0], pc.c[1]), pc.r));
    } else if (pc.type === 'line') {
      ids.push(addLine(sk, pointAt(pc.a), pointAt(pc.b)));
    } else {
      const center = addPoint(sk, pc.c[0], pc.c[1]);
      // The arc model sweeps CCW from start to end.
      const [s, e] = pc.ccw ? [pc.a, pc.b] : [pc.b, pc.a];
      ids.push(addArc(sk, center, pointAt(s), pointAt(e), pc.r));
    }
  }
  return ids;
}

/**
 * Convert part edges into the sketch.
 *
 * @param {object} sk  the sketch document
 * @param {object} plane  the sketch's plane
 * @param {{points:number[][], closed:boolean}[]} chains  3D chains (an edge, or a face's loops)
 * @returns {number[]} ids added
 */
export function convertChains(sk, plane, chains) {
  const ids = [];
  for (const ch of chains) ids.push(...addPieces(sk, fitPolyline(projectChain(plane, ch.points), ch.closed)));
  return ids;
}
