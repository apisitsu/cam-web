/**
 * The control's POSITION (ABSOLUTE) readout — which axes it lists, and what
 * number each one shows.
 *
 * "Absolute" on a real control means the position in the active work coordinate
 * system, and in this app that is simply the program's own coordinates: there is
 * no live G54 table (see `cam/envelope.js`), because a datum is baked into the
 * mesh's coordinates instead (see `mesh/datum.js`). So the tool point
 * `toolPointAt` returns is already an absolute work position for milling, and
 * needs no offset applied on the way to the screen.
 *
 * Turning is the exception, and it is the reason this module exists rather than
 * three `toFixed(3)` calls in the component. `interpreter.js` halves the X word
 * into a radius when `diameterMode` is on, because every arc centre, tool radius
 * and stock calculation downstream wants a radius. A lathe control's ABSOLUTE
 * page shows X as a **diameter** — the same number the programmer typed. Posting
 * the stored radius there would read as half the part, which is exactly the kind
 * of quiet factor-of-two an operator trusts and shouldn't have to check.
 *
 * Pure. No React, no store, no three.js.
 */

/** Decimal places a metric control posts — microns, same as the program. */
export const COORD_DECIMALS = 3;

/**
 * Does this program index the rotary axis anywhere but zero?
 *
 * A 3-axis program should not grow an A row that reads 0.000 forever — a control
 * only lists the axes the machine has. `aIndices` is `stats.aIndices`, the
 * distinct A values the interpreter saw.
 */
export function usesRotary(aIndices) {
  if (!aIndices || aIndices.length === 0) return false;
  return aIndices.length > 1 || aIndices.some((a) => a !== 0);
}

/**
 * Axis labels the readout lists, in the order a control stacks them.
 *
 * Turning drops Y outright: the app's turn mode works the G18 ZX plane, so a Y
 * row would be a permanent 0.000 that says nothing about a 2-axis lathe.
 */
export function droAxisLabels({ mode = 'mill', rotary = false } = {}) {
  if (mode === 'turn') return ['X', 'Z'];
  return rotary ? ['X', 'Y', 'Z', 'A'] : ['X', 'Y', 'Z'];
}

/**
 * One coordinate, formatted the way a control posts it: fixed decimals, never
 * exponential, and `-0.000` folded to `0.000` — a signed zero is an artefact of
 * the arithmetic, not a position.
 */
export function formatCoord(value, decimals = COORD_DECIMALS) {
  if (!Number.isFinite(value)) return (0).toFixed(decimals);
  const out = value.toFixed(decimals);
  return /^-0\.?0*$/.test(out) ? out.slice(1) : out;
}

/**
 * The absolute position as the control would post it, per axis label.
 *
 * `point` is a tool tip in the program's own coordinates (what `toolPointAt`
 * returns), or null before the playhead has moved — a control reads zero then,
 * not blank. `rotary` is the A/B record from `rotaryAt`.
 */
export function absoluteValue(label, point, { mode = 'mill', diameterMode = true, rotary = null } = {}) {
  const [x = 0, y = 0, z = 0] = point ?? [];
  switch (label) {
    case 'X':
      // Back to a diameter for the readout — see the module note.
      return mode === 'turn' && diameterMode ? x * 2 : x;
    case 'Y': return y;
    case 'Z': return z;
    case 'A': return rotary?.a ?? 0;
    case 'B': return rotary?.b ?? 0;
    default: return 0;
  }
}

/**
 * The whole readout as rows the view maps straight onto JSX.
 *
 * @param {number[]|null} point tool tip in program coordinates, or null
 * @param {{mode?:'mill'|'turn', diameterMode?:boolean,
 *   rotary?:{a:number,b:number}|null, aIndices?:number[]}} opts
 * @returns {{label:string, value:number, text:string, unit:string}[]}
 */
export function droRows(point, opts = {}) {
  const { mode = 'mill', diameterMode = true, rotary = null, aIndices = null } = opts;
  const labels = droAxisLabels({ mode, rotary: usesRotary(aIndices) });
  return labels.map((label) => {
    const value = absoluteValue(label, point, { mode, diameterMode, rotary });
    return {
      label,
      value,
      text: formatCoord(value),
      unit: label === 'A' || label === 'B' ? 'deg' : 'mm',
    };
  });
}

/**
 * Should the readout be on screen at all?
 *
 * It belongs to running a program, so it appears once one is loaded and stays
 * put whether the playhead is moving or parked — a control does not blank its
 * position page when the machine stops. The sketch page has no machine, and a
 * program with no segments has no position to post.
 */
export function showDro({ sketching = false, count = 0 } = {}) {
  return !sketching && count > 0;
}

/**
 * The `X = ⌀` note the readout carries on a diameter lathe, so the number is
 * never ambiguous; null when it would say nothing (milling, or radius mode).
 */
export function droXNote({ mode = 'mill', diameterMode = true } = {}) {
  return mode === 'turn' && diameterMode ? '⌀' : null;
}
