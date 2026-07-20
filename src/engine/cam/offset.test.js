import { describe, it, expect } from 'vitest';
import {
  offsetLoops, clearingRings, areaOf, perimeterOf, differenceLoops, rectLoop,
} from './offset.js';

const square = (s) => rectLoop(-s / 2, -s / 2, s / 2, s / 2);
/** Clockwise square — the hole convention. */
const holeSquare = (s) => [-s / 2, -s / 2, -s / 2, s / 2, s / 2, s / 2, s / 2, -s / 2];

describe('areaOf and perimeterOf', () => {
  it('sign follows winding', () => {
    expect(areaOf(square(10))).toBeCloseTo(100, 6);
    expect(areaOf(holeSquare(10))).toBeCloseTo(-100, 6);
  });

  it('measures perimeter around the closing edge too', () => {
    expect(perimeterOf(square(10))).toBeCloseTo(40, 6);
  });
});

describe('offsetLoops', () => {
  it('grows a square outward by the offset on every side', () => {
    const out = offsetLoops([square(10)], 2);
    expect(out).toHaveLength(1);
    // Rounded corners, so the area is the square plus four bands plus a circle.
    const expected = 14 * 14 - (4 * 4 - Math.PI * 4);
    expect(Math.abs(areaOf(out[0]))).toBeCloseTo(expected, 0);
  });

  it('shrinks a square inward', () => {
    const out = offsetLoops([square(10)], -2);
    expect(Math.abs(areaOf(out[0]))).toBeCloseTo(36, 0);
  });

  it('returns nothing once the shape is offset away entirely', () => {
    expect(offsetLoops([square(10)], -6)).toEqual([]);
  });

  it('splits a dumbbell into two when the waist is offset through', () => {
    // Two squares joined by a thin neck; shrinking past the neck separates them.
    const dumbbell = [
      -20, -10, -10, -10, -10, -1, 10, -1, 10, -10, 20, -10,
      20, 10, 10, 10, 10, 1, -10, 1, -10, 10, -20, 10,
    ];
    expect(offsetLoops([dumbbell], -2).length).toBe(2);
  });

  it('moves a hole outward when the solid is shrunk', () => {
    // Outer CCW, hole CW: a negative delta must shrink the material, which
    // means the hole gets bigger, not smaller.
    const out = offsetLoops([square(40), holeSquare(10)], -2);
    const areas = out.map((p) => Math.abs(areaOf(p))).sort((a, b) => b - a);
    expect(areas[0]).toBeCloseTo(36 * 36, 0);   // outer shrank
    expect(areas[1]).toBeGreaterThan(100);       // hole grew
  });

  it('rounds corners by default, and squares them on request', () => {
    const round = Math.abs(areaOf(offsetLoops([square(10)], 3, { join: 'round' })[0]));
    const sq = Math.abs(areaOf(offsetLoops([square(10)], 3, { join: 'square' })[0]));
    expect(sq).toBeGreaterThan(round); // square joins fill the corner
  });

  it('ignores degenerate input instead of throwing', () => {
    expect(offsetLoops([[0, 0, 1, 1]], 1)).toEqual([]);
    expect(offsetLoops([], 1)).toEqual([]);
  });

  it('accepts loops in the {points} shape sliceLoops returns', () => {
    const out = offsetLoops([{ points: square(10), isHole: false }], -2);
    expect(Math.abs(areaOf(out[0]))).toBeCloseTo(36, 0);
  });
});

describe('clearingRings', () => {
  it('walks inward until the pocket closes', () => {
    const rings = clearingRings([square(20)], 3, 4);
    expect(rings.length).toBeGreaterThan(0);
    // Each ring is strictly smaller than the last.
    const areas = rings.map((r) => r.loops.reduce((s, l) => s + Math.abs(areaOf(l)), 0));
    for (let i = 1; i < areas.length; i++) expect(areas[i]).toBeLessThan(areas[i - 1]);
  });

  it('starts one tool radius in from the boundary', () => {
    const rings = clearingRings([square(20)], 3, 4);
    expect(rings[0].offset).toBe(-3);
    // A Ø6 cutter in a 20 mm square leaves a 14 mm centreline square.
    expect(Math.abs(areaOf(rings[0].loops[0]))).toBeCloseTo(196, 0);
  });

  it('produces nothing when the tool cannot even enter', () => {
    expect(clearingRings([square(4)], 3, 2)).toEqual([]);
  });

  it('terminates on a tiny stepover rather than spinning', () => {
    const rings = clearingRings([square(20)], 1, 0.05, { maxRings: 40 });
    expect(rings.length).toBeLessThanOrEqual(40);
  });
});

describe('differenceLoops', () => {
  it('leaves the stock minus the part', () => {
    const stock = [rectLoop(0, 0, 100, 100)];
    const part = [rectLoop(25, 25, 75, 75)];
    const out = differenceLoops(stock, part);
    // The result is a frame: an outer boundary plus a hole. Net area is the
    // signed sum — adding magnitudes would count the hole as material.
    expect(out).toHaveLength(2);
    const net = out.reduce((s, l) => s + areaOf(l), 0);
    expect(net).toBeCloseTo(100 * 100 - 50 * 50, 0);
  });

  it('returns nothing when the part fills the stock', () => {
    expect(differenceLoops([rectLoop(0, 0, 10, 10)], [rectLoop(-1, -1, 11, 11)])).toEqual([]);
  });
});
