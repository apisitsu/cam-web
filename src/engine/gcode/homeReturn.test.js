import { describe, it, expect } from 'vitest';
import { interpret } from './interpreter.js';
import { homeEstimate, machineById } from '../cam/machines.js';

const PROG = [
  'G90 G0 X0 Y0 Z5.',
  'G1 Z-1. F600',
  'G0 Z5.',
  'G91 G28 Z0.',
  'G90',
  'G0 X10. Y0',
  'G1 Z-1. F600',
  'G0 Z5.',
  'G91 G28 Z0.',
  'M30',
].join('\n');

describe('G28 return-to-reference with a machine home', () => {
  it('without a home: warns, and adds no travel', () => {
    const r = interpret(PROG, { rapidRate: 6000 });
    expect(r.stats.warnings.some((w) => w.includes('return-to-reference'))).toBe(true);
    expect(r.stats.homeLength).toBe(0);
  });

  it('with a home: times the leg up and the leg back, no warning, bounds untouched', () => {
    const plain = interpret(PROG, { rapidRate: 6000 });
    const r = interpret(PROG, { rapidRate: 6000, home: { X: 300, Y: 200, Z: 255 } });
    expect(r.stats.warnings.some((w) => w.includes('return-to-reference'))).toBe(false);
    // Up 250 and back down 250 after the first G28; up 250 at the end, never back.
    expect(r.stats.homeLength).toBeCloseTo(750, 6);
    expect(r.stats.rapidLength - plain.stats.rapidLength).toBeCloseTo(750, 6);
    expect(r.stats.cycleTime - plain.stats.cycleTime).toBeCloseTo((750 / 6000) * 60, 6);
    expect(r.bounds.max[2]).toBe(plain.bounds.max[2]);
  });

  it('a lathe X home is a diameter', () => {
    const r = interpret('G0 X20. Z2.\nG28 U0. W0.\nM30', {
      mode: 'turn', rapidRate: 6000, home: { X: 220, Z: 100 },
    });
    // From X10 (radius) Z2 to X110 Z100.
    expect(r.stats.homeLength).toBeCloseTo(Math.hypot(100, 98), 6);
  });
});

describe('homeEstimate', () => {
  it('is half the stroke on a mill, the radial stroke as a diameter on a lathe', () => {
    const mill = machineById('fanuc-generic-vmc');
    const est = homeEstimate(mill);
    for (const a of mill.linear) expect(est[a]).toBe(Math.round(mill.travel[a] / 2));
    const lathe = machineById('fanuc-generic-lathe');
    expect(homeEstimate(lathe).X).toBe(lathe.travel.X);
  });
});
