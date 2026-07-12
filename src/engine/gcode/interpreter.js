/**
 * G-code interpreter: modal state machine + motion planner.
 *
 * interpret(text, opts) walks every block, tracks modal state (motion mode,
 * plane, units, distance mode, feed mode, canned-cycle params) and emits a flat
 * list of straight line segments classified as 'rapid' or 'feed'. Arcs are
 * tessellated; drilling canned cycles (G81-G89, G73) and the turning stock
 * removal cycle (G71 + G70) are expanded into their constituent moves.
 *
 * Everything is normalised to millimetres. Inch programs (G20) are scaled on
 * the way in, so downstream rendering and stats are unit-agnostic.
 *
 * Each segment also carries a duration `t` (seconds), derived from the modal
 * feed rate at the time it was emitted. Summed with G4 dwells this gives the
 * program's estimated cycle time.
 *
 * Two machine modes:
 *   'mill' — XY plane (G17) default, X/Y/Z are cartesian, G94 mm/min feed.
 *   'turn' — ZX plane (G18) default, the X word is a *diameter* (halved into a
 *            radius) unless diameterMode is off, and the feed defaults to per
 *            revolution (F × spindle rpm) as on a lathe, until G98/G94.
 *
 * Output segments are intentionally simple ({type, a, b, line, t}) so the
 * worker can pack them into transferable Float32Arrays without reshaping.
 */
import { tokenizeLine, stripComments } from './tokenizer.js';
import { tessellateArc } from './arc.js';
import { expandProgram } from './macro.js';
import { parseToolTable } from './tools.js';

const PLANES = {
  G17: [0, 1, 2], // XY
  G18: [2, 0, 1], // ZX
  G19: [1, 2, 0], // YZ
};

// Motion group-1 words this interpreter understands.
const MOTION_CODES = new Set([0, 1, 2, 3, 73, 80, 81, 82, 83, 84, 85, 86, 89]);
const DRILL_CYCLES = new Set([73, 81, 82, 83, 84, 85, 86, 89]);
// Lathe multiple-repetitive cycles. G71 (roughing) and G70 (finishing) are
// expanded; the rest are recognised and reported.
const TURNING_CYCLES = new Set([70, 71, 72, 74, 75, 76]);

// Used when a feed move runs before any usable F word — keeps the cycle-time
// estimate finite instead of yielding Infinity.
const FALLBACK_FEED = 100; // mm/min
// A feed rate only makes sense in one of the two units. Nobody cuts at
// 0.4 mm/min, and nobody takes a 40 mm bite per revolution — an F word on the
// wrong side of these bounds means the feed mode is wrong, and the cycle time
// would be off by orders of magnitude rather than a few percent.
const PER_REV_MIN = 1;   // mm/min — an F below this is really mm/rev
const PER_REV_MAX = 40;  // mm/rev — an F above this is really mm/min
const EPS = 1e-6;
const MAX_ROUGH_PASSES = 2000; // guard against a bad depth-of-cut

