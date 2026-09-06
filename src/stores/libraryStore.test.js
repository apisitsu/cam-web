/**
 * The library store, against a stand-in for the server.
 *
 * There is no backend under vitest, and asserting on a mocked axios would only
 * test the mock. What is worth testing is the sequencing this store owns: that a
 * save writes both halves of a record under one key, that the list comes back
 * newest-first, that a name offered for a second save does not silently replace
 * the first, that opening hands the work to the same parse a dropped file uses,
 * and that a failure lands in `error` as a sentence instead of an unhandled
 * rejection.
 *
 * So `lib/workApi.js` is replaced below, and everything above it is real code.
 *
 * The stand-in models **shelves**, because that is now the thing the store is
 * sequencing against: a row belongs to one operator or to the shared library,
 * `(shelf, key)` is what a save replaces, and rows are addressed by id because
 * the same key is legitimately two rows. A fake that kept the old flat
 * key→record Map would still pass every test here while being unable to
 * represent the bug the shelves exist to prevent — one operator's save landing
 * on another's row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const SHARED = '~shared';
const OTHER = 'XX999';

const db = { rows: new Map(), nextId: 1, fail: null, me: 'LC043' };

/** The row shape the real server returns, permissions included. */
function asItem(r) {
  const shared = r.shelf === SHARED;
  const mine = r.owner === db.me;
  return {
    ...r.meta,
    id: r.id,
    shared,
    owner_empno: r.owner,
    owner_name: r.owner,
    mine,
    canShare: !shared && r.shelf === db.me,
    canUnshare: shared && mine,
    canDelete: r.shelf === db.me || (shared && mine),
  };
}

const find = (shelf, key) => [...db.rows.values()].find((r) => r.shelf === shelf && r.key === key);

/** Put a row straight in, the way another session or another operator would. */
function seed({ key, shelf = db.me, owner = shelf, meta = {}, data = {} }) {
  const id = String(db.nextId++);
  const row = { id, shelf, key, owner: owner === SHARED ? null : owner, meta: { key, ...meta }, data };
  db.rows.set(id, row);
  return row;
}

