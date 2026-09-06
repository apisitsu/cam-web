/**
 * Offsetting a closed profile must give back a closed profile.
 *
 * The reported symptom: offset a square and the result is four parallel lines
 * with a gap at every corner. That is what offsetting each entity on its own
 * gives you — a line moved along its own normal ends where it ends, and a corner
 * needs the two neighbours *extended* (outward) or *trimmed* (inward) to where
 * they now cross.
 *
 * It is not only cosmetic. The sketcher's whole downstream depends on closed
 * loops: `loops.js` finds a region by walking shared endpoints, and Build
 * extrudes what it finds. Four disconnected segments are not a region, so an
 * offset profile could be drawn and then not built.
 */
import { describe, it, expect } from 'vitest';
import { createSketch, addPoint, addLine, addArc } from './model.js';
import { offsetChain } from './edit.js';
import { sketchLoops } from './loops.js';

/** A closed square of side `s`, corners sharing one point each. */
function square(sk, s = 90) {
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, s, 0);
  const c = addPoint(sk, s, s);
  const d = addPoint(sk, 0, s);
  return [addLine(sk, a, b), addLine(sk, b, c), addLine(sk, c, d), addLine(sk, d, a)];
}

const P = (sk, id) => sk.entities.get(id);
const ends = (sk, lineId) => {
  const e = P(sk, lineId);
  return [P(sk, e.p1), P(sk, e.p2)];
};

/** Largest gap between the end of one offset entity and the start of the next. */
function worstGap(sk, ids) {
  let worst = 0;
  for (let i = 0; i < ids.length; i++) {
    const [, b] = ends(sk, ids[i]);
    const [c] = ends(sk, ids[(i + 1) % ids.length]);
    worst = Math.max(worst, Math.hypot(b.x - c.x, b.y - c.y));
  }
  return worst;
}

describe('offsetChain on a closed square', () => {
  it('closes the corners going outward', () => {
    const sk = createSketch();
    const src = square(sk, 90);
    const out = offsetChain(sk, src, 10);
    expect(out).toHaveLength(4);
    expect(worstGap(sk, out)).toBeLessThan(1e-6);
  });

  it('closes the corners going inward', () => {
    const sk = createSketch();
    const src = square(sk, 90);
    const out = offsetChain(sk, src, -10);
    expect(out).toHaveLength(4);
    expect(worstGap(sk, out)).toBeLessThan(1e-6);
  });

  it('gives the outward offset the right size — 90 becomes 110 at 10 out', () => {
    const sk = createSketch();
    const src = square(sk, 90);
    // The originals run counter-clockwise, so the LEFT normal points inward:
    // a positive distance shrinks it and a negative one grows it. Whichever way
    // round, the two sides must differ by twice the distance.
    const out = offsetChain(sk, src, -10);
    const xs = out.flatMap((id) => ends(sk, id).map((p) => p.x));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(110, 6);
  });

  it('is a region the rest of the sketcher can use', () => {
    // The point of closing it: `loops.js` walks shared endpoints, and Build
    // extrudes what it finds. Four loose segments are not a region — they come
    // back in `open`, the chains that never closed.
    const sk = createSketch();
    const src = square(sk, 90);
    expect(sketchLoops(sk).loops).toHaveLength(1);
    offsetChain(sk, src, -10);
    const after = sketchLoops(sk);
    expect(after.loops).toHaveLength(2);
    expect(after.open).toHaveLength(0);
  });

  it('shares ONE point per corner, not two on top of each other', () => {
    // Coincident-but-separate points look right and behave wrong: the loop
    // walk keys on point identity, and a later drag moves one and not the other.
    const sk = createSketch();
    const src = square(sk, 90);
    const out = offsetChain(sk, src, 10);
    const shared = out.map((id, i) => {
      const e = P(sk, id);
      const n = P(sk, out[(i + 1) % out.length]);
      return e.p2 === n.p1;
    });
    expect(shared).toEqual([true, true, true, true]);
  });
});

