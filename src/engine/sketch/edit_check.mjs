/**
 * Dependency-free validation of the sketch editing operations (the interactive
 * sketcher's logic core). Rendering/event handling is verified separately in the
 * browser; this proves the geometry/selection maths.
 *
 * Run:  node --test src/engine/sketch/edit_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSketch, addPoint, addLine, addCircleXY, addArc, addConstraint } from './model.js';
import {
  hitTestPoint, getOrCreatePoint, deleteEntity, removeConstraint, chamfer, hitTestArc,
  trimLine, distancePointToLine, farEndpointFromLine,
} from './edit.js';

/** Build an L: a corner point shared by two lines going -x and +y. Returns ids. */
function makeCorner() {
  const sk = createSketch();
  const far1 = addPoint(sk, 0, 0);
  const corner = addPoint(sk, 10, 0);
  const far2 = addPoint(sk, 10, 10);
  const l1 = addLine(sk, far1, corner);
  const l2 = addLine(sk, corner, far2);
  return { sk, far1, corner, far2, l1, l2 };
}

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

test('chamfer cuts the shared corner: new points at dist along each line, corner dropped', () => {
  const { sk, far1, far2, l1, l2, corner } = makeCorner();
  const chamferId = chamfer(sk, l1, l2, 2);
  assert.notEqual(chamferId, null);

  // old corner is gone; both far ends survive
  assert.equal(sk.entities.has(corner), false);
  assert.equal(sk.entities.has(far1), true);
  assert.equal(sk.entities.has(far2), true);

  // the chamfer line joins the two pull-back points: (8,0) and (10,2)
  const line = sk.entities.get(chamferId);
  const a = sk.entities.get(line.p1);
  const b = sk.entities.get(line.p2);
  const coords = [
    [a.x, a.y],
    [b.x, b.y],
  ].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  assert.deepEqual(coords, [
    [8, 0],
    [10, 2],
  ]);

  // originals were re-pointed off the corner and onto the chamfer points
  const L1 = sk.entities.get(l1);
  const L2 = sk.entities.get(l2);
  assert.equal(L1.p1 !== corner && L1.p2 !== corner, true);
  assert.equal(L2.p1 !== corner && L2.p2 !== corner, true);

  // 4 points (2 far + 2 new) and 3 lines (2 original + chamfer)
  const kinds = [...sk.entities.values()].map((e) => e.type);
  assert.equal(kinds.filter((t) => t === 'point').length, 4);
  assert.equal(kinds.filter((t) => t === 'line').length, 3);
});

test('chamfer drops any constraint that referenced the removed corner', () => {
  const { sk, l1, l2, corner } = makeCorner();
  addConstraint(sk, 'lockX', [corner], 10);
  assert.equal(sk.constraints.length, 1);
  assert.notEqual(chamfer(sk, l1, l2, 2), null);
  assert.equal(sk.constraints.length, 0);
});

test('chamfer returns null when the two lines share no corner', () => {
  const sk = createSketch();
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  const c = addPoint(sk, 0, 10);
  const d = addPoint(sk, 10, 10);
  const l1 = addLine(sk, a, b);
  const l2 = addLine(sk, c, d);
  assert.equal(chamfer(sk, l1, l2, 2), null);
});

test('chamfer returns null for non-positive dist or dist past a line end', () => {
  {
    const { sk, l1, l2 } = makeCorner();
    assert.equal(chamfer(sk, l1, l2, 0), null);
    assert.equal(chamfer(sk, l1, l2, -1), null);
  }
  {
    const { sk, l1, l2 } = makeCorner(); // both legs length 10
    assert.equal(chamfer(sk, l1, l2, 10), null); // dist >= far end
    assert.equal(chamfer(sk, l1, l2, 12), null);
  }
});

test('chamfer returns null when a referenced id is not a line', () => {
  const { sk, l1, corner } = makeCorner();
  assert.equal(chamfer(sk, l1, corner, 2), null); // corner is a point, not a line
  assert.equal(chamfer(sk, l1, 'nope', 2), null); // missing entity
});

test('deleting an arc endpoint or centre cascades the arc away', () => {
  const sk = createSketch();
  const c = addPoint(sk, 0, 0);
  const s = addPoint(sk, 10, 0);
  const e = addPoint(sk, 0, 10);
  const arc = addArc(sk, c, s, e, 10);
  // deleting the start point takes the arc with it, leaves centre + end
  const removed = deleteEntity(sk, s);
  assert.ok(removed.has(s) && removed.has(arc));
  assert.equal(sk.entities.has(c), true);
  assert.equal(sk.entities.has(e), true);
  assert.equal(sk.entities.has(arc), false);
});

test('hitTestArc only picks within the swept (CCW start→end) span', () => {
  const sk = createSketch();
  const c = addPoint(sk, 0, 0);
  const s = addPoint(sk, 10, 0); //   0° start
  const e = addPoint(sk, 0, 10); //  90° end   → CCW quarter arc
  const arc = addArc(sk, c, s, e, 10);
  const on = 10 / Math.SQRT2; // a point on the rim at 45° — inside the span
  assert.equal(hitTestArc(sk, on, on, 0.5), arc);
  // 225° is on the same ring but outside the 0→90° sweep
  assert.equal(hitTestArc(sk, -on, -on, 0.5), null);
  // way off the ring is a miss regardless of angle
  assert.equal(hitTestArc(sk, 2, 2, 0.5), null);
});

