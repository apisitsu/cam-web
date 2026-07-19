import { describe, it, expect } from 'vitest';
import {
  createSketch, addPoint, addLine, addCircle, addArc, addConstraint,
} from './model.js';
import {
  trimCircle, trimArc, sketchBounds, nearestRimPoint, circleIntersections,
  chamfer, fillet, filletLineArc, filletArcArc, tangentPoint, nearestTangent,
  deleteEntity, mirror, offsetEntity, angleSpec, interiorAngleToModel,
  axisDimensionGeometry, measureConstraint, axisFromPlacement, arcArcMeet,
  filletCircleCircle,
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

describe('mirror', () => {
  it('reflects a connected line pair across a vertical axis, sharing the reflected corner', () => {
    const sk = createSketch();
    // Axis: the y-axis (x=0). An L on the right: (2,0)-(2,5)-(6,5).
    const ax1 = addPoint(sk, 0, 0);
    const ax2 = addPoint(sk, 0, 10);
    const axis = addLine(sk, ax1, ax2);
    const a = addPoint(sk, 2, 0);
    const b = addPoint(sk, 2, 5);
    const c = addPoint(sk, 6, 5);
    const l1 = addLine(sk, a, b);
    const l2 = addLine(sk, b, c);
    const created = mirror(sk, [l1, l2], axis);
    expect(created).toHaveLength(2);
    const m1 = sk.entities.get(created[0]);
    const m2 = sk.entities.get(created[1]);
    // Mirrored L is at x = -2 / -6; the shared corner (2,5)→(-2,5) is one point.
    const pts = [m1.p1, m1.p2, m2.p1, m2.p2].map((id) => sk.entities.get(id));
    expect(pts.some((p) => near(p.x, -2) && near(p.y, 0))).toBe(true);
    expect(pts.some((p) => near(p.x, -6) && near(p.y, 5))).toBe(true);
    // The reflected shared corner is reused (only 3 distinct new points, not 4).
    const shared = new Set([m1.p1, m1.p2].filter((id) => id === m2.p1 || id === m2.p2));
    expect(shared.size).toBe(1);
    // Parametric link (SW): each original↔mirror point pair gets a symmetric relation.
    expect(sk.constraints.filter((c) => c.kind === 'symmetric').length).toBe(3);
  });

  it('mirrors an arc and keeps it a valid CCW arc', () => {
    const sk = createSketch();
    const axis = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 0, 10));
    const arc = addArc(sk, addPoint(sk, 5, 0), addPoint(sk, 8, 0), addPoint(sk, 5, 3), 3);
    const [mid] = mirror(sk, [arc], axis);
    const m = sk.entities.get(mid);
    expect(m.type).toBe('arc');
    expect(near(m.r, 3)).toBe(true);
    expect(near(sk.entities.get(m.center).x, -5)).toBe(true); // centre reflected
  });
});

describe('offsetEntity', () => {
  it('offsets a line along its normal by the given distance', () => {
    const sk = createSketch();
    const line = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0)); // along +x
    const nl = offsetEntity(sk, line, 4); // left normal = +y
    const e = sk.entities.get(nl);
    const p1 = sk.entities.get(e.p1);
    const p2 = sk.entities.get(e.p2);
    expect(near(p1.y, 4) && near(p2.y, 4)).toBe(true);
    expect(near(p1.x, 0) && near(p2.x, 10)).toBe(true);
  });

  it('offsets a circle to a concentric one and refuses a collapsing radius', () => {
    const sk = createSketch();
    const { circle } = { circle: addCircle(sk, addPoint(sk, 0, 0), 5) };
    const nc = offsetEntity(sk, circle, 3);
    expect(near(sk.entities.get(nc).r, 8)).toBe(true);
    expect(offsetEntity(sk, circle, -5)).toBeNull(); // r would be 0
  });
});

