import { describe, it, expect } from 'vitest';
import { faceToRawFrame } from './datum.js';
import { linkFaceToSolids } from '../sketch/plane.js';

const close = (a, b) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

// Measured in the live app: a 20.3 × 55.8 × 10 extrude comes back laid down
// quarter-turned about Z — displayed (x', y') = (y, −x) of the raw solid.
const LAID = { order: [1, 0, 2], signs: [1, -1, 1] };
const SOLID = { id: 1, bounds: { min: [-30.705, -7.37, 0], max: [-10.385, 48.46, 10] } };
const PICKED_TOP = {
  normal: [0, 0, 1],
  centroid: [20.545, 20.545, 10],
  bounds: { min: [-7.37, 10.385, 10], max: [48.46, 30.705, 10] },
};

describe('faceToRawFrame — a picked face, back in the frame the solids are built in', () => {
  it('puts the top face of a laid-down extrude back on the feature’s own bounds', () => {
    const raw = faceToRawFrame(PICKED_TOP, LAID, null);
    close(raw.normal, [0, 0, 1]);
    close(raw.centroid, [-20.545, 20.545, 10]);
    // Corners swap min/max under the sign flip; the result must be re-sorted.
    close(raw.bounds.min, [-30.705, -7.37, 10]);
    close(raw.bounds.max, [-10.385, 48.46, 10]);
  });

  it('is what makes the link possible: compared as picked it misses, in raw it matches', () => {
    expect(linkFaceToSolids(PICKED_TOP, [SOLID])).toBeNull(); // the bug seen in the live app
    expect(linkFaceToSolids(faceToRawFrame(PICKED_TOP, LAID, null), [SOLID]))
      .toEqual({ featureId: 1, axis: 'z', side: 'max' });
  });

  it('undoes the datum shift too, which moves the displayed frame', () => {
    // Origin touched off 5 mm up: a face at displayed z=5 is at raw z=10.
    const face = { normal: [0, 0, 1], centroid: [0, 0, 5], bounds: { min: [0, 0, 5], max: [4, 4, 5] } };
    const raw = faceToRawFrame(face, null, [0, 0, 5]);
    expect(raw.centroid[2]).toBe(10);
    expect(raw.bounds.min[2]).toBe(10);
  });

  it('leaves a face alone when nothing is laid down or shifted, and tolerates junk', () => {
    expect(faceToRawFrame(PICKED_TOP, null, null)).toEqual(PICKED_TOP);
    expect(faceToRawFrame(null, LAID, null)).toBeNull();
    const noBounds = faceToRawFrame({ normal: [0, 0, 1], centroid: [1, 2, 3] }, null, null);
    expect(noBounds.bounds).toBeUndefined();
  });

  it('rotates a normal as a direction — no shift applied to it', () => {
    const side = { normal: [1, 0, 0], centroid: [0, 0, 0] };
    close(faceToRawFrame(side, LAID, [9, 9, 9]).normal, [0, 1, 0]);
  });
});
