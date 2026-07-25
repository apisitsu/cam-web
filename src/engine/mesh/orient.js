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
 * Reoriented meshes, keyed weakly on the source mesh and then on the transform.
 *
 * Sound only because meshes here are immutable — every transform returns new
 * arrays rather than writing through an existing one — which is the same
 * property the slice index and the feature cache rely on.
 */
const _reorientCache = new WeakMap();

/**
 * Whether an axis assignment `[x, y, z]` is a rotation (even) or would mirror
 * the model if applied with no other sign change (odd).
 *
 * Shared by `millingOrientation` and `datum.js`'s `orientToNormal` — both pick
 * a permutation and then must correct its parity the same way, one from an
 * extent heuristic, the other from a picked face.
 */
export function isEvenPermutation([x, y, z]) {
  return (x === 0 && y === 1 && z === 2)
    || (x === 1 && y === 2 && z === 0)
    || (x === 2 && y === 0 && z === 1);
}

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
  const even = isEvenPermutation(order);
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
 * Re-express a mesh in a permuted, optionally reflected axis frame.
 *
 * Works on a triangle soup or a welded mesh and returns the same shape, so it
 * can be dropped in anywhere a mesh is accepted. Indices are untouched: the
 * connectivity does not change, only where each vertex sits.
 *
 * `flipY` is `millingOrientation`'s original single-axis reflection, kept as
 * a shorthand for `signs: [1, -1, 1]`. `signs` generalizes it to any of the
 * three axes, which a datum picked from an arbitrary face (rather than the
 * shortest-extent heuristic) may need to flip. Triangle winding is preserved
 * only when the combination of `order`'s permutation parity and `signs`
 * multiplies out to +1 — callers that build `signs` themselves are
 * responsible for that, the same way `millingOrientation` is responsible for
 * `flipY`.
 */
export function reorient(mesh, transform) {
  const { order, flipY = false, signs } = transform;
  const [ix, iy, iz] = order;
  const [sx, sy, sz] = signs ?? [1, flipY ? -1 : 1, 1];

  // Laying a part down is re-derived far more often than it changes.
  //
  // `camPlanStore.prepare()` always re-orients from the *pristine* import, so
  // that picking a datum then clearing it lands exactly back where it started
  // rather than compounding transforms. The cost is that a part which needs
  // laying down — most of them — produced a brand-new mesh on every machine,
  // process or datum change, and a new mesh invalidates everything keyed on it:
  // feature detection, the slice index, the analysis. Returning the identical
  // object for an identical transform keeps those caches alive across all the
  // changes that do not actually move the part.
  const key = `${ix},${iy},${iz}|${sx},${sy},${sz}`;
  let perMesh = _reorientCache.get(mesh);
  if (!perMesh) _reorientCache.set(mesh, perMesh = new Map());
  const hit = perMesh.get(key);
  if (hit) return hit;

  const src = mesh.positions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i + ix] * sx;
    out[i + 1] = src[i + iy] * sy;
    out[i + 2] = src[i + iz] * sz;
  }
  const result = { ...mesh, positions: out };
  if (mesh.normals && mesh.normals.length === mesh.triangleCount * 3) {
    const n = new Float32Array(mesh.normals.length);
    for (let i = 0; i < n.length; i += 3) {
      n[i] = mesh.normals[i + ix] * sx;
      n[i + 1] = mesh.normals[i + iy] * sy;
      n[i + 2] = mesh.normals[i + iz] * sz;
    }
    result.normals = n;
  }
  perMesh.set(key, result);
  return result;
}

/**
 * Lay a part down for milling, if it is not already.
 *
 * Returns the meshes to plan and display against, plus the orientation record
 * the plan reports to the operator — who has to reproduce that setup at the
 * vice, and cannot do so from a toolpath alone.
 *
 * `orientationOverride`, when given, replaces the automatic shortest-extent
 * decision outright — this is how an operator-picked datum plane (see
 * `engine/mesh/datum.js`) wins over the heuristic without this function
 * needing to know anything about datums.
 */
export function orientForMilling(soup, welded, orientationOverride) {
  const orientation = orientationOverride ?? millingOrientation(boundsOf(welded));
  if (!orientation.changed) {
    return { soup, welded, orientation };
  }
  return {
    soup: reorient(soup, orientation),
    welded: reorient(welded, orientation),
    orientation,
  };
}
