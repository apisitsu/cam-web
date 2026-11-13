import { describe, it, expect } from 'vitest';
import { createSketch, addPoint, addLineXY, addCircleXY, addArc, addConstraint } from './model.js';
import { relationsFor } from './relations.js';

const keys = (sk, sel) => relationsFor(sk, sel).map((r) => r.key);
const find = (sk, sel, key) => relationsFor(sk, sel).find((r) => r.key === key);

describe('relationsFor', () => {
  it('offers nothing for an empty or stale selection', () => {
    const sk = createSketch();
    expect(relationsFor(sk, [])).toEqual([]);
    expect(relationsFor(sk, [99])).toEqual([]);
  });

  it('one line: horizontal / vertical on its end points', () => {
    const sk = createSketch();
    const l = addLineXY(sk, 0, 0, 10, 1).line;
    const { p1, p2 } = sk.entities.get(l);
    expect(keys(sk, [l])).toEqual(['horizontal', 'vertical']);
    expect(find(sk, [l], 'horizontal').constraints).toEqual([['horizontal', [p1, p2]]]);
  });

  it('several lines: Equal chains equalLength to the first picked', () => {
    const sk = createSketch();
    const a = addLineXY(sk, 0, 0, 10, 0).line;
    const b = addLineXY(sk, 0, 5, 7, 5).line;
    const c = addLineXY(sk, 0, 9, 3, 9).line;
    expect(keys(sk, [a, b, c])).toEqual(['horizontal', 'vertical', 'equal', 'parallel', 'collinear']);
    expect(find(sk, [a, b, c], 'equal').constraints).toEqual([['equalLength', [a, b]], ['equalLength', [a, c]]]);
    expect(keys(sk, [a, b])).toContain('perpendicular');
    expect(find(sk, [a, b, c], 'collinear').constraints).toEqual([['collinear', [a, b]], ['collinear', [a, c]]]);
  });

  it('circles and arcs: Equal radius and Concentric on the centres', () => {
    const sk = createSketch();
    const c1 = addCircleXY(sk, 0, 0, 5).circle;
    const c2 = addCircleXY(sk, 3, 1, 2).circle;
    const ctr = addPoint(sk, 20, 0);
    const s = addPoint(sk, 24, 0);
    const e = addPoint(sk, 20, 4);
    const arc = addArc(sk, ctr, s, e, 4);
    const sel = [c1, c2, arc];
    expect(find(sk, sel, 'equal').constraints).toEqual([['equalRadius', [c1, c2]], ['equalRadius', [c1, arc]]]);
    const c1c = sk.entities.get(c1).center;
    expect(find(sk, sel, 'concentric').constraints).toEqual([
      ['coincident', [c1c, sk.entities.get(c2).center]],
      ['coincident', [c1c, ctr]],
    ]);
  });

  it('a point and a circle: On Curve and Concentric; not concentric with its own centre', () => {
    const sk = createSketch();
    const c = addCircleXY(sk, 0, 0, 5).circle;
    const p = addPoint(sk, 8, 8);
    expect(keys(sk, [p, c])).toEqual(['onCurve', 'concentric']);
    expect(keys(sk, [sk.entities.get(c).center, c])).toEqual(['onCurve']);
  });

  it('line + circle: Tangent; 2 points + line: Symmetric; point + line: On Line / Midpoint', () => {
    const sk = createSketch();
    const l = addLineXY(sk, 0, 0, 10, 0).line;
    const c = addCircleXY(sk, 5, 6, 5).circle;
    const p = addPoint(sk, 2, 3);
    const q = addPoint(sk, 2, -3);
    expect(keys(sk, [l, c])).toEqual(['tangent']);
    expect(keys(sk, [p, q, l])).toEqual(['symmetric']);
    expect(keys(sk, [p, l])).toEqual(['onLine', 'midpoint']);
  });

  it('every offered relation is a valid model constraint', () => {
    const sk = createSketch();
    const a = addLineXY(sk, 0, 0, 10, 0).line;
    const b = addLineXY(sk, 0, 5, 10, 8).line;
    const c1 = addCircleXY(sk, 0, 0, 5).circle;
    const c2 = addCircleXY(sk, 3, 1, 2).circle;
    for (const sel of [[a], [a, b], [c1, c2], [a, c1]]) {
      for (const r of relationsFor(sk, sel)) {
        for (const [kind, refs] of r.constraints) expect(() => addConstraint(sk, kind, refs)).not.toThrow();
      }
    }
  });
});
