import { describe, it, expect } from 'vitest';
import { millingOrientation, reorient, orientForMilling } from './orient.js';
import { boundsOf, meshVolume, shellReport } from './analyze.js';
import { weld } from './stl.js';
import { box } from './fixtures.js';

/** Rotate a box so its long side runs up Z — a model "standing on end". */
function standingBox(long = 67, a = 18, b = 17) {
  return box(a, b, long);
}

describe('millingOrientation', () => {
  it('puts the shortest dimension on the tool axis', () => {
    const o = millingOrientation(boundsOf(standingBox(67, 18, 17)));
    // Source Y (17, shortest) becomes Z; source Z (67, longest) becomes X.
    expect(o.order[2]).toBe(1);
    expect(o.order[0]).toBe(2);
    expect(o.depth).toBeCloseTo(17, 6);
    expect(o.changed).toBe(true);
  });

  it('leaves a part that already lies flat alone', () => {
    const o = millingOrientation(boundsOf(box(60, 40, 10)));
    expect(o.order).toEqual([0, 1, 2]);
    expect(o.changed).toBe(false);
    expect(o.flipY).toBe(false);
    expect(o.description).toMatch(/already lying/);
  });

  it('explains the setup in terms the setter can act on', () => {
    const o = millingOrientation(boundsOf(standingBox(67, 18, 17)));
    expect(o.description).toMatch(/17\.0 mm/);
    expect(o.description).toMatch(/67\.0 mm/);
  });

  it('never returns a reflection uncorrected', () => {
    // Every axis assignment is either an even permutation, or an odd one paired
    // with flipY. An uncorrected reflection would machine a mirrored part.
    for (const dims of [[67, 18, 17], [10, 60, 40], [40, 10, 60], [5, 5, 5], [1, 100, 50]]) {
      const o = millingOrientation(boundsOf(box(...dims)));
      const [x, y, z] = o.order;
      const even = (x === 0 && y === 1 && z === 2)
        || (x === 1 && y === 2 && z === 0)
        || (x === 2 && y === 0 && z === 1);
      // eslint-disable-next-line jest/valid-expect
      expect(o.flipY, `dims ${dims}`).toBe(!even);
    }
  });
});

describe('reorient', () => {
  it('swaps the bounding box the way the order says', () => {
    const m = weld(standingBox(67, 18, 17));
    const o = millingOrientation(boundsOf(m));
    const b = boundsOf(reorient(m, o));
    expect(b.size[0]).toBeCloseTo(67, 4); // longest across the table
    expect(b.size[2]).toBeCloseTo(17, 4); // shortest up the spindle
  });

  it('preserves volume and winding', () => {
    // A reflection would flip the sign of the volume — that is the whole point
    // of flipY, and the cheapest way to prove it did its job.
    const m = weld(standingBox(67, 18, 17));
    const before = meshVolume(m);
    const after = meshVolume(reorient(m, millingOrientation(boundsOf(m))));
    expect(after).toBeCloseTo(before, 3);
    expect(Math.sign(after)).toBe(Math.sign(before));
  });

  it('keeps the shell watertight', () => {
    const m = weld(standingBox());
    const r = shellReport(reorient(m, millingOrientation(boundsOf(m))));
    expect(r.watertight).toBe(true);
    expect(r.consistentWinding).toBe(true);
  });

  it('leaves indices untouched', () => {
    const m = weld(box(60, 40, 10));
    const out = reorient(m, { order: [2, 0, 1], flipY: true });
    expect(out.indices).toBe(m.indices);
    expect(out.triangleCount).toBe(m.triangleCount);
  });

  it('is an identity for the identity order', () => {
    const m = weld(box(10, 20, 30));
    const out = reorient(m, { order: [0, 1, 2], flipY: false });
    expect(Array.from(out.positions)).toEqual(Array.from(m.positions));
  });
});

describe('orientForMilling', () => {
  it('returns the meshes untouched when nothing needs turning over', () => {
    const soup = box(60, 40, 10);
    const welded = weld(soup);
    const r = orientForMilling(soup, welded);
    expect(r.soup).toBe(soup);
    expect(r.welded).toBe(welded);
    expect(r.orientation.changed).toBe(false);
  });

  it('lays a standing part down, soup and welded mesh alike', () => {
    const soup = standingBox(67, 18, 17);
    const welded = weld(soup);
    const r = orientForMilling(soup, welded);
    expect(r.orientation.changed).toBe(true);
    // Both representations must agree, or the viewport and the toolpath will
    // disagree about where the part is.
    expect(boundsOf(r.soup).size[2]).toBeCloseTo(17, 3);
    expect(boundsOf(r.welded).size[2]).toBeCloseTo(17, 3);
  });
});
