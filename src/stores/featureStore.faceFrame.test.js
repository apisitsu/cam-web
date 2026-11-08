import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import { useSketchStore } from './sketchStore.js';
import { useCamPlanStore } from './camPlanStore.js';
import { useFeatureStore } from './featureStore.js';
import { addPoint, addLine } from '../engine/sketch/model.js';
import { faceToRawFrame } from '../engine/mesh/datum.js';

const sketch = () => useSketchStore.getState();
const features = () => useFeatureStore.getState();

// The part on screen is laid down; the sketch and the solids are in the raw
// frame. These two orientations are the cases where the two frames disagree.
const QUARTER_TURN = { order: [1, 0, 2], signs: [1, -1, 1] };   // x'=y, y'=−x  (seen in the live app)
const ON_ITS_SIDE = { order: [1, 2, 0], signs: [1, 1, 1] };     // displayed Z is raw X

let realFaceInRawFrame;
beforeEach(async () => {
  features().clear();
  sketch().clear();
  useSketchStore.setState({
    sketches: [{ id: 1, name: 'Sketch1', plane: { preset: 'XY', offset: 0 }, doc: sketch().sk }],
    activeId: 1, nextSketchId: 2, past: [], future: [], error: null,
  });
  realFaceInRawFrame = useCamPlanStore.getState().faceInRawFrame;
  // Raw solid: 40 × 20 × 10 slab, X 0..40, Y 0..20, Z 0..10.
  const sk = sketch().sk;
  const p = [addPoint(sk, 0, 0), addPoint(sk, 40, 0), addPoint(sk, 40, 20), addPoint(sk, 0, 20)];
  for (let i = 0; i < 4; i++) addLine(sk, p[i], p[(i + 1) % 4]);
  sketch()._bump();
  await features().buildFromSketch({ op: 'extrude', depth: 10 });
});
afterEach(() => {
  useCamPlanStore.setState({ faceInRawFrame: realFaceInRawFrame, selectedFeature: null });
});

/** Pretend the part is displayed under `orientation`, and the operator picked `displayed`. */
function pick(displayed, orientation) {
  useCamPlanStore.setState({
    selectedFeature: displayed,
    faceInRawFrame: (f) => faceToRawFrame(f, orientation, null),
  });
}

const planeOf = (id) => sketch().sketches.find((s) => s.id === id).plane;

describe('sketch on a face — the plane is made in the frame the solids live in', () => {
  it('quarter-turned part: the top face is still the plane z = 10, linked to z max', () => {
    // Raw top (z=10) as it appears displayed under the quarter turn.
    pick({
      normal: [0, 0, 1], centroid: [10, -20, 10], facing: 'up',
      bounds: { min: [0, -40, 10], max: [20, 0, 10] },
    }, QUARTER_TURN);
    const id = features().sketchOnFace();
    expect(planeOf(id)).toMatchObject({ preset: 'XY', offset: 10, ref: { axis: 'z', side: 'max' } });
  });

  it('part laid on its side: the raw top is STILL z = 10 — not whatever the screen calls up', () => {
    // Raw top face (normal +Z, z=10) as displayed when raw X is shown as Z:
    // x'=rawY, y'=rawZ, z'=rawX.
    pick({
      normal: [0, 1, 0], centroid: [10, 10, 20], facing: 'back',
      bounds: { min: [0, 10, 0], max: [20, 10, 40] },
    }, ON_ITS_SIDE);
    const id = features().sketchOnFace();
    const plane = planeOf(id);
    // The old behaviour took the plane from the displayed face: an angled-looking
    // custom frame (displayed +Y has no preset), disagreeing with the solids.
    expect(plane).toMatchObject({ preset: 'XY', offset: 10, ref: { axis: 'z', side: 'max' } });
  });

  it('follows the feature when the part is on its side, which a displayed-frame plane could not', async () => {
    pick({
      normal: [0, 1, 0], centroid: [10, 10, 20], facing: 'back',
      bounds: { min: [0, 10, 0], max: [20, 10, 40] },
    }, ON_ITS_SIDE);
    const id = features().sketchOnFace();
    features().updateFeature(features().features[0].id, { depth: 25 });
    await features().rebuild();
    expect(planeOf(id).offset).toBe(25);
  });

  it('does not carry the displayed frame’s word for the face onto a raw-frame plane', () => {
    pick({
      normal: [0, Math.SQRT1_2, Math.SQRT1_2], centroid: [1, 2, 3], facing: 'up',
    }, QUARTER_TURN);
    const id = features().sketchOnFace();
    expect(planeOf(id).name).toBe('On face'); // not "On face · up"
  });
});
