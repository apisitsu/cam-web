import { describe, it, expect } from 'vitest';
import { createSketch, addPoint, addLine, addCircle, addArc } from './model.js';
import { sketchToDxf, sketchHasGeometry, LAYER_GEOMETRY, LAYER_CONSTRUCTION } from './dxf.js';

/** Group codes/values as pairs, the way a DXF reader consumes the file. */
function pairs(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([lines[i].trim(), lines[i + 1]]);
  return out;
}
/** The value that follows `code` inside the entity starting at `at`. */
const valueIn = (ps, at, code) => {
  for (let i = at + 1; i < ps.length && ps[i][0] !== '0'; i++) {
    if (ps[i][0] === code) return ps[i][1];
  }
  return undefined;
};
const entityStarts = (ps, type) => ps
  .map(([c, v], i) => (c === '0' && v === type ? i : -1))
  .filter((i) => i >= 0);

describe('sketchToDxf — file structure', () => {
  it('is a well-formed R12 file in millimetres', () => {
    const ps = pairs(sketchToDxf(createSketch()));
    // Group codes always come in pairs, and the file ends with EOF.
    expect(ps.every(([c]) => /^\d+$/.test(c))).toBe(true);
    expect(ps[ps.length - 1]).toEqual(['0', 'EOF']);
    expect(ps.some(([c, v]) => c === '1' && v === 'AC1009')).toBe(true);
    expect(ps.some(([c, v]) => c === '70' && v === '4')).toBe(true); // $INSUNITS = mm
    // SECTION/ENDSEC are balanced.
    const open = ps.filter(([c, v]) => c === '0' && v === 'SECTION').length;
    const close = ps.filter(([c, v]) => c === '0' && v === 'ENDSEC').length;
    expect(open).toBe(close);
  });

  it('declares both layers so entities are not dropped', () => {
    const ps = pairs(sketchToDxf(createSketch()));
    const layers = entityStarts(ps, 'LAYER').map((i) => valueIn(ps, i, '2'));
    expect(layers).toContain(LAYER_GEOMETRY);
    expect(layers).toContain(LAYER_CONSTRUCTION);
  });
});

describe('sketchToDxf — geometry', () => {
  const sample = () => {
    const sk = createSketch();
    addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 40, 30));
    addCircle(sk, addPoint(sk, 60, 10), 12);
    // Quarter arc about (0,0): from (10,0) CCW to (0,10) → 0° to 90°.
    addArc(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0), addPoint(sk, 0, 10), 10);
    return sk;
  };

  it('writes a line with both endpoints', () => {
    const ps = pairs(sketchToDxf(sample()));
    const [at] = entityStarts(ps, 'LINE');
    expect(at).toBeDefined();
    expect(valueIn(ps, at, '10')).toBe('0');
    expect(valueIn(ps, at, '20')).toBe('0');
    expect(valueIn(ps, at, '11')).toBe('40');
    expect(valueIn(ps, at, '21')).toBe('30');
  });

  it('writes a circle centre and radius', () => {
    const ps = pairs(sketchToDxf(sample()));
    const [at] = entityStarts(ps, 'CIRCLE');
    expect(valueIn(ps, at, '10')).toBe('60');
    expect(valueIn(ps, at, '20')).toBe('10');
    expect(valueIn(ps, at, '40')).toBe('12');
  });

  it('writes arc angles in degrees, CCW start→end like the sketcher', () => {
    const ps = pairs(sketchToDxf(sample()));
    const [at] = entityStarts(ps, 'ARC');
    expect(valueIn(ps, at, '40')).toBe('10');
    expect(Number(valueIn(ps, at, '50'))).toBeCloseTo(0, 6);
    expect(Number(valueIn(ps, at, '51'))).toBeCloseTo(90, 6);
  });

  it('normalises negative angles into 0..360', () => {
    const sk = createSketch();
    // Start at (0,−10) = −90° must be written as 270°, not −90.
    addArc(sk, addPoint(sk, 0, 0), addPoint(sk, 0, -10), addPoint(sk, 10, 0), 10);
    const ps = pairs(sketchToDxf(sk));
    const [at] = entityStarts(ps, 'ARC');
    expect(Number(valueIn(ps, at, '50'))).toBeCloseTo(270, 6);
    expect(Number(valueIn(ps, at, '51'))).toBeCloseTo(0, 6);
  });

  it('leaves loose points out unless asked for them', () => {
    const sk = sample();
    expect(entityStarts(pairs(sketchToDxf(sk)), 'POINT')).toHaveLength(0);
    expect(entityStarts(pairs(sketchToDxf(sk, { includePoints: true })), 'POINT').length)
      .toBeGreaterThan(0);
  });
});

describe('sketchToDxf — construction geometry', () => {
  const withConstruction = () => {
    const sk = createSketch();
    addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0));
    const axis = addLine(sk, addPoint(sk, 0, -5), addPoint(sk, 0, 5));
    sk.entities.get(axis).construction = true;
    return sk;
  };

  it('puts it on its own layer so the receiving CAD can hide it', () => {
    const ps = pairs(sketchToDxf(withConstruction()));
    const layers = entityStarts(ps, 'LINE').map((i) => valueIn(ps, i, '8'));
    expect(layers).toContain(LAYER_GEOMETRY);
    expect(layers).toContain(LAYER_CONSTRUCTION);
  });

  it('can leave it out entirely', () => {
    const ps = pairs(sketchToDxf(withConstruction(), { includeConstruction: false }));
    const layers = entityStarts(ps, 'LINE').map((i) => valueIn(ps, i, '8'));
    expect(layers).toEqual([LAYER_GEOMETRY]);
  });
});

describe('sketchHasGeometry', () => {
  it('ignores a sketch that is only points', () => {
    const sk = createSketch();
    addPoint(sk, 0, 0);
    expect(sketchHasGeometry(sk)).toBe(false);
    addCircle(sk, addPoint(sk, 1, 1), 5);
    expect(sketchHasGeometry(sk)).toBe(true);
  });
});
