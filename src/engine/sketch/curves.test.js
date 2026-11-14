import { describe, it, expect } from 'vitest';
import {
  ellipsePoints, splinePoints, curveOf, hitTestCurve, curveAt, syncCurves, polylineDistance,
} from './curves.js';
import {
  createSketch, addPoint, addEllipse, addSpline, addLine, addCircle, addConstraint,
} from './model.js';
import {
  deleteEntity, entitiesInBox, trimLine, trimCurve, trimCircle, offsetChain, mirror,
  snapshotEntities, hydrateSnapshot, entityIntersections,
} from './edit.js';
import { sketchRegions } from './loops.js';
import { sketchToDxf } from './dxf.js';

const area = (flat) => {
  let a = 0;
  for (let i = 0, n = flat.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1];
  }
  return a / 2;
};

describe('ellipse', () => {
  it('runs round the centre with the major axis along the point given', () => {
    const pts = ellipsePoints({ x: 0, y: 0 }, { x: 0, y: 10 }, 4);
    expect(pts[0]).toBeCloseTo(0, 9);
    expect(pts[1]).toBeCloseTo(10, 9);
    expect(Math.abs(area(pts))).toBeCloseTo(Math.PI * 40, 0);
  });

  it('is a closed profile an extrude can use, and goes with its centre', () => {
    const sk = createSketch();
    const c = addPoint(sk, 5, 5);
    const m = addPoint(sk, 25, 5);
    const e = addEllipse(sk, c, m, 8);
    const { regions } = sketchRegions(sk);
    expect(regions).toHaveLength(1);
    expect(regions[0].area).toBeCloseTo(Math.PI * 20 * 8, -1);
    expect(hitTestCurve(sk, 5, 13, 0.5)).toBe(e);
    expect(entitiesInBox(sk, -20, -10, 30, 20)).toEqual([e]);
    deleteEntity(sk, c);
    expect(sk.entities.has(e)).toBe(false);
  });
});

describe('spline', () => {
  it('passes through every point it is drawn through', () => {
    const P = [[0, 0], [10, 5], [20, -5], [30, 0]];
    const flat = splinePoints(P);
    for (const [x, y] of P) {
      let hit = false;
      for (let i = 0; i < flat.length; i += 2) if (Math.hypot(flat[i] - x, flat[i + 1] - y) < 1e-9) hit = true;
      expect(hit).toBe(true);
    }
  });

  it('an open spline closed by a line makes a profile; a closed one is one by itself', () => {
    const sk = createSketch();
    const ids = [[0, 0], [10, 8], [20, 8], [30, 0]].map(([x, y]) => addPoint(sk, x, y));
    addSpline(sk, ids);
    addLine(sk, ids[3], ids[0]);
    expect(sketchRegions(sk).regions).toHaveLength(1);

    const sk2 = createSketch();
    const ring = [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => addPoint(sk2, x, y));
    const s = addSpline(sk2, ring, true);
    expect(curveOf(sk2, sk2.entities.get(s)).closed).toBe(true);
    expect(sketchRegions(sk2).regions).toHaveLength(1);
    expect(sketchToDxf(sk2)).toMatch(/LINE/);
  });
});

/** Ellipse round the origin, half-axes 20 (along X) and 10, and a line x = 10 across it. */
function ellipseAndChord() {
  const sk = createSketch();
  const e = addEllipse(sk, addPoint(sk, 0, 0), addPoint(sk, 20, 0), 10);
  const l = addLine(sk, addPoint(sk, 10, -20), addPoint(sk, 10, 20));
  return { sk, e, l };
}

