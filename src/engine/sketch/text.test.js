import { describe, it, expect } from 'vitest';
import {
  GLYPHS, GLYPH_W, GLYPH_H, textStrokes, textWidth, buildText, unsupportedChars,
} from './text.js';
import { sketchStrokes } from './strokes.js';
import { createSketch, addPoint, addLine, addCircle } from './model.js';

describe('the engraving font', () => {
  it('draws every digit and capital, inside its cell', () => {
    for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(GLYPHS[ch]?.length).toBeGreaterThan(0);
      for (const stroke of GLYPHS[ch]) {
        for (const [x, y] of stroke) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(GLYPH_W);
          expect(y).toBeGreaterThanOrEqual(-1);
          expect(y).toBeLessThanOrEqual(GLYPH_H);
        }
      }
    }
  });

  it('writes lower case as capitals and names what it cannot draw', () => {
    expect(textStrokes('ab')).toEqual(textStrokes('AB'));
    expect(unsupportedChars('PN-12 ก!')).toEqual(['ก', '!']);
  });

  it('scales to the height asked, spaces letters, and turns the baseline', () => {
    const [l] = textStrokes('L', { x: 10, y: 20, height: 12 });
    expect(l).toEqual([[10, 32], [10, 20], [18, 20]]);
    expect(textWidth('LL', 6)).toBeCloseTo(4 + 1.5 + 4, 9);
    const [turned] = textStrokes('L', { height: 6, angle: 90 });
    expect(turned[2][0]).toBeCloseTo(0, 9);
    expect(turned[2][1]).toBeCloseTo(4, 9);
  });

  it('puts text into a sketch as lines that chain back into its strokes', () => {
    const sk = createSketch();
    const ids = buildText(sk, 'T1', { height: 6 });
    expect(ids.length).toBe(2 + 3); // T: two lines; 1: two + one
    const strokes = sketchStrokes(sk);
    expect(strokes).toHaveLength(4);
  });

  it('closes a ring letter on its first point', () => {
    const sk = createSketch();
    buildText(sk, 'O', { height: 6 });
    const [ring] = sketchStrokes(sk);
    expect(ring.closed).toBe(true);
  });
});

describe('sketchStrokes', () => {
  it('chains lines that meet end to end, and keeps a circle whole', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    const c = addPoint(sk, 10, 10);
    addLine(sk, b, c);
    addLine(sk, a, b);
    addCircle(sk, addPoint(sk, 50, 50), 5);
    const out = sketchStrokes(sk);
    expect(out).toHaveLength(2);
    const open = out.find((s) => !s.closed);
    expect(open.points).toHaveLength(3);
    expect(out.find((s) => s.closed).points.length).toBeGreaterThan(20);
  });

  it('leaves construction lines out', () => {
    const sk = createSketch();
    const l = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 5, 0));
    sk.entities.get(l).construction = true;
    expect(sketchStrokes(sk)).toEqual([]);
  });
});
