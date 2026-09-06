/**
 * Tool-table auto-detection from program comments.
 *
 * Shop programs describe their tooling in the comment on the tool-change line,
 * not in any machine-readable field:
 *
 *   T1(SHOULDERMILL D32 - FACE MILLING)
 *   T2(DRILL 9 CB - PRE-DRILL)
 *   T3(ENDMILL D7 L48-54 - ROUGH B2)
 *   T8(REAMER D3)
 *
 * ...or on a comment line of their own, which is what this app's own
 * post-processor writes, because a Fanuc tool change is two bare words:
 *
 *   (OP1: FACE)
 *   (TOOL: T1 FACEMILL Ø50)
 *   T1 M06
 *
 * That second form was not read at all, and the cost was not academic: every
 * program posted from the CAM panel came back with an empty tool table, so the
 * operation the operator had explicitly tooled with a Ø50 face mill simulated —
 * and drew — as whatever the fallback picker happened to hold. Choosing a tool
 * changed nothing on screen.
 *
 * parseToolTable() reads those comments into a table keyed by tool number, so
 * the simulator can carve each operation with its real cutter geometry instead
 * of one global tool, and the UI can name the tool that is cutting. A program
 * with no descriptive tool comments (a bare `T0606` lathe call) yields an empty
 * table and the caller falls back to its default tool.
 */

import { cutterFromType } from '../cam/cutters.js';

// Comment keyword -> normalised type + the shape the dexel simulator carves
// with. Only ball-nosed cutters leave a rounded bottom; everything else is
// modelled as a flat-bottomed disc of the tool's radius.
//
// A shoulder mill and a face mill are separated here (they used to share one
// type) because `cam/cutters.js` draws and feeds them as different tools: a
// face mill is a shallow disc, a shoulder mill a squat body cutting a true 90°
// wall. Slot mills likewise — `SLOT DRILL` must not fall through to `DRILL`,
// which is why its row sits above it.
const TYPES = [
  [/BALL\s*NOSE|BALL\s*MILL|BALL\s*END|\bBALL\b/i, 'ballmill', 'ball'],
  [/BULL\s*NOSE|\bBULL\b/i, 'bullmill', 'flat'],
  [/SHOULDER\s*MILL|\bSHOULDERMILL\b|\bSHOULDER\b/i, 'shouldermill', 'flat'],
  [/FACE\s*MILL|\bFACEMILL\b/i, 'facemill', 'flat'],
  [/CHAMFER|\bSPOT\b|CENTER\s*DRILL|CENTRE\s*DRILL/i, 'chamfer', 'flat'],
  [/\bREAMER\b|\bREAM\b/i, 'reamer', 'flat'],
  [/\bTAP\b|TAPPING/i, 'tap', 'flat'],
  [/BORING|BORE\s*BAR|\bBORE\b/i, 'bore', 'flat'],
  [/SLOT\s*MILL|SLOT\s*DRILL|\bSLOTMILL\b/i, 'slotmill', 'flat'],
  [/\bDRILL\b/i, 'drill', 'flat'],
  [/END\s*MILL|\bENDMILL\b|FLAT\s*MILL|SQUARE\s*MILL/i, 'endmill', 'flat'],
];

/**
 * Classify a tool description; unknown descriptions default to a flat endmill.
 *
 * `cutter` is the shape from `cam/cutters.js` when the type is a milling cutter
 * we can draw — it is what makes a detected `T1(FACEMILL D50)` appear on screen
 * as a disc, and what the carvers stamp with. Drills, taps, reamers and boring
 * bars have no cutter shape here (`null`): they keep the plain flat/ball.
 *
 * **An unrecognised comment reports `unclassified: true`**, and that is not the
 * same as a recognised tool with no shape. Two different things both arrive here
 * as `cutter: null`:
 *
 * - a **reamer, tap or boring bar** — recognised, and deliberately shapeless:
 *   it sizes or threads a hole that is already there, so it keeps the plain
 *   flat/ball and must NOT borrow whatever the fallback picker holds;
 * - an **unrecognised description** — nothing was said about the shape at all,
 *   so the cutter the operator picked is the only opinion in the room and gets
 *   to decide.
 *
 * They used to be indistinguishable, and the second was resolved as a confident
 * `'endmill'`, which beat the operator every time: pick a chamfer mill, run a
 * program whose tool line reads `T1 M6 (ROUGH D6)`, and the stock came out with a
 * square-shouldered groove where the part has a chamfer — with nothing on screen
 * to say why. `effectiveTool` reads the flag; `type` and `simType` keep their old
 * defaults, being what the tool table *displays* and what the feed model assumes,
 * neither of which is a shape the carvers stamp with.
 */
