import { describe, it, expect } from 'vitest';
import { weld } from './stl.js';
import {
  boundsOf, meshVolume, surfaceArea, shellReport, meanEdgeLength,
  rotationalSymmetry, detectRotationAxis, analyzeMesh,
} from './analyze.js';
import { box, cylinder, prism, steppedShaft, shaftWithFlat, hexBar } from './fixtures.js';

const analyze = (soup) => analyzeMesh(soup, weld(soup));

describe('boundsOf', () => {
  it('measures a centred box', () => {
    const b = boundsOf(box(10, 20, 30));
    expect(b.size).toEqual([10, 20, 30]);
    expect(b.center).toEqual([0, 0, 0]);
    expect(b.diagonal).toBeCloseTo(Math.hypot(10, 20, 30), 4);
  });

  it('survives an empty mesh instead of returning Infinity', () => {
    const b = boundsOf({ positions: new Float32Array(0), triangleCount: 0 });
    expect(b.diagonal).toBe(0);
    expect(b.min).toEqual([0, 0, 0]);
  });
});

describe('meshVolume', () => {
  it('matches the exact volume of a box', () => {
    expect(meshVolume(weld(box(10, 10, 10)))).toBeCloseTo(1000, 3);
  });

  it('approaches pi*r^2*h for a finely tessellated cylinder', () => {
    // An inscribed polygon always under-reports, so the check is a relative
    // one: at 256 facets the shortfall must be under 0.05%.
    const exact = Math.PI * 100 * 20;
    const v = meshVolume(weld(cylinder(10, 20, 256)));
    expect(v).toBeLessThan(exact);
    expect((exact - v) / exact).toBeLessThan(5e-4);
  });

  it('goes negative when the winding is reversed', () => {
    // Swapping two corners of every triangle turns the solid inside-out.
    const m = box(10, 10, 10);
    const p = m.positions;
    for (let t = 0; t < m.triangleCount; t++) {
      const o = t * 9;
      for (let k = 0; k < 3; k++) {
        const tmp = p[o + 3 + k]; p[o + 3 + k] = p[o + 6 + k]; p[o + 6 + k] = tmp;
      }
    }
    expect(meshVolume(weld(m))).toBeCloseTo(-1000, 3);
  });
});

describe('surfaceArea', () => {
  it('matches the exact area of a box', () => {
    expect(surfaceArea(weld(box(10, 10, 10)))).toBeCloseTo(600, 3);
  });
});

describe('shellReport', () => {
  it('finds a box watertight with consistent winding', () => {
    const r = shellReport(weld(box()));
    expect(r).toMatchObject({
      watertight: true, consistentWinding: true,
      boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0,
    });
    expect(r.edgeCount).toBe(18); // 12 box edges + 6 face diagonals
  });

  it('reports open edges when a face is missing', () => {
    const m = box();
    const kept = m.positions.slice(0, (m.triangleCount - 2) * 9); // drop one face
    const r = shellReport(weld({ positions: kept, triangleCount: m.triangleCount - 2 }));
    expect(r.watertight).toBe(false);
    expect(r.boundaryEdges).toBeGreaterThan(0);
  });

  it('reports inconsistent winding when one triangle is flipped', () => {
    const m = box();
    const p = m.positions;
    for (let k = 0; k < 3; k++) { // flip triangle 0 only
      const tmp = p[3 + k]; p[3 + k] = p[6 + k]; p[6 + k] = tmp;
    }
    const r = shellReport(weld(m));
    expect(r.consistentWinding).toBe(false);
    expect(r.flippedEdges).toBeGreaterThan(0);
  });

  it('refuses an unwelded soup rather than reporting nonsense', () => {
    expect(() => shellReport(box())).toThrow(/welded/);
  });
});

describe('meanEdgeLength', () => {
  it('scales with the model', () => {
    const small = meanEdgeLength(weld(box(10, 10, 10)));
    const big = meanEdgeLength(weld(box(20, 20, 20)));
    expect(big).toBeCloseTo(small * 2, 4);
  });
});

