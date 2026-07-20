import { describe, it, expect } from 'vitest';
import {
  detectPlanarFaces, detectSharpEdges, detectFeatures, faceOfTriangle,
  faceLoops, polylineLength, describeFace, describeEdge,
} from './features.js';
import { weld } from './stl.js';
import { box, cylinder } from './fixtures.js';

const meshOf = (soup) => weld(soup);

describe('detectPlanarFaces', () => {
  const { faces, triangleFace } = detectPlanarFaces(meshOf(box(60, 40, 20)));

  it('recovers a box as exactly six faces', () => {
    // The whole point of the module: 12 triangles, 6 faces. If this ever
    // returns 12, coplanar merging has stopped working.
    expect(faces).toHaveLength(6);
  });

  it('gets each face’s area right', () => {
    const areas = faces.map((f) => f.area).sort((a, b) => b - a);
    // 60×40 top and bottom, 60×20 front and back, 40×20 ends.
    expect(areas).toEqual([2400, 2400, 1200, 1200, 800, 800]);
  });

  it('names which way each face points', () => {
    const facings = faces.map((f) => f.facing).sort();
    expect(facings).toEqual(['back', 'down', 'front', 'left', 'right', 'up'].sort());
  });

  it('puts the biggest face first, because that is the one people mean', () => {
    for (let i = 1; i < faces.length; i++) {
      expect(faces[i - 1].area).toBeGreaterThanOrEqual(faces[i].area);
    }
  });

  it('gives every face a stable id matching its position', () => {
    faces.forEach((f, i) => {
      expect(f.id).toBe(`F${i}`);
      expect(f.index).toBe(i);
    });
  });

  it('maps every triangle back to the face it belongs to', () => {
    expect(triangleFace).toHaveLength(12);
    for (const i of triangleFace) expect(i).toBeGreaterThanOrEqual(0);
    // Two triangles per face on a box.
    const counts = new Map();
    for (const i of triangleFace) counts.set(i, (counts.get(i) ?? 0) + 1);
    expect([...counts.values()]).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it('puts the centroid of the top face on the top', () => {
    const top = faces.find((f) => f.facing === 'up');
    expect(top.centroid[2]).toBeCloseTo(10, 4);
    expect(top.normal[2]).toBeCloseTo(1, 6);
  });

  it('does not weld a curved wall into one flat face', () => {
    // A tessellated cylinder's side is not planar, and calling it planar would
    // machine a round part square.
    const round = detectPlanarFaces(meshOf(cylinder(15, 40, 48)));
    const up = round.faces.filter((f) => f.facing === 'up');
    expect(up).toHaveLength(1);                     // the flat top, merged
    expect(up[0].area).toBeGreaterThan(600);        // ~pi r^2 = 707
    // ...and the wall did not become one face.
    expect(round.faces.some((f) => f.facing === 'side' && f.area > 500)).toBe(false);
  });

  it('drops slivers below the minimum area', () => {
    const all = detectPlanarFaces(meshOf(box(60, 40, 20)), { minArea: 0 });
    const big = detectPlanarFaces(meshOf(box(60, 40, 20)), { minArea: 1000 });
    expect(big.faces.length).toBeLessThan(all.faces.length);
    expect(big.faces.every((f) => f.area >= 1000)).toBe(true);
  });

  it('keeps a shallow taper distinct from a flat floor', () => {
    // Two triangles 2 degrees apart must not merge — a draft angle machined
    // square is scrap, and 2 degrees is a common draft.
    const mesh = {
      positions: new Float32Array([
        0, 0, 0, 10, 0, 0, 10, 10, 0,
        0, 0, 0, 10, 10, 0, 0, 10, 0.35,
      ]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    };
    expect(detectPlanarFaces(mesh, { minArea: 0 }).faces.length).toBe(2);
  });
});

describe('faceLoops', () => {
  it('returns the outline of a face as a closed loop', () => {
    const mesh = meshOf(box(60, 40, 20));
    const { faces } = detectPlanarFaces(mesh);
    const top = faces.find((f) => f.facing === 'up');
    expect(top.loops).toHaveLength(1);
    // A rectangle: four corners, all at the top.
    expect(top.loops[0]).toHaveLength(4);
    for (const p of top.loops[0]) expect(p[2]).toBeCloseTo(10, 5);
  });

  it('returns an outer and an inner loop for a face with a hole', () => {
    // A square annulus: outer ring of 4, inner ring of 4, tessellated between.
    const outer = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    const inner = [[-4, -4], [4, -4], [4, 4], [-4, 4]];
    const pts = [...outer, ...inner].map(([x, y]) => [x, y, 0]);
    const positions = new Float32Array(pts.flat());
    const idx = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      idx.push(i, j, 4 + i, j, 4 + j, 4 + i);
    }
    const mesh = { positions, indices: new Uint32Array(idx) };
    const loops = faceLoops(mesh, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(loops).toHaveLength(2);
    expect(loops[0]).toHaveLength(4);
    expect(loops[1]).toHaveLength(4);
  });
});

describe('detectSharpEdges', () => {
  it('finds the twelve edges of a box', () => {
    const edges = detectSharpEdges(meshOf(box(60, 40, 20)));
    // The box's corners chain into closed rings rather than 12 loose segments,
    // which is what an operator wants to trace anyway.
    expect(edges.length).toBeGreaterThan(0);
    const total = edges.reduce((s, e) => s + e.length, 0);
    // 4×60 + 4×40 + 4×20 = 480 mm of edge, however it gets chained.
    expect(total).toBeCloseTo(480, 1);
  });

  it('ignores tessellation seams on a curved wall', () => {
    // A 48-sided cylinder has 7.5 degrees between facets. At the default 30
    // degree threshold none of those is an edge — only the two rims are.
    const edges = detectSharpEdges(meshOf(cylinder(15, 40, 48)));
    const circumference = 2 * Math.PI * 15;
    for (const e of edges) {
      expect(e.length).toBeLessThan(circumference * 1.1);
    }
    // The rims are there, and they are closed.
    const rims = edges.filter((e) => e.length > circumference * 0.9);
    expect(rims.length).toBeGreaterThanOrEqual(2);
    expect(rims.every((e) => e.closed)).toBe(true);
  });

  it('finds every facet when told to be sensitive', () => {
    const coarse = detectSharpEdges(meshOf(cylinder(15, 40, 48)), { angleTol: 30 });
    const fine = detectSharpEdges(meshOf(cylinder(15, 40, 48)), { angleTol: 1 });
    expect(fine.length).toBeGreaterThan(coarse.length);
  });

  it('drops edges shorter than the minimum', () => {
    const edges = detectSharpEdges(meshOf(box(60, 40, 20)), { minLength: 1000 });
    expect(edges).toHaveLength(0);
  });

  it('sorts longest first and gives every chain an id', () => {
    const edges = detectSharpEdges(meshOf(box(60, 40, 20)));
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i - 1].length).toBeGreaterThanOrEqual(edges[i].length);
    }
    edges.forEach((e, i) => expect(e.id).toBe(`E${i}`));
  });
});