describe('angleSpec (interior corner angle)', () => {
  it('reports the interior corner angle, not the 120° directed angle', () => {
    // Horizontal line pointing INTO the vertex (R20→V) + a diagonal V→up-left at
    // 120° from +x: the corner between them is 60°, though planegcs measures 120°.
    const sk = createSketch();
    const V = addPoint(sk, 0, 0);
    const lh = addLine(sk, addPoint(sk, -10, 0), V); // dir +x (toward the vertex)
    const ld = addLine(sk, V, addPoint(sk, Math.cos((120 * Math.PI) / 180) * 10, Math.sin((120 * Math.PI) / 180) * 10));
    const spec = angleSpec(sk, lh, ld);
    expect(near(spec.interiorDeg, 60, 1e-3)).toBe(true);   // shown to the user
    expect(near(Math.abs(spec.parametric), 120, 1e-3)).toBe(true); // planegcs's directed angle
    // Entering interior 60 stores the directed value planegcs needs (±120°).
    const model = (interiorAngleToModel(spec, 60) * 180) / Math.PI;
    expect(near(Math.abs(model), 120, 1e-3)).toBe(true);
  });
});

describe('deleteEntity prune', () => {
  it('drops a deleted line\'s dangling endpoints but keeps shared ones', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    const c = addPoint(sk, 10, 10);
    const l1 = addLine(sk, a, b); // a–b
    addLine(sk, b, c); // b–c shares point b
    deleteEntity(sk, l1, true);
    // a was only used by l1 → pruned; b is still used by b–c → kept; c kept.
    expect(sk.entities.has(a)).toBe(false);
    expect(sk.entities.has(b)).toBe(true);
    expect(sk.entities.has(c)).toBe(true);
  });

  it('never prunes the origin', () => {
    const sk = createSketch();
    const o = addPoint(sk, 0, 0, true);
    sk.entities.get(o).origin = true;
    const b = addPoint(sk, 10, 0);
    const l = addLine(sk, o, b);
    deleteEntity(sk, l, true);
    expect(sk.entities.has(o)).toBe(true); // origin survives
    expect(sk.entities.has(b)).toBe(false); // stray endpoint pruned
  });
});

