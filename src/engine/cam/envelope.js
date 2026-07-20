/**
 * Envelope check — does this program fit this machine?
 *
 * Two questions, and they are not the same one:
 *
 * 1. **Which axes does the program command?** A toolpath that only ever writes
 *    X and Z is a 2-axis program and will run on anything; one that writes Y
 *    will not run on a 2-axis lathe however big the lathe is. This is read off
 *    the moves themselves rather than assumed from the process, because the
 *    process is what we *intended* and the moves are what we actually emitted.
 * 2. **Does the motion fit inside the strokes?** Every axis has a finite
 *    travel, and a program that runs the slide into its limit stops mid-cut.
 *
 * Both are answered from the built operations, so the answer describes the
 * program that will actually be posted — not the part, and not the plan. A part
 * can fit the table and still produce a toolpath that does not, because the
 * toolpath includes the stock, the approach moves and the safe-Z retract.
 *
 * What this deliberately does **not** do is decide anything. It measures and
 * reports; the planner turns the report into warnings and the UI shows it. A
 * check that silently "fixes" an over-travel by shrinking the toolpath would be
 * the worst possible behaviour here.
 *
 * Pure functions. No React, no store, no DOM.
 */

/** Axes a lathe move implies. Turning moves carry X and Z only. */
const TURN_AXES = ['X', 'Z'];
const MILL_AXES = ['X', 'Y', 'Z'];

/**
 * The extent of every axis the program commands.
 *
 * Turning X is reported as **diameter**, not radius. The moves carry radius
 * because that is what the geometry is, but every number a turner reads — bar
 * size, chuck capacity, the X on the control — is a diameter, and quietly
 * halving it here is how a 300 mm bar gets reported as fitting a 200 mm lathe.
 *
 * @param {object[]} operations built operations, each with `moves`
 * @param {'mill'|'turn'} mode
 * @returns {{letters:string[], extent:Record<string,{min:number,max:number,range:number}>,
 *   moveCount:number}}
 */
export function programAxes(operations, mode) {
  const candidates = mode === 'turn' ? TURN_AXES : MILL_AXES;
  const rotaries = mode === 'turn' ? [] : ['A'];
  const extent = {};
  let moveCount = 0;

  const see = (axis, value) => {
    if (value == null || !Number.isFinite(value)) return;
    const v = mode === 'turn' && axis === 'X' ? value * 2 : value;
    const e = extent[axis] ?? (extent[axis] = { min: Infinity, max: -Infinity, range: 0 });
    if (v < e.min) e.min = v;
    if (v > e.max) e.max = v;
  };

  for (const op of operations || []) {
    // A rotary index lives on the operation, not on its moves: the table turns
    // once and the whole operation runs at that angle. It still makes the
    // program need the axis, and it is the *only* thing that does — so a job
    // that never leaves A0 stays a 3-axis program and will run anywhere.
    if (op.indexA != null) see('A', op.indexA);
    for (const m of op.moves || []) {
      moveCount++;
      for (const axis of candidates) see(axis, m[axis.toLowerCase()]);
      // A canned cycle commands the hole bottom through Z even though the block
      // is not a motion block, and its R plane is a real Z position too.
      if (m.cycle) {
        see('Z', m.z);
        see('Z', m.r);
      }
    }
  }

  for (const e of Object.values(extent)) e.range = e.max - e.min;
  // An axis that never moved was still commanded — it is holding a position —
  // but it does not make the program need that axis. Only a moving axis does.
  //
  // A rotary is the exception: a program that sits at A90 for its whole length
  // never *moves* A, and still cannot run on a machine without one. So any
  // commanded angle other than zero counts.
  const letters = [
    ...candidates.filter((a) => extent[a] && extent[a].range > 1e-9),
    ...rotaries.filter((a) => extent[a] && (extent[a].range > 1e-9 || extent[a].max !== 0)),
  ];
  return { letters, extent, moveCount };
}

/**
 * Check a program against a machine.
 *
 * @param {object} machine  from `machines.js`
 * @param {{operations?:object[], mode?:string, bounds?:object, stock?:object}} program
 * @returns {{axes:{required:string[], available:string[], missing:string[], unused:string[],
 *   count:number, machineCount:number}, travel:object[], warnings:string[], ok:boolean}}
 */
