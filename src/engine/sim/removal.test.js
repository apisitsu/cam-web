import { describe, it, expect } from 'vitest';
import { removalDiagnosis, cuttingBounds } from './removal.js';
import { interpret } from '../gcode/interpreter.js';

const BOX = { xMin: -25, xMax: 25, yMin: -25, yMax: 25, base: -28, top: 0 };
const CUT = { min: [0, 0, -8], max: [20, 15, -8] };

describe('a carve that removed something says nothing', () => {
  it('is silent whenever material actually came off', () => {
    expect(removalDiagnosis({
      hasProgram: true, feeds: 12, removedVolume: 1888, cutBounds: CUT, box: BOX,
    })).toBeNull();
  });

  it('is silent even for a tiny but real cut', () => {
    expect(removalDiagnosis({
      hasProgram: true, feeds: 1, removedVolume: 0.01, cutBounds: CUT, box: BOX,
    })).toBeNull();
  });
});

describe('it names the first thing that is wrong, not every thing', () => {
  it('asks for a program before commenting on the blank', () => {
    const msg = removalDiagnosis({
      hasProgram: false, feeds: 0, removedVolume: 0, box: BOX,
    });
    expect(msg).toMatch(/No program loaded/);
  });

  it('catches a program that only rapids', () => {
    expect(removalDiagnosis({
      hasProgram: true, feeds: 0, removedVolume: 0, box: BOX,
    })).toMatch(/no cutting moves/);
  });

  it('catches the full carve immediately undone by the playhead', () => {
    // simulate() carves the whole program and then carves again to the
    // playhead. At playhead 0 that hands back the uncut block, which is
    // indistinguishable from a simulator that did not run.
    expect(removalDiagnosis({
      hasProgram: true, feeds: 20, removedVolume: 0,
      cutBounds: CUT, box: BOX, followsPlayback: true, playhead: 0,
    })).toMatch(/playhead is at the start/);
  });

  it('does not blame the playhead once it has moved', () => {
    const msg = removalDiagnosis({
      hasProgram: true, feeds: 20, removedVolume: 0,
      cutBounds: CUT, box: BOX, followsPlayback: true, playhead: 40,
    });
    expect(msg).not.toMatch(/playhead/);
  });
});

describe('it explains a blank the toolpath never reaches', () => {
  it('catches the Origin-Z trap the stock form makes easy', () => {
    // `Origin` is the blank's MINIMUM corner, so Z0 puts the whole blank above
    // the work plane and an ordinary program passes underneath it.
    const above = { xMin: -25, xMax: 25, yMin: -25, yMax: 25, base: 0, top: 28 };
    const msg = removalDiagnosis({
      hasProgram: true, feeds: 20, removedVolume: 0, cutBounds: CUT, box: above,
    });
    expect(msg).toMatch(/below the blank/);
    expect(msg).toMatch(/Origin Z/);
    expect(msg).toMatch(/0\.0 to 28\.0/);
  });

  it('catches a program that never reaches down into the material', () => {
    const shallow = { min: [0, 0, 5], max: [20, 15, 5] };
    expect(removalDiagnosis({
      hasProgram: true, feeds: 20, removedVolume: 0, cutBounds: shallow, box: BOX,
    })).toMatch(/above the blank/);
  });

  it('catches a toolpath that misses in XY', () => {
    const away = { min: [200, 200, -8], max: [220, 215, -8] };
    expect(removalDiagnosis({
      hasProgram: true, feeds: 20, removedVolume: 0, cutBounds: away, box: BOX,
    })).toMatch(/misses the blank in XY/);
  });

  it('falls back to a plain statement when nothing specific fits', () => {
    expect(removalDiagnosis({
      hasProgram: true, feeds: 20, removedVolume: 0, cutBounds: CUT, box: BOX,
    })).toMatch(/removed nothing/);
  });

  it('says something usable with no blank or bounds to reason about', () => {
    const msg = removalDiagnosis({ hasProgram: true, feeds: 5, removedVolume: 0 });
    expect(msg).toBeTruthy();
  });
});

describe('cuttingBounds ignores the rapids', () => {
  const prog = 'G21 G90\nG0 X0 Y0 Z50\nG1 Z-8 F200\nG1 X20 F400\nG0 Z50';

  it('measures the cuts, not the retract height', () => {
    // A rapid at Z50 over a blank whose top is Z0 proves nothing about the
    // material, and including it would defeat every Z check.
    const b = cuttingBounds(interpret(prog, { mode: 'mill' }).segments);
    expect(b.max[2]).toBeLessThan(50);
    expect(b.min[2]).toBeCloseTo(-8);
  });

  it('has nothing to report for a program that only rapids', () => {
    expect(cuttingBounds(interpret('G0 X0 Y0 Z5\nG0 X10', { mode: 'mill' }).segments))
      .toBeNull();
    expect(cuttingBounds([])).toBeNull();
    expect(cuttingBounds(null)).toBeNull();
  });
});
