import { describe, it, expect } from 'vitest';
import { meshBoolean, MESH_OPS } from './csg.js';
import { openEdgeCount } from '../engine/mesh/repair.js';
import { extrudeRegion, revolveRegion } from '../engine/solid/extrude.js';
import { volume } from '../engine/solid/solidAssert.js';

/**
 * Add and cut grow the new solid by `GROW` (a micron) so a surface it shares with
 * the part is not kept twice. Volumes land within a fraction of a mm³ of exact.
 */
const nearVolume = (v, want) => expect(Math.abs(v - want)).toBeLessThan(1);

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
    nearVolume(volume(out), 4000 - 10 * 10 * 10);
    expect(out.format).toBe('cut');
  });

  it('cuts a blind pocket, not only a through one', () => {
    const part = box(0, 0, 20, 20, 0, 10);
    const tool = box(5, 5, 15, 15, 6, 11); // 4 mm deep from the top
    const out = meshBoolean(part, tool, 'cut');
    nearVolume(volume(out), 4000 - 10 * 10 * 4);
  });

  it('adds two overlapping boxes without counting the overlap twice', () => {
    const a = box(0, 0, 20, 20, 0, 10); // 4000
    const b = box(10, 0, 30, 20, 0, 10); // 4000, overlapping 10×20×10 = 2000
    const out = meshBoolean(a, b, 'add');
    nearVolume(volume(out), 4000 + 4000 - 2000);
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

describe('meshBoolean — a cut whose surface lies on the part’s', () => {
  /** Directed edges with no partner running the other way. */
  function openEdges(soup) {
    const p = soup.positions;
    const key = (i) => `${p[i]},${p[i + 1]},${p[i + 2]}`;
    const edges = new Map();
    for (let t = 0; t < soup.triangleCount; t++) {
      for (let k = 0; k < 3; k++) {
        const e = `${key(t * 9 + k * 3)}|${key(t * 9 + ((k + 1) % 3) * 3)}`;
        edges.set(e, (edges.get(e) || 0) + 1);
      }
    }
    let n = 0;
    for (const [e, c] of edges) {
      const [a, b] = e.split('|');
      if ((edges.get(`${b}|${a}`) || 0) !== c) n++;
    }
    return n;
  }

  it('cuts a groove drawn out to the bar’s own radius into a closed solid', () => {
    // The way a groove is drawn: from the bar's surface inwards. The groove's
    // outside lies exactly on the bar's, which the evaluator left as streaks of
    // doubled, opposite-facing surface and open edges.
    const bar = revolveRegion({ outer: square(0, 0, 60, 20) }, { axis: 'x' });
    const groove = revolveRegion({ outer: square(25, 15, 35, 20) }, { axis: 'x' });
    const out = meshBoolean(bar, groove, 'cut');
    expect(openEdges(out)).toBe(0);
    nearVolume(volume(out), volume(bar) - volume(groove));
  });

  it('cuts a pocket from a sketch on the top face into a closed solid', () => {
    const part = box(0, 0, 40, 40, 0, 20);
    const pocket = box(10, 10, 30, 30, 10, 20); // its top is the part's top
    const out = meshBoolean(part, pocket, 'cut');
    expect(openEdges(out)).toBe(0);
    nearVolume(volume(out), 40 * 40 * 20 - 20 * 20 * 10);
  });
});

describe('meshBoolean — a part of a turn, and a drilled hole', () => {
  it('cuts a half-turn step from a bar into a closed solid of the right volume', () => {
    // The cut's end faces lie on a plane through the axis, where the bar has corners.
    // Uncut as drawn, some 58 mm³ that should go is kept; repaired at every edge,
    // and not only the open ones, it was left with over a hundred open edges.
    const bar = revolveRegion({ outer: square(0, 0, 60, 20) }, { axis: 'x' });
    const step = revolveRegion({ outer: square(50, 12, 60, 20) }, { axis: 'x', angle: Math.PI });
    const out = meshBoolean(bar, step, 'cut');
    nearVolume(volume(out), volume(bar) - volume(step));
    expect(openEdgeCount(out)).toBe(0);
  });

  it('repairs a hole without splitting the plate round it into thousands of slivers', () => {
    // The fan of long thin triangles a boolean leaves round a hole once read as
    // T-junctions everywhere: ~37 000 triangles and the hole's volume bent by 1%.
    const plate = box(0, 0, 40, 40, 0, 10);
    const r = 3;
    const ring = Array.from({ length: 120 }, (_, i) => {
      const a = (i / 120) * 2 * Math.PI;
      return [20 + r * Math.cos(a), 20 + r * Math.sin(a)];
    }).flat();
    const hole = extrudeRegion({ outer: ring }, { depth: 12, base: -1 });
    const out = meshBoolean(plate, hole, 'cut');
    nearVolume(volume(out), 16000 - volume(hole) * (10 / 12));
    expect(out.triangleCount).toBeLessThan(5000);
  });

  it('counts the open edges of a surface', () => {
    const quad = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]), triangleCount: 2 };
    expect(openEdgeCount(quad)).toBe(4); // the rim; the shared diagonal is matched
    expect(openEdgeCount(box(0, 0, 1, 1, 0, 1))).toBe(0);
  });
});
