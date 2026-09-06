import { describe, it, expect } from 'vitest';
import { createSketch, addPoint } from './model.js';
import {
  buildSlot, buildPolygon, polygonPreview, slotPreview, axisDistance,
} from './shapes.js';
import { sketchLoops } from './loops.js';

const ofType = (sk, t) => [...sk.entities.values()].filter((e) => e.type === t);
const kinds = (sk) => sk.constraints.map((c) => c.kind);

describe('buildSlot', () => {
  it('builds two flanks and two caps that chain into one closed profile', () => {
    const sk = createSketch();
    const built = buildSlot(sk, 0, 0, 30, 0, 5);
    expect(built.lines).toHaveLength(2);
    expect(built.arcs).toHaveLength(2);
    const { loops, open, branches } = sketchLoops(sk);
    expect(open).toHaveLength(0);
    expect(branches).toHaveLength(0);
    expect(loops).toHaveLength(1);
    // A 30 × 10 body plus a full circle of r = 5 from the two caps.
    expect(loops[0].area).toBeCloseTo(300 + Math.PI * 25, 0);
  });

  it('encloses the right area whatever direction the axis runs', () => {
    for (const [x2, y2] of [[30, 0], [0, 30], [-30, 0], [21.21, 21.21]]) {
      const sk = createSketch();
      buildSlot(sk, 0, 0, x2, y2, 5);
      const { loops } = sketchLoops(sk);
      // eslint-disable-next-line jest/valid-expect
      expect(loops, `axis ${x2},${y2}`).toHaveLength(1);
      const len = Math.hypot(x2, y2);
      expect(loops[0].area).toBeCloseTo(len * 10 + Math.PI * 25, 0);
    }
  });

  it('constrains itself so it stays a slot: tangent flanks and equal caps', () => {
    const sk = createSketch();
    buildSlot(sk, 0, 0, 30, 0, 5);
    const k = kinds(sk);
    expect(k.filter((x) => x === 'tangentArc')).toHaveLength(4);
    expect(k.filter((x) => x === 'equalRadius')).toHaveLength(1);
  });

  it('shares the flank ends with the cap ends rather than doubling them', () => {
    // Two centres plus four tangent points, and nothing else.
    const sk = createSketch();
    buildSlot(sk, 0, 0, 30, 0, 5);
    expect(ofType(sk, 'point')).toHaveLength(6);
  });

  it('refuses a zero-length axis or a zero radius', () => {
    const sk = createSketch();
    expect(buildSlot(sk, 5, 5, 5, 5, 5)).toBeNull();
    expect(buildSlot(sk, 0, 0, 30, 0, 0)).toBeNull();
    expect(sk.entities.size).toBe(0);
  });

  it('refuses a slot so short the caps would swallow the flanks', () => {
    // Welding would collapse two of the six points onto each other.
    const sk = createSketch();
    expect(buildSlot(sk, 0, 0, 1e-9, 0, 5)).toBeNull();
  });
});

describe('buildPolygon', () => {
  it('builds a hexagon that closes, with the right area', () => {
    const sk = createSketch();
    const built = buildPolygon(sk, 0, 0, 10, 0, 6);
    expect(built.lines).toHaveLength(6);
    expect(built.vertices).toHaveLength(6);
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(1);
    // Regular n-gon inscribed in r: (n/2) r² sin(2π/n)
    expect(loops[0].area).toBeCloseTo(3 * 100 * Math.sin(Math.PI / 3), 6);
  });

  it('works for any side count it accepts', () => {
    for (const n of [3, 4, 5, 8, 12]) {
      const sk = createSketch();
      buildPolygon(sk, 0, 0, 10, 0, n);
      const { loops } = sketchLoops(sk);
      // eslint-disable-next-line jest/valid-expect
      expect(loops, `${n}-gon`).toHaveLength(1);
      expect(loops[0].area).toBeCloseTo((n / 2) * 100 * Math.sin((Math.PI * 2) / n), 6);
    }
  });

  it('takes its rotation from where the vertex was clicked', () => {
    const sk = createSketch();
    const built = buildPolygon(sk, 0, 0, 0, 10, 4); // first vertex straight up
    const v = sk.entities.get(built.vertices[0]);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(10);
  });

  it('keeps its circumscribed circle as construction, out of the profile', () => {
    const sk = createSketch();
    const built = buildPolygon(sk, 0, 0, 10, 0, 6);
    expect(sk.entities.get(built.circle).construction).toBe(true);
    // The profile is the hexagon alone — the circle contributes no second loop.
    expect(sketchLoops(sk).loops).toHaveLength(1);
  });

  it('pins every vertex to that circle and makes the sides equal', () => {
    const sk = createSketch();
    buildPolygon(sk, 0, 0, 10, 0, 6);
    const k = kinds(sk);
    expect(k.filter((x) => x === 'pointOnCircle')).toHaveLength(6);
    // n−1, not n: the last is implied by the others and would over-define it.
    expect(k.filter((x) => x === 'equalLength')).toHaveLength(5);
  });

  it('refuses a side count or a radius it cannot build', () => {
    const sk = createSketch();
    expect(buildPolygon(sk, 0, 0, 10, 0, 2)).toBeNull();
    expect(buildPolygon(sk, 0, 0, 10, 0, 500)).toBeNull();
    expect(buildPolygon(sk, 0, 0, 0, 0, 6)).toBeNull();
    expect(sk.entities.size).toBe(0);
  });
});

