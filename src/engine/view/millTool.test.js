import { describe, it, expect } from 'vitest';
import { endMillGeometry, offerArborToggle, ARBOR_LENGTH, parkedTip } from './millTool.js';

/** Bottom and top of a part along the tool axis, from its centre and length. */
const span = (p) => [p.z - p.length / 2, p.z + p.length / 2];

describe('endMillGeometry — the parts stack up', () => {
  it('starts the flutes at the tip for a flat cutter', () => {
    const g = endMillGeometry({ radius: 3, type: 'flat' });
    expect(span(g.flutes)[0]).toBeCloseTo(0, 9);
  });

  it('leaves no gap or overlap between flutes and shank', () => {
    // A gap here draws a floating shank; an overlap hides flute length.
    const g = endMillGeometry({ radius: 4, length: 60 });
    expect(span(g.flutes)[1]).toBeCloseTo(span(g.shank)[0], 9);
  });

  it('puts the arbor exactly on the collet face, where the shank ends', () => {
    const g = endMillGeometry({ radius: 4, length: 60 });
    expect(span(g.shank)[1]).toBeCloseTo(g.gauge, 9);
    expect(span(g.arbor)[0]).toBeCloseTo(g.gauge, 9);
  });

  it('gives the ball nose the first radius of the tool, flutes above it', () => {
    const g = endMillGeometry({ radius: 5, type: 'ball' });
    expect(g.nose.z).toBeCloseTo(5, 9);
    expect(span(g.flutes)[0]).toBeCloseTo(5, 9);
  });

  it('has no nose sphere for a flat cutter', () => {
    expect(endMillGeometry({ radius: 5, type: 'flat' }).nose).toBe(null);
  });
});

describe('endMillGeometry — the gauge length', () => {
  it('spans exactly the tool-table length when it is known', () => {
    // Stick-out to scale is the whole reason the tool table carries a length.
    expect(endMillGeometry({ radius: 3, length: 75 }).gauge).toBeCloseTo(75, 9);
  });

  it('stands in a plausible length when the program never said', () => {
    const g = endMillGeometry({ radius: 3, length: 0 });
    expect(g.gauge).toBeGreaterThan(0);
    expect(g.shank.length).toBeGreaterThan(0);
  });

  it('never lets a short gauge collapse the shank to nothing', () => {
    // A 5 mm gauge on a tool with 12 mm of flute is physically nonsense; the
    // marker still has to be drawable rather than inverted.
    const g = endMillGeometry({ radius: 3, length: 5 });
    expect(g.shank.length).toBeGreaterThan(0);
    expect(g.flutes.length).toBeGreaterThan(0);
    expect(span(g.flutes)[1]).toBeCloseTo(span(g.shank)[0], 9);
  });

  it('keeps the flutes off a negative length for a ball nose on a short gauge', () => {
    const g = endMillGeometry({ radius: 6, type: 'ball', length: 4 });
    expect(g.flutes.length).toBeGreaterThan(0);
  });
});

describe('endMillGeometry — the arbor', () => {
  it('is wider than the shank — it is a holder, not more tool', () => {
    const g = endMillGeometry({ radius: 3 });
    expect(g.arbor.rBottom).toBeGreaterThan(g.shank.radius);
  });

  it('tapers upward, like a collet nut', () => {
    const g = endMillGeometry({ radius: 3 });
    expect(g.arbor.rTop).toBeLessThan(g.arbor.rBottom);
  });

  it('stays visible on a tiny cutter', () => {
    // A Ø0.5 engraver's holder is not 0.9 mm across in real life.
    const g = endMillGeometry({ radius: 0.25 });
    expect(g.arbor.rBottom).toBeGreaterThanOrEqual(4);
  });

  it('grows with a big face mill', () => {
    const small = endMillGeometry({ radius: 3 }).arbor.rBottom;
    const big = endMillGeometry({ radius: 25 }).arbor.rBottom;
    expect(big).toBeGreaterThan(small);
  });

  it('is a fixed lump, not scaled to the gauge', () => {
    expect(endMillGeometry({ radius: 3, length: 40 }).arbor.length).toBe(ARBOR_LENGTH);
    expect(endMillGeometry({ radius: 3, length: 140 }).arbor.length).toBe(ARBOR_LENGTH);
  });

  it('is omitted entirely when hidden', () => {
    expect(endMillGeometry({ radius: 3, arbor: false }).arbor).toBe(null);
  });

  it('leaves the cutter untouched when hidden — only the holder goes', () => {
    // Hiding the arbor must not move the tool: the tip is the position readout.
    const on = endMillGeometry({ radius: 4, length: 60, arbor: true });
    const off = endMillGeometry({ radius: 4, length: 60, arbor: false });
    expect(off.flutes).toEqual(on.flutes);
    expect(off.shank).toEqual(on.shank);
    expect(off.gauge).toBe(on.gauge);
  });
});

