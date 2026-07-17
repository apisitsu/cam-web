import { describe, it, expect } from 'vitest';
import {
  createSketch, addPoint, addLine, addCircle, addArc,
} from './model.js';
import {
  trimCircle, trimArc, sketchBounds, nearestRimPoint, circleIntersections,
  fillet, tangentPoint, nearestTangent,
} from './edit.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const entities = (sk) => [...sk.entities.values()];
const ofType = (sk, t) => entities(sk).filter((e) => e.type === t);

describe('circleIntersections', () => {
  it('finds where a segment crosses the ring, within the segment span', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    const circle = addCircle(sk, c, 10);
    // Vertical segment through the centre crosses at (0, ±10).
    const a = addPoint(sk, 0, -20);
    const b = addPoint(sk, 0, 20);
    addLine(sk, a, b);
    const pts = circleIntersections(sk, 0, 0, 10, circle).sort((u, v) => u.y - v.y);
    expect(pts.length).toBe(2);
    expect(near(pts[0].x, 0) && near(pts[0].y, -10)).toBe(true);
    expect(near(pts[1].x, 0) && near(pts[1].y, 10)).toBe(true);
  });

  it('ignores a segment that stops short of the ring', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    const circle = addCircle(sk, c, 10);
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 0, 5); // never reaches r=10
    addLine(sk, a, b);
    expect(circleIntersections(sk, 0, 0, 10, circle).length).toBe(0);
  });
});

describe('trimCircle', () => {
  it('turns a circle into the surviving arc, dropping the clicked segment', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    const circle = addCircle(sk, c, 10);
    // Vertical cut line → crossings at 90° and 270°.
    addLine(sk, addPoint(sk, 0, -20), addPoint(sk, 0, 20));
    // Click on the right half (angle 0) → remove it, keep the left half.
    const res = trimCircle(sk, circle, 10, 0);
    expect(res).not.toBeNull();
    expect(ofType(sk, 'circle').length).toBe(0);
    const arcs = ofType(sk, 'arc');
    expect(arcs.length).toBe(1);
    const arc = arcs[0];
    expect(near(arc.r, 10)).toBe(true);
    const s = sk.entities.get(arc.start);
    const e = sk.entities.get(arc.end);
    // Surviving arc sweeps CCW from (0,10) round the left to (0,-10).
    expect(near(s.x, 0) && near(s.y, 10)).toBe(true);
    expect(near(e.x, 0) && near(e.y, -10)).toBe(true);
  });

  it('is a no-op with fewer than two crossings', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    const circle = addCircle(sk, c, 10);
    expect(trimCircle(sk, circle, 10, 0)).toBeNull();
    expect(ofType(sk, 'circle').length).toBe(1);
  });
});

describe('trimArc', () => {
  it('shortens an arc back to a crossing under the click', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    const s = addPoint(sk, 10, 0); // start 0°
    const e = addPoint(sk, -10, 0); // end 180° → upper half, CCW
    const arcId = addArc(sk, c, s, e, 10);
    // Vertical line crosses the arc once inside the span, at (0, 10) → 90°.
    addLine(sk, addPoint(sk, 0, -20), addPoint(sk, 0, 20));
    // Click at 135° removes [90°,180°], keeping [0°,90°]: end moves to (0,10).
    const res = trimArc(sk, arcId, -7.07, 7.07);
    expect(res).not.toBeNull();
    expect(ofType(sk, 'arc').length).toBe(1);
    const arc = sk.entities.get(arcId);
    const start = sk.entities.get(arc.start);
    const end = sk.entities.get(arc.end);
    expect(near(start.x, 10) && near(start.y, 0)).toBe(true);
    expect(near(end.x, 0, 1e-3) && near(end.y, 10, 1e-3)).toBe(true);
  });

  it('is a no-op when nothing crosses the arc span', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    const arc = addArc(sk, c, addPoint(sk, 10, 0), addPoint(sk, -10, 0), 10);
    expect(trimArc(sk, arc, 0, 10)).toBeNull();
  });
});

describe('sketchBounds', () => {
  it('frames geometry and ignores the lone origin', () => {
    const sk = createSketch();
    const o = addPoint(sk, 0, 0, true);
    sk.entities.get(o).origin = true;
    const c = addPoint(sk, 5, 5);
    addCircle(sk, c, 3);
    const b = sketchBounds(sk);
    expect(b.min).toEqual([2, 2, 0]);
    expect(b.max).toEqual([8, 8, 0]);
  });

  it('returns null for an origin-only sketch', () => {
    const sk = createSketch();
    const o = addPoint(sk, 0, 0, true);
    sk.entities.get(o).origin = true;
    expect(sketchBounds(sk)).toBeNull();
  });
});

