import { describe, it, expect } from 'vitest';
import {
  KINDS, NAME_MAX, libraryKey, cleanName, requireName, suggestName, uniqueName,
  programLines, byteLength, describe as describeRecord, buildRecord, readPayload,
  sortLibrary, namesOfKind, formatBytes, formatSavedAt,
} from './savedWork.js';
import { buildProject } from './projectFile.js';

describe('libraryKey — what makes two saves the same save', () => {
  it('is the kind and the name, so re-saving replaces rather than piling up', () => {
    expect(libraryKey('project', 'OR35128 OP10')).toBe('project/OR35128 OP10');
    expect(libraryKey('program', 'OR35128 OP10')).not.toBe(libraryKey('project', 'OR35128 OP10'));
  });

  it('covers both kinds the library holds', () => {
    expect(KINDS).toEqual(['program', 'project']);
  });
});

describe('cleanName', () => {
  it('collapses whitespace and trims, so " part" and "part " are one name', () => {
    expect(cleanName('  OR35128   OP10 ')).toBe('OR35128 OP10');
  });

  it('strips the control characters a pasted name brings', () => {
    expect(cleanName('OP10\n\tfinish')).toBe('OP10 finish');
  });

  it('caps the length, and does not leave a trailing space behind the cut', () => {
    const long = `${'x'.repeat(NAME_MAX - 1)} tail`;
    const out = cleanName(long);
    expect(out.length).toBeLessThanOrEqual(NAME_MAX);
    expect(out).toBe(out.trim());
  });

  it('reads nothing out of nothing', () => {
    expect(cleanName('')).toBe('');
    expect(cleanName(null)).toBe('');
    expect(cleanName('   ')).toBe('');
  });
});

describe('requireName', () => {
  it('hands back the cleaned name', () => {
    expect(requireName('  Bearing ring ')).toBe('Bearing ring');
  });

  it('refuses an empty one rather than saving something nobody can find', () => {
    expect(() => requireName('  ')).toThrow(/name/i);
  });
});

describe('suggestName', () => {
  it('offers the loaded file without its extension', () => {
    expect(suggestName('OR35128_OP20.NC')).toBe('OR35128_OP20');
    expect(suggestName('C:\\jobs\\bracket.camweb.json')).toBe('bracket.camweb');
  });

  it('falls back when there is nothing loaded', () => {
    expect(suggestName(null, 'Project')).toBe('Project');
    expect(suggestName('', 'Program')).toBe('Program');
  });
});

describe('uniqueName', () => {
  it('leaves a free name alone', () => {
    expect(uniqueName('OP10', ['OP20'])).toBe('OP10');
  });

  it('counts up past the ones taken', () => {
    expect(uniqueName('OP10', ['OP10'])).toBe('OP10 (2)');
    expect(uniqueName('OP10', ['OP10', 'OP10 (2)'])).toBe('OP10 (3)');
  });

  it('keeps the suffix legible by trimming the name, not the number', () => {
    const base = 'y'.repeat(NAME_MAX);
    const out = uniqueName(base, [base]);
    expect(out.length).toBeLessThanOrEqual(NAME_MAX);
    expect(out.endsWith(' (2)')).toBe(true);
  });

  it('takes a Set as readily as an array', () => {
    expect(uniqueName('OP10', new Set(['OP10']))).toBe('OP10 (2)');
  });
});

describe('programLines — blocks, not lines', () => {
  it('does not count blank lines', () => {
    expect(programLines('G21\n\nG0 X0\n   \nM30')).toBe(3);
  });

  it('is zero for nothing at all', () => {
    expect(programLines('')).toBe(0);
    expect(programLines(null)).toBe(0);
  });
});

describe('the line the list shows under a name', () => {
  it('counts a program in blocks', () => {
    expect(describeRecord('program', { gcode: 'G21\nG0 X0\nM30' })).toBe('3 blocks');
    expect(describeRecord('program', { gcode: 'M30' })).toBe('1 block');
  });

  it('says what a project actually contains', () => {
    const project = buildProject({
      gcode: 'G21\nG0 X0\nM30',
      cam: { ops: [{}, {}, {}], part: { name: 'ring' } },
      sketch: { entities: [] },
    });
    expect(describeRecord('project', { project }))
      .toBe('3 blocks · 3 ops · a part · a sketch');
  });

  it('says so when a project has nothing in it', () => {
    expect(describeRecord('project', { project: buildProject({}) })).toBe('empty');
  });
});

