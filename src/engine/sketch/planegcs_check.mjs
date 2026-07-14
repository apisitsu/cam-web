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
