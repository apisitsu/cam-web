/**
 * Compound sketch shapes — a slot and a regular polygon.
 *
 * Both are built out of the primitives that already exist (points, lines, arcs,
 * a construction circle) rather than added as new entity kinds, and that is the
 * whole design. A new kind has to be taught to the solver bridge, the loop
 * chainer, the DXF writer and reader, the hit tests and the renderer before it
 * can be drawn at all. A compound shape needs none of them: it is ordinary
 * geometry from the moment it exists, so it chains into a profile, extrudes,
 * exports and machines on the day it is written.
 *
 * What makes them shapes rather than a pile of lines is the **constraints** they
 * come with. A slot whose flanks are merely parallel-looking stops being a slot
 * the first time anything near it is dragged; tangency and equal radii keep it
 * one through every solve. Same for a polygon: the vertices are pinned to a
 * construction circle and the sides made equal, so it stays regular.
 *
 * Pure — a sketch document in, ids out. No DOM, no store.
 */
import {
  addLine, addCircle, addArc, addConstraint,
} from './model.js';
import { getOrCreatePoint } from './edit.js';

/** Smallest slot/polygon worth making — below this a click is a mis-click. */
const MIN_SIZE = 1e-6;

/**
 * Weld tolerance for the points these shapes **generate themselves**.
 *
 * Deliberately not the caller's pick tolerance. That one answers "which existing
 * point did the user mean to click", is measured in pixels and so grows without
 * limit as the view zooms out — and it was being used to decide whether a slot's
 * own tangent points were distinct. At a zoomed-out `pickTol` of 9 mm every slot
 * narrower than about 18 mm collapsed onto its own centreline and the build
 * returned nothing, so three clicks produced silence. What the user picks and
 * what the shape derives are different questions and now use different numbers.
 */
const GEN_TOL = 1e-6;

/**
 * Perpendicular distance from (px, py) to the infinite line through `a` and `b`
 * — the slot's radius, taken from where the third click landed off the axis.
 *
 * `edit.js` has a `distancePointToLine`, and it takes **entity ids**: it is the
 * measurement behind a point-to-line dimension. This one works on raw
 * coordinates because the third click has not become an entity and never will.
 */
export function axisDistance(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > MIN_SIZE)) return Math.hypot(px - a.x, py - a.y);
  return Math.abs((px - a.x) * dy - (py - a.y) * dx) / len;
}

/**
 * A straight slot: two flanks and two semicircular caps, of radius `r` about
 * the axis running from (x1, y1) to (x2, y2).
 *
 * The caps are named from the end that puts each sweep on the **outside**. An
 * arc sweeps counter-clockwise from its start to its end, so naming a cap the
 * other way round carves it back into the slot — a shape that looks almost right
 * and encloses the wrong area.
 *
 * @returns {{lines:number[], arcs:number[], centers:number[]}|null}
 */
export function buildSlot(sk, x1, y1, x2, y2, r, tol = 1e-6) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (!(len > MIN_SIZE) || !(r > MIN_SIZE)) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Left normal of the axis: the flanks sit ±r along it.
  const px = -uy;
  const py = ux;

  // The two axis ends are two separate clicks, so the snap that finds an
  // existing point near them must never be wide enough to merge them with each
  // other. Zoomed far out the raw pick tolerance easily exceeds the whole slot.
  const snap = Math.min(tol, len * 0.49);
  const c1 = getOrCreatePoint(sk, x1, y1, snap);
  const c2 = getOrCreatePoint(sk, x2, y2, snap);
  const a1 = getOrCreatePoint(sk, x1 + px * r, y1 + py * r, GEN_TOL);
  const a2 = getOrCreatePoint(sk, x2 + px * r, y2 + py * r, GEN_TOL);
  const b1 = getOrCreatePoint(sk, x1 - px * r, y1 - py * r, GEN_TOL);
  const b2 = getOrCreatePoint(sk, x2 - px * r, y2 - py * r, GEN_TOL);
  // A degenerate click can weld two of these onto each other; bail rather than
  // build a shape with a zero-length side in it.
  if (new Set([c1, c2, a1, a2, b1, b2]).size !== 6) return null;

  const top = addLine(sk, a1, a2);
  const bottom = addLine(sk, b2, b1);
  // Cap at the far end sweeps from the −normal side round to the +normal side;
  // the near cap sweeps the other way. Both leave the slot's interior alone.
  const capFar = addArc(sk, c2, b2, a2, r);
  const capNear = addArc(sk, c1, a1, b1, r);

  // The relations that keep it a slot when anything near it is dragged.
  addConstraint(sk, 'tangentArc', [top, capFar]);
  addConstraint(sk, 'tangentArc', [top, capNear]);
  addConstraint(sk, 'tangentArc', [bottom, capFar]);
  addConstraint(sk, 'tangentArc', [bottom, capNear]);
  addConstraint(sk, 'equalRadius', [capFar, capNear]);

  return { lines: [top, bottom], arcs: [capFar, capNear], centers: [c1, c2] };
}

