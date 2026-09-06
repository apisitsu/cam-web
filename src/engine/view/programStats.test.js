import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { formatDuration, programStatRows, timingBreakdown } from './programStats.js';

// Resolved against this file, not the working directory — see sidebar.test.js for why
// a relative 'src/App.jsx' silently reads nothing inside EngineerSystem's larger src/.
const APP_JSX = new URL('../../App.jsx', import.meta.url);

const STATS = {
  blocks: 355,
  rapidLength: 1234.56,
  feedLength: 12345.67,
  rapidTime: 14,
  feedTime: 50,
  dwellTime: 0,
  cycleTime: 64,
};

describe('formatDuration', () => {
  it('posts m:ss the way a control does', () => {
    expect(formatDuration(64)).toBe('1:04');
    expect(formatDuration(3)).toBe('0:03');
  });

  it('grows an hours field only when there are hours', () => {
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(599)).toBe('9:59');
  });

  it('refuses to render nonsense as a time', () => {
    // A program that failed to parse has no times; '0:00' is honest, 'NaN:aN' is not.
    for (const v of [0, -1, NaN, Infinity, undefined, null]) {
      // eslint-disable-next-line jest/valid-expect
      expect(formatDuration(v), String(v)).toBe('0:00');
    }
  });
});

describe('programStatRows', () => {
  it('is empty until a program has been parsed', () => {
    // The view renders the panel from the length alone, so this is what keeps an
    // unparsed program from showing a rail of dashes.
    expect(programStatRows(null)).toEqual([]);
    expect(programStatRows(undefined)).toEqual([]);
  });

  it('carries the four numbers, in reading order', () => {
    expect(programStatRows(STATS).map((r) => r.key))
      .toEqual(['cycleTime', 'feedLength', 'rapidLength', 'blocks']);
  });

  it('formats each one the way it is read', () => {
    const by = Object.fromEntries(programStatRows(STATS).map((r) => [r.key, r]));
    expect(by.cycleTime.value).toBe('1:04');
    expect(by.feedLength.value).toBe('12,345.7');   // one decimal, thousands grouped
    expect(by.rapidLength.value).toBe('1,234.6');
    expect(by.blocks.value).toBe('355');            // a count has no decimals
  });

  it('groups with a comma whatever the host locale would do', () => {
    // A de-DE host groups with a dot, which would print 12.345,7 — read on the floor
    // as twelve millimetres. The locale is named in the module for exactly this.
    const [, cutting] = programStatRows(STATS);
    expect(cutting.value).not.toMatch(/^\d{1,3}\.\d{3}/);
    expect(cutting.value).toContain(',');
  });

  it('marks the two lengths as mm and leaves the others unitless', () => {
    const by = Object.fromEntries(programStatRows(STATS).map((r) => [r.key, r]));
    expect(by.feedLength.unit).toBe('mm');
    expect(by.rapidLength.unit).toBe('mm');
    expect(by.cycleTime.unit).toBeUndefined();
    expect(by.blocks.unit).toBeUndefined();
  });

  it('shows a dash rather than NaN for a missing field', () => {
    const [, cutting] = programStatRows({ cycleTime: 1 });
    expect(cutting.value).toBe('—');
  });
});

describe('timingBreakdown', () => {
  it('says where the cycle time went', () => {
    expect(timingBreakdown(STATS)).toBe('feed 0:50 · rapid 0:14');
  });

  it('names dwell only when the program dwells', () => {
    expect(timingBreakdown({ ...STATS, dwellTime: 5 })).toBe('feed 0:50 · rapid 0:14 · dwell 0:05');
    expect(timingBreakdown(STATS)).not.toContain('dwell');
  });

  it('is empty with no program', () => {
    expect(timingBreakdown(null)).toBe('');
  });
});

describe('the panel App actually draws', () => {
  // These numbers left the sidebar for the viewport. If a later edit puts them back
  // behind the Setup drawer they are once again hidden by the thing they describe,
  // and nothing else would notice — the sidebar renders fine either way.
  const src = () => readFileSync(APP_JSX, 'utf8');

  it('renders from the engine, not from a second copy of the formatting', () => {
    expect(src()).toMatch(/programStatRows\(/);
  });

  it('floats over the viewport rather than sitting in the sidebar', () => {
    expect(src()).toMatch(/data-cam-overlay="stats"/);
  });

  it('keeps one formatDuration — the engine\'s', () => {
    // It was a local function in App.jsx and the bottom rail still uses it; two copies
    // would drift, and the drift is invisible until two places disagree on a time.
    expect(src()).not.toMatch(/function formatDuration/);
  });
});
