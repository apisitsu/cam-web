/**
 * The sketch document model.
 *
 * This had no test file of its own until the sketcher started building solids —
 * it was covered incidentally, through `edit.js` and the store. That was thin
 * cover for the layer everything else is defined in terms of: the DOF arithmetic
 * drives the under/full/over badge an operator trusts, and serialize/deserialize
 * is what a saved project and the shared library both go through.
 */
import { describe, it, expect } from 'vitest';
import {
  ENTITY_KINDS, CONSTRAINT_KINDS,
  createSketch, addPoint, addLine, addLineXY, addCircle, addCircleXY, addArc,
  addConstraint, totalDof, dof, serialize, deserialize,
} from './model.js';

/** A square from four shared corner points — no coincidences needed. */
function square(sk, s = 10) {
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, s, 0);
  const p3 = addPoint(sk, s, s);
  const p4 = addPoint(sk, 0, s);
  return {
    pts: [p1, p2, p3, p4],
    lines: [addLine(sk, p1, p2), addLine(sk, p2, p3), addLine(sk, p3, p4), addLine(sk, p4, p1)],
  };
}

describe('entity creation', () => {
  it('starts empty and hands out increasing ids', () => {
    const sk = createSketch();
    expect(sk.entities.size).toBe(0);
    expect(sk.constraints).toEqual([]);
    const a = addPoint(sk, 1, 2);
    const b = addPoint(sk, 3, 4);
    expect(b).toBeGreaterThan(a);
  });

  it('stores a point with its coordinates and fixed flag', () => {
    const sk = createSketch();
    const id = addPoint(sk, 3, -4, true);
    expect(sk.entities.get(id)).toMatchObject({ type: 'point', x: 3, y: -4, fixed: true });
  });

  it('makes a line reference points rather than own coordinates', () => {
    // The property the whole module is built on: a shared corner is one point,
    // so a closed profile needs no coincidence constraints at all.
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    const l = addLine(sk, a, b);
    expect(sk.entities.get(l)).toEqual({ id: l, type: 'line', p1: a, p2: b });
    expect(sk.entities.get(l).x).toBeUndefined();
  });

  it('creates points and geometry together for the XY helpers', () => {
    const sk = createSketch();
    const { line, p1, p2 } = addLineXY(sk, 0, 0, 10, 5);
    expect(sk.entities.get(line).p1).toBe(p1);
    expect(sk.entities.get(p2)).toMatchObject({ x: 10, y: 5 });
    const { circle, center } = addCircleXY(sk, 3, 4, 7);
    expect(sk.entities.get(circle)).toMatchObject({ type: 'circle', center, r: 7 });
  });

  it('stores an arc as a centre, two endpoints and a radius', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    const s = addPoint(sk, 10, 0);
    const e = addPoint(sk, 0, 10);
    const a = addArc(sk, c, s, e, 10);
    expect(sk.entities.get(a)).toEqual({ id: a, type: 'arc', center: c, start: s, end: e, r: 10 });
  });

  it('refuses geometry built on a missing or wrong-typed entity', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    expect(() => addLine(sk, a, 999)).toThrow(/missing entity/);
    const l = addLine(sk, a, addPoint(sk, 1, 1));
    expect(() => addCircle(sk, l, 5)).toThrow(/expected point/);
  });
});