describe('faceOfTriangle', () => {
  it('maps a picked triangle to its whole face', () => {
    // This is what a click in the viewport turns into: the raycast gives a
    // triangle, and the operator meant the face it is part of.
    const features = detectFeatures(meshOf(box(60, 40, 20)));
    const face = faceOfTriangle(features, 0);
    expect(face).toBeTruthy();
    expect(face.triangles).toContain(0);
    expect(face.triangles.length).toBe(2);
  });

  it('returns null for nothing picked', () => {
    const features = detectFeatures(meshOf(box(60, 40, 20)));
    expect(faceOfTriangle(features, null)).toBeNull();
    expect(faceOfTriangle(features, -1)).toBeNull();
    expect(faceOfTriangle(features, 9999)).toBeNull();
  });
});

describe('labels', () => {
  it('describes a face in terms an operator uses', () => {
    const { faces } = detectPlanarFaces(meshOf(box(60, 40, 20)));
    const top = faces.find((f) => f.facing === 'up');
    expect(describeFace(top)).toMatch(/^up face · 60.0 × 40.0 mm · 2400 mm²$/);
  });

  it('describes an edge by length and whether it closes', () => {
    const edges = detectSharpEdges(meshOf(cylinder(15, 40, 48)));
    expect(describeEdge(edges[0])).toMatch(/closed edge · \d+\.\d mm · \d+ points/);
  });
});

describe('polylineLength', () => {
  it('sums the segments', () => {
    expect(polylineLength([[0, 0, 0], [3, 4, 0], [3, 4, 12]])).toBeCloseTo(17, 6);
  });

  it('is zero for a single point', () => {
    expect(polylineLength([[1, 2, 3]])).toBe(0);
  });
});
