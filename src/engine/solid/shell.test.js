import {
  describe, it, expect, beforeAll,
} from 'vitest';
import { extrudeRegion } from './extrude.js';
import { innerBody, shellSolid, openFaceRef } from './shell.js';
import { createFeature, rebuildFeatures } from './featureTree.js';
import { meshBoolean, loadMeshBoolean } from '../../lib/csg.js';
import { createSketch, addPoint, addLine } from '../sketch/model.js';
import { volume, bounds } from './solidAssert.js';

beforeAll(async () => { await loadMeshBoolean(); });

const box = (x, y, z) => extrudeRegion({ outer: [0, 0, x, 0, x, y, 0, y] }, { depth: z });
const near = (v, want, tol = 1) => expect(Math.abs(v - want)).toBeLessThan(tol);
const TOP = { normal: [0, 0, 1], plane: 20, min: [0, 0, 20], max: [40, 30, 20] };

describe('innerBody', () => {
  it('moves every plane of a box in by the thickness', () => {
    const inner = innerBody(box(40, 30, 20), 2);
    const b = bounds(inner);
    expect(b.min.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([2, 2, 2]);
    expect(b.max.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([38, 28, 18]);
    near(volume(inner), 36 * 26 * 16, 1e-2);
  });

  it('pushes an open face out instead', () => {
    const inner = innerBody(box(40, 30, 20), 2, [TOP]);
    expect(inner.opened).toBeGreaterThan(0);
    expect(bounds(inner).max[2]).toBeCloseTo(23, 4);
  });
});

describe('shellSolid', () => {
  it('a closed box keeps its outside and loses its middle', () => {
    const out = shellSolid(box(40, 30, 20), { thickness: 2 }, meshBoolean);
    near(volume(out), 40 * 30 * 20 - 36 * 26 * 16);
  });

  it('an open top leaves a tray: walls and floor only', () => {
    const out = shellSolid(box(40, 30, 20), { thickness: 2, openFaces: [TOP] }, meshBoolean);
    near(volume(out), 40 * 30 * 20 - 36 * 26 * 18);
    expect(openFaceRef({ normal: [0, 0, 1], plane: 20, bounds: { min: [0, 0, 20], max: [1, 1, 20] } }))
      .toEqual({ normal: [0, 0, 1], plane: 20, min: [0, 0, 20], max: [1, 1, 20] });
  });

  it('hollows a faceted cylinder close to the true wall', () => {
    const n = 96;
    const ring = [];
    for (let i = 0; i < n; i++) ring.push(20 * Math.cos((2 * Math.PI * i) / n), 20 * Math.sin((2 * Math.PI * i) / n));
    const cyl = extrudeRegion({ outer: ring }, { depth: 20 });
    const out = shellSolid(cyl, { thickness: 2, openFaces: [{ normal: [0, 0, 1], plane: 20, min: null, max: null }] }, meshBoolean);
    const want = volume(cyl) * (1 - (18 * 18 * 18) / (20 * 20 * 20));
    expect(Math.abs(volume(out) - want) / want).toBeLessThan(0.01);
  });

  it('replays as a feature after the part it hollows', () => {
    const sk = createSketch();
    const p = [[0, 0], [40, 0], [40, 30], [0, 30]].map(([x, y]) => addPoint(sk, x, y));
    p.forEach((a, i) => addLine(sk, a, p[(i + 1) % 4]));
    const base = createFeature('extrude', { sketchId: 1, depth: 20 });
    const sh = createFeature('shell', { thickness: 2, openFaces: [TOP] });
    const out = rebuildFeatures([base, sh], {
      sketchOf: () => ({ doc: sk, plane: { preset: 'XY', offset: 0 } }), meshBoolean,
    });
    expect(out.errors).toEqual([]);
    near(volume(out.soup), 40 * 30 * 20 - 36 * 26 * 18);
  });
});

describe('shell on a part too thin for the wall', () => {
  it('stops with where, rather than breaking through', () => {
    expect(() => shellSolid(box(40, 30, 3), { thickness: 2 }, meshBoolean)).toThrow(/thinner than twice the wall/);
    // Open on top, the same plate has only its floor to make: that is fine.
    const TOP3 = { normal: [0, 0, 1], plane: 3, min: [0, 0, 3], max: [40, 30, 3] };
    const out = shellSolid(box(40, 30, 3), { thickness: 2, openFaces: [TOP3] }, meshBoolean);
    near(volume(out), 40 * 30 * 3 - 36 * 26 * 1);
  });
});