describe('constraints', () => {
  it('records refs and value, and hands back the index', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    expect(addConstraint(sk, 'coincident', [a, b])).toBe(0);
    expect(addConstraint(sk, 'distance', [a, b], 25)).toBe(1);
    expect(sk.constraints[1]).toEqual({ kind: 'distance', refs: [a, b], value: 25 });
    expect(sk.constraints[0].value).toBeNull();
  });

  it('copies the refs array, so a caller mutating theirs cannot corrupt it', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 1, 1);
    const refs = [a, b];
    addConstraint(sk, 'coincident', refs);
    refs[0] = 999;
    expect(sk.constraints[0].refs[0]).toBe(a);
  });

  it('rejects an unknown kind, a wrong ref count, and a wrong ref type', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 1, 1);
    const l = addLine(sk, a, b);
    expect(() => addConstraint(sk, 'nonsense', [a])).toThrow(/unknown constraint/);
    expect(() => addConstraint(sk, 'coincident', [a])).toThrow(/needs 2 refs/);
    expect(() => addConstraint(sk, 'parallel', [a, l])).toThrow(/expected line/);
  });

  it('insists on a value for a dimension and refuses one otherwise', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 1, 1);
    expect(() => addConstraint(sk, 'distance', [a, b])).toThrow(/requires a numeric value/);
    expect(() => addConstraint(sk, 'distance', [a, b], NaN)).toThrow(/requires a numeric value/);
    expect(() => addConstraint(sk, 'coincident', [a, b], 5)).toThrow(/does not take a value/);
  });

  it('accepts either a circle or an arc where the kind allows both', () => {
    const sk = createSketch();
    const c1 = addCircleXY(sk, 0, 0, 5).circle;
    const cc = addPoint(sk, 30, 0);
    const arc = addArc(sk, cc, addPoint(sk, 35, 0), addPoint(sk, 30, 5), 5);
    expect(() => addConstraint(sk, 'equalRadius', [c1, arc])).not.toThrow();
    expect(() => addConstraint(sk, 'equalRadius', [arc, c1])).not.toThrow();
  });
});

describe('degrees of freedom', () => {
  it('counts two per free point and none for a fixed one', () => {
    const sk = createSketch();
    addPoint(sk, 0, 0);
    expect(totalDof(sk)).toBe(2);
    addPoint(sk, 1, 1, true);
    expect(totalDof(sk)).toBe(2);
  });

  it('gives a line no parameters of its own', () => {
    const sk = createSketch();
    addLineXY(sk, 0, 0, 10, 0);
    expect(totalDof(sk)).toBe(4); // the two points, and nothing for the line
    expect(ENTITY_KINDS.line.ownParams).toBe(0);
  });

  it('gives a circle one parameter for its radius', () => {
    const sk = createSketch();
    addCircleXY(sk, 0, 0, 5);
    expect(totalDof(sk)).toBe(3); // centre 2 + radius 1
  });

  it('accounts for an arc\'s built-in rim coupling, not just its parameters', () => {
    // An arc owns r and two sweep angles (3) on top of three points (6) = 9,
    // and `arc_rules` pins both endpoints to the rim, removing 4. Getting this
    // wrong makes every sketch with an arc in it read as under-defined forever.
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    addArc(sk, c, addPoint(sk, 10, 0), addPoint(sk, 0, 10), 10);
    expect(totalDof(sk)).toBe(9);
    expect(dof(sk).removed).toBe(4);
    expect(dof(sk).free).toBe(5);
  });

  it('reports under, full and over as the badge shows them', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0, true); // grounded
    const b = addPoint(sk, 10, 0);
    expect(dof(sk).state).toBe('under');
    addConstraint(sk, 'horizontal', [a, b]);
    expect(dof(sk).free).toBe(1);
    addConstraint(sk, 'distance', [a, b], 10);
    expect(dof(sk)).toMatchObject({ free: 0, state: 'full' });
    addConstraint(sk, 'lockX', [b], 10);
    expect(dof(sk).state).toBe('over');
  });

  it('lets a driven (reference) dimension remove nothing', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0, true);
    const b = addPoint(sk, 10, 0);
    const i = addConstraint(sk, 'distance', [a, b], 10);
    expect(dof(sk).free).toBe(1);
    sk.constraints[i].driven = true;
    expect(dof(sk).free).toBe(2); // measured, not enforced
  });

  it('fully constrains a square through its own shared corners', () => {
    const sk = createSketch();
    const { pts } = square(sk);
    sk.entities.get(pts[0]).fixed = true;
    addConstraint(sk, 'horizontal', [pts[0], pts[1]]);
    addConstraint(sk, 'horizontal', [pts[3], pts[2]]);
    addConstraint(sk, 'vertical', [pts[0], pts[3]]);
    addConstraint(sk, 'vertical', [pts[1], pts[2]]);
    addConstraint(sk, 'distance', [pts[0], pts[1]], 10);
    addConstraint(sk, 'distance', [pts[0], pts[3]], 10);
    expect(dof(sk)).toMatchObject({ free: 0, state: 'full' });
  });
});

