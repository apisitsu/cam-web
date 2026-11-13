import { describe, it, expect } from 'vitest';
import {
  ellipsePoints, splinePoints, curveOf, hitTestCurve,
} from './curves.js';
import {
  createSketch, addPoint, addEllipse, addSpline, addLine,
} from './model.js';
import { deleteEntity, entitiesInBox } from './edit.js';
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
