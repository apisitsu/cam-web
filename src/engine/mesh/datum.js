/**
 * Work datum — letting the operator say where X0/Y0/Z0 physically is.
 *
 * Everything else in this codebase treats the STL's own coordinates as the
 * machining origin, because nothing ever moves the geometry away from them
 * (see `orient.js`, which only ever rotates). That is fine for a program this
 * app posts itself — the coordinates it writes are exactly the coordinates it
 * measured. It falls apart the moment a *separately authored* `.nc` file is
 * loaded: that program's zero was set by a machinist against a physical
 * fixture, which has no necessary relationship to wherever the STL happens to
 * sit in its own file.
 *
 * The fix is not to teach the interpreter about work-offset registers (the
 * app deliberately does not model a live G54 table — see `cam/envelope.js`).
 * It is to let the operator pick, once, the plane and point on the *model*
 * that correspond to physical zero, and bake that choice into the mesh's own
 * coordinates — the same trick `orientForMilling` already uses for automatic
 * axis layout. Once the mesh sits in that frame, any G-code — generated here
 * or loaded from elsewhere — that was zeroed at the same physical point lines
 * up with it for free, because the viewport already draws every toolpath and
 * every imported model in one shared, untransformed space.
 *
 * Pure functions over typed arrays. No three.js, no store, no DOM.
 */

import { boundsOf } from './analyze.js';
import { isEvenPermutation, orientForMilling, reorient } from './orient.js';
import { rotateAboutX, normalizeAngle } from './rotate.js';

/** A proper (winding-preserving) 180° turn about Z: X and Y both reverse, Z does not. */
const REVERSE_X_TRANSFORM = { order: [0, 1, 2], signs: [-1, -1, 1] };

/**
 * Move a point to the origin by subtracting it from every vertex.
 *
 * Normals are untouched — a translation does not rotate anything. Works on a
 * triangle soup or a welded mesh, like `reorient`.
 */
export function translate(mesh, offset) {
  const [ox, oy, oz] = offset;
  if (ox === 0 && oy === 0 && oz === 0) return mesh;
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i] - ox;
    out[i + 1] = src[i + 1] - oy;
    out[i + 2] = src[i + 2] - oz;
  }
  return { ...mesh, positions: out };
}

/**
 * An axis-aligned orientation that puts a *picked* face's normal on +Z,
 * instead of `millingOrientation`'s shortest-extent heuristic.
 *
 * The normal is snapped to whichever source axis it is nearest — every face
 * an operator picks for a datum is, in practice, one this app's 3-axis
 * toolpaths already treat as axis-aligned, so an off-axis normal only ever
 * happens from a slightly noisy STL facet, not a genuinely angled setup.
 *
 * The remaining two source axes keep their natural (ascending) order onto X
 * and Y. Handedness is preserved the same way `millingOrientation` does it —
 * by flipping exactly one more axis when the permutation and the picked
 * face's sign would otherwise combine into a reflection.
 *
 * @param {number[]} normal a (near-)unit vector in the mesh's own frame
 * @returns {{order:[number,number,number], signs:[number,number,number],
 *   changed:boolean, description:string}}
 */
export function orientToNormal(normal) {
  const abs = normal.map(Math.abs);
  const srcAxis = abs.indexOf(Math.max(...abs));
  const srcSign = normal[srcAxis] < 0 ? -1 : 1;
  const [p, q] = [0, 1, 2].filter((a) => a !== srcAxis);
  const order = [p, q, srcAxis];
  const signs = [1, 1, srcSign];

  // The permutation's own parity, combined with the sign forced onto Z by the
  // picked face, must multiply out to +1 or the model comes out mirrored.
  const parity = isEvenPermutation(order) ? 1 : -1;
  if (parity * srcSign !== 1) signs[1] = -1;

  const changed = order[0] !== 0 || order[1] !== 1 || order[2] !== 2
    || signs[0] !== 1 || signs[1] !== 1 || signs[2] !== 1;

  const AXIS_NAME = ['X', 'Y', 'Z'];
  return {
    order,
    signs,
    changed,
    description: changed
      ? `Set the part with the picked face's ${AXIS_NAME[srcAxis]} face vertical, pointing up.`
      : 'The picked face already points straight up.',
  };
}

