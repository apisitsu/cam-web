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

const AXIS_NAME = ['X', 'Y', 'Z'];
const NO_FLIP = [false, false, false];

/** cos 1°: a face further off an axis than this is curved or genuinely angled. */
const SQUARE_TO_AXIS = 0.99985;

/**
 * Which displayed axes a datum reverses, as `[x, y, z]` booleans.
 *
 * A project saved before Y and Z could flip carries `reverseX:true` instead,
 * which was the same 180° turn about Z that X and Y reversed together are now.
 */
export function flipOf(datum) {
  if (datum?.flip) return datum.flip;
  return datum?.reverseX ? [true, true, false] : NO_FLIP;
}

/**
 * Flip one axis, carrying the next axis round with it (X→Y, Y→Z, Z→X).
 *
 * Reversing a single axis is a reflection, which would machine the mirror image
 * of the model with nothing on screen looking wrong. Reversing two is a 180°
 * turn about the third, so the part stays itself, and every setup keeps an even
 * number of reversed axes.
 */
export function toggledFlip(flip, axis) {
  const next = [...flip];
  next[axis] = !next[axis];
  const partner = (axis + 1) % 3;
  next[partner] = !next[partner];
  return next;
}

function applyFlip([x, y, z], flip) {
  return [flip[0] ? -x : x, flip[1] ? -y : y, flip[2] ? -z : z];
}

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
 * `angleToFaceUp`) and a `flip` 180° turn on top of that (see `applyDatum`) —
 * undone in the reverse of the order they were applied.
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
    order, flipY = false, signs, angle = 0, flip = NO_FLIP,
  } = orientation;
  const [sx, sy, sz] = signs ?? [1, flipY ? -1 : 1, 1];
  let [x, y, z] = applyFlip(point, flip);
  if (angle) [y, z] = rotateYZ(y, z, -angle);
  const out = new Array(3);
  out[order[0]] = x * sx;
  out[order[1]] = y * sy;
  out[order[2]] = z * sz;
  return out;
}

