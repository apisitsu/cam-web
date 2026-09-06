import { describe, it, expect } from 'vitest';
import { dxfToSketch, parsePairs, unitScale, bulgeArc } from './dxfImport.js';
import { sketchToDxf, LAYER_CONSTRUCTION } from './dxf.js';
import {
  createSketch, addPoint, addLine, addCircle, addArc,
} from './model.js';
import { sketchLoops } from './loops.js';

/** Wrap entity text in the minimum DXF a reader needs. */
const dxf = (entities, header = '') => [
  '0', 'SECTION', '2', 'HEADER', header, '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  entities,
  '0', 'ENDSEC', '0', 'EOF',
].filter(Boolean).join('\n');

const line = (x1, y1, x2, y2, layer = 'SKETCH') => [
  '0', 'LINE', '8', layer,
  '10', String(x1), '20', String(y1), '30', '0',
  '11', String(x2), '21', String(y2), '31', '0',
].join('\n');

const ofType = (sk, t) => [...sk.entities.values()].filter((e) => e.type === t);

describe('parsePairs / unitScale', () => {
  it('reads group code and value pairs, CRLF included', () => {
    const pairs = parsePairs('0\r\nSECTION\r\n2\r\nENTITIES\r\n');
    expect(pairs).toEqual([
      { code: 0, value: 'SECTION' },
      { code: 2, value: 'ENTITIES' },
    ]);
  });

  it('takes millimetres as the default when the header says nothing', () => {
    expect(unitScale(parsePairs(dxf(line(0, 0, 1, 1))))).toBe(1);
  });

  it('scales a drawing that says it is in inches', () => {
    expect(unitScale(parsePairs(dxf(line(0, 0, 1, 1), ['9', '$INSUNITS', '70', '1'].join('\n')))))
      .toBe(25.4);
  });
});

describe('bulgeArc', () => {
  it('turns a bulge of 1 into a semicircle on the chord', () => {
    const a = bulgeArc(0, 0, 10, 0, 1);
    expect(a.cx).toBeCloseTo(5);
    expect(a.cy).toBeCloseTo(0);
    expect(a.r).toBeCloseTo(5);
    expect(a.ccwFromFirst).toBe(true);
  });

  it('puts the centre on the true circle through both ends', () => {
    const a = bulgeArc(0, 0, 10, 0, 0.5);
    expect(Math.hypot(0 - a.cx, 0 - a.cy)).toBeCloseTo(a.r, 9);
    expect(Math.hypot(10 - a.cx, 0 - a.cy)).toBeCloseTo(a.r, 9);
  });

  it('mirrors the arc for a negative bulge and names it the other way round', () => {
    const up = bulgeArc(0, 0, 10, 0, 0.5);
    const down = bulgeArc(0, 0, 10, 0, -0.5);
    expect(down.cy).toBeCloseTo(-up.cy);
    expect(down.r).toBeCloseTo(up.r);
    expect(down.ccwFromFirst).toBe(false);
  });

  it('is nothing for a zero bulge or a zero-length chord', () => {
    expect(bulgeArc(0, 0, 10, 0, 0)).toBeNull();
    expect(bulgeArc(3, 3, 3, 3, 0.5)).toBeNull();
  });
});

