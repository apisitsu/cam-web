/**
 * libraryStore — the saved-work library: what is in it, and what you can do to
 * it (save, open, share, unshare, delete, clear).
 *
 * Thin, as the store layer is meant to be. The record shape, the naming rules
 * and the ordering are `engine/savedWork.js`; the storage is `lib/workApi.js`
 * (`lib/workDb.js` is the per-browser IndexedDB store it replaced, kept only for
 * the one-off migration described in `.claude/rules/cam-library-migration.md`);
 * gathering the current session into a project document, and applying one back
 * to the app, is `lib/projectIO.js`. This sequences those three and holds what
 * came back — a list, a busy flag, and the last error.
 *
 * **Saving is private.** A save always lands on this operator's own shelf, and
 * there is no argument anywhere in here for saving somewhere else — publishing
 * to the shared library is `share(id)`, a separate act on an item that already
 * exists. That asymmetry is deliberate: the previous design made every save a
 * publish, so an operator typing a name their colleague had also used replaced
 * that colleague's work without being asked anything.
 *
 * Who may share, unshare or delete which row is decided by the server and
 * arrives on each row as `canShare` / `canUnshare` / `canDelete`. This store
 * does not re-derive it; it calls, and reports what came back.
 *
 * `error` is a string, not a thrown exception, because every one of these
 * actions is a button press: the operator needs a sentence next to the button,
 * not an unhandled rejection in a console they will never open.
 */
import { create } from 'zustand';
import {
  buildRecord, readPayload, sortLibrary, namesOfKind, uniqueName, suggestName,
  myWork, sharedWork,
} from '../engine/savedWork.js';
import {
  putRecord, listMeta, getData, deleteRecord, clearAll, shareRecord, unshareRecord,
} from '../lib/workApi.js';
import { currentProject, applyProject, newProject as startNewProject } from '../lib/projectIO.js';
import { clearDraft } from '../lib/autosave.js';
import { useCamStore } from './camStore.js';

