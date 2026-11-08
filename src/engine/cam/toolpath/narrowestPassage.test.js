import { describe, it, expect } from 'vitest';
import { narrowestPassage } from './mill.js';

const ring = (cx, cy, r, n) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * 2 * Math.PI;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}).flat();

/** A closed polyline with every edge cut into pieces no longer than `step`. */
function dense(corners, step = 0.5) {
  const out = [];
  for (let i = 0; i < corners.length; i++) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[(i + 1) % corners.length];
    const k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let s = 0; s < k; s++) out.push(x0 + ((x1 - x0) * s) / k, y0 + ((y1 - y0) * s) / k);
  }
  return out;
}

describe('narrowestPassage', () => {
  it('reads a round hole as its diameter, not as a chord of its wall', () => {
    // It used to be ~3 mm for every hole — the chord across `minArc` of wall —
    // and how close under 3 depended on how many corners the wall had.
    expect(narrowestPassage([ring(0, 0, 10, 120)])).toBeGreaterThan(19.5);
    expect(narrowestPassage([ring(0, 0, 10, 800)])).toBeGreaterThan(19.5);
  });

  it('still finds the gap of a slot between two walls', () => {
    // A U: two 20 mm prongs, 3 mm apart.
    const u = dense([[0, 0], [11, 0], [11, 20], [7, 20], [7, 5], [4, 5], [4, 20], [0, 20]]);
    expect(narrowestPassage([u])).toBeCloseTo(3, 1);
  });

  it('is unconstrained by a plain rectangle beyond its own width', () => {
    expect(narrowestPassage([dense([[0, 0], [60, 0], [60, 40], [0, 40]])])).toBeCloseTo(40, 1);
  });
});
