/**
 * Which tool is actually in the spindle — one answer, for the carve and for the
 * picture.
 *
 * Three things can say what tool a move is made with, and they disagree:
 *
 * 1. the **tool table override** — what the operator picked in the Tool table;
 * 2. the **program's own comment** — `T1(FACEMILL D50 - FACE)`, detected by
 *    `gcode/tools.js`;
 * 3. the **fallback cutter** — the picker under the Tool table, for a program
 *    that never named its tools.
 *
 * They used to be resolved twice, differently: `sim/session.js` merged (1) and
 * (2) into a radius and a flat/ball for the carvers, while `App.jsx` did its own
 * merge for the marker — and deliberately dropped the cutter TYPE the moment the
 * program named any tool at all. The result was a picker that changed the
 * simulation while the tool on screen went on being the same stick, which reads
 * exactly like a picker that does nothing.
 *
 * So the precedence lives here once, and both callers ask it:
 *
 * - **the cutter shape** is the operator's pick, else the program's comment,
 *   else — only when nothing at all is known about the tool — the fallback.
 * - **the size** is the operator's diameter, else the detected one, else the
 *   fallback's.
 * - a tool with **no shape we can draw** (a drill, a tap, a reamer) keeps the
 *   plain flat/ball it always had. `cutterFromType` returns null for those.
 *
 * Pure: plain data in, plain data out.
 */

import { cutterById } from './cutters.js';

/**
 * @typedef {object} ResolvedTool
 * @property {number} radius     cutting radius, mm
 * @property {string} [cutter]   cutter id from `cutters.js`, when one is known
 * @property {'flat'|'ball'|'cone'} type  the surface `cutFootprint` carves
 * @property {number} [thickness] how far up the tool it cuts, when stated
 * @property {number} [shank]     shank diameter, when stated
 * @property {number} [angle]    included angle, cone cutters only
 * @property {number} length     gauge length (tip to collet), 0 when unknown
 */

/**
 * @param {{detected?:object|null, override?:object|null, fallback?:object}} args
 *   `detected` is a row of `stats.tools`; `override` is `toolOverrides[n]`;
 *   `fallback` is an already-resolved tool (`cutterGeometry`'s output, plus a
 *   `cutter` id when the caller wants the marker to draw it).
 * @returns {ResolvedTool}
 */
export function effectiveTool({ detected = null, override = null, fallback = {} } = {}) {
  const ov = override || {};
  const det = detected || {};

  const diameter = ov.diameter ?? det.diameter ?? null;
  const radius = diameter != null ? diameter / 2 : (det.radius ?? null);
  const cutter = ov.cutter
    // A project saved before the tool table offered types carries only the old
    // Flat/Ball choice. "Ball" was an explicit pick of a rounded end and must
    // still win over the comment; "flat" was the default half of a two-way
    // switch and says nothing a detected face mill does not say better.
    ?? (ov.simType === 'ball' ? 'ball' : null)
    ?? det.cutter
    ?? null;
  const simType = ov.simType ?? det.simType ?? null;
  const length = ov.length ?? det.length ?? null;

  // Nothing is known about this tool: no size, no shape, nothing typed in. The
  // carvers hand such a move to the fallback cutter, so the marker must draw
  // that same tool — anything else shows a cut being made by a tool that is not
  // on screen. (`detected.simType` is not a signal here: the interpreter stamps
  // 'flat' on every tool it lists, including one that only ever appeared as a
  // bare `T5` with no comment at all.)
  if (!(radius > 0) && !cutter && !ov.simType) {
    return { ...fallback, length: length ?? fallback.length ?? 0 };
  }

  const spec = cutter ? cutterById(cutter) : null;
  const angle = ov.angle ?? spec?.angle;
  const r = radius > 0 ? radius : (fallback.radius ?? 3);
  const thickness = ov.thickness ?? fallback.thickness;
  const shank = ov.shank ?? fallback.shank;
  return {
    radius: r,
    ...(cutter ? { cutter } : {}),
    type: spec ? spec.profile : (simType ?? 'flat'),
    ...(spec?.profile === 'cone' ? { angle: angle ?? 90 } : {}),
    // The cutting body's length and the shank's diameter, when the operator has
    // stated them — on this tool's own row, else on the fallback picker.
    //
    // The fallback fills in here where it does NOT for the type or the size,
    // and the difference is not an inconsistency: a program's comment can name
    // its cutter and give its diameter, so a fallback that overrode those would
    // be overruling the program. There is no comment syntax for a cutting-body
    // length. If the operator has typed one anywhere and the tool that is
    // cutting does not have its own, that number is the only measurement in the
    // room — and dropping it silently is how "I told it the cutter is 3 mm
    // thick and the groove came out 10" happens.
    //
    // Absent everywhere means "not measured": the marker falls back to what the
    // type implies (`defaultThickness`) and the carvers leave the cut alone,
    // rather than treating a drawing default as a depth limit.
    ...(thickness > 0 ? { thickness } : {}),
    ...(shank > 0 ? { shank } : {}),
    length: length ?? 0,
  };
}
