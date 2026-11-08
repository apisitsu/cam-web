import { describe, it, expect } from 'vitest';
import { linkFaceToSolids, resolvePlaneRef, parsePlane } from './plane.js';

const box = (id, min, max, cut = false) => ({ id, bounds: { min, max }, cut });
const faceAt = (normal, centroid, bounds) => ({ normal, centroid, bounds });

describe('face links — a sketch placed on a feature’s face follows that feature', () => {
  it('links the top of an extrude to its max end along Z', () => {
    const solids = [box(1, [0, 0, 0], [40, 20, 10])];
    const ref = linkFaceToSolids(
      faceAt([0, 0, 1], [20, 10, 10], { min: [0, 0, 10], max: [40, 20, 10] }), solids,
    );
    expect(ref).toEqual({ featureId: 1, axis: 'z', side: 'max' });
  });

  it('links a downward face to the min end', () => {
    const solids = [box(1, [0, 0, 0], [40, 20, 10])];
    expect(linkFaceToSolids(faceAt([0, 0, -1], [20, 10, 0]), solids))
      .toEqual({ featureId: 1, axis: 'z', side: 'min' });
  });

  it('reads a pocket floor as the BOTTOM of the cut that carved it', () => {
    // Part 0..10 tall; a cut tool spanning z 4..12 leaves a floor at z=4 that faces up.
    const solids = [box(1, [0, 0, 0], [40, 20, 10]), box(2, [5, 5, 4], [15, 15, 12], true)];
    const ref = linkFaceToSolids(
      faceAt([0, 0, 1], [10, 10, 4], { min: [5, 5, 4], max: [15, 15, 4] }), solids,
    );
    expect(ref).toEqual({ featureId: 2, axis: 'z', side: 'min' });
  });

  it('prefers the latest feature that fits', () => {
    const solids = [box(1, [0, 0, 0], [40, 20, 10]), box(2, [0, 0, 0], [40, 20, 10])];
    expect(linkFaceToSolids(faceAt([0, 0, 1], [20, 10, 10]), solids).featureId).toBe(2);
  });

  it('does not link an angled face, a miss, or a coplanar face outside the solid', () => {
    const solids = [box(1, [0, 0, 0], [40, 20, 10])];
    const s = Math.SQRT1_2;
    expect(linkFaceToSolids(faceAt([0, s, s], [20, 10, 10]), solids)).toBeNull();
    expect(linkFaceToSolids(faceAt([0, 0, 1], [20, 10, 6]), solids)).toBeNull();
    // Same height, but the face lies beyond the solid in X.
    expect(linkFaceToSolids(
      faceAt([0, 0, 1], [90, 10, 10], { min: [80, 0, 10], max: [100, 20, 10] }), solids,
    )).toBeNull();
    expect(linkFaceToSolids(null, solids)).toBeNull();
    expect(linkFaceToSolids(faceAt([0, 0, 1], [0, 0, 0]), [])).toBeNull();
  });

  it('moves a preset plane to the face’s new position, in the preset’s own sign', () => {
    const bounds = new Map([[1, { min: [0, 0, 0], max: [40, 25, 18] }]]);
    const top = { preset: 'XY', offset: 10, ref: { featureId: 1, axis: 'z', side: 'max' } };
    expect(resolvePlaneRef(top, bounds)).toEqual({ ...top, offset: 18 });
    // Front (XZ) has its normal along −Y, so the offset is −y.
    const front = { preset: 'XZ', offset: -20, ref: { featureId: 1, axis: 'y', side: 'max' } };
    expect(resolvePlaneRef(front, bounds).offset).toBe(-25);
  });

  it('slides a custom frame along the axis and keeps its u and v', () => {
    const bottom = {
      origin: [0, 0, 0], u: [1, 0, 0], v: [0, -1, 0], ref: { featureId: 1, axis: 'z', side: 'min' },
    };
    const moved = resolvePlaneRef(bottom, new Map([[1, { min: [0, 0, -7], max: [40, 25, 18] }]]));
    expect(moved.origin[2]).toBe(-7);
    expect(moved.u).toEqual([1, 0, 0]);
    // Unchanged → the same object, so a rebuild that moved nothing writes nothing.
    expect(resolvePlaneRef(bottom, new Map([[1, { min: [0, 0, 0], max: [1, 1, 1] }]]))).toBe(bottom);
  });

  it('falls back to the stored numbers when the link cannot be resolved', () => {
    const p = { preset: 'XY', offset: 10, ref: { featureId: 9, axis: 'z', side: 'max' } };
    expect(resolvePlaneRef(p, new Map())).toBe(p); // feature not built
    // A link that disagrees with its plane (Z link on a Right/YZ plane) is ignored.
    const odd = { preset: 'YZ', offset: 5, ref: { featureId: 1, axis: 'z', side: 'max' } };
    expect(resolvePlaneRef(odd, new Map([[1, { min: [0, 0, 0], max: [1, 1, 1] }]]))).toBe(odd);
    const plain = { preset: 'XY', offset: 3 };
    expect(resolvePlaneRef(plain, new Map([[1, { min: [0, 0, 0], max: [1, 1, 1] }]]))).toBe(plain);
  });

  it('keeps a valid link through a save, drops a malformed one, and opens an old file', () => {
    const ref = { featureId: 3, axis: 'z', side: 'max' };
    expect(parsePlane(JSON.parse(JSON.stringify({ preset: 'XY', offset: 4, ref }))))
      .toEqual({ preset: 'XY', offset: 4, ref });
    const custom = { origin: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0], ref };
    expect(parsePlane(JSON.parse(JSON.stringify(custom))).ref).toEqual(ref);
    expect(parsePlane({ preset: 'XY', offset: 4, ref: { featureId: 'x', axis: 'q', side: 'mid' } }))
      .toEqual({ preset: 'XY', offset: 4 });
    expect(parsePlane({ preset: 'XY', offset: 4 })).toEqual({ preset: 'XY', offset: 4 });
  });
});
