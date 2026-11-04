import { describe, it, expect } from 'vitest';
import { toolSpecSummary } from './toolRow.js';

describe('toolSpecSummary — the Tool table row at a glance', () => {
  it('reads the holder label on a lathe, not a cutter label', () => {
    expect(toolSpecSummary({ turning: true, diameter: 12, holderLabel: 'MVJNR · 93° OD (insert adj.)', cutterLabel: 'Endmill' }))
      .toBe('⌀12 · MVJNR · 93° OD (insert adj.)');
  });

  it('reads the cutter label on a mill, not a holder label', () => {
    expect(toolSpecSummary({ turning: false, diameter: 7, holderLabel: 'MVJNR', cutterLabel: 'Endmill' }))
      .toBe('⌀7 · Endmill');
  });

  it('falls back to a bare diameter with nothing else known', () => {
    expect(toolSpecSummary({ turning: false, diameter: 7 })).toBe('⌀7');
  });

  it('shows a dash rather than inventing a diameter', () => {
    expect(toolSpecSummary({ turning: false, diameter: null, cutterLabel: 'Endmill' })).toBe('⌀— · Endmill');
    expect(toolSpecSummary({})).toBe('⌀—');
  });
});