function dist(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/**
 * Where a roughing pass at radius `level` runs out of room.
 *
 * The tool travels along the profile's direction (decreasing Z for OD turning)
 * until the contour swells past `level` — that crossing is the end of the cut.
 * A level clear of the whole contour cuts the full length of the profile.
 *
 * @param {number[][]} profile [x(radius), z] points, in program order
 */
function zAtRadius(profile, level) {
  for (let i = 0; i < profile.length - 1; i++) {
    const [x1, z1] = profile[i];
    const [x2, z2] = profile[i + 1];
    if (x1 > level + EPS) return z1; // already buried in the contour
    if (x2 > level + EPS) {
      const t = Math.abs(x2 - x1) > EPS ? (level - x1) / (x2 - x1) : 0;
      return z1 + t * (z2 - z1);
    }
  }
  return profile[profile.length - 1][1];
}

/**
 * Rotate a machine-frame point into the part frame for a rotary index: A about
 * X, B about Y. The table carries the part; the programmed coordinates stay in
 * the stationary machine frame, so undoing the table rotation is what puts every
 * face of a 4-/5-axis program back where it belongs on the workpiece.
 *
 * The undo is applied A-then-B (net Ry(-B)·Rx(-A)); the tool marker in the
 * viewport composes its orientation the same way so it stands normal to the
 * face being cut.
 */
function toPartFrame(p, aDeg, bDeg) {
  let [x, y, z] = p;
  if (aDeg) {
    const t = -aDeg * (Math.PI / 180);
    const c = Math.cos(t);
    const s = Math.sin(t);
    const ny = y * c - z * s;
    const nz = y * s + z * c;
    y = ny; z = nz;
  }
  if (bDeg) {
    const t = -bDeg * (Math.PI / 180);
    const c = Math.cos(t);
    const s = Math.sin(t);
    const nx = x * c + z * s;
    const nz = -x * s + z * c;
    x = nx; z = nz;
  }
  return [x, y, z];
}

/**
 * @param {string} text raw G-code program
 * @param {{mode?:'mill'|'turn', rapidRate?:number, diameterMode?:boolean,
 *          rotaryFrame?:'part'|'machine'}} opts
 *   rapidRate — machine traverse speed in mm/min, used to time G0 moves.
 *   diameterMode — turn mode only: treat the X word as a diameter.
 *   rotaryFrame — 'part' orients each A index onto the workpiece (what you want
 *     to look at); 'machine' leaves coordinates as programmed, with the tool
 *     always along +Z (what the height-field simulator needs).
 */
export function interpret(text, opts = {}) {
  const { mode = 'mill', rapidRate = 5000, diameterMode = true, rotaryFrame = 'part' } = opts;
  const turning = mode === 'turn';
  const partFrame = rotaryFrame !== 'machine';

  const state = {
    motion: 0, // modal group 1 (G0 default)
    plane: turning ? 'G18' : 'G17',
    scale: 1, // G21 mm -> 1, G20 inch -> 25.4
    absolute: true, // G90 / G91
    absoluteArcCentre: false, // G90.1 / G91.1 (I/J/K as absolute centre)
    retractToInitial: true, // G98 / G99 (milling)
    feed: 0,
    // 94 = per minute, 95 = per revolution, 93 = inverse time. A lathe powers
    // up in feed-per-rev (G99) and a mill in feed-per-minute (G94); a program
    // that means otherwise says so with G98/G94 or G99/G95.
    feedMode: turning ? 95 : 94,
    spindle: 0, // last S word (rpm) — needed for feed-per-rev timing
    pos: [0, 0, 0],
    aAxis: 0, // 4th-axis rotary index, degrees about X
    bAxis: 0, // 5th-axis rotary index, degrees about Y
    tool: 0, // active tool number (T word), so each segment knows its cutter
    // canned-cycle modal params
    cycleR: 0,
    cycleZ: 0,
    cycleQ: 0,
    cycleInitialZ: 0,
    inCycle: false,
    // G71 depth / retract, set by its first (P-less) block
    roughDepth: 0,
    roughRetract: 0.5,
  };

  const segments = []; // each: { type, a:[x,y,z], b:[x,y,z], line, t }
  const warnings = [];
  const warnOnce = (msg) => { if (!warnings.includes(msg)) warnings.push(msg); };

  let rapidLength = 0;
  let feedLength = 0;
  let rapidTime = 0;
  let feedTime = 0;
  let dwellTime = 0;
  const aIndices = new Set([0]); // every A angle the program machines at
  const toolCut = new Map(); // tool number -> { feeds, cutLength } actually cut
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  // Bounds of the cutting moves alone. Rapid retracts (especially a 4-axis
  // program's Z-clearance rotated out to ±Y) balloon the full bounds, so the
  // viewport frames these tighter feed bounds — the part, not the fly-overs.
  const fMin = [Infinity, Infinity, Infinity];
  const fMax = [-Infinity, -Infinity, -Infinity];

  const grow = (p, feed) => {
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
      if (feed) {
        if (p[k] < fMin[k]) fMin[k] = p[k];
        if (p[k] > fMax[k]) fMax[k] = p[k];
      }
    }
  };

  /** Effective cutting feed in mm/min for the current modal state. */
  const effectiveFeed = () => {
    if (state.feedMode === 95) {
      if (state.feed > PER_REV_MAX) {
        warnOnce(`F${state.feed} is implausible as a feed per revolution — if the program means mm/min, select it with G98 (lathe) or G94 (mill)`);
      }
      const rpm = Math.abs(state.spindle);
      if (state.feed > 0 && rpm > 0) return state.feed * rpm;
      warnOnce('Feed per revolution (G95/G99) with no S word — cycle time estimated at 100 mm/min');
      return FALLBACK_FEED;
    }
    if (state.feed > 0) {
      if (state.feed < PER_REV_MIN) {
        warnOnce(`F${state.feed} looks like a feed per revolution, but feed per minute is active — select mm/rev with G99 (lathe) or G95 (mill)`);
      }
      return state.feed;
    }
    warnOnce('Cutting move before any F word — cycle time estimated at 100 mm/min');
    return FALLBACK_FEED;
  };

  /**
   * The real sink: records a segment and folds it into the bounds + stats.
   * Profile probing (G71/G70) swaps in a collector instead, so those passes
   * don't pollute the geometry.
   */
  const emit = (type, a, b, line) => {
    // Time and distance are the same in either frame — rotation is rigid — so
    // measure before the transform and reuse it.
    const d = dist(a, b);
    const a2 = partFrame ? toPartFrame(a, state.aAxis, state.bAxis) : a.slice();
    const b2 = partFrame ? toPartFrame(b, state.aAxis, state.bAxis) : b.slice();
    const isFeed = type !== 'rapid';
    grow(a2, isFeed);
    grow(b2, isFeed);
    let t;
    if (type === 'rapid') {
      t = rapidRate > 0 ? (d / rapidRate) * 60 : 0;
      rapidLength += d;
      rapidTime += t;
    } else {
      t = (d / effectiveFeed()) * 60;
      feedLength += d;
      feedTime += t;
      const tc = toolCut.get(state.tool) || { feeds: 0, cutLength: 0 };
      tc.feeds += 1;
      tc.cutLength += d;
      toolCut.set(state.tool, tc);
    }
    if (state.aAxis) aIndices.add(state.aAxis);
    segments.push({ type, a: a2, b: b2, line, t, a4: state.aAxis, b4: state.bAxis, tool: state.tool });
  };

  /**
   * A dwell (G4, or the P word of G82/G89) pauses at the end of the move that
   * preceded it, so bill it to that segment. Before any motion it is program
   * overhead and only lands in the total.
   */
  const addDwell = (seconds) => {
    if (!(seconds > 0)) return;
    dwellTime += seconds;
    const last = segments[segments.length - 1];
    if (last) last.t += seconds;
  };

  // Resolve one axis word against the current position + distance mode.
  const axisTarget = (current, word, scale, absolute) => {
    if (word === undefined) return current;
    const v = word * scale;
    return absolute ? v : current + v;
  };

  // On a lathe the X word is conventionally a diameter, while I/K/R stay radial.
  const xScale = () => state.scale * (turning && diameterMode ? 0.5 : 1);
  /** Convert an X-axis allowance (U word) into a radius. */
  const toRadius = (v) => (turning && diameterMode ? v / 2 : v);

  const snapshot = () => ({ ...state, pos: state.pos.slice() });
  const restore = (s) => Object.assign(state, s, { pos: s.pos.slice() });

  // Detect the tool table from the program's comments up front, so each tool's
  // real diameter/type is available to the simulator and the UI.
  const toolTable = parseToolTable(text);

  // Resolve the macro layer first: variables, expressions and WHILE loops
  // collapse into literal blocks, each still pointing at its source line.
  const blocks = expandProgram(text, warnOnce);

  // Sequence-number index for the P/Q block ranges of the lathe cycles. The
  // tokenizer drops N words, so scan the (comment-stripped) block text.
  const nIndex = new Map();
  for (let i = 0; i < blocks.length; i++) {
    const m = /(?:^|\s)N\s*(\d+)/i.exec(stripComments(blocks[i].text));
    if (m && !nIndex.has(Number(m[1]))) nIndex.set(Number(m[1]), i);
  }

  /**
   * Walk the profile blocks between two sequence numbers and return the contour
   * as [x(radius), z] points. Modal state is restored afterwards, so probing the
   * profile has no side effects on the main program stream.
   */
  const collectProfile = (from, to) => {
    const pts = [];
    const snap = snapshot();
    runBlocks(from, to + 1, (type, a, b) => { pts.push([b[0], b[2]]); });
    restore(snap);
    return pts;
  };

  /**
   * Resolve the P/Q block range of a lathe cycle. Returns null (after warning)
   * if the sequence numbers are missing or would recurse into the cycle itself.
   */
  const profileRange = (words, lineNo, code, blockIdx) => {
    const from = nIndex.get(words.P);
    const to = nIndex.get(words.Q);
    if (from === undefined || to === undefined) {
      warnings.push(`Line ${lineNo}: G${code} references N${words.P}/N${words.Q}, which the program doesn't define`);
      return null;
    }
    if (to < from || (blockIdx >= from && blockIdx <= to)) {
      warnings.push(`Line ${lineNo}: G${code} block range N${words.P}..N${words.Q} is not a valid profile`);
      return null;
    }
    return [from, to];
  };

  /**
   * G71 — stock removal in turning (Fanuc type I).
   *
   * Roughs the P..Q profile away in constant-radius passes of depth `d`, each
   * cutting along Z until it meets the contour, then retracting at 45° by `e`.
   * A final pass follows the contour offset outward by the finishing allowance
   * (U on diameter, W on Z). The tool returns to the cycle start point, which is
   * where the control resumes.
   */
  const expandG71 = (words, lineNo, sink, blockIdx) => {
    const range = profileRange(words, lineNo, 71, blockIdx);
    if (!range) return null;
    const [from, to] = range;
    // The profile normally follows the cycle block; the control resumes after
    // it. A profile placed elsewhere in the program stays in the stream.
    const skip = from > blockIdx ? to : null;

    const depth = words.D !== undefined
      ? Math.abs(words.D * state.scale)   // single-block form: G71 P Q U W D
      : state.roughDepth;                 // two-block form: G71 U(d) R(e)
    if (!(depth > 0)) {
      warnings.push(`Line ${lineNo}: G71 has no depth of cut (U on the first block, or D) — cycle skipped`);
      return skip;
    }
    const retract = state.roughRetract;
    const allowX = toRadius((words.U ?? 0) * state.scale); // diameter -> radius
    const allowZ = (words.W ?? 0) * state.scale;

    const raw = collectProfile(from, to);
    if (raw.length < 2) {
      warnings.push(`Line ${lineNo}: G71 profile N${words.P}..N${words.Q} contains no motion`);
      return skip;
    }
    // Finishing allowance: leave stock on the OD and on the +Z faces.
    const profile = raw.map(([x, z]) => [x + allowX, z + allowZ]);

    const [xs, , zs] = state.pos;
    let xMin = Infinity;
    for (const [x] of profile) xMin = Math.min(xMin, x);
    if (xs <= xMin + EPS) {
      warnings.push(`Line ${lineNo}: G71 starts at or below the profile — nothing to rough`);
      return skip;
    }

    let cur = [xs, 0, zs];
    const move = (type, next) => { sink(type, cur, next, lineNo); cur = next; };

    for (let k = 1; k <= MAX_ROUGH_PASSES; k++) {
      let x = xs - k * depth;
      const lastPass = x <= xMin;
      if (lastPass) x = xMin;
      const z = zAtRadius(profile, x);

      move('rapid', [x, 0, zs]);
      move('feed', [x, 0, z]);
      move('feed', [x + retract, 0, z + retract]); // 45° pull-off
      move('rapid', [x + retract, 0, zs]);
      if (lastPass) break;
    }

    // Semi-finish pass along the offset contour.
    move('rapid', [profile[0][0], 0, profile[0][1]]);
    for (let i = 1; i < profile.length; i++) move('feed', [profile[i][0], 0, profile[i][1]]);
    move('rapid', [xs, 0, zs]);

    state.pos = [xs, 0, zs];
    // The profile normally follows the cycle block; the control resumes after
    // it. A profile placed elsewhere in the program stays in the stream.
    return skip;
  };

  /**
   * G70 — finishing pass: run the P..Q profile exactly as programmed, then
   * resume at the block after G70 itself. Unlike G71 it never consumes lines
   * from the main stream: G71 has already jumped past them.
   */
  const expandG70 = (words, lineNo, sink, blockIdx) => {
    const range = profileRange(words, lineNo, 70, blockIdx);
    if (!range) return null;
    const [from, to] = range;
    const start = state.pos.slice();
    runBlocks(from, to + 1, sink);
    sink('rapid', state.pos, start, lineNo); // control returns to the start point
    state.pos = start;
    return null;
  };

  /**
   * Dispatch a lathe multiple-repetitive cycle. Returns the last line of the
   * consumed profile (the control resumes *after* it), or null when the cycle
   * body stays in the stream.
   */
  const turningCycle = (code, words, lineNo, sink, blockIdx) => {
    if (!turning) {
      warnOnce(`G${code} is a lathe cycle — switch the machine mode to Turning to expand it`);
      return null;
    }
    if (code === 71 || code === 72) {
      // Two-block form: the P-less block only carries depth (U) and retract (R).
      if (words.P === undefined) {
        if (words.U !== undefined) state.roughDepth = Math.abs(words.U * state.scale);
        if (words.R !== undefined) state.roughRetract = Math.abs(words.R * state.scale);
        return null;
      }
      if (code === 72) {
        warnings.push(`Line ${lineNo}: G72 facing cycle recognised but not expanded`);
        return null;
      }
      return expandG71(words, lineNo, sink, blockIdx);
    }
    if (code === 70) return expandG70(words, lineNo, sink, blockIdx);
    warnings.push(`Line ${lineNo}: G${code} turning cycle recognised but not expanded`);
    return null;
  };

  /**
   * Execute the blocks in [from, to), feeding motion to `sink`. Lathe cycles can
   * re-enter this with a collector sink to trace their profile, and can skip the
   * profile blocks they consumed.
   */
  function runBlocks(from, to, sink) {
    for (let li = from; li < to; li++) {
      const tokens = tokenizeLine(blocks[li].text);
      if (tokens.length === 0) continue;
      const lineNo = blocks[li].line;

      // Collect words. Multiple G words can share a block (e.g. G90 G1 X..).
      const words = {};
      const gCodes = [];
      for (const t of tokens) {
        if (t.letter === 'G') gCodes.push(t.value);
        else words[t.letter] = t.value; // last one wins for repeated addresses
      }

      // --- Apply non-motion modal G-codes first ---
      let motionThisBlock;
      let dwellThisBlock = false;
      let refReturn = 0;
      for (const g of gCodes) {
        switch (g) {
          case 4: dwellThisBlock = true; break;
          case 28: case 30: refReturn = g; break;
          case 20: state.scale = 25.4; break;
          case 21: state.scale = 1; break;
          case 17: state.plane = 'G17'; break;
          case 18: state.plane = 'G18'; break;
          case 19: state.plane = 'G19'; break;
          case 90: state.absolute = true; break;
          case 91: state.absolute = false; break;
          case 90.1: state.absoluteArcCentre = true; break;
          case 91.1: state.absoluteArcCentre = false; break;
          // On a Fanuc-style lathe G98/G99 select the feed mode; on a mill they
          // select the canned-cycle retract plane.
          case 98:
            if (turning) state.feedMode = 94; else state.retractToInitial = true;
            break;
          case 99:
            if (turning) state.feedMode = 95; else state.retractToInitial = false;
            break;
          case 94: state.feedMode = 94; break;
          case 95: state.feedMode = 95; break;
          case 93:
            warnOnce('G93 inverse-time feed is not modelled — cycle time uses the F word as mm/min');
            state.feedMode = 94;
            break;
          default:
            // G73 is a peck-drill cycle on a mill but a pattern-repeat cycle on
            // a lathe; the machine mode decides which table to look it up in.
            if (turning && g === 73) motionThisBlock = 73;
            else if (MOTION_CODES.has(g) || TURNING_CYCLES.has(g)) motionThisBlock = g;
            // silently ignore other G-codes (G40/41/42 comp, G43 tool len, etc.)
        }
      }

      if (words.F !== undefined) state.feed = words.F * state.scale;
      if (words.S !== undefined) state.spindle = words.S;
      // The rotary axes index the part, not the tool. Degrees, never scaled.
      if (words.A !== undefined) {
        state.aAxis = state.absolute ? words.A : state.aAxis + words.A;
      }
      // B is a rotary index on a mill / 5-axis machine; on a lathe the same
      // address is a cycle parameter (e.g. the G76 thread angle), so only a
      // milling program rotates the part with it.
      if (!turning && words.B !== undefined) {
        state.bAxis = state.absolute ? words.B : state.bAxis + words.B;
      }
      // A tool change (T word) selects the cutter every following move is made
      // with. The tool-change block itself carries no motion, so tagging from
      // here forward is enough. A lathe T word packs an offset (T0606); keep the
      // raw number — the comment table (milling) keys on the small tool index.
      if (words.T !== undefined) state.tool = words.T;

      // G4 dwell: P (or X/U) seconds. Consumes the block — no motion.
      if (dwellThisBlock) {
        const secs = words.P ?? words.X ?? words.U;
        if (secs === undefined) warnOnce(`Line ${lineNo}: G4 with no dwell time`);
        else addDwell(Math.abs(secs));
        continue;
      }

      // G28/G30: rapid via an intermediate point, then to a reference position
      // fixed in *machine* coordinates. We don't know where that is, so only the
      // intermediate leg is drawn. Non-modal: the motion mode is left alone.
      if (refReturn) {
        warnOnce(`G${refReturn} return-to-reference is drawn only as far as its intermediate point — the machine home position is not in the program`);
        const start = state.pos.slice();
        // The intermediate point is X/Y/Z on a mill; on a lathe it is given with
        // the incremental words U/V/W (`G28 U0 W0`), which stay incremental
        // regardless of G90/G91. Read whichever the block carries.
        const via = [
          words.X !== undefined ? axisTarget(start[0], words.X, xScale(), state.absolute)
            : words.U !== undefined ? start[0] + words.U * xScale() : start[0],
          words.Y !== undefined ? axisTarget(start[1], words.Y, state.scale, state.absolute)
            : words.V !== undefined ? start[1] + words.V * state.scale : start[1],
          words.Z !== undefined ? axisTarget(start[2], words.Z, state.scale, state.absolute)
            : words.W !== undefined ? start[2] + words.W * state.scale : start[2],
        ];
        if (dist(start, via) > EPS) sink('rapid', start, via, lineNo);
        state.pos = via;
        continue;
      }

      const isTurningCycle =
        motionThisBlock !== undefined &&
        (TURNING_CYCLES.has(motionThisBlock) || (turning && motionThisBlock === 73));

      const hasCoords =
        words.X !== undefined || words.Y !== undefined || words.Z !== undefined;

      // Determine effective motion mode (modal if none stated this block).
      if (motionThisBlock === undefined) {
        // A bare coordinate block repeats the modal motion. Under a modal arc a
        // block may carry only centre offsets (`G3 J14` — a full circle).
        const arcOnly = (state.motion === 2 || state.motion === 3)
          && (words.I !== undefined || words.J !== undefined || words.K !== undefined);
        if (!hasCoords && !arcOnly) continue;
        motionThisBlock = state.motion;
      }

      if (motionThisBlock === 80) {
        state.inCycle = false;
        // Cancelling a canned cycle restores rapid positioning, so a retract
        // written as `G80 Z100.` still has to move.
        state.motion = 0;
        if (!hasCoords) continue;
        motionThisBlock = 0;
      }

      if (isTurningCycle) {
        const skipTo = turningCycle(motionThisBlock, words, lineNo, sink, li);
        state.motion = motionThisBlock;
        // The control jumps past the profile blocks the cycle just consumed.
        // Forward only — a backward jump would re-enter the cycle forever.
        if (skipTo != null && skipTo > li) li = skipTo;
        continue;
      }

      // Resolve target position for this block.
      const start = state.pos.slice();
      const target = [
        axisTarget(start[0], words.X, xScale(), state.absolute),
        axisTarget(start[1], words.Y, state.scale, state.absolute),
        axisTarget(start[2], words.Z, state.scale, state.absolute),
      ];

      if (DRILL_CYCLES.has(motionThisBlock)) {
        expandDrillCycle(motionThisBlock, state, words, start, target, sink, lineNo, addDwell);
        state.motion = motionThisBlock;
        continue;
      }

      // Linear / arc motion.
      if (motionThisBlock === 0) {
        sink('rapid', start, target, lineNo);
        state.pos = target;
      } else if (motionThisBlock === 1) {
        sink('feed', start, target, lineNo);
        state.pos = target;
      } else if (motionThisBlock === 2 || motionThisBlock === 3) {
        const plane = PLANES[state.plane];
        const arc = {};
        if (words.R !== undefined) arc.r = words.R * state.scale;
        else {
          // Remap I/J/K to the active plane's in-plane (u,v) offsets.
          const off = arcOffsets(state.plane, words, state.scale);
          arc.i = off.i;
          arc.j = off.j;
        }
        const cw = motionThisBlock === 2;
        const { points, warning } = tessellateArc(start, target, arc, plane, cw);
        if (warning) warnings.push(`Line ${lineNo}: ${warning}${arcHint(warning, state.plane, words)}`);
        for (let n = 0; n < points.length - 1; n++) {
          sink('feed', points[n], points[n + 1], lineNo);
        }
        state.pos = target;
      }
      state.motion = motionThisBlock;
    }
  }

  runBlocks(0, blocks.length, emit);

  if (!isFinite(min[0])) {
    min.fill(0);
    max.fill(0);
  }
  // Fall back to the full bounds when nothing was cut (a rapid-only program).
  const feedBounds = isFinite(fMin[0])
    ? { min: fMin, max: fMax }
    : { min: min.slice(), max: max.slice() };

  // Merge the detected tool table with what each tool actually cut. Tools that
  // ran but were never described in a comment still appear (type 'unknown'), so
  // the UI never hides an operation.
  const toolNums = new Set([...toolTable.keys(), ...toolCut.keys()].filter((n) => n));
  const tools = [...toolNums].sort((x, y) => x - y).map((n) => {
    const def = toolTable.get(n);
    const use = toolCut.get(n) || { feeds: 0, cutLength: 0 };
    return {
      n,
      type: def?.type ?? 'unknown',
      simType: def?.simType ?? 'flat',
      diameter: def?.diameter ?? null,
      radius: def?.radius ?? null,
      length: def?.length ?? null,
      lengthMax: def?.lengthMax ?? null,
      desc: def?.desc ?? '',
      feeds: use.feeds,
      cutLength: use.cutLength,
    };
  });

  return {
    segments,
    bounds: { min, max, feedMin: feedBounds.min, feedMax: feedBounds.max },
    stats: {
      mode,
      blocks: segments.length,
      rapidLength,
      feedLength,          // total distance spent cutting
      totalLength: rapidLength + feedLength,
      rapidTime,           // seconds
      feedTime,            // seconds
      dwellTime,           // seconds
      cycleTime: rapidTime + feedTime + dwellTime,
      // Distinct A-axis indices the program machines at. More than one means a
      // 4-axis job, which the Z-up height-field simulator can't carve whole.
      aIndices: [...aIndices].sort((x, y) => x - y),
      // Tools auto-detected from the program comments, with the diameter/type
      // each cut was actually made with. Drives the simulator's per-tool
      // geometry and the tool list in the panel.
      tools,
      warnings,
    },
  };
}