describe('endMillGeometry — degenerate input', () => {
  it('survives a zero radius without producing NaN', () => {
    const g = endMillGeometry({ radius: 0 });
    for (const v of [g.gauge, g.flutes.length, g.shank.length, g.arbor.rBottom]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(g.flutes.length).toBeGreaterThan(0);
  });

  it('defaults to a usable tool with no options at all', () => {
    const g = endMillGeometry();
    expect(g.flutes.length).toBeGreaterThan(0);
    expect(g.arbor).not.toBe(null);
  });
});

describe('offerArborToggle', () => {
  it('is offered for milling', () => {
    expect(offerArborToggle({ mode: 'mill' })).toBe(true);
  });

  it('is withheld on the lathe — its holder is drawn a different way', () => {
    expect(offerArborToggle({ mode: 'turn' })).toBe(false);
  });

  it('is withheld on the sketch page, where there is no tool', () => {
    expect(offerArborToggle({ mode: 'mill', sketching: true })).toBe(false);
  });
});

describe('parkedTip — the tool is visible when nothing is running', () => {
  it('parks over the middle of the stock, clear of its top', () => {
    const solid = { center: [10, 20, -14], size: [50, 50, 28] };
    const [x, y, z] = parkedTip({ solid, radius: 3 });
    expect(x).toBe(10);
    expect(y).toBe(20);
    expect(z).toBeGreaterThan(0);          // above the blank's top face (Z0)
    expect(z).toBeCloseTo(0 + 10);         // top + the 10 mm floor clearance
  });

  it('scales the clearance with the cutter', () => {
    // A Ø63 face mill must not park with its flutes buried in the billet.
    const solid = { center: [0, 0, -10], size: [100, 100, 20] };
    const small = parkedTip({ solid, radius: 3 })[2];
    const big = parkedTip({ solid, radius: 31.5 })[2];
    expect(big).toBeGreaterThan(small);
  });

  it('falls back to the toolpath when no blank is defined', () => {
    const bounds = { min: [0, 0, -8], max: [60, 40, 5] };
    const [x, y, z] = parkedTip({ bounds, radius: 3 });
    expect(x).toBe(30);
    expect(y).toBe(20);
    expect(z).toBeCloseTo(15);
  });

  it('prefers the blank over the toolpath when both exist', () => {
    const solid = { center: [0, 0, -10], size: [20, 20, 20] };
    const bounds = { min: [500, 500, 500], max: [600, 600, 600] };
    expect(parkedTip({ solid, bounds })[0]).toBe(0);
  });

  it('parks at the work origin with neither', () => {
    expect(parkedTip({})).toEqual([0, 0, 10]);
    expect(parkedTip()).toEqual([0, 0, 10]);
  });

  it('ignores the degenerate bounds an unparsed viewport holds', () => {
    const empty = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    expect(parkedTip({ bounds: empty })).toEqual([0, 0, 10]);
  });

  it('always returns finite coordinates', () => {
    for (const opts of [{}, { bounds: null }, { solid: null }, { radius: 0 }]) {
      expect(parkedTip(opts).every(Number.isFinite)).toBe(true);
    }
  });
});