/** The forward transform of a single point, mirroring what `reorient` (plus a picked A0 and/or `flip`) does to vertices. */
export function pointFromRawFrame(point, orientation) {
  if (!orientation) return point;
  const {
    order, flipY = false, signs, angle = 0, flip = NO_FLIP,
  } = orientation;
  const [sx, sy, sz] = signs ?? [1, flipY ? -1 : 1, 1];
  const x = point[order[0]] * sx;
  let y = point[order[1]] * sy;
  let z = point[order[2]] * sz;
  if (angle) [y, z] = rotateYZ(y, z, angle);
  return applyFlip([x, y, z], flip);
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
 * A picked face, taken from the frame on screen back into the raw frame.
 *
 * A face comes off the **displayed** mesh — laid down, and shifted by the datum
 * if one is set — while the solids the feature tree builds live in the raw
 * frame the soup was handed to `loadSoup` in. They only agree when the
 * orientation happens to be the identity; for an ordinary extrude it is not (a
 * part laid along X comes back quarter-turned about Z), so comparing a picked
 * face with a feature's bounds directly says "no match" for a face that plainly
 * is the top of that feature. Bounds are transformed corner-to-corner and
 * re-sorted, because a permutation or a sign flip swaps which corner is the min.
 *
 * @param {{normal:number[], centroid:number[], bounds?:{min:number[],max:number[]}}} face
 * @param {object|null} orientation the active lay-down orientation
 * @param {number[]|null} datumPoint the origin in force (raw frame), or null
 */
export function faceToRawFrame(face, orientation, datumPoint) {
  if (!face?.normal || !face?.centroid) return face;
  const out = {
    ...face,
    // A direction: rotation only, no shift.
    normal: pointToRawFrame(face.normal, orientation),
    centroid: displayedPointToRawFrame(face.centroid, orientation, datumPoint),
  };
  // `facing` is a word for the displayed frame ("up"); once the part has been
  // laid down it would name the wrong side, and a plane built from this face
  // takes its label from it.
  if (orientation) delete out.facing;
  if (face.bounds?.min && face.bounds?.max) {
    const a = displayedPointToRawFrame(face.bounds.min, orientation, datumPoint);
    const b = displayedPointToRawFrame(face.bounds.max, orientation, datumPoint);
    out.bounds = {
      min: a.map((v, i) => Math.min(v, b[i])),
      max: a.map((v, i) => Math.max(v, b[i])),
    };
  }
  return out;
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
 * @param {number} [offset] how far along +axis the zero sits from the picked plane
 * @returns {number[]} the new origin, in the raw import frame
 */
export function originFromAxisPick(currentRawPoint, orientation, axis, clickedDisplayed, offset = 0) {
  const g = currentRawPoint ? pointFromRawFrame(currentRawPoint, orientation) : [0, 0, 0];
  const next = [...g];
  next[axis] = g[axis] + clickedDisplayed[axis] + offset;
  return pointToRawFrame(next, orientation);
}

/**
 * Put the origin on a circle's centre: the two axes across the circle move, and
 * the one along it stays, since a centre says nothing about depth.
 *
 * @param {number[]|null} currentRawPoint the origin in force (raw frame), or null
 * @param {number[]|null} currentRawOffset the offset in force (raw frame), or null
 * @param {object|null} orientation the active lay-down orientation
 * @param {0|1|2} circleAxis the displayed axis the circle runs along
 * @param {number[]} center the centre, in the displayed frame
 * @returns {number[]} the new origin, in the raw import frame
 */
export function originFromCircle(currentRawPoint, currentRawOffset, orientation, circleAxis, center) {
  const g = currentRawPoint ? pointFromRawFrame(currentRawPoint, orientation) : [0, 0, 0];
  const d = currentRawOffset ? pointFromRawFrame(currentRawOffset, orientation) : [0, 0, 0];
  const next = g.map((v, i) => (i === circleAxis ? v : v + center[i] + d[i]));
  return pointToRawFrame(next, orientation);
}

/**
 * The axis layout that brings a clicked flat face square to the axis being set,
 * or `null` when the part should stay as it is.
 *
 * It stays put for a face already square to that axis, on either side: clicking
 * the far side of a block for X0 is an ordinary touch-off, not a request to turn
 * it round. It also stays put for a curved or angled surface, which has no axis to
 * bring square, so such a click only sets the origin as it always did.
 *
 * Otherwise the part takes the one 90° turn that puts the face's outward normal on
 * +axis, about the third axis, which therefore stays where it is: standing a part
 * up on Z and then squaring a side to X leaves it standing. Everything already
 * applied, flips included, is folded into the result, so it needs no flip of its
 * own and the operator can flip again from there.
 *
 * @param {object} orientation the active lay-down orientation
 * @param {number[]} normal the clicked face's outward normal, in the displayed frame
 * @param {0|1|2} axis the displayed axis being set
 * @returns {{order:number[], signs:number[], changed:boolean, description:string}|null}
 */
export function realignedAxes(orientation, normal, axis) {
  const abs = normal.map(Math.abs);
  const from = abs.indexOf(Math.max(...abs));
  if (from === axis || abs[from] < SQUARE_TO_AXIS * Math.hypot(...normal)) return null;
  const sign = normal[from] < 0 ? -1 : 1;
  return signedAxes(orientation, (shown) => {
    const turned = [...shown];
    turned[axis] = sign * shown[from];
    turned[from] = -sign * shown[axis];
    return turned;
  }, NO_FLIP, `Set the part with the picked face square to ${AXIS_NAME[axis]}, facing +${AXIS_NAME[axis]}.`);
}

/**
 * Re-express the frame on screen, moved by a quarter turn, as an axis layout.
 *
 * `keptFlip` is the flip that will still be applied on top of the result, so it is
 * taken back out here. Passing none folds every flip into the layout instead.
 */
function signedAxes(orientation, move, keptFlip, description) {
  const order = [0, 0, 0];
  const signs = [1, 1, 1];
  for (let raw = 0; raw < 3; raw += 1) {
    const unit = [0, 0, 0];
    unit[raw] = 1;
    const moved = applyFlip(move(pointFromRawFrame(unit, orientation)), keptFlip);
    const to = moved.findIndex((v) => Math.abs(v) > 0.5);
    order[to] = raw;
    signs[to] = moved[to] < 0 ? -1 : 1;
  }
  return {
    order,
    signs,
    changed: order.some((raw, i) => raw !== i) || signs.some((s) => s !== 1),
    description,
  };
}

/** Each axis's lock, moved to the axis the plane it was set on reads on now. */
function carriedLocks(axesSet, orientation, nextOrientation) {
  const carried = [false, false, false];
  axesSet.forEach((locked, was) => {
    const unit = [0, 0, 0];
    unit[was] = 1;
    const now = pointFromRawFrame(pointToRawFrame(unit, orientation), nextOrientation);
    carried[now.findIndex((v) => Math.abs(v) > 0.5)] = locked;
  });
  return carried;
}

/**
 * Turn the part 90° about one axis of the frame on screen, counter-clockwise looking
 * down that axis, as a patch for the datum.
 *
 * `datum.point` stays as it is, so the turn happens about the origin: X0/Y0 set on
 * a bore stay on that bore while a keyway beside it comes round. Any flip stays on.
 *
 * @param {object} datum the datum in force
 * @param {object} orientation the active lay-down orientation
 * @param {0|1|2} axis the displayed axis to turn about
 */
export function quarterTurn(datum, orientation, axis) {
  const flip = flipOf(datum);
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const axes = signedAxes(orientation, (shown) => {
    const turned = [...shown];
    turned[u] = -shown[v];
    turned[v] = shown[u];
    return turned;
  }, flip, `Set the part turned to the layout chosen on the panel, last 90° about ${AXIS_NAME[axis]}.`);
  return { axes, axesSet: carriedLocks(datum.axesSet, orientation, { ...axes, flip }) };
}

/**
 * What a pick on a flat face changes when it also turns the part, as a patch for
 * the datum, or `null` when `realignedAxes` says the part stays put.
 *
 * The clicked point is taken back to the raw frame before the layout changes and
 * re-read in the new one. Whatever else was already set stays on the same spot of
 * the part, so its lock has to follow it to the axis it now reads on.
 *
 * @param {object} datum the datum in force
 * @param {object} orientation the active lay-down orientation
 * @param {0|1|2} axis the displayed axis being set
 * @param {number[]} clicked the picked point, in the displayed frame
 * @param {number[]} normal the clicked face's outward normal, in the displayed frame
 */
export function realignAxisPick(datum, orientation, axis, clicked, normal) {
  const axes = realignedAxes(orientation, normal, axis);
  if (!axes) return null;
  const clickedRaw = displayedPointToRawFrame(clicked, orientation, datum.point);
  const next = datum.point ? [...pointFromRawFrame(datum.point, axes)] : [0, 0, 0];
  const offset = datum.offset ? pointFromRawFrame(datum.offset, axes)[axis] : 0;
  next[axis] = pointFromRawFrame(clickedRaw, axes)[axis] + offset;

  const axesSet = carriedLocks(datum.axesSet, orientation, axes);
  axesSet[axis] = true;

  return {
    axes, flip: NO_FLIP, point: pointToRawFrame(next, axes), axesSet,
  };
}

/**
 * Set how far ONE axis's zero sits from the plane it was picked on.
 *
 * `datum.point` always holds the effective origin, offset included, so nothing
 * downstream has to know offsets exist. `datum.offset` remembers how much of it
 * is offset, which is what lets 0.5 → 1.0 move the origin by 0.5 rather than
 * stacking on what is already there. Both are in the raw import frame, so a flip
 * turns the part about the origin without moving it on the part: the fields read
 * with the opposite sign and the physical zero stays where it was.
 *
 * @param {number[]|null} currentRawPoint the origin in force (raw frame), or null
 * @param {number[]|null} currentRawOffset the offset in force (raw frame), or null
 * @param {object|null} orientation the active lay-down orientation
 * @param {0|1|2} axis the displayed axis being offset
 * @param {number} value distance along +axis, in the displayed frame
 * @returns {{point:number[], offset:number[]}} both in the raw import frame
 */
export function originFromAxisOffset(currentRawPoint, currentRawOffset, orientation, axis, value) {
  const g = currentRawPoint ? pointFromRawFrame(currentRawPoint, orientation) : [0, 0, 0];
  const d = currentRawOffset ? pointFromRawFrame(currentRawOffset, orientation) : [0, 0, 0];
  return {
    point: originFromAxisValue(currentRawPoint, orientation, axis, g[axis] + value - d[axis]),
    offset: originFromAxisValue(currentRawOffset, orientation, axis, value),
  };
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
 * For milling, `datum.axes` (see `realignedAxes`) or `datum.planeNormal` overrides
 * `orientForMilling`'s automatic shortest-extent decision; leaving both unset keeps that automatic behaviour
 * exactly as it is today (this is what makes the feature invisible to a part
 * nobody has picked a datum for). `datum.rotaryZero` — a second, independent
 * face pick — then turns the part about that same (now-established) rotary
 * axis so the picked face reads as A0; a 4-axis part rarely arrives modelled
 * at the angle it will actually be chucked at, and this is the "index by eye
 * once" step that fixes that without touching `indexAngle`'s own numbering.
 * `datum.flip` then turns the whole result 180° about one axis — a proper
 * rotation, so two axes reverse together (see `toggledFlip`) rather than
 * mirroring the part into its own reflection — for when a hand-written or
 * externally posted program counts an axis the other way along the same
 * physical setup. `datum.point`, in the raw import frame, then becomes the new
 * (0,0,0) once everything above has been applied, so the turn happens about the
 * origin and the origin stays on the same spot of the part.
 *
 * Turning is never reoriented — `turningProfile` finds its own spindle axis
 * by symmetry — so only the translation matters there, and only its
 * component along that axis has any visible effect, because the profile is
 * already re-centred radially on the bounding box regardless of X/Y.
 *
 * @param {{soup:object, welded:object}} raw the mesh exactly as imported
 * @param {{planeNormal:number[]|null, rotaryZero:number[]|null,
 *   flip:boolean[], point:number[]|null}} datum
 * @param {{mode:'mill'|'turn'}} opts
 * @returns {{soup:object, welded:object, orientation:object|null}}
 *   `orientation` is `orientForMilling`'s record for mill — with an `angle`
 *   field added when `rotaryZero` moved anything, and `flip` when any axis is
 *   reversed — or `null` for turn, where none of this applies.
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

  const override = datum?.axes
    ?? (datum?.planeNormal ? orientToNormal(datum.planeNormal) : undefined);
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

  const flip = flipOf(datum);
  if (flip.some(Boolean)) {
    const turn = { order: [0, 1, 2], signs: flip.map((f) => (f ? -1 : 1)) };
    soup = reorient(soup, turn);
    welded = reorient(welded, turn);
    const reversed = AXIS_NAME.filter((_, i) => flip[i]).join(' and ');
    orientation = {
      ...orientation,
      flip,
      changed: true,
      // This line is what the setter reads at the vice, and a flip can turn the
      // part upside down, so it has to say so rather than repeat the lay-down.
      description: `${orientation.description} Then turned 180° so ${reversed} read reversed.`,
    };
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
