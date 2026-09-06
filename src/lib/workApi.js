/**
 * Saved work, offline: a private shelf plus a "shared" shelf, both in this
 * browser.
 *
 * The vendored EngineerSystem build of this file is an HTTP client for a
 * server-backed library (`cam_saved_work`, a real private/shared split across
 * operators). Standalone cam-web has no server and one user, so this is the
 * same seven-function surface backed by IndexedDB (`lib/workDb.js`):
 *
 *   - a record is addressed by its own key (`kind/name`) — with one browser and
 *     one operator there is no second row of the same name to disambiguate, so
 *     `id === key` here;
 *   - `shared` is a flag stored on the meta row. `share`/`unshare` flip it. It
 *     keeps the two-shelf UI (`LibraryPanel`) working; offline it just means
 *     "pinned to the shared shelf" rather than "published to the shop".
 *
 * `libraryStore.js` and `savedWork.js` are byte-for-byte the vendored files —
 * this module is the only place the two builds differ, mirroring the divergence
 * note in cam-web's own re-sync rules.
 */
import {
  putRecord as dbPut,
  listMeta as dbList,
  getData as dbGet,
  deleteRecord as dbDelete,
  clearAll as dbClear,
} from './workDb.js';

const ME = 'me';

/**
 * A meta row as the store wants it: the stored fields plus the per-caller
 * permission flags the server would have stamped. Offline the operator owns
 * everything, so the only real input is whether the row is on the shared shelf.
 */
function toItem(meta) {
  const shared = Boolean(meta?.shared);
  return {
    ...meta,
    id: meta.key,
    shared,
    owner: ME,
    canShare: !shared,
    canUnshare: shared,
    canDelete: true,
  };
}

/** Every row, unordered — `sortLibrary` decides the order. */
export async function listMeta() {
  const metas = await dbList();
  return metas.map(toItem);
}

/** One payload, by id (== key). Undefined when it is not there. */
export async function getData(id) {
  return dbGet(id);
}

/**
 * Write a record to the private shelf. A re-save of an item that is already on
 * the shared shelf stays there — the flag is a property of the name, not of
 * this write.
 */
export async function putRecord({ meta, data }) {
  const existing = (await dbList()).find((m) => m.key === meta.key);
  const merged = { ...meta, shared: existing ? Boolean(existing.shared) : false };
  await dbPut({ meta: merged, data });
  return toItem(merged);
}

/** Remove a record. Deleting something already gone is not an error. */
export async function deleteRecord(id) {
  return dbDelete(id);
}

/** Empty every shelf. */
export async function clearAll() {
  return dbClear();
}

async function setShared(id, shared) {
  const meta = (await dbList()).find((m) => m.key === id);
  if (!meta) throw new Error('That saved item is no longer in the library.');
  const data = await dbGet(id);
  if (data === undefined) throw new Error('That saved item has no payload to move.');
  const next = { ...meta, shared };
  await dbPut({ meta: next, data });
  return toItem(next);
}

/** Pin one of my saved items to the shared shelf. */
export function shareRecord(id) {
  return setShared(id, true);
}

/** Take one back onto the private shelf. */
export function unshareRecord(id) {
  return setShared(id, false);
}