describe('serialize / deserialize', () => {
  it('round-trips geometry, constraints and the id counter', () => {
    const sk = createSketch();
    const { pts } = square(sk);
    addCircleXY(sk, 5, 5, 2);
    addConstraint(sk, 'distance', [pts[0], pts[1]], 10);
    const back = deserialize(serialize(sk));
    expect(back.entities.size).toBe(sk.entities.size);
    expect(back.constraints).toEqual(sk.constraints);
    expect(back.nextId).toBe(sk.nextId);
  });

  it('survives JSON, which is how a project file and the library carry it', () => {
    const sk = createSketch();
    const { pts } = square(sk);
    addConstraint(sk, 'distance', [pts[0], pts[1]], 10);
    const back = deserialize(JSON.parse(JSON.stringify(serialize(sk))));
    expect(dof(back)).toEqual(dof(sk));
    expect(back.entities.get(pts[2])).toEqual(sk.entities.get(pts[2]));
  });

  it('deep-copies, so editing the copy cannot reach the original', () => {
    const sk = createSketch();
    const p = addPoint(sk, 1, 2);
    const back = deserialize(serialize(sk));
    back.entities.get(p).x = 99;
    back.constraints.push({ kind: 'x', refs: [], value: null });
    expect(sk.entities.get(p).x).toBe(1);
    expect(sk.constraints).toHaveLength(0);
  });

  it('keeps the flags the rest of the app hangs behaviour off', () => {
    // `origin` refuses deletion, `construction` is excluded from a profile, and
    // `driven` makes a dimension a measurement — all must survive a save.
    const sk = createSketch();
    const o = addPoint(sk, 0, 0, true);
    sk.entities.get(o).origin = true;
    const { line } = addLineXY(sk, 0, 0, 5, 5);
    sk.entities.get(line).construction = true;
    const b = addPoint(sk, 9, 9);
    const i = addConstraint(sk, 'distance', [o, b], 12);
    sk.constraints[i].driven = true;

    const back = deserialize(JSON.parse(JSON.stringify(serialize(sk))));
    expect(back.entities.get(o)).toMatchObject({ origin: true, fixed: true });
    expect(back.entities.get(line).construction).toBe(true);
    expect(back.constraints[i].driven).toBe(true);
  });

  it('round-trips an empty sketch', () => {
    const back = deserialize(serialize(createSketch()));
    expect(back.entities.size).toBe(0);
    expect(back.nextId).toBe(1);
  });
});

describe('the kind tables stay coherent', () => {
  it('gives every entity kind a ref count matching its refTypes', () => {
    for (const [kind, spec] of Object.entries(ENTITY_KINDS)) {
      const refTypes = spec.refTypes ?? [];
      // eslint-disable-next-line jest/valid-expect
      expect(refTypes.length, `${kind} refs`).toBe(spec.refs);
    }
  });

  it('gives every constraint kind a positive DOF cost and real ref types', () => {
    const known = new Set(Object.keys(ENTITY_KINDS));
    for (const [kind, spec] of Object.entries(CONSTRAINT_KINDS)) {
      // eslint-disable-next-line jest/valid-expect
      expect(spec.dof, `${kind} dof`).toBeGreaterThan(0);
      // eslint-disable-next-line jest/valid-expect
      expect(spec.refTypes.length, `${kind} refs`).toBeGreaterThan(0);
      for (const t of spec.refTypes) {
        for (const one of Array.isArray(t) ? t : [t]) {
          // eslint-disable-next-line jest/valid-expect
          expect(known.has(one), `${kind} references unknown type ${one}`).toBe(true);
        }
      }
    }
  });
});
