/**
 * The browser database the library lives in — IndexedDB, and nothing else.
 *
 * Deliberately dumb: open, put, get, list, delete. Every decision about what a
 * record *is* — its key, its name, its summary line, its order — is in
 * `engine/savedWork.js`, where it can be tested. What is left here is the part
 * that genuinely cannot be: a browser API with an event-based, transactional
 * shape that has to be promisified.
 *
 * Two object stores, both keyed by the same string (see `savedWork.js`):
 *
 * - `meta` — one small row per saved item, which is all a list needs.
 * - `data` — the payload: a program's text, or a whole project document with a
 *   base64 STL inside it.
 *
 * Drawing the list from `data` would deserialize every megabyte in the library
 * to show a column of names, which is exactly the kind of thing that makes an
 * app feel slow for no reason the user can see.
 *
 * Why IndexedDB and not `localStorage`: localStorage holds ~5 MB of *strings*,
 * synchronously, on the main thread. One project with an imported STL can be
 * most of that on its own, and writing it would jank the viewport.
 */

export const DB_NAME = 'cam-web';
export const DB_VERSION = 1;
export const META_STORE = 'meta';
export const DATA_STORE = 'data';

/** The database, opened once and shared. */
let dbPromise = null;

/**
 * Is there a database to use at all?
 *
 * Firefox in private browsing, and some locked-down enterprise profiles, expose
 * `indexedDB` and then fail on open. The check is here so callers can say "the
 * library is not available in this browser" once, rather than every action
 * failing with a DOM exception nobody can act on.
 */
export function dbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

/** Wrap an IDBRequest as a promise. */
function ask(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('The saved-work database refused that.'));
  });
}

/** Wrap a transaction's completion, so a write is only done when it commits. */
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('The save did not go through.'));
    tx.onabort = () => reject(tx.error || new Error('The save was cancelled by the browser — it may be out of space.'));
  });
}

export function openDb() {
  if (!dbAvailable()) {
    return Promise.reject(new Error('This browser has no storage for the library (private browsing blocks it).'));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(DATA_STORE)) db.createObjectStore(DATA_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading the schema would otherwise be blocked forever by
      // this connection. Letting it close means this tab's next call reopens.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('Could not open the saved-work database.'));
    req.onblocked = () => reject(new Error('Another tab has the library open at a different version — close it and try again.'));
  }).catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}

/**
 * Write a record. Meta and data go in **one transaction**, so the library can
 * never end up listing a row whose payload was never written.
 */
export async function putRecord({ meta, data }) {
  const db = await openDb();
  const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
  tx.objectStore(META_STORE).put(meta);
  tx.objectStore(DATA_STORE).put(data);
  await done(tx);
  return meta;
}

/** Every row the list shows, unordered — `sortLibrary` decides the order. */
export async function listMeta() {
  const db = await openDb();
  const tx = db.transaction(META_STORE, 'readonly');
  const all = await ask(tx.objectStore(META_STORE).getAll());
  return Array.isArray(all) ? all : [];
}

/** One payload, by key. Undefined when it is not there. */
export async function getData(key) {
  const db = await openDb();
  const tx = db.transaction(DATA_STORE, 'readonly');
  return ask(tx.objectStore(DATA_STORE).get(key));
}

/** Remove both halves of a record. Deleting a key that is gone is not an error. */
export async function deleteRecord(key) {
  const db = await openDb();
  const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
  tx.objectStore(META_STORE).delete(key);
  tx.objectStore(DATA_STORE).delete(key);
  await done(tx);
  return key;
}

/** Empty the library. */
export async function clearAll() {
  const db = await openDb();
  const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
  tx.objectStore(META_STORE).clear();
  tx.objectStore(DATA_STORE).clear();
  await done(tx);
}

/**
 * How much the browser has given this origin and how much is used, when it will
 * say. Shown next to the library so "why did my save fail" has an answer that is
 * not a shrug. Null where the API does not exist (Safari).
 */
export async function storageUse() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage ?? 0, quota: quota ?? 0 };
  } catch {
    return null;
  }
}
