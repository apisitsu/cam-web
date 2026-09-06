/**
 * Anything that makes a closed profile must make a CLOSED one.
 *
 * This is the general form of the offset bug: a command that builds or copies
 * several entities has to give the neighbours a *shared* endpoint, or the result
 * only looks like a profile. `loops.js` welds at 1e-6 — effectively nothing — so
 * a chain whose corners are separate points is not a region, and Build has
 * nothing to extrude. On screen it is invisible until you zoom into a corner,
 * which is exactly how the offset gap survived.
 *
 * So every command that can produce one is held to it here, together, rather
 * than each being trusted to have got it right on its own.
 */
import { describe, it, expect } from 'vitest';
import { createSketch, addPoint, addLine } from './model.js';
import { mirror, offsetChain } from './edit.js';
import { buildPolygon, buildSlot } from './shapes.js';
import { sketchLoops } from './loops.js';
import { dxfToSketch } from './dxfImport.js';

/** How many closed regions the sketch has, and how much is left dangling. */
const shape = (sk) => {
  const { loops, open } = sketchLoops(sk);
  return { loops: loops.length, open: open.length };
};

/** A closed square of side `s`, corners sharing one point each. */
function square(sk, s = 40) {
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, s, 0);
  const c = addPoint(sk, s, s);
  const d = addPoint(sk, 0, s);
  return [addLine(sk, a, b), addLine(sk, b, c), addLine(sk, c, d), addLine(sk, d, a)];
}

describe('a closed profile survives', () => {
  it('an offset — the bug this file was written for', () => {
    const sk = createSketch();
    const src = square(sk);
    offsetChain(sk, src, -5);
    expect(shape(sk)).toEqual({ loops: 2, open: 0 });
  });

  it('a mirror', () => {
    const sk = createSketch();
    const src = square(sk);
    // An axis clear of the square, so the image does not overlap it. Marked
    // construction, which is what a mirror axis is — otherwise the axis itself
    // is a dangling line and counts as an open chain.
    const axis = addLine(sk, addPoint(sk, 60, -10), addPoint(sk, 60, 50));
    sk.entities.get(axis).construction = true;
    expect(mirror(sk, src, axis)).not.toBeNull();
    expect(shape(sk)).toEqual({ loops: 2, open: 0 });
  });

  it('a polygon', () => {
    const sk = createSketch();
    buildPolygon(sk, 0, 0, 20, 0, 6);
    expect(shape(sk)).toEqual({ loops: 1, open: 0 });
  });

  it('a slot', () => {
    const sk = createSketch();
    buildSlot(sk, -20, 0, 20, 0, 6);
    expect(shape(sk)).toEqual({ loops: 1, open: 0 });
  });

  it('a DXF round trip', () => {
    // A closed square as four LINE entities, the way a CAD exports one — the
    // importer has to weld the shared ends back together.
    const seg = (x1, y1, x2, y2) => [
      '0', 'LINE', '8', '0',
      '10', String(x1), '20', String(y1),
      '11', String(x2), '21', String(y2),
    ].join('\n');
    const dxf = ['0', 'SECTION', '2', 'ENTITIES',
      seg(0, 0, 40, 0), seg(40, 0, 40, 40), seg(40, 40, 0, 40), seg(0, 40, 0, 0),
      '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const { sk } = dxfToSketch(dxf);
    expect(shape(sk)).toEqual({ loops: 1, open: 0 });
  });
});
