import { describe, it, expect } from 'vitest';
import {
  millingSpeeds, turningSpeeds, millingEngagement, drillingSpeeds,
  chipload, cuttingTime, DEFAULT_MACHINE,
} from './feeds.js';
import {
  materialById, largestToolFitting, drillForHole, toolById, MATERIALS,
} from './library.js';

describe('library', () => {
  it('falls back to the default material instead of throwing', () => {
    expect(materialById('unobtainium').id).toBe('aluminium');
  });

  it('every material carries the fields the formulas read', () => {
    for (const m of MATERIALS) {
      for (const k of ['vcMill', 'vcTurn', 'fzBase', 'fnTurn', 'apFactor', 'aeFactor']) {
        expect(typeof m[k], `${m.id}.${k}`).toBe('number');
        expect(m[k]).toBeGreaterThan(0);
      }
    }
  });

  it('picks the largest endmill that clears an inside corner', () => {
    // A 3 mm inside radius admits at most a Ø6 cutter.
    expect(largestToolFitting('endmill', { maxRadius: 3 }).diameter).toBe(6);
    expect(largestToolFitting('endmill', { maxRadius: 2.9 }).diameter).toBe(4);
  });

  it('will not pick a tool too short for the depth', () => {
    // Ø20 has 45 mm of flute; asking for 60 mm forces a different answer or none.
    const t = largestToolFitting('endmill', { maxRadius: 100, depth: 60 });
    expect(t).toBeNull();
    expect(largestToolFitting('endmill', { maxRadius: 100, depth: 40 }).diameter).toBe(20);
  });

  it('returns null when nothing in the library fits', () => {
    expect(largestToolFitting('endmill', { maxRadius: 0.2 })).toBeNull();
  });

  it('prefers a drill at or under the measured hole', () => {
    // Faceted STL holes read undersized, so overcutting is the dangerous error.
    expect(drillForHole(10).diameter).toBe(10);
    expect(drillForHole(9.85).diameter).toBe(10); // within tolerance, rounds up
    expect(drillForHole(9.4).diameter).toBe(9);
    expect(drillForHole(0.5)).toBeNull();
  });

  it('resolves tools by id across all three families', () => {
    expect(toolById('em10').diameter).toBe(10);
    expect(toolById('dr8').diameter).toBe(8);
    expect(toolById('cnmg-rough').noseRadius).toBe(0.8);
    expect(toolById('nope')).toBeUndefined();
  });
});

describe('millingSpeeds', () => {
  it('matches the textbook formula when nothing is clamped', () => {
    // Mild steel Vc=150, Ø10: S = 1000*150/(pi*10) = 4775 rpm
    const r = millingSpeeds({ material: 'mild-steel', diameter: 10, flutes: 4 });
    expect(r.rpm).toBe(4775);
    expect(r.limitedBy).toBeNull();
    // F = S * z * fz, with fz = fzBase at the 10 mm reference diameter
    expect(r.feed).toBe(Math.round(4775 * 4 * 0.04));
  });

  it('clamps a small cutter in aluminium to the spindle maximum', () => {
    // Ø2 in aluminium ideally wants ~63,000 rpm — no machine has it.
    const r = millingSpeeds({ material: 'aluminium', diameter: 2, flutes: 2 });
    expect(r.idealRpm).toBeGreaterThan(60000);
    expect(r.rpm).toBe(DEFAULT_MACHINE.maxRpm);
    expect(r.limitedBy).toBe('maxRpm');
    // The reported Vc must be the one actually achieved, not the table value.
    expect(r.vc).toBeLessThan(100);
  });

  it('reports maxFeed when the feedrate is what binds', () => {
    const r = millingSpeeds({
      material: 'aluminium', diameter: 20, flutes: 4,
      machine: { ...DEFAULT_MACHINE, maxFeed: 500 },
    });
    expect(r.feed).toBe(500);
    expect(r.limitedBy).toBe('maxFeed');
  });

  it('raises rpm for a finishing pass via vcScale', () => {
    const rough = millingSpeeds({ material: 'mild-steel', diameter: 10, flutes: 4 });
    const finish = millingSpeeds({ material: 'mild-steel', diameter: 10, flutes: 4, vcScale: 1.3 });
    expect(finish.rpm).toBeGreaterThan(rough.rpm);
  });

  it('does not divide by zero on a nonsense diameter', () => {
    const r = millingSpeeds({ material: 'aluminium', diameter: 0, flutes: 2 });
    expect(Number.isFinite(r.rpm)).toBe(true);
  });
});