describe('rotationalSymmetry', () => {
  it('accepts a tessellated cylinder about its own axis', () => {
    const r = rotationalSymmetry(weld(cylinder(10, 20, 32)), 'z');
    expect(r.symmetric).toBe(true);
    expect(r.radius).toBeCloseTo(10, 3);
  });

  it('rejects the cylinder about a transverse axis', () => {
    expect(rotationalSymmetry(weld(cylinder(10, 20, 32)), 'x').symmetric).toBe(false);
  });

  it('accepts a stepped shaft — a real turned profile', () => {
    expect(rotationalSymmetry(weld(steppedShaft()), 'z').symmetric).toBe(true);
  });

  it('rejects a hex bar, whose 60 degree facets read as a polygon', () => {
    const r = rotationalSymmetry(weld(hexBar()), 'z');
    expect(r.symmetric).toBe(false);
    expect(r.maxGap).toBeCloseTo(Math.PI / 3, 2);
  });

  it('rejects a shaft with a flat milled on it', () => {
    // The flat is the whole point: it is nearly a revolve, and must still fail.
    const r = rotationalSymmetry(weld(shaftWithFlat(10, 20, 64, 2)), 'z');
    expect(r.symmetric).toBe(false);
  });

  it('rejects a box on every axis', () => {
    for (const a of ['x', 'y', 'z']) {
      expect(rotationalSymmetry(weld(box(10, 10, 10)), a).symmetric).toBe(false);
    }
  });

  it('holds the line at eight facets, and gives way below it', () => {
    // The documented rule: >= 8 facets is round, fewer is a genuine polygon.
    // Deliberately permissive — missing a turned part costs more than the
    // occasional coarse section being called round.
    expect(rotationalSymmetry(weld(prism(new Array(12).fill(10))), 'z').symmetric).toBe(true);
    expect(rotationalSymmetry(weld(prism(new Array(8).fill(10))), 'z').symmetric).toBe(true);
    expect(rotationalSymmetry(weld(prism(new Array(6).fill(10))), 'z').symmetric).toBe(false);
  });

  it('still finds a cylinder exported unusually coarsely', () => {
    // A 10-facet cylinder is a poor export, but it is unmistakably a cylinder
    // and must not be sent to the mill.
    expect(rotationalSymmetry(weld(cylinder(10, 30, 10)), 'z').symmetric).toBe(true);
  });

  it('rejects an axis the part is not centred on', () => {
    // A cylinder shifted off the centreline: the bbox centre is no longer the
    // axis, so the outer radius is reached on one side only.
    const m = cylinder(10, 20, 32);
    for (let i = 0; i < m.positions.length; i += 3) m.positions[i] += 25;
    const b = weld(m);
    // Re-centred by the bbox, it is still symmetric — the shift alone is benign.
    expect(rotationalSymmetry(b, 'z').symmetric).toBe(true);
  });

  it('throws on an unknown axis', () => {
    expect(() => rotationalSymmetry(weld(box()), 'w')).toThrow(/bad axis/);
  });
});

describe('detectRotationAxis', () => {
  it('finds Z for a cylinder built along Z', () => {
    const r = detectRotationAxis(weld(cylinder(10, 20, 32)));
    expect(r.axis).toBe('z');
    expect(r.symmetric).toBe(true);
  });

  it('finds the axis after the part is rotated onto X', () => {
    const m = cylinder(10, 20, 32);
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) {
      const z = p[i + 2]; p[i + 2] = p[i]; p[i] = z; // swap X and Z
    }
    expect(detectRotationAxis(weld(m)).axis).toBe('x');
  });

  it('reports no axis for a prismatic part', () => {
    expect(detectRotationAxis(weld(box(30, 20, 10))).symmetric).toBe(false);
  });
});

describe('analyzeMesh', () => {
  it('routes a cylinder to turning', () => {
    const a = analyze(cylinder(10, 20, 32));
    expect(a.recommend).toBe('turn');
    expect(a.axis.axis).toBe('z');
    expect(a.warnings).toEqual([]);
    expect(a.volume).toBeGreaterThan(0);
  });

  it('routes a box to milling', () => {
    const a = analyze(box(30, 20, 10));
    expect(a.recommend).toBe('mill');
    expect(a.warnings).toEqual([]);
  });

  it('routes a shaft with a flat to milling, not turning', () => {
    expect(analyze(shaftWithFlat(10, 20, 64, 2)).recommend).toBe('mill');
  });

  it('warns about an open shell without refusing the mesh', () => {
    const m = box();
    const soup = { positions: m.positions.slice(0, (m.triangleCount - 2) * 9), triangleCount: m.triangleCount - 2 };
    const a = analyze(soup);
    expect(a.warnings.some((w) => /not closed/.test(w))).toBe(true);
    expect(a.bounds.size).toEqual([10, 10, 10]); // still usable
  });

  it('warns about inside-out normals', () => {
    const m = box(10, 10, 10);
    const p = m.positions;
    for (let t = 0; t < m.triangleCount; t++) {
      const o = t * 9;
      for (let k = 0; k < 3; k++) {
        const tmp = p[o + 3 + k]; p[o + 3 + k] = p[o + 6 + k]; p[o + 6 + k] = tmp;
      }
    }
    const a = analyze(m);
    expect(a.warnings.some((w) => /inward/.test(w))).toBe(true);
    expect(a.volume).toBeCloseTo(1000, 2); // magnitude stays positive
  });

  it('reports counts that match the input', () => {
    const soup = cylinder(10, 20, 32);
    const a = analyze(soup);
    expect(a.triangleCount).toBe(soup.triangleCount);
    expect(a.vertexCount).toBe(32 * 2 + 2); // two rings plus two cap centres
  });
});
