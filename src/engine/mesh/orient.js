/**
 * Work orientation — deciding how the part sits on the machine.
 *
 * A model arrives in whatever frame it was drawn in, and that is almost never
 * how it gets clamped. A 67 mm fork modelled standing up the Z axis reads to a
 * 3-axis planner as a 67 mm *deep* pocket, and no endmill in any library is
 * both long enough to reach it and small enough for the 3 mm gaps between the
 * tines — so the planner correctly concludes nothing can be machined, and
 * produces an empty program. Nothing is wrong with the geometry or the tool
 * library; the part is simply stood on end.
 *
 * A setter never does that. They lay the part down so the tool reaches
 * everything in the shortest possible plunge, and that single decision is what
 * this module makes: **the shortest dimension goes along the tool axis.**
 *
 * Pure functions over typed arrays. No three.js, no store, no DOM.
 */

import { boundsOf } from './analyze.js';

const AXIS_NAME = ['X', 'Y', 'Z'];

/**
 * Which source axis should become X, Y and Z for 3-axis milling.
 *
 * Z takes the smallest extent — the depth the cutter has to plunge — and X the
 * largest of what remains, so the part lies with its long side across the table.
 *
 * `flipY` exists because a permutation of the axes is a rotation only when it
 * is *even*. An odd permutation is a reflection: it turns the model into its
 * own mirror image, which would machine a left-hand part from a right-hand
 * model with nothing on screen looking wrong. Negating one axis restores the
 * handedness.
 *
 * @param {{size:number[]}} bounds from `boundsOf`
 * @returns {{order:[number,number,number], flipY:boolean, changed:boolean,
 *   depth:number, description:string}}
 */
export function millingOrientation(bounds) {
  const size = bounds.size;
  const byExtent = [0, 1, 2].sort((a, b) => size[a] - size[b]);
  const z = byExtent[0];                     // shortest -> tool axis
  const rest = [0, 1, 2].filter((a) => a !== z);
  const x = size[rest[0]] >= size[rest[1]] ? rest[0] : rest[1];
  const y = rest[0] === x ? rest[1] : rest[0];
  const order = [x, y, z];

  // Sign of the permutation: even keeps handedness, odd needs a flip.
  const even = (x === 0 && y === 1 && z === 2)
    || (x === 1 && y === 2 && z === 0)
    || (x === 2 && y === 0 && z === 1);
  const changed = !(x === 0 && y === 1 && z === 2);

  return {
    order,
    flipY: !even,
    changed,
    depth: size[z],
    description: changed
      ? `Set the part with its ${AXIS_NAME[z]} axis (${size[z].toFixed(1)} mm, the shortest) vertical — the cutter then plunges ${size[z].toFixed(1)} mm instead of ${Math.max(...size).toFixed(1)} mm.`
      : 'The model is already lying the right way up for milling.',
  };
}

/**
 * Re-express a mesh in a permuted axis frame.
 *
 * Works on a triangle soup or a welded mesh and returns the same shape, so it
 * can be dropped in anywhere a mesh is accepted. Indices are untouched: the
 * connectivity does not change, only where each vertex sits.
 *
 * Triangle winding is preserved. A reflection would invert it — which is why
 * `millingOrientation` never returns one without `flipY` to cancel it out.
 */
export function reorient(mesh, { order, flipY = false }) {
  const [ix, iy, iz] = order;
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  const sy = flipY ? -1 : 1;
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i + ix];
    out[i + 1] = src[i + iy] * sy;
    out[i + 2] = src[i + iz];
  }
  const result = { ...mesh, positions: out };
  if (mesh.normals && mesh.normals.length === mesh.triangleCount * 3) {
    const n = new Float32Array(mesh.normals.length);
    for (let i = 0; i < n.length; i += 3) {
      n[i] = mesh.normals[i + ix];
      n[i + 1] = mesh.normals[i + iy] * sy;
      n[i + 2] = mesh.normals[i + iz];
    }
    result.normals = n;
  }
  return result;
}

/**
 * Lay a part down for milling, if it is not already.
 *
 * Returns the meshes to plan and display against, plus the orientation record
 * the plan reports to the operator — who has to reproduce that setup at the
 * vice, and cannot do so from a toolpath alone.
 */
export function orientForMilling(soup, welded) {
  const orientation = millingOrientation(boundsOf(welded));
  if (!orientation.changed && !orientation.flipY) {
    return { soup, welded, orientation };
  }
  return {
    soup: reorient(soup, orientation),
    welded: reorient(welded, orientation),
    orientation,
  };
}
