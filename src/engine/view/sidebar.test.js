import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sidebarSections, isRunMode, SECTIONS, RUN_SECTIONS } from './sidebar.js';

// Resolved against this file, not the working directory. `'src/App.jsx'` only
// finds anything when the runner is started from the cam-web root; inside
// EngineerSystem the app is a subtree of a much larger src/ and the test read a
// path that does not exist there — silently, because a file it cannot read
// yields no `show.x` matches, which is not distinguishable from a clean App.
const APP_JSX = new URL('../../App.jsx', import.meta.url);

describe('sidebarSections while set up', () => {
  it('shows everything when the program is not running', () => {
    const s = sidebarSections({ playing: false });
    expect(SECTIONS.every((name) => s[name])).toBe(true);
  });

  it('shows everything with no state at all', () => {
    const s = sidebarSections();
    expect(SECTIONS.every((name) => s[name])).toBe(true);
  });
});

describe('sidebarSections while running', () => {
  it('collapses to the program listing', () => {
    const s = sidebarSections({ playing: true });
    expect(s.program).toBe(true);
  });

  it('hides every setup section — that is the point', () => {
    const s = sidebarSections({ playing: true });
    for (const name of ['files', 'project', 'cam', 'machine', 'warnings', 'tools', 'removal']) {
      // eslint-disable-next-line jest/valid-expect
      expect(s[name], name).toBe(false);
    }
  });

  it('never suppresses a parse error', () => {
    // Hiding a failure behind a mode change would leave the app looking broken
    // with no explanation on screen.
    expect(sidebarSections({ playing: true }).errors).toBe(true);
  });

  it('keeps exactly the sections it advertises', () => {
    const s = sidebarSections({ playing: true });
    const shown = SECTIONS.filter((name) => s[name]);
    expect(shown.sort()).toEqual([...RUN_SECTIONS].sort());
  });

  it('answers for every known section, and nothing else', () => {
    // A section the view asks about but the engine forgot would be `undefined`,
    // which is falsy — the block would silently vanish in both modes.
    const s = sidebarSections({ playing: true });
    expect(Object.keys(s).sort()).toEqual([...SECTIONS].sort());
  });
});

describe('the names App actually asks for', () => {
  // A typo — `show.file` for `show.files` — is `undefined`, which is falsy, so
  // the section would vanish in *both* modes and no other test would notice.
  // Cheap to guard, and the failure is otherwise invisible.
  it('are all real sections', () => {
    const src = readFileSync(APP_JSX, 'utf8');
    const used = [...src.matchAll(/\bshow\.([a-zA-Z]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    // eslint-disable-next-line jest/valid-expect
    for (const name of used) expect(SECTIONS, `show.${name}`).toContain(name);
  });

  it('cover every section that is meant to be collapsible', () => {
    // program and errors are rendered unconditionally — they survive run mode —
    // so every *other* section must be gated, or Play would leave it on screen.
    const src = readFileSync(APP_JSX, 'utf8');
    const used = new Set([...src.matchAll(/\bshow\.([a-zA-Z]+)/g)].map((m) => m[1]));
    for (const name of SECTIONS) {
      if (RUN_SECTIONS.includes(name)) continue;
      // eslint-disable-next-line jest/valid-expect
      expect(used, `show.${name} is missing from App.jsx`).toContain(name);
    }
  });
});

describe('isRunMode', () => {
  it('is on while playing and off when paused', () => {
    expect(isRunMode({ playing: true })).toBe(true);
    expect(isRunMode({ playing: false })).toBe(false);
    expect(isRunMode()).toBe(false);
  });
});
