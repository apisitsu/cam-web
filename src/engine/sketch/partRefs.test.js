import { describe, it, expect } from 'vitest';
import {
  partReferences, pickPartRef, placePartRef, dropUnusedPartRefs, followPartRefs,
} from './partRefs.js';
import { weld } from '../mesh/stl.js';
import { createSketch, addPoint, addConstraint } from './model.js';
import { holePositions } from '../solid/hole.js';
import { extrudeRegion } from '../solid/extrude.js';

const TOP = { preset: 'XY', offset: 10 };

function square(x0, y0, x1, y1) {
  return { outer: [x0, y0, x1, y0, x1, y1, x0, y1], holes: [] };
}

function circleLoop(r, n = 48) {
  return Array.from({ length: n }, (_, i) => {
    const t = (-2 * Math.PI * i) / n;
    return [r * Math.cos(t), r * Math.sin(t)];
  }).flat();
}

const prism = (region) => weld(extrudeRegion(region, { depth: 10, plane: { preset: 'XY', offset: 0 } }));

describe('partReferences', () => {
  it('a block seen from the top is its four outline edges and four corners', () => {
    const refs = partReferences(prism(square(0, 0, 40, 20)), TOP);
    expect(refs.segments).toHaveLength(4);
    expect(refs.points).toHaveLength(4);
    expect(refs.circles).toHaveLength(0);
  });

  it('a block seen from the front is one rectangle, whatever lies behind it', () => {
    const refs = partReferences(prism(square(0, 0, 40, 20)), { preset: 'XZ', offset: 0 });
    expect(refs.segments).toHaveLength(4);
  });

  it('a bored hole comes through as one circle, not dozens of short lines', () => {
    const refs = partReferences(prism({ ...square(-30, -30, 30, 30), holes: [circleLoop(5)] }), TOP);
    expect(refs.circles).toHaveLength(1);
    expect(refs.circles[0].r).toBeCloseTo(5, 1);
    expect(refs.segments).toHaveLength(4);
  });
});

describe('pickPartRef', () => {
  const refs = {
    segments: [{ a: { x: 0, y: 0 }, b: { x: 40, y: 0 } }],
    circles: [{ x: 20, y: 20, r: 5 }],
    points: [{ x: 0, y: 0 }, { x: 40, y: 0 }],
  };

  it('prefers the corner to the edge ending there', () => {
    expect(pickPartRef(refs, 0.2, 0.1, 1)).toMatchObject({ kind: 'point', x: 0, y: 0 });
  });
  it('takes the edge along its length', () => {
    expect(pickPartRef(refs, 20, 0.5, 1)).toMatchObject({ kind: 'line' });
  });
  it('takes a rim or a centre as the centre', () => {
    expect(pickPartRef(refs, 25.2, 20, 1)).toMatchObject({ kind: 'point', x: 20, y: 20 });
    expect(pickPartRef(refs, 20, 20, 1)).toMatchObject({ kind: 'point', x: 20, y: 20 });
  });
  it('finds nothing in empty space', () => {
    expect(pickPartRef(refs, 20, 10, 1)).toBeNull();
  });
});

describe('placing a reference', () => {
  const edge = { kind: 'line', a: { x: 0, y: 0 }, b: { x: 40, y: 0 } };

  it('makes fixed construction geometry and reuses it on a second pick', () => {
    const sk = createSketch();
    const id = placePartRef(sk, edge);
    const line = sk.entities.get(id);
    expect(line.construction).toBe(true);
    expect(sk.entities.get(line.p1).fixed).toBe(true);
    expect(placePartRef(sk, edge)).toBe(id);
    expect(sk.entities.size).toBe(3);
  });

  it('never becomes a hole position', () => {
    const sk = createSketch();
    placePartRef(sk, { kind: 'point', x: 5, y: 5 });
    expect(holePositions(sk)).toHaveLength(0);
  });

  it('dropping keeps what a dimension uses and removes the rest', () => {
    const sk = createSketch();
    const kept = placePartRef(sk, edge);
    placePartRef(sk, { kind: 'point', x: 9, y: 9 });
    const p = addPoint(sk, 10, 10);
    addConstraint(sk, 'pointLineDistance', [p, kept], 10);
    expect(dropUnusedPartRefs(sk)).toBe(true);
    expect(sk.entities.has(kept)).toBe(true);
    expect([...sk.entities.values()].filter((e) => e.ref)).toHaveLength(3);
    expect(dropUnusedPartRefs(sk)).toBe(false);
  });
});

