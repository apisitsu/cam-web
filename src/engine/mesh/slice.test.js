import { describe, it, expect } from 'vitest';
import { weld } from './stl.js';
import {
  slicePlane, chainSegments, sliceLoops, loopArea, loopLength, zLevels,
} from './slice.js';
import { box, cylinder, steppedShaft, prism } from './fixtures.js';

/** A box with a square hole through it — outer loop plus a hole loop. */
function boxWithHole(outer = 40, hole = 10, height = 20) {
  const o = box(outer, outer, height);
  const i = box(hole, hole, height + 2); // through, so it clears both faces
  // Flip the inner box's winding so it reads as a void.
  const inner = new Float32Array(i.positions);
  for (let t = 0; t < i.triangleCount; t++) {
    const b = t * 9;
    for (let k = 0; k < 3; k++) {
      const tmp = inner[b + 3 + k]; inner[b + 3 + k] = inner[b + 6 + k]; inner[b + 6 + k] = tmp;
    }
  }
  const positions = new Float32Array(o.positions.length + inner.length);
  positions.set(o.positions);
  positions.set(inner, o.positions.length);
  return { positions, triangleCount: o.triangleCount + i.triangleCount };
}

describe('slicePlane', () => {
  it('cuts a box into four segments at mid-height', () => {
    const seg = slicePlane(weld(box(10, 10, 10)), 2, 0);
    // Each of the four side faces is two triangles, and the plane crosses both.
    expect(seg.length / 4).toBe(8);
  });

  it('returns nothing above or below the solid', () => {
    expect(slicePlane(weld(box(10, 10, 10)), 2, 20).length).toBe(0);
    expect(slicePlane(weld(box(10, 10, 10)), 2, -20).length).toBe(0);
  });

  it('handles a plane exactly on a face without exploding', () => {
    // The top face lies in the plane; nudging must keep the count sane rather
    // than emitting the whole cap as segments.
    const seg = slicePlane(weld(box(10, 10, 10)), 2, 5);
    expect(seg.length % 4).toBe(0);
    expect(seg.length / 4).toBeLessThan(20);
  });

  it('slices along any axis', () => {
    for (const axis of [0, 1, 2]) {
      expect(slicePlane(weld(box(10, 10, 10)), axis, 0).length / 4).toBe(8);
    }
  });
});

describe('chainSegments', () => {
  it('stitches a square from its four sides, given in scrambled order', () => {
    const segs = Float64Array.from([
      1, 1, -1, 1,   // top, right-to-left
      -1, -1, 1, -1, // bottom
      1, -1, 1, 1,   // right
      -1, 1, -1, -1, // left
    ]);
    const { closed, open } = chainSegments(segs);
    expect(open).toHaveLength(0);
    expect(closed).toHaveLength(1);
    expect(closed[0].length / 2).toBe(4);
    expect(Math.abs(loopArea(closed[0]))).toBeCloseTo(4, 6);
  });

  it('joins endpoints that differ in the last float bit', () => {
    const e = 1e-9;
    const segs = Float64Array.from([
      0, 0, 10, 0,
      10 + e, 0 - e, 10, 10,
      10, 10, 0, 10,
      0, 10, 0, 0,
    ]);
    expect(chainSegments(segs).closed).toHaveLength(1);
  });

  it('reports an unclosed chain as open rather than dropping it', () => {
    const segs = Float64Array.from([0, 0, 10, 0, 10, 0, 10, 10]);
    const { closed, open } = chainSegments(segs);
    expect(closed).toHaveLength(0);
    expect(open).toHaveLength(1);
    expect(open[0].length / 2).toBe(3);
  });

  it('separates two disjoint loops', () => {
    const square = (cx, s) => [
      cx - s, -s, cx + s, -s, cx + s, -s, cx + s, s,
      cx + s, s, cx - s, s, cx - s, s, cx - s, -s,
    ];
    const segs = Float64Array.from([...square(0, 1), ...square(50, 1)]);
    expect(chainSegments(segs).closed).toHaveLength(2);
  });

  it('handles an empty input', () => {
    expect(chainSegments(new Float64Array(0))).toEqual({ closed: [], open: [] });
  });
});

describe('loopArea and loopLength', () => {
  it('signs area by winding', () => {
    const ccw = [0, 0, 10, 0, 10, 10, 0, 10];
    const cw = [0, 0, 0, 10, 10, 10, 10, 0];
    expect(loopArea(ccw)).toBeCloseTo(100, 6);
    expect(loopArea(cw)).toBeCloseTo(-100, 6);
  });

  it('measures perimeter, closed or open', () => {
    const sq = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(loopLength(sq, true)).toBeCloseTo(40, 6);
    expect(loopLength(sq, false)).toBeCloseTo(30, 6);
  });
});