/**
 * A degenerate arc usually means the centre offsets were written for a
 * different plane — the classic case being a lathe I/K arc read in G17, where
 * K is ignored and I alone collapses the radius. Say so.
 */
function arcHint(warning, plane, words) {
  if (warning !== 'zero-radius arc') return '';
  if (plane !== 'G17' || words.K === undefined) return '';
  return ' — the K offset is ignored in the XY plane; this looks like a lathe arc (use Turning mode or G18)';
}

/** Map the I/J/K words onto the active plane's in-plane (u,v) offsets. */
function arcOffsets(plane, words, scale) {
  const I = (words.I || 0) * scale;
  const J = (words.J || 0) * scale;
  const K = (words.K || 0) * scale;
  if (plane === 'G17') return { i: I, j: J }; // XY
  if (plane === 'G18') return { i: K, j: I }; // ZX -> u=Z(K), v=X(I)
  return { i: J, j: K }; // G19 YZ -> u=Y(J), v=Z(K)
}

/**
 * Expand a drilling canned cycle into rapid/feed moves.
 * Supports G81/G82/G84/G85/G86/G89 (single plunge) and G83/G73 (peck).
 */
function expandDrillCycle(code, state, words, start, target, emit, lineNo, addDwell) {
  if (words.R !== undefined) state.cycleR = words.R * state.scale;
  if (words.Z !== undefined) state.cycleZ = words.Z * state.scale;
  if (words.Q !== undefined) state.cycleQ = Math.abs(words.Q * state.scale);

  const R = state.cycleR;
  const zBottom = state.cycleZ;
  const [hx, hy] = [target[0], target[1]]; // hole XY

  // On first invocation the "initial Z" is the height we entered the cycle at.
  if (!state.inCycle) {
    state.cycleInitialZ = start[2];
    state.inCycle = true;
  }
  const initialZ = state.cycleInitialZ;
  const retractZ = state.retractToInitial ? initialZ : R;

  let cur = state.pos.slice();

  // 1. Rapid traverse to hole XY at current height.
  const overHole = [hx, hy, cur[2]];
  emit('rapid', cur, overHole, lineNo);
  cur = overHole;

  // 2. Rapid down to the R (retract) plane.
  const atR = [hx, hy, R];
  emit('rapid', cur, atR, lineNo);
  cur = atR;

  // 3. Plunge to bottom — pecking for G83/G73.
  if ((code === 83 || code === 73) && state.cycleQ > 0) {
    let z = R;
    while (z > zBottom + 1e-9) {
      const next = Math.max(zBottom, z - state.cycleQ);
      emit('feed', [hx, hy, z], [hx, hy, next], lineNo);
      z = next;
      if (z > zBottom + 1e-9) {
        // G73 makes a small chip-break hop; G83 fully retracts to R.
        const hop = code === 73 ? Math.min(R, z + 0.5) : R;
        emit('rapid', [hx, hy, z], [hx, hy, hop], lineNo);
        emit('rapid', [hx, hy, hop], [hx, hy, z], lineNo);
      }
    }
  } else {
    emit('feed', [hx, hy, R], [hx, hy, zBottom], lineNo);
  }

  // G82/G89 dwell at the bottom of the hole for P seconds.
  if ((code === 82 || code === 89) && words.P !== undefined) addDwell(Math.abs(words.P));

  // 4. Retract. G85/G89 feed back out (boring); others rapid.
  const retractType = code === 85 || code === 89 ? 'feed' : 'rapid';
  emit(retractType, [hx, hy, zBottom], [hx, hy, retractZ], lineNo);

  state.pos = [hx, hy, retractZ];
}