export function checkEnvelope(machine, program = {}) {
  const { operations = [], mode = machine.kind ?? 'mill', bounds = null } = program;
  const warnings = [];

  const used = programAxes(operations, mode);
  const available = axesOf(machine, mode);
  const missing = used.letters.filter((a) => !available.includes(a));
  const unused = available.filter((a) => !used.letters.includes(a));

  const machineCount = machine.axisCount ?? available.length;
  if (missing.length) {
    warnings.push(`The program commands ${missing.join(', ')}, which ${label(machine)} does not have — it is a ${machineCount}-axis machine (${available.join('')}).`);
  }

  // The opposite mismatch, and the one that quietly disappoints: the machine
  // has a rotary and the program does not use it. Someone who chose a 4-axis
  // machine expects 4-axis output, and getting a 3-axis program with no comment
  // reads as the rotary being broken rather than unimplemented. Say it plainly.
  const rotary = machine.rotary ?? [];
  const idleRotary = rotary.filter((a) => !used.letters.includes(a));
  if (rotary.length && idleRotary.length === rotary.length && used.moveCount > 0) {
    warnings.push(`${label(machine)} has a rotary on ${rotary.join('/')}, but this program is 3-axis — nothing is written to ${rotary.join(' or ')}. Index it by hand between setups.`);
  }

  // --- Stroke -------------------------------------------------------------
  // Compared as *range*, not absolute position: where the program sits inside
  // the machine's coordinates depends on the work offset, which is set at the
  // machine and is not ours to know. The distance the axis has to move is.
  const travel = [];
  for (const axis of machine.linear ?? []) {
    const stroke = machine.travel?.[axis];
    const e = used.extent[axis];
    if (stroke == null || !e) continue;
    const need = axis === 'X' && mode === 'turn'
      // On a lathe the cross-slide moves in radius while the program is written
      // on diameter, so the stroke consumed is half the X range.
      ? e.range / 2
      : e.range;
    const over = need > stroke;
    travel.push({
      axis,
      need: Number(need.toFixed(2)),
      stroke,
      used: Number(((need / stroke) * 100).toFixed(1)),
      over,
    });
    if (over) {
      warnings.push(`${axis} travel: the toolpath spans ${need.toFixed(0)} mm but ${label(machine)} has ${stroke} mm.`);
    }
  }

  // --- Capacity the stroke does not describe -------------------------------
  if (machine.kind === 'turn' && machine.maxTurnDia) {
    const dia = used.extent.X ? used.extent.X.max : diameterOf(bounds);
    if (dia != null && dia > machine.maxTurnDia) {
      warnings.push(`Ø${dia.toFixed(0)} exceeds the ${machine.maxTurnDia} mm turning capacity of ${label(machine)}.`);
    }
  }

  return {
    axes: {
      required: used.letters,
      available,
      missing,
      unused,
      count: used.letters.length,
      machineCount,
    },
    travel,
    warnings,
    ok: warnings.length === 0,
  };
}

/**
 * A cheap fit check against the raw part, before any toolpath exists.
 *
 * This runs at plan time, when the operations do not exist yet, and it is
 * deliberately more forgiving than `checkEnvelope`: it compares the part's
 * footprint against the table in its **best** orientation, because the setter
 * is free to rotate the part about Z and a part that fits sideways fits.
 */
export function fitWarnings(machine, bounds) {
  const out = [];
  if (!bounds || !machine.travel) return out;
  const [sx, sy, sz] = bounds.size;

  if (machine.kind === 'mill') {
    const footprint = [sx, sy].sort((a, b) => a - b);
    const limits = [machine.travel.X, machine.travel.Y].sort((a, b) => a - b);
    if (footprint[0] > limits[0] || footprint[1] > limits[1]) {
      out.push(`The part is ${sx.toFixed(0)} × ${sy.toFixed(0)} mm; ${label(machine)} has ${machine.travel.X} × ${machine.travel.Y} mm of travel.`);
    }
    if (sz > machine.travel.Z) {
      out.push(`The part is ${sz.toFixed(0)} mm tall against ${machine.travel.Z} mm of Z travel on ${label(machine)}.`);
    }
    return out;
  }

  const dia = diameterOf(bounds);
  if (machine.maxTurnDia && dia > machine.maxTurnDia) {
    out.push(`Ø${dia.toFixed(0)} exceeds the ${machine.maxTurnDia} mm turning capacity of ${label(machine)}.`);
  }
  // The spindle axis is the long one on a turned part, and it is Z on the lathe
  // whatever axis it was modelled about.
  const length = Math.max(...bounds.size);
  if (machine.travel?.Z && length > machine.travel.Z) {
    out.push(`The part is ${length.toFixed(0)} mm long against ${machine.travel.Z} mm of Z travel on ${label(machine)}.`);
  }
  return out;
}

/**
 * The axes a machine can be commanded on.
 *
 * Falls back to the plain 3-axis / 2-axis set for a bare envelope object — the
 * planner's default machine is a set of limits, not a catalogue entry, and it
 * should not have to pretend to be one just to be checked.
 */
function axesOf(machine, mode) {
  if (machine.linear) return [...machine.linear, ...(machine.rotary ?? [])];
  return mode === 'turn' ? [...TURN_AXES] : [...MILL_AXES];
}

/** A machine without a catalogue entry has no label to blame. */
function label(machine) {
  return machine.label ?? 'this machine';
}

/** The turned diameter of a part: the larger of the two cross-axis sizes. */
function diameterOf(bounds) {
  if (!bounds) return null;
  const [sx, sy, sz] = bounds.size;
  const sorted = [sx, sy, sz].sort((a, b) => a - b);
  // The two smaller dimensions are across the spindle; the largest is length.
  return sorted[1];
}

/**
 * One line for the UI: what the program needs against what the machine has.
 *
 * Reads as "3-axis program (XYZ) · machine has 5 (B, C unused)" — which is the
 * question actually being asked when someone looks at a machine list.
 */
export function axisSummary(check) {
  const { required, count, machineCount, unused, missing } = check.axes;
  const head = `${count}-axis program (${required.join('') || 'none'})`;
  if (missing.length) return `${head} · machine cannot do ${missing.join(', ')}`;
  if (count === machineCount) return `${head} · matches the machine`;
  return `${head} · machine has ${machineCount}${unused.length ? ` (${unused.join(', ')} unused)` : ''}`;
}
