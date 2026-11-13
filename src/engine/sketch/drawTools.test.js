import { describe, it, expect } from 'vitest';
import {
  buildCenterRectangle, circleThrough3, buildArc3, buildTangentArc, extendLine, leavingDirection,
} from './drawTools.js';
import {
  createSketch, addPoint, addLine, addCircle, addArc,
} from './model.js';

const P = (sk, id) => sk.entities.get(id);

describe('Center Rectangle', () => {
  it('builds four lines about the centre, held by a construction diagonal', () => {
    const sk = createSketch();
    const c = addPoint(sk, 10, 5);
    const r = buildCenterRectangle(sk, c, 30, 15);
    expect(r.lines).toHaveLength(4);
    const corners = r.lines.map((l) => P(sk, P(sk, l).p1));
    expect(corners.map((p) => [p.x, p.y])).toEqual([[-10, -5], [30, -5], [30, 15], [-10, 15]]);
    expect(P(sk, r.diagonal).construction).toBe(true);
    expect(sk.constraints.some((k) => k.kind === 'midpoint')).toBe(true);
  });

  it('refuses a rectangle with no width or height', () => {
    const sk = createSketch();
    expect(buildCenterRectangle(sk, addPoint(sk, 0, 0), 5, 0)).toBe(null);
  });
});

describe('3-Point Arc', () => {
  it('finds the circle through three points', () => {
    const c = circleThrough3({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 });
    expect(c.x).toBeCloseTo(0, 9);
    expect(c.y).toBeCloseTo(0, 9);
    expect(c.r).toBeCloseTo(10, 9);
    expect(circleThrough3({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBe(null);
  });

  it('runs through the third point whichever side it is on', () => {
    for (const [mx, my, wantStart] of [[0, 10, 'a'], [0, -10, 'b']]) {
      const sk = createSketch();
      const a = addPoint(sk, 10, 0);
      const b = addPoint(sk, -10, 0);
      const arc = P(sk, buildArc3(sk, a, b, mx, my));
      expect(arc.r).toBeCloseTo(10, 9);
      // CCW from start to end: over the top starts at +X, under the bottom at −X.
      expect(arc.start).toBe(wantStart === 'a' ? a : b);
    }
  });

  it('refuses three points in a line', () => {
    const sk = createSketch();
    expect(buildArc3(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0), 5, 0)).toBe(null);
  });
});

describe('Tangent Arc', () => {
  it('leaves the end of a line in the line\'s own direction', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    const line = addLine(sk, a, b);
    expect(leavingDirection(sk, line, b)).toEqual([1, 0]);
    // A half turn up to (10, 10): centre (10, 5), radius 5, turning left (CCW).
    const arc = P(sk, buildTangentArc(sk, line, b, 10, 10));
    expect(arc.r).toBeCloseTo(5, 9);
    expect(P(sk, arc.center).x).toBeCloseTo(10, 9);
    expect(P(sk, arc.center).y).toBeCloseTo(5, 9);
    expect(arc.start).toBe(b);
    expect(sk.constraints.some((k) => k.kind === 'tangentArc')).toBe(true);
  });

  it('turns right as well, and refuses a point straight ahead', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    const line = addLine(sk, a, b);
    const arc = P(sk, buildTangentArc(sk, line, b, 10, -10));
    expect(arc.end).toBe(b); // clockwise from the line = CCW from the far end
    expect(buildTangentArc(sk, line, b, 20, 0)).toBe(null);
  });

  it('carries on from the end of an arc', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    const s = addPoint(sk, 10, 0);
    const e = addPoint(sk, 0, 10);
    const arc = addArc(sk, c, s, e, 10);
    expect(leavingDirection(sk, arc, e).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([-1, 0]);
    const next = buildTangentArc(sk, arc, e, -10, 20);
    expect(next).not.toBe(null);
    expect(sk.constraints.some((k) => k.kind === 'tangentArcArc')).toBe(true);
  });
});

describe('Extend', () => {
  it('runs a free end on to the next line it meets', () => {
    const sk = createSketch();
    const l = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 5, 0));
    addLine(sk, addPoint(sk, 20, -5), addPoint(sk, 20, 5));
    const out = extendLine(sk, l, 4, 0);
    expect(out.x).toBeCloseTo(20, 9);
    expect(P(sk, P(sk, l).p2).x).toBeCloseTo(20, 9);
  });

  it('stops at the nearer of a circle and a line beyond it', () => {
    const sk = createSketch();
    const l = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 5, 0));
    addLine(sk, addPoint(sk, 30, -5), addPoint(sk, 30, 5));
    addCircle(sk, addPoint(sk, 20, 0), 4);
    expect(extendLine(sk, l, 5, 0).x).toBeCloseTo(16, 9);
  });

  it('extends the end nearer the click, and says why when it cannot', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const l = addLine(sk, a, addPoint(sk, 5, 0));
    addLine(sk, addPoint(sk, -10, -5), addPoint(sk, -10, 5));
    expect(extendLine(sk, l, 1, 0).x).toBeCloseTo(-10, 9);
    const sk2 = createSketch();
    const l2 = addLine(sk2, addPoint(sk2, 0, 0), addPoint(sk2, 5, 0));
    expect(extendLine(sk2, l2, 5, 0).error).toMatch(/Nothing/);
    const corner = addPoint(sk2, 9, 9);
    const l3 = addLine(sk2, addPoint(sk2, 0, 9), corner);
    addLine(sk2, corner, addPoint(sk2, 9, 20));
    expect(extendLine(sk2, l3, 9, 9).error).toMatch(/joined/);
  });
});