/** Rotate a Y/Z pair about the origin, exactly like `rotateAboutX`'s own math. */
function rotateYZ(y, z, degrees) {
  const t = (-degrees * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [y * c - z * s, y * s + z * c];
}

/**
 * Which angle (degrees, `rotateAboutX`'s sign convention) rotates a normal —
 * already expressed in the frame `orientToNormal` just established, so its X
 * component is along the rotary axis — onto +Z.
 *
 * This is what "pick the face that should read as A0" resolves to: an
 * *arbitrary*, continuous angle, unlike `orientToNormal`'s 90°-snapped
 * permutation. A face whose normal has no Y/Z component at all (an end face,
 * pointing straight down the rotary axis) cannot be brought to +Z by rotating
 * about that same axis, so this returns `0` rather than a nonsensical value.
 */
export function angleToFaceUp([, ny, nz]) {
  const len = Math.hypot(ny, nz);
  if (len < 1e-9) return 0;
  const t = Math.atan2(ny / len, nz / len);
  // `+ 0` folds a `-0` result (dead flat already) to the plain `0` every
  // other "nothing to do" path in this module returns.
  return normalizeAngle((-t * 180) / Math.PI) + 0;
}

/**
 * Map a point through the inverse of a `reorient`/`orientToNormal` transform,
 * plus the continuous `angle` a picked A0 face may have added (see
 * `angleToFaceUp`) and a `reverseX` 180°-about-Z flip on top of that (see
 * `applyDatum`) — undone in the reverse of the order they were applied.
 *
 * A point picked off the *displayed* mesh (already laid down, automatically
 * or by a previous datum) has to be converted back to the pristine import
 * frame to be stored — otherwise it would silently go stale the moment the
 * orientation changes again. Inverting a signed permutation is another signed
 * permutation: undo the last transform applied first, and so on back to the
 * axis assignment and the sign on each axis.
 */
export function pointToRawFrame(point, orientation) {
  if (!orientation) return point;
  const {
    order, flipY = false, signs, angle = 0, reverseX = false,
  } = orientation;
  const [sx, sy, sz] = signs ?? [1, flipY ? -1 : 1, 1];
  let [x, y, z] = point;
  if (reverseX) { x = -x; y = -y; }
  if (angle) [y, z] = rotateYZ(y, z, -angle);
  const out = new Array(3);
  out[order[0]] = x * sx;
  out[order[1]] = y * sy;
  out[order[2]] = z * sz;
  return out;
}

/** The forward transform of a single point, mirroring what `reorient` (plus a picked A0 and/or `reverseX`) does to vertices. */
export function pointFromRawFrame(point, orientation) {
  if (!orientation) return point;
  const {
    order, flipY = false, signs, angle = 0, reverseX = false,
  } = orientation;
  const [sx, sy, sz] = signs ?? [1, flipY ? -1 : 1, 1];
  let x = point[order[0]] * sx;
  let y = point[order[1]] * sy;
  let z = point[order[2]] * sz;
  if (angle) [y, z] = rotateYZ(y, z, angle);
  if (reverseX) { x = -x; y = -y; }
  return [x, y, z];
}

/**
 * Convert a point picked off the *currently displayed* mesh — already laid
 * down and/or shifted by whatever datum is currently active — back to the
 * pristine import frame.
 *
 * `pointToRawFrame` alone only undoes the rotation; the mesh on screen has
 * also been translated by `currentPoint` (the datum point already in force,
 * or `null` for none), so a fresh pick has to undo both, in reverse order,
 * to land in the same frame `_raw` is measured in — otherwise picking a new
 * origin while one is already set would land in the wrong place by exactly
 * the old offset.
 */
export function displayedPointToRawFrame(point, orientation, currentPoint) {
  const shift = currentPoint ? pointFromRawFrame(currentPoint, orientation) : [0, 0, 0];
  const unshifted = [point[0] + shift[0], point[1] + shift[1], point[2] + shift[2]];
  return pointToRawFrame(unshifted, orientation);
}

/**
 * Set the work origin along ONE axis from a point picked on the model, leaving
 * the other two axes exactly where they were.
 *
 * This is how touch-off actually happens at a machine: edge-find X, then Y,
 * then the top face for Z — three independent moves, none of which disturbs the
 * part's orientation. It is the deliberate opposite of picking a whole face,
 * which snaps a plane and re-lays the part down so every axis moves at once (the
 * thing operators kept hitting by accident). The picked point arrives in the
 * *currently displayed* frame — already laid down and shifted by whatever origin
 * is in force — so its component along `axis` is how far that axis's zero must
 * travel from the current origin; the other two axes are copied from the origin
 * already set. The result is in the raw import frame, the one that survives a
 * later re-lay-down (see `pointToRawFrame`).
 *
 * @param {number[]|null} currentRawPoint the origin in force (raw frame), or null
 * @param {object|null} orientation the active lay-down orientation
 * @param {0|1|2} axis the displayed axis being set (X, Y or Z)
 * @param {number[]} clickedDisplayed the picked point, in the displayed frame
 * @returns {number[]} the new origin, in the raw import frame
 */
export function originFromAxisPick(currentRawPoint, orientation, axis, clickedDisplayed) {
  const g = currentRawPoint ? pointFromRawFrame(currentRawPoint, orientation) : [0, 0, 0];
  const next = [...g];
  next[axis] = g[axis] + clickedDisplayed[axis];
  return pointToRawFrame(next, orientation);
}

/**
 * Set the work origin along ONE axis to a typed value, leaving the others put.
 *
 * The value is the axis's coordinate in the laid-down setup frame — exactly
 * what the numeric field shows — so typing the same value back is a no-op, and
 * clearing an axis is `value = 0`. Same per-axis discipline as
 * `originFromAxisPick`, but absolute rather than relative to a click.
 */
export function originFromAxisValue(currentRawPoint, orientation, axis, value) {
  const g = currentRawPoint ? pointFromRawFrame(currentRawPoint, orientation) : [0, 0, 0];
  const next = [...g];
  next[axis] = value;
  return pointToRawFrame(next, orientation);
}

/**
 * Apply an operator-picked datum to the pristine imported mesh.
 *
 * For milling, `datum.planeNormal` overrides `orientForMilling`'s automatic
 * shortest-extent decision; leaving it unset keeps that automatic behaviour
 * exactly as it is today (this is what makes the feature invisible to a part
 * nobody has picked a datum for). `datum.rotaryZero` — a second, independent
 * face pick — then turns the part about that same (now-established) rotary
 * axis so the picked face reads as A0; a 4-axis part rarely arrives modelled
 * at the angle it will actually be chucked at, and this is the "index by eye
 * once" step that fixes that without touching `indexAngle`'s own numbering.
 * `datum.reverseX` then turns the whole result 180° about Z — a proper
 * rotation, so it reverses which end reads as high X *and* which side reads
 * as high Y together, rather than mirroring the part into its own reflection
 * — for when a hand-written or externally posted program counts X the other
 * way along the same physical setup. `datum.point`, in the raw import frame,
 * then becomes the new (0,0,0) once everything above has been applied.
 *
 * Turning is never reoriented — `turningProfile` finds its own spindle axis
 * by symmetry — so only the translation matters there, and only its
 * component along that axis has any visible effect, because the profile is
 * already re-centred radially on the bounding box regardless of X/Y.
 *
 * @param {{soup:object, welded:object}} raw the mesh exactly as imported
 * @param {{planeNormal:number[]|null, rotaryZero:number[]|null,
 *   reverseX:boolean, point:number[]|null}} datum
 * @param {{mode:'mill'|'turn'}} opts
 * @returns {{soup:object, welded:object, orientation:object|null}}
 *   `orientation` is `orientForMilling`'s record for mill — with an `angle`
 *   field added when `rotaryZero` moved anything, and `reverseX:true` when
 *   set — or `null` for turn, where none of this applies.
 */
export function applyDatum(raw, datum, { mode }) {
  if (mode !== 'mill') {
    let { soup, welded } = raw;
    if (datum?.point) {
      soup = translate(soup, datum.point);
      welded = translate(welded, datum.point);
    }
    return { soup, welded, orientation: null };
  }

  const override = datum?.planeNormal ? orientToNormal(datum.planeNormal) : undefined;
  const laid = orientForMilling(raw.soup, raw.welded, override);
  let { soup, welded } = laid;
  let orientation = laid.orientation;

  if (datum?.rotaryZero) {
    // The picked normal is in the raw frame; bring it into the frame the
    // permutation above just established (no `angle` on it yet) before
    // measuring how far it is from pointing straight up.
    const permutedNormal = pointFromRawFrame(datum.rotaryZero, orientation);
    const zeroAngle = angleToFaceUp(permutedNormal);
    if (zeroAngle) {
      soup = rotateAboutX(soup, zeroAngle);
      welded = rotateAboutX(welded, zeroAngle);
    }
    orientation = { ...orientation, angle: zeroAngle, changed: orientation.changed || zeroAngle !== 0 };
  }

  if (datum?.reverseX) {
    soup = reorient(soup, REVERSE_X_TRANSFORM);
    welded = reorient(welded, REVERSE_X_TRANSFORM);
    orientation = { ...orientation, reverseX: true, changed: true };
  }

  if (datum?.point) {
    const shifted = pointFromRawFrame(datum.point, orientation);
    soup = translate(soup, shifted);
    welded = translate(welded, shifted);
  }
  return { soup, welded, orientation };
}

// Re-exported so callers that only need bounds for a preset (e.g. "origin at
// the bounding-box corner") don't have to import `analyze.js` separately.
export { boundsOf };
