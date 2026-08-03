import { describe, it, expect } from 'vitest';
import {
  billetBox, billetWarnings, suggestBilletSize, suggestBillet, billetExtents,
  billetSolid, anySized, previewSolid,
} from './billet.js';

/** A program cutting a 60 × 40 pocket 8 mm deep, tool retracting to Z5. */
const BOUNDS = { min: [0, 0, -8], max: [60, 40, 5] };

describe('Z0 on the top face is the default, not a rule', () => {
  it('puts the top face on zero and hangs the thickness below it', () => {
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 20 });
    expect(box.top).toBe(0);
    expect(box.base).toBe(-20);
  });

  it('does not let a high rapid lift the top off the datum', () => {
    // The old form took `top` from the highest move, so a G0 to Z50 made a
    // 50 mm-tall blank out of thin air. A stated thickness cannot do that.
    const box = billetBox({ min: [0, 0, -8], max: [60, 40, 50] }, { x: 80, y: 60, z: 20 });
    expect(box.top).toBe(0);
    expect(box.base).toBe(-20);
  });

  it('gives a thicker blank more material under the same top', () => {
    const thin = billetBox(BOUNDS, { x: 80, y: 60, z: 10 });
    const thick = billetBox(BOUNDS, { x: 80, y: 60, z: 40 });
    expect(thick.top).toBe(thin.top);
    expect(thick.base).toBeLessThan(thin.base);
  });
});

describe('X and Y are centred on the cutting', () => {
  it('centres a stated size on the toolpath, not on the origin', () => {
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 20 });
    expect(box.xMin).toBeCloseTo(30 - 40);   // path centre 30, half of 80
    expect(box.xMax).toBeCloseTo(30 + 40);
    expect(box.yMin).toBeCloseTo(20 - 30);
    expect(box.yMax).toBeCloseTo(20 + 30);
  });

  it('gives exactly the size asked for', () => {
    const box = billetBox(BOUNDS, { x: 123, y: 45, z: 6 });
    expect(box.xMax - box.xMin).toBeCloseTo(123);
    expect(box.yMax - box.yMin).toBeCloseTo(45);
    expect(box.top - box.base).toBeCloseTo(6);
  });

  it('holds the program inside a blank that is big enough', () => {
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 20 });
    expect(billetWarnings(box, BOUNDS)).toEqual([]);
  });
});

describe('a blank dimension keeps the old automatic behaviour', () => {
  it('wraps the toolpath with the margin when nothing is given', () => {
    const box = billetBox(BOUNDS, {}, { margin: 5 });
    expect(box.xMin).toBe(-5);
    expect(box.xMax).toBe(65);
    expect(box.yMin).toBe(-5);
    expect(box.yMax).toBe(45);
  });

  it('falls back per axis, not all or nothing', () => {
    // X stated, Y and Z left to the program.
    const box = billetBox(BOUNDS, { x: 100 }, { margin: 5 });
    expect(box.xMax - box.xMin).toBeCloseTo(100);
    expect(box.yMin).toBe(-5);
    expect(box.sized).toEqual({ x: true, y: false, z: false });
  });

  it('uses the supplied automatic Z when no thickness is given', () => {
    const box = billetBox(BOUNDS, {}, { autoTop: 2, autoBase: -12 });
    expect(box.top).toBe(2);
    expect(box.base).toBe(-12);
  });

  it('treats zero and negative dimensions as not given', () => {
    // A half-typed "0" must not collapse the blank to nothing.
    expect(billetBox(BOUNDS, { x: 0, y: -5, z: 0 }).sized)
      .toEqual({ x: false, y: false, z: false });
  });

  it('treats a null or absent size object as fully automatic', () => {
    expect(billetBox(BOUNDS).sized).toEqual({ x: false, y: false, z: false });
    expect(billetBox(BOUNDS, { x: null, y: undefined, z: NaN }).sized)
      .toEqual({ x: false, y: false, z: false });
  });
});