describe('chamfer', () => {
  // Build a square (corners A,B,C,D) with the top and left edges dimensioned, so
  // we can prove those dimensions survive a chamfer of one corner.
  const square = () => {
    const sk = createSketch();
    const A = addPoint(sk, 0, 0);
    const B = addPoint(sk, 20, 0);
    const C = addPoint(sk, 20, 20);
    const D = addPoint(sk, 0, 20);
    const top = addLine(sk, A, B); // A→B
    const right = addLine(sk, B, C); // B→C
    addLine(sk, C, D);
    addLine(sk, D, A);
    addConstraint(sk, 'distance', [A, B], 20); // top-edge width
    addConstraint(sk, 'distance', [B, C], 20); // right-edge height
    addConstraint(sk, 'horizontal', [A, B]);
    addConstraint(sk, 'vertical', [B, C]);
    return { sk, A, B, C, D, top, right };
  };

  it('keeps the corner as a virtual sharp so its dimensions stay put', () => {
    const { sk, A, B, C, top, right } = square();
    const line = chamfer(sk, top, right, 4); // chamfer corner B (shared by top & right)
    expect(line).not.toBeNull();
    // The corner survives as a construction "virtual sharp" (SW-style).
    expect(sk.entities.has(B)).toBe(true);
    expect(sk.entities.get(B).construction).toBe(true);
    // The width/height dimensions still reference B and keep their ORIGINAL value
    // (they don't recede inward): [A,B] and [B,C] are both still 20.
    const width = sk.constraints.find((c) => c.kind === 'distance' && c.refs.includes(A) && c.refs.includes(B));
    const height = sk.constraints.find((c) => c.kind === 'distance' && c.refs.includes(B) && c.refs.includes(C));
    expect(width && near(width.value, 20)).toBe(true);
    expect(height && near(height.value, 20)).toBe(true);
    // The chamfer is pinned parametrically: B on both edges + two 4 mm setbacks.
    expect(sk.constraints.filter((c) => c.kind === 'pointOnLine' && c.refs.includes(B)).length).toBe(2);
    expect(sk.constraints.filter((c) => c.kind === 'distance' && c.refs.includes(B) && c.value === 4).length).toBe(2);
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

  it('rounds a line↔arc junction with a tangent arc of the given radius', () => {
    const sk = createSketch();
    // Line along +x from the origin to the corner (10,0). Arc centred at (20,0)
    // r=10, whose leftmost point is that same corner (radius there is horizontal,
    // so the arc's tangent is vertical) — a true 90° corner, not a smooth joint.
    // The arc sweeps CCW from (10,0)@180° down to (20,−10)@270°.
    const o = addPoint(sk, 0, 0);
    const j = addPoint(sk, 10, 0); // shared corner
    const c = addPoint(sk, 20, 0);
    const e = addPoint(sk, 20, -10);
    const line = addLine(sk, o, j);
    const arc = addArc(sk, c, j, e, 10);
    const filletId = filletLineArc(sk, line, arc, 3);
    expect(filletId).not.toBeNull();
    const f = sk.entities.get(filletId);
    expect(near(f.r, 3)).toBe(true);
    expect(sk.entities.has(j)).toBe(false); // old sharp corner gone
    const fc = sk.entities.get(f.center);
    // Tangent to the line y=0 → centre sits |y| = r = 3 from it.
    expect(near(Math.abs(fc.y), 3, 1e-6)).toBe(true);
    // Tangent to the arc → |centre − arcCentre| = R ∓ r (7 or 13).
    const dToArc = Math.hypot(fc.x - 20, fc.y - 0);
    expect(near(Math.abs(dToArc - 10), 3, 1e-4)).toBe(true);
    // The line was shortened: its surviving tangent endpoint is before the corner.
    const tOnLine = [sk.entities.get(f.start), sk.entities.get(f.end)].find((p) => near(p.y, 0));
    expect(tOnLine && tOnLine.x < 10).toBe(true);
  });

  it('refuses a line↔arc fillet when they do not share a corner', () => {
    const sk = createSketch();
    const line = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 20, 0));
    const arc = addArc(sk, addPoint(sk, 50, 20), addPoint(sk, 50, 0), addPoint(sk, 70, 20), 20);
    expect(filletLineArc(sk, line, arc, 5)).toBeNull();
  });

  it('fillets where a trimmed-circle arc ends on a line interior (splits the line)', () => {
    // The reported bug: circle + overlapping rectangle, trim the circle → the arc
    // ends ON the rectangle edge (not a shared point). Fillet must still work.
    const sk = createSketch();
    const B = addPoint(sk, 20, 0);
    const Ctop = addPoint(sk, 20, 20);
    const edge = addLine(sk, B, Ctop); // vertical edge x=20
    const cc = addPoint(sk, 20, 10);
    const circle = addCircle(sk, cc, 6);
    const trim = trimCircle(sk, circle, 14, 10); // keep the x>20 bulge
    const arc = sk.entities.get(trim.added);
    // Arc endpoints sit on the edge interior, sharing no point id with it.
    expect([edge].some(() => {
      const l = sk.entities.get(edge);
      return [l.p1, l.p2].some((id) => id === arc.start || id === arc.end);
    })).toBe(false);
    const nEntities = sk.entities.size;
    const filletId = filletLineArc(sk, edge, trim.added, 2);
    expect(filletId).not.toBeNull(); // was null before the fix
    const f = sk.entities.get(filletId);
    expect(f.type).toBe('arc');
    expect(near(f.r, 2)).toBe(true);
    // The line was split (a new leg segment was added) and the fillet is tangent
    // to the edge: its centre sits |x-20| = r = 2 from the edge line.
    expect(sk.entities.size).toBeGreaterThan(nEntities);
    expect(near(Math.abs(sk.entities.get(f.center).x - 20), 2, 1e-6)).toBe(true);
  });

  it('fillets when the line endpoint and arc endpoint coincide but are distinct points', () => {
    // Drawn to the same spot, never merged (the reported screenshot case): the arc
    // starts at (10,0) tangent-vertical; a horizontal line ends ~there as its own point.
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    const s = addPoint(sk, 10, 0);
    const e = addPoint(sk, 0, 10);
    const arc = addArc(sk, c, s, e, 10);
    const lend = addPoint(sk, 10.0005, 0); // coincident-ish, different id
    const line = addLine(sk, addPoint(sk, 25, 0), lend);
    const filletId = filletLineArc(sk, line, arc, 2, 1.5);
    expect(filletId).not.toBeNull();
    expect(near(sk.entities.get(filletId).r, 2)).toBe(true);
    // Both stray coincident points are cleaned up (line/arc re-pointed to tangents).
    expect(sk.entities.has(lend)).toBe(false);
    expect(sk.entities.has(s)).toBe(false);
  });

  it('rounds an arc↔arc junction with a tangent arc', () => {
    const sk = createSketch();
    // Two arcs meeting at the origin, each r=20, centres above and to the side.
    const j = addPoint(sk, 0, 0); // shared corner
    const c1 = addPoint(sk, 0, 20);
    const e1 = addPoint(sk, -20, 20);
    const c2 = addPoint(sk, 20, 0);
    const e2 = addPoint(sk, 20, -20);
    const arc1 = addArc(sk, c1, e1, j, 20); // ...→ (0,0)
    const arc2 = addArc(sk, c2, j, e2, 20); // (0,0) →...
    const filletId = filletArcArc(sk, arc1, arc2, 4);
    expect(filletId).not.toBeNull();
    const f = sk.entities.get(filletId);
    expect(near(f.r, 4)).toBe(true);
    expect(sk.entities.has(j)).toBe(false);
    // Tangent to both arcs: centre distance to each arc centre = R ∓ r.
    const fc = sk.entities.get(f.center);
    const d1 = Math.hypot(fc.x - 0, fc.y - 20);
    const d2 = Math.hypot(fc.x - 20, fc.y - 0);
    expect(near(Math.abs(d1 - 20), 4, 1e-4)).toBe(true);
    expect(near(Math.abs(d2 - 20), 4, 1e-4)).toBe(true);
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

describe('axisDimensionGeometry — dimension lines locked to an axis', () => {
  // The whole point of distanceX/distanceY: the drawn dimension line must run
  // along the axis, never diagonally between the two points.
  it('a horizontal (dX) dimension line has constant y', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 100, 40); // diagonal pair
    const g = axisDimensionGeometry(sk, 'distanceX', [a, b]);
    expect(g.horiz).toBe(true);
    expect(near(g.line[0].y, g.line[1].y)).toBe(true); // on-axis
    expect(near(g.line[0].x, 0)).toBe(true);
    expect(near(g.line[1].x, 100)).toBe(true);
    expect(near(g.span, 100)).toBe(true);
    expect(g.line[0].y < 0).toBe(true); // stood off below the lower point
  });

  it('a vertical (dY) dimension line has constant x', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 100, 40);
    const g = axisDimensionGeometry(sk, 'distanceY', [a, b]);
    expect(g.horiz).toBe(false);
    expect(near(g.line[0].x, g.line[1].x)).toBe(true); // on-axis
    expect(near(g.span, 40)).toBe(true);
    expect(g.line[0].x > 100).toBe(true); // stood off right of the rightmost point
  });

  it('witness lines connect each measured point to the dimension line', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 100, 40);
    const g = axisDimensionGeometry(sk, 'distanceX', [a, b]);
    const [w1, w2] = g.witness;
    expect(near(w1[0].x, 0) && near(w1[0].y, 0)).toBe(true); // starts at the point
    expect(near(w1[1].y, g.line[0].y)).toBe(true); // lands on the dimension line
    expect(near(w1[1].x, w1[0].x)).toBe(true); // dropped straight down
    expect(near(w2[0].x, 100) && near(w2[0].y, 40)).toBe(true);
    expect(near(w2[1].y, g.line[0].y)).toBe(true);
  });

  it('the label sits mid-span on the dimension line', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 100, 40);
    const g = axisDimensionGeometry(sk, 'distanceX', [a, b]);
    expect(near(g.label.x, 50)).toBe(true);
    expect(near(g.label.y, g.line[0].y)).toBe(true);
  });

  it('measureConstraint reports the signed axis gap, not the true distance', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 3, 4); // true distance 5
    expect(near(measureConstraint(sk, 'distanceX', [a, b]), 3)).toBe(true);
    expect(near(measureConstraint(sk, 'distanceY', [a, b]), 4)).toBe(true);
    expect(near(measureConstraint(sk, 'distanceX', [b, a]), -3)).toBe(true); // signed
  });

  it('returns null for a missing point', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    expect(axisDimensionGeometry(sk, 'distanceX', [a, 999])).toBeNull();
  });
});

