/**
 * Measure — what a click on the part is, and what two of them measure.
 *
 * The questions an operator asks before posting a program are few and concrete:
 * how big is this bore, how thick is this wall, how far is this hole from that
 * edge, how deep is this step. Each is one or two clicks, so a click is read for
 * the most specific thing under it:
 *
 * - on a **round wall** (a bore or a boss), the circle the wall is part of —
 *   a cylinder is what has a diameter;
 * - close to a **straight edge**, that edge;
 * - on a **flat face**, that face — faces are what have a distance between them;
 * - otherwise just the **point**.
 *
 * A reference plane is a pick too, not from the mesh (`planePick`).
 *
 * The distance between two picks is the one a drawing would dimension: square
 * across a plane or an edge, and across the axis of a bore. Where on a face the
 * click landed, or how far down a bore, is never part of it.
 *
 * Pure, plain arrays, in whatever frame the mesh is in: the machining pages
 * measure the part as set up (coordinates from the work origin), the Sketch page
 * the part as built. Distances are the same in both.
 */
import { detectFeatures, faceOfTriangle } from './features.js';
import { circlesAt, nearestCircle } from './circlePick.js';
import { EDGE_PICK_TOLERANCE } from './pickEdge.js';
import { PLANE_PRESETS, planeToWorld, worldToPlane } from '../sketch/plane.js';
import { partReferences } from '../sketch/partRefs.js';

/** How close to a circle's edge a point must be, as a share of its radius, to be on its wall. */
const ON_WALL = 0.02;
/** Cosine above which two directions count as parallel. */
const PARALLEL = 0.9999;
/** Sine of the bend that still counts as one straight edge. */
const STRAIGHT = 1e-3;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Read one click.
 *
 * @param {object} welded  the welded mesh the click landed on
 * @param {number} faceIndex  the triangle hit (soup and welded share their order)
 * @param {number[]} point  where, in the mesh's frame
 * @param {number[]} normal  the hit triangle's normal
 * @param {number} [tolerance]  how near, in mm, counts as on an edge or a rim
 * @returns {{kind:'circle'|'edge'|'face'|'point', point:number[], circle?:object, edge?:object, face?:object}}
 */
export function measurePick(welded, faceIndex, point, normal, tolerance = EDGE_PICK_TOLERANCE) {
  const circle = nearestCircle(circlesAt(welded, point, normal), point);
  if (circle && onWall(circle, point, tolerance)) return { kind: 'circle', point, circle };
  const features = detectFeatures(welded);
  const edge = straightEdgeAt(features.edges, point, tolerance);
  if (edge) return { kind: 'edge', point, edge };
  const face = faceOfTriangle(features, faceIndex);
  if (face?.normal) return { kind: 'face', point, face };
  return { kind: 'point', point };
}

/** A reference plane through the frame's origin, as a pick. */
export function planePick(preset) {
  const p = PLANE_PRESETS[preset];
  return {
    kind: 'plane', point: [0, 0, 0], name: p.label, normal: [...p.n], u: [...p.u], v: [...p.v],
  };
}

/**
 * What a click on a reference plane measures. Looking straight down a through
 * bore the click meets no part at all, only the plane behind it, and the operator
 * meant the bore.
 */
export function planeClickPick(welded, preset, worldPoint) {
  const plane = { preset, offset: 0 };
  const at = worldToPlane(plane, worldPoint);
  const bore = welded && partReferences(welded, plane).circles
    .filter((c) => Math.hypot(c.x - at.x, c.y - at.y) <= c.r)
    .sort((p, q) => p.r - q.r)[0]; // a bore inside a round boss is inside both circles
  if (!bore) return planePick(preset);
  const center = planeToWorld(plane, bore.x, bore.y);
  const axis = PLANE_PRESETS[preset].n.findIndex((v) => Math.abs(v) === 1);
  return { kind: 'circle', point: center, circle: { axis, center, radius: bore.r } };
}