describe('a blank too small to hold the program says so', () => {
  it('is silent when the blank contains the cutting', () => {
    expect(billetWarnings(billetBox(BOUNDS, { x: 80, y: 60, z: 20 }), BOUNDS)).toEqual([]);
  });

  it('catches a program running off the side, and says by how much', () => {
    const box = billetBox(BOUNDS, { x: 40, y: 60, z: 20 });   // path is 60 wide
    const w = billetWarnings(box, BOUNDS);
    expect(w.join(' ')).toMatch(/past the billet in \+X by 10\.00 mm/);
    expect(w.join(' ')).toMatch(/−X by 10\.00 mm/);
  });

  it('catches a cut deeper than the material is thick', () => {
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 5 });    // cuts to -8
    expect(billetWarnings(box, BOUNDS).join(' '))
      .toMatch(/deeper than the billet is thick by 3\.00 mm/);
  });

  it('never complains about a rapid above the top face', () => {
    // Retracting to Z5 over a blank whose top is Z0 is the tool clear of the
    // work, which is where it spends most of the program.
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 20 });
    expect(billetWarnings(box, BOUNDS).join(' ')).not.toMatch(/Z/);
  });
});

describe('suggestBilletSize', () => {
  it('offers a blank that holds the program with margin all round', () => {
    expect(suggestBilletSize(BOUNDS, { margin: 5 })).toEqual({ x: 70, y: 50, z: 8 });
  });

  it('rounds up to whole millimetres — nobody stocks 60.37', () => {
    const s = suggestBilletSize({ min: [0, 0, -3.2], max: [60.4, 40, 5] }, { margin: 0 });
    expect(s).toEqual({ x: 61, y: 40, z: 4 });
  });

  it('measures thickness from Z0 down, ignoring the retract height', () => {
    const s = suggestBilletSize({ min: [0, 0, -12], max: [10, 10, 100] }, { margin: 0 });
    expect(s.z).toBe(12);
  });

  it('never suggests a blank with no thickness', () => {
    const s = suggestBilletSize({ min: [0, 0, 0], max: [10, 10, 5] }, { margin: 0 });
    expect(s.z).toBeGreaterThan(0);
  });

  it('has nothing to suggest with no program parsed', () => {
    expect(suggestBilletSize(null)).toBeNull();
    expect(suggestBilletSize({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }))
      .toBeNull();
  });

  it('suggests a size the program then fits inside', () => {
    // The offer has to be a good one: filling the form with it must not
    // immediately produce a warning.
    const size = suggestBilletSize(BOUNDS, { margin: 5 });
    expect(billetWarnings(billetBox(BOUNDS, size), BOUNDS)).toEqual([]);
  });
});

describe('a stated origin places the block, overriding the Z0 default', () => {
  it('spans size from the origin corner on every axis', () => {
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 20 }, { origin: { x: -10, y: -10, z: -25 } });
    expect([box.xMin, box.xMax]).toEqual([-10, 70]);
    expect([box.yMin, box.yMax]).toEqual([-10, 50]);
    expect([box.base, box.top]).toEqual([-25, -5]);
  });

  it('lets the top sit somewhere other than Z0 — the whole point', () => {
    // A datum on the vice, not on the raw top: the blank stands proud of Z0.
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 20 }, { origin: { z: -12 } });
    expect(box.top).toBe(8);
    expect(box.base).toBe(-12);
  });

  it('treats a Z origin of 0 as stated, not as blank', () => {
    // The bug this guards: `origin.z || default` would swallow a real zero and
    // silently drop the blank 20 mm, which is a crash on the machine.
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 20 }, { origin: { z: 0 } });
    expect(box.base).toBe(0);
    expect(box.top).toBe(20);
  });

  it('still defaults the top to Z0 when the origin is blank', () => {
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 20 });
    expect(box.top).toBe(0);
    expect(box.placed).toEqual({ x: false, y: false, z: false });
  });

  it('places each axis on its own', () => {
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 20 }, { origin: { x: 0 } });
    expect(box.xMin).toBe(0);           // placed
    expect(box.yMin).toBeCloseTo(-10);  // centred on the path (centre 20, half 30)
    expect(box.top).toBe(0);            // default
    expect(box.placed).toEqual({ x: true, y: false, z: false });
  });

  it('ignores an origin on an axis with no size to measure from', () => {
    // Without a length, a corner says nothing about where the far face is.
    const box = billetBox(BOUNDS, {}, { origin: { x: 100, y: 100, z: 100 }, margin: 5 });
    expect(box.xMin).toBe(-5);
    expect(box.placed).toEqual({ x: false, y: false, z: false });
  });

  it('warns when a placed block no longer contains the cutting', () => {
    // Big enough, in the wrong place — which is exactly what an origin makes
    // possible and what the old forced Z0 could not express or catch.
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 20 }, { origin: { z: 5 } });
    expect(billetWarnings(box, BOUNDS).join(' '))
      .toMatch(/deeper than the billet is thick by 13\.00 mm/);
  });
});

