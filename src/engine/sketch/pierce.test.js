import { describe, it, expect } from 'vitest';
import { piercePoints, followPierces } from './pierce.js';
import { createSketch, addPoint, addLine } from './model.js';
import { planeToWorld, worldToPlane } from './plane.js';
import { placePartRef, pickPartRef } from './partRefs.js';

const XZ = { preset: 'XZ', offset: 0 };
const UP10 = { preset: 'XY', offset: 10 };

/** A path sketch on XZ: one line standing up from the floor at sketch x = `x`. */
function path(x) {
  const doc = createSketch();
  addLine(doc, addPoint(doc, x, -5), addPoint(doc, x, 40));
  return doc;
}

describe('Pierce', () => {
  it('finds where another sketch passes through this plane, and follows it', () => {
    const profile = createSketch();
    const sketches = [
      { id: 1, name: 'Path', plane: XZ, doc: path(5) },
      { id: 2, name: 'Profile', plane: UP10, doc: profile },
    ];
    const spots = piercePoints(sketches, 2);
    expect(spots).toHaveLength(1);
    expect(spots[0].sketchName).toBe('Path');
    // The path's line, in the world, meets z = 10 where the spot says.
    const w = planeToWorld(UP10, spots[0].x, spots[0].y);
    expect(w[2]).toBeCloseTo(10, 9);
    const onPath = worldToPlane(XZ, w);
    expect(onPath.x).toBeCloseTo(5, 9);
    expect(Math.abs(onPath.off)).toBeLessThan(1e-9);

    // Picked like a part edge, it becomes a fixed point that knows what it pierces.
    const ref = pickPartRef({ points: spots, circles: [], segments: [] }, spots[0].x, spots[0].y, 0.5);
    const id = placePartRef(profile, ref);
    expect(profile.entities.get(id).pierce).toEqual({ sketchId: 1, entityId: spots[0].pierce.entityId });

    // The path moves; the point goes with it.
    sketches[0].doc = path(8);
    // Same entity ids as before (a fresh sketch numbers the same way).
    const { moved, lost } = followPierces(sketches, 2);
    expect(moved).toBe(true);
    expect(lost).toBe(0);
    const p = profile.entities.get(id);
    expect(worldToPlane(XZ, planeToWorld(UP10, p.x, p.y)).x).toBeCloseTo(8, 9);
  });

  it('skips geometry lying in the plane itself', () => {
    const flat = createSketch();
    addLine(flat, addPoint(flat, 0, 0), addPoint(flat, 10, 0));
    const sketches = [
      { id: 1, name: 'Flat', plane: UP10, doc: flat },
      { id: 2, name: 'Other', plane: UP10, doc: createSketch() },
    ];
    expect(piercePoints(sketches, 2)).toEqual([]);
  });
});