describe('following the part when it changes', () => {
  const pt = (x, y) => ({ x, y });
  const seg = (ax, ay, bx, by) => ({ a: pt(ax, ay), b: pt(bx, by) });
  const box = (w, h) => ({
    segments: [seg(0, 0, w, 0), seg(w, 0, w, h), seg(w, h, 0, h), seg(0, h, 0, 0)],
    circles: [],
    points: [pt(0, 0), pt(w, 0), pt(w, h), pt(0, h)],
  });
  const lineEnds = (sk, id) => {
    const l = sk.entities.get(id);
    return [sk.entities.get(l.p1), sk.entities.get(l.p2)].map((p) => [p.x, p.y]);
  };

  it('the edge that moved takes its reference along; the one that did not stays', () => {
    const sk = createSketch();
    const right = placePartRef(sk, { kind: 'line', ...seg(40, 0, 40, 20) });
    const left = placePartRef(sk, { kind: 'line', ...seg(0, 0, 0, 20) });
    expect(followPartRefs(sk, box(40, 20), box(60, 20))).toEqual({ moved: true, lost: 0 });
    expect(lineEnds(sk, right)).toEqual([[60, 0], [60, 20]]);
    expect(lineEnds(sk, left)).toEqual([[0, 0], [0, 20]]);
  });

  it('a shrink past the halfway mark still finds the right edge', () => {
    const sk = createSketch();
    const right = placePartRef(sk, { kind: 'line', ...seg(100, 0, 100, 20) });
    followPartRefs(sk, box(100, 20), box(5, 20));
    expect(lineEnds(sk, right)[0][0]).toBe(5);
  });

  it('an edge whose length alone changed keeps its reference on it', () => {
    const sk = createSketch();
    const top = placePartRef(sk, { kind: 'line', ...seg(40, 20, 0, 20) });
    followPartRefs(sk, box(40, 20), box(60, 20));
    expect(lineEnds(sk, top)).toEqual([[60, 20], [0, 20]]);
  });

  it('a corner goes where its edges went', () => {
    const sk = createSketch();
    const c = placePartRef(sk, { kind: 'point', x: 40, y: 20 });
    followPartRefs(sk, box(40, 20), box(60, 35));
    expect(sk.entities.get(c)).toMatchObject({ x: 60, y: 35 });
  });

  it('a hole centre follows the hole, even at a new diameter', () => {
    const sk = createSketch();
    const c = placePartRef(sk, { kind: 'point', x: 10, y: 10 });
    followPartRefs(
      sk,
      { ...box(40, 20), circles: [{ x: 10, y: 10, r: 3 }] },
      { ...box(40, 20), circles: [{ x: 14, y: 12, r: 5 }] },
    );
    expect(sk.entities.get(c)).toMatchObject({ x: 14, y: 12 });
  });

  it('more geometry on the part leaves references on untouched edges alone', () => {
    const sk = createSketch();
    const right = placePartRef(sk, { kind: 'line', ...seg(40, 0, 40, 20) });
    const after = box(40, 20);
    after.segments.push(seg(10, 5, 10, 15), seg(30, 5, 30, 15));
    expect(followPartRefs(sk, box(40, 20), after)).toEqual({ moved: false, lost: 0 });
    expect(lineEnds(sk, right)[0][0]).toBe(40);
  });

  it('counts a reference whose edge is gone, and leaves it where it was', () => {
    const sk = createSketch();
    const edge = placePartRef(sk, { kind: 'line', ...seg(10, 5, 30, 25) });
    const before = box(40, 20);
    before.segments.push(seg(10, 5, 30, 25));
    expect(followPartRefs(sk, before, box(40, 20))).toEqual({ moved: false, lost: 1 });
    expect(lineEnds(sk, edge)[0]).toEqual([10, 5]);
  });

  it('a dimension to an edge on the origin moves the reference, not the origin', () => {
    const sk = createSketch();
    const o = addPoint(sk, 0, 0, true);
    sk.entities.get(o).origin = true;
    const bottom = placePartRef(sk, { kind: 'line', ...seg(0, 0, 40, 0) });
    expect(sk.entities.get(bottom).p1).not.toBe(o);
  });
});
