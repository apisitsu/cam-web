/**
 * End-to-end validation of the planegcs bridge: build a sketch in the model,
 * solve it with the real WASM solver, and assert the geometry moved to satisfy
 * the constraints. Proves Phase 2 slice 2 (model → planegcs → solve → write-back).
 *
 * Run:  node --test src/engine/sketch/planegcs_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSketch,
  addPoint,
  addLine,
  addCircleXY,
  addArc,
  addConstraint,
} from './model.js';
import { createSolver, toPlanegcs } from './planegcs.js';
import { createRequire } from 'node:module';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const wasmPath = createRequire(import.meta.url).resolve(
  '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'
);

let solver;
test('load solver (WASM)', async () => {
  solver = await createSolver({ wasmPath });
  assert.equal(typeof solver.solve, 'function');
});

test('translator emits points before geometry before constraints', () => {
  const sk = createSketch();
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, 1, 1);
  addLine(sk, p1, p2);
  addConstraint(sk, 'horizontal', [p1, p2]);
  const prims = toPlanegcs(sk);
  assert.equal(prims[0].type, 'point');
  assert.equal(prims[2].type, 'line');
  assert.equal(prims[3].type, 'horizontal_pp');
});

test('skewed quad solves to a 10x10 square pinned at the origin', () => {
  const sk = createSketch();
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, 10, 1); // deliberately off
  const p3 = addPoint(sk, 9, 11);
  const p4 = addPoint(sk, -1, 10);
  const L1 = addLine(sk, p1, p2);
  const L2 = addLine(sk, p2, p3);
  addLine(sk, p3, p4);
  addLine(sk, p4, p1);
  addConstraint(sk, 'horizontal', [p1, p2]);
  addConstraint(sk, 'horizontal', [p4, p3]);
  addConstraint(sk, 'vertical', [p1, p4]);
  addConstraint(sk, 'vertical', [p2, p3]);
  addConstraint(sk, 'distance', [p1, p2], 10);
  addConstraint(sk, 'equalLength', [L1, L2]);
  addConstraint(sk, 'lockX', [p1], 0);
  addConstraint(sk, 'lockY', [p1], 0);

  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  assert.deepEqual(res.conflicting, []);

  const pt = (id) => sk.entities.get(id);
  assert.ok(near(pt(p1).x, 0) && near(pt(p1).y, 0));
  assert.ok(near(pt(p2).x, 10) && near(pt(p2).y, 0));
  assert.ok(near(pt(p3).x, 10) && near(pt(p3).y, 10));
  assert.ok(near(pt(p4).x, 0) && near(pt(p4).y, 10));
});

test('radius constraint drives a circle to the requested size', () => {
  const sk = createSketch();
  const { circle, center } = addCircleXY(sk, 2, 3, 999); // wrong radius
  addConstraint(sk, 'lockX', [center], 2);
  addConstraint(sk, 'lockY', [center], 3);
  addConstraint(sk, 'radius', [circle], 7.5);
  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  assert.ok(near(sk.entities.get(circle).r, 7.5));
});

test('arc_rules pins both endpoints to the rim (radius = centre→start distance)', () => {
  const sk = createSketch();
  const c = addPoint(sk, 0, 0);
  const s = addPoint(sk, 10, 0); // start on the rim at 0°
  const e = addPoint(sk, 1, 9); // end deliberately OFF the rim
  addArc(sk, c, s, e, 10);
  addConstraint(sk, 'lockX', [c], 0);
  addConstraint(sk, 'lockY', [c], 0);
  addConstraint(sk, 'lockX', [s], 10); // pin start → forces radius to 10
  addConstraint(sk, 'lockY', [s], 0);

  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const pt = (id) => sk.entities.get(id);
  // Both endpoints sit on the rim; the end was pulled onto radius 10.
  assert.ok(near(dist(pt(c), pt(s)), 10, 1e-4), 'start on rim');
  assert.ok(near(dist(pt(c), pt(e)), 10, 1e-4), `end pulled to rim (got ${dist(pt(c), pt(e))})`);
});

test('arcRadius drives a partial arc to the requested radius', () => {
  const sk = createSketch();
  const c = addPoint(sk, 0, 0);
  const s = addPoint(sk, 8, 0); // start on the rim at 0°
  const e = addPoint(sk, 0, 8); // end at 90°
  addArc(sk, c, s, e, 8);
  addConstraint(sk, 'lockX', [c], 0);
  addConstraint(sk, 'lockY', [c], 0);
  addConstraint(sk, 'arcRadius', [[...sk.entities.values()].find((x) => x.type === 'arc').id], 12);

  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  const arc = [...sk.entities.values()].find((x) => x.type === 'arc');
  assert.ok(near(arc.r, 12, 1e-4), `arc radius driven to 12 (got ${arc.r})`);
  // Endpoints followed the rim out to radius 12.
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const pt = (id) => sk.entities.get(id);
  assert.ok(near(dist(pt(c), pt(s)), 12, 1e-3), 'start on the grown rim');
  assert.ok(near(dist(pt(c), pt(e)), 12, 1e-3), 'end on the grown rim');
});

test('diameter constraint drives a circle to the requested Ø', () => {
  const sk = createSketch();
  const { circle } = addCircleXY(sk, 0, 0, 3);
  addConstraint(sk, 'diameter', [circle], 20); // Ø20 → r10
  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  assert.ok(near(sk.entities.get(circle).r, 10, 1e-4), 'radius driven to 10 by Ø20');
});

test('equalRadius ties two circles to the same radius', () => {
  const sk = createSketch();
  const { circle: c1 } = addCircleXY(sk, 0, 0, 4);
  const { circle: c2 } = addCircleXY(sk, 30, 0, 9);
  addConstraint(sk, 'radius', [c1], 7);
  addConstraint(sk, 'equalRadius', [c1, c2]);
  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  assert.ok(near(sk.entities.get(c2).r, 7, 1e-4), `second circle equalised to 7 (got ${sk.entities.get(c2).r})`);
});

test('midpoint pins a point to the centre of a line', () => {
  const sk = createSketch();
  const a = addPoint(sk, 0, 0, true);
  const b = addPoint(sk, 10, 4, true);
  const line = addLine(sk, a, b);
  const m = addPoint(sk, 2, 9); // off the line
  addConstraint(sk, 'midpoint', [m, line]);
  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  const pm = sk.entities.get(m);
  assert.ok(near(pm.x, 5, 1e-4) && near(pm.y, 2, 1e-4), `point at midpoint (5,2), got (${pm.x},${pm.y})`);
});

test('symmetric mirrors one point across a line axis onto the other', () => {
  const sk = createSketch();
  // Vertical axis at x=5 (two fixed points on it).
  const ax1 = addPoint(sk, 5, 0, true);
  const ax2 = addPoint(sk, 5, 10, true);
  const axis = addLine(sk, ax1, ax2);
  const p1 = addPoint(sk, 2, 3, true); // fixed on the left
  const p2 = addPoint(sk, 20, 20); // free — should snap to the mirror of p1
  addConstraint(sk, 'symmetric', [p1, p2, axis]);
  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  const q = sk.entities.get(p2);
  assert.ok(near(q.x, 8, 1e-3) && near(q.y, 3, 1e-3), `p2 mirrored to (8,3), got (${q.x},${q.y})`);
});

test('a driven (reference) distance measures but does not move geometry', () => {
  const sk = createSketch();
  const a = addPoint(sk, 0, 0, true);
  const b = addPoint(sk, 10, 0, true); // both fixed → true length is 10
  addLine(sk, a, b);
  // Driven distance asserting 999 must NOT stretch the (fixed) line.
  sk.constraints.push({ kind: 'distance', refs: [a, b], value: 999, driven: true });
  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  assert.ok(near(sk.entities.get(b).x, 10, 1e-6), 'driven dim did not drive the geometry');
});

test('tangentArcArc makes two arcs tangent (centre distance = R1+R2)', () => {
  const sk = createSketch();
  // Fixed arc A: centre (0,0), r 10. Arc B: centre free, r 4, pushed to touch.
  const cA = addPoint(sk, 0, 0, true);
  const sA = addPoint(sk, 10, 0, true);
  const eA = addPoint(sk, 0, 10, true);
  const arcA = addArc(sk, cA, sA, eA, 10);
  addConstraint(sk, 'lockX', [sA], 10); // pin A's radius to 10
  const cB = addPoint(sk, 20, 0);
  const sB = addPoint(sk, 24, 0);
  const eB = addPoint(sk, 20, 4);
  const arcB = addArc(sk, cB, sB, eB, 4);
  addConstraint(sk, 'arcRadius', [arcB], 4);
  addConstraint(sk, 'lockY', [cB], 0); // keep B's centre on the x-axis
  addConstraint(sk, 'tangentArcArc', [arcA, arcB]);
  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  const d = Math.hypot(sk.entities.get(cB).x - 0, sk.entities.get(cB).y - 0);
  // External tangency → centre distance = 10 + 4 = 14 (DogLeg from the outside start).
  assert.ok(near(d, 14, 1e-2), `arc centres 14 apart (external tangency), got ${d}`);
});

test('distanceX / distanceY drive the axis gap only, leaving the other axis free', () => {
  const sk = createSketch();
  const o = addPoint(sk, 0, 0, true); // fixed datum
  // A free point sitting diagonally away; dX pins x, dY pins y, independently.
  const p = addPoint(sk, 37, 12);
  addConstraint(sk, 'distanceX', [o, p], 100);
  addConstraint(sk, 'distanceY', [o, p], 40);

  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  const pt = sk.entities.get(p);
  assert.ok(near(pt.x, 100, 1e-4), `dX drove x to 100, got ${pt.x}`);
  assert.ok(near(pt.y, 40, 1e-4), `dY drove y to 40, got ${pt.y}`);
});

test('difference is signed p2 − p1, so ref order sets the positive direction', () => {
  const sk = createSketch();
  const o = addPoint(sk, 0, 0, true);
  const p = addPoint(sk, 5, 0);
  // refs reversed: [p, o] means o.x − p.x = 30, so p lands at −30.
  addConstraint(sk, 'distanceX', [p, o], 30);
  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  assert.ok(near(sk.entities.get(p).x, -30, 1e-4), `got ${sk.entities.get(p).x}`);
});

test('distanceX emits a difference primitive on the points x params', () => {
  const sk = createSketch();
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, 10, 4);
  addConstraint(sk, 'distanceX', [p1, p2], 10);
  const c = toPlanegcs(sk).find((x) => x.type === 'difference');
  assert.ok(c, 'emitted a difference primitive');
  assert.equal(c.param1.prop, 'x');
  assert.equal(c.param2.prop, 'x');
  assert.equal(c.difference, 10);
});

test('pointLineDistance drives a point to a set perpendicular gap from a line', () => {
  const sk = createSketch();
  // fixed horizontal line along the x-axis
  const a = addPoint(sk, 0, 0, true);
  const b = addPoint(sk, 10, 0, true);
  const line = addLine(sk, a, b);
  // a free point starting 3 above the line, pinned in x so only y solves
  const p = addPoint(sk, 4, 3);
  addConstraint(sk, 'lockX', [p], 4);
  addConstraint(sk, 'pointLineDistance', [p, line], 7);

  const res = solver.solve(sk);
  assert.ok(res.success, `solve status ${res.status}`);
  const pt = sk.entities.get(p);
  assert.ok(near(Math.abs(pt.y), 7, 1e-4), `point moved to gap 7 (got y=${pt.y})`);
});

test('pointLineDistance maps to p2l_distance', () => {
  const sk = createSketch();
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  const line = addLine(sk, a, b);
  const p = addPoint(sk, 4, 3);
  addConstraint(sk, 'pointLineDistance', [p, line], 5);
  const prims = toPlanegcs(sk);
  const c = prims.find((x) => x.type === 'p2l_distance');
  assert.ok(c, 'emitted a p2l_distance primitive');
  assert.equal(c.distance, 5);
});

test('over-constraint is detected as conflicting/redundant, not a silent wrong answer', () => {
  const sk = createSketch();
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, 10, 0);
  addLine(sk, p1, p2);
  addConstraint(sk, 'distance', [p1, p2], 10);
  addConstraint(sk, 'distance', [p1, p2], 20); // contradictory
  const res = solver.solve(sk);
  assert.ok(
    res.conflicting.length > 0 || res.redundant.length > 0 || !res.success,
    'expected planegcs to flag the contradiction'
  );
});

test('destroy solver', () => {
  solver.destroy();
});
