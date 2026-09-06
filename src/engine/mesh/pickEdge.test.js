import { describe, it, expect } from 'vitest';
import {
  edgeAtPoint, distanceSqToEdge, featureAtPoint, EDGE_PICK_TOLERANCE,
} from './pickEdge.js';

/** A straight chain along X at y=0, z=0. */
const straight = {
  id: 'E1', closed: false, length: 10, points: [[0, 0, 0], [10, 0, 0]],
};
/** A square loop, 10 mm a side, on z=0. */
const loop = {
  id: 'E2',
  closed: true,
  length: 40,
  points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
};

describe('distanceSqToEdge', () => {
  it('measures to the nearest point ON the segment, not to its ends', () => {
    // Straight above the middle: 2 mm away, not 5.4 mm to an endpoint.
    expect(distanceSqToEdge(straight, [5, 0, 2])).toBeCloseTo(4, 6);
  });

  it('clamps past the ends rather than running off the line', () => {
    expect(distanceSqToEdge(straight, [-3, 0, 0])).toBeCloseTo(9, 6);
    expect(distanceSqToEdge(straight, [13, 0, 0])).toBeCloseTo(9, 6);
  });

  it('closes a closed chain — the last point joins the first', () => {
    // Mid-way down the left side, which only exists if the loop is closed.
    expect(distanceSqToEdge(loop, [0, 5, 0])).toBeCloseTo(0, 6);
    const open = { ...loop, closed: false };
    expect(distanceSqToEdge(open, [0, 5, 0])).toBeCloseTo(25, 6);
  });

  it('is Infinity for a chain with no points', () => {
    expect(distanceSqToEdge({ points: [] }, [0, 0, 0])).toBe(Infinity);
    expect(distanceSqToEdge(null, [0, 0, 0])).toBe(Infinity);
  });
});

describe('edgeAtPoint', () => {
  it('finds the edge the cursor is sitting on', () => {
    expect(edgeAtPoint([straight, loop], [5, 0, 0])?.id).toBe('E1');
  });

  it('returns null out on open surface', () => {
    expect(edgeAtPoint([straight, loop], [5, 5, 5])).toBeNull();
  });

  it('respects the tolerance at its boundary', () => {
    const justInside = [5, 0, EDGE_PICK_TOLERANCE * 0.9];
    const justOutside = [5, 0, EDGE_PICK_TOLERANCE * 1.1];
    expect(edgeAtPoint([straight], justInside)?.id).toBe('E1');
    expect(edgeAtPoint([straight], justOutside)).toBeNull();
  });

  it('breaks a tie towards the shorter chain — the more specific thing', () => {
    // Both pass exactly through the origin; the short one is what was meant.
    const long = { id: 'LONG', closed: false, length: 200, points: [[0, 0, 0], [200, 0, 0]] };
    const short = { id: 'SHORT', closed: false, length: 4, points: [[0, 0, 0], [0, 4, 0]] };
    expect(edgeAtPoint([long, short], [0, 0, 0])?.id).toBe('SHORT');
    expect(edgeAtPoint([short, long], [0, 0, 0])?.id).toBe('SHORT');
  });

  it('survives nothing at all', () => {
    expect(edgeAtPoint([], [0, 0, 0])).toBeNull();
    expect(edgeAtPoint(null, [0, 0, 0])).toBeNull();
    expect(edgeAtPoint([straight], null)).toBeNull();
  });
});

describe('featureAtPoint', () => {
  const face = { id: 'F1', facing: 'up' };

  it('prefers the edge when the cursor is on one', () => {
    expect(featureAtPoint({ edges: [straight], face, point: [5, 0, 0] }).id).toBe('E1');
  });

  it('falls to the face out on open surface', () => {
    expect(featureAtPoint({ edges: [straight], face, point: [5, 5, 5] }).id).toBe('F1');
  });

  it('returns null when neither is there', () => {
    expect(featureAtPoint({ edges: [], face: null, point: [0, 0, 0] })).toBeNull();
    expect(featureAtPoint({})).toBeNull();
  });
});
