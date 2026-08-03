import { describe, it, expect } from 'vitest';
import {
  COMMANDS, command, commandsIn, labelledCommands, ariaLabel,
} from './commands.js';

describe('every command can be understood without its label on screen', () => {
  it.each(COMMANDS)('$id has a name', ({ label }) => {
    // An icon-only button with no name announces itself as nothing.
    expect(label.trim().length).toBeGreaterThan(0);
  });

  it.each(COMMANDS)('$id has a hint', ({ hint }) => {
    expect(hint.trim().length).toBeGreaterThan(0);
  });

  it.each(COMMANDS)('$id says something new in its hint', ({ label, hint }) => {
    // A tooltip that only repeats the name has wasted the hover — the whole
    // trade for dropping the words is that hovering tells you more, not less.
    expect(hint.toLowerCase()).not.toBe(label.toLowerCase());
    expect(hint.length).toBeGreaterThan(label.length);
  });

  it.each(COMMANDS)('$id reads as a sentence, not a second label', ({ hint }) => {
    expect(hint.split(/\s+/).length).toBeGreaterThanOrEqual(4);
  });
});

describe('the catalogue is a usable index', () => {
  it('has no duplicate ids', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every command a group', () => {
    for (const c of COMMANDS) expect(c.group).toBeTruthy();
  });

  it('never repeats a name inside one rail', () => {
    // Two buttons side by side reading the same name is indistinguishable from
    // a bug, whichever glyphs they carry.
    for (const group of new Set(COMMANDS.map((c) => c.group))) {
      const labels = commandsIn(group).map((c) => c.label);
      expect(new Set(labels).size, `duplicate label in "${group}"`).toBe(labels.length);
    }
  });

  it('looks a command up by id', () => {
    expect(command('autoPlan').label).toBe('Auto-plan');
    expect(command('autoPlan').group).toBe('cam');
  });

  it('throws on an unknown id rather than rendering a nameless button', () => {
    expect(() => command('nope')).toThrow(/Unknown command id/);
  });

  it('returns a rail in catalogue order', () => {
    expect(commandsIn('playback').map((c) => c.id))
      .toEqual(['restart', 'stepBack', 'play', 'pause', 'stepForward']);
  });

  it('has no empty rails referenced by name', () => {
    for (const group of new Set(COMMANDS.map((c) => c.group))) {
      expect(commandsIn(group).length).toBeGreaterThan(0);
    }
  });
});

describe('keeping a label is the exception, and an argued one', () => {
  it('is a short list', () => {
    // Not a hard cap on the design — a tripwire. If this starts climbing, the
    // convention has quietly been abandoned rather than deliberately changed.
    expect(labelledCommands().length).toBeLessThanOrEqual(3);
  });

  it('makes every exception state its reason', () => {
    for (const c of labelledCommands()) {
      expect(c.keepsText.split(/\s+/).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('leaves the ordinary toolbar commands icon-only', () => {
    for (const id of ['parse', 'simulate', 'autoPlan', 'exportNc', 'verifyInViewport']) {
      expect(command(id).keepsText).toBeUndefined();
    }
  });

  it('keeps the dropdown trigger labelled — a bare glyph hides the menu', () => {
    expect(command('addOperation').keepsText).toBeTruthy();
  });
});

describe('ariaLabel', () => {
  it('is the same string the tooltip titles', () => {
    expect(ariaLabel('verifyInViewport')).toBe(command('verifyInViewport').label);
  });

  it('throws on an unknown id', () => {
    expect(() => ariaLabel('nope')).toThrow();
  });
});