describe('the offset side is the profile’s, not each line’s', () => {
  /** The four sides' coordinates, sorted, so two sketches can be compared. */
  const outline = (sk, ids) => ids
    .flatMap((id) => ends(sk, id).map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`))
    .sort()
    .join(' | ');

  it('does not care which way round each line was drawn', () => {
    // Draw three sides and close back to the start and the last line runs the
    // other way. `offsetEntity` measures from each line's OWN left normal, so
    // that one side went outward while its neighbours went inward — a wrong
    // shape, not a wrong-looking one, and the corner gaps used to hide it.
    const a = createSketch();
    const p = [addPoint(a, 0, 0), addPoint(a, 100, 0), addPoint(a, 100, 100), addPoint(a, 0, 100)];
    const forward = [
      addLine(a, p[0], p[1]), addLine(a, p[1], p[2]),
      addLine(a, p[2], p[3]), addLine(a, p[3], p[0]),
    ];

    const b = createSketch();
    const q = [addPoint(b, 0, 0), addPoint(b, 100, 0), addPoint(b, 100, 100), addPoint(b, 0, 100)];
    const mixed = [
      addLine(b, q[0], q[1]), addLine(b, q[1], q[2]),
      addLine(b, q[2], q[3]), addLine(b, q[0], q[3]), // drawn back-to-front
    ];

    expect(outline(b, offsetChain(b, mixed, 10)))
      .toBe(outline(a, offsetChain(a, forward, 10)));
  });

  it('puts every side on the same side of the profile', () => {
    const sk = createSketch();
    const p = [addPoint(sk, 0, 0), addPoint(sk, 100, 0), addPoint(sk, 100, 100), addPoint(sk, 0, 100)];
    const src = [
      addLine(sk, p[0], p[1]), addLine(sk, p[1], p[2]),
      addLine(sk, p[2], p[3]), addLine(sk, p[0], p[3]),
    ];
    const out = offsetChain(sk, src, 10);
    const xs = out.flatMap((id) => ends(sk, id).map((pt) => pt.x));
    const ys = out.flatMap((id) => ends(sk, id).map((pt) => pt.y));
    // A square inset by 10 on all four sides: 10..90 in both axes. A side that
    // went the other way would show up as a -10 or a 110.
    expect(Math.min(...xs)).toBeCloseTo(10, 6);
    expect(Math.max(...xs)).toBeCloseTo(90, 6);
    expect(Math.min(...ys)).toBeCloseTo(10, 6);
    expect(Math.max(...ys)).toBeCloseTo(90, 6);
  });
});

describe('offsetChain on things that are not a closed chain', () => {
  it('leaves a lone line exactly where offsetting one entity puts it', () => {
    const sk = createSketch();
    const l = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0));
    const out = offsetChain(sk, [l], 2);
    expect(out).toHaveLength(1);
    const [a, b] = ends(sk, out[0]);
    expect(a.y).toBeCloseTo(2, 6);
    expect(b.y).toBeCloseTo(2, 6);
  });

  it('closes the corners of an OPEN chain but leaves its two free ends alone', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    const c = addPoint(sk, 10, 10);
    const src = [addLine(sk, a, b), addLine(sk, b, c)];
    const out = offsetChain(sk, src, 2);
    // The shared corner is joined...
    expect(P(sk, out[0]).p2).toBe(P(sk, out[1]).p1);
    // ...and the far ends are still where the plain offset put them.
    const [start] = ends(sk, out[0]);
    expect(start.x).toBeCloseTo(0, 6);
  });

  it('still offsets an arc in a chain, and joins it to its neighbour', () => {
    const sk = createSketch();
    const a = addPoint(sk, -10, 0);
    const b = addPoint(sk, 0, 0);
    const cen = addPoint(sk, 0, 10);
    const top = addPoint(sk, 0, 20);
    const line = addLine(sk, a, b);
    const arc = addArc(sk, cen, b, top, 10);
    const out = offsetChain(sk, [line, arc], 2);
    expect(out).toHaveLength(2);
    expect(P(sk, out[0]).p2).toBe(P(sk, out[1]).start);
  });
});
