import { describe, it, expect } from 'vitest';
import { planContext } from './plan.js';
import { attachCadHoles } from './toolpath/mill.js';
import { weld } from '../mesh/stl.js';
import { extrudeRegion } from '../solid/extrude.js';
import { holeSolid, holeRecords } from '../solid/hole.js';
import { meshBoolean } from '../../lib/csg.js';

const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const top = { preset: 'XY', offset: 20 };
const part = { top: 20, bottom: 0 };

function drilled(spec, positions, shape) {
  const soup = meshBoolean(
    extrudeRegion({ outer: square(-30, -20, 30, 20) }, { depth: 20 }),
    holeSolid(positions, top, spec, shape),
    'cut',
  );
  return { soup, welded: weld(soup), holes: holeRecords(positions, top, spec, shape) };
}

const tapped = { holeType: 'tap', thread: 'M8', threadDepth: 12 };

describe('holeRecords', () => {
  it('states the thread a mesh cannot', () => {
    const [h] = holeRecords([[5, 6]], top, tapped, { depth: 15 });
    expect(h.drill).toBe(6.8);
    expect(h.thread).toEqual({ name: 'M8', pitch: 1.25, depth: 12 });
    expect(h.at).toEqual([5, 6, 20]);
    expect(h.axis[2]).toBe(-1);
    expect(h.tip).toBeCloseTo(3.4 / Math.tan((59 * Math.PI) / 180), 6);
  });

  it('has no drill point on a through hole', () => {
    const [h] = holeRecords([[0, 0]], top, { holeType: 'drill', diameter: 6 }, { depth: 21, through: true });
    expect(h.tip).toBe(0);
  });
});

describe('attachCadHoles', () => {
  const mesh = {
    x: 5.01, y: 6, diameter: 6.6, depth: 14, throughHole: false,
  };

  it('replaces what the mesh measured', () => {
    const cad = holeRecords([[5, 6]], top, tapped, { depth: 15 });
    const [h] = attachCadHoles([mesh], cad, part);
    expect(h.x).toBe(5);
    expect(h.diameter).toBe(6.8);
    expect(h.depth).toBeCloseTo(15 + cad[0].tip, 6);
    expect(h.cad.thread.name).toBe('M8');
  });

  it('leaves a hole with no CAD record as measured', () => {
    const cad = holeRecords([[20, 6]], top, tapped, { depth: 15 });
    expect(attachCadHoles([mesh], cad, part)).toEqual([mesh]);
  });

  it('ignores a CAD hole drilled from the other side', () => {
    const cad = holeRecords([[5, 6]], top, tapped, { depth: 15, reverse: true });
    expect(attachCadHoles([mesh], cad, part)).toEqual([mesh]);
  });

  it('passes straight through when there is no CAD data', () => {
    const holes = [mesh];
    expect(attachCadHoles(holes, undefined, part)).toBe(holes);
  });
});

describe('planContext with CAD holes', () => {
  const shape = { depth: 15 };
  const made = () => drilled(tapped, [[10, 5]], shape);

  it('groups a tapped hole by its tap drill', () => {
    const { soup, welded, holes } = made();
    const ctx = planContext(soup, welded, { mode: 'mill', cad: { holes } });
    expect(ctx.holes).toHaveLength(1);
    expect(ctx.holes[0].cad.holeType).toBe('tap');
    expect(ctx.holeGroups[0].diameter).toBe(6.8);
  });

  it('finds the hole after the origin is moved', () => {
    const { soup, welded, holes } = made();
    const datum = { point: [10, 5, 20] };
    const ctx = planContext(soup, welded, { mode: 'mill', datum, cad: { holes } });
    expect(ctx.holes).toHaveLength(1);
    expect(ctx.holes[0].cad).toBeTruthy();
    expect(ctx.holes[0].x).toBeCloseTo(0, 3);
    expect(ctx.holes[0].y).toBeCloseTo(0, 3);
  });

  it('a counterbored hole is drilled at the hole, not the counterbore', () => {
    const spec = {
      holeType: 'cbore', diameter: 6.6, cbDiameter: 11, cbDepth: 6.5,
    };
    const { soup, welded, holes } = drilled(spec, [[0, 0]], { depth: 21, through: true });
    const ctx = planContext(soup, welded, { mode: 'mill', cad: { holes } });
    expect(ctx.holeGroups[0].diameter).toBe(6.6);
    expect(ctx.holes[0].throughHole).toBe(true);
    expect(ctx.holes[0].cad.counterbore.diameter).toBe(11);
  });

  it('a part with no CAD data plans as it always did', () => {
    const { soup, welded } = made();
    const ctx = planContext(soup, welded, { mode: 'mill' });
    expect(ctx.holes[0].cad).toBeUndefined();
  });
});
