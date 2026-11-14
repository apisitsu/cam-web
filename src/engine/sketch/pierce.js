/**
 * Pierce: where the geometry of other sketches passes through this sketch's
 * plane — SolidWorks' Pierce relation, which ties a point to the spot a path
 * from another sketch goes through it (a sweep's profile on its path).
 *
 * The spots are offered like the part's edges are (`partRefs.js`): picking one
 * puts a fixed reference point there, tagged with the sketch and entity it came
 * from, and `followPierces` moves it when that sketch changes.
 *
 * Pure.
 */
import { planeToWorld, worldToPlane } from './plane.js';
import { tessellateArc, CHORD_TOL } from './loops.js';
import { curveOf, isCurve } from './curves.js';

/** A sketch's lines, arcs, circles and curves as 3D polylines on its plane. */
function polylines(doc, plane) {
  const E = (id) => doc.entities.get(id);
  const W = (x, y) => planeToWorld(plane, x, y);
  const out = [];
  for (const e of doc.entities.values()) {
    if (e.ref) continue;
    let flat = null;
    if (e.type === 'line') {
      const a = E(e.p1); const b = E(e.p2);
      if (a && b) flat = [a.x, a.y, b.x, b.y];
    } else if (e.type === 'circle' || e.type === 'arc') {
      const c = E(e.center);
      if (!c) continue;
      let a0 = 0; let a1 = 2 * Math.PI;
      if (e.type === 'arc') {
        const s = E(e.start); const en = E(e.end);
        if (!s || !en) continue;
        a0 = Math.atan2(s.y - c.y, s.x - c.x);
        a1 = Math.atan2(en.y - c.y, en.x - c.x);
        if (a1 <= a0) a1 += 2 * Math.PI;
      }
      flat = tessellateArc(c.x, c.y, e.r, a0, a1, CHORD_TOL);
    } else if (isCurve(e)) {
      const c = curveOf(doc, e);
      if (c) flat = c.closed ? [...c.points, c.points[0], c.points[1]] : c.points;
    }
    if (!flat || flat.length < 4) continue;
    const pts = [];
    for (let i = 0; i < flat.length; i += 2) pts.push(W(flat[i], flat[i + 1]));
    out.push({ id: e.id, pts });
  }
  return out;
}

/**
 * Every spot where another sketch's geometry crosses the plane of sketch
 * `activeId`, in that sketch's coordinates:
 * `[{ x, y, pierce: { sketchId, entityId }, sketchName }]`. Geometry lying in
 * the plane itself crosses it nowhere in particular and is left out.
 */
export function piercePoints(sketches, activeId) {
  const active = sketches.find((s) => s.id === activeId);
  if (!active) return [];
  const out = [];
  for (const s of sketches) {
    if (s.id === activeId || !s.doc) continue;
    for (const { id, pts } of polylines(s.doc, s.plane)) {
      const local = pts.map((p) => worldToPlane(active.plane, p));
      for (let i = 0; i + 1 < local.length; i++) {
        const a = local[i]; const b = local[i + 1];
        const za = Math.abs(a.off) <= 1e-9; const zb = Math.abs(b.off) <= 1e-9;
        if (za && zb) continue; // along the plane: no one spot
        let t;
        if (zb) t = 1;
        else if (za) { if (i > 0) continue; t = 0; } // counted as the previous run's end
        else if ((a.off < 0) !== (b.off < 0)) t = a.off / (a.off - b.off);
        else continue;
        const x = a.x + (b.x - a.x) * t; const y = a.y + (b.y - a.y) * t;
        if (out.some((q) => q.pierce.sketchId === s.id && q.pierce.entityId === id && Math.hypot(q.x - x, q.y - y) < 1e-6)) continue;
        out.push({
          x, y, pierce: { sketchId: s.id, entityId: id }, sketchName: s.name,
        });
      }
    }
  }
  return out;
}

/**
 * Move the pierce points of sketch `id` to where their geometry crosses its
 * plane now (the crossing of the same entity nearest where the point was).
 * `{ moved, lost }`: whether any moved, and how many have nothing to follow.
 */
export function followPierces(sketches, id) {
  const entry = sketches.find((s) => s.id === id);
  const result = { moved: false, lost: 0 };
  if (!entry) return result;
  const pts = [...entry.doc.entities.values()].filter((e) => e.type === 'point' && e.pierce);
  if (!pts.length) return result;
  const spots = piercePoints(sketches, id);
  for (const p of pts) {
    let best = null;
    let bestD = Infinity;
    for (const q of spots) {
      if (q.pierce.sketchId !== p.pierce.sketchId || q.pierce.entityId !== p.pierce.entityId) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) { bestD = d; best = q; }
    }
    if (!best) { result.lost += 1; continue; }
    if (bestD > 1e-9) { p.x = best.x; p.y = best.y; result.moved = true; }
  }
  return result;
}
