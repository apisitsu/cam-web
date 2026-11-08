import { describe, it, expect } from 'vitest';
import {
  fitCircle, circleAtPick, circlesAt, nearestCircle,
} from './circlePick.js';
import { translate } from './datum.js';
import { weld } from './stl.js';
import { box, cylinder, tube } from './fixtures.js';

const ring = (cx, cy, r, n = 32) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * 2 * Math.PI;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}).flat();

describe('fitCircle', () => {
  it('finds the centre and radius of a ring', () => {
    const c = fitCircle(ring(5, -3, 12));
    expect(c.center[0]).toBeCloseTo(5, 6);
    expect(c.center[1]).toBeCloseTo(-3, 6);
    expect(c.radius).toBeCloseTo(12, 6);
  });

  it('refuses a rectangle, even one with many points along its sides', () => {
    const pts = [];
    for (let i = 0; i < 10; i += 1) pts.push(i * 6, 0);
    for (let i = 0; i < 10; i += 1) pts.push(60, i * 3);
    for (let i = 0; i < 10; i += 1) pts.push(60 - i * 6, 30);
    for (let i = 0; i < 10; i += 1) pts.push(0, 30 - i * 3);
    expect(fitCircle(pts)).toBeNull();
  });

  it('refuses a square, whose corners alone would fit a circle', () => {
    expect(fitCircle([0, 0, 10, 0, 10, 10, 0, 10])).toBeNull();
  });

  it('is not fooled by a rectangle whose corners each appear twice', () => {
    expect(fitCircle([0, 0, 0, 0, 10, 0, 10, 0, 10, 30, 10, 30, 0, 30, 0, 30])).toBeNull();
  });

  it('is not fooled by points bunched near the four corners of a rectangle', () => {
    expect(fitCircle([
      0, 0.01, 0.01, 0, 60, 0.01, 59.99, 0, 60, 39.99, 59.99, 40, 0, 39.99, 0.01, 40,
    ])).toBeNull();
  });

  it('refuses an arc that does not go all the way round', () => {
    const half = ring(0, 0, 10, 32).slice(0, 34);
    expect(fitCircle(half)).toBeNull();
  });
});

describe('circleAtPick', () => {
  // Bore and boss on the Z axis through (5, 7), from z = 0 to z = 30.
  const part = () => weld(translate(tube(20, 10, 30), [-5, -7, 0]));

  it('finds the boss from a click on its outer wall', () => {
    const c = circleAtPick(part(), [25, 7, 15], [1, 0, 0]);
    expect(c.axis).toBe(2);
    expect(c.center[0]).toBeCloseTo(5, 2);
    expect(c.center[1]).toBeCloseTo(7, 2);
    expect(c.radius).toBeCloseTo(20, 0);
  });

  it('finds the bore from a click on its wall', () => {
    const c = circleAtPick(part(), [15, 7, 15], [-1, 0, 0]);
    expect(c.axis).toBe(2);
    expect(c.radius).toBeCloseTo(10, 0);
    expect(c.center[0]).toBeCloseTo(5, 2);
  });

  it('takes the nearer circle for a click on the end face between them', () => {
    const nearBore = circleAtPick(part(), [16, 7, 30], [0, 0, 1]);
    expect(nearBore.radius).toBeCloseTo(10, 0);
    const nearBoss = circleAtPick(part(), [24, 7, 30], [0, 0, 1]);
    expect(nearBoss.radius).toBeCloseTo(20, 0);
    expect(nearBoss.center[2]).toBe(30);
  });

  it('works for a cylinder lying along another axis', () => {
    const soup = cylinder(10, 40);
    const welded = weld(soup);
    const p = welded.positions;
    const turned = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      turned[i] = p[i + 2];
      turned[i + 1] = p[i];
      turned[i + 2] = p[i + 1];
    }
    const c = circleAtPick({ ...welded, positions: turned }, [20, 0, 10], [0, 0, 1]);
    expect(c.axis).toBe(0);
    expect(c.center[1]).toBeCloseTo(0, 2);
    expect(c.center[2]).toBeCloseTo(0, 2);
  });

  it('chooses again from one set of sections as the cursor moves across a facet', () => {
    const circles = circlesAt(part(), [20, 7, 30], [0, 0, 1]);
    expect(nearestCircle(circles, [16, 7, 30]).radius).toBeCloseTo(10, 0);
    expect(nearestCircle(circles, [24, 7, 30]).radius).toBeCloseTo(20, 0);
  });

  it('finds nothing on a plain block', () => {
    expect(circleAtPick(weld(box(60, 40, 20)), [0, 0, 10], [0, 0, 1])).toBeNull();
  });
});