function classify(desc) {
  for (const [re, type, simType] of TYPES) {
    if (re.test(desc)) return { type, simType, cutter: cutterFromType(type) };
  }
  return { type: 'endmill', simType: 'flat', cutter: null, unclassified: true };
}

/**
 * Pull the cutter diameter (mm) from a description. Prefers an explicit
 * diameter word — `D7`, `D32`, `D6.5`, or the `Ø50` this app's own tool library
 * writes — and falls back to the first bare number for styles like `DRILL 9`.
 * Numbers that belong to a length (`L48`) are never diameters.
 */
function diameterOf(head) {
  const d = /(?:\bD|[ØøΦφ⌀])\s*(\d+(?:\.\d+)?)/i.exec(head);
  if (d) return Number(d[1]);
  // Strip any L-length token so its digits can't be mistaken for a diameter.
  const bare = /(?:^|\s)(\d+(?:\.\d+)?)(?=\s|$)/.exec(head.replace(/\bL\s*\d[\d.-]*/gi, ' '));
  return bare ? Number(bare[1]) : null;
}

/** Pull the flute/gauge length, as a single value or a min–max range (`L48-54`). */
function lengthOf(head) {
  const m = /\bL\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/i.exec(head);
  if (!m) return { length: null, lengthMax: null };
  const length = Number(m[1]);
  return { length, lengthMax: m[2] !== undefined ? Number(m[2]) : null };
}

/**
 * @param {string} text raw G-code program
 * @returns {Map<number, {n:number, type:string, simType:'flat'|'ball',
 *   cutter:string|null, diameter:number|null, radius:number|null,
 *   length:number|null, lengthMax:number|null, desc:string}>}
 *   Keyed by tool number. When a number is redefined (a tool used twice with
 *   different comments) the first descriptive definition wins.
 */
export function parseToolTable(text) {
  const table = new Map();
  const lines = String(text).split(/\r?\n/);
  // A tool-change line: optional leading N-block, then T<number>, then a paren
  // comment on the same line. `T0303` / `T3` both parse; the comment is required
  // (a bare T call carries no description to detect).
  const RE = /^\s*(?:N\s*\d+\s*)?T0*(\d+)\b[^(\n]*\(([^)]*)\)/i;
  // A comment line that names the tool instead: `(TOOL: T1 FACEMILL Ø50)`. The
  // tool number is inside the comment here, which is why the rule above cannot
  // see it — its `T` is the machine's, this one is prose.
  const RE_DECL = /^\s*\(\s*TOOL\s*[:-]?\s*T0*(\d+)\s*[:-]?\s*([^)]*)\)/i;
  for (const raw of lines) {
    const m = RE.exec(raw) || RE_DECL.exec(raw);
    if (!m) continue;
    const n = Number(m[1]);
    if (table.has(n)) continue; // first definition wins
    const desc = m[2].trim();
    const head = desc.split(/\s+-\s+|--/)[0]; // drop the "- OPERATION" tail
    const { type, simType, cutter, unclassified } = classify(desc);
    const diameter = diameterOf(head);
    const { length, lengthMax } = lengthOf(head);
    table.set(n, {
      n, type, simType, cutter, diameter,
      radius: diameter != null ? diameter / 2 : null,
      // Only present when the comment named nothing we recognise — see
      // `classify`. `effectiveTool` reads it to know the shape is unstated
      // rather than deliberately shapeless.
      ...(unclassified ? { unclassified: true } : {}),
      length, lengthMax, desc,
    });
  }
  return table;
}
