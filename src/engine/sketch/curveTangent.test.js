/**
 * Tangent relations on ellipses and splines, solved by the real planegcs.
 */
import {
  describe, it, expect, beforeAll,
} from 'vitest';
import { createRequire } from 'node:module';
import { createSolver } from './planegcs.js';
import {
  createSketch, addPoint, addLine, addArc, addEllipse, addSpline, addConstraint,
} from './model.js';
import { curveAt, curveTangent } from './curves.js';
import { relationsFor } from './relations.js';

let solver;
beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm');
  const initModule = async (opts) => (await import('@salusoft89/planegcs/dist/planegcs_dist/planegcs.js')).default(opts);
  solver = await createSolver({ wasmPath, initModule });
});

const P = (sk, id) => sk.entities.get(id);
/** Smallest distance from the ellipse to the line's infinite line, signed by side; 0 when it touches. */
function gap(sk, lineId, ellipseId) {
  const l = P(sk, lineId);
  const a = P(sk, l.p1); const b = P(sk, l.p2);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let min = Infinity;
  for (let i = 0; i < 3600; i++) {
    const p = curveAt(sk, P(sk, ellipseId), (2 * Math.PI * i) / 3600);
    min = Math.min(min, ((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / len);
  }
  return Math.abs(min);
}

describe('Tangent with curves', () => {
  it('moves a line onto an ellipse until it touches', () => {
    const sk = createSketch();
    const e = addEllipse(sk, addPoint(sk, 0, 0, true), addPoint(sk, 20, 0, true), 10);
    const l = addLine(sk, addPoint(sk, -30, 14), addPoint(sk, 30, 16));
    expect(relationsFor(sk, [l, e]).map((r) => r.key)).toContain('tangent');
    addConstraint(sk, 'tangentEllipse', [l, e]);
    expect(solver.solve(sk).success).toBe(true);
    expect(gap(sk, l, e)).toBeLessThan(1e-3);
    expect(P(sk, e).rb).toBeGreaterThan(0);
  });

  it('holds the minor radius its dimension gives while the line stays tangent', () => {
    const sk = createSketch();
    const e = addEllipse(sk, addPoint(sk, 0, 0, true), addPoint(sk, 20, 0, true), 10);
    const l = addLine(sk, addPoint(sk, -30, 14, true), addPoint(sk, 30, 14, true));
    addConstraint(sk, 'tangentEllipse', [l, e]);
    expect(solver.solve(sk).success).toBe(true);
    expect(P(sk, e).rb).toBeCloseTo(14, 6); // only the minor radius can move to touch y = 14
    addConstraint(sk, 'ellipseMinor', [e], 14);
    expect(solver.solve(sk).success).toBe(true);
  });

  it('runs a line, an arc and another spline smoothly into a spline end', () => {
    const sk = createSketch();
    const s0 = addPoint(sk, 0, 0, true);
    const sp = addSpline(sk, [s0, addPoint(sk, 10, 8), addPoint(sk, 20, 0)]);
    const l = addLine(sk, addPoint(sk, -20, -5), s0);
    expect(relationsFor(sk, [l, sp]).map((r) => r.key)).toContain('tangent');
    addConstraint(sk, 'tangentSpline', [l, sp]);
    expect(solver.solve(sk).success).toBe(true);
    const line = P(sk, l);
    const a = P(sk, line.p1);
    const ld = { x: P(sk, s0).x - a.x, y: P(sk, s0).y - a.y };
    const t = curveTangent(sk, P(sk, sp), 0);
    expect(Math.abs(ld.x * t.y - ld.y * t.x) / Math.hypot(ld.x, ld.y)).toBeLessThan(1e-6);

    // An arc ending on the spline's far end.
    const end = P(sk, sp).pts[2];
    const arc = addArc(sk, addPoint(sk, 30, 5), end, addPoint(sk, 35, 5 + Math.sqrt(125 - 25)), Math.sqrt(125));
    addConstraint(sk, 'tangentSpline', [arc, sp]);
    expect(solver.solve(sk).success).toBe(true);
    const c = P(sk, P(sk, arc).center); const e2 = P(sk, end);
    const t2 = curveTangent(sk, P(sk, sp), 2);
    expect(Math.abs((e2.x - c.x) * t2.x + (e2.y - c.y) * t2.y) / Math.hypot(e2.x - c.x, e2.y - c.y)).toBeLessThan(1e-6);

    // A second spline from the first one's start.
    const sp2 = addSpline(sk, [s0, addPoint(sk, -10, 10), addPoint(sk, -20, 12)]);
    expect(relationsFor(sk, [sp2, sp]).map((r) => r.key)).toContain('tangent');
  });

  it('offers no spline Tangent where the two do not meet at an end', () => {
    const sk = createSketch();
    const sp = addSpline(sk, [addPoint(sk, 0, 0), addPoint(sk, 10, 8), addPoint(sk, 20, 0)]);
    const l = addLine(sk, addPoint(sk, 0, 20), addPoint(sk, 20, 20));
    expect(relationsFor(sk, [l, sp]).map((r) => r.key)).not.toContain('tangent');
  });
});
