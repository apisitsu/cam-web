import { describe, it, expect } from 'vitest';
import {
  createSketch, addPoint, addLine, addCircle, addArc, addConstraint,
} from './model.js';
import { dimensionAnnotations, fmtDim } from './annotations.js';

const DEG = Math.PI / 180;
/** Distance from a label to a point, for "is it near the geometry" checks. */
const distTo = (label, x, y) => Math.hypot(label.pos[0] - x, label.pos[1] - y);

describe('dimensionAnnotations — what gets drawn at all', () => {
  it('draws nothing for a sketch with no dimensions', () => {
    const sk = createSketch();
    addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0));
    addConstraint(sk, 'horizontal', [1, 2]); // a relation, not a size
    const { segs, labels } = dimensionAnnotations(sk);
    expect(segs).toHaveLength(0);
    expect(labels).toHaveLength(0);
  });

  it('survives an empty or malformed sketch instead of throwing', () => {
    expect(dimensionAnnotations(null)).toEqual({ segs: [], labels: [] });
    expect(dimensionAnnotations(createSketch())).toEqual({ segs: [], labels: [] });
  });

  it('skips a constraint whose geometry was deleted', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    addConstraint(sk, 'distance', [a, b], 10);
    sk.entities.delete(b); // a dangling reference must not crash the viewport
    expect(() => dimensionAnnotations(sk)).not.toThrow();
    expect(dimensionAnnotations(sk).labels).toHaveLength(0);
  });

  it('gives every segment and label a unique key', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    const c = addPoint(sk, 10, 8);
    addConstraint(sk, 'distance', [a, b], 10);
    addConstraint(sk, 'distance', [b, c], 8);
    const { segs, labels } = dimensionAnnotations(sk);
    const keys = [...segs, ...labels].map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('tags each label with the constraint index, so double-click can edit it', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    addConstraint(sk, 'horizontal', [a, b]);   // index 0, not drawn
    addConstraint(sk, 'distance', [a, b], 10); // index 1
    const { labels } = dimensionAnnotations(sk);
    expect(labels).toHaveLength(1);
    expect(labels[0].ci).toBe(1);
  });

  it('lifts everything to the requested z so it clears the pick plane', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    addConstraint(sk, 'distance', [a, b], 10);
    const { segs, labels } = dimensionAnnotations(sk, { z: 0.05 });
    for (const s of segs) for (const p of s.pts) expect(p[2]).toBe(0.05);
    for (const l of labels) expect(l.pos[2]).toBe(0.05);
  });
});

describe('dimensionAnnotations — distance', () => {
  const sk = () => {
    const s = createSketch();
    addConstraint(s, 'distance', [addPoint(s, 0, 0), addPoint(s, 10, 0)], 10);
    return s;
  };

  it('draws two witness lines and a dimension line standing off the geometry', () => {
    const { segs, labels } = dimensionAnnotations(sk());
    expect(segs).toHaveLength(3);
    // The dimension line is parallel to the measured pair, offset off-axis.
    const dim = segs[2];
    expect(dim.pts[0][1]).toBeCloseTo(dim.pts[1][1], 9);
    expect(Math.abs(dim.pts[0][1])).toBeGreaterThan(0);
    expect(labels[0].text).toBe('10');
  });

  it('puts the label mid-span on the dimension line', () => {
    const { segs, labels } = dimensionAnnotations(sk());
    const dim = segs[2];
    expect(labels[0].pos[0]).toBeCloseTo((dim.pts[0][0] + dim.pts[1][0]) / 2, 9);
    expect(labels[0].pos[1]).toBeCloseTo(dim.pts[0][1], 9);
  });
});

describe('dimensionAnnotations — axis-locked dX / dY', () => {
  const build = (kind) => {
    const s = createSketch();
    const a = addPoint(s, 0, 0);
    const b = addPoint(s, 100, 40);
    addConstraint(s, kind, [a, b], kind === 'distanceX' ? 100 : 40);
    return dimensionAnnotations(s);
  };

  it('runs the dX line along X only — never diagonally', () => {
    const { segs } = build('distanceX');
    const dim = segs[segs.length - 1];
    expect(dim.pts[0][1]).toBeCloseTo(dim.pts[1][1], 9);
  });

  it('runs the dY line along Y only', () => {
    const { segs } = build('distanceY');
    const dim = segs[segs.length - 1];
    expect(dim.pts[0][0]).toBeCloseTo(dim.pts[1][0], 9);
  });

  it('shows the magnitude even though the stored value is signed', () => {
    const s = createSketch();
    const a = addPoint(s, 0, 0);
    const b = addPoint(s, -30, 0);
    addConstraint(s, 'distanceX', [a, b], -30); // planegcs stores p2 − p1
    expect(dimensionAnnotations(s).labels[0].text).toBe('30');
  });
});

