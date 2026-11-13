import { describe, it, expect } from 'vitest';
import { strokesInFrame, engraveOp } from './sketchOps.js';
import { machineById, DEFAULT_MILL_ID } from '../machines.js';

const tool = { id: 'v', label: 'V90', type: 'spot', angle: 90, diameter: 6, flutes: 2, fluteLength: 10 };
const common = { material: 'S50C', tool, machine: machineById(DEFAULT_MILL_ID), safeZ: 10 };

describe('engraveOp', () => {
  it('runs the cutter along each stroke at depth, nearest stroke next', () => {
    const shape = strokesInFrame({
      plane: { preset: 'XY', offset: 5 },
      strokes: [
        { points: [[30, 0], [40, 0]], closed: false },
        { points: [[0, 0], [10, 0]], closed: false },
      ],
    }, (p) => p);
    expect(shape.z).toBe(5);
    const op = engraveOp(shape, { ...common, depth: 0.3 });
    const feeds = op.moves.filter((m) => m.t === 'feed');
    feeds.forEach((m) => expect(m.z).toBeCloseTo(4.7, 9));
    // From the origin the stroke at X0 comes first, then the one at X30.
    expect(feeds[0].x).toBe(0);
    expect(feeds[2].x).toBe(30);
    expect(op.cutLength).toBeGreaterThanOrEqual(20);
    expect(op.kind).toBe('engrave');
    // A 90° V at 0.3 mm deep cuts 0.6 mm wide.
    expect(op.notes[1]).toMatch(/0\.60 mm wide/);
  });

  it('enters an open stroke from whichever end is nearer', () => {
    const shape = strokesInFrame({
      plane: { preset: 'XY', offset: 0 },
      strokes: [{ points: [[10, 0], [0, 0]], closed: false }],
    }, (p) => p);
    const op = engraveOp(shape, { ...common, depth: 0.2 });
    expect(op.moves.find((m) => m.t === 'feed').x).toBe(0);
  });

  it('says so for a sketch with nothing on it, or one not facing the spindle', () => {
    expect(strokesInFrame({ plane: { preset: 'XY', offset: 0 }, strokes: [] }, (p) => p).error).toMatch(/nothing drawn/);
    expect(strokesInFrame({ plane: { preset: 'XZ', offset: 0 }, strokes: [{ points: [[0, 0], [1, 0]] }] }, (p) => p).error).toMatch(/not flat/);
  });
});
