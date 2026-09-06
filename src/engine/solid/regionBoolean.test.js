import { describe, it, expect } from 'vitest';
import { combineRegions, BOOLEAN_OPS } from './regionBoolean.js';
import { loopArea } from '../mesh/slice.js';

const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
/**
 * Reverse a loop's winding. `Array.reverse()` on a flat loop reverses the
 * *numbers*, which rotates the points and leaves the winding exactly as it was —
 * a hole built that way is still an outer, and the boolean unions it instead.
 */
const reverseLoop = (flat) => {
  const out = [];
  for (let i = flat.length - 2; i >= 0; i -= 2) out.push(flat[i], flat[i + 1]);
  return out;
};
const region = (outer, holes = []) => ({ outer, holes, area: Math.abs(loopArea(outer)), entities: [] });

/** Net area of a region set — outers less their holes. */
const netArea = (regions) => regions.reduce(
  (sum, r) => sum + Math.abs(loopArea(r.outer)) - r.holes.reduce((h, l) => h + Math.abs(loopArea(l)), 0),
  0,
);

describe('combineRegions — union', () => {
  it('merges two overlapping squares into one outline', () => {
    const out = combineRegions([region(square(0, 0, 20, 20)), region(square(10, 10, 30, 30))], 'union');
    expect(out).toHaveLength(1);
    // 400 + 400 less the 10×10 counted twice.
    expect(netArea(out)).toBeCloseTo(400 + 400 - 100, 3);
  });

  it('leaves two separate squares as two regions', () => {
    const out = combineRegions([region(square(0, 0, 10, 10)), region(square(30, 0, 40, 10))], 'union');
    expect(out).toHaveLength(2);
    expect(netArea(out)).toBeCloseTo(200, 3);
  });
});

describe('combineRegions — difference', () => {
  it('subtracts a smaller square from the first, leaving a notch', () => {
    const out = combineRegions([region(square(0, 0, 40, 40)), region(square(30, 30, 50, 50))], 'difference');
    expect(out).toHaveLength(1);
    expect(netArea(out)).toBeCloseTo(1600 - 100, 3);
  });

  it('turns a fully enclosed square into a hole, not a second body', () => {
    // The whole reason grouping is redone after a boolean: this comes back as
    // one region with a hole, which extrudes to a plate with a pocket — not as
    // two solids, one of them sitting inside the other.
    const out = combineRegions([region(square(0, 0, 40, 40)), region(square(10, 10, 20, 20))], 'difference');
    expect(out).toHaveLength(1);
    expect(out[0].holes).toHaveLength(1);
    expect(netArea(out)).toBeCloseTo(1600 - 100, 3);
    // Convention holds on the way out: outer CCW, hole CW.
    expect(loopArea(out[0].outer)).toBeGreaterThan(0);
    expect(loopArea(out[0].holes[0])).toBeLessThan(0);
  });

  it('subtracts every later region, not only the second', () => {
    const out = combineRegions([
      region(square(0, 0, 40, 40)),
      region(square(0, 0, 10, 10)),
      region(square(30, 30, 40, 40)),
    ], 'difference');
    expect(netArea(out)).toBeCloseTo(1600 - 100 - 100, 3);
  });

  it('keeps a hole the subject already had', () => {
    const plate = region(square(0, 0, 40, 40), [reverseLoop(square(20, 20, 25, 25))]);
    const out = combineRegions([plate, region(square(0, 0, 10, 10))], 'difference');
    expect(netArea(out)).toBeCloseTo(1600 - 25 - 100, 3);
  });
});

describe('combineRegions — intersect and exclude', () => {
  it('keeps only the overlap', () => {
    const out = combineRegions([region(square(0, 0, 20, 20)), region(square(10, 10, 30, 30))], 'intersect');
    expect(out).toHaveLength(1);
    expect(netArea(out)).toBeCloseTo(100, 3);
  });

  it('is empty when nothing overlaps', () => {
    const out = combineRegions([region(square(0, 0, 10, 10)), region(square(30, 0, 40, 10))], 'intersect');
    expect(out).toHaveLength(0);
  });

  it('excludes the overlap and keeps the rest', () => {
    const out = combineRegions([region(square(0, 0, 20, 20)), region(square(10, 10, 30, 30))], 'xor');
    expect(netArea(out)).toBeCloseTo(400 + 400 - 2 * 100, 3);
  });
});

describe('combineRegions — edges', () => {
  it('returns a single region untouched, without re-tessellating it', () => {
    const only = region(square(0, 0, 10, 10));
    expect(combineRegions([only], 'union')[0]).toBe(only);
  });

  it('is empty for no regions', () => {
    expect(combineRegions([], 'union')).toEqual([]);
  });

  it('refuses an operation it does not have', () => {
    expect(() => combineRegions([region(square(0, 0, 1, 1))], 'squish')).toThrow(/unknown boolean op/i);
  });

  it('names every operation it offers', () => {
    for (const op of Object.keys(BOOLEAN_OPS)) {
      expect(() => combineRegions(
        [region(square(0, 0, 20, 20)), region(square(10, 10, 30, 30))],
        op,
      )).not.toThrow();
    }
  });
});
