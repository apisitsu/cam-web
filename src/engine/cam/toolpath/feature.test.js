import { describe, it, expect } from 'vitest';
import { faceRegionOp, traceOp, faceToLoops } from './feature.js';
import { detectPlanarFaces, detectSharpEdges } from '../../mesh/features.js';
import { areaOf } from '../offset.js';
import { toolById } from '../library.js';
import { machineById } from '../machines.js';
import { weld } from '../../mesh/stl.js';
import { box, cylinder } from '../../mesh/fixtures.js';

const cut = {
  material: 'aluminium',
  tool: toolById('em6'),
  machine: machineById('haas-vf2'),
};

const facesOf = (soup) => detectPlanarFaces(weld(soup)).faces;
const topOf = (soup) => facesOf(soup).find((f) => f.facing === 'up');

describe('faceToLoops', () => {
  it('flattens a face outline to XY, wound outer-CCW', () => {
    const loops = faceToLoops(topOf(box(60, 40, 20)));
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(8);          // four corners, x/y pairs
    expect(areaOf(loops[0])).toBeGreaterThan(0); // CCW
  });

  it('winds a hole the opposite way to its outline', () => {
    // The offsetter reads inside from outside off the winding alone, so a hole
    // wound the same way as its outline grows instead of shrinking.
    const face = {
      facing: 'up',
      loops: [
        [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]],
        [[-4, -4, 0], [4, -4, 0], [4, 4, 0], [-4, 4, 0]],
      ],
    };
    const [outer, hole] = faceToLoops(face);
    expect(areaOf(outer)).toBeGreaterThan(0);
    expect(areaOf(hole)).toBeLessThan(0);
  });
});

describe('faceRegionOp', () => {
  it('clears a picked face with concentric rings', () => {
    const op = faceRegionOp(topOf(box(60, 40, 20)), cut);
    expect(op).toBeTruthy();
    expect(op.kind).toBe('region');
    expect(op.cutLength).toBeGreaterThan(100);
    expect(op.notes.some((n) => /ring/.test(n))).toBe(true);
  });

  it('cuts at the face’s own plane', () => {
    const op = faceRegionOp(topOf(box(60, 40, 20)), cut);
    const feeds = op.moves.filter((m) => m.t === 'feed');
    for (const m of feeds) expect(m.z).toBeCloseTo(10, 3);
  });

  it('stays a tool radius inside the outline', () => {
    // The cutter's edge lands on the boundary, not its centre — otherwise it
    // machines half a diameter of air outside the face.
    const op = faceRegionOp(topOf(box(60, 40, 20)), cut);
    const xs = op.moves.filter((m) => m.t === 'feed').map((m) => m.x);
    expect(Math.max(...xs)).toBeLessThanOrEqual(30 - 3 + 0.01);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-30 + 3 - 0.01);
  });

  it('steps down when asked to come from above the face', () => {
    const face = topOf(box(60, 40, 20));
    const shallow = faceRegionOp(face, cut);
    const deep = faceRegionOp(face, { ...cut, from: 20 });
    expect(deep.cutLength).toBeGreaterThan(shallow.cutLength);
    expect(deep.notes.some((n) => /passes of/.test(n))).toBe(true);
    // Nothing cuts below the face plane.
    const zs = deep.moves.filter((m) => m.t === 'feed').map((m) => m.z);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(10 - 0.001);
  });

  it('refuses a face the tool axis cannot reach', () => {
    // A side wall projected onto the table and machined as its own shadow is
    // the single worst thing this module could do quietly.
    for (const facing of ['front', 'left', 'down']) {
      const face = facesOf(box(60, 40, 20)).find((f) => f.facing === facing);
      // eslint-disable-next-line jest/valid-expect
      expect(faceRegionOp(face, cut), facing).toBeNull();
    }
  });

  it('refuses a face smaller than the cutter', () => {
    const face = topOf(box(4, 4, 10));
    expect(faceRegionOp(face, cut)).toBeNull();
  });

  it('leaves an allowance when asked', () => {
    const op = faceRegionOp(topOf(box(60, 40, 20)), { ...cut, allowance: 0.5, from: 20 });
    const zs = op.moves.filter((m) => m.t === 'feed').map((m) => m.z);
    expect(Math.min(...zs)).toBeCloseTo(10.5, 3);
  });

  it('runs faster with a bigger cutter, for the same face', () => {
    const small = faceRegionOp(topOf(box(60, 40, 20)), { ...cut, tool: toolById('em4') });
    const big = faceRegionOp(topOf(box(60, 40, 20)), { ...cut, tool: toolById('em12') });
    expect(big.cutLength).toBeLessThan(small.cutLength);
  });
});

describe('traceOp', () => {
  const rim = () => detectSharpEdges(weld(cylinder(15, 40, 48)))[0];

  it('follows the picked edge point for point', () => {
    const edge = rim();
    const op = traceOp(edge, cut);
    expect(op.kind).toBe('trace');
    // One pass over every point, plus the closing move.
    const feeds = op.moves.filter((m) => m.t === 'feed');
    expect(feeds.length).toBeGreaterThanOrEqual(edge.points.length);
    // The edge is walked once and only once: the approach rapids down to a
    // millimetre above and feeds that last millimetre, so the cut length is the
    // edge plus that entry and nothing else.
    expect(op.cutLength).toBeCloseTo(edge.length + 1, 1);
  });

  it('cuts at the edge’s own height by default', () => {
    const edge = rim();
    const op = traceOp(edge, cut);
    const z0 = edge.points[0][2];
    for (const m of op.moves.filter((m) => m.t === 'feed')) {
      expect(m.z).toBeCloseTo(z0, 3);
    }
  });

  it('steps down in passes when given a depth', () => {
    const edge = rim();
    const shallow = traceOp(edge, { ...cut, depth: 0.5 });
    const deep = traceOp(edge, { ...cut, depth: 12 });
    expect(deep.cutLength).toBeGreaterThan(shallow.cutLength);
    const zs = deep.moves.filter((m) => m.t === 'feed').map((m) => m.z);
    expect(Math.min(...zs)).toBeCloseTo(edge.points[0][2] - 12, 3);
  });

  it('closes a closed edge and leaves an open one open', () => {
    const closed = traceOp(rim(), cut);
    const first = closed.moves.find((m) => m.t === 'feed');
    const lastFeed = [...closed.moves].reverse().find((m) => m.t === 'feed');
    expect(lastFeed.x).toBeCloseTo(first.x, 4);
    expect(lastFeed.y).toBeCloseTo(first.y, 4);

    const open = traceOp({ points: [[0, 0, 0], [10, 0, 0]], length: 10, closed: false }, cut);
    const openLast = [...open.moves].reverse().find((m) => m.t === 'feed');
    expect(openLast.x).toBeCloseTo(10, 4);
  });

  it('is candid that it does not offset to either side', () => {
    // Which side of a line the cutter belongs on is a question about the part,
    // not the line. Guessing cuts the feature away instead of beside it.
    expect(traceOp(rim(), cut).notes.some((n) => /no side offset/.test(n))).toBe(true);
  });

  it('refuses a degenerate edge', () => {
    expect(traceOp({ points: [[0, 0, 0]], closed: false, length: 0 }, cut)).toBeNull();
    expect(traceOp({ points: [], closed: false, length: 0 }, cut)).toBeNull();
  });
});
