import { describe, it, expect } from 'vitest';
import {
  measurePick, measureResult, planePick, planeClickPick,
} from './measure.js';
import { weld } from './stl.js';
import { tube, box } from './fixtures.js';

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

describe('reading an edge', () => {
  const block = weld(box(40, 20, 10));
  const onTop = (point) => measurePick(block, topTriangle(block), point, [0, 0, 1], 1);
  function topTriangle(mesh) {
    const { positions, indices } = mesh;
    for (let t = 0; t < indices.length / 3; t++) {
      if ([0, 1, 2].every((k) => Math.abs(positions[indices[t * 3 + k] * 3 + 2] - 5) < 1e-6)) return t;
    }
    throw new Error('no top');
  }

  it('takes a click near a straight edge as the whole edge', () => {
    const p = onTop([0, 9.5, 5]);
    expect(p.kind).toBe('edge');
    expect(p.edge.length).toBeCloseTo(40, 6);
  });

  it('takes a click well inside as the face', () => {
    expect(onTop([0, 0, 5]).kind).toBe('face');
  });

  it('reports an edge by its length', () => {
    expect(value(measureResult([onTop([0, 9.5, 5])]), 'Edge length')).toBe('40.000 mm');
  });
});

describe('what a pair of picks measures', () => {
  const edge = (a, b) => ({
    kind: 'edge', point: a, edge: { a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) },
  });
  const hole = (x, y, z = 5, r = 3) => ({ kind: 'circle', point: [x, y, z], circle: { axis: 2, center: [x, y, z], radius: r } });
  const face = (normal, centroid, point = centroid) => ({
    kind: 'face', point, face: { normal, centroid, area: 1 },
  });

  it('edge to hole: square to the edge, and to the wall', () => {
    const lines = measureResult([edge([0, 20, 10], [40, 20, 10]), hole(15, 5)]);
    expect(value(lines, 'Edge to centre')).toBe('15.000 mm');
    expect(value(lines, 'Edge to wall')).toBe('12.000 mm');
  });

  it('edge to hole does not count how far down the bore was clicked', () => {
    const lines = measureResult([hole(15, 5, 0.5), edge([0, 20, 10], [40, 20, 10])]);
    expect(value(lines, 'Edge to centre')).toBe('15.000 mm');
  });

  it('plane to plane: parallel is the distance, from any two picks', () => {
    const lines = measureResult([planePick('XY'), face([0, 0, 1], [20, 10, 10], [3, 4, 10])]);
    expect(value(lines, 'Distance (normal)')).toBe('10.000 mm');
    expect(value(lines, 'Distance')).toBeUndefined();
  });

  it('plane to plane: at an angle, the angle', () => {
    expect(value(measureResult([planePick('XY'), planePick('XZ')]), 'Angle')).toBe('90.000°');
  });

  it('wall face to hole: the distance to the centre, not to where the face was clicked', () => {
    const lines = measureResult([face([0, -1, 0], [20, 0, 5], [39, 0, 9]), hole(15, 12)]);
    expect(value(lines, 'Distance to centre')).toBe('12.000 mm');
    expect(value(lines, 'Distance to wall')).toBe('9.000 mm');
  });

  it('says so when a bore runs square through the plane picked', () => {
    expect(value(measureResult([planePick('XY'), hole(5, 5)]), 'Note')).toMatch(/square/);
  });

  it('plane to edge lying along it: the distance', () => {
    expect(value(measureResult([planePick('XZ'), edge([0, 20, 10], [40, 20, 10])]), 'Distance (normal)')).toBe('20.000 mm');
  });

  it('edge to edge: parallel distance, or the angle', () => {
    const a = edge([0, 0, 0], [40, 0, 0]);
    expect(value(measureResult([a, edge([0, 20, 0], [40, 20, 0])]), 'Distance (normal)')).toBe('20.000 mm');
    expect(value(measureResult([a, edge([0, 0, 0], [0, 20, 0])]), 'Angle')).toBe('90.000°');
  });

  it('hole to hole: centres across the axis, and the wall between', () => {
    const lines = measureResult([hole(0, 0, 1), hole(30, 40, 9)]);
    expect(value(lines, 'Centre distance')).toBe('50.000 mm');
    expect(value(lines, 'Between walls')).toBe('44.000 mm');
    expect(value(lines, 'dX dY dZ')).toBe('30.000  40.000  0.000');
  });
});

describe('a click that reaches a reference plane', () => {
  const pipe = weld(tube(20, 10, 30, 64));

  it('down a through bore means the bore', () => {
    const p = planeClickPick(pipe, 'XY', [2, 3, 0]);
    expect(p.kind).toBe('circle');
    expect(p.circle.axis).toBe(2);
    expect(p.circle.radius).toBeCloseTo(10, 1);
    expect(p.circle.center[0]).toBeCloseTo(0, 3);
  });

  it('anywhere else means the plane', () => {
    expect(planeClickPick(pipe, 'XY', [50, 0, 0]).kind).toBe('plane');
    expect(planeClickPick(null, 'XY', [0, 0, 0]).kind).toBe('plane');
  });
});
