/**
 * Does the stated billet reach the block that actually gets carved — by every
 * route the UI can take?
 *
 * `billet.test.js` proves the box arithmetic. That is not the same thing, and
 * the gap between them is exactly where this went wrong the first time: the
 * billet was threaded into `runSimulation`, which was tested and passed, while
 * the Simulate button calls `createSession` through the worker's `init` — a
 * different function, building its own stock, silently ignoring the size and
 * origin the operator had typed. The engine was right and the app did not move.
 *
 * So the unit under test here is not a function, it is the *set* of entry
 * points. A new one that forgets to pass the billet through fails here rather
 * than on screen.
 */
import { describe, it, expect } from 'vitest';
import { runSimulation, runVoxelSimulation } from './index.js';
import { createSession } from './session.js';

const PROGRAM = [
  'G21 G90',
  'G0 X0 Y0 Z5',
  'G1 Z-8 F200',
  'G1 X20 F400',
  'G0 Z5',
].join('\n');

const SIZE = { x: 50, y: 50, z: 28 };
const ORIGIN = { x: -25, y: -25, z: 0 };

/** The XYZ extent of a returned mesh's vertices. */
function meshExtent(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < min[k]) min[k] = positions[i + k];
      if (positions[i + k] > max[k]) max[k] = positions[i + k];
    }
  }
  return { min, max };
}

/**
 * Every way the app asks for a carved block, as `(name, run) => extent`.
 * `run` takes the billet options and returns the block's world extent.
 */
const ENTRIES = [
  ['runSimulation (one-shot height field)', (opts) => {
    const r = runSimulation(PROGRAM, { radius: 3, cellSize: 0.5, ...opts });
    return meshExtent(r.positions);
  }],
  ['createSession (the Simulate button)', (opts) => {
    // The route that was broken: the store's `simulate()` calls the worker's
    // `init`, which is this.
    const s = createSession(PROGRAM, { radius: 3, cellSize: 0.5, ...opts });
    return {
      min: [s.stock.xMin, s.stock.yMin, s.stock.base],
      max: [s.stock.xMax, s.stock.yMax, s.stock.top],
    };
  }],
  ['runVoxelSimulation (the Voxel button)', (opts) => {
    const r = runVoxelSimulation(PROGRAM, { radius: 3, voxelSize: 1, ...opts });
    return meshExtent(r.positions);
  }],
];

describe.each(ENTRIES)('%s honours the stated billet', (_name, run) => {
  it('sizes the block to the stated dimensions', () => {
    const { min, max } = run({ stockSize: SIZE, stockOrigin: ORIGIN });
    expect(max[0] - min[0]).toBeGreaterThan(SIZE.x - 2);
    expect(max[0] - min[0]).toBeLessThan(SIZE.x + 2);
    expect(max[1] - min[1]).toBeGreaterThan(SIZE.y - 2);
    expect(max[1] - min[1]).toBeLessThan(SIZE.y + 2);
  });

  it('places the block on the stated origin corner', () => {
    const { min, max } = run({ stockSize: SIZE, stockOrigin: ORIGIN });
    expect(min[0]).toBeCloseTo(ORIGIN.x, 0);
    expect(min[1]).toBeCloseTo(ORIGIN.y, 0);
    expect(max[2]).toBeCloseTo(ORIGIN.z + SIZE.z, 0);
  });

  it('MOVES the block when the origin moves — the reported bug', () => {
    // The failure was not a wrong number, it was a number that did nothing.
    const here = run({ stockSize: SIZE, stockOrigin: ORIGIN });
    const there = run({ stockSize: SIZE, stockOrigin: { ...ORIGIN, x: ORIGIN.x + 40 } });
    expect(there.min[0] - here.min[0]).toBeCloseTo(40, 0);
  });

  it('resizes the block when the size changes', () => {
    const small = run({ stockSize: SIZE, stockOrigin: ORIGIN });
    const big = run({ stockSize: { ...SIZE, x: 90 }, stockOrigin: ORIGIN });
    expect((big.max[0] - big.min[0]) - (small.max[0] - small.min[0])).toBeCloseTo(40, 0);
  });

  it('lifts the block off Z0 when told to — the forcing is gone', () => {
    const { min, max } = run({ stockSize: SIZE, stockOrigin: { ...ORIGIN, z: -12 } });
    expect(min[2]).toBeCloseTo(-12, 0);
    expect(max[2]).toBeCloseTo(16, 0);
  });

  it('still works with no billet stated at all', () => {
    const { min, max } = run({});
    expect(max[0]).toBeGreaterThan(min[0]);
    expect(max[2]).toBeGreaterThan(min[2]);
  });
});
