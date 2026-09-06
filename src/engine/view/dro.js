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

import { cutterById } from '../cam/cutters.js';

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
 * DISTANCE TO GO for one axis: what is left of the move in progress, signed the
 * way the axis is travelling — the control's own convention, so a negative number
 * means the axis is still heading negative.
 *
 * Both ends go through `absoluteValue`, so the lathe's radius→diameter doubling
 * applies to the remaining distance too. That is right, not a leftover: on a
 * diameter-programmed lathe an X move from ⌀60 to ⌀40 has 20 to go on the
 * ABSOLUTE page, and posting the 10 mm the slide actually travels beside a
 * diameter position would be a second factor-of-two to catch.
 *
 * `target` is `blockTargetAt` — where the block in progress ends. Null (parked,
 * or no program) reads 0, the same as a control with nothing commanded.
 */
export function distToGo(label, point, target, opts = {}) {
  if (!target) return 0;
  return absoluteValue(label, target, opts) - absoluteValue(label, point, opts);
}

/**
 * The whole readout as rows the view maps straight onto JSX.
 *
 * @param {number[]|null} point tool tip in program coordinates, or null
 * @param {{mode?:'mill'|'turn', diameterMode?:boolean,
 *   rotary?:{a:number,b:number}|null, aIndices?:number[],
 *   target?:number[]|null}} opts
 * @returns {{label:string, value:number, text:string, unit:string,
 *   dtg:number, dtgText:string}[]}
 */
export function droRows(point, opts = {}) {
  const {
    mode = 'mill', diameterMode = true, rotary = null, aIndices = null,
    target = null,
  } = opts;
  const labels = droAxisLabels({ mode, rotary: usesRotary(aIndices) });
  return labels.map((label) => {
    const at = { mode, diameterMode, rotary };
    const value = absoluteValue(label, point, at);
    // A/B fall out as 0: the rotary index is carried in `opts`, not in the two
    // XYZ points, so both ends of the subtraction read the same index. An indexer
    // is where it was told to be — there is no distance to go on it.
    const dtg = distToGo(label, point, target, at);
    return {
      label,
      value,
      text: formatCoord(value),
      unit: label === 'A' || label === 'B' ? 'deg' : 'mm',
      dtg,
      dtgText: formatCoord(dtg),
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

/** A dimension with its trailing zeros dropped: 7, 6.35, 12.7 — never 7.000. */
function trim(value, decimals = 3) {
  return String(Number(Number(value).toFixed(decimals)));
}

/** Longest tool name the panel can hold before it starts pushing N— off the row. */
const NAME_MAX = 24;

/**
 * The tool in the spindle, as the readout names it: the T number, and beside it
 * what that tool actually **is**.
 *
 * A bare `T3` is what the position page used to say, and it is the one thing on
 * the panel an operator cannot check against the machine — every other number
 * is a position they can eyeball. Two programs in, `T3` is a Ø7 endmill in one
 * and a Ø9 drill in the other, and the difference is a scrapped part.
 *
 * The name is the tool that is **cutting**, resolved the same way the marker and
 * the carvers resolve it (`cam/effectiveTool.js`), so what the readout says, the
 * screen draws and the simulation removes. Failing that it falls back to the
 * program's own comment, which is at least what the programmer wrote, and
 * failing that to nothing — a made-up tool name would be worse than none.
 *
 * @param {{number?:number, cutter?:string|null, radius?:number,
 *   desc?:string, holder?:{label?:string}|null}} args
 *   `holder` is the lathe toolholder (`sim/turning.js`), which is what a turned
 *   tool is: an insert in a holder, with no diameter to post.
 * @returns {{number:string, name:string|null}}
 */
export function droTool({
  number = 0, cutter = null, radius = 0, desc = '', holder = null,
} = {}) {
  const label = number > 0 ? `T${number}` : 'T—';
  // A holder's catalogue label is `MVJNR · 93° OD (insert adj.)` — the part
  // before the dot is the designation, and the rest is picker prose.
  if (holder?.label) return { number: label, name: holder.label.split('·')[0].trim() };

  const size = radius > 0 ? `Ø${trim(radius * 2)}` : '';
  if (cutter) {
    const name = `${cutterById(cutter).label}${size ? ` ${size}` : ''}`;
    return { number: label, name };
  }
  if (size) return { number: label, name: size };
  // The program's own comment: `ENDMILL D7 L48-54 - ROUGH B2` names the tool in
  // its head and the operation in its tail, and only the head is a tool name.
  const head = String(desc || '').split(/\s+-\s+|--/)[0].trim();
  if (head) return { number: label, name: head.slice(0, NAME_MAX) };
  return { number: label, name: null };
}

/**
 * The FEED field: the rate the move in progress is running at.
 *
 * **Always mm/min**, milling and turning alike, because that is the number an
 * operator can compare with anything else on the screen — the cycle time, the
 * other operations, the feed the machine beside it is running. A lathe under
 * G95/G99 is *programmed* in mm per rev (`F0.15`), and this used to post that
 * unit on turning; the trouble is that 0.15 and 850 sitting in the same field on
 * different jobs are not comparable quantities, and the field gives no warning
 * which one it is holding.
 *
 * The programmed figure is not thrown away, because it is the only one that can
 * be checked against the program text: it comes back as `note`, which the
 * readout prints under the rate. So both questions are answerable — *what is it
 * doing* from the field, *what was it told* from the note.
 *
 * @param {{feed?:number, rpm?:number, feedMode?:number}} running from `runningAt`
 * @returns {{text:string, unit:string, note:string|null}} `—` before the
 *   program's first F word, the same as a control that has not been told a feed
 *   yet. `note` is the programmed per-rev feed, or null when there isn't one.
 */
export function droFeed({ feed = 0, rpm = 0, feedMode = 0 } = {}) {
  if (!(feed > 0)) return { text: '—', unit: '', note: null };
  // Only under G95/G99 with the spindle turning is there a per-rev feed to
  // report: `feed` is already mm/min, having been multiplied by that same rpm.
  const perRev = feedMode === 95 && rpm > 0 ? `${trim(feed / rpm, 4)} mm/rev` : null;
  return {
    text: trim(feed, feed < 10 ? 2 : 0),
    unit: 'mm/min',
    note: perRev,
  };
}

/**
 * The SPEED field: how fast the spindle is actually turning.
 *
 * "Actually" is not pedantry on a lathe. Under constant surface speed the S
 * word is a surface speed in m/min and the rpm chases the diameter, so the only
 * honest thing to post beside a position is the rpm the machine is at *there* —
 * which is what `interpret` works out and hands along, clamp included.
 */
export function droSpindle({ rpm = 0 } = {}) {
  return rpm > 0 ? { text: trim(rpm, 0), unit: 'rpm' } : { text: '—', unit: '' };
}

/**
 * The whole footer strip: what is cutting, how fast, and where in the program.
 *
 * @param {{toolNumber?:number, tool?:object|null, running?:object|null,
 *   line?:number}} args `tool` is the `droTool` description, `running` is
 *   `runningAt` from `gcode/path.js`.
 */
export function droFooter({
  toolNumber = 0, tool = null, running = null, line = 0,
} = {}) {
  return {
    tool: droTool({ ...(tool || {}), number: toolNumber }),
    feed: droFeed(running || {}),
    spindle: droSpindle(running || {}),
    line: line > 0 ? `N${line}` : 'N—',
  };
}