vi.mock('../lib/workApi.js', () => ({
  // A save always lands on the caller's own shelf — there is no argument for
  // saving anywhere else, which is the property the real service guarantees.
  putRecord: async ({ meta, data }) => {
    if (db.fail) throw new Error(db.fail);
    const row = find(db.me, meta.key)
      ?? seed({ key: meta.key, shelf: db.me, owner: db.me });
    row.meta = meta;
    row.data = data;
    return asItem(row);
  },
  listMeta: async () => [...db.rows.values()]
    .filter((r) => r.shelf === db.me || r.shelf === SHARED)
    .map(asItem),
  getData: async (id) => {
    const r = db.rows.get(String(id));
    return r && (r.shelf === db.me || r.shelf === SHARED) ? r.data : undefined;
  },
  deleteRecord: async (id) => { db.rows.delete(String(id)); return id; },
  clearAll: async () => { db.rows.clear(); },
  shareRecord: async (id) => {
    const row = db.rows.get(String(id));
    const held = find(SHARED, row.key);
    if (held && held.owner !== db.me) {
      throw new Error(`The shared library already has “${row.meta.name}” from ${held.owner}.`);
    }
    if (held) db.rows.delete(held.id);
    row.shelf = SHARED;
    return asItem(row);
  },
  unshareRecord: async (id) => {
    const row = db.rows.get(String(id));
    if (row.owner !== db.me) throw new Error('That is not yours to remove.');
    const own = find(db.me, row.key);
    if (own) db.rows.delete(own.id);
    row.shelf = db.me;
    return asItem(row);
  },
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

/** The row this session just wrote, by the key the client built for it. */
const myRow = (key) => [...db.rows.values()].find((r) => r.shelf === db.me && r.key === key);

beforeEach(() => {
  db.rows.clear();
  db.nextId = 1;
  db.fail = null;
  db.me = 'LC043';
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
    expect(myRow(meta.key).data.project.gcode).toBe(PROGRAM);
  });

  it('writes both halves under one key', async () => {
    const meta = await lib().saveProgram('OP10');
    const row = myRow(meta.key);
    expect(row.meta.key).toBe(meta.key);
    expect(row.data.key).toBe(meta.key);
  });

  it('refuses a program with nothing in it, rather than saving an empty file', async () => {
    useCamStore.setState({ gcode: '   ' });
    await expect(lib().saveProgram('OP10')).rejects.toThrow(/no program/i);
    expect(db.rows.size).toBe(0);
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
    expect(myRow('program/OP10').data.gcode).toBe('M30');
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
    seed({ key: 'project/OR35128_OP10', meta: {
      kind: 'project', name: 'OR35128_OP10',
      savedAt: '2026-08-01T10:00:00.000Z', bytes: 10, note: 'empty',
    } });
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
    myRow('program/first').meta.savedAt = '2026-08-01T10:00:00.000Z';
    myRow('program/second').meta.savedAt = '2026-08-05T10:00:00.000Z';
    await lib().refresh();
    expect(lib().items.map((i) => i.name)).toEqual(['second', 'first']);
  });

  // There is no "reports what the browser has room for" test any more. The
  // quota it asserted on was the browser's, and the work no longer lives there;
  // the store kept reading it into a `storage` field nothing rendered.
});

describe('opening', () => {
  it('puts a saved program back through the same parse a dropped file uses', async () => {
    // The parse itself needs the G-code worker, which is not running here, so
    // what is asserted is the seam this store owns: the text and the name it
    // hands over. That the parse then works is `camStore`'s own business.
    await lib().saveProgram('OP10');
    const parse = vi.fn(async () => {});
    useCamStore.setState({ parse });
    await lib().open(myRow('program/OP10').id);
    expect(parse).toHaveBeenCalledWith(PROGRAM, 'OP10');
  });

  it('opens a saved project through the one path an opened .camweb.json takes', async () => {
    await lib().saveProject('OP10 setup');
    await lib().open(myRow('project/OP10 setup').id);
    expect(applied).toHaveBeenCalledTimes(1);
    // ...and with the document that was actually stored, not a rebuilt one.
    expect(applied.mock.calls[0][0].gcode).toBe(PROGRAM);
  });

  it('says so rather than applying a record it cannot read', async () => {
    const ghost = seed({ key: 'program/ghost', data: { kind: 'program' } }); // no text in it
    await expect(lib().open(ghost.id)).rejects.toThrow(/no text/i);
    expect(lib().error).toMatch(/no text/i);
  });

  it('says so when the key is not there at all', async () => {
    await expect(lib().open('9999')).rejects.toThrow(/could not be read/i);
  });
});

describe('deleting', () => {
  it('removes both halves and the row', async () => {
    await lib().saveProgram('OP10');
    await lib().remove(myRow('program/OP10').id);
    expect(lib().items).toHaveLength(0);
    expect(myRow('program/OP10')).toBeUndefined();
  });

  it('empties the whole library', async () => {
    await lib().saveProgram('a');
    await lib().saveProgram('b');
    await lib().clear();
    expect(lib().items).toHaveLength(0);
  });
});

/**
 * The reason the shelves exist. Before them there was one library keyed by
 * `'program/<name>'`, so the moment two operators picked the same obvious name —
 * and "OP10" is the obvious name — the second save replaced the first's work
 * with no question asked and no way to tell it had happened.
 */
describe('one shelf per operator', () => {
  it('does not show me a colleague\'s private work', async () => {
    seed({ key: 'program/OP10', shelf: OTHER, meta: { kind: 'program', name: 'OP10' } });
    await lib().refresh();
    expect(lib().items).toHaveLength(0);
  });

  it('saves a name a colleague already used without touching their copy', async () => {
    const theirs = seed({
      key: 'program/OP10', shelf: OTHER,
      meta: { kind: 'program', name: 'OP10' },
      data: { kind: 'program', name: 'OP10', gcode: 'THEIRS' },
    });
    await lib().saveProgram('OP10');
    expect(db.rows.get(theirs.id).data.gcode).toBe('THEIRS');
    expect(myRow('program/OP10').data.gcode).toBe(PROGRAM);
  });

  it('offers the plain name even when a colleague has published one like it', async () => {
    seed({
      key: 'project/OR35128_OP10', shelf: SHARED, owner: OTHER,
      meta: { kind: 'project', name: 'OR35128_OP10' },
    });
    await lib().refresh();
    // Counting up here would leave my own OR35128_OP10 slot empty while I saved
    // "(2)" — the name is only taken if I took it.
    expect(lib().suggestFor('project')).toBe('OR35128_OP10');
  });

  it('splits the one list into my shelf and the shared one', async () => {
    await lib().saveProgram('mine');
    seed({
      key: 'program/theirs', shelf: SHARED, owner: OTHER,
      meta: { kind: 'program', name: 'theirs' },
    });
    await lib().refresh();
    expect(lib().mine().map((i) => i.name)).toEqual(['mine']);
    expect(lib().shared().map((i) => i.name)).toEqual(['theirs']);
  });
});

describe('sharing', () => {
  it('moves my item onto the shared shelf — it is in one place, not two', async () => {
    await lib().saveProgram('OP10');
    await lib().share(myRow('program/OP10').id);
    expect(lib().mine()).toHaveLength(0);
    expect(lib().shared().map((i) => i.name)).toEqual(['OP10']);
  });

  it('takes it back again', async () => {
    await lib().saveProgram('OP10');
    await lib().share(myRow('program/OP10').id);
    await lib().unshare(lib().shared()[0].id);
    expect(lib().mine().map((i) => i.name)).toEqual(['OP10']);
    expect(lib().shared()).toHaveLength(0);
  });

  it('refuses to publish over somebody else\'s, and says whose it is', async () => {
    seed({
      key: 'program/OP10', shelf: SHARED, owner: OTHER,
      meta: { kind: 'program', name: 'OP10' },
    });
    await lib().saveProgram('OP10');
    await expect(lib().share(myRow('program/OP10').id)).rejects.toThrow(/already has/i);
    // The sentence is the whole value of refusing, so it has to reach the panel.
    expect(lib().error).toMatch(new RegExp(OTHER));
    // ...and mine is still mine, unpublished and unharmed.
    expect(lib().mine().map((i) => i.name)).toEqual(['OP10']);
  });

  it('will not let me pull back what a colleague shared', async () => {
    const theirs = seed({
      key: 'program/OP10', shelf: SHARED, owner: OTHER,
      meta: { kind: 'program', name: 'OP10' },
    });
    await expect(lib().unshare(theirs.id)).rejects.toThrow(/not yours/i);
  });

  it('opens what a colleague shared, which is the point of sharing it', async () => {
    seed({
      key: 'program/OP10', shelf: SHARED, owner: OTHER,
      meta: { kind: 'program', name: 'OP10' },
      data: { kind: 'program', name: 'OP10', gcode: PROGRAM },
    });
    await lib().refresh();
    const parse = vi.fn(async () => {});
    useCamStore.setState({ parse });
    await lib().open(lib().shared()[0].id);
    expect(parse).toHaveBeenCalledWith(PROGRAM, 'OP10');
  });
});