/** Whether `point` lies on the round wall of `circle`, not merely near it. */
function onWall(circle, point, tolerance) {
  const off = sub(point, circle.center);
  off[circle.axis] = 0;
  return Math.abs(len(off) - circle.radius) <= Math.max(circle.radius * ON_WALL, tolerance);
}

function distanceToSegment(p, a, b) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return len(sub(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]));
}

/**
 * The straight edge within `tolerance` of `point`, or null.
 *
 * A chain of sharp edges can turn a corner, so only the straight run under the
 * cursor is taken. A curved chain (a rim seen as many short facets) is not an edge.
 */
function straightEdgeAt(edges, point, tolerance) {
  let best = null;
  let bestD = tolerance;
  for (const edge of edges) {
    for (let i = 0; i + 1 < edge.points.length; i += 1) {
      const d = distanceToSegment(point, edge.points[i], edge.points[i + 1]);
      if (d <= bestD) { best = { points: edge.points, i }; bestD = d; }
    }
  }
  if (!best) return null;
  const { points, i } = best;
  const dir = (k) => unit(sub(points[k + 1], points[k]));
  const along = dir(i);
  const straight = (k) => len(cross(dir(k), along)) < STRAIGHT && dot(dir(k), along) > 0;
  let first = i;
  let last = i;
  while (first > 0 && straight(first - 1)) first -= 1;
  while (last + 2 < points.length && straight(last + 1)) last += 1;
  const a = points[first];
  const b = points[last + 1];
  const whole = points.reduce((sum, p, k) => (k ? sum + len(sub(p, points[k - 1])) : 0), 0);
  if (points.length > 8 && len(sub(b, a)) < whole * 0.25) return null;
  return { a, b, length: len(sub(b, a)) };
}

const AXES = ['X', 'Y', 'Z'];
const round3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);
const mm = (v) => `${round3(v)} mm`;
const degrees = (rad) => `${round3((rad * 180) / Math.PI)}°`;
const xyz = (p) => p.map((v, i) => `${AXES[i]} ${round3(v)}`).join('  ');

/** A pick that is a plane in space: where it passes, and which way it faces. */
function flatOf(p) {
  if (p.kind === 'face') return { at: p.face.centroid, n: p.face.normal };
  if (p.kind === 'plane') return { at: p.point, n: p.normal };
  return null;
}

/** Remove the part of `v` along coordinate `axis`: what a drawing looking down that axis sees. */
const acrossAxis = (v, axis) => v.map((x, k) => (k === axis ? 0 : x));

/** Perpendicular distance from a point to an infinite line through an edge; `axis` flattens both first. */
function offLine(p, edge, axis = null) {
  const flat = (v) => (axis == null ? v : acrossAxis(v, axis));
  const off = flat(sub(p, edge.a));
  const dir = flat(sub(edge.b, edge.a));
  if (len(dir) < 1e-9) return len(off); // the edge runs along the axis, and is a point down it
  return len(cross(off, unit(dir)));
}

function flatToOther(flat, other) {
  if (other.kind === 'circle') {
    const { center, radius, axis } = other.circle;
    if (Math.abs(flat.n[axis]) > PARALLEL) {
      return [{ label: 'Note', value: 'The bore runs square through this plane' }];
    }
    const d = Math.abs(dot(sub(center, flat.at), flat.n));
    const lines = [{ label: 'Distance to centre', value: mm(d) }];
    if (d > radius) lines.push({ label: 'Distance to wall', value: mm(d - radius) });
    return lines;
  }
  if (other.kind === 'edge') {
    const dir = unit(sub(other.edge.b, other.edge.a));
    const off = Math.abs(dot(dir, flat.n));
    if (off > 1 - PARALLEL) return [{ label: 'Angle', value: degrees(Math.asin(Math.min(1, off))) }];
    return [{ label: 'Distance (normal)', value: mm(Math.abs(dot(sub(other.edge.a, flat.at), flat.n))) }];
  }
  return [{ label: 'Distance (normal)', value: mm(Math.abs(dot(sub(other.point, flat.at), flat.n))) }];
}