describe('fillet', () => {
  it('rounds a right-angle corner with a tangent arc of the given radius', () => {
    const sk = createSketch();
    // Corner at the origin: one leg along +x, one along +y.
    const corner = addPoint(sk, 0, 0);
    const ex = addPoint(sk, 20, 0);
    const ey = addPoint(sk, 0, 20);
    const l1 = addLine(sk, corner, ex);
    const l2 = addLine(sk, corner, ey);
    const arcId = fillet(sk, l1, l2, 5);
    expect(arcId).not.toBeNull();
    const arc = sk.entities.get(arcId);
    expect(near(arc.r, 5)).toBe(true);
    // 90° corner → tangent points 5 mm out along each leg, centre at (5,5).
    const c = sk.entities.get(arc.center);
    expect(near(c.x, 5) && near(c.y, 5)).toBe(true);
    // The legs now stop at the tangent points, not the old corner.
    expect(sk.entities.has(corner)).toBe(false);
    const ends = [sk.entities.get(arc.start), sk.entities.get(arc.end)];
    const onXleg = ends.find((p) => near(p.y, 0));
    const onYleg = ends.find((p) => near(p.x, 0));
    expect(onXleg && near(onXleg.x, 5)).toBe(true);
    expect(onYleg && near(onYleg.y, 5)).toBe(true);
  });

  it('refuses a radius that does not fit on the legs, and collinear lines', () => {
    const sk = createSketch();
    const corner = addPoint(sk, 0, 0);
    const l1 = addLine(sk, corner, addPoint(sk, 4, 0));
    const l2 = addLine(sk, corner, addPoint(sk, 0, 4));
    expect(fillet(sk, l1, l2, 50)).toBeNull(); // setback exceeds the 4 mm legs
    // Collinear legs (straight through the corner) → no fillet.
    const s2 = createSketch();
    const mid = addPoint(s2, 0, 0);
    const a = addLine(s2, mid, addPoint(s2, 10, 0));
    const b = addLine(s2, mid, addPoint(s2, -10, 0));
    expect(fillet(s2, a, b, 2)).toBeNull();
  });
});

describe('tangentPoint / nearestTangent', () => {
  it('finds the tangent point on a circle from an external anchor', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    addCircle(sk, c, 10);
    // Anchor on +x at distance 20; tangent points are symmetric about the x-axis.
    // Pick the upper one via a hint above the axis.
    const tp = tangentPoint(sk, ofType(sk, 'circle')[0].id, 20, 0, 0, 8);
    expect(tp).not.toBeNull();
    // Tangent point lies on the rim and TP ⟂ the radius: |A−C|²=|TP|²+|A−TP|².
    expect(near(Math.hypot(tp.x, tp.y), 10, 1e-6)).toBe(true);
    const dot = tp.x * (20 - tp.x) + tp.y * (0 - tp.y); // (C→TP)·(TP→A)
    expect(near(dot, 0, 1e-6)).toBe(true);
    expect(tp.y > 0).toBe(true); // chose the upper tangent (hint was above)
  });

  it('returns null when the anchor is inside the circle', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    addCircle(sk, c, 10);
    expect(tangentPoint(sk, ofType(sk, 'circle')[0].id, 2, 0, 0, 8)).toBeNull();
  });

  it('nearestTangent triggers only when the cursor is near the rim', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    addCircle(sk, c, 10);
    // Cursor near the rim on the upper-right → a tangent from (30,0) is offered.
    const hit = nearestTangent(sk, 30, 0, 7, 7.5, 2);
    expect(hit).not.toBeNull();
    expect(near(Math.hypot(hit.x, hit.y), 10, 1e-6)).toBe(true);
    // Cursor far from any rim → nothing.
    expect(nearestTangent(sk, 30, 0, 0, 0, 2)).toBeNull();
  });
});

describe('nearestRimPoint', () => {
  it('projects a near-rim query onto the circle', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    addCircle(sk, c, 10);
    const hit = nearestRimPoint(sk, 12, 0, 3);
    expect(hit).not.toBeNull();
    expect(hit.type).toBe('circle');
    expect(near(hit.x, 10) && near(hit.y, 0)).toBe(true);
  });

  it('misses when the query is outside tolerance', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    addCircle(sk, c, 10);
    expect(nearestRimPoint(sk, 20, 0, 3)).toBeNull();
  });
});
