/**
 * Standard cutting speeds, offline: a flat table in this browser instead of
 * the server-backed `cam_std_material` / `cam_std_vc` the vendored
 * EngineerSystem build reads over HTTP (`lib/stdApi.js` there, behind
 * `/api/engineer/cam/std-vc`).
 *
 * Standalone cam-web has no server and one user, so the table lives in
 * localStorage and starts empty — the same "no standard yet" state
 * `stdStore.loadStandard` already degrades to when the server is down, so no
 * seed data is needed for the UI to behave. What a range *means* is still
 * `engine/cam/stdVc.js`; this is transport only, same as the vendored build.
 *
 * Every material is
 *   { key, label, isoGroup, aliases, status: 'draft'|'approved', sourceNote,
 *     vc: { turning: [min,max], milling, drilling, reaming, tap } }
 */
const STORAGE_KEY = 'camweb.stdVc.v1';

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(materials) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(materials));
}

/** Every material and its ranges. Never throws — an unreadable table reads as empty. */
export async function listStd() {
  return readAll();
}

/** Create or update one material. Offline there is one operator, so no admin gate on `status`. */
export async function saveStd(key, body) {
  const materials = readAll();
  const material = { key, ...body };
  const idx = materials.findIndex((m) => m.key === key);
  if (idx >= 0) materials[idx] = material; else materials.push(material);
  writeAll(materials);
  return material;
}
