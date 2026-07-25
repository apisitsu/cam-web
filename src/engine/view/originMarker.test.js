import { describe, it, expect } from 'vitest';
import { originMarkerSize, rotaryAxisLength } from './originMarker.js';

describe('originMarkerSize', () => {
  it('scales with the part, so a lathe bar and a pin get different markers', () => {
    const small = originMarkerSize({ diagonal: 20 });
    const big = originMarkerSize({ diagonal: 600 });
    expect(big).toBeGreaterThan(small);
  });

  it('never collapses to nothing for a tiny part', () => {
    expect(originMarkerSize({ diagonal: 1 })).toBeGreaterThanOrEqual(2);
  });

  it('falls back to a sane default with no bounds at all', () => {
    expect(originMarkerSize(null)).toBeGreaterThan(0);
    expect(originMarkerSize({})).toBeGreaterThan(0);
  });
});

describe('rotaryAxisLength', () => {
  it('spans past the part along X, with margin either side', () => {
    expect(rotaryAxisLength({ size: [120, 30, 20] })).toBeGreaterThan(120);
  });

  it('scales with a longer part', () => {
    const short = rotaryAxisLength({ size: [50, 10, 10] });
    const long = rotaryAxisLength({ size: [500, 10, 10] });
    expect(long).toBeGreaterThan(short);
  });

  it('falls back to a sane default with no bounds at all', () => {
    expect(rotaryAxisLength(null)).toBeGreaterThan(0);
    expect(rotaryAxisLength({})).toBeGreaterThan(0);
  });
});
