/**
 * Standard cutting speeds — find the material, read each tool's Vc, propose the
 * standard instead, and rewrite the program if the operator agrees.
 *
 * The ranges themselves come from the database (`/api/engineer/cam/std-vc`, see
 * `lib/stdApi.js`); everything here is a pure function of the program text and
 * the table it is handed, so it is testable without a server and the same code
 * answers whether the table came from the API or from a test.
 *
 * Three steps, kept apart because each fails differently:
 *
 *   detectMaterial  which material is this program for?  (a guess; may be none)
 *   scanProgram     what does each tool block say?        (reads, never edits)
 *   proposeStd      what would the standard change?       (the diff, with reasons)
 *   applyStd        make that change in the text          (only what was proposed)
 *
 * A proposal records the exact character position of every number it would
 * replace, and `applyStd` checks the program still reads the same there before
 * writing. If the operator edited the listing between "propose" and "apply" the
 * edit is refused and counted as stale, rather than landing on the wrong word.
 *
 * What it will NOT do, on purpose:
 *   - touch a tool the table has no figure for (parting, grooving, threading) or
 *     whose speed cannot be worked out (no diameter on a G97 tool);
 *   - invent a feed. The table holds speeds only. On a mill (feed per minute) F
 *     moves with S so chip load per tooth is unchanged; on a lathe (feed per
 *     revolution) F is left as written;
 *   - ask a machine for more rpm than it has. A speed capped by the spindle is
 *     reported as capped — still outside the range — not quietly accepted.
 */

import { parseToolTable } from '../gcode/tools.js';

export const STD_OPERATIONS = ['turning', 'milling', 'drilling', 'reaming', 'tap', 'parting', 'grooving', 'centre'];

/** Spindle ceilings used when the caller has no better figure (rpm). */
export const DEFAULT_LIMITS = { mill: 8000, turn: 2200 };

const PI = Math.PI;

/** `line` with comments blanked to spaces — same length, so indices still point into `line`. */
export function maskComments(line) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '(') { depth++; out += ' '; continue; }
    if (ch === ')' && depth > 0) { depth--; out += ' '; continue; }
    if (depth > 0) { out += ' '; continue; }
    if (ch === ';') { out += ' '.repeat(line.length - i); break; }
    out += ch;
  }
  return out;
}

