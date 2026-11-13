import { describe, it, expect } from 'vitest';
import {
  createSketch, addPoint, addLine, addLineXY, addCircleXY, addConstraint,
} from './model.js';
import { relationGlyphs } from './relationGlyphs.js';

describe('relationGlyphs', () => {
  it('draws H/V on the line its two points belong to', () => {
    const sk = createSketch();
    const { line, p1, p2 } = addLineXY(sk, 0, 0, 10, 0);
    addConstraint(sk, 'horizontal', [p1, p2]);
    const g = relationGlyphs(sk);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ kind: 'horizontal', text: '—', pos: [5, 0], slot: 0 });
    expect(line).toBeDefined();
  });

  it('puts one glyph on each line of a two-line relation and stacks shared anchors', () => {
    const sk = createSketch();
    const a = addLineXY(sk, 0, 0, 10, 0);
    const b = addLineXY(sk, 0, 5, 10, 5);
    addConstraint(sk, 'parallel', [a.line, b.line]);
    addConstraint(sk, 'equalLength', [a.line, b.line]);
    const g = relationGlyphs(sk);
    expect(g.map((x) => x.text)).toEqual(['//', '//', '=', '=']);
    expect(g.filter((x) => x.pos[1] === 0).map((x) => x.slot)).toEqual([0, 1]);
  });

  it('reads a coincident pair of centres as concentric, and hides plain coincidents', () => {
    const sk = createSketch();
    const c1 = addCircleXY(sk, 0, 0, 5);
    const c2 = addCircleXY(sk, 1, 0, 2);
    addConstraint(sk, 'coincident', [c1.center, c2.center]);
    const p = addPoint(sk, 3, 3);
    const q = addPoint(sk, 4, 4);
    addLine(sk, p, q);
    addConstraint(sk, 'coincident', [p, q]);
    const g = relationGlyphs(sk);
    expect(g.map((x) => x.kind)).toEqual(['concentric', 'concentric']);
    expect(g[0].pos).toEqual([0, 5]);
  });

  it('is empty for a sketch with no relations', () => {
    expect(relationGlyphs(createSketch())).toEqual([]);
    expect(relationGlyphs(null)).toEqual([]);
  });
});