describe('chipload', () => {
  it('is the table value at the 10 mm reference diameter', () => {
    expect(chipload('mild-steel', 10)).toBeCloseTo(0.04, 6);
  });

  it('scales down for small cutters and up for large', () => {
    expect(chipload('mild-steel', 3)).toBeLessThan(chipload('mild-steel', 10));
    expect(chipload('mild-steel', 20)).toBeGreaterThan(chipload('mild-steel', 10));
    // sqrt scaling: Ø20 is sqrt(2) times the Ø10 chipload
    expect(chipload('mild-steel', 20)).toBeCloseTo(0.04 * Math.SQRT2, 6);
  });
});

describe('turningSpeeds', () => {
  it('computes rpm at the diameter being cut', () => {
    // Mild steel Vc=200, Ø50: S = 1000*200/(pi*50) = 1273 rpm
    const r = turningSpeeds({ material: 'mild-steel', diameter: 50 });
    expect(r.rpm).toBe(1273);
    expect(r.feed).toBeCloseTo(0.12, 3); // mm/rev, not mm/min
  });

  it('rises as the tool works toward centre, and clamps there', () => {
    const big = turningSpeeds({ material: 'mild-steel', diameter: 50 });
    const small = turningSpeeds({ material: 'mild-steel', diameter: 5 });
    expect(small.rpm).toBeGreaterThan(big.rpm);
    // Near centre the ideal rpm runs away — this is why G96 needs a G50 clamp.
    const centre = turningSpeeds({ material: 'mild-steel', diameter: 0.5 });
    expect(centre.idealRpm).toBeGreaterThan(centre.clampRpm);
    expect(centre.rpm).toBe(centre.clampRpm);
    expect(centre.limitedBy).toBe('maxRpm');
  });

  it('predicts a better finish from a lighter feed and a bigger nose', () => {
    const coarse = turningSpeeds({ material: 'mild-steel', diameter: 50, noseRadius: 0.4 });
    const fine = turningSpeeds({ material: 'mild-steel', diameter: 50, fnScale: 0.5, noseRadius: 0.4 });
    const blunt = turningSpeeds({ material: 'mild-steel', diameter: 50, noseRadius: 0.8 });
    expect(fine.estimatedRa).toBeLessThan(coarse.estimatedRa);
    expect(blunt.estimatedRa).toBeLessThan(coarse.estimatedRa);
  });
});

describe('millingEngagement', () => {
  it('takes a deeper, wider cut in aluminium than in titanium', () => {
    const al = millingEngagement({ material: 'aluminium', diameter: 10 });
    const ti = millingEngagement({ material: 'titanium', diameter: 10 });
    expect(al.ap).toBeGreaterThan(ti.ap);
    expect(al.ae).toBeGreaterThan(ti.ae);
  });

  it('keeps a facemill shallow regardless of its diameter', () => {
    const fm = millingEngagement({ material: 'aluminium', diameter: 63, type: 'facemill' });
    expect(fm.ap).toBeLessThanOrEqual(2);
    expect(fm.ae).toBeCloseTo(63 * 0.7, 3);
  });
});

describe('drillingSpeeds', () => {
  it('calls for G81 on a shallow hole and G83 on a deep one', () => {
    const shallow = drillingSpeeds({ material: 'mild-steel', diameter: 8, depth: 16 });
    expect(shallow.cycle).toBe('G81');
    expect(shallow.peck).toBeNull();

    const deep = drillingSpeeds({ material: 'mild-steel', diameter: 8, depth: 50 });
    expect(deep.cycle).toBe('G83');
    expect(deep.peck).toBeGreaterThan(0);
    expect(deep.depthRatio).toBeCloseTo(6.25, 2);
  });

  it('runs slower than an endmill of the same size', () => {
    const drill = drillingSpeeds({ material: 'mild-steel', diameter: 10, depth: 20 });
    const mill = millingSpeeds({ material: 'mild-steel', diameter: 10, flutes: 4 });
    expect(drill.rpm).toBeLessThan(mill.rpm);
  });
});

describe('cuttingTime', () => {
  it('converts path length and feed into minutes', () => {
    expect(cuttingTime(1000, 500)).toBeCloseTo(2, 6);
  });

  it('returns zero rather than Infinity on a zero feed', () => {
    expect(cuttingTime(1000, 0)).toBe(0);
  });
});
