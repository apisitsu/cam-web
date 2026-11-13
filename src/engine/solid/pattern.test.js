import {
  describe, it, expect, beforeAll,
} from 'vitest';
import { createFeature, rebuildFeatures, describeFeature } from './featureTree.js';
import { patternTransforms, transformSoup, transformHole } from './pattern.js';
import { meshBoolean, loadMeshBoolean } from '../../lib/csg.js';
import { createSketch, addPoint, addLine } from '../sketch/model.js';
import { volume } from './solidAssert.js';
import { boundsOf } from '../mesh/analyze.js';

beforeAll(async () => { await loadMeshBoolean(); });

const near = (v, want, tol = 1) => expect(Math.abs(v - want)).toBeLessThan(tol);

function rect(x0, y0, x1, y1) {
  const sk = createSketch();
  const p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => addPoint(sk, x, y));
  p.forEach((a, i) => addLine(sk, a, p[(i + 1) % 4]));
  return sk;
}
const XY = { preset: 'XY', offset: 0 };
const ctx = (sketches) => ({ sketchOf: (id) => sketches[id] || null, meshBoolean });

describe('patternTransforms', () => {
  it('linear: count−1 copies, a grid with a second direction', () => {
    const f = createFeature('pattern', { pattern: 'linear', dir: 'x', count: 3, spacing: 10 });
    expect(patternTransforms(f).map((x) => x.t)).toEqual([[10, 0, 0], [20, 0, 0]]);
    const g = createFeature('pattern', {
      pattern: 'linear', dir: 'x', count: 2, spacing: 5, dir2: 'y', count2: 2, spacing2: 7,
    });
    expect(patternTransforms(g).map((x) => x.t)).toEqual([[0, 7, 0], [5, 0, 0], [5, 7, 0]]);
  });

  it('circular: 360° spaces copies equally; less puts the last on the end', () => {
    const f = createFeature('pattern', { pattern: 'circular', axis: 'z', count: 4, angle: 360 });
    const p = [10, 0, 0];
    const at = patternTransforms(f).map(({ m, t }) => [0, 1, 2].map((r) => m[r * 3] * p[0] + m[r * 3 + 1] * p[1] + m[r * 3 + 2] * p[2] + t[r]));
    expect(at.map((q) => q.map((v) => Math.round(v * 1e6) / 1e6 + 0))).toEqual([[0, 10, 0], [-10, 0, 0], [0, -10, 0]]);
    const g = createFeature('pattern', { pattern: 'circular', axis: 'z', count: 3, angle: 90 });
    expect(patternTransforms(g)).toHaveLength(2);
  });

  it('mirror reflects and flips the winding so the copy stays outward', () => {
    const f = createFeature('pattern', { pattern: 'mirror', mirrorPlane: 'YZ', mirrorOffset: 5 });
    const [x] = patternTransforms(f);
    expect(x.flip).toBe(true);
    const tri = { positions: new Float32Array([1, 0, 0, 2, 0, 0, 1, 1, 0]), triangleCount: 1 };
    expect([...transformSoup(tri, x).positions]).toEqual([9, 0, 0, 9, 1, 0, 8, 0, 0]);
    const h = transformHole({ at: [1, 2, 3], axis: [0, 0, -1] }, x);
    expect(h.at).toEqual([9, 2, 3]);
    expect(h.axis.map((v) => v + 0)).toEqual([0, 0, -1]);
  });
});

describe('rebuild with a pattern', () => {
  it('copies a boss along X: volume grows by each copy', () => {
    const base = createFeature('extrude', { sketchId: 1, depth: 10 });
    const boss = createFeature('extrude', { sketchId: 2, depth: 5, base: 10, merge: 'add' });
    const pat = createFeature('pattern', { pattern: 'linear', seeds: [boss.id], dir: 'x', count: 3, spacing: 20 });
    const out = rebuildFeatures([base, boss, pat], ctx({ 1: { doc: rect(0, 0, 60, 20), plane: XY }, 2: { doc: rect(2, 2, 8, 8), plane: XY } }));
    expect(out.errors).toEqual([]);
    near(volume(out.soup), 60 * 20 * 10 + 3 * 6 * 6 * 5);
  });

  it('copies a cut circularly and mirrors the whole body', () => {
    const base = createFeature('extrude', { sketchId: 1, depth: 10 });
    const cut = createFeature('extrude', { sketchId: 2, depth: 10, merge: 'cut' });
    const pat = createFeature('pattern', { pattern: 'circular', seeds: [cut.id], axis: 'z', count: 4, angle: 360 });
    const sk = { 1: { doc: rect(-30, -30, 30, 30), plane: XY }, 2: { doc: rect(15, -2, 25, 2), plane: XY } };
    const out = rebuildFeatures([base, cut, pat], ctx(sk));
    expect(out.errors).toEqual([]);
    near(volume(out.soup), 60 * 60 * 10 - 4 * 10 * 4 * 10);

    const body = createFeature('extrude', { sketchId: 3, depth: 5 });
    const mir = createFeature('pattern', { pattern: 'mirror', mirrorPlane: 'YZ', mirrorOffset: 0 });
    const m = rebuildFeatures([body, mir], ctx({ 3: { doc: rect(0, 0, 10, 10), plane: XY } }));
    expect(m.errors).toEqual([]);
    near(volume(m.soup), 2 * 10 * 10 * 5);
    expect(boundsOf(m.soup).min[0]).toBeCloseTo(-10, 2);
    expect(describeFeature(mir)).toBe('Mirror the body in YZ');
  });

  it('fails only itself when a seed is missing or comes later', () => {
    const base = createFeature('extrude', { sketchId: 1, depth: 10 });
    const pat = createFeature('pattern', { pattern: 'linear', seeds: [9999], count: 2 });
    const out = rebuildFeatures([base, pat], ctx({ 1: { doc: rect(0, 0, 10, 10), plane: XY } }));
    expect(out.errors.map((e) => e.id)).toEqual([pat.id]);
    near(volume(out.soup), 1000);
  });
});
