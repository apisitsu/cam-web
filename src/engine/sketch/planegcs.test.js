/**
 * The planegcs bridge.
 *
 * `createSolver` needs the real WASM and is exercised end to end by
 * `planegcs_check.mjs` (`node --test`), which is where it belongs — this file
 * covers `toPlanegcs`, the pure translation, which is where the bugs that
 * actually happen live: a constraint that maps to the wrong primitive, or to
 * none at all.
 *
 * The load-bearing test here is the last one. Every kind in `CONSTRAINT_KINDS`
 * must translate, so adding a kind to the model and forgetting the mapping fails
 * here rather than as a thrown error in the worker, mid-drag, with the sketch
 * half-solved.
 */
import { describe, it, expect } from 'vitest';
import {
  // eslint-disable-next-line no-unused-vars
  createSketch, addPoint, addLine, addLineXY, addCircle, addCircleXY, addArc,
  addConstraint, CONSTRAINT_KINDS,
} from './model.js';
import { toPlanegcs } from './planegcs.js';

/** Primitives of one type from the translation. */
const ofType = (prims, type) => prims.filter((p) => p.type === type);
/** The single primitive of a type, asserting there is exactly one. */
function only(prims, type) {
  const found = ofType(prims, type);
  // eslint-disable-next-line jest/valid-expect
  expect(found, `expected exactly one ${type}`).toHaveLength(1);
  return found[0];
}

describe('toPlanegcs — geometry', () => {
  it('emits every point before any geometry that references one', () => {
    // planegcs resolves references as it pushes, so a line whose points have not
    // been declared yet is a dangling id.
    const sk = createSketch();
    addLineXY(sk, 0, 0, 10, 0);
    addCircleXY(sk, 5, 5, 3);
    const prims = toPlanegcs(sk);
    const lastPoint = prims.map((p) => p.type).lastIndexOf('point');
    const firstOther = prims.findIndex((p) => p.type === 'line' || p.type === 'circle');
    expect(lastPoint).toBeLessThan(firstOther);
  });

  it('carries a point\'s coordinates and its fixed flag', () => {
    const sk = createSketch();
    addPoint(sk, 3, -4, true);
    expect(toPlanegcs(sk)[0]).toMatchObject({ type: 'point', x: 3, y: -4, fixed: true });
  });

  it('sends ids as strings, which is what the wrapper indexes on', () => {
    const sk = createSketch();
    const p = addPoint(sk, 0, 0);
    expect(toPlanegcs(sk)[0].id).toBe(String(p));
  });

  it('maps a line to its two point ids', () => {
    const sk = createSketch();
    const { line, p1, p2 } = addLineXY(sk, 0, 0, 10, 0);
    expect(only(toPlanegcs(sk), 'line')).toMatchObject({
      id: String(line), p1_id: String(p1), p2_id: String(p2),
    });
  });

  it('maps a circle to its centre and radius', () => {
    const sk = createSketch();
    const { circle, center } = addCircleXY(sk, 1, 2, 7);
    expect(only(toPlanegcs(sk), 'circle')).toMatchObject({
      id: String(circle), c_id: String(center), radius: 7,
    });
  });

  it('derives an arc\'s sweep angles from where its endpoints actually are', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    const s = addPoint(sk, 10, 0); // 0°
    const e = addPoint(sk, 0, 10); // 90°
    addArc(sk, c, s, e, 10);
    const arc = only(toPlanegcs(sk), 'arc');
    expect(arc.start_angle).toBeCloseTo(0);
    expect(arc.end_angle).toBeCloseTo(Math.PI / 2);
    expect(arc.radius).toBe(10);
  });

  it('pins every arc to its rim with an arc_rules of its own', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    const a1 = addArc(sk, c, addPoint(sk, 10, 0), addPoint(sk, 0, 10), 10);
    const c2 = addPoint(sk, 50, 0);
    addArc(sk, c2, addPoint(sk, 55, 0), addPoint(sk, 50, 5), 5);
    const rules = ofType(toPlanegcs(sk), 'arc_rules');
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ id: `arc_rules_${a1}`, a_id: String(a1) });
  });

  it('translates an empty sketch to nothing', () => {
    expect(toPlanegcs(createSketch())).toEqual([]);
  });
});

