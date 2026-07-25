import { describe, it, expect } from 'vitest';
import {
  usesRotary, droAxisLabels, formatCoord, absoluteValue, droRows, showDro, droXNote,
} from './dro.js';

describe('usesRotary', () => {
  it('is false for a 3-axis program that never leaves A0', () => {
    expect(usesRotary([0])).toBe(false);
    expect(usesRotary([])).toBe(false);
    expect(usesRotary(null)).toBe(false);
  });

  it('is true once a program indexes anywhere else', () => {
    expect(usesRotary([0, 90, 180, 270])).toBe(true);
  });

  it('is true for a program that sits at a single non-zero index', () => {
    // A fixture already clocked to 90° still has a rotary axis to report.
    expect(usesRotary([90])).toBe(true);
  });
});

describe('droAxisLabels', () => {
  it('lists X Y Z for milling', () => {
    expect(droAxisLabels({ mode: 'mill' })).toEqual(['X', 'Y', 'Z']);
  });

  it('adds A only when the program indexes', () => {
    expect(droAxisLabels({ mode: 'mill', rotary: true })).toEqual(['X', 'Y', 'Z', 'A']);
  });

  it('drops Y on the lathe — turn mode works the ZX plane', () => {
    expect(droAxisLabels({ mode: 'turn' })).toEqual(['X', 'Z']);
  });

  it('defaults to milling with no options at all', () => {
    expect(droAxisLabels()).toEqual(['X', 'Y', 'Z']);
  });
});

describe('formatCoord', () => {
  it('posts microns, like the program', () => {
    expect(formatCoord(12.3456)).toBe('12.346');
    expect(formatCoord(-7)).toBe('-7.000');
  });

  it('folds a signed zero — -0.000 is not a position', () => {
    expect(formatCoord(-0)).toBe('0.000');
    expect(formatCoord(-1e-9)).toBe('0.000');
  });

  it('never goes exponential on a big or tiny number', () => {
    expect(formatCoord(1e-7)).toBe('0.000');
    expect(formatCoord(123456.789)).toBe('123456.789');
  });

  it('reads zero rather than NaN for a missing value', () => {
    expect(formatCoord(undefined)).toBe('0.000');
    expect(formatCoord(NaN)).toBe('0.000');
  });
});

describe('absoluteValue', () => {
  const point = [10, 20, -5];

  it('passes milling coordinates through untouched — they are already absolute', () => {
    expect(absoluteValue('X', point, { mode: 'mill' })).toBe(10);
    expect(absoluteValue('Y', point, { mode: 'mill' })).toBe(20);
    expect(absoluteValue('Z', point, { mode: 'mill' })).toBe(-5);
  });

  it('doubles X back to a diameter on a diameter lathe', () => {
    // interpreter.js halves the X word into a radius; the ABSOLUTE page shows
    // the diameter the programmer typed.
    expect(absoluteValue('X', [12.5, 0, -30], { mode: 'turn', diameterMode: true })).toBe(25);
  });

  it('leaves X alone on a radius-programmed lathe', () => {
    expect(absoluteValue('X', [12.5, 0, -30], { mode: 'turn', diameterMode: false })).toBe(12.5);
  });

  it('never doubles X for milling, whatever diameterMode says', () => {
    // diameterMode is a lathe setting; it must not leak into a mill readout.
    expect(absoluteValue('X', point, { mode: 'mill', diameterMode: true })).toBe(10);
  });

  it('reads the rotary index for A', () => {
    expect(absoluteValue('A', point, { rotary: { a: 90, b: 0 } })).toBe(90);
    expect(absoluteValue('B', point, { rotary: { a: 90, b: 45 } })).toBe(45);
  });

  it('reads zero before the playhead has moved', () => {
    expect(absoluteValue('X', null)).toBe(0);
    expect(absoluteValue('A', null)).toBe(0);
  });
});

describe('droRows', () => {
  it('gives a mill three rows in mm', () => {
    const rows = droRows([1, 2, 3], { mode: 'mill' });
    expect(rows.map((r) => r.label)).toEqual(['X', 'Y', 'Z']);
    expect(rows.map((r) => r.text)).toEqual(['1.000', '2.000', '3.000']);
    expect(rows.every((r) => r.unit === 'mm')).toBe(true);
  });

  it('adds an A row in degrees for a 4-axis program', () => {
    const rows = droRows([1, 2, 3], { aIndices: [0, 90], rotary: { a: 90, b: 0 } });
    const a = rows.find((r) => r.label === 'A');
    expect(a.text).toBe('90.000');
    expect(a.unit).toBe('deg');
  });

  it('posts the lathe X as a diameter and skips Y', () => {
    const rows = droRows([12.5, 0, -30], { mode: 'turn', diameterMode: true });
    expect(rows.map((r) => r.label)).toEqual(['X', 'Z']);
    expect(rows[0].text).toBe('25.000');
    expect(rows[1].text).toBe('-30.000');
  });

  it('reads all zeros with no position yet, rather than blanks', () => {
    const rows = droRows(null, { mode: 'mill' });
    expect(rows.map((r) => r.text)).toEqual(['0.000', '0.000', '0.000']);
  });

  it('carries the numeric value alongside the text, for the view to style on', () => {
    const rows = droRows([-1.5, 0, 0], { mode: 'mill' });
    expect(rows[0].value).toBe(-1.5);
  });
});

describe('showDro', () => {
  it('appears once a program is loaded', () => {
    expect(showDro({ count: 1200 })).toBe(true);
  });

  it('stays on screen while parked — a control does not blank its position page', () => {
    // No playhead argument at all: parked at 0 is still a position.
    expect(showDro({ count: 1200, sketching: false })).toBe(true);
  });

  it('is hidden with no program', () => {
    expect(showDro({ count: 0 })).toBe(false);
    expect(showDro()).toBe(false);
  });

  it('is hidden on the sketch page — no machine there', () => {
    expect(showDro({ sketching: true, count: 1200 })).toBe(false);
  });
});

describe('droXNote', () => {
  it('marks X as a diameter on a diameter lathe', () => {
    expect(droXNote({ mode: 'turn', diameterMode: true })).toBe('⌀');
  });

  it('says nothing when it would be noise', () => {
    expect(droXNote({ mode: 'turn', diameterMode: false })).toBe(null);
    expect(droXNote({ mode: 'mill', diameterMode: true })).toBe(null);
  });
});
