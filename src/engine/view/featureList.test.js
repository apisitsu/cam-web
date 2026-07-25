import { describe, it, expect } from 'vitest';
import { visibleFeatures, hiddenNote, FEATURE_LIST_LIMIT } from './featureList.js';

const list = (n) => Array.from({ length: n }, (_, i) => ({ id: `F${i}` }));

describe('visibleFeatures', () => {
  it('shows a short list whole, and reports nothing hidden', () => {
    const items = list(12);
    const { shown, hidden } = visibleFeatures(items);
    expect(shown).toBe(items);          // same array, not a copy
    expect(hidden).toBe(0);
  });

  it('caps a long list and counts the remainder', () => {
    const { shown, hidden } = visibleFeatures(list(7060));
    expect(shown).toHaveLength(FEATURE_LIST_LIMIT);
    expect(hidden).toBe(7060 - FEATURE_LIST_LIMIT);
  });

  it('keeps the largest faces, since the list arrives sorted biggest-first', () => {
    // The prefix is the useful part only if order is preserved.
    const { shown } = visibleFeatures(list(500), 3);
    expect(shown.map((f) => f.id)).toEqual(['F0', 'F1', 'F2']);
  });

  it('treats exactly-at-the-limit as complete', () => {
    const { shown, hidden } = visibleFeatures(list(10), 10);
    expect(shown).toHaveLength(10);
    expect(hidden).toBe(0);
  });

  it('survives a missing list', () => {
    expect(visibleFeatures(undefined)).toEqual({ shown: [], hidden: 0 });
  });
});

describe('hiddenNote', () => {
  it('says nothing when the list was complete', () => {
    expect(hiddenNote(0)).toBeNull();
  });

  it('points the operator at the model for the rest', () => {
    expect(hiddenNote(6910)).toContain('6910');
    expect(hiddenNote(6910)).toContain('click the model');
  });

  it('gets the singular right', () => {
    expect(hiddenNote(1)).toContain('1 smaller face —');
    expect(hiddenNote(2)).toContain('2 smaller faces');
  });

  it('takes the noun for edges', () => {
    expect(hiddenNote(3, 'edge')).toContain('smaller edges');
  });
});
