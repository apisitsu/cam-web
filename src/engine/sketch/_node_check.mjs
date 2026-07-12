/**
 * Dependency-free validation of the Phase 2 sketch model (point-based). Proves
 * the document model, DOF bookkeeping, and serialization. The planegcs solver
 * itself is validated separately in `planegcs_check.mjs`.
 *
 * Run:  node --test src/engine/sketch/_node_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSketch,
  addPoint,
  addLine,
  addLineXY,
  addCircleXY,
  addConstraint,
  dof,
  serialize,
  deserialize,
} from './model.js';

test('points carry 2 DOF each; fixed points carry none', () => {
  const sk = createSketch();
  addPoint(sk, 0, 0); // 2
  addPoint(sk, 5, 5, true); // fixed -> 0
  assert.equal(dof(sk).params, 2);
});

test('a line adds no params of its own (defined by its two points)', () => {
  const sk = createSketch();
  addLineXY(sk, 0, 0, 10, 2); // 2 points = 4, line = 0
  assert.equal(dof(sk).params, 4);
});

test('a circle adds one param (radius); centre is a point', () => {
  const sk = createSketch();
  addCircleXY(sk, 0, 0, 5); // centre point (2) + radius (1)
  assert.equal(dof(sk).params, 3);
});

test('shared-point square: 4 points + 4 lines, H/V/dist/equal + lock = full', () => {
  const sk = createSketch();
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, 10, 1);
  const p3 = addPoint(sk, 9, 11);
  const p4 = addPoint(sk, -1, 10);
  const L1 = addLine(sk, p1, p2);
  const L2 = addLine(sk, p2, p3);
  addLine(sk, p3, p4);
  addLine(sk, p4, p1);
  assert.equal(dof(sk).params, 8); // 4 points, lines free
  addConstraint(sk, 'horizontal', [p1, p2]);
  addConstraint(sk, 'horizontal', [p4, p3]);
  addConstraint(sk, 'vertical', [p1, p4]);
  addConstraint(sk, 'vertical', [p2, p3]);
  addConstraint(sk, 'distance', [p1, p2], 10);
  addConstraint(sk, 'equalLength', [L1, L2]);
  addConstraint(sk, 'lockX', [p1], 0);
  addConstraint(sk, 'lockY', [p1], 0);
  assert.deepEqual(dof(sk), { params: 8, removed: 8, free: 0, state: 'full' });
});

test('constraint validation: arity, ref type, value usage, missing entity', () => {
  const sk = createSketch();
  const { line, p1 } = addLineXY(sk, 0, 0, 10, 0);
  const { circle } = addCircleXY(sk, 0, 0, 5);
  assert.throws(() => addConstraint(sk, 'radius', [circle]), /requires a numeric value/);
  assert.throws(() => addConstraint(sk, 'horizontal', [p1, line]), /expected point/);
  assert.throws(() => addConstraint(sk, 'parallel', [line]), /needs 2 refs/);
  assert.throws(() => addConstraint(sk, 'lockX', [p1, p1], 0), /needs 1 refs/);
  assert.throws(() => addConstraint(sk, 'distance', [p1, 999], 5), /missing entity 999/);
  assert.throws(() => addConstraint(sk, 'nope', [p1], 0), /unknown constraint/);
});

test('addLine rejects a non-point reference', () => {
  const sk = createSketch();
  const { line } = addLineXY(sk, 0, 0, 10, 0);
  assert.throws(() => addLine(sk, line, line), /expected point/);
});

test('serialize / deserialize is a faithful round-trip', () => {
  const sk = createSketch();
  const { line, p1, p2 } = addLineXY(sk, 0, 0, 10, 0);
  addConstraint(sk, 'horizontal', [p1, p2]);
  const back = deserialize(serialize(sk));
  assert.deepEqual(serialize(back), serialize(sk));
  assert.equal(back.entities.get(line).type, 'line');
});
