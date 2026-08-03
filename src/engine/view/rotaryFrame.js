/**
 * Which frame the 4th axis is *drawn* in — the part's, or the machine's.
 *
 * A rotary table turns the work. Nothing on a real 4-axis mill tilts the
 * spindle: the cutter hangs straight down +Z from the moment it is loaded to
 * the moment it comes out, and every face the program reaches is reached by
 * rolling the part under it. There are two honest ways to put that on screen,
 * and they are the same rigid motion viewed from opposite ends:
 *
 * - **part frame** — undo the table's rotation, so each index's toolpath lands
 *   on the workpiece where it belongs and the part never moves. The tool then
 *   has to tilt to stay normal to the face it is cutting. This is the frame to
 *   *inspect* a job in: every face is assembled onto one model.
 * - **machine frame** — leave the coordinates as programmed. The tool stays
 *   upright and the **work rotates**, which is what actually happens at the
 *   machine. This is the frame to *watch* a job in, and the one to reach for
 *   when the question is "will the fixture clear the spindle at A90".
 *
 * The interpreter already emits either (`rotaryFrame` in `gcode/interpreter.js`;
 * 'part' is its default, and the height-field simulator has always asked for
 * 'machine'). What was missing was the other half: in machine frame the *view*
 * has to turn the workpiece by the same angle the interpreter declined to undo,
 * or the toolpath would swing around a part standing still and cut air.
 *
 * Sign convention, and the only thing here that can be wrong in a way that
 * looks plausible: `toPartFrame` maps a machine point by Rx(−A). So the part
 * geometry, which is stored in the part frame, is put back into the machine
 * frame by **Rx(+A)** — turn the work the way the table turns it. Getting this
 * backwards draws the part rolling away from the cut instead of into it.
 *
 * Pure maths over plain numbers: no React, no three.js, no store.
 */

const DEG = Math.PI / 180;

/**
 * Does this machine turn the *work* on a rotary axis?
 *
 * True for a mill with an A axis — a rotary table or trunnion bolted to the
 * table, which is what "4-axis" means in this app (see `AXES.mill4` in
 * `cam/machines.js`). A lathe's C axis also turns the work, but turning is
 * already drawn in the spindle frame and has no part-frame alternative to
 * choose between, so it is deliberately not included.
 *
 * @param {{kind?:string, rotary?:string[]}|null} machine
 */
export function workRotates(machine) {
  if (!machine || machine.kind !== 'mill') return false;
  return (machine.rotary ?? []).includes('A');
}

/**
 * The frame to draw in: the operator's pick when they made one, otherwise the
 * machine's own answer.
 *
 * Defaulting off the machine is the point of the feature — picking a 4-axis
 * VMC should be enough to make the simulation behave like one, without a second
 * setting to find. `pinned` is what a manual toggle sets, and it wins until the
 * machine changes under it.
 *
 * @param {object|null} machine
 * @param {'part'|'machine'|'auto'} [pinned]
 * @returns {'part'|'machine'}
 */
export function rotaryFrameFor(machine, pinned = 'auto') {
  if (pinned === 'part' || pinned === 'machine') return pinned;
  return workRotates(machine) ? 'machine' : 'part';
}

/**
 * How to place the workpiece for the frame being drawn.
 *
 * Returned as a pivot / rotation / unpivot triple because rotating about a line
 * that is not the origin is the whole difficulty: the physical A axis runs
 * through wherever the operator touched it off (`ctx.rotaryCenter`, a Y/Z
 * pair), not through the part's own zero. Nesting three groups in that order is
 * the declarative equivalent of translate → rotate → translate back.
 *
 * `baseA` is the angle the geometry is **already** expressed at, which is not
 * always zero: the height-field simulator carves one rotary index in the
 * machine frame, so its stock arrives pre-rotated to `aIndex` and must only be
 * turned the *remaining* way. Part-frame geometry (the imported model, the
 * voxel sim) leaves it at 0. Ignoring this double-rotates the carved stock off
 * the model it was cut from.
 *
 * @param {'part'|'machine'} frame
 * @param {{a?:number, baseA?:number, center?:[number,number]}} [opts]
 *   a — the A index (degrees) at the playhead; baseA — the angle the geometry
 *   already sits at; center — Y/Z the physical A axis passes through.
 */
export function workTransform(frame, opts = {}) {
  const { a = 0, baseA = 0, center = [0, 0] } = opts;
  // Part frame is where the geometry already lives, so there is nothing to do —
  // returning an explicit identity (rather than null) keeps the caller free of
  // a branch it would otherwise have to get right in JSX.
  const degrees = frame === 'machine' ? (a || 0) - (baseA || 0) : 0;
  const theta = degrees * DEG;
  const [cy = 0, cz = 0] = center ?? [];
  return {
    degrees,
    rotation: [theta, 0, 0],
    pivot: [0, cy, cz],
    unpivot: [0, -cy, -cz],
    identity: Math.abs(degrees) < 1e-9,
  };
}

/**
 * How to orient the tool marker for the frame being drawn.
 *
 * Part frame: tilt by the negative of the index, so the cutter stands normal to
 * the face — the part is not moving, so the tool has to. Machine frame: no tilt
 * at all, ever. A real spindle does not swivel, and drawing it swivelled is the
 * exact thing this frame exists to stop.
 *
 * B is carried through for the 5-axis case, composed the same way the
 * interpreter composes its undo (Ry(−B)·Rx(−A)); the viewport nests two groups
 * in that order.
 *
 * @param {'part'|'machine'} frame
 * @param {{a?:number, b?:number}|null} [rotary]
 * @returns {{a:number, b:number}} radians
 */
export function toolTilt(frame, rotary) {
  if (frame === 'machine' || !rotary) return { a: 0, b: 0 };
  return {
    a: -(rotary.a || 0) * DEG,
    b: -(rotary.b || 0) * DEG,
  };
}

/**
 * The box the work sweeps as the table turns, for framing the camera.
 *
 * In the machine frame a 4-axis program's cutting moves collapse onto the top
 * of the part — the tool is always above the A axis, so a four-face job that
 * spans ±30 mm in the part frame reads as a *plane* at Y0 in machine
 * coordinates. Fitting the camera to that gives a sliver: correct bounds, a
 * useless view. What is actually on screen over the run is those moves swept
 * around the rotary axis, so that is what has to be framed.
 *
 * X is untouched — it is the axis of rotation. Y and Z open out to the box's
 * own largest radius from the axis, which is exactly the circle the farthest
 * corner traces. With nothing indexing, that is a bounding sphere's worth of
 * slack in two axes and no more.
 *
 * @param {{min:number[], max:number[]}|null} box
 * @param {[number,number]} [center] Y/Z the A axis passes through
 */
export function sweptFitBox(box, center = [0, 0]) {
  if (!box || !box.min || !box.max) return box ?? null;
  const [cy = 0, cz = 0] = center ?? [];
  let r = 0;
  for (const y of [box.min[1], box.max[1]]) {
    for (const z of [box.min[2], box.max[2]]) {
      r = Math.max(r, Math.hypot(y - cy, z - cz));
    }
  }
  if (!Number.isFinite(r)) return box;
  return {
    min: [box.min[0], cy - r, cz - r],
    max: [box.max[0], cy + r, cz + r],
  };
}

/**
 * One line for the UI: what the viewer is about to see.
 *
 * Worth naming rather than leaving to a bare toggle label, because "part" and
 * "machine" describe the *coordinate frame* and operators think in terms of
 * what moves on screen.
 */
export function frameLabel(frame) {
  return frame === 'machine' ? 'Work rotates' : 'Tool rotates';
}