describe('axisFromPlacement — SolidWorks-style orientation from the placement point', () => {
  // A diagonal pair, so all three orientations are genuinely distinct.
  const diag = () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 100, 40);
    return { sk, a, b };
  };

  it('placing below the pair gives a horizontal (dX) dimension', () => {
    const { sk, a, b } = diag();
    expect(axisFromPlacement(sk, a, b, { x: 50, y: -60 })).toBe('x');
  });

  it('placing above the pair also gives dX', () => {
    const { sk, a, b } = diag();
    expect(axisFromPlacement(sk, a, b, { x: 50, y: 90 })).toBe('x');
  });

  it('placing out to the side gives a vertical (dY) dimension', () => {
    const { sk, a, b } = diag();
    expect(axisFromPlacement(sk, a, b, { x: 180, y: 20 })).toBe('y');
    expect(axisFromPlacement(sk, a, b, { x: -90, y: 20 })).toBe('y');
  });

  it('placing square off the line itself gives the aligned dimension', () => {
    const { sk, a, b } = diag();
    // Perpendicular to the 100×40 pair, offset from its midpoint.
    const len = Math.hypot(100, 40);
    const px = -40 / len;
    const py = 100 / len;
    expect(axisFromPlacement(sk, a, b, { x: 50 + px * 40, y: 20 + py * 40 })).toBe('aligned');
  });

  it('an already-horizontal pair resolves ties to aligned', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 100, 0);
    // Below the pair: aligned and dX are the same measurement here.
    expect(axisFromPlacement(sk, a, b, { x: 50, y: -30 })).toBe('aligned');
    // Out to the side is still unambiguously dY.
    expect(axisFromPlacement(sk, a, b, { x: 200, y: 0 })).toBe('y');
  });

  it('a vertical pair placed to the side stays aligned (which is already dY)', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 0, 100);
    // Aligned and dY measure the same 100 here, so the tie resolving to the
    // simpler 'aligned' is correct — dX would be a useless zero dimension.
    expect(axisFromPlacement(sk, a, b, { x: 60, y: 50 })).toBe('aligned');
  });

  it('falls back to aligned with no placement or a degenerate one', () => {
    const { sk, a, b } = diag();
    expect(axisFromPlacement(sk, a, b, null)).toBe('aligned');
    expect(axisFromPlacement(sk, a, b, { x: 50, y: 20 })).toBe('aligned'); // the midpoint
    expect(axisFromPlacement(sk, a, 999, { x: 0, y: 0 })).toBe('aligned');
  });
});

