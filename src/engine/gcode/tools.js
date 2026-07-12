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
 * parseToolTable() reads those comments into a table keyed by tool number, so
 * the simulator can carve each operation with its real cutter geometry instead
 * of one global tool, and the UI can name the tool that is cutting. A program
 * with no descriptive tool comments (a bare `T0606` lathe call) yields an empty
 * table and the caller falls back to its default tool.
 */

// Comment keyword -> normalised type + the shape the dexel simulator carves
// with. Only ball-nosed cutters leave a rounded bottom; everything else is
// modelled as a flat-bottomed disc of the tool's radius.
const TYPES = [
  [/BALL\s*NOSE|BALL\s*MILL|BALL\s*END|\bBALL\b/i, 'ballmill', 'ball'],
  [/BULL\s*NOSE|\bBULL\b/i, 'bullmill', 'flat'],
  [/SHOULDER\s*MILL|FACE\s*MILL|\bFACEMILL\b/i, 'facemill', 'flat'],
  [/CHAMFER|\bSPOT\b|CENTER\s*DRILL|CENTRE\s*DRILL/i, 'chamfer', 'flat'],
  [/\bREAMER\b|\bREAM\b/i, 'reamer', 'flat'],
  [/\bTAP\b|TAPPING/i, 'tap', 'flat'],
  [/BORING|BORE\s*BAR|\bBORE\b/i, 'bore', 'flat'],
  [/\bDRILL\b/i, 'drill', 'flat'],
  [/END\s*MILL|\bENDMILL\b|SLOT\s*MILL|FLAT\s*MILL|SQUARE\s*MILL/i, 'endmill', 'flat'],
];

/** Classify a tool description; unknown descriptions default to a flat endmill. */
function classify(desc) {
  for (const [re, type, simType] of TYPES) {
    if (re.test(desc)) return { type, simType };
  }
  return { type: 'endmill', simType: 'flat' };
}

/**
 * Pull the cutter diameter (mm) from a description. Prefers an explicit `D`
 * word (`D7`, `D32`, `D6.5`); falls back to the first bare number for styles
 * like `DRILL 9`. Numbers that belong to a length (`L48`) are never diameters.
 */
function diameterOf(head) {
  const d = /\bD\s*(\d+(?:\.\d+)?)/i.exec(head);
  if (d) return Number(d[1]);
  // Strip any L-length token so its digits can't be mistaken for a diameter.
  const bare = /(?:^|\s)(\d+(?:\.\d+)?)(?=\s|$)/.exec(head.replace(/\bL\s*\d[\d.\-]*/gi, ' '));
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
 *   diameter:number|null, radius:number|null, length:number|null,
 *   lengthMax:number|null, desc:string}>}
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
  for (const raw of lines) {
    const m = RE.exec(raw);
    if (!m) continue;
    const n = Number(m[1]);
    if (table.has(n)) continue; // first definition wins
    const desc = m[2].trim();
    const head = desc.split(/\s+-\s+|--/)[0]; // drop the "- OPERATION" tail
    const { type, simType } = classify(desc);
    const diameter = diameterOf(head);
    const { length, lengthMax } = lengthOf(head);
    table.set(n, {
      n, type, simType, diameter,
      radius: diameter != null ? diameter / 2 : null,
      length, lengthMax, desc,
    });
  }
  return table;
}
