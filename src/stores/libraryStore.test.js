/**
 * The library store, against a stand-in database.
 *
 * IndexedDB does not exist under vitest, and mocking the browser's own
 * transactional API would only test the mock. What is worth testing is the
 * sequencing this store owns: that a save writes both halves of a record under
 * one key, that the list comes back newest-first, that a name offered for a
 * second save does not silently replace the first, that opening hands the work
 * to the same parse a dropped file uses, and that a failure lands in `error` as
 * a sentence instead of an unhandled rejection.
 *
 * So `lib/workDb.js` is replaced by a Map — the smallest thing with the same
 * contract — and everything above it is the real code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = { meta: new Map(), data: new Map(), fail: null };

vi.mock('../lib/workDb.js', () => ({
  dbAvailable: () => true,
  putRecord: async ({ meta, data }) => {
    if (db.fail) throw new Error(db.fail);
    db.meta.set(meta.key, meta);
    db.data.set(data.key, data);
    return meta;
  },
  listMeta: async () => [...db.meta.values()],
  getData: async (key) => db.data.get(key),
  deleteRecord: async (key) => { db.meta.delete(key); db.data.delete(key); return key; },
  clearAll: async () => { db.meta.clear(); db.data.clear(); },
  storageUse: async () => ({ usage: 1000, quota: 2000 }),
}));

// `applyProject` drives the G-code worker, which does not exist here. The rest
// of projectIO is real — `currentProject` gathering the session is exactly the
// part a save must not skip.
const applied = vi.fn(async () => {});
vi.mock('../lib/projectIO.js', async (importOriginal) => ({
  ...(await importOriginal()),
  applyProject: (doc) => applied(doc),
}));

const { useLibraryStore } = await import('./libraryStore.js');
const { useCamStore } = await import('./camStore.js');

const lib = () => useLibraryStore.getState();

const PROGRAM = 'G21 G90\nG0 X0 Y0\nG1 Z-2 F200\nM30';

beforeEach(() => {
  db.meta.clear();
  db.data.clear();
  db.fail = null;
  applied.mockClear();
  useLibraryStore.setState({ items: [], loaded: false, busy: false, error: null });
  useCamStore.setState({ gcode: PROGRAM, fileName: 'OR35128_OP10.NC', mode: 'mill' });
});

describe('saving', () => {
  it('keeps a program under the name it was given, and lists it', async () => {
    await lib().saveProgram('OP10');
    expect(lib().items.map((i) => i.name)).toEqual(['OP10']);
    expect(lib().items[0].kind).toBe('program');
    expect(lib().items[0].note).toBe('4 blocks');
    expect(lib().loaded).toBe(true);
  });

  it('keeps the whole session as a project', async () => {
    await lib().saveProject('OP10 setup');
    const meta = lib().items[0];
    expect(meta.kind).toBe('project');
    expect(db.data.get(meta.key).project.gcode).toBe(PROGRAM);
  });

  it('writes both halves under one key', async () => {
    const meta = await lib().saveProgram('OP10');
    expect(db.meta.has(meta.key)).toBe(true);
    expect(db.data.has(meta.key)).toBe(true);
  });

  it('refuses a program with nothing in it, rather than saving an empty file', async () => {
    useCamStore.setState({ gcode: '   ' });
    await expect(lib().saveProgram('OP10')).rejects.toThrow(/no program/i);
    expect(db.meta.size).toBe(0);
  });

  it('refuses an unnamed save', async () => {
    await expect(lib().saveProgram('  ')).rejects.toThrow(/name/i);
    expect(lib().error).toMatch(/name/i);
  });

  it('replaces when the same name is saved again — one name, one record', async () => {
    await lib().saveProgram('OP10');
    useCamStore.setState({ gcode: 'M30' });
    await lib().saveProgram('OP10');
    expect(lib().items).toHaveLength(1);
    expect(db.data.get('program/OP10').gcode).toBe('M30');
  });

  it('puts the database\'s own failure on screen as a sentence', async () => {
    db.fail = 'The disk is full.';
    await expect(lib().saveProgram('OP10')).rejects.toThrow();
    expect(lib().error).toBe('The disk is full.');
    expect(lib().busy).toBe(false);
  });
});

describe('the name it offers', () => {
  it('comes from the loaded program, without its extension', () => {
    expect(lib().suggestFor('project')).toBe('OR35128_OP10');
  });

  it('counts up rather than offering a name that would replace a save', async () => {
    await lib().saveProject('OR35128_OP10');
    expect(lib().suggestFor('project')).toBe('OR35128_OP10 (2)');
  });

  it('does not count a program of the same name against a project', async () => {
    await lib().saveProgram('OR35128_OP10');
    expect(lib().suggestFor('project')).toBe('OR35128_OP10');
  });

  it('falls back when nothing is loaded', () => {
    useCamStore.setState({ fileName: null });
    expect(lib().suggestFor('project')).toBe('Project');
    expect(lib().suggestFor('program')).toBe('Program');
  });

  it('reads the library before offering a name, so a first save cannot replace one', async () => {
    // The state a fresh session is in: something saved last week is in the
    // database, and this tab has never listed it. `suggestFor` alone would hand
    // back the taken name, and saving under it would overwrite without a word.
    db.meta.set('project/OR35128_OP10', {
      key: 'project/OR35128_OP10', kind: 'project', name: 'OR35128_OP10',
      savedAt: '2026-08-01T10:00:00.000Z', bytes: 10, note: 'empty',
    });
    expect(lib().loaded).toBe(false);
    expect(lib().suggestFor('project')).toBe('OR35128_OP10');
    expect(await lib().nameFor('project')).toBe('OR35128_OP10 (2)');
  });
});

describe('the list', () => {
  it('is newest first — what you were just working on is what you reopen', async () => {
    await lib().saveProgram('first');
    await lib().saveProgram('second');
    // The clock can land both saves in the same millisecond; date them apart.
    db.meta.get('program/first').savedAt = '2026-08-01T10:00:00.000Z';
    db.meta.get('program/second').savedAt = '2026-08-05T10:00:00.000Z';
    await lib().refresh();
    expect(lib().items.map((i) => i.name)).toEqual(['second', 'first']);
  });

  it('reports what the browser has room for', async () => {
    await lib().refresh();
    // Storage is read alongside the list, on its own promise.
    await Promise.resolve();
    expect(lib().storage).toEqual({ usage: 1000, quota: 2000 });
  });
});

describe('opening', () => {
  it('puts a saved program back through the same parse a dropped file uses', async () => {
    // The parse itself needs the G-code worker, which is not running here, so
    // what is asserted is the seam this store owns: the text and the name it
    // hands over. That the parse then works is `camStore`'s own business.
    await lib().saveProgram('OP10');
    const parse = vi.fn(async () => {});
    useCamStore.setState({ parse });
    await lib().open('program/OP10');
    expect(parse).toHaveBeenCalledWith(PROGRAM, 'OP10');
  });

  it('opens a saved project through the one path an opened .camweb.json takes', async () => {
    await lib().saveProject('OP10 setup');
    await lib().open('project/OP10 setup');
    expect(applied).toHaveBeenCalledTimes(1);
    // ...and with the document that was actually stored, not a rebuilt one.
    expect(applied.mock.calls[0][0].gcode).toBe(PROGRAM);
  });

  it('says so rather than applying a record it cannot read', async () => {
    db.data.set('program/ghost', { kind: 'program' }); // no text in it
    await expect(lib().open('program/ghost')).rejects.toThrow(/no text/i);
    expect(lib().error).toMatch(/no text/i);
  });

  it('says so when the key is not there at all', async () => {
    await expect(lib().open('program/missing')).rejects.toThrow(/could not be read/i);
  });
});

describe('deleting', () => {
  it('removes both halves and the row', async () => {
    await lib().saveProgram('OP10');
    await lib().remove('program/OP10');
    expect(lib().items).toHaveLength(0);
    expect(db.data.has('program/OP10')).toBe(false);
  });

  it('empties the whole library', async () => {
    await lib().saveProgram('a');
    await lib().saveProgram('b');
    await lib().clear();
    expect(lib().items).toHaveLength(0);
  });
});
