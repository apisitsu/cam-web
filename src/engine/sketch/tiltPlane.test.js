import { describe, it, expect } from 'vitest';
import { tiltPlane, planeBasis, planeToWorld, parsePlane } from './plane.js';

const close = (a, b) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 7));

describe('tiltPlane', () => {
  it('turns Top 90° about X into a plane facing −Y, like Front', () => {
    const { u, v, n } = planeBasis(tiltPlane({ preset: 'XY', offset: 0 }, { axis: 'x', angle: 90 }));
    close(u, [1, 0, 0]);
    close(v, [0, 0, 1]);
    close(n, [0, -1, 0]);
  });

  it('hinges at the pivot and climbs the slope from there', () => {
    // Top at Z 10, turned 30° about a line along X at Y = 40.
    const plane = tiltPlane({ preset: 'XY', offset: 10 }, { axis: 'x', angle: 30, pivot: 40 });
    close(planeToWorld(plane, 5, 0), [5, 40, 10]);
    close(planeToWorld(plane, 0, 10), [0, 40 + 10 * Math.cos(Math.PI / 6), 10 + 10 * Math.sin(Math.PI / 6)]);
  });

  it('turns about Y the same way, and stands off along the new normal', () => {
    const plane = tiltPlane({ preset: 'XY', offset: 0 }, { axis: 'y', angle: 45, offset: 2 });
    const { n } = planeBasis(plane);
    close(n, [-Math.SQRT1_2, 0, Math.SQRT1_2]);
    close(planeToWorld(plane, 0, 0), [-Math.SQRT2, 0, Math.SQRT2]);
  });

  it('says what it is, and survives a save and reopen', () => {
    const plane = tiltPlane({ preset: 'XY', offset: 10 }, { axis: 'x', angle: 30, pivot: 40 });
    expect(plane.name).toBe('Top (XY) +10 · 30° about X at 40');
    expect(parsePlane(JSON.parse(JSON.stringify(plane)))).toEqual(plane);
  });
});