describe('dxfToSketch — entities', () => {
  it('reads lines, and welds the ends that meet', () => {
    // Four independent LINE records with no shared topology — exactly what any
    // CAD writes a rectangle as.
    const { sk, counts } = dxfToSketch(dxf([
      line(0, 0, 40, 0), line(40, 0, 40, 20), line(40, 20, 0, 20), line(0, 20, 0, 0),
    ].join('\n')));
    expect(counts.line).toBe(4);
    expect(ofType(sk, 'line')).toHaveLength(4);
    // Four corners, not eight — plus the sketch's own origin, which (0,0) shares.
    expect(ofType(sk, 'point')).toHaveLength(4);
  });

  it('produces a profile that actually chains into a closed loop', () => {
    // The whole reason welding matters: without it this is 8 points and no loop.
    const { sk } = dxfToSketch(dxf([
      line(0, 0, 40, 0), line(40, 0, 40, 20), line(40, 20, 0, 20), line(0, 20, 0, 0),
    ].join('\n')));
    const { loops, open, branches } = sketchLoops(sk);
    expect(open).toHaveLength(0);
    expect(branches).toHaveLength(0);
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBeCloseTo(800);
  });

  it('reads a circle', () => {
    const { sk } = dxfToSketch(dxf(['0', 'CIRCLE', '8', 'SKETCH', '10', '5', '20', '6', '40', '3'].join('\n')));
    const [c] = ofType(sk, 'circle');
    expect(c.r).toBe(3);
    expect(sk.entities.get(c.center).x).toBe(5);
  });

  it('reads an arc, putting its ends on the rim at the stated angles', () => {
    const { sk } = dxfToSketch(dxf([
      '0', 'ARC', '8', 'SKETCH', '10', '0', '20', '0', '40', '10', '50', '0', '51', '90',
    ].join('\n')));
    const [a] = ofType(sk, 'arc');
    expect(a.r).toBe(10);
    expect(sk.entities.get(a.start).x).toBeCloseTo(10);
    expect(sk.entities.get(a.start).y).toBeCloseTo(0);
    expect(sk.entities.get(a.end).x).toBeCloseTo(0);
    expect(sk.entities.get(a.end).y).toBeCloseTo(10);
  });

  it('reads a closed LWPOLYLINE as a chained profile', () => {
    const { sk, counts } = dxfToSketch(dxf([
      '0', 'LWPOLYLINE', '8', 'SKETCH', '90', '4', '70', '1',
      '10', '0', '20', '0',
      '10', '30', '20', '0',
      '10', '30', '20', '15',
      '10', '0', '20', '15',
    ].join('\n')));
    expect(counts.polyline).toBe(1);
    expect(counts.line).toBe(4); // closed, so the last edge is drawn too
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBeCloseTo(450);
  });

  it('leaves an open LWPOLYLINE open', () => {
    const { counts } = dxfToSketch(dxf([
      '0', 'LWPOLYLINE', '8', 'SKETCH', '90', '3', '70', '0',
      '10', '0', '20', '0', '10', '30', '20', '0', '10', '30', '20', '15',
    ].join('\n')));
    expect(counts.line).toBe(2);
  });

  it('turns a polyline bulge into a real arc, not a straight line', () => {
    // A slot: two flanks and two semicircular caps, which is how a CAD writes it.
    const { sk, counts } = dxfToSketch(dxf([
      '0', 'LWPOLYLINE', '8', 'SKETCH', '90', '2', '70', '1',
      '10', '0', '20', '0', '42', '1',
      '10', '20', '20', '0', '42', '1',
    ].join('\n')));
    expect(counts.arc).toBe(2);
    expect(counts.line).toBe(0);
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBeCloseTo(Math.PI * 100, 0); // two semicircles r=10
  });

  it('keeps construction geometry on its own layer as construction', () => {
    const { sk } = dxfToSketch(dxf([
      line(0, 0, 10, 0),
      line(0, 5, 10, 5, LAYER_CONSTRUCTION),
    ].join('\n')));
    const lines = ofType(sk, 'line');
    expect(lines.filter((l) => l.construction)).toHaveLength(1);
  });

  it('scales an inch drawing to millimetres and says it did', () => {
    const { sk, warnings } = dxfToSketch(
      dxf(line(0, 0, 1, 0), ['9', '$INSUNITS', '70', '1'].join('\n')),
    );
    const xs = ofType(sk, 'point').map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(25.4);
    expect(warnings.join(' ')).toMatch(/scaled ×25.4/);
  });

  it('names what it could not read rather than dropping it silently', () => {
    const { warnings, counts } = dxfToSketch(dxf([
      line(0, 0, 10, 0),
      '0', 'SPLINE', '8', 'SKETCH', '10', '0', '20', '0',
      '0', 'TEXT', '8', 'SKETCH', '1', 'hello',
    ].join('\n')));
    expect(counts.skipped).toBe(2);
    expect(warnings.join(' ')).toMatch(/SPLINE/);
    expect(warnings.join(' ')).toMatch(/TEXT/);
  });
});

describe('dxfToSketch — what it refuses', () => {
  it('says so for a file that is not a DXF', () => {
    expect(() => dxfToSketch('this is not a dxf at all')).toThrow(/not a DXF|no ENTITIES/i);
  });

  it('says so for a DXF with no ENTITIES section', () => {
    expect(() => dxfToSketch(['0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC', '0', 'EOF'].join('\n')))
      .toThrow(/no ENTITIES section/i);
  });

  it('says so for a DXF that holds only text', () => {
    expect(() => dxfToSketch(dxf(['0', 'TEXT', '8', 'SKETCH', '1', 'hello'].join('\n'))))
      .toThrow(/no lines, circles or arcs/i);
  });
});

describe('DXF round trip', () => {
  it('exports a sketch and reads it back to the same geometry', () => {
    const sk = createSketch();
    const p1 = addPoint(sk, 0, 0);
    const p2 = addPoint(sk, 40, 0);
    const p3 = addPoint(sk, 40, 20);
    const p4 = addPoint(sk, 0, 20);
    addLine(sk, p1, p2);
    addLine(sk, p2, p3);
    addLine(sk, p3, p4);
    addLine(sk, p4, p1);
    const c = addPoint(sk, 20, 10);
    addCircle(sk, c, 4);
    const ac = addPoint(sk, 60, 0);
    const as = addPoint(sk, 70, 0);
    const ae = addPoint(sk, 60, 10);
    addArc(sk, ac, as, ae, 10);

    const back = dxfToSketch(sketchToDxf(sk)).sk;
    expect(ofType(back, 'line')).toHaveLength(4);
    expect(ofType(back, 'circle')).toHaveLength(1);
    expect(ofType(back, 'arc')).toHaveLength(1);
    expect(ofType(back, 'circle')[0].r).toBeCloseTo(4);

    // And the profile still closes, which is what it is for.
    const { loops } = sketchLoops(back);
    expect(loops.map((l) => l.isHole)).toEqual([false, true]);
    expect(loops[0].area).toBeCloseTo(800);
  });

  it('keeps construction geometry construction through the round trip', () => {
    const sk = createSketch();
    const p1 = addPoint(sk, 0, 0);
    const p2 = addPoint(sk, 10, 10);
    const l = addLine(sk, p1, p2);
    sk.entities.get(l).construction = true;
    const back = dxfToSketch(sketchToDxf(sk)).sk;
    expect(ofType(back, 'line')[0].construction).toBe(true);
  });
});