function edgeToOther(edge, other) {
  if (other.kind === 'edge') {
    const [d1, d2] = [unit(sub(edge.b, edge.a)), unit(sub(other.edge.b, other.edge.a))];
    const c = Math.abs(dot(d1, d2));
    if (c > PARALLEL) return [{ label: 'Distance (normal)', value: mm(offLine(other.edge.a, edge)) }];
    return [{ label: 'Angle', value: degrees(Math.acos(Math.min(1, c))) }];
  }
  if (other.kind === 'circle') {
    const { center, radius, axis } = other.circle;
    const d = offLine(center, edge, axis);
    const lines = [{ label: 'Edge to centre', value: mm(d) }];
    if (d > radius) lines.push({ label: 'Edge to wall', value: mm(d - radius) });
    return lines;
  }
  return [{ label: 'Distance (normal)', value: mm(offLine(other.point, edge)) }];
}

function betweenPoints(a, b) {
  const anchor = (p) => (p.kind === 'circle' ? p.circle.center : p.point);
  let d = sub(anchor(b), anchor(a));
  // Down the bore's axis the height is only where the wall was clicked.
  if (a.kind === 'circle' && (b.kind !== 'circle' || b.circle.axis === a.circle.axis)) d = acrossAxis(d, a.circle.axis);
  else if (b.kind === 'circle' && a.kind !== 'circle') d = acrossAxis(d, b.circle.axis);
  const both = a.kind === 'circle' && b.kind === 'circle';
  const lines = [{ label: both ? 'Centre distance' : 'Distance', value: mm(len(d)) }];
  if (both && len(d) > a.circle.radius + b.circle.radius) {
    lines.push({ label: 'Between walls', value: mm(len(d) - a.circle.radius - b.circle.radius) });
  }
  lines.push({ label: 'dX dY dZ', value: d.map(round3).join('  ') });
  return lines;
}

function twoPicks(a, b) {
  const [fa, fb] = [flatOf(a), flatOf(b)];
  if (fa && fb) {
    const c = dot(fa.n, fb.n);
    if (Math.abs(c) > PARALLEL) {
      // Parallel: the distance that matters is across them, wherever on each
      // face the clicks happened to land.
      return [{ label: 'Distance (normal)', value: mm(Math.abs(dot(sub(fb.at, fa.at), fa.n))) }];
    }
    return [{ label: 'Angle', value: degrees(Math.acos(Math.max(-1, Math.min(1, c)))) }];
  }
  if (fa) return flatToOther(fa, b);
  if (fb) return flatToOther(fb, a);
  if (a.kind === 'edge') return edgeToOther(a.edge, b);
  if (b.kind === 'edge') return edgeToOther(b.edge, a);
  return betweenPoints(a, b);
}

/**
 * What one or two picks measure, as labelled lines for the panel.
 *
 * @param {object[]} picks  from `measurePick` or `planePick`
 * @returns {{label:string, value:string}[]}
 */
export function measureResult(picks) {
  if (!picks.length) return [];
  if (picks.length > 1) return twoPicks(picks[0], picks[1]);
  const [p] = picks;
  if (p.kind === 'circle') {
    return [
      { label: 'Diameter', value: `Ø${mm(p.circle.radius * 2)}` },
      { label: 'Radius', value: mm(p.circle.radius) },
      { label: 'Centre', value: xyz(p.circle.center) },
      { label: 'Axis', value: AXES[p.circle.axis] },
    ];
  }
  if (p.kind === 'edge') {
    return [
      { label: 'Edge length', value: mm(p.edge.length) },
      { label: 'From', value: xyz(p.edge.a) },
      { label: 'To', value: xyz(p.edge.b) },
    ];
  }
  if (p.kind === 'face') {
    return [
      { label: 'Face', value: `${p.face.facing ?? ''} · ${(Math.round(p.face.area * 100) / 100).toFixed(2)} mm²` },
      { label: 'Point', value: xyz(p.point) },
    ];
  }
  if (p.kind === 'plane') return [{ label: 'Plane', value: p.name }];
  return [{ label: 'Point', value: xyz(p.point) }];
}