const norm = (s) => String(s || '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// 1. Which material?
// ---------------------------------------------------------------------------

/**
 * Find the material a program is for.
 *
 * G-code does not say. The two places a shop does say it are the file name
 * (`7075_1F-B-00180-004_FORK…`, `17-4PH_…`) and a comment in the header
 * (`(MATERIAL: 7075-T73511 …)`), so those are read, file name first.
 *
 * An alias matches only as a whole token — `7075` matches `7075_1F-B…` but not
 * a part number that merely contains the digits. When the longest alias wins:
 * `Ti-6Al-4V` over a stray `Ti`.
 *
 * @param {{fileName?:string, text?:string}} src
 * @param {{key:string, aliases:string[]}[]} materials
 * @returns {{key:string, source:'file name'|'program comment', alias:string, conflict:string|null}|null}
 */
export function detectMaterial({ fileName = '', text = '' }, materials) {
  const find = (haystack) => {
    let best = null;
    for (const m of materials || []) {
      for (const alias of [m.key, ...(m.aliases || [])]) {
        if (!alias) continue;
        const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(alias)}(?![A-Za-z0-9])`, 'i');
        if (re.test(haystack) && (!best || alias.length > best.alias.length)) best = { key: m.key, alias };
      }
    }
    return best;
  };

  const head = norm(text).split(/\r?\n/).slice(0, 40);
  const comments = head
    .map((l) => /\(([^)]*)\)/g.exec(l))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((c) => /MATERIAL|MAT\b|STOCK/i.test(c))
    .join(' | ');

  const fromFile = find(norm(fileName));
  const fromComment = comments ? find(comments) : null;
  if (fromFile) {
    return {
      ...fromFile, source: 'file name',
      conflict: fromComment && fromComment.key !== fromFile.key ? fromComment.key : null,
    };
  }
  if (fromComment) return { ...fromComment, source: 'program comment', conflict: null };
  return null;
}

// ---------------------------------------------------------------------------
// 2. Read the program, tool block by tool block
// ---------------------------------------------------------------------------

const S_RE = /(?<![A-Za-z#])S(\d+(?:\.\d+)?)/g;
const F_RE = /(?<![A-Za-z#])F(\d+(?:\.\d*)?)/g;
const TOOL_RE = /^\s*(?:N\s*\d+\s*)?T0*(\d+)\b/i;
// A G-word, not a prefix of another: `G1Y-5` and `G99G73` must both match (there is no
// word boundary between a digit and a letter), while `G10` / `G100` must not.
const G = (n) => new RegExp(`(?<![A-Za-z])G0*${n}(?!\\d)`, "i");
const CUT_RE = /(?<![A-Za-z])G0*(?:[123]|7[0-6]|8[1-9])(?!\d)/i;

/**
 * Is this a lathe program or a mill program? Read from the text, because the
 * CAM tab's mode is just whatever the operator last set — opening a turning file
 * while the tab says Milling must not make its tools "milling" tools.
 *
 * Signals: constant surface speed (G96), a G50 clamp, G99-with-no-tool-change and
 * four-digit tool words (T0101) say lathe; M6, G43 and the 8x canned cycles say
 * mill. Returns 'turn' | 'mill', or null when the text gives no clear lead.
 */
export function detectProgramMode(text, fileName = '') {
  let turn = /(?:^|[^A-Za-z])(?:TURN|LATHE|BLANK)/i.test(fileName) ? 2 : 0;
  let mill = 0;
  const seen = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = maskComments(raw);
    if (!seen.g96 && G(96).test(line)) { seen.g96 = true; turn += 3; }
    if (!seen.g50 && G(50).test(line) && /S\d/i.test(line)) { seen.g50 = true; turn += 2; }
    if (!seen.t4 && /^\s*(?:N\s*\d+\s*)?T\d{4}(?!\d)/i.test(line)) { seen.t4 = true; turn += 2; }
    if (!seen.m6 && /(?<![A-Za-z])M0*6(?!\d)/i.test(line)) { seen.m6 = true; mill += 3; }
    if (!seen.g43 && G(43).test(line)) { seen.g43 = true; mill += 2; }
    if (!seen.can && /(?<![A-Za-z])G0*8[1-9](?!\d)/i.test(line)) { seen.can = true; mill += 1; }
  }
  if (turn > mill) return 'turn';
  if (mill > turn) return 'mill';
  return null;
}

/**
 * Split a program into tool blocks and collect each block's S and F words.
 *
 * @param {string} text
 * @param {{mode?:'mill'|'turn'}} opts
 */
export function scanProgram(text, { mode = 'mill' } = {}) {
  const lines = norm(text).split('\n');
  const turning = mode === 'turn';
  let css = false;
  let feedPerRev = turning; // a lathe starts in feed per revolution, a mill in per minute
  const blocks = [];
  let cur = null;
  const counts = new Map();

  lines.forEach((raw, i) => {
    const code = maskComments(raw);

    const t = TOOL_RE.exec(code);
    if (t && !/^\s*T\s*[#=]/i.test(code)) {
      const tool = Number(t[1]);
      // As the program writes it — `T0606` is station 6, offset 06, not tool 606 —
      // so the label the operator reads is the one on their own listing.
      const label = `T${/T(\d+)/i.exec(code)[1]}`;
      const n = (counts.get(label) || 0) + 1;
      counts.set(label, n);
      // A header comment sits on the tool line or on the line just above it.
      const prev = i > 0 && /^\s*\(.*\)\s*$/.test(lines[i - 1]) ? lines[i - 1] : '';
      cur = {
        id: `${label}#${n}`, tool, label, startLine: i, endLine: i,
        header: [prev, raw].filter(Boolean).join('\n'),
        sWords: [], fWords: [], cut: false, g71: false, g74: false, g76: false, varFeed: false, g50: null,
      };
      blocks.push(cur);
    }

    if (turning) {
      if (G(98).test(code)) feedPerRev = false;
      if (G(99).test(code)) feedPerRev = true;
    } else {
      if (G(95).test(code)) feedPerRev = true;
      if (G(94).test(code)) feedPerRev = false;
    }
    if (G(96).test(code)) css = true;
    if (G(97).test(code)) css = false;

    if (!cur) return;
    cur.endLine = i;
    cur.feedPerRev = feedPerRev;
    if (CUT_RE.test(code)) cur.cut = true;
    if ((G(71).test(code) || G(70).test(code))) cur.g71 = true;
    if (G(74).test(code)) cur.g74 = true;
    if (G(76).test(code)) cur.g76 = true;

    const isG50 = G(50).test(code);
    for (const m of code.matchAll(S_RE)) {
      if (isG50) { cur.g50 = Number(m[1]); continue; } // the lathe's rpm clamp, not a speed
      cur.sWords.push({ line: i, index: m.index, text: m[0], value: Number(m[1]), css });
    }
    if (/(?<![A-Za-z])F\s*[#[]/.test(code)) cur.varFeed = true;
    for (const m of code.matchAll(F_RE)) {
      cur.fWords.push({ line: i, index: m.index, text: m[0], value: Number(m[1]) });
    }
  });

  // Describe each block with the tool-table reader the rest of the CAM module uses.
  for (const b of blocks) {
    const entry = [...parseToolTable(b.header).values()][0];
    b.type = entry?.type ?? null;
    // On a lathe the tool has no diameter that sets a cutting speed — the workpiece does — so
    // a number in the header ("ROUGHING CYCLE 2") is not one. Only hole tools carry a real Ø.
    // (`parseToolTable` falls back to the first bare number, which is right for "DRILL 9".)
    const holeTool = ['drill', 'reamer', 'tap', 'chamfer'].includes(entry?.type)
      || /CENTRE?R?\s*DRILL|CENTER\s*DRILL|SPOT/i.test(b.header);
    b.diameter = turning && !holeTool ? null : (entry?.diameter ?? null);
    b.desc = entry?.desc ?? '';
    b.unclassified = entry ? !!entry.unclassified : true;
  }
  return { blocks, mode: turning ? 'turn' : 'mill' };
}

/** Which standard operation a tool block is, or null when the table says nothing about it. */
export function operationOf(block, mode) {
  const text = `${block.header}`.toUpperCase();
  // Threading has no figure (nothing verified to cite yet), so it is never touched.
  if (block.g76 || /THREAD/.test(text) || block.type === 'thread') return null;
  // A centre / spotting drill is its own operation: it runs far slower than the drill it precedes.
  if (/CENTRE?R?\s*DRILL|CENTER\s*DRILL|SPOT/.test(text)) return 'centre';
  // Parting and grooving are lathe tools. "PARTING / GROOVING" on one tool is a parting tool.
  // (`parseToolTable` files both under type 'parting', so the words decide, not the type.)
  if (mode === 'turn' && /PARTING|PART[ -]?OFF|CUT[ -]?OFF/.test(text)) return 'parting';
  if (mode === 'turn' && (/GROOV/.test(text) || block.type === 'parting')) return 'grooving';
  if (block.type === 'parting') return null;
  if (block.type === 'reamer') return 'reaming';
  if (block.type === 'tap') return 'tap';
  if (block.type === 'drill' || block.g74) return 'drilling';
  if (mode === 'turn') {
    if (block.type === 'bore') return 'turning';
    return block.cut && block.sWords.some((w) => w.css) ? 'turning' : null;
  }
  if (block.type === 'bore') return null;
  return block.cut ? 'milling' : null;
}

// ---------------------------------------------------------------------------
// 3. Propose
// ---------------------------------------------------------------------------

const round1 = (v) => Math.round(v * 10) / 10;
/** A feed rounded the way a person would write it: whole 5s above 100, a decimal below. */
function tidyFeed(v) {
  if (v >= 100) return Math.round(v / 5) * 5;
  return round1(v);
}
const fmt = (v) => String(Number.isInteger(v) ? v : round1(v));

/**
 * Compare every tool block with the material's standard.
 *
 * `status` per row:
 *   ok           already inside the range — nothing to do
 *   change       outside the range and a replacement was worked out
 *   limit        outside the range, but the spindle cannot get any closer
 *   no-standard  the table has no figure for this tool / operation
 *   no-spindle   the block never sets a speed
 *   no-diameter  a G97 speed with no tool diameter, so Vc cannot be known
 *
 * @param {{blocks:object[], mode:'mill'|'turn'}} scan
 * @param {{key:string,label:string,status:string,vc:Record<string,[number,number]>}} material
 * @param {{maxRpm?:number, diameters?:Record<string,number>}} opts
 *   `diameters`: Ø (mm) the operator typed, by block id, for tools whose header has none.
 */
export function proposeStd(scan, material, opts = {}) {
  const { mode } = scan;
  const cap = opts.maxRpm ?? DEFAULT_LIMITS[mode];
  const rows = scan.blocks.map((b) => {
    const op = operationOf(b, mode);
    // The program's own diameter always wins; an operator-supplied one only fills a gap.
    const given = Number(opts.diameters?.[b.id]);
    const dia = b.diameter || (given > 0 ? given : null);
    const row = {
      id: b.id, tool: b.tool, label: b.label, startLine: b.startLine, endLine: b.endLine, desc: b.desc || b.header.split('\n').pop().trim(),
      operation: op, diameter: dia, diameterEditable: !b.diameter, diameterGiven: !b.diameter && !!dia,
      status: 'no-standard', reason: '',
      range: op ? material.vc[op] || null : null,
      css: false, sOld: null, vcOld: null, sNew: null, vcNew: null, capped: false,
      edits: [], warnings: [],
    };
    if (!op || !row.range) {
      row.reason = !op ? 'No standard for this kind of tool (threading, or a tool the table has no figure for).'
        : `The standard has no ${op} range for ${material.label}.`;
      return row;
    }
    const s = b.sWords.find((w) => w.value > 0);
    if (!s) { row.status = 'no-spindle'; row.reason = 'The tool block sets no spindle speed.'; return row; }
    row.css = s.css;
    row.sOld = s.value;
    if (s.css) row.vcOld = s.value;
    else if (dia) row.vcOld = (PI * dia * s.value) / 1000;
    else { row.status = 'no-diameter'; row.reason = 'Speed is in rpm but the tool diameter is not in the program.'; return row; }

    const [lo, hi] = row.range;
    if (row.vcOld >= lo - 1e-9 && row.vcOld <= hi + 1e-9) {
      row.status = 'ok';
      row.reason = `${Math.round(row.vcOld)} m/min is inside ${lo}–${hi}.`;
      return row;
    }

    // Outside: move to the lower bound of the range.
    let sNew;
    if (s.css) {
      sNew = lo;
    } else {
      sNew = Math.ceil((1000 * lo) / (PI * dia) / 10) * 10;
      if (sNew > cap) { sNew = cap; row.capped = true; }
    }
    row.sNew = sNew;
    row.vcNew = s.css ? sNew : (PI * dia * sNew) / 1000;

    const closer = Math.abs(row.vcNew - lo) < Math.abs(row.vcOld - lo) - 1e-9;
    if (row.capped && !closer) {
      row.status = 'limit';
      row.reason = `${Math.round(row.vcOld)} m/min is outside ${lo}–${hi}, but the spindle limit (${cap} rpm) cannot get closer.`;
      row.sNew = row.vcNew = null;
      row.capped = false;
      return row;
    }

    row.status = 'change';
    row.reason = `${Math.round(row.vcOld)} m/min is outside ${lo}–${hi}.`;
    if (row.capped) row.warnings.push(`Limited by the ${cap} rpm spindle: reaches ${Math.round(row.vcNew)} m/min, still outside the range.`);

    row.edits.push({ line: s.line, index: s.index, old: s.text, next: `S${fmt(sNew)}`, kind: 'S' });
    // Only the speed in the block's own S word moves; every other S in the block
    // (a second tool use that re-states it) is edited to the same value.
    for (const w of b.sWords) {
      if (w === s || w.value <= 0) continue;
      if (w.value === s.value) row.edits.push({ line: w.line, index: w.index, old: w.text, next: `S${fmt(sNew)}`, kind: 'S' });
    }

    // Feed: per minute follows the spindle so chip load is unchanged; per revolution stays.
    if (!b.feedPerRev && !s.css) {
      const k = sNew / s.value;
      for (const f of b.fWords) {
        if (f.value <= 0) continue;
        const next = tidyFeed(f.value * k);
        // Keep the program's own style: `F600.` was written with its decimal point.
        const dot = f.text.endsWith('.') && Number.isInteger(next) ? '.' : '';
        if (next !== f.value) row.edits.push({ line: f.line, index: f.index, old: f.text, next: `F${fmt(next)}${dot}`, kind: 'F' });
      }
      row.feedScale = k;
      if (b.varFeed) row.warnings.push('Some feeds are variables — they were not scaled. Check chip load.');
    } else {
      row.feedScale = 1;
    }
    return row;
  });

  return {
    rows,
    changes: rows.filter((r) => r.status === 'change').length,
    material: { key: material.key, label: material.label, status: material.status },
  };
}

/**
 * Seconds of machining each tool block accounts for, from the interpreter's own
 * segments — each carries the time of its move (a dwell is billed to the move
 * before it) and the 1-based program line it came from. A block owns the lines
 * from its tool call to the next one, so a tool called twice gets two figures.
 *
 * Tool-change time and any motion before the first tool call belong to no block,
 * so the figures add up to LESS than the program's cycle time, never more.
 *
 * @param {{line:number,t:number}[]} segments `interpret(...).segments`
 * @param {{id:string,startLine:number,endLine:number}[]} rows the proposal's rows (0-based lines)
 * @returns {Record<string, number>} seconds by row id
 */
export function rowTimes(segments, rows) {
  const out = {};
  const byTool = new Map();
  for (const r of rows) {
    out[r.id] = 0;
    if (!byTool.has(r.tool)) byTool.set(r.tool, []);
    byTool.get(r.tool).push(r);
  }
  for (const s of segments) {
    if (!(s.t > 0)) continue;
    // The tool that was cutting decides the row. A line number cannot: a lathe's G70 replays
    // the profile written in the roughing tool's block, so its moves report THOSE lines while
    // belonging to the finishing tool — which used to leave the finisher with a second or two.
    // The line only picks between several blocks of the SAME tool.
    const cands = s.tool != null ? byTool.get(s.tool) : undefined;
    const i = s.line - 1;
    const inside = (x) => i >= x.startLine && i <= x.endLine;
    let r = null;
    if (cands?.length === 1) [r] = cands;
    else if (cands?.length > 1) r = cands.find(inside) ?? [...cands].reverse().find((x) => x.startLine <= i) ?? cands[0];
    else r = rows.find(inside) ?? null; // no tool to go by: only a line that sits inside a block counts
    if (r) out[r.id] += s.t;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Apply
// ---------------------------------------------------------------------------

/**
 * Rewrite the program with the chosen proposals.
 *
 * @param {string} text the program exactly as it was when `proposeStd` ran
 * @param {{rows:object[]}} proposal
 * @param {{skip?:Set<string>}} opts row ids the operator turned off
 * @returns {{text:string, applied:number, stale:number}}
 */
export function applyStd(text, proposal, { skip = new Set() } = {}) {
  const lines = norm(text).split('\n');
  const byLine = new Map();
  let stale = 0;
  let applied = 0;
  for (const row of proposal.rows) {
    if (row.status !== 'change' || skip.has(row.id)) continue;
    let rowStale = false;
    for (const e of row.edits) {
      if (lines[e.line]?.slice(e.index, e.index + e.old.length) !== e.old) { rowStale = true; break; }
    }
    if (rowStale) { stale++; continue; } // all of a row or none of it — a half-changed tool is worse than either
    for (const e of row.edits) {
      if (!byLine.has(e.line)) byLine.set(e.line, []);
      byLine.get(e.line).push(e);
    }
    applied++;
  }
  for (const [ln, edits] of byLine) {
    edits.sort((a, b) => b.index - a.index);
    let s = lines[ln];
    for (const e of edits) s = s.slice(0, e.index) + e.next + s.slice(e.index + e.old.length);
    lines[ln] = s;
  }
  return { text: lines.join('\n'), applied, stale };
}
