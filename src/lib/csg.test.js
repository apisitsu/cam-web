import { describe, it, expect } from 'vitest';
import { meshBoolean, MESH_OPS } from './csg.js';
import { extrudeRegion } from '../engine/solid/extrude.js';
import { volume } from '../engine/solid/solidAssert.js';

const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];

/** A box as a triangle soup, built by the same extruder the app uses. */
const box = (x0, y0, x1, y1, z0, z1) => extrudeRegion(
  { outer: square(x0, y0, x1, y1) },
  { depth: z1 - z0, base: z0 },
);


describe('meshBoolean', () => {
  it('cuts one box out of another, leaving the right volume', () => {
    const part = box(0, 0, 20, 20, 0, 10); // 4000
    const tool = box(5, 5, 15, 15, -1, 11); // a through pocket, 10×10
    const out = meshBoolean(part, tool, 'cut');
    expect(volume(out)).toBeCloseTo(4000 - 10 * 10 * 10, 1);
    expect(out.format).toBe('cut');
  });

  it('cuts a blind pocket, not only a through one', () => {
    const part = box(0, 0, 20, 20, 0, 10);
    const tool = box(5, 5, 15, 15, 6, 11); // 4 mm deep from the top
    const out = meshBoolean(part, tool, 'cut');
    expect(volume(out)).toBeCloseTo(4000 - 10 * 10 * 4, 1);
  });

  it('adds two overlapping boxes without counting the overlap twice', () => {
    const a = box(0, 0, 20, 20, 0, 10); // 4000
    const b = box(10, 0, 30, 20, 0, 10); // 4000, overlapping 10×20×10 = 2000
    const out = meshBoolean(a, b, 'add');
    expect(volume(out)).toBeCloseTo(4000 + 4000 - 2000, 1);
  });

  it('keeps only the overlap for common', () => {
    const a = box(0, 0, 20, 20, 0, 10);
    const b = box(10, 0, 30, 20, 0, 10);
    const out = meshBoolean(a, b, 'common');
    expect(volume(out)).toBeCloseTo(2000, 1);
  });

  it('returns the soup shape the CAM pipeline reads', () => {
    const out = meshBoolean(box(0, 0, 20, 20, 0, 10), box(5, 5, 15, 15, -1, 11), 'cut');
    expect(out.positions).toBeInstanceOf(Float32Array);
    expect(out.positions.length).toBe(out.triangleCount * 9);
  });

  it('says so rather than returning an empty part', () => {
    const a = box(0, 0, 10, 10, 0, 5);
    const b = box(50, 50, 60, 60, 0, 5); // nowhere near it
    expect(() => meshBoolean(a, b, 'common')).toThrow(/Nothing is left after common/i);
  });

  it('refuses an unknown operation and a missing operand', () => {
    const a = box(0, 0, 10, 10, 0, 5);
    expect(() => meshBoolean(a, a, 'squish')).toThrow(/unknown mesh boolean/i);
    expect(() => meshBoolean(null, a, 'cut')).toThrow(/no part loaded/i);
    expect(() => meshBoolean(a, null, 'cut')).toThrow(/empty/i);
  });

  it('names every operation it offers', () => {
    expect(Object.keys(MESH_OPS).sort()).toEqual(['add', 'common', 'cut']);
  });
});
