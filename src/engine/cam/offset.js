/**
 * Polygon offsetting — the operation every 2.5D milling toolpath is built from.
 *
 * A contour pass is the part boundary offset outward by the tool radius; a
 * pocket is the boundary offset inward again and again until nothing is left.
 * Doing that correctly is deceptively hard — offsetting a concave polygon makes
 * edges cross, and the self-intersections have to be resolved or the tool cuts
 * through the part — so this delegates to Clipper, which solves it properly,
 * and confines itself to being a clean boundary around it.
 *
 * Clipper works in integers, so coordinates are scaled by `SCALE` on the way in
 * and back on the way out. At 1000 that is micron resolution, which is finer
 * than any machine tool will hold and coarse enough to stay well inside the
 * 53-bit integer range for parts up to several metres.
 *
 * Pure functions over plain arrays of `[x0,y0,x1,y1,...]`. No three.js, no DOM.
 */

import ClipperLib from 'clipper-lib';

const SCALE = 1000;

/** Our flat [x,y,...] loop -> Clipper's [{X,Y}] path. */
function toPath(points) {
  const path = new Array(points.length / 2);
  for (let i = 0; i < points.length; i += 2) {
    path[i / 2] = { X: Math.round(points[i] * SCALE), Y: Math.round(points[i + 1] * SCALE) };
  }
  return path;
}

/** Clipper path -> our flat loop. */
function fromPath(path) {
  const out = new Array(path.length * 2);
  for (let i = 0; i < path.length; i++) {
    out[i * 2] = path[i].X / SCALE;
    out[i * 2 + 1] = path[i].Y / SCALE;
  }
  return out;
}

const JOINS = {
  round: ClipperLib.JoinType.jtRound,
  square: ClipperLib.JoinType.jtSquare,
  miter: ClipperLib.JoinType.jtMiter,
};

/**
 * Offset a set of closed loops by `delta` mm — positive grows, negative shrinks.
 *
 * Holes must already be wound opposite to outers (which `sliceLoops`
 * guarantees), because that is how Clipper tells them apart: a negative delta
 * shrinks the solid, which means outers move in and holes move out. Get the
 * winding wrong and a pocket grows into the part.
 *
 * `round` joins are the default and the right one for machining: a square or
 * mitred join projects a sharp spike past the corner that the tool would have
 * to trace into thin air.
 *
 * @returns {number[][]} offset loops, outers CCW and holes CW as before
 */
export function offsetLoops(loops, delta, opts = {}) {
  const { join = 'round', arcTolerance = 0.01 } = opts;
  if (loops.length === 0) return [];

  const co = new ClipperLib.ClipperOffset(2, arcTolerance * SCALE);
  for (const l of loops) {
    const points = Array.isArray(l) ? l : l.points;
    if (points.length < 6) continue; // fewer than 3 corners is not an area
    co.AddPath(toPath(points), JOINS[join] ?? JOINS.round, ClipperLib.EndType.etClosedPolygon);
  }
  const solution = new ClipperLib.Paths();
  co.Execute(solution, delta * SCALE);
  return solution.map(fromPath).filter((p) => p.length >= 6);
}

/**
 * Concentric inward offsets that clear a region, from the boundary inward.
 *
 * Each ring is one stepover further in than the last, and the walk stops when
 * the region closes up. `maxRings` is a safety net rather than a parameter to
 * tune: a self-intersecting input can otherwise shrink forever without ever
 * emptying.
 *
 * The first ring is offset by the tool *radius* so the cutter's edge lands on
 * the boundary; subsequent rings step by `stepover`.
 *
 * @returns {Array<{depth:number, loops:number[][]}>} rings, outermost first
 */
export function clearingRings(loops, toolRadius, stepover, opts = {}) {
  const { maxRings = 500 } = opts;
  const rings = [];
  let delta = -toolRadius;
  for (let i = 0; i < maxRings; i++) {
    const ring = offsetLoops(loops, delta, opts);
    if (ring.length === 0) break;
    rings.push({ pass: i, offset: delta, loops: ring });
    delta -= stepover;
  }
  return rings;
}

/** Signed area of a flat loop; positive is counter-clockwise. */
export function areaOf(points) {
  let a = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return a / 2;
}

/** Perimeter of a closed loop — used to estimate cutting time. */
export function perimeterOf(points) {
  let len = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    len += Math.hypot(points[j * 2] - points[i * 2], points[j * 2 + 1] - points[i * 2 + 1]);
  }
  return len;
}

const CLIP_TYPES = {
  difference: ClipperLib.ClipType.ctDifference,
  union: ClipperLib.ClipType.ctUnion,
  intersect: ClipperLib.ClipType.ctIntersection,
  xor: ClipperLib.ClipType.ctXor,
};

/**
 * Boolean of two loop sets.
 *
 * Non-zero fill throughout, which is why the outer-CCW / hole-CW convention has
 * to hold on the way in: an outer counts +1 and a hole −1, so the inside of a
 * hole nets to zero and stays empty through the operation. Loops handed over the
 * wrong way round quietly become the opposite of themselves.
 *
 * Winding of the *result* is Clipper's, not ours — run it through
 * `normalizeLoops` before anything downstream reads solid-versus-hole from it.
 *
 * @param {string} op  'difference' | 'union' | 'intersect' | 'xor'
 */
export function booleanLoops(subject, clip, op = 'difference') {
  const type = CLIP_TYPES[op];
  if (type === undefined) throw new Error(`unknown boolean op: ${op}`);
  const c = new ClipperLib.Clipper();
  const add = (loops, kind) => {
    for (const l of loops) {
      const points = Array.isArray(l) ? l : l.points;
      if (points.length >= 6) c.AddPath(toPath(points), kind, true);
    }
  };
  add(subject, ClipperLib.PolyType.ptSubject);
  add(clip, ClipperLib.PolyType.ptClip);
  const solution = new ClipperLib.Paths();
  c.Execute(
    type, solution,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero,
  );
  return solution.map(fromPath).filter((p) => p.length >= 6);
}

/**
 * Boolean difference, `subject` minus `clip`.
 *
 * Roughing needs it to work out what the stock boundary still holds that the
 * part does not: the material to remove at a Z level is the stock section minus
 * the part section.
 */
export function differenceLoops(subject, clip) {
  return booleanLoops(subject, clip, 'difference');
}

/** A rectangle as a CCW loop — the usual stock boundary for a milling job. */
export function rectLoop(minX, minY, maxX, maxY) {
  return [minX, minY, maxX, minY, maxX, maxY, minX, maxY];
}