describe('toPlanegcs — constraints', () => {
  /** A sketch with one of everything the constraint kinds need. */
  function rig() {
    const sk = createSketch();
    const p1 = addPoint(sk, 0, 0);
    const p2 = addPoint(sk, 10, 0);
    const p3 = addPoint(sk, 10, 10);
    const l1 = addLine(sk, p1, p2);
    const l2 = addLine(sk, p2, p3);
    const { circle: c1, center: cc1 } = addCircleXY(sk, 30, 0, 5);
    const { circle: c2 } = addCircleXY(sk, 50, 0, 5);
    const ac = addPoint(sk, 70, 0);
    const arc = addArc(sk, ac, addPoint(sk, 75, 0), addPoint(sk, 70, 5), 5);
    const ac2 = addPoint(sk, 90, 0);
    const arc2 = addArc(sk, ac2, addPoint(sk, 95, 0), addPoint(sk, 90, 5), 5);
    return {
      sk, p1, p2, p3, l1, l2, c1, c2, cc1, arc, arc2,
    };
  }

  it('maps each relation to the primitive planegcs knows it by', () => {
    const r = rig();
    const cases = [
      ['coincident', [r.p1, r.p2], undefined, 'p2p_coincident'],
      ['horizontal', [r.p1, r.p2], undefined, 'horizontal_pp'],
      ['vertical', [r.p1, r.p2], undefined, 'vertical_pp'],
      ['parallel', [r.l1, r.l2], undefined, 'parallel'],
      ['perpendicular', [r.l1, r.l2], undefined, 'perpendicular_ll'],
      ['pointOnLine', [r.p3, r.l1], undefined, 'point_on_line_pl'],
      ['pointOnCircle', [r.p3, r.c1], undefined, 'point_on_circle'],
      ['pointOnArc', [r.p3, r.arc], undefined, 'point_on_arc'],
      ['equalLength', [r.l1, r.l2], undefined, 'equal_length'],
      ['tangent', [r.l1, r.c1], undefined, 'tangent_lc'],
      ['tangentArc', [r.l1, r.arc], undefined, 'tangent_la'],
      ['tangentArcArc', [r.arc, r.arc2], undefined, 'tangent_aa'],
      ['symmetric', [r.p1, r.p2, r.l2], undefined, 'p2p_symmetric_ppl'],
    ];
    for (const [kind, refs, value, type] of cases) {
      const sk = rig().sk;
      // Rebuild each time so ids line up with a fresh rig.
      const fresh = rig();
      addConstraint(fresh.sk, kind, refs, value);
      // eslint-disable-next-line jest/valid-expect
      expect(ofType(toPlanegcs(fresh.sk), type), `${kind} → ${type}`).toHaveLength(1);
      expect(sk).toBeTruthy();
    }
  });

  it('maps each dimension with its value under the name planegcs uses', () => {
    const r1 = rig();
    addConstraint(r1.sk, 'distance', [r1.p1, r1.p2], 25);
    expect(only(toPlanegcs(r1.sk), 'p2p_distance')).toMatchObject({ distance: 25, driving: true });

    const r2 = rig();
    addConstraint(r2.sk, 'pointLineDistance', [r2.p3, r2.l1], 4);
    expect(only(toPlanegcs(r2.sk), 'p2l_distance')).toMatchObject({ distance: 4 });

    const r3 = rig();
    addConstraint(r3.sk, 'radius', [r3.c1], 8);
    expect(only(toPlanegcs(r3.sk), 'circle_radius')).toMatchObject({ radius: 8 });

    const r4 = rig();
    addConstraint(r4.sk, 'diameter', [r4.c1], 16);
    expect(only(toPlanegcs(r4.sk), 'circle_diameter')).toMatchObject({ diameter: 16 });

    const r5 = rig();
    addConstraint(r5.sk, 'arcRadius', [r5.arc], 3);
    expect(only(toPlanegcs(r5.sk), 'arc_radius')).toMatchObject({ radius: 3 });

    const r6 = rig();
    addConstraint(r6.sk, 'angle', [r6.l1, r6.l2], Math.PI / 3);
    expect(only(toPlanegcs(r6.sk), 'l2l_angle_ll').angle).toBeCloseTo(Math.PI / 3);

    const r7 = rig();
    addConstraint(r7.sk, 'lockX', [r7.p1], 12);
    expect(only(toPlanegcs(r7.sk), 'coordinate_x')).toMatchObject({ x: 12 });

    const r8 = rig();
    addConstraint(r8.sk, 'lockY', [r8.p1], -3);
    expect(only(toPlanegcs(r8.sk), 'coordinate_y')).toMatchObject({ y: -3 });
  });

  it('builds an axis-locked dimension out of a raw parameter difference', () => {
    // planegcs has no dx/dy constraint; pointing `difference` at the same
    // property of two points is what gives the axis-aligned gap.
    const rx = rig();
    addConstraint(rx.sk, 'distanceX', [rx.p1, rx.p2], 40);
    const dx = only(toPlanegcs(rx.sk), 'difference');
    expect(dx.param1).toEqual({ o_id: String(rx.p1), prop: 'x' });
    expect(dx.param2).toEqual({ o_id: String(rx.p2), prop: 'x' });
    expect(dx.difference).toBe(40);

    const ry = rig();
    addConstraint(ry.sk, 'distanceY', [ry.p1, ry.p2], 40);
    expect(only(toPlanegcs(ry.sk), 'difference').param1.prop).toBe('y');
  });

  it('picks the right equal-radius primitive for each mix of circle and arc', () => {
    const cc = rig();
    addConstraint(cc.sk, 'equalRadius', [cc.c1, cc.c2]);
    expect(ofType(toPlanegcs(cc.sk), 'equal_radius_cc')).toHaveLength(1);

    const aa = rig();
    addConstraint(aa.sk, 'equalRadius', [aa.arc, aa.arc2]);
    expect(ofType(toPlanegcs(aa.sk), 'equal_radius_aa')).toHaveLength(1);

    // A circle and an arc in either order must both give circle-then-arc.
    for (const refs of [['c1', 'arc'], ['arc', 'c1']]) {
      const r = rig();
      addConstraint(r.sk, 'equalRadius', [r[refs[0]], r[refs[1]]]);
      const p = only(toPlanegcs(r.sk), 'equal_radius_ca');
      expect(p.c1_id).toBe(String(r.c1));
      expect(p.a2_id).toBe(String(r.arc));
    }
  });

  it('expands a midpoint into the two primitives that make one', () => {
    const r = rig();
    addConstraint(r.sk, 'midpoint', [r.p3, r.l1]);
    const prims = toPlanegcs(r.sk);
    expect(ofType(prims, 'point_on_line_pl')).toHaveLength(1);
    const bisector = only(prims, 'point_on_perp_bisector_ppp');
    expect(bisector).toMatchObject({ lp1_id: String(r.p1), lp2_id: String(r.p2) });
  });

  it('sends a driven dimension as non-driving, so it measures without enforcing', () => {
    const r = rig();
    const i = addConstraint(r.sk, 'distance', [r.p1, r.p2], 25);
    r.sk.constraints[i].driven = true;
    expect(only(toPlanegcs(r.sk), 'p2p_distance').driving).toBe(false);
  });

  it('gives every constraint a distinct id', () => {
    const r = rig();
    addConstraint(r.sk, 'horizontal', [r.p1, r.p2]);
    addConstraint(r.sk, 'vertical', [r.p2, r.p3]);
    addConstraint(r.sk, 'distance', [r.p1, r.p2], 10);
    const ids = toPlanegcs(r.sk).filter((p) => /^k\d+$/.test(p.id)).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('translates **every** kind the model defines', () => {
    // The structural guard: a kind added to `CONSTRAINT_KINDS` without a case in
    // the switch throws "no planegcs mapping", and it would otherwise do that
    // for the first time inside the worker with a sketch half solved.
    const sample = (r, type) => ({
      point: r.p1, line: r.l1, circle: r.c1, arc: r.arc,
    }[type]);
    for (const [kind, spec] of Object.entries(CONSTRAINT_KINDS)) {
      const r = rig();
      const used = new Set();
      const refs = spec.refTypes.map((t, i) => {
        const type = Array.isArray(t) ? t[0] : t;
        // Distinct entities per slot: a constraint between an entity and itself
        // is not what the mapping is being checked for.
        const pool = {
          point: [r.p1, r.p2, r.p3], line: [r.l1, r.l2], circle: [r.c1, r.c2], arc: [r.arc, r.arc2],
        }[type];
        const pick = pool.find((id) => !used.has(id)) ?? sample(r, type) ?? pool[i % pool.length];
        used.add(pick);
        return pick;
      });
      addConstraint(r.sk, kind, refs, spec.value ? 5 : undefined);
      // eslint-disable-next-line jest/valid-expect
      expect(() => toPlanegcs(r.sk), `${kind} has no planegcs mapping`).not.toThrow();
    }
  });
});