describe('buildRecord — the row and the payload', () => {
  const gcode = 'G21 G90\nG0 X0 Y0\nG1 Z-2 F200\nM30';

  it('splits a program into a small row and its text', () => {
    const { meta, data } = buildRecord({
      kind: 'program', name: 'OP10', gcode, mode: 'mill', savedAt: '2026-08-05T09:00:00.000Z',
    });
    expect(meta).toEqual({
      key: 'program/OP10',
      kind: 'program',
      name: 'OP10',
      savedAt: '2026-08-05T09:00:00.000Z',
      version: 1,
      mode: 'mill',
      bytes: byteLength(gcode),
      note: '4 blocks',
    });
    expect(data.gcode).toBe(gcode);
    // Both halves under one key, so a delete cannot leave one behind.
    expect(data.key).toBe(meta.key);
  });

  it('keeps a project whole, and sizes the row by the document', () => {
    const project = buildProject({ gcode, settings: { mode: 'turn' } });
    const { meta, data } = buildRecord({ kind: 'project', name: 'Ring OP20', project });
    expect(meta.kind).toBe('project');
    expect(meta.mode).toBe('turn');
    expect(meta.bytes).toBe(byteLength(JSON.stringify(project)));
    expect(data.project).toBe(project);
  });

  it('stamps the time itself when the caller does not', () => {
    const { meta } = buildRecord({ kind: 'program', name: 'OP10', gcode });
    expect(Number.isFinite(Date.parse(meta.savedAt))).toBe(true);
  });

  it('cleans the name into the key, so one name is one record', () => {
    const a = buildRecord({ kind: 'program', name: ' OP10 ', gcode });
    const b = buildRecord({ kind: 'program', name: 'OP10', gcode });
    expect(a.meta.key).toBe(b.meta.key);
  });

  it('refuses what it cannot save', () => {
    expect(() => buildRecord({ kind: 'program', name: '', gcode })).toThrow(/name/i);
    expect(() => buildRecord({ kind: 'project', name: 'x', project: null })).toThrow(/no project/i);
    expect(() => buildRecord({ kind: 'setup', name: 'x' })).toThrow(/Unknown kind/);
  });
});

describe('readPayload — what comes back out', () => {
  it('reads a program back', () => {
    const { data } = buildRecord({ kind: 'program', name: 'OP10', gcode: 'M30' });
    expect(readPayload(data)).toEqual({ kind: 'program', name: 'OP10', gcode: 'M30' });
  });

  it('reads a project back', () => {
    const project = buildProject({ gcode: 'M30' });
    const { data } = buildRecord({ kind: 'project', name: 'Ring', project });
    expect(readPayload(data).project).toBe(project);
  });

  it('says so rather than applying half a record', () => {
    // A tab killed mid-save, or a record from a build that stored something else.
    expect(() => readPayload(null)).toThrow(/could not be read/i);
    expect(() => readPayload({ kind: 'program' })).toThrow(/no text/i);
    expect(() => readPayload({ kind: 'project' })).toThrow(/empty/i);
    expect(() => readPayload({ kind: 'project', project: { kind: 'something-else' } }))
      .toThrow(/not a cam-web project/i);
    expect(() => readPayload({ kind: 'toolpath' })).toThrow(/does not know/i);
  });
});

describe('sortLibrary', () => {
  const at = (name, savedAt) => ({ name, savedAt, kind: 'project' });

  it('puts the most recent first — the thing you were just working on', () => {
    const list = sortLibrary([
      at('old', '2026-08-01T10:00:00.000Z'),
      at('new', '2026-08-05T10:00:00.000Z'),
      at('mid', '2026-08-03T10:00:00.000Z'),
    ]);
    expect(list.map((x) => x.name)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks a tie by name, so the order does not wander', () => {
    const same = '2026-08-05T10:00:00.000Z';
    expect(sortLibrary([at('b', same), at('a', same)]).map((x) => x.name)).toEqual(['a', 'b']);
  });

  it('does not mutate what it was given', () => {
    const input = [at('old', '2026-08-01T10:00:00.000Z'), at('new', '2026-08-05T10:00:00.000Z')];
    sortLibrary(input);
    expect(input[0].name).toBe('old');
  });

  it('survives a row with no date on it', () => {
    expect(sortLibrary([at('a', null), at('b', '2026-08-05T10:00:00.000Z')])[0].name).toBe('b');
  });
});

describe('namesOfKind', () => {
  it('only counts names of the kind being saved', () => {
    const metas = [
      { kind: 'project', name: 'OP10' },
      { kind: 'program', name: 'OP20' },
    ];
    expect(namesOfKind(metas, 'project')).toEqual(new Set(['OP10']));
    // A project called OP20 is free even though a program has that name.
    expect(uniqueName('OP20', namesOfKind(metas, 'project'))).toBe('OP20');
  });
});

describe('the numbers the list shows', () => {
  it('reads a size the way a person would', () => {
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(41200)).toBe('41.2 kB');
    expect(formatBytes(3.4e6)).toBe('3.4 MB');
    expect(formatBytes(undefined)).toBe('0 B');
  });

  it('shows the time for today and the date for anything older', () => {
    // Built in local time on purpose: "today" is the operator's day, not UTC's,
    // and a machine in +07 saving at 09:00Z saved this afternoon.
    const now = new Date(2026, 7, 5, 18, 0);
    const earlierToday = new Date(2026, 7, 5, 9, 15);
    const lastMonth = new Date(2026, 6, 1, 9, 15);
    expect(formatSavedAt(earlierToday.toISOString(), now)).toBe(
      earlierToday.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    );
    expect(formatSavedAt(lastMonth.toISOString(), now))
      .toContain(lastMonth.toLocaleDateString());
  });

  it('says nothing for a missing date rather than "Invalid Date"', () => {
    expect(formatSavedAt(null)).toBe('');
    expect(formatSavedAt('not a date')).toBe('');
  });
});