test('distancePointToLine gives the perpendicular gap to the infinite line', () => {
  const sk = createSketch();
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0); // line along the x-axis
  const l = addLine(sk, a, b);
  const p = addPoint(sk, 3, 4); // 4 above the line, beyond the segment is fine
  assert.equal(distancePointToLine(sk, p, l), 4);
  const q = addPoint(sk, 100, -2.5);
  assert.equal(distancePointToLine(sk, q, l), 2.5);
  assert.equal(distancePointToLine(sk, a, l), 0); // a point on the line
});

test('farEndpointFromLine picks the endpoint farther from the reference line', () => {
  const sk = createSketch();
  // reference line along the x-axis
  const ra = addPoint(sk, 0, 0);
  const rb = addPoint(sk, 10, 0);
  const ref = addLine(sk, ra, rb);
  // a line whose p1 sits on the x-axis (dist 0) and p2 is 5 above it
  const p1 = addPoint(sk, 2, 0);
  const p2 = addPoint(sk, 2, 5);
  const l = addLine(sk, p1, p2);
  assert.equal(farEndpointFromLine(sk, l, ref), p2);
  // parallel lines: both endpoints equidistant → p1 returned
  const q1 = addPoint(sk, 0, 3);
  const q2 = addPoint(sk, 8, 3);
  const par = addLine(sk, q1, q2);
  assert.equal(farEndpointFromLine(sk, par, ref), q1);
});

test('trimLine leaves a line with no crossings untouched (no-op, never deletes)', () => {
  const sk = createSketch();
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  const l = addLine(sk, a, b);
  assert.equal(trimLine(sk, l, 5, 0), null);
  assert.equal(sk.entities.has(l), true); // still there — Delete is a separate tool
});

test('trimLine shortens a line to the crossing when the click is on an end piece', () => {
  const sk = createSketch();
  // horizontal line 0..10 crossed by a vertical line at x=6
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  const l = addLine(sk, a, b);
  addLine(sk, addPoint(sk, 6, -5), addPoint(sk, 6, 5));
  // click near the right end (x=9) → drop [6,10], keep [0,6]
  const res = trimLine(sk, l, 9, 0);
  assert.equal(res.added, null);
  const line = sk.entities.get(l);
  const p1 = sk.entities.get(line.p1);
  const p2 = sk.entities.get(line.p2);
  const xs = [p1.x, p2.x].sort((m, n) => m - n);
  assert.deepEqual(xs, [0, 6]);
});

test('trimLine cuts at a circle crossing', () => {
  const sk = createSketch();
  // horizontal line 0..10 through a circle centred at (5,0) r=2 → cuts at x=3,7
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  const l = addLine(sk, a, b);
  addCircleXY(sk, 5, 0, 2);
  // click the far-right piece (x=9) → keep [0,7]
  const res = trimLine(sk, l, 9, 0);
  assert.equal(res.added, null);
  const line = sk.entities.get(l);
  const xs = [sk.entities.get(line.p1).x, sk.entities.get(line.p2).x].sort((m, n) => m - n);
  assert.deepEqual(xs.map((v) => Math.round(v)), [0, 7]);
});

test('trimLine splits into two lines when the click is on a middle piece', () => {
  const sk = createSketch();
  // horizontal 0..10 crossed at x=3 and x=7 → pieces [0,3] [3,7] [7,10]
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  const l = addLine(sk, a, b);
  addLine(sk, addPoint(sk, 3, -5), addPoint(sk, 3, 5));
  addLine(sk, addPoint(sk, 7, -5), addPoint(sk, 7, 5));
  const before = [...sk.entities.values()].filter((e) => e.type === 'line').length;
  // click the middle piece (x=5) → keep [0,3] and [7,10]
  const res = trimLine(sk, l, 5, 0);
  assert.notEqual(res.added, null);
  const after = [...sk.entities.values()].filter((e) => e.type === 'line').length;
  assert.equal(after, before + 1); // one line became two
  // the original keeps [0,3]
  const orig = sk.entities.get(l);
  const oxs = [sk.entities.get(orig.p1).x, sk.entities.get(orig.p2).x].sort((m, n) => m - n);
  assert.deepEqual(oxs, [0, 3]);
  // the new line spans [7,10]
  const nw = sk.entities.get(res.added);
  const nxs = [sk.entities.get(nw.p1).x, sk.entities.get(nw.p2).x].sort((m, n) => m - n);
  assert.deepEqual(nxs, [7, 10]);
});

test('trimLine returns null on a non-line id', () => {
  const sk = createSketch();
  const p = addPoint(sk, 0, 0);
  assert.equal(trimLine(sk, p, 0, 0), null);
  assert.equal(trimLine(sk, 999, 0, 0), null);
});
