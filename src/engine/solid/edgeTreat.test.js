import { describe, it, expect } from 'vitest';
import {
  treatmentSection, lineEdgeFrame, circleEdgeFrame, applyEdgeTreatment,
  pickTreatEdge, parseEdgeRef, sameEdge, describeEdgeRef,
} from './edgeTreat.js';
import { extrudeRegion, revolveRegion } from './extrude.js';
import { meshBoolean } from '../../lib/csg.js';
import { volume, isClosed } from './solidAssert.js';
import { openEdgeCount } from '../mesh/repair.js';
import { weld } from '../mesh/stl.js';

const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const box = (x0, y0, x1, y1, z0, z1) => extrudeRegion(
  { outer: square(x0, y0, x1, y1) },
  { depth: z1 - z0, base: z0 },
);
const circleLoop = (r, n = 64) => Array.from({ length: n }, (_, i) => [
  r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n),
]).flat();

const near = (v, want, tol = 1) => expect(Math.abs(v - want)).toBeLessThan(tol);
// The top front edge of a 40 × 20 × 10 block, running along X.
const TOP_FRONT = { type: 'line', a: [0, 0, 10], b: [40, 0, 10] };

describe('treatmentSection', () => {
  const square90 = {
    P: [0, 0], n1: [0, 1], n2: [1, 0], t1: [-1, 0], t2: [0, -1],
  };

  it('cuts at an outside corner and fills an inside one', () => {
    expect(treatmentSection(square90, 'chamfer', 2).convex).toBe(true);
    const inside = {
      P: [0, 0], n1: [0, 1], n2: [-1, 0], t1: [-1, 0], t2: [0, 1],
    };
    expect(treatmentSection(inside, 'chamfer', 2).convex).toBe(false);
  });

  it('gives a counter-clockwise loop', () => {
    for (const kind of ['chamfer', 'fillet']) {
      const { loop } = treatmentSection(square90, kind, 2);
      let area = 0;
      for (let i = 0; i < loop.length; i += 2) {
        const j = (i + 2) % loop.length;
        area += loop[i] * loop[j + 1] - loop[j] * loop[i + 1];
      }
      expect(area).toBeGreaterThan(0);
    }
  });

  it('refuses a size of zero and faces that are flat', () => {
    expect(() => treatmentSection(square90, 'chamfer', 0)).toThrow(/size/);
    expect(() => treatmentSection({
      ...square90, t2: [1, 0], n2: [0, 1],
    }, 'chamfer', 1)).toThrow(/flat/);
  });
});

describe('lineEdgeFrame', () => {
  it('finds both faces and the whole edge, even from a part of it', () => {
    const part = box(0, 0, 40, 20, 0, 10);
    const f = lineEdgeFrame(part, { type: 'line', a: [10, 0, 10], b: [20, 0, 10] });
    near(f.a[0], 0, 1e-3);
    near(f.b[0], 40, 1e-3);
    const normals = [f.n1, f.n2].map((n) => n.map(Math.round).join());
    expect(normals.sort()).toEqual(['0,-1,0', '0,0,1']);
    // Each face runs away from the edge into the part.
    const inward = [f.t1, f.t2].map((t) => t.map(Math.round).join());
    expect(inward.sort()).toEqual(['0,0,-1', '0,1,0']);
  });

  it('says so when the edge is not on the part', () => {
    const part = box(0, 0, 40, 20, 0, 10);
    expect(() => lineEdgeFrame(part, { type: 'line', a: [0, 5, 10], b: [40, 5, 10] })).toThrow(/no longer/);
  });
});

describe('applyEdgeTreatment — straight edges', () => {
  it('chamfers an edge: removes c²/2 per mm of length', () => {
    const part = box(0, 0, 40, 20, 0, 10);
    const out = applyEdgeTreatment(part, { kind: 'chamfer', size: 2, edges: [TOP_FRONT] }, meshBoolean);
    near(volume(out), 8000 - 2 * 40, 0.5);
    expect(openEdgeCount(out)).toBe(0);
  });

  it('fillets an edge: removes (1 − π/4)·r² per mm of length', () => {
    const part = box(0, 0, 40, 20, 0, 10);
    const out = applyEdgeTreatment(part, { kind: 'fillet', size: 3, edges: [TOP_FRONT] }, meshBoolean);
    near(volume(out), 8000 - (1 - Math.PI / 4) * 9 * 40, 0.5);
    expect(isClosed(out)).toBe(true);
  });

  it('chamfers several edges of one block', () => {
    const part = box(0, 0, 40, 20, 0, 10);
    const edges = [
      TOP_FRONT,
      { type: 'line', a: [0, 20, 10], b: [40, 20, 10] },
      { type: 'line', a: [0, 0, 0], b: [0, 20, 0] },
    ];
    const out = applyEdgeTreatment(part, { kind: 'chamfer', size: 1, edges }, meshBoolean);
    near(volume(out), 8000 - 0.5 * (40 + 40 + 20), 0.5);
  });

  it('fills an inside corner', () => {
    // An L drawn on the YZ plane and run 40 along X: a 20×5 plate with a 5×15
    // wall standing on its back.
    const part = extrudeRegion(
      { outer: [0, 0, 20, 0, 20, 20, 15, 20, 15, 5, 0, 5] },
      { depth: 40, plane: { origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1] } },
    );
    const corner = { type: 'line', a: [0, 15, 5], b: [40, 15, 5] };
    const before = volume(part);
    const out = applyEdgeTreatment(part, { kind: 'chamfer', size: 2, edges: [corner] }, meshBoolean);
    near(volume(out), before + 2 * 40, 1);
  });
});

