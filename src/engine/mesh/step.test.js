import { describe, it, expect } from 'vitest';
import { meshToStep, meshToStlBinary, stepReal } from './step.js';
import { box, tube, revolveOutline } from './fixtures.js';
import { weld, parseSTL } from './stl.js';

/** The DATA section as `id → { type, body }`. */
function entities(text) {
  const out = new Map();
  const data = text.slice(text.indexOf('DATA;') + 5, text.lastIndexOf('ENDSEC;'));
  for (const m of data.matchAll(/#(\d+)=(\(?[A-Z_0-9]+)\((.*?)\);\s*$/gm)) {
    out.set(Number(m[1]), { type: m[2].replace('(', ''), body: m[3] });
  }
  return out;
}

const count = (ents, type) => [...ents.values()].filter((e) => e.type === type).length;

/** Every edge used by exactly two oriented edges, once each way: a closed shell. */
function closedShell(ents) {
  const uses = new Map();
  for (const e of ents.values()) {
    if (e.type !== 'ORIENTED_EDGE') continue;
    const [, id, sense] = e.body.match(/#(\d+),\.(T|F)\.$/);
    if (!uses.has(id)) uses.set(id, []);
    uses.get(id).push(sense);
  }
  return [...uses.values()].every((s) => s.length === 2 && s[0] !== s[1]);
}

describe('STEP export', () => {
  it('writes a box as six faces, twelve edges and eight vertices of one solid', () => {
    const text = meshToStep(weld(box(30, 20, 10)), { name: 'block', date: new Date(0) });
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text.trim().endsWith('END-ISO-10303-21;')).toBe(true);
    const ents = entities(text);
    expect(count(ents, 'ADVANCED_FACE')).toBe(6);
    expect(count(ents, 'EDGE_CURVE')).toBe(12);
    expect(count(ents, 'VERTEX_POINT')).toBe(8);
    expect(count(ents, 'MANIFOLD_SOLID_BREP')).toBe(1);
    expect(closedShell(ents)).toBe(true);
    // Every reference points at an entity that is there.
    for (const e of ents.values()) {
      for (const m of e.body.matchAll(/#(\d+)/g)) expect(ents.has(Number(m[1]))).toBe(true);
    }
  });

  it('keeps the hole of a tube: faces with an inner bound, Euler count of a ring', () => {
    const ents = entities(meshToStep(weld(tube(20, 10, 30, 32))));
    expect(closedShell(ents)).toBe(true);
    const F = count(ents, 'ADVANCED_FACE');
    const E = count(ents, 'EDGE_CURVE');
    const V = count(ents, 'VERTEX_POINT');
    const L = count(ents, 'FACE_OUTER_BOUND') + count(ents, 'FACE_BOUND');
    expect(count(ents, 'FACE_BOUND')).toBe(2); // the two end rings
    expect(V - E + F - (L - F)).toBe(0); // genus 1
  });

  it('writes round walls as true cylinders bounded by circles, and falls back flat on request', () => {
    const mesh = weld(tube(20, 10, 30, 64));
    const text = meshToStep(mesh);
    const ents = entities(text);
    expect(closedShell(ents)).toBe(true);
    // Inside and outside, each in its two half turns.
    expect(count(ents, 'CYLINDRICAL_SURFACE')).toBe(4);
    expect(count(ents, 'CIRCLE')).toBe(8);
    expect(count(ents, 'ADVANCED_FACE')).toBe(6);
    const radii = [...ents.values()].filter((e) => e.type === 'CYLINDRICAL_SURFACE').map((e) => Number(e.body.split(',').pop()));
    expect(new Set(radii.map((r) => Math.round(r))).size).toBe(2);
    const flat = entities(meshToStep(mesh, { cylinders: false }));
    expect(count(flat, 'CYLINDRICAL_SURFACE')).toBe(0);
    expect(count(flat, 'ADVANCED_FACE')).toBe(130);
  });

  it('writes a tapered wall as a cone, its narrow end the placement', () => {
    const frustum = revolveOutline([{ z: 0, r: 0 }, { z: 0, r: 10 }, { z: 20, r: 5 }, { z: 20, r: 0 }], 64);
    const ents = entities(meshToStep(weld(frustum)));
    expect(closedShell(ents)).toBe(true);
    const cones = [...ents.values()].filter((e) => e.type === 'CONICAL_SURFACE');
    expect(cones).toHaveLength(2);
    const [r, semi] = cones[0].body.split(',').slice(-2).map(Number);
    expect(r).toBeCloseTo(5, 3);
    expect(semi).toBeCloseTo(Math.atan(5 / 20), 4);
  });

  it('writes a filleted rim as two halves of a true torus, from what the fillet recorded', async () => {
    const { meshBoolean, loadMeshBoolean } = await import('../../lib/csg.js');
    const { applyEdgeTreatment } = await import('../solid/edgeTreat.js');
    const { revolveRegion } = await import('../solid/extrude.js');
    await loadMeshBoolean();
    const boss = revolveRegion({ outer: [0, 0, 8, 0, 8, 10, 0, 10] }, { axis: 'y', segments: 64 });
    const out = applyEdgeTreatment(boss, {
      kind: 'fillet', size: 2, edges: [{ type: 'circle', axis: 1, center: [0, 10, 0], radius: 8 }],
    }, meshBoolean);
    expect(out.surfaces).toHaveLength(1);
    expect(out.surfaces[0].kind).toBe('torus');
    expect(out.surfaces[0].R).toBeCloseTo(6, 6);
    expect(out.surfaces[0].r).toBe(2);
    const ents = entities(meshToStep(weld(out), { surfaces: out.surfaces }));
    expect(closedShell(ents)).toBe(true);
    expect(count(ents, 'TOROIDAL_SURFACE')).toBe(2);
    expect(count(ents, 'CYLINDRICAL_SURFACE')).toBe(2);
    expect(count(ents, 'ADVANCED_FACE')).toBe(6);
    // Without what the fillet recorded it is written flat, still closed.
    expect(closedShell(entities(meshToStep(weld(out))))).toBe(true);
  }, 60000);

  it('writes reals the way STEP reads them', () => {
    expect(stepReal(0)).toBe('0.');
    expect(stepReal(12)).toBe('12.');
    expect(stepReal(-1.5)).toBe('-1.5');
    expect(stepReal(1e-7)).toBe('1.E-7');
    expect(stepReal(2.5e21)).toBe('2.5E21');
  });

  it('writes an open mesh as surfaces, not a solid', () => {
    const soup = box(10, 10, 10);
    const open = { positions: soup.positions.slice(0, -9), triangleCount: soup.triangleCount - 1 };
    const ents = entities(meshToStep(weld(open)));
    expect(count(ents, 'MANIFOLD_SOLID_BREP')).toBe(0);
    expect(count(ents, 'SHELL_BASED_SURFACE_MODEL')).toBe(1);
  });
});

describe('STL export', () => {
  it('round-trips through the STL reader', () => {
    const mesh = weld(box(30, 20, 10));
    const back = parseSTL(meshToStlBinary(mesh));
    expect(back.triangleCount).toBe(mesh.triangleCount);
  });
});