describe('previews', () => {
  it('draws a closed polygon outline with one point per corner plus the join', () => {
    const pts = polygonPreview(0, 0, 10, 0, 5);
    expect(pts).toHaveLength(6);
    expect(pts[0][0]).toBeCloseTo(pts[5][0]);
    expect(pts[0][1]).toBeCloseTo(pts[5][1]);
  });

  it('draws a closed slot outline whose extent matches the slot', () => {
    const pts = slotPreview(0, 0, 30, 0, 5);
    expect(pts.length).toBeGreaterThan(8);
    expect(pts[0]).toEqual(pts[pts.length - 1]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(-5, 1);
    expect(Math.max(...xs)).toBeCloseTo(35, 1);
    expect(Math.max(...ys)).toBeCloseTo(5, 6);
  });

  it('is empty for a degenerate preview rather than throwing', () => {
    expect(polygonPreview(0, 0, 10, 0, 2)).toEqual([]);
    expect(slotPreview(0, 0, 0, 0, 5)).toEqual([]);
  });
});

describe('axisDistance', () => {
  it('measures perpendicular distance to the infinite line, not to its ends', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 30, y: 0 };
    expect(axisDistance(15, 7, a, b)).toBeCloseTo(7);
    // Beyond the segment, still the perpendicular distance to the line.
    expect(axisDistance(100, 7, a, b)).toBeCloseTo(7);
    expect(axisDistance(15, -7, a, b)).toBeCloseTo(7);
  });

  it('works on a slanted axis', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 10 };
    expect(axisDistance(10, 0, a, b)).toBeCloseTo(Math.SQRT1_2 * 10);
  });

  it('falls back to the distance from the point when the axis has no length', () => {
    expect(axisDistance(3, 4, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5);
  });
});

describe('the pick tolerance must not decide whether a shape is degenerate', () => {
  it('builds a small slot even when the view is zoomed far out', () => {
    // The regression: `pickTol` is `9 / zoom`, so zooming out grew it without
    // limit, and it was being used to weld the slot's *own* tangent points. Any
    // slot narrower than the tolerance collapsed onto its centreline and the
    // build returned nothing — three clicks, no shape, no message.
    for (const tol of [1.5, 4, 9, 30]) {
      for (const r of [1, 2, 5]) {
        const sk = createSketch();
        // eslint-disable-next-line jest/valid-expect
        expect(buildSlot(sk, 0, 0, 30, 0, r, tol), `r=${r} at pickTol=${tol}`).not.toBeNull();
        // eslint-disable-next-line jest/valid-expect
        expect(sketchLoops(sk).loops, `r=${r} at pickTol=${tol}`).toHaveLength(1);
      }
    }
  });

  it('builds a small polygon at a coarse pick tolerance too', () => {
    for (const tol of [4, 9, 30]) {
      const sk = createSketch();
      // eslint-disable-next-line jest/valid-expect
      expect(buildPolygon(sk, 0, 0, 3, 0, 6, tol), `pickTol=${tol}`).not.toBeNull();
      expect(sketchLoops(sk).loops).toHaveLength(1);
    }
  });

  it('still refuses what is genuinely degenerate', () => {
    const sk = createSketch();
    expect(buildSlot(sk, 0, 0, 30, 0, 0, 9)).toBeNull();       // no radius
    expect(buildSlot(sk, 5, 5, 5, 5, 5, 9)).toBeNull();        // no axis
    expect(buildPolygon(sk, 0, 0, 0, 0, 6, 9)).toBeNull();     // no radius
  });

  it('still snaps the points the user actually clicked to existing geometry', () => {
    // The centres keep the pick tolerance — that is what "click near a point to
    // reuse it" means, and it is a different question from the one above.
    const sk = createSketch();
    const existing = addPoint(sk, 0, 0);
    const built = buildSlot(sk, 0.5, 0.4, 30, 0, 5, 1.5);
    expect(built.centers[0]).toBe(existing);
  });
});