describe('applyEdgeTreatment — round edges', () => {
  it('chamfers the mouth of a bore', () => {
    const plate = box(-20, -20, 20, 20, 0, 10);
    const bore = extrudeRegion({ outer: circleLoop(5) }, { depth: 12, base: -1 });
    const part = meshBoolean(plate, bore, 'cut');
    const rim = { type: 'circle', axis: 2, center: [0, 0, 10], radius: 5 };
    const f = circleEdgeFrame(part, rim);
    expect(f.n1).toEqual([0, 1]);
    expect(f.n2).toEqual([-1, 0]);
    expect(f.segments).toBe(64);
    expect(f.open).toBe(true);
    const before = volume(part);
    const out = applyEdgeTreatment(part, { kind: 'chamfer', size: 1, edges: [rim] }, meshBoolean);
    // A ring of triangle ½·1·1 at a mean radius of 5 + 1/3, and the 0.01 mm skin
    // re-cut down the 9 mm of wall below it and 1 mm past.
    const chamfer = 0.5 * 2 * Math.PI * (5 + 1 / 3);
    const skin = 2 * Math.PI * 5 * 0.01 * 10;
    near(before - volume(out), chamfer + skin, 0.4);
    // The mesh boolean leaves a few cracks where a cone crosses a flat face —
    // the Hole Wizard's own chamfer does the same — but not a ring of them.
    expect(openEdgeCount(out)).toBeLessThan(60);
  });

  it('fillets the top of a boss', () => {
    const boss = revolveRegion({ outer: [0, 0, 8, 0, 8, 10, 0, 10] }, { axis: 'y', segments: 64 });
    // Revolved about Y: the top rim is at y = 10, radius 8.
    const rim = { type: 'circle', axis: 1, center: [0, 10, 0], radius: 8 };
    const before = volume(boss);
    const out = applyEdgeTreatment(boss, { kind: 'fillet', size: 2, edges: [rim] }, meshBoolean);
    const ringArea = (1 - Math.PI / 4) * 4;
    // The removed ring's section sits between radius 7 and 8, plus the 0.01 mm
    // skin down the 8 mm of wall below the fillet and 2 mm past its foot.
    const skin = 2 * Math.PI * 8 * 0.01 * 10;
    expect(before - volume(out)).toBeGreaterThan(ringArea * 2 * Math.PI * 7 + skin * 0.9);
    expect(before - volume(out)).toBeLessThan(ringArea * 2 * Math.PI * 8 + skin * 1.1);
  });
});

describe('picking and storage', () => {
  it('reads a click near an edge as that straight edge, with its faces', () => {
    const part = box(0, 0, 40, 20, 0, 10);
    const ref = pickTreatEdge(weld(part), [12, 0.1, 9.9], 0.5);
    expect(ref.type).toBe('line');
    expect(sameEdge(ref, TOP_FRONT)).toBe(true);
    expect(describeEdgeRef(ref)).toBe('Edge 40.0 mm');
  });

  it('reads a click on a bore rim as the circle', () => {
    const plate = box(-20, -20, 20, 20, 0, 10);
    const bore = extrudeRegion({ outer: circleLoop(5) }, { depth: 12, base: -1 });
    const part = meshBoolean(plate, bore, 'cut');
    const ref = pickTreatEdge(weld(part), [5, 0.05, 10], 0.5);
    expect(ref.type).toBe('circle');
    expect(ref.axis).toBe(2);
    near(ref.radius, 5, 0.01);
    near(ref.center[2], 10, 1e-3);
  });

  it('keeps only well-formed references from a file', () => {
    expect(parseEdgeRef({ type: 'line', a: [0, 0, 0], b: [1, 0, 0] })).toEqual({ type: 'line', a: [0, 0, 0], b: [1, 0, 0] });
    expect(parseEdgeRef({ type: 'circle', axis: 2, center: [0, 0, 0], radius: 3 })?.radius).toBe(3);
    expect(parseEdgeRef({ type: 'line', a: [0, 0] })).toBe(null);
    expect(parseEdgeRef({ type: 'circle', axis: 4, center: [0, 0, 0], radius: 3 })).toBe(null);
  });
});