describe('billetExtents', () => {
  it('reports the three ranges the operator sees on screen', () => {
    const box = billetBox(BOUNDS, { x: 80, y: 60, z: 20 }, { origin: { x: -10, y: -10, z: -25 } });
    expect(billetExtents(box)).toEqual({ x: [-10, 70], y: [-10, 50], z: [-25, -5] });
  });

  it('has nothing to report without a box', () => {
    expect(billetExtents(null)).toBeNull();
  });
});

describe('suggestBillet offers a size AND a place for it', () => {
  it('produces a blank that contains the program', () => {
    const { size, origin } = suggestBillet(BOUNDS, { margin: 5 });
    const box = billetBox(BOUNDS, size, { origin });
    expect(billetWarnings(box, BOUNDS)).toEqual([]);
  });

  it('centres it on the cutting and tops it at Z0', () => {
    const { size, origin } = suggestBillet(BOUNDS, { margin: 5 });
    expect(origin.z).toBe(-size.z);
    const box = billetBox(BOUNDS, size, { origin });
    expect(box.top).toBe(0);
    expect((box.xMin + box.xMax) / 2).toBeCloseTo(30);
  });

  it('has nothing to suggest with no program parsed', () => {
    expect(suggestBillet(null)).toBeNull();
  });
});

describe('billetSolid — the blank as a drawable box', () => {
  it('centres the box on the stated block', () => {
    const box = billetBox(BOUNDS, { x: 50, y: 50, z: 28 }, { origin: { x: -25, y: -25, z: 0 } });
    expect(billetSolid(box)).toEqual({ center: [0, 0, 14], size: [50, 50, 28] });
  });

  it('follows the origin, so the drawn box moves with the numbers', () => {
    const at = (z) => billetSolid(billetBox(BOUNDS, { x: 50, y: 50, z: 28 }, { origin: { z } }));
    expect(at(0).center[2]).toBe(14);
    expect(at(-28).center[2]).toBe(-14);
    expect(at(10).center[2]).toBe(24);
  });

  it('reports the size asked for, not the size of the cutting', () => {
    const box = billetBox(BOUNDS, { x: 123, y: 45, z: 6 });
    expect(billetSolid(box).size).toEqual([123, 45, 6]);
  });

  it('draws the automatic fit too, when nothing is stated', () => {
    const solid = billetSolid(billetBox(BOUNDS, {}, { margin: 5 }));
    expect(solid.size[0]).toBeCloseTo(70);
    expect(solid.size[1]).toBeCloseTo(50);
  });

  it('never hands an Infinity to a geometry argument', () => {
    // An Infinity in a boxGeometry takes the whole canvas down. Unparsed bounds
    // degenerate to a finite margin box; whether that box is worth *drawing* is
    // `previewSolid`'s call, not this one's.
    const empty = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const solid = billetSolid(billetBox(empty, {}));
    expect(solid.center.every(Number.isFinite)).toBe(true);
    expect(solid.size.every(Number.isFinite)).toBe(true);
    expect(billetSolid(null)).toBeNull();
  });

  it('has nothing to draw for a box with no volume', () => {
    expect(billetSolid({ xMin: 0, xMax: 0, yMin: 0, yMax: 10, base: 0, top: 10 })).toBeNull();
  });
});