/**
 * A regular polygon of `sides` sides, inscribed in the circle through
 * (vx, vy) about (cx, cy) — centre first, then one vertex, which sets both the
 * size and the rotation.
 *
 * A **construction** circle is created with it and every vertex pinned to that
 * circle, which is how a CAD keeps a polygon regular: the sides are made equal
 * to each other and the corners cannot leave the circumscribed circle, so
 * dragging the vertex resizes the whole thing instead of denting it. The circle
 * is construction geometry, so it is reference only and stays out of the
 * profile — `sketchLoops` skips it and the extrude never sees it.
 *
 * @returns {{lines:number[], vertices:number[], circle:number, center:number}|null}
 */
export function buildPolygon(sk, cx, cy, vx, vy, sides = 6, tol = 1e-6) {
  const n = Math.round(sides);
  if (!Number.isFinite(n) || n < 3 || n > 64) return null;
  const r = Math.hypot(vx - cx, vy - cy);
  if (!(r > MIN_SIZE)) return null;
  const a0 = Math.atan2(vy - cy, vx - cx);

  // Same clamp as the slot: the snap must not reach the corners it is about to
  // create, or the polygon swallows its own centre.
  const center = getOrCreatePoint(sk, cx, cy, Math.min(tol, r * 0.49));
  const vertices = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (i * Math.PI * 2) / n;
    vertices.push(getOrCreatePoint(sk, cx + r * Math.cos(a), cy + r * Math.sin(a), GEN_TOL));
  }
  // Welding two corners together means the polygon is smaller than the pick
  // tolerance — nothing worth building.
  if (new Set(vertices).size !== n || vertices.includes(center)) return null;

  const circle = addCircle(sk, center, r);
  sk.entities.get(circle).construction = true;

  const lines = [];
  for (let i = 0; i < n; i++) lines.push(addLine(sk, vertices[i], vertices[(i + 1) % n]));

  for (const v of vertices) addConstraint(sk, 'pointOnCircle', [v, circle]);
  // Equal sides all round. The last pair is implied by the rest and by the
  // circle, so it is left out — adding it makes the sketch read over-defined.
  for (let i = 0; i < n - 1; i++) addConstraint(sk, 'equalLength', [lines[i], lines[i + 1]]);

  return {
    lines, vertices, circle, center,
  };
}

/**
 * Where a polygon's vertices would land, without building anything — the
 * rubber-band preview the toolbar draws while the second click is pending.
 */
export function polygonPreview(cx, cy, vx, vy, sides = 6) {
  const n = Math.round(sides);
  if (!Number.isFinite(n) || n < 3 || n > 64) return [];
  const r = Math.hypot(vx - cx, vy - cy);
  const a0 = Math.atan2(vy - cy, vx - cx);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i * Math.PI * 2) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/**
 * The outline of a slot, without building it — the same preview job as
 * `polygonPreview`. Returns the two flanks and the two cap arcs as one closed
 * point list, tessellated coarsely enough for a rubber band.
 */
export function slotPreview(x1, y1, x2, y2, r, segs = 24) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (!(len > MIN_SIZE) || !(r > MIN_SIZE)) return [];
  const px = -dy / len;
  const py = dx / len;
  const base = Math.atan2(py, px);
  const pts = [[x1 + px * r, y1 + py * r], [x2 + px * r, y2 + py * r]];
  for (let i = 1; i < segs; i++) {
    const a = base - (i * Math.PI) / segs;
    pts.push([x2 + r * Math.cos(a), y2 + r * Math.sin(a)]);
  }
  pts.push([x2 - px * r, y2 - py * r], [x1 - px * r, y1 - py * r]);
  for (let i = 1; i < segs; i++) {
    const a = base + Math.PI - (i * Math.PI) / segs;
    pts.push([x1 + r * Math.cos(a), y1 + r * Math.sin(a)]);
  }
  pts.push(pts[0]);
  return pts;
}
