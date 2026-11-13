import { describe, it, expect } from 'vitest';
import { sweepSolid, loftSolid } from './sweep.js';
import { volume, isClosed, bounds } from './solidAssert.js';
import { createFeature, rebuildFeatures, featureSketchIds } from './featureTree.js';
import { createSketch, addPoint, addLine } from '../sketch/model.js';

const square = (h) => [-h, -h, h, -h, h, h, -h, h];
const XY = { preset: 'XY', offset: 0 };
const YZ = { preset: 'YZ', offset: 0 };

describe('sweepSolid', () => {
  it('a straight sweep is a prism', () => {
    const s = sweepSolid({ outer: square(5) }, YZ, [0, 0, 40, 0], XY);
    expect(isClosed(s)).toBe(true);
    expect(volume(s)).toBeCloseTo(100 * 40, 3);
    expect(bounds(s).max[0]).toBeCloseTo(40, 4);
  });

  it('mitres a corner: volume is the area times the centreline', () => {
    const s = sweepSolid({ outer: square(5) }, YZ, [0, 0, 50, 0, 50, 40], XY);
    expect(isClosed(s)).toBe(true);
    expect(volume(s)).toBeCloseTo(100 * 90, 2);
  });

  it('keeps a hole in the profile through the sweep (a tube)', () => {
    const s = sweepSolid({ outer: square(5), holes: [[-3, -3, -3, 3, 3, 3, 3, -3]] }, YZ, [0, 0, 30, 0, 30, 30], XY);
    expect(isClosed(s)).toBe(true);
    expect(volume(s)).toBeCloseTo((100 - 36) * 60, 2);
  });

  it('refuses a profile lying along the path', () => {
    expect(() => sweepSolid({ outer: square(5) }, XY, [0, 0, 40, 0], XY)).toThrow(/across the start/);
  });
});

describe('loftSolid', () => {
  it('lofts a big square into a small one above it: a frustum', () => {
    const s = loftSolid([
      { outer: square(10), plane: XY },
      { outer: square(5), plane: { preset: 'XY', offset: 20 } },
    ]);
    expect(isClosed(s)).toBe(true);
    expect(volume(s)).toBeCloseTo((20 / 3) * (400 + 100 + 200), 2);
  });

  it('lofts a square into a circle, keeping every corner', () => {
    const circle = [];
    for (let i = 0; i < 64; i++) circle.push(6 * Math.cos((2 * Math.PI * i) / 64), 6 * Math.sin((2 * Math.PI * i) / 64));
    const s = loftSolid([
      { outer: square(10), plane: XY },
      { outer: circle, plane: { preset: 'XY', offset: 15 } },
    ]);
    expect(isClosed(s)).toBe(true);
    expect(volume(s)).toBeGreaterThan(0);
    const b = bounds(s);
    expect(b.min[0]).toBeCloseTo(-10, 4);
    expect(b.max[2]).toBeCloseTo(15, 4);
  });

  it('needs two profiles in different places', () => {
    expect(() => loftSolid([{ outer: square(5), plane: XY }])).toThrow(/two profiles/);
    expect(() => loftSolid([{ outer: square(5), plane: XY }, { outer: square(5), plane: XY }])).toThrow(/one place/);
  });
});

describe('sweep / loft features in the tree', () => {
  const poly = (pts, closed) => {
    const sk = createSketch();
    const ids = pts.map(([x, y]) => addPoint(sk, x, y));
    for (let i = 0; i + 1 < ids.length; i++) addLine(sk, ids[i], ids[i + 1]);
    if (closed) addLine(sk, ids[ids.length - 1], ids[0]);
    return sk;
  };
  const sketches = {
    1: { doc: poly([[-5, -5], [5, -5], [5, 5], [-5, 5]], true), plane: YZ },
    2: { doc: poly([[0, 0], [50, 0], [50, 40]], false), plane: XY },
    3: { doc: poly([[-10, -10], [10, -10], [10, 10], [-10, 10]], true), plane: XY },
    4: { doc: poly([[-5, -5], [5, -5], [5, 5], [-5, 5]], true), plane: { preset: 'XY', offset: 20 } },
  };
  const ctx = { sketchOf: (id) => sketches[id] || null };

  it('replays a sweep from a profile sketch and a path sketch', () => {
    const f = createFeature('sweep', { sketchId: 1, pathSketchId: 2 });
    const out = rebuildFeatures([f], ctx);
    expect(out.errors).toEqual([]);
    expect(volume(out.soup)).toBeCloseTo(100 * 90, 1);
    expect(featureSketchIds(f)).toEqual([1, 2]);
  });

  it('replays a loft through its sketches in order, and says what is missing', () => {
    const f = createFeature('loft', { sketchIds: [3, 4] });
    const out = rebuildFeatures([f], ctx);
    expect(out.errors).toEqual([]);
    expect(volume(out.soup)).toBeCloseTo((20 / 3) * 700, 1);
    const bad = rebuildFeatures([createFeature('sweep', { sketchId: 1, pathSketchId: 3 })], ctx);
    expect(bad.errors[0].message).toMatch(/no open line/);
  });
});
