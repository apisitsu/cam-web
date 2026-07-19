/**
 * Camera framing maths for the viewport — pure, so the thing that decides where
 * the camera looks can be tested without a canvas.
 *
 * This lives here because every camera bug so far has been arithmetic, not
 * rendering: `camera.up` going degenerate when it was parallel to the view
 * direction, a lathe preset showing the wrong plane, a fit reading the radius off
 * the wrong axis. None of that needs WebGL to catch — it needs a cross product
 * and an assertion.
 *
 * Vectors are plain `[x, y, z]` arrays; `Viewport` converts to THREE.Vector3.
 */

/** Camera offset direction (camera sits at centre + dir·distance) per preset. */
export const VIEW_DIRS = {
  iso:    [1, -1, 1],
  top:    [0, -1e-3, 1],
  bottom: [0, 1e-3, -1],
  front:  [0, -1, 0],
  back:   [0, 1, 0],
  right:  [1, 0, 0],
  left:   [-1, 0, 0],
};

/**
 * Turning has its own view set. A lathe is programmed X = radius, Z = spindle,
 * and its physical vertical is **Y** — the cross-slide (X) and the bed (Z) both
 * run horizontally, so the turned profile lies in a *horizontal* X-Z plane and
 * you look **down** at it:
 *   - Top/Bottom look down Y → the X-Z working plane: Z across, radius up, tool
 *     standing on top. **This is where the toolpath reads.**
 *   - Front/Back look down X → the operator's view (Z across, Y up). All the
 *     geometry sits at Y=0, so a lathe program is edge-on here by nature.
 *   - Right/Left look down Z → the end view at the chuck, Y up. +Z is to the
 *     right in Top, so the +Z end is the machine's right.
 *   - Iso sits above (+Y) on the Front side, a 3/4 of the profile.
 *
 * Z runs left→right in Top, Front and Iso alike, so switching between them never
 * flips the part end-for-end.
 */
export const TURN_VIEW_DIRS = {
  top:    [0, 1, 0],
  bottom: [0, -1, 0],
  front:  [-1, 0, 0],
  back:   [1, 0, 0],
  right:  [0, 0, 1],
  left:   [0, 0, -1],
  iso:    [-1, 1, 1],
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Offset direction for a preset in a given machine mode. */
export function viewDir(mode, view) {
  const arr = (mode === 'turn' ? TURN_VIEW_DIRS[view] : null) ?? VIEW_DIRS[view] ?? VIEW_DIRS.iso;
  return norm(arr);
}

/** World up: milling is Z-up, turning is Y-up (a lathe's vertical is Y). */
export function worldUpFor(mode) {
  return mode === 'turn' ? [0, 1, 0] : [0, 0, 1];
}

/**
 * The screen axes for a view: `dir` (camera offset), `right` and `up`.
 *
 * `up` is what the camera must actually be oriented with. Using the world-up
 * instead is the trap: the two disagree whenever the fallback below fires, and
 * world-up goes degenerate when it is parallel to the view direction — which is
 * exactly Top/Bottom — leaving the camera roll undefined.
 */
export function viewBasis(mode, view) {
  const dir = viewDir(mode, view);
  const forward = [-dir[0], -dir[1], -dir[2]]; // camera → target
  const worldUp = worldUpFor(mode);
  let upRef = worldUp;
  if (Math.abs(dot(forward, upRef)) > 0.99) {
    // Looking straight down the world-up axis. Fall back to the axis drawn
    // upward in that plan view: X for the lathe (radius up, the turning-drawing
    // convention), Y for the mill.
    upRef = mode === 'turn' ? [1, 0, 0] : [0, 1, 0];
  }
  const right = norm(cross(forward, upRef));
  const up = norm(cross(right, forward));
  return { dir, forward, right, up };
}

/** Union two [min,max] boxes; either may be null. */
export function unionBounds(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    min: a.min.map((v, i) => Math.min(v, b.min[i])),
    max: a.max.map((v, i) => Math.max(v, b.max[i])),
  };
}

/** Half-size of the working area framed when nothing is loaded or drawn (mm). */
export const EMPTY_VIEW_HALF_SPAN = 80;

/**
 * How to frame `bounds` for a view: the camera zoom that fits it, the centre to
 * look at, and the bounding radius used to stand the camera off.
 *
 * The box is projected onto *this view's* screen axes, so a wide-shallow and a
 * tall-narrow part both fill the canvas — measuring the 3D diagonal instead made
 * an out-of-plane dimension (a 4-axis part's rotated retracts) shrink the part to
 * a sliver.
 *
 * @param {{min:number[],max:number[]}|null} bounds
 * @param {{width:number,height:number}} canvas  canvas size in pixels
 */
export function framing(mode, view, bounds, canvas, { margin = 1.08 } = {}) {
  const D = EMPTY_VIEW_HALF_SPAN;
  const min = bounds?.min ?? [-D, -D, 0];
  const max = bounds?.max ?? [D, D, 0];
  const center = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
  const { dir, right, up } = viewBasis(mode, view);

  let hw = 1e-3;
  let hh = 1e-3;
  let radius = 1e-3;
  for (let xi = 0; xi < 2; xi++) {
    for (let yi = 0; yi < 2; yi++) {
      for (let zi = 0; zi < 2; zi++) {
        const c = sub([xi ? max[0] : min[0], yi ? max[1] : min[1], zi ? max[2] : min[2]], center);
        hw = Math.max(hw, Math.abs(dot(c, right)));
        hh = Math.max(hh, Math.abs(dot(c, up)));
        radius = Math.max(radius, Math.hypot(c[0], c[1], c[2]));
      }
    }
  }
  // R3F sizes an ortho frustum to the canvas pixels at zoom 1, so the visible
  // world span is (pixels / zoom). Take the zoom that fits both screen axes.
  const zoom = Math.max(
    Math.min(canvas.width / (2 * hw * margin), canvas.height / (2 * hh * margin)),
    1e-3,
  );
  // Distance is irrelevant to ortho scale — only push far enough that the whole
  // scene sits inside a generous [near, far] slab, so zoom/orbit never clips.
  const distance = radius * 3 + 100;
  return {
    center, dir, right, up, zoom, radius, distance,
    position: [0, 1, 2].map((i) => center[i] + dir[i] * distance),
    near: 0.1,
    far: distance + radius * 3 + 1000,
  };
}
