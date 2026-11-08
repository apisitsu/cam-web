import { describe, it, expect } from 'vitest';
import { measurePick, measureResult } from './measure.js';
import { weld } from './stl.js';
import { tube } from './fixtures.js';

/** A tube Ø40/Ø20 × 30 along Z, and a way to click the middle of a triangle of it. */
const soup = tube(20, 10, 30, 64);
const welded = weld(soup);
const tri = (t) => [0, 1, 2].map((k) => Array.from(soup.positions.subarray(t * 9 + k * 3, t * 9 + k * 3 + 3)));
function clickWhere(test) {
  for (let t = 0; t < soup.triangleCount; t++) {
    const v = tri(t);
    if (!test(v)) continue;
    const point = [0, 1, 2].map((k) => (v[0][k] + v[1][k] + v[2][k]) / 3);
    const ab = [0, 1, 2].map((k) => v[1][k] - v[0][k]);
    const ac = [0, 1, 2].map((k) => v[2][k] - v[0][k]);
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const l = Math.hypot(...n);
    return measurePick(welded, t, point, n.map((x) => x / l));
  }
  throw new Error('no such triangle');
}
const r = (p) => Math.hypot(p[0], p[1]);
const outerWall = () => clickWhere((v) => v.every((p) => Math.abs(r(p) - 20) < 1e-3) && v.some((p) => p[2] > 1) && v.some((p) => p[2] < 29));
const bore = () => clickWhere((v) => v.every((p) => Math.abs(r(p) - 10) < 1e-3) && v.some((p) => p[2] > 1) && v.some((p) => p[2] < 29));
const endFace = (z) => clickWhere((v) => v.every((p) => Math.abs(p[2] - z) < 1e-6));
const value = (lines, label) => lines.find((l) => l.label === label)?.value;

describe('measurePick — what a click is', () => {
  it('reads a click on the outside wall as the Ø40 it is part of', () => {
    const p = outerWall();
    expect(p.kind).toBe('circle');
    expect(p.circle.radius * 2).toBeCloseTo(40, 1);
    expect(p.circle.axis).toBe(2);
  });

  it('reads a click in the bore as the Ø20 bore', () => {
    const p = bore();
    expect(p.kind).toBe('circle');
    expect(p.circle.radius * 2).toBeCloseTo(20, 1);
  });

  it('reads a click on the end face as the face, not the bore beside it', () => {
    const p = endFace(30);
    expect(p.kind).toBe('face');
    expect(p.face.normal[2]).toBeCloseTo(1, 6);
  });
});

describe('measureResult — what one or two clicks measure', () => {
  it('gives a bore its diameter and centre', () => {
    const lines = measureResult([bore()]);
    expect(value(lines, 'Diameter')).toMatch(/^Ø20\.0\d\d mm$|^Ø19\.9\d\d mm$/);
    expect(value(lines, 'Axis')).toBe('Z');
  });

  it('measures two parallel faces straight across, wherever they were clicked', () => {
    const lines = measureResult([endFace(0), endFace(30)]);
    expect(value(lines, 'Distance (normal)')).toBe('30.000 mm');
  });

  it('measures between the centres of two circles', () => {
    const a = { kind: 'circle', point: [0, 0, 0], circle: { axis: 2, center: [0, 0, 5], radius: 3 } };
    const b = { kind: 'circle', point: [0, 0, 0], circle: { axis: 2, center: [30, 40, 5], radius: 3 } };
    const lines = measureResult([a, b]);
    expect(value(lines, 'Centre distance')).toBe('50.000 mm');
    expect(value(lines, 'dX dY dZ')).toBe('30.000  40.000  0.000');
  });

  it('gives the angle between two faces that are not parallel', () => {
    const f = (normal) => ({ kind: 'face', point: [0, 0, 0], face: { normal, centroid: [0, 0, 0], area: 1 } });
    const lines = measureResult([f([0, 0, 1]), f([1, 0, 0])]);
    expect(value(lines, 'Angle')).toBe('90.000°');
  });

  it('is nothing before a click', () => {
    expect(measureResult([])).toEqual([]);
  });
});