describe('dimensionAnnotations — circles and arcs', () => {
  it('draws a diameter line across the circle with a Ø label', () => {
    const sk = createSketch();
    const c = addCircle(sk, addPoint(sk, 0, 0), 10);
    addConstraint(sk, 'diameter', [c], 20);
    const { segs, labels } = dimensionAnnotations(sk);
    expect(segs).toHaveLength(1);
    // The line spans the full diameter through the centre.
    const [p, q] = segs[0].pts;
    expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeCloseTo(20, 6);
    expect(labels[0].text).toBe('Ø20');
  });

  it('labels a radius without drawing a line across the circle', () => {
    const sk = createSketch();
    const c = addCircle(sk, addPoint(sk, 0, 0), 10);
    addConstraint(sk, 'radius', [c], 10);
    const { segs, labels } = dimensionAnnotations(sk);
    expect(segs).toHaveLength(0);
    expect(labels[0].text).toBe('R10');
  });

  it('draws an arc radius as a spoke to the arc midpoint', () => {
    const sk = createSketch();
    // Quarter arc, centre (0,0) r10, from (10,0) CCW to (0,10) → midpoint at 45°.
    const arc = addArc(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0), addPoint(sk, 0, 10), 10);
    addConstraint(sk, 'arcRadius', [arc], 10);
    const { segs, labels } = dimensionAnnotations(sk);
    const [ctr, rim] = segs[0].pts;
    expect(ctr[0]).toBeCloseTo(0, 9);
    expect(rim[0]).toBeCloseTo(10 * Math.cos(45 * DEG), 6);
    expect(rim[1]).toBeCloseTo(10 * Math.sin(45 * DEG), 6);
    expect(labels[0].text).toBe('R10');
  });
});

describe('dimensionAnnotations — angle', () => {
  it('sweeps an arc between the legs and labels the interior angle', () => {
    const sk = createSketch();
    const v = addPoint(sk, 0, 0);
    const l1 = addLine(sk, v, addPoint(sk, 10, 0));                 // along +X
    const l2 = addLine(sk, v, addPoint(sk, 10 * Math.cos(60 * DEG), 10 * Math.sin(60 * DEG)));
    addConstraint(sk, 'angle', [l1, l2], 60 * DEG);
    const { segs, labels } = dimensionAnnotations(sk);
    // A polyline, not a straight segment.
    expect(segs[0].pts.length).toBeGreaterThan(10);
    // Every point of the sweep sits at the same radius about the vertex.
    const radii = segs[0].pts.map((p) => Math.hypot(p[0], p[1]));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-6);
    // A 60° corner must read 60, not the 120° supplement.
    expect(labels[0].text).toBe('60°');
  });

  it('takes the shorter sweep between the legs', () => {
    const sk = createSketch();
    const v = addPoint(sk, 0, 0);
    const l1 = addLine(sk, v, addPoint(sk, 10, 0));
    const l2 = addLine(sk, v, addPoint(sk, -10, -1)); // ~186° apart the long way
    addConstraint(sk, 'angle', [l1, l2], 174 * DEG);
    const { labels } = dimensionAnnotations(sk);
    expect(Number(labels[0].text.replace('°', ''))).toBeLessThanOrEqual(180);
  });
});

describe('dimensionAnnotations — point to line', () => {
  it('draws the perpendicular from the point to its foot', () => {
    const sk = createSketch();
    const line = addLine(sk, addPoint(sk, -10, 5), addPoint(sk, 10, 5));
    const p = addPoint(sk, 0, 0);
    addConstraint(sk, 'pointLineDistance', [p, line], 5);
    const { segs, labels } = dimensionAnnotations(sk);
    expect(segs[0].pts[0]).toEqual([0, 0, 0]);
    expect(segs[0].pts[1][0]).toBeCloseTo(0, 9);
    expect(segs[0].pts[1][1]).toBeCloseTo(5, 9);
    expect(labels[0].text).toBe('5');
  });

  it('extends a witness along the line when the foot lands past the segment', () => {
    const sk = createSketch();
    const line = addLine(sk, addPoint(sk, 20, 5), addPoint(sk, 40, 5));
    const p = addPoint(sk, 0, 0); // foot at x=0, well before the segment start
    addConstraint(sk, 'pointLineDistance', [p, line], 5);
    const { segs } = dimensionAnnotations(sk);
    expect(segs).toHaveLength(2); // perpendicular + the extension witness
  });
});

describe('dimensionAnnotations — locks', () => {
  it('labels lockX and lockY near the point, with the axis letter', () => {
    const sk = createSketch();
    const p = addPoint(sk, 12, 7);
    addConstraint(sk, 'lockX', [p], 12);
    addConstraint(sk, 'lockY', [p], 7);
    const { labels } = dimensionAnnotations(sk);
    expect(labels.map((l) => l.text)).toEqual(['X12', 'Y7']);
    for (const l of labels) expect(distTo(l, 12, 7)).toBeLessThan(5);
  });
});

describe('fmtDim', () => {
  it('rounds to two decimals and drops trailing noise', () => {
    expect(fmtDim(10)).toBe('10');
    expect(fmtDim(10.004)).toBe('10');
    expect(fmtDim(10.006)).toBe('10.01');
    expect(fmtDim(0.1 + 0.2)).toBe('0.3');
  });
});
