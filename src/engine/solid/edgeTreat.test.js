import {
  describe, it, expect, beforeAll,
} from 'vitest';
import {
  treatmentSection, lineEdgeFrame, circleEdgeFrame, applyEdgeTreatment,
  pickTreatEdge, parseEdgeRef, sameEdge, describeEdgeRef,
} from './edgeTreat.js';
import { extrudeRegion, revolveRegion } from './extrude.js';
import { meshBoolean, loadMeshBoolean } from '../../lib/csg.js';
import { volume, isClosed } from './solidAssert.js';
import { openEdgeCount } from '../mesh/repair.js';
import { weld } from '../mesh/stl.js';
import { analyzeMesh } from '../mesh/analyze.js';

const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const box = (x0, y0, x1, y1, z0, z1) => extrudeRegion(
  { outer: square(x0, y0, x1, y1) },
  { depth: z1 - z0, base: z0 },
);
const circleLoop = (r, n = 64) => Array.from({ length: n }, (_, i) => [
  r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n),
]).flat();

// The app always booleans through manifold once it is loaded; so do these.
beforeAll(async () => { await loadMeshBoolean(); });

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
    expect(openEdgeCount(out)).toBe(0);
  });

  it('fillets an edge with a radius running from one size to another', () => {
    const part = box(0, 0, 40, 20, 0, 10);
    const out = applyEdgeTreatment(part, {
      kind: 'fillet', size: 1, sizeEnd: 4, edges: [TOP_FRONT],
    }, meshBoolean);
    // ∫ (1 − π/4) r(s)² ds with r linear from 1 to 4 over 40 mm.
    near(volume(out), 8000 - (1 - Math.PI / 4) * 40 * ((1 + 4 + 16) / 3), 0.5);
    expect(isClosed(out)).toBe(true);
    expect(openEdgeCount(out)).toBe(0);
    expect(() => applyEdgeTreatment(part, {
      kind: 'fillet', size: 1, sizeEnd: 4, edges: [{ type: 'circle', center: [0, 0, 10], normal: [0, 0, 1], r: 3 }],
    }, meshBoolean)).toThrow(/straight edges/);
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
    const before = volume(part);
    const out = applyEdgeTreatment(part, { kind: 'chamfer', size: 1, edges: [rim] }, meshBoolean);
    // A ring of triangle ½·1·1 at a mean radius of 5 + 1/3.
    near(before - volume(out), 0.5 * 2 * Math.PI * (5 + 1 / 3), 0.1);
    expect(openEdgeCount(out)).toBe(0);
  });

  it('fillets the top of a boss', () => {
    const boss = revolveRegion({ outer: [0, 0, 8, 0, 8, 10, 0, 10] }, { axis: 'y', segments: 64 });
    // Revolved about Y: the top rim is at y = 10, radius 8.
    const rim = { type: 'circle', axis: 1, center: [0, 10, 0], radius: 8 };
    const before = volume(boss);
    const out = applyEdgeTreatment(boss, { kind: 'fillet', size: 2, edges: [rim] }, meshBoolean);
    const ringArea = (1 - Math.PI / 4) * 4;
    // The removed ring's section sits between radius 7 and 8.
    expect(before - volume(out)).toBeGreaterThan(ringArea * 2 * Math.PI * 7);
    expect(before - volume(out)).toBeLessThan(ringArea * 2 * Math.PI * 8);
    expect(openEdgeCount(out)).toBe(0);
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

describe('chains — straight runs and arcs round a flat face', () => {
  // A 60 × 60 × 15 block with its four upright corners filleted R10: the top
  // edge is then one run, straight–arc–straight round the top face.
  const roundedBlock = () => applyEdgeTreatment(
    box(0, 0, 60, 60, 0, 15),
    {
      kind: 'fillet',
      size: 10,
      edges: [[0, 0], [60, 0], [60, 60], [0, 60]].map(([x, y]) => ({ type: 'line', a: [x, y, 0], b: [x, y, 15] })),
    },
    meshBoolean,
  );

  it('picks the whole run, not just the straight piece under the click', () => {
    const part = roundedBlock();
    const ref = pickTreatEdge(weld(part), [30, 0.05, 14.95], 0.5);
    expect(ref.type).toBe('chain');
    expect(ref.closed).toBe(true);
    expect(ref.n[2]).toBeCloseTo(1, 6);
    // 4 × 40 straight + a full turn of R10 arcs (faceted, so a hair under 2π·10).
    near(ref.length, 160 + 2 * Math.PI * 10, 0.5);
    expect(describeEdgeRef(ref)).toMatch(/^Edge chain/);
    expect(sameEdge(ref, pickTreatEdge(weld(part), [60, 30, 15], 0.5))).toBe(true);
  });

  it('chamfers the whole run, closed, and as much as the sweep removes', () => {
    const part = roundedBlock();
    const ref = pickTreatEdge(weld(part), [30, 0, 15], 0.5);
    const out = applyEdgeTreatment(part, { kind: 'chamfer', size: 1.5, edges: [ref] }, meshBoolean);
    // ½c² swept along the path of its centroid, c/3 in from the outline.
    near(volume(part) - volume(out), 0.5 * 1.5 ** 2 * (160 + 2 * Math.PI * (10 - 0.5)), 0.5);
    expect(openEdgeCount(out)).toBe(0);
    expect(analyzeMesh(out, weld(out)).warnings).toEqual([]);
  });

  it('fillets the whole run', () => {
    const part = roundedBlock();
    const ref = pickTreatEdge(weld(part), [30, 0, 15], 0.5);
    const out = applyEdgeTreatment(part, { kind: 'fillet', size: 2, edges: [ref] }, meshBoolean);
    // (1 − π/4)·r² swept along its centroid's path, 0.223·r in from the outline.
    const inset = (2 * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI));
    near(volume(part) - volume(out), (1 - Math.PI / 4) * 4 * (160 + 2 * Math.PI * (10 - inset)), 2);
    expect(analyzeMesh(out, weld(out)).warnings).toEqual([]);
  });

  it('chamfers the rim of a pocket with rounded corners, turning the other way', () => {
    // A 60 × 60 × 10 plate with a 30 × 30 through pocket whose corners are R5.
    const plate = box(-30, -30, 30, 30, 0, 10);
    const r = 5;
    const pocketLoop = [];
    for (const [cx, cy, a0] of [[10, -10, -90], [10, 10, 0], [-10, 10, 90], [-10, -10, 180]]) {
      for (let k = 0; k <= 18; k++) {
        const a = ((a0 + (90 * k) / 18) * Math.PI) / 180;
        pocketLoop.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }
    }
    const part = meshBoolean(plate, extrudeRegion({ outer: pocketLoop }, { depth: 12, base: -1 }), 'cut');
    const ref = pickTreatEdge(weld(part), [0, -15, 10], 0.5);
    expect(ref.type).toBe('chain');
    const out = applyEdgeTreatment(part, { kind: 'chamfer', size: 1, edges: [ref] }, meshBoolean);
    // The centroid's path runs c/3 OUT from the pocket's outline.
    near(volume(part) - volume(out), 0.5 * (80 + 2 * Math.PI * (5 + 1 / 3)), 0.5);
    expect(analyzeMesh(out, weld(out)).warnings).toEqual([]);
  });

  it('keeps a straight edge that meets others at sharp corners a straight edge', () => {
    const ref = pickTreatEdge(weld(box(0, 0, 40, 20, 0, 10)), [12, 0.1, 9.9], 0.5);
    expect(ref.type).toBe('line');
  });
});

describe('phase 8 — edits that move edges, ball corners, tilted rims', () => {
  it('follows a straight edge that moved when the part got taller', () => {
    // The chamfer was picked on a 10-high block; the block is now 15 high.
    const ref = pickTreatEdge(weld(box(0, 0, 40, 20, 0, 10)), [20, 0, 10], 0.5);
    const taller = box(0, 0, 40, 20, 0, 15);
    const out = applyEdgeTreatment(taller, { kind: 'chamfer', size: 2, edges: [ref] }, meshBoolean);
    near(volume(out), 40 * 20 * 15 - 2 * 40, 0.5);
    // The cut is on the new top edge, not the old line through the front face.
    const zs = [];
    for (let i = 2; i < out.positions.length; i += 3) zs.push(out.positions[i]);
    expect(Math.max(...zs)).toBeCloseTo(15, 3);
  });

  it('follows a rim whose hole moved', () => {
    const plate = box(-20, -20, 20, 20, 0, 10);
    const bore = (x) => extrudeRegion({ outer: circleLoop(5).map((v, i) => (i % 2 ? v : v + x)) }, { depth: 12, base: -1 });
    const ref = pickTreatEdge(weld(meshBoolean(plate, bore(0), 'cut')), [5, 0.05, 10], 0.5);
    const moved = meshBoolean(plate, bore(6), 'cut');
    const out = applyEdgeTreatment(moved, { kind: 'chamfer', size: 1, edges: [ref] }, meshBoolean);
    near(volume(moved) - volume(out), 0.5 * 2 * Math.PI * (5 + 1 / 3), 0.2);
  });

  it('rounds the corner where three filleted edges meet into a ball', () => {
    const r = 3;
    const part = box(0, 0, 40, 30, 0, 20);
    const edges = [
      { type: 'line', a: [0, 0, 0], b: [40, 0, 0] },
      { type: 'line', a: [0, 0, 0], b: [0, 30, 0] },
      { type: 'line', a: [0, 0, 0], b: [0, 0, 20] },
    ].map((e) => pickTreatEdge(weld(part), e.a.map((v, i) => (v + e.b[i]) / 2), 0.5));
    const out = applyEdgeTreatment(part, { kind: 'fillet', size: r, edges }, meshBoolean);
    // Along each edge past the corner cube, and the corner cube less an eighth of the ball.
    const along = (1 - Math.PI / 4) * r * r * ((40 - r) + (30 - r) + (20 - r));
    const corner = r ** 3 * (1 - Math.PI / 6);
    near(volume(part) - volume(out), along + corner, 1.5);
    expect(analyzeMesh(out, weld(out)).warnings).toEqual([]);
    // Nearest the corner along its diagonal the part now starts on the ball,
    // x+y+z = 3r(1 − 1/√3) ≈ 3.80, not at the three fillets' seam (≈ 2.64).
    let least = Infinity;
    for (let i = 0; i < out.positions.length; i += 3) {
      least = Math.min(least, out.positions[i] + out.positions[i + 1] + out.positions[i + 2]);
    }
    expect(least).toBeGreaterThan(3.6);
    expect(least).toBeLessThan(3.85);
  });

  it('rounds a corner that is not square into a ball as well', () => {
    const r = 3;
    // A slanted prism: the corner at the origin is 71.6° in plan.
    const part = extrudeRegion({ outer: [0, 0, 40, 0, 50, 30, 10, 30] }, { depth: 20 });
    const lines = [
      { a: [0, 0, 0], b: [40, 0, 0] },
      { a: [0, 0, 0], b: [10, 30, 0] },
      { a: [0, 0, 0], b: [0, 0, 20] },
    ];
    const edges = lines.map((e) => pickTreatEdge(weld(part), e.a.map((v, i) => (v + e.b[i]) / 2), 0.5));
    const out = applyEdgeTreatment(part, { kind: 'fillet', size: r, edges }, meshBoolean);
    expect(analyzeMesh(out, weld(out)).warnings).toEqual([]);
    // The ball: r in from the floor (z = 0), the front (y = 0) and the slanted
    // side through the origin, whose outward normal is (−3, 1)/√10.
    const C = [(r * (1 + Math.sqrt(10))) / 3, r, r];
    const dirs = [[1, 0, 0], [1 / Math.sqrt(10), 3 / Math.sqrt(10), 0], [0, 0, 1]];
    // What is left in the corner — short of the centre along every edge — is
    // on or inside that ball.
    let worst = 0;
    let seen = 0;
    for (let i = 0; i < out.positions.length; i += 3) {
      const p = [out.positions[i], out.positions[i + 1], out.positions[i + 2]];
      const d = p.map((v, k) => v - C[k]);
      if (dirs.some((e) => d[0] * e[0] + d[1] * e[1] + d[2] * e[2] > -1e-6)) continue;
      seen++;
      worst = Math.max(worst, Math.hypot(...d) - r);
    }
    expect(seen).toBeGreaterThan(10);
    expect(worst).toBeLessThan(0.05);
  });

  it('finds and chamfers a rim on a tilted face', () => {
    const plate = box(-20, -20, 20, 20, 0, 10);
    const flat = meshBoolean(plate, extrudeRegion({ outer: circleLoop(5) }, { depth: 12, base: -1 }), 'cut');
    // The same plate turned 30° about X: the bore's axis is no longer Z.
    const t = Math.PI / 6;
    const tilted = { ...flat, positions: new Float32Array(flat.positions.length) };
    for (let i = 0; i < flat.positions.length; i += 3) {
      const [x, y, z] = [flat.positions[i], flat.positions[i + 1], flat.positions[i + 2]];
      tilted.positions[i] = x;
      tilted.positions[i + 1] = y * Math.cos(t) - z * Math.sin(t);
      tilted.positions[i + 2] = y * Math.sin(t) + z * Math.cos(t);
    }
    const onRim = [5, -10 * Math.sin(t), 10 * Math.cos(t)];
    const ref = pickTreatEdge(weld(tilted), onRim, 0.5);
    expect(ref.type).toBe('circle');
    expect(ref.axis).toBe(-1);
    expect(Math.abs(ref.n[2])).toBeCloseTo(Math.cos(t), 4);
    const out = applyEdgeTreatment(tilted, { kind: 'chamfer', size: 1, edges: [ref] }, meshBoolean);
    near(volume(tilted) - volume(out), 0.5 * 2 * Math.PI * (5 + 1 / 3), 0.2);
    expect(openEdgeCount(out)).toBe(0);
    expect(parseEdgeRef(JSON.parse(JSON.stringify(ref)))).toEqual(ref);
  });
});
