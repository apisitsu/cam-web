/**
 * Rotating a mesh about a machine axis — what an indexed 4th axis actually is.
 *
 * A rotary table does not give the cutter a new degree of freedom while it is
 * cutting; used as an **indexer** it turns the part to a new angle, locks, and
 * then an ordinary 3-axis program runs. So the geometry problem is not "4-axis
 * toolpaths" at all — it is "the same 3-axis toolpath, on the part as it looks
 * from this angle".
 *
 * That is the whole idea here, and it is why indexing is cheap to support
 * correctly: rotate the mesh by −A about the rotary's axis, plan it with the
 * existing 3-axis code, and tell the post to turn the table to +A first. Every
 * slice, every offset, every drop of the cutter is code that is already tested.
 *
 * Convention: **A rotates about X**, the standard for a rotary table sitting on
 * a VMC with its faceplate facing −X. Positive A is counter-clockwise looking
 * from +X back toward the origin, which is what a Fanuc control does with a
 * positive A word.
 *
 * Pure functions over typed arrays. No three.js, no store, no DOM.
 */

/**
 * Rotate a mesh about the X axis.
 *
 * The part turns by `-degrees` because the *table* turns by `+degrees`: a
 * feature at A90 is reached by rolling the model back to where the spindle can
 * see it. Getting this sign backwards machines the mirror of the intended face,
 * which looks plausible on screen and is scrap on the machine.
 *
 * @param {{positions:Float32Array, normals?:Float32Array}} mesh
 * @param {number} degrees  table angle (A word), not the model's rotation
 * @param {{center?:[number,number]}} [opts] Y/Z the rotary axis passes through
 * @returns {object} a new mesh; the input is untouched
 */
export function rotateAboutX(mesh, degrees, opts = {}) {
  const { center = [0, 0] } = opts;
  const theta = (-degrees * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const [cy, cz] = center;

  const src = mesh.positions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const y = src[i + 1] - cy;
    const z = src[i + 2] - cz;
    out[i] = src[i];
    out[i + 1] = y * cos - z * sin + cy;
    out[i + 2] = y * sin + z * cos + cz;
  }

  const result = { ...mesh, positions: out };
  // Normals rotate too, but about the origin — they are directions, so the
  // centre offset must not be applied to them.
  if (mesh.normals?.length) {
    const n = mesh.normals;
    const rn = new Float32Array(n.length);
    for (let i = 0; i < n.length; i += 3) {
      rn[i] = n[i];
      rn[i + 1] = n[i + 1] * cos - n[i + 2] * sin;
      rn[i + 2] = n[i + 1] * sin + n[i + 2] * cos;
    }
    result.normals = rn;
  }
  return result;
}

/**
 * The index angles worth cutting a part from, given its shape.
 *
 * Four faces at 90° is the honest default for prismatic work on a rotary: it is
 * what a fixture and a vice actually give you, and each index is a face the
 * cutter can reach square-on. Offering 30° steps because the table can do them
 * would be generating twelve programs where four were wanted.
 *
 * Returns angles only — deciding *which* of them a part needs is a planning
 * question, not a geometric one, and belongs to whoever is looking at the part.
 */
export const INDEX_PRESETS = [
  { id: 'single', label: 'One side (A0)', angles: [0] },
  { id: 'opposite', label: 'Two sides (A0, A180)', angles: [0, 180] },
  { id: 'quarters', label: 'Four sides (every 90°)', angles: [0, 90, 180, 270] },
  { id: 'thirds', label: 'Three sides (every 120°)', angles: [0, 120, 240] },
  { id: 'sixths', label: 'Six sides (every 60°)', angles: [0, 60, 120, 180, 240, 300] },
];

/** Look a preset up by id, falling back to a single side rather than throwing. */
export function indexPreset(id) {
  return INDEX_PRESETS.find((p) => p.id === id) ?? INDEX_PRESETS[0];
}

/** Normalise an angle into [0, 360). A180 and A-180 are the same face. */
export function normalizeAngle(degrees) {
  const a = degrees % 360;
  return a < 0 ? a + 360 : a;
}
