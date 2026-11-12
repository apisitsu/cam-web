/**
 * The shop's machines, offline: rows in this browser instead of the
 * server-backed `cam_machine` the vendored EngineerSystem build reads over HTTP
 * (`lib/machineApi.js` there, behind `/api/engineer/cam/machines`).
 *
 * A row is `{ id, ...machineRow(m) }` (see `engine/cam/machines.js`). An id of
 * a built-in machine changes that machine; any other id is a machine added.
 */
const STORAGE_KEY = 'camweb.machines.v1';

function readAll() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(rows) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
}

/** Every row. Never throws: an unreadable table reads as empty. */
export async function listMachines() {
  return readAll();
}

/** Add a machine, or change one. Offline there is one operator, so no engineer gate. */
export async function saveMachine(id, body) {
  const row = { ...body, id, updatedBy: null, updatedAt: new Date().toISOString() };
  writeAll([...readAll().filter((r) => r.id !== id), row]);
  return row;
}

/** Remove a row: a built-in goes back to its own figures, an added machine is gone. */
export async function deleteMachine(id) {
  const rows = readAll();
  if (!rows.some((r) => r.id === id)) throw new Error('no such machine');
  writeAll(rows.filter((r) => r.id !== id));
}
