/**
 * Dependency-free validation of the sketch editing operations (the interactive
 * sketcher's logic core). Rendering/event handling is verified separately in the
 * browser; this proves the geometry/selection maths.
 *
 * Run:  node --test src/engine/sketch/edit_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSketch, addPoint, addLine, addCircleXY, addConstraint } from './model.js';
import { hitTestPoint, getOrCreatePoint, deleteEntity, removeConstraint } from './edit.js';

test('hitTestPoint finds the nearest point within tolerance, else null', () => {
  const sk = createSketch();
  const a = addPoint(sk, 0, 0);
  addPoint(sk, 10, 0);
  assert.equal(hitTestPoint(sk, 0.2, 0.1, 0.5), a);
  assert.equal(hitTestPoint(sk, 5, 5, 0.5), null);
});

test('getOrCreatePoint reuses a nearby point (snap) instead of duplicating', () => {
  const sk = createSketch();
  const a = addPoint(sk, 0, 0);
  const same = getOrCreatePoint(sk, 0.05, 0.0, 0.5); // within tol -> reuse
  assert.equal(same, a);
  const fresh = getOrCreatePoint(sk, 20, 20, 0.5); // far -> new
  assert.notEqual(fresh, a);
  assert.equal(sk.entities.size, 2);
});

test('snapping two line endpoints to a corner yields a truly shared point', () => {
  const sk = createSketch();
  // draw an L: first line, then a second that starts where the first ended
  const p0 = getOrCreatePoint(sk, 0, 0);
  const p1 = getOrCreatePoint(sk, 10, 0);
  addLine(sk, p0, p1);
  const p1again = getOrCreatePoint(sk, 10, 0, 0.5); // click the shared corner
  const p2 = getOrCreatePoint(sk, 10, 10);
  addLine(sk, p1again, p2);
  assert.equal(p1again, p1); // same point object -> coincident for free
  const points = [...sk.entities.values()].filter((e) => e.type === 'point');
  assert.equal(points.length, 3); // not 4
});

test('deleteEntity cascades: a point takes its lines/circles and their constraints', () => {
  const sk = createSketch();
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, 10, 0);
  const p3 = addPoint(sk, 10, 10);
  const L1 = addLine(sk, p1, p2);
  const L2 = addLine(sk, p2, p3);
  addConstraint(sk, 'horizontal', [p1, p2]); // refs p1,p2
  addConstraint(sk, 'equalLength', [L1, L2]); // refs L1,L2
  addConstraint(sk, 'vertical', [p2, p3]); // refs p2,p3

  const removed = deleteEntity(sk, p2); // p2 -> also L1, L2
  assert.ok(removed.has(p2) && removed.has(L1) && removed.has(L2));
  assert.equal(sk.entities.has(p1), true);
  assert.equal(sk.entities.has(p3), true);
  // every constraint referenced a removed entity -> all gone
  assert.equal(sk.constraints.length, 0);
});

test('deleting a circle centre removes the circle', () => {
  const sk = createSketch();
  const { circle, center } = addCircleXY(sk, 0, 0, 5);
  const removed = deleteEntity(sk, center);
  assert.ok(removed.has(center) && removed.has(circle));
  assert.equal(sk.entities.size, 0);
});

test('deleteEntity on an unknown id is a no-op', () => {
  const sk = createSketch();
  addPoint(sk, 0, 0);
  assert.equal(deleteEntity(sk, 999).size, 0);
  assert.equal(sk.entities.size, 1);
});

test('removeConstraint by index, with bounds checking', () => {
  const sk = createSketch();
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, 10, 0);
  addConstraint(sk, 'horizontal', [p1, p2]);
  assert.equal(removeConstraint(sk, 5), false);
  assert.equal(removeConstraint(sk, 0), true);
  assert.equal(sk.constraints.length, 0);
});
