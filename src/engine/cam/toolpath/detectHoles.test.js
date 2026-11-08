import { describe, it, expect } from 'vitest';
import { detectHoles } from './mill.js';
import { weld } from '../../mesh/stl.js';
import { extrudeRegion } from '../../solid/extrude.js';
import { holeSolid } from '../../solid/hole.js';
import { meshBoolean } from '../../../lib/csg.js';

/**
 * Holes cut by the feature tree, read back the way the planner reads them. A
 * boolean leaves a hole's wall with its corners bunched in places; these are the
 * parts that went undrilled, or were drilled short, before that was allowed for.
 */
const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const plate = () => extrudeRegion({ outer: square(-30, -20, 30, 20) }, { depth: 20 });
const part = { top: 20, bottom: 0 };
const top = { preset: 'XY', offset: 20 };
const holesIn = (tool) => detectHoles(weld(meshBoolean(plate(), tool, 'cut')), part);

describe('detectHoles on a part the feature tree cut', () => {
  it('finds a Ø6 through hole where it was put', () => {
    const [h] = holesIn(holeSolid([[-15, -8]], top, { holeType: 'drill', diameter: 6 }, { depth: 21, through: true }));
    expect(h.x).toBeCloseTo(-15, 2);
    expect(h.y).toBeCloseTo(-8, 2);
    expect(h.diameter).toBeCloseTo(6, 1);
    expect(h.throughHole).toBe(true);
  });

  it('finds both of two through holes, each going through', () => {
    const holes = holesIn(holeSolid([[-15, -8], [15, -8]], top, { holeType: 'drill', diameter: 6 }, { depth: 21, through: true }));
    expect(holes).toHaveLength(2);
    expect(holes.every((h) => h.throughHole)).toBe(true);
  });

  it('reads a Ø20 hole cut by an extrude as going through, not stopping short', () => {
    const ring = Array.from({ length: 120 }, (_, i) => [10 * Math.cos((i * Math.PI) / 60), 10 * Math.sin((i * Math.PI) / 60)]).flat();
    const [h] = holesIn(extrudeRegion({ outer: ring }, { depth: 22, base: -1 }));
    expect(h.diameter).toBeCloseTo(20, 1);
    expect(h.throughHole).toBe(true);
  });

  it('still ends a blind hole at its bottom', () => {
    const [h] = holesIn(holeSolid([[-15, -8]], top, { holeType: 'drill', diameter: 10 }, { depth: 12 }));
    expect(h.throughHole).toBe(false);
    expect(h.depth).toBeGreaterThan(11);
    expect(h.depth).toBeLessThan(16);
  });
});