describe('filletArcArc — corner modes between two curves', () => {
  /**
   * Two overlapping circles trimmed into a lens: arc1 is the right bulge of a
   * circle at (0,0) r50, arc2 the left bulge of one at (80,0) r50. They cross at
   * (40, ±30). `merged` controls whether the touching endpoints are the same
   * point id (as if drawn merged) or two distinct points at the same spot (what
   * trimming two circles actually leaves behind).
   */
  const lens = ({ merged }) => {
    const sk = createSketch();
    const c1 = addPoint(sk, 0, 0);
    const c2 = addPoint(sk, 80, 0);
    const low1 = addPoint(sk, 40, -30);
    const top1 = addPoint(sk, 40, 30);
    const top2 = merged ? top1 : addPoint(sk, 40, 30);
    const low2 = merged ? low1 : addPoint(sk, 40, -30);
    const arc1 = addArc(sk, c1, low1, top1, 50); // CCW through (50,0)
    const arc2 = addArc(sk, c2, top2, low2, 50); // CCW through (30,0)
    return { sk, arc1, arc2, top1, top2 };
  };

  it('fillets a corner where the two arcs share an endpoint id', () => {
    const { sk, arc1, arc2 } = lens({ merged: true });
    const f = filletArcArc(sk, arc1, arc2, 5);
    expect(f).not.toBeNull();
    const arc = sk.entities.get(f);
    expect(near(arc.r, 5)).toBe(true);
  });

  /** The fillet must be genuinely tangent to both arcs: its centre sits at
   *  R∓r from each arc's centre. */
  const assertTangent = (sk, filletId, arcIds, r) => {
    const f = sk.entities.get(filletId);
    const fc = sk.entities.get(f.center);
    for (const id of arcIds) {
      const a = sk.entities.get(id);
      const ac = sk.entities.get(a.center);
      const d = Math.hypot(fc.x - ac.x, fc.y - ac.y);
      const tangent = near(d, a.r - r, 1e-6) || near(d, a.r + r, 1e-6);
      expect(tangent).toBe(true);
    }
  };

  it('fillets a corner where the endpoints are coincident but distinct points', () => {
    // This is the case trimming two circles leaves behind — it used to return
    // null, so R simply could not be applied between two curves.
    const { sk, arc1, arc2 } = lens({ merged: false });
    const f = filletArcArc(sk, arc1, arc2, 5);
    expect(f).not.toBeNull();
    expect(near(sk.entities.get(f).r, 5)).toBe(true);
    assertTangent(sk, f, [arc1, arc2], 5);
  });

  it('fillets the corner nearest where the user clicked, not just the first one', () => {
    // A lens has TWO corners, (40,30) and (40,-30). Without a hint the pick is
    // arbitrary; the hint is the chamfer tool's last click.
    for (const corner of [{ x: 40, y: 30 }, { x: 40, y: -30 }]) {
      const { sk, arc1, arc2 } = lens({ merged: false });
      const f = filletArcArc(sk, arc1, arc2, 5, undefined, corner);
      expect(f).not.toBeNull();
      const fc = sk.entities.get(sk.entities.get(f).center);
      // The fillet centre must land near the corner that was pointed at, not the
      // one 60mm away on the other side.
      expect(Math.hypot(fc.x - corner.x, fc.y - corner.y) < 20).toBe(true);
      assertTangent(sk, f, [arc1, arc2], 5);
    }
  });

  it('returns null when the two arcs never come near each other', () => {
    const sk = createSketch();
    const a1 = addArc(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0), addPoint(sk, 0, 10), 10);
    const a2 = addArc(sk, addPoint(sk, 500, 0), addPoint(sk, 510, 0), addPoint(sk, 500, 10), 10);
    expect(filletArcArc(sk, a1, a2, 3)).toBeNull();
  });

  it('arcArcMeet reports whether a fillet corner exists at all', () => {
    const merged = lens({ merged: true });
    expect(arcArcMeet(merged.sk, merged.arc1, merged.arc2)).toBe(true);
    const apart = lens({ merged: false });
    expect(arcArcMeet(apart.sk, apart.arc1, apart.arc2)).toBe(true);
    const sk = createSketch();
    const a1 = addArc(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0), addPoint(sk, 0, 10), 10);
    const a2 = addArc(sk, addPoint(sk, 500, 0), addPoint(sk, 510, 0), addPoint(sk, 500, 10), 10);
    expect(arcArcMeet(sk, a1, a2)).toBe(false);
  });
});

