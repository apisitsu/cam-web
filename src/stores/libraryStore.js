/**
 * libraryStore — the saved-work library: what is in it, and the four things you
 * can do to it (save, open, delete, clear).
 *
 * Thin, as the store layer is meant to be. The record shape, the naming rules
 * and the ordering are `engine/savedWork.js`; the database is `lib/workDb.js`;
 * gathering the current session into a project document, and applying one back
 * to the app, is `lib/projectIO.js`. This sequences those three and holds what
 * came back — a list, a busy flag, and the last error.
 *
 * `error` is a string, not a thrown exception, because every one of these
 * actions is a button press: the operator needs a sentence next to the button,
 * not an unhandled rejection in a console they will never open.
 */
import { create } from 'zustand';
import {
  buildRecord, readPayload, sortLibrary, namesOfKind, uniqueName, suggestName,
} from '../engine/savedWork.js';
import {
  putRecord, listMeta, getData, deleteRecord, clearAll, dbAvailable, storageUse,
} from '../lib/workDb.js';
import { currentProject, applyProject } from '../lib/projectIO.js';
import { useCamStore } from './camStore.js';

export const useLibraryStore = create((set, get) => ({
  /** Rows for the list, newest first. Empty until `refresh()` has run once. */
  items: [],
  /** Has the list been read at least once? Distinguishes "empty" from "unread". */
  loaded: false,
  busy: false,
  error: null,
  /** { usage, quota } when the browser will say, else null. */
  storage: null,

  /** Whether this browser can hold a library at all. */
  available: dbAvailable(),

  setError: (error) => set({ error: error || null }),

  /** Re-read the list from the database. */
  async refresh() {
    if (!get().available) return [];
    set({ busy: true });
    try {
      const items = sortLibrary(await listMeta());
      set({ items, loaded: true, busy: false, error: null });
      storageUse().then((storage) => set({ storage })).catch(() => {});
      return items;
    } catch (err) {
      set({ busy: false, error: err?.message || String(err) });
      return [];
    }
  },

  /**
   * The name to offer when the operator asks to save: whatever the work is
   * already called, made unique for that kind so a second save of an untitled
   * job does not silently replace the first.
   *
   * Saving over a name *on purpose* is still one keystroke away — leave the
   * offered name alone and it writes a copy; type the old name back and it
   * replaces. The default leans to keeping work rather than to overwriting it.
   */
  suggestFor(kind) {
    const { fileName } = useCamStore.getState();
    const base = suggestName(fileName, kind === 'program' ? 'Program' : 'Project');
    return uniqueName(base, namesOfKind(get().items, kind));
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
      await putRecord(record);
      await get().refresh();
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
  async open(key) {
    set({ busy: true, error: null });
    try {
      const payload = readPayload(await getData(key));
      if (payload.kind === 'program') {
        await useCamStore.getState().parse(payload.gcode, payload.name);
      } else {
        await applyProject(payload.project);
      }
      set({ busy: false });
      return payload;
    } catch (err) {
      set({ busy: false, error: err?.message || String(err) });
      throw err;
    }
  },

  /** Remove one saved item. */
  async remove(key) {
    set({ busy: true, error: null });
    try {
      await deleteRecord(key);
      await get().refresh();
      return key;
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
