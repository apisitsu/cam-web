/**
 * The cam-web project file: one JSON document holding everything the user
 * authored — the G-code program, the machine setup, and the sketch.
 *
 * Nothing in the app was persistent before this: a sketch lived only in memory,
 * so a refresh threw the work away. This module is the pure format layer (build
 * and parse, no DOM, no stores) so the shape is testable and versioned; the
 * browser side lives in `src/lib/projectIO.js`.
 */

export const PROJECT_KIND = 'cam-web.project';
/**
 * Bump when the shape changes incompatibly; `parseProject` refuses newer files.
 * v2 added the `cam` block — the whole STL→plan setup (part, machine, material,
 * origin, operations). A v1 file still opens: the `cam` block is simply absent.
 */
export const PROJECT_VERSION = 2;

/** camStore settings worth carrying (everything else is derived). */
const SETTING_KEYS = [
  'mode', 'rapidRate', 'diameterMode',
  'toolRadius', 'toolType', 'toolOverrides',
  'cellSize', 'voxelSize', 'simMethod',
  'stockTop', 'stockBase', 'stockMargin', 'stockOversize',
  'turnTool', 'aIndex',
];

/**
 * Base64 for the imported part's vertex buffer.
 *
 * A saved project has to carry the STL itself, or reopening it restores a
 * machine, a material and an origin with no part for any of them to mean
 * anything against. The positions are a `Float32Array`; base64 of its raw bytes
 * is ~3× smaller than a JSON number array and round-trips the float32 values
 * exactly. `btoa`/`atob` are standard in both the browser and the Node test
 * runner — no `node:*` import, which the bundle forbids. The binary string is
 * built in chunks so a large buffer never overflows `String.fromCharCode`.
 */
const B64_CHUNK = 0x8000;
export function encodeFloat32(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(bin);
}

export function decodeFloat32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/**
 * Assemble a project document. `sketch` is the sketchStore's serialized form (or
 * null); `settings` is filtered to the keys above so unrelated UI state — the
 * playhead, worker status — never lands in a saved file. `cam` is the CAM-plan
 * setup (see `camPlanStore.serializeSetup`), or null for a project that has no
 * imported part — a pure sketch or a hand-typed program.
 */
export function buildProject({
  gcode = '', fileName = null, sketch = null, settings = {}, cam = null,
} = {}) {
  const kept = {};
  for (const k of SETTING_KEYS) if (settings[k] !== undefined) kept[k] = settings[k];
  return {
    kind: PROJECT_KIND,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    fileName,
    gcode,
    sketch,
    settings: kept,
    cam,
  };
}

/** Serialize a project document for writing to disk. */
export function serializeProject(project) {
  return JSON.stringify(project, null, 2);
}

/**
 * Parse and validate a project file. Throws an Error with a message meant for
 * the user — a wrong file dropped on the app should say so, not blow up deep in
 * a store. Returns { gcode, fileName, sketch, settings }.
 */
export function parseProject(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('That file is not a cam-web project (it is not valid JSON).');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('That file is not a cam-web project.');
  }
  if (doc.kind !== PROJECT_KIND) {
    throw new Error('That file is not a cam-web project — open G-code with "Open file" instead.');
  }
  const version = Number(doc.version);
  if (!Number.isFinite(version) || version < 1) {
    throw new Error('This project file has no usable version number.');
  }
  if (version > PROJECT_VERSION) {
    throw new Error(`This project was saved by a newer version of cam-web (v${version}); this build reads up to v${PROJECT_VERSION}.`);
  }
  const settings = {};
  if (doc.settings && typeof doc.settings === 'object') {
    for (const k of SETTING_KEYS) if (doc.settings[k] !== undefined) settings[k] = doc.settings[k];
  }
  return {
    gcode: typeof doc.gcode === 'string' ? doc.gcode : '',
    fileName: typeof doc.fileName === 'string' ? doc.fileName : null,
    // The sketch is handed to sketchStore's deserialize, which validates it.
    sketch: doc.sketch ?? null,
    settings,
    // The CAM setup, if this project has one. Handed to
    // `camPlanStore.restoreSetup`, which validates and rebuilds from it; here we
    // only confirm it is an object so a malformed field can't crash the parse.
    cam: doc.cam && typeof doc.cam === 'object' && !Array.isArray(doc.cam) ? doc.cam : null,
    savedAt: typeof doc.savedAt === 'string' ? doc.savedAt : null,
  };
}

/**
 * A filename for a saved project, derived from the loaded program's name so a
 * project sits next to the G-code it came from.
 */
export function projectFileName(fileName) {
  const base = (fileName || 'untitled').replace(/\.[^.\\/]*$/, '') || 'untitled';
  return `${base}.camweb.json`;
}