describe('filletCircleCircle — fillet two whole circles, auto-trimming them', () => {
  /** Two r50 circles 80 apart, crossing at (40, ±30). */
  const pair = () => {
    const sk = createSketch();
    const c1 = addCircle(sk, addPoint(sk, 0, 0), 50);
    const c2 = addCircle(sk, addPoint(sk, 80, 0), 50);
    return { sk, c1, c2 };
  };
  const ofKind = (sk, t) => [...sk.entities.values()].filter((e) => e.type === t);

  it('replaces both circles with arcs plus a tangent fillet', () => {
    const { sk, c1, c2 } = pair();
    const res = filletCircleCircle(sk, c1, c2, 8, { x: 40, y: 30 });
    expect(res).not.toBeNull();
    expect(ofKind(sk, 'circle').length).toBe(0); // both were trimmed away
    expect(ofKind(sk, 'arc').length).toBe(3); // two trimmed arcs + the fillet
    const f = sk.entities.get(res.fillet);
    expect(near(f.r, 8)).toBe(true);
    // Tangency: the fillet centre sits at R∓r from each original centre.
    const fc = sk.entities.get(f.center);
    for (const [cx, cy] of [[0, 0], [80, 0]]) {
      const d = Math.hypot(fc.x - cx, fc.y - cy);
      expect(near(d, 50 - 8, 1e-6) || near(d, 50 + 8, 1e-6)).toBe(true);
    }
  });

  it('rounds the crossing nearest the pick', () => {
    for (const pick of [{ x: 40, y: 30 }, { x: 40, y: -30 }]) {
      const { sk, c1, c2 } = pair();
      const res = filletCircleCircle(sk, c1, c2, 8, pick);
      const fc = sk.entities.get(sk.entities.get(res.fillet).center);
      expect(Math.hypot(fc.x - pick.x, fc.y - pick.y) < 25).toBe(true);
    }
  });

  it('keeps the half each circle was picked on', () => {
    const { sk, c1, c2 } = pair();
    // Pick the inner (lens) side of each circle: near (40,0) from both.
    const res = filletCircleCircle(sk, c1, c2, 5, { x: 40, y: 30 }, {
      [c1]: { x: 50, y: 0 }, // circle 1's right-hand side, inside circle 2
      [c2]: { x: 30, y: 0 }, // circle 2's left-hand side, inside circle 1
    });
    expect(res).not.toBeNull();
    const covers = (arcId, px, py) => {
      const arc = sk.entities.get(arcId);
      const c = sk.entities.get(arc.center);
      const s = sk.entities.get(arc.start);
      const e = sk.entities.get(arc.end);
      const TAU = Math.PI * 2;
      const n = (x) => ((x % TAU) + TAU) % TAU;
      const a0 = n(Math.atan2(s.y - c.y, s.x - c.x));
      const sweep = n(n(Math.atan2(e.y - c.y, e.x - c.x)) - a0) || TAU;
      return n(n(Math.atan2(py - c.y, px - c.x)) - a0) <= sweep;
    };
    expect(covers(res.arcs[0], 50, 0)).toBe(true); // the picked side survived
    expect(covers(res.arcs[0], -50, 0)).toBe(false); // the far side was trimmed
  });

  it('defaults to keeping the outer (blob) halves when nothing was picked', () => {
    const { sk, c1, c2 } = pair();
    const res = filletCircleCircle(sk, c1, c2, 8, { x: 40, y: 30 });
    // The kept arc of circle 1 must still cover its far side (180°, i.e. (-50,0))
    // and must NOT cover the rounded corner at (40,30).
    const a1 = sk.entities.get(res.arcs[0]);
    const span = (arc, px, py) => {
      const c = sk.entities.get(arc.center);
      const s = sk.entities.get(arc.start);
      const e = sk.entities.get(arc.end);
      const TAU = Math.PI * 2;
      const n = (x) => ((x % TAU) + TAU) % TAU;
      const a0 = n(Math.atan2(s.y - c.y, s.x - c.x));
      const sweep = n(n(Math.atan2(e.y - c.y, e.x - c.x)) - a0) || TAU;
      return n(n(Math.atan2(py - c.y, px - c.x)) - a0) <= sweep;
    };
    expect(span(a1, -50, 0)).toBe(true); // far side kept
    expect(span(a1, 40, 30)).toBe(false); // corner trimmed off
  });

  it('carries a diameter dimension over to the trimmed arc as a radius', () => {
    const { sk, c1, c2 } = pair();
    addConstraint(sk, 'diameter', [c1], 100);
    const res = filletCircleCircle(sk, c1, c2, 8, { x: 40, y: 30 });
    const dim = sk.constraints.find((c) => c.kind === 'arcRadius' && c.refs[0] === res.arcs[0]);
    expect(dim).toBeTruthy();
    expect(near(dim.value, 50)).toBe(true); // Ø100 → R50
    expect(sk.constraints.some((c) => c.kind === 'diameter')).toBe(false);
  });

  it('refuses circles that do not genuinely cross', () => {
    const sk = createSketch();
    const a = addCircle(sk, addPoint(sk, 0, 0), 10);
    const b = addCircle(sk, addPoint(sk, 500, 0), 10); // far apart
    expect(filletCircleCircle(sk, a, b, 3, null)).toBeNull();
    const t1 = addCircle(sk, addPoint(sk, 0, 200), 10);
    const t2 = addCircle(sk, addPoint(sk, 20, 200), 10); // exactly tangent
    expect(filletCircleCircle(sk, t1, t2, 3, null)).toBeNull();
  });
});