describe('the blank can be described before any program exists', () => {
  // The reported failure: with nothing parsed, the stock never appeared, so it
  // still looked like Simulate was what made material show up. Setting up the
  // material comes first — you know what is in the vice long before you know
  // what will be cut out of it.
  const SIZE = { x: 50, y: 50, z: 28 };
  const ORIGIN = { x: -25, y: -25, z: 0 };

  it('builds the stated box with no bounds at all', () => {
    for (const nothing of [null, undefined, {}]) {
      const box = billetBox(nothing, SIZE, { origin: ORIGIN });
      expect(billetSolid(box)).toEqual({ center: [0, 0, 14], size: [50, 50, 28] });
    }
  });

  it('survives the degenerate bounds an unparsed viewport holds', () => {
    const empty = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    expect(billetSolid(billetBox(empty, SIZE, { origin: ORIGIN })).size).toEqual([50, 50, 28]);
  });

  it('still defaults the top to Z0 with no program to measure', () => {
    expect(billetBox(null, SIZE).top).toBe(0);
    expect(billetBox(null, SIZE).base).toBe(-28);
  });

  it('centres an unplaced axis on the origin when there is no cutting', () => {
    const box = billetBox(null, SIZE);
    expect(box.xMin).toBe(-25);
    expect(box.xMax).toBe(25);
  });
});

describe('anySized — is there a stated blank to draw yet?', () => {
  it('is true for any single stated dimension', () => {
    expect(anySized({ x: 50, y: null, z: null })).toBe(true);
    expect(anySized({ x: null, y: null, z: 28 })).toBe(true);
  });

  it('is false for nothing, zeroes and negatives', () => {
    expect(anySized({ x: null, y: null, z: null })).toBe(false);
    expect(anySized({ x: 0, y: -5, z: NaN })).toBe(false);
    expect(anySized({})).toBe(false);
    expect(anySized(null)).toBe(false);
  });
});

describe('previewSolid — what the viewport should draw right now', () => {
  const SIZE = { x: 50, y: 50, z: 28 };
  const NONE = { x: null, y: null, z: null };
  const EMPTY = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  it('draws a stated blank with no program — the reported failure', () => {
    // This is the case that showed nothing: stock typed in, no .nc loaded, so
    // it still looked as though Simulate was what made material appear.
    expect(previewSolid(null, SIZE, { origin: { x: -25, y: -25, z: 0 } }))
      .toEqual({ center: [0, 0, 14], size: [50, 50, 28] });
    expect(previewSolid(EMPTY, SIZE).size).toEqual([50, 50, 28]);
  });

  it('draws the automatic fit when a program exists and nothing is stated', () => {
    // So you can see the blank the sim would pick for itself.
    const solid = previewSolid(BOUNDS, NONE, { margin: 5 });
    expect(solid.size[0]).toBeCloseTo(70);
    expect(solid.size[1]).toBeCloseTo(50);
  });

  it('draws nothing with neither a program nor a size', () => {
    // A margin box round the origin is not a billet, it is the absence of one.
    expect(previewSolid(null, NONE)).toBeNull();
    expect(previewSolid(EMPTY, NONE)).toBeNull();
    expect(previewSolid(undefined, {})).toBeNull();
  });

  it('draws as soon as ONE dimension is typed', () => {
    expect(previewSolid(null, { x: 50, y: null, z: null })).not.toBeNull();
  });

  it('follows the numbers, which is the whole point', () => {
    const at = (x) => previewSolid(null, { ...SIZE, x }, { origin: { x: 0, y: 0, z: 0 } });
    expect(at(50).size[0]).toBe(50);
    expect(at(90).size[0]).toBe(90);
    expect(at(90).center[0]).toBe(45);
  });
});