describe('trim, offset and mirror on curves', () => {
  it('trims an ellipse and a line against each other into one closed profile', () => {
    const { sk, e, l } = ellipseAndChord();
    expect(entityIntersections(sk, sk.entities.get(e), sk.entities.get(l))).toHaveLength(2);
    expect(trimCurve(sk, e, 20, 0)).not.toBeNull();
    const el = sk.entities.get(e);
    expect(el.range).toBeTruthy();
    // The ends sit exactly on the line, where it crosses the ellipse.
    for (const id of el.ends) {
      const p = sk.entities.get(id);
      expect(p.x).toBeCloseTo(10, 9);
      expect(Math.abs(p.y)).toBeCloseTo(10 * Math.sqrt(0.75), 9);
    }
    trimLine(sk, l, 10, 15);
    trimLine(sk, l, 10, -15);
    // The line ends on the ellipse's own end points: one joint, not two.
    const line = sk.entities.get(l);
    expect([line.p1, line.p2].sort()).toEqual(el.ends.slice().sort());
    const { regions } = sketchRegions(sk);
    expect(regions).toHaveLength(1);
    // Ellipse area less the cap past x = 10: ab(π − (φ − sinφ cosφ)), φ = 60°.
    const phi = Math.PI / 3;
    expect(regions[0].area).toBeCloseTo(200 * (Math.PI - (phi - Math.sin(phi) * Math.cos(phi))), -1);
  });

  it('keeps trimmed ends on the curve when its centre moves', () => {
    const { sk, e } = ellipseAndChord();
    trimCurve(sk, e, 20, 0);
    const el = sk.entities.get(e);
    sk.entities.get(el.center).x += 5;
    sk.entities.get(el.major).x += 5;
    syncCurves(sk);
    el.ends.forEach((id, k) => {
      const q = curveAt(sk, el, el.range[k]);
      expect(sk.entities.get(id).x).toBeCloseTo(q.x, 12);
    });
  });

  it('shortens an open spline at a crossing, and splits it in the middle', () => {
    const sk = createSketch();
    const s = addSpline(sk, [[0, 0], [10, 6], [20, -6], [30, 0]].map(([x, y]) => addPoint(sk, x, y)));
    addLine(sk, addPoint(sk, 5, -20), addPoint(sk, 5, 20));
    addLine(sk, addPoint(sk, 25, -20), addPoint(sk, 25, 20));
    const mid = trimCurve(sk, s, 15, 0);
    expect(mid.added).not.toBeNull();
    const a = sk.entities.get(s); const b = sk.entities.get(mid.added);
    expect(sk.entities.get(a.ends[1]).x).toBeCloseTo(5, 9);
    expect(sk.entities.get(b.ends[0]).x).toBeCloseTo(25, 9);
    expect(trimCurve(sk, s, 1, 0)).toBeNull(); // nothing crosses what is left of it
  });

  it('cuts a line and a circle where a spline crosses them', () => {
    const sk = createSketch();
    addSpline(sk, [[-20, -5], [0, 5], [20, -5]].map(([x, y]) => addPoint(sk, x, y)));
    const l = addLine(sk, addPoint(sk, 0, -20), addPoint(sk, 0, 20));
    const c = addCircle(sk, addPoint(sk, 0, 30), 30);
    expect(trimLine(sk, l, 0, 15)).not.toBeNull();
    expect(sk.entities.get(sk.entities.get(l).p2).y).toBeCloseTo(5, 9);
    expect(trimCircle(sk, c, 0, 60)).not.toBeNull();
  });

  it('offsets an ellipse to a spline the distance off it all round', () => {
    const sk = createSketch();
    const e = addEllipse(sk, addPoint(sk, 0, 0), addPoint(sk, 20, 0), 10);
    const [o] = offsetChain(sk, [e], -2); // left of a CCW ring is inside: −2 goes out
    const off = curveOf(sk, sk.entities.get(o));
    expect(off.closed).toBe(true);
    const ring = curveOf(sk, sk.entities.get(e));
    for (let i = 0; i < off.points.length; i += 2) {
      expect(polylineDistance(ring.points, true, off.points[i], off.points[i + 1])).toBeCloseTo(2, 1);
    }
  });

  it('offsets a line and a spline as one chain, joined at their corner', () => {
    const sk = createSketch();
    const p0 = addPoint(sk, 0, 0); const p1 = addPoint(sk, 20, 0);
    const l = addLine(sk, p0, p1);
    const s = addSpline(sk, [p1, addPoint(sk, 25, 10), addPoint(sk, 20, 20)]);
    const [ol, os] = offsetChain(sk, [l, s], 1);
    const line = sk.entities.get(ol); const sp = sk.entities.get(os);
    expect(sp.pts[0]).toBe(line.p2);
  });

  it('mirrors a trimmed ellipse onto its reflection', () => {
    const { sk, e } = ellipseAndChord();
    trimCurve(sk, e, 20, 0);
    const axis = addLine(sk, addPoint(sk, -30, -40), addPoint(sk, -30, 40));
    const [m] = mirror(sk, [e], axis);
    const a = curveOf(sk, sk.entities.get(e));
    const b = curveOf(sk, sk.entities.get(m));
    for (let i = 0; i < b.points.length; i += 2) {
      expect(polylineDistance(a.points, false, -60 - b.points[i], b.points[i + 1])).toBeLessThan(1e-6);
    }
  });

  it('copies a spline and an ellipse with their points', () => {
    const sk = createSketch();
    const e = addEllipse(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0), 4);
    const s = addSpline(sk, [[0, 0], [5, 5], [10, 0]].map(([x, y]) => addPoint(sk, x, y)));
    const snap = snapshotEntities(sk, [e, s]);
    const made = hydrateSnapshot(sk, snap, (x, y) => ({ x: x + 50, y }));
    const types = made.map((id) => sk.entities.get(id).type);
    expect(types).toEqual(['ellipse', 'spline']);
    expect(curveAt(sk, sk.entities.get(made[0]), 0).x).toBeCloseTo(60, 9);
  });

  it('sizes an ellipse minor radius by its dimension', () => {
    const sk = createSketch();
    const e = addEllipse(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0), 4);
    addConstraint(sk, 'ellipseMinor', [e], 6);
    syncCurves(sk);
    expect(sk.entities.get(e).rb).toBe(6);
  });
});

describe('many curves', () => {
  it('finds the profiles of 600 curves without trying every pair segment by segment', () => {
    const sk = createSketch();
    for (let i = 0; i < 300; i++) {
      const x = (i % 20) * 30; const y = Math.floor(i / 20) * 30;
      addEllipse(sk, addPoint(sk, x, y), addPoint(sk, x + 10, y + 3), 5);
      addSpline(sk, [[0, 0], [4, 6], [8, -6], [12, 6], [16, 0]].map(([a, b]) => addPoint(sk, x + a - 8, y + b + 12)));
    }
    const t = performance.now();
    expect(sketchRegions(sk).regions).toHaveLength(300);
    expect(performance.now() - t).toBeLessThan(3000); // was 8.7 s
  });
});