describe('sliceLoops', () => {
  it('finds one closed square through a box', () => {
    const { loops, openCount } = sliceLoops(weld(box(20, 20, 10)), 2, 0);
    expect(openCount).toBe(0);
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBeCloseTo(400, 3);
    expect(loops[0].isHole).toBe(false);
  });

  it('finds the outer boundary and the hole, outer first', () => {
    const { loops } = sliceLoops(weld(boxWithHole(40, 10, 20)), 2, 0);
    expect(loops).toHaveLength(2);
    expect(loops[0].area).toBeCloseTo(1600, 2);
    expect(loops[1].area).toBeCloseTo(100, 2);
    // The convention every later stage relies on: outer CCW, hole CW.
    expect(loops[0].isHole).toBe(false);
    expect(loops[1].isHole).toBe(true);
  });

  it('recovers a circle of the right area from a cylinder', () => {
    const { loops } = sliceLoops(weld(cylinder(10, 20, 128)), 2, 10);
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBeCloseTo(Math.PI * 100, 0);
  });

  it('follows a stepped shaft to the right diameter at each height', () => {
    const m = weld(steppedShaft(10, 15, 6, 10, 64));
    const low = sliceLoops(m, 2, 7);
    const high = sliceLoops(m, 2, 20);
    expect(low.loops[0].area).toBeCloseTo(Math.PI * 100, -1);
    expect(high.loops[0].area).toBeCloseTo(Math.PI * 36, -1);
  });

  it('drops degenerate slivers', () => {
    // Grazing the very top of a cylinder should not yield a hairline loop.
    const { loops } = sliceLoops(weld(cylinder(10, 20, 32)), 2, 19.9999);
    expect(loops.every((l) => l.area > 1e-6)).toBe(true);
  });

  it('sections a revolve through its axis to give the turned profile', () => {
    // This is the turning path: cut on Y=0 and read the X,Z outline.
    // The stepped-shaft fixture is two stacked shells rather than one fused
    // solid, so the section legitimately comes back as one loop per stage —
    // which is why the turning profile is built from all loops, not just the
    // largest.
    const { loops } = sliceLoops(weld(steppedShaft(10, 15, 6, 10, 64)), 1, 0);
    expect(loops.length).toBeGreaterThan(0);
    let maxX = -Infinity, maxZ = -Infinity;
    for (const l of loops) {
      for (let i = 0; i < l.points.length; i += 2) {
        maxX = Math.max(maxX, l.points[i]);
        maxZ = Math.max(maxZ, l.points[i + 1]);
      }
    }
    expect(maxX).toBeCloseTo(10, 1); // the big diameter's radius
    expect(maxZ).toBeCloseTo(25, 1); // total length
  });

  it('reads nesting, not mesh winding, when the STL is inside-out', () => {
    // Flipping every triangle must not turn the pocket into an island.
    const m = boxWithHole(40, 10, 20);
    for (let t = 0; t < m.triangleCount; t++) {
      const b = t * 9;
      for (let k = 0; k < 3; k++) {
        const tmp = m.positions[b + 3 + k];
        m.positions[b + 3 + k] = m.positions[b + 6 + k];
        m.positions[b + 6 + k] = tmp;
      }
    }
    const { loops } = sliceLoops(weld(m), 2, 0);
    expect(loops[0].isHole).toBe(false);
    expect(loops[1].isHole).toBe(true);
    expect(loops[0].signedArea).toBeGreaterThan(0);
    expect(loops[1].signedArea).toBeLessThan(0);
  });

  it('keeps a polygon section exact', () => {
    // A 6-sided prism of radius 10: area = (3*sqrt(3)/2) * r^2
    const { loops } = sliceLoops(weld(prism(new Array(6).fill(10), 20)), 2, 10);
    expect(loops[0].area).toBeCloseTo((3 * Math.sqrt(3) / 2) * 100, 3);
  });
});

describe('zLevels', () => {
  it('spaces passes evenly and lands exactly on the floor', () => {
    const l = zLevels(10, 0, 3);
    expect(l).toHaveLength(4);            // ceil(10/3)
    expect(l[l.length - 1]).toBeCloseTo(0, 9);
    // Evenly spaced: no thin last pass.
    const steps = l.map((z, i) => (i === 0 ? 10 - z : l[i - 1] - z));
    for (const s of steps) expect(s).toBeCloseTo(2.5, 9);
  });

  it('takes a single pass when the depth already fits', () => {
    expect(zLevels(10, 8, 3)).toEqual([8]);
  });

  it('returns just the floor for zero depth', () => {
    expect(zLevels(5, 5, 2)).toEqual([5]);
  });

  it('rejects a non-positive stepdown instead of looping forever', () => {
    expect(() => zLevels(10, 0, 0)).toThrow(/positive/);
  });
});
