import { describe, it, expect } from 'vitest';
import { isSketchableFace } from './sketchFace.js';
import { detectPlanarFaces } from './features.js';
import { weld } from './stl.js';
import { extrudeRegion } from '../solid/extrude.js';

const ring = (cx, cy, r, n) => Array.from({ length: n }, (_, i) => [
  cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n),
]).flat();

describe('isSketchableFace', () => {
  it('takes every face of a block', () => {
    const mesh = weld(extrudeRegion({ outer: [0, 0, 40, 0, 40, 20, 0, 20] }, { depth: 10 }));
    const { faces } = detectPlanarFaces(mesh);
    expect(faces).toHaveLength(6);
    faces.forEach((f) => expect(isSketchableFace(mesh, f)).toBe(true));
  });

  it('refuses a strip of a round wall, but takes the ends of the rod', () => {
    const mesh = weld(extrudeRegion({ outer: ring(0, 0, 25, 96) }, { depth: 10 }));
    const { faces } = detectPlanarFaces(mesh);
    const ends = faces.filter((f) => Math.abs(f.normal[2]) > 0.99);
    const strips = faces.filter((f) => Math.abs(f.normal[2]) < 0.01);
    expect(ends).toHaveLength(2);
    expect(strips.length).toBeGreaterThan(90);
    ends.forEach((f) => expect(isSketchableFace(mesh, f)).toBe(true));
    strips.forEach((f) => expect(isSketchableFace(mesh, f)).toBe(false));
  });

  it('still takes a flat side that runs into a rounded corner', () => {
    // A 60 × 20 slab with one end rounded: the long flat sides meet the round end
    // tangentially on one short side only.
    // The round end: the half circle on the +X side, from -90° to +90°.
    const half = [];
    for (let k = 0; k <= 32; k++) {
      const a = -Math.PI / 2 + (Math.PI * k) / 32;
      half.push(50 + 10 * Math.cos(a), 10 + 10 * Math.sin(a));
    }
    const mesh = weld(extrudeRegion({ outer: [0, 0, ...half, 0, 20] }, { depth: 10 }));
    const { faces } = detectPlanarFaces(mesh);
    const front = faces.find((f) => f.normal[1] < -0.99);
    expect(isSketchableFace(mesh, front)).toBe(true);
  });
});
