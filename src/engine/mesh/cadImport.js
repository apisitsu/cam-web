/**
 * STEP / IGES parts: what OpenCascade (`occt-import-js`, see `lib/occtLoader.js`)
 * reads them into, turned into the triangle soup every other part format ends
 * as. From there a STEP part is planned, sketched on and built on exactly as an
 * STL is.
 *
 * Pure: the reader is handed in, so this runs the same in Node and the browser.
 */

/** Is this a STEP file (its header says so), an IGES file (by name), or neither? */
export function cadFormatOf(bytes, name = '') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 256))).trimStart();
  if (/^ISO-10303-21/.test(head)) return 'step';
  const ext = String(name).toLowerCase().replace(/^.*(\.[^.]+)$/, '$1');
  if (ext === '.stp' || ext === '.step') return 'step';
  if (ext === '.igs' || ext === '.iges') return 'iges';
  return null;
}

/**
 * How finely the surfaces are cut into triangles: a chord no more than this far
 * off the true surface (mm), and no facet turning more than this (radians).
 * Fine enough to machine from; a round of Ø100 comes out in some 250 facets.
 */
export const CAD_MESH = { linearDeflection: 0.01, angularDeflection: 0.05 };

/**
 * Read a STEP or IGES file with OpenCascade into a soup.
 *
 * @param {object} occt the initialised `occt-import-js` module
 * @param {Uint8Array} bytes
 * @param {'step'|'iges'} format
 * @returns {{positions: Float32Array, triangleCount: number, format: string}}
 */
export function readCad(occt, bytes, format) {
  const params = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: CAD_MESH.linearDeflection,
    angularDeflection: CAD_MESH.angularDeflection,
  };
  const result = format === 'iges' ? occt.ReadIgesFile(bytes, params) : occt.ReadStepFile(bytes, params);
  if (!result?.success) throw new Error(`That ${format.toUpperCase()} file could not be read.`);
  return cadResultToSoup(result, format);
}

/** OpenCascade's meshes (each indexed, in millimetres) as one soup. */
export function cadResultToSoup(result, format = 'step') {
  let count = 0;
  for (const m of result.meshes || []) count += (m.index?.array?.length || 0) / 3;
  const positions = new Float32Array(count * 9);
  let o = 0;
  for (const m of result.meshes || []) {
    const P = m.attributes?.position?.array;
    const I = m.index?.array;
    if (!P || !I) continue;
    for (let i = 0; i < I.length; i++) {
      const v = I[i] * 3;
      positions[o++] = P[v];
      positions[o++] = P[v + 1];
      positions[o++] = P[v + 2];
    }
  }
  if (!count) throw new Error(`That ${format.toUpperCase()} file has no solid or surface to mesh.`);
  return { positions, triangleCount: count, format };
}