export const useLibraryStore = create((set, get) => ({
  /** Rows for the list, newest first. Empty until `refresh()` has run once. */
  items: [],
  /** Has the list been read at least once? Distinguishes "empty" from "unread". */
  loaded: false,
  busy: false,
  error: null,
  /**
   * What was last opened from the library, or saved into it: `{ id, name, kind,
   * shared }`, or null for work that has never been filed.
   *
   * Kept because saving used to have exactly one shape — type a name — even
   * when the job already had one. Re-typing a name you are trying not to change
   * is where a typo becomes a second copy, and there was no way to say "this
   * one, again". `saveOpen` uses this; `saveAs` ignores it.
   *
   * `shared` matters: a shared item belongs to whoever published it, and a save
   * always lands on your own shelf, so re-saving one is a *copy* — the panel
   * says so rather than pretending it can write back.
   */
  openItem: null,
  setOpenItem: (openItem) => set({ openItem: openItem || null }),
  setError: (error) => set({ error: error || null }),

  /** Re-read the list from the server. */
  async refresh() {
    set({ busy: true });
    try {
      const items = sortLibrary(await listMeta());
      set({ items, loaded: true, busy: false, error: null });
      return items;
    } catch (err) {
      set({ busy: false, error: err?.message || String(err) });
      return [];
    }
  },

  /** This operator's own shelf, and the shared library, out of the one list. */
  mine: () => myWork(get().items),
  shared: () => sharedWork(get().items),

  /**
   * The name to offer when the operator asks to save: whatever the work is
   * already called, made unique for that kind so a second save of an untitled
   * job does not silently replace the first.
   *
   * Measured against **this operator's own shelf only**, because that is the
   * only place a save can land. Avoiding a name a colleague had published would
   * offer "OP10 (2)" while your own OP10 slot stood empty.
   *
   * Saving over your own name *on purpose* is still one keystroke away — leave
   * the offered name alone and it writes a copy; type the old name back and it
   * replaces. The default leans to keeping work rather than to overwriting it.
   */
  suggestFor(kind) {
    const { fileName } = useCamStore.getState();
    const base = suggestName(fileName, kind === 'program' ? 'Program' : 'Project');
    return uniqueName(base, namesOfKind(get().mine(), kind));
  },

  /**
   * The same, but safe to offer.
   *
   * `suggestFor` can only avoid the names it knows about, and the list is read
   * lazily — the first save of a session would otherwise be offered a name that
   * looked free, and saving under it would replace a record from last week
   * without a word. Every caller that puts a name in front of the operator goes
   * through here; the sync version is for re-deriving it once the list is in.
   */
  async nameFor(kind) {
    if (!get().loaded) await get().refresh();
    return get().suggestFor(kind);
  },

  /** Save the whole session — program, setup, sketch — under `name`. */
  async saveProject(name) {
    return get()._save(() => buildRecord({
      kind: 'project',
      name,
      project: currentProject(),
      mode: useCamStore.getState().mode,
    }));
  },

  /**
   * Save over what is open, without asking again.
   *
   * Only when the open item is **yours** and is a project — a shared item is
   * somebody else's and a save lands on your own shelf, so writing it back is
   * not a thing that can happen. Callers check `canSaveOpen` first; this
   * repeats the check because a store action that trusts its caller is one
   * refactor away from not being checked at all.
   */
  async saveOpen() {
    const open = get().openItem;
    if (!open || open.shared || open.kind !== 'project') {
      throw new Error('There is no project of your own open to save over.');
    }
    return get().saveProject(open.name);
  },

  /** Whether `saveOpen` has something to write to. */
  canSaveOpen() {
    const open = get().openItem;
    return Boolean(open && !open.shared && open.kind === 'project');
  },

  /**
   * Empty the app and forget what was open.
   *
   * The emptying itself is `projectIO.newProject`, which knows every store a
   * project spans; this adds the one thing it deliberately does not know about
   * — that the next save should ask for a name again rather than write over
   * whatever was open before.
   */
  async newProject() {
    set({ busy: true, error: null });
    try {
      await startNewProject();
      set({ busy: false, openItem: null });
      return true;
    } catch (err) {
      set({ busy: false, error: err?.message || String(err) });
      return false;
    }
  },

  /** Save just the program text under `name`. */
  async saveProgram(name) {
    const { gcode, mode } = useCamStore.getState();
    if (!gcode || !gcode.trim()) throw new Error('There is no program to save yet.');
    return get()._save(() => buildRecord({ kind: 'program', name, gcode, mode }));
  },

  /** Shared write path: build, put, re-read the list. */
  async _save(build) {
    set({ busy: true, error: null });
    try {
      const record = build();
      const saved = await putRecord(record);
      clearDraft(); // the work is filed under a name now — the draft is redundant
      await get().refresh();
      // Saving files the work under a name, which is exactly what "open" means
      // for everything after it — so the next save can go straight back here.
      const row = get().items.find((m) => m.key === record.meta.key && !m.shared);
      set({
        openItem: {
          id: saved?.id ?? row?.id ?? null,
          name: record.meta.name,
          kind: record.meta.kind,
          shared: false,
        },
      });
      return record.meta;
    } catch (err) {
      set({ busy: false, error: err?.message || String(err) });
      throw err;
    }
  },

  /**
   * Open a saved item into the app.
   *
   * A program replaces the editor and is parsed, exactly as opening a file
   * does. A project goes through the same `applyProject` an opened
   * `.camweb.json` does, so a restored session cannot drift from a restored
   * file — there is one path, and this is a second door onto it.
   */
  async open(id) {
    set({ busy: true, error: null });
    try {
      const payload = readPayload(await getData(id));
      if (payload.kind === 'program') {
        await useCamStore.getState().parse(payload.gcode, payload.name);
      } else {
        await applyProject(payload.project);
      }
      const row = get().items.find((m) => m.id === id) || null;
      set({
        busy: false,
        openItem: {
          id,
          name: payload.name ?? row?.name ?? '',
          kind: payload.kind,
          shared: Boolean(row?.shared),
        },
      });
      return payload;
    } catch (err) {
      set({ busy: false, error: err?.message || String(err) });
      throw err;
    }
  },

  /**
   * Publish one of my saved items to the shared library, or take it back.
   *
   * A move, not a copy — the item is in one place, and which place it is in is
   * the whole state being changed. The server refuses to publish over somebody
   * else's item of the same name and says so in a sentence; that sentence is
   * what lands in `error`, so the operator finds out *why* rather than that
   * "something went wrong".
   */
  async share(id) {
    return get()._move(() => shareRecord(id));
  },

  async unshare(id) {
    return get()._move(() => unshareRecord(id));
  },

  async _move(call) {
    set({ busy: true, error: null });
    try {
      const meta = await call();
      await get().refresh();
      return meta;
    } catch (err) {
      set({ busy: false, error: err?.message || String(err) });
      throw err;
    }
  },

  /** Remove one saved item, by row id. */
  async remove(id) {
    set({ busy: true, error: null });
    try {
      await deleteRecord(id);
      await get().refresh();
      return id;
    } catch (err) {
      set({ busy: false, error: err?.message || String(err) });
      throw err;
    }
  },

  /** Empty the library. */
  async clear() {
    set({ busy: true, error: null });
    try {
      await clearAll();
      await get().refresh();
    } catch (err) {
      set({ busy: false, error: err?.message || String(err) });
      throw err;
    }
  },
}));
