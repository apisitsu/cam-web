/**
 * Reading a part file, whatever kind it is.
 *
 * Everything downstream — welding, slicing, offsetting, feature recovery, every
 * toolpath — works on a triangle soup. So the cost of a new *mesh* format is
 * only its parser, and the cost of getting the dispatch wrong is a part
 * silently machined from garbage.
 *
 * **The content decides, not the extension.** A file named `.stl` that is
 * really an OBJ is common enough (people rename files) that trusting the name
 * would be careless, and every format here is identifiable from its first few
 * bytes. The extension is used only to break ties and to phrase the error.
 *
 * ### What is deliberately not here
 *
 * **STEP and IGES.** They are the formats that would actually improve the
 * output rather than merely widen the inbox: a STEP file has real planar faces,
 * real cylinders and real tolerances, so a Ø10 hole is a Ø10 hole instead of a
 * 32-sided polygon that has to be fitted back into one. Reading them means a
 * B-rep kernel — `opencascade.js` is about 30 MB of WebAssembly — which is a
 * decision about what this app *is*, not a parser to be dropped in. The
 * geometry pipeline is mesh-based throughout and would keep working; STEP would
 * be tessellated on the way in and its exact faces carried alongside.
 *
 * Pure functions. No three.js, no store, no DOM.
 */

import { parseSTL, isBinarySTL } from './stl.js';
import { parseOBJ, looksLikeOBJ } from './obj.js';
import { parsePLY, looksLikePLY } from './ply.js';

/**
 * The formats that can be read, for a file picker and for error messages.
 *
 * `accept` is what goes in the upload control. Keep it and the parsers in step:
 * offering an extension nothing can read is worse than not offering it.
 */
export const PART_FORMATS = [
  { id: 'stl', label: 'STL', extensions: ['.stl'], note: 'Triangle mesh. The usual export from any CAD.' },
  { id: 'obj', label: 'OBJ', extensions: ['.obj'], note: 'Wavefront mesh. Multi-object and n-sided faces.' },
  { id: 'ply', label: 'PLY', extensions: ['.ply'], note: 'Scanner and mesh-repair output.' },
];

/** The `accept` attribute for a file input: ".stl,.obj,.ply". */
export const PART_ACCEPT = PART_FORMATS.flatMap((f) => f.extensions).join(',');

/** The extension of a filename, lowercased, including the dot. */
export function extensionOf(name = '') {
  const dot = String(name).lastIndexOf('.');
  return dot < 0 ? '' : String(name).slice(dot).toLowerCase();
}

/**
 * Work out what a file actually is.
 *
 * Order matters. PLY and binary STL are checked by magic bytes first because
 * they are unambiguous; OBJ is a text sniff and so is checked after ASCII STL,
 * which is also text and would otherwise be plausible to both.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @param {string} [name] filename, used only to break a tie
 * @returns {'stl'|'obj'|'ply'|null}
 */
export function detectFormat(data, name = '') {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length === 0) return null;

  if (looksLikePLY(bytes)) return 'ply';

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
    .trimStart();

  // ASCII STL announces itself, and its facet lines are unmistakable.
  if (/^solid\b/i.test(head) && /facet\s+normal/i.test(
    new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096)),
  )) {
    return 'stl';
  }
  if (looksLikeOBJ(bytes)) return 'obj';

  const ext = extensionOf(name);
  // Binary STL has no magic at all — its "header" is 80 arbitrary bytes — so
  // it is identified by its own length arithmetic instead.
  if (isBinarySTL(bytes.buffer ?? bytes)) return 'stl';
  if (ext === '.stl') return 'stl';
  if (ext === '.obj') return 'obj';
  if (ext === '.ply') return 'ply';
  return null;
}

/**
 * Read any supported part file into a triangle soup.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @param {string} [name] filename, for format detection and error wording
 * @returns {{positions:Float32Array, triangleCount:number, format:string}}
 */
export function parsePart(data, name = '') {
  const format = detectFormat(data, name);
  if (!format) {
    const ext = extensionOf(name);
    throw new Error(
      ext
        ? `${ext} is not a part format this can read. Supported: ${PART_ACCEPT}.`
        : `That file is not a mesh this can read. Supported: ${PART_ACCEPT}.`,
    );
  }

  const soup = format === 'stl' ? parseSTL(data)
    : format === 'obj' ? parseOBJ(data)
      : parsePLY(data);

  if (!soup.triangleCount) {
    throw new Error(`That ${format.toUpperCase()} file contains no triangles.`);
  }
  return { ...soup, format };
}
