import { describe, it, expect } from 'vitest';
import { fitPolyline, convertChains } from './convert.js';
import { createSketch } from './model.js';
import { sketchLoops } from './loops.js';

const ring = (cx, cy, r, n, a0 = 0, a1 = 2 * Math.PI, inclusive = false) => {
  const out = [];
  const steps = inclusive ? n : n - 1;
  for (let k = 0; k <= steps; k++) {
    if (!inclusive && k === n) break;
    const a = a0 + ((a1 - a0) * k) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
};

describe('fitPolyline', () => {
  it('reads a faceted circle as a circle', () => {
    const [c] = fitPolyline(ring(5, 5, 10, 64), true);
    expect(c.type).toBe('circle');
    expect(c.r).toBeCloseTo(10, 6);
  });

  it('reads a square as four lines, with the extra corners on its sides merged', () => {
    const pts = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10], [0, 5]];
    const out = fitPolyline(pts, true);
    expect(out.map((p) => p.type)).toEqual(['line', 'line', 'line', 'line']);
  });

  it('reads a rounded rectangle as lines and arcs', () => {
    // 40 × 20 with R5 corners, each corner 9 facets.
    const pts = [];
    for (const [cx, cy, a0] of [[35, 5, -90], [35, 15, 0], [5, 15, 90], [5, 5, 180]]) {
      for (let k = 0; k <= 9; k++) {
        const a = ((a0 + (90 * k) / 9) * Math.PI) / 180;
        pts.push([cx + 5 * Math.cos(a), cy + 5 * Math.sin(a)]);
      }
    }
    const out = fitPolyline(pts, true);
    expect(out.filter((p) => p.type === 'arc')).toHaveLength(4);
    expect(out.filter((p) => p.type === 'line')).toHaveLength(4);
    out.filter((p) => p.type === 'arc').forEach((a) => expect(a.r).toBeCloseTo(5, 4));
  });

  it('reads an open run of an arc then a line', () => {
    const arc = ring(0, 0, 10, 12, 0, Math.PI / 2, true); // (10,0) … (0,10)
    const out = fitPolyline([...arc, [-20, 10]], false);
    expect(out.map((p) => p.type)).toEqual(['arc', 'line']);
    expect(out[0].ccw).toBe(true);
  });
});

describe('convertChains', () => {
  it('puts a face outline into the sketch as a closed profile', () => {
    const sk = createSketch();
    const plane = { preset: 'XY', offset: 10 };
    const square = [[0, 0, 10], [30, 0, 10], [30, 20, 10], [0, 20, 10]];
    const hole = ring(15, 10, 4, 48).map(([x, y]) => [x, y, 10]);
    convertChains(sk, plane, [{ points: square, closed: true }, { points: hole, closed: true }]);
    const types = [...sk.entities.values()].map((e) => e.type);
    expect(types.filter((t) => t === 'line')).toHaveLength(4);
    expect(types.filter((t) => t === 'circle')).toHaveLength(1);
    expect(sketchLoops(sk).loops.length).toBeGreaterThanOrEqual(2);
  });

  it('projects an edge that lies off the plane straight onto it', () => {
    const sk = createSketch();
    convertChains(sk, { preset: 'XY', offset: 0 }, [{ points: [[0, 0, 7], [12, 0, 7]], closed: false }]);
    const pts = [...sk.entities.values()].filter((e) => e.type === 'point');
    expect(pts.map((p) => [p.x, p.y])).toEqual([[0, 0], [12, 0]]);
  });
});
