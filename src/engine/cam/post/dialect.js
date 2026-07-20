/**
 * Post dialects — what each control expects a program to look like.
 *
 * The moves are the same everywhere; the wrapping around them is not. A Haas
 * wants a five-digit program number and comes home on `G53 Z0.`, a Siemens ISO
 * program has no tape marks and comments with `;`, and a GRBL router has no
 * tool changer, no work-offset table and no tool-length compensation to cancel.
 * Sending a Fanuc header to any of them is how a program gets rejected at the
 * control before a single move is read.
 *
 * So the dialect is data, and `fanuc.js` is the ISO writer that consumes it.
 * Everything here is a *format* decision — never a geometry one. If a value in
 * this file could change where the tool goes, it is in the wrong file.
 *
 * These are pragmatic ISO-compatible outputs, not vendor-certified posts. Every
 * dialect carries a `caveat` where that matters, and the caveat is surfaced in
 * the program header rather than hidden here.
 *
 * Pure data + pure lookups: no React, no store, no DOM.
 */

/**
 * @typedef {object} Dialect
 * @property {string} id
 * @property {string} label
 * @property {boolean} tapeMarks        wrap the file in `%`
 * @property {'paren'|'semicolon'} commentStyle
 * @property {number|null} programDigits  digits after `O`; null = no O-number
 * @property {boolean} toolChanges       the machine has a changer
 * @property {boolean} toolLengthComp    emit G43 / G49
 * @property {boolean} workOffset        emit G54
 * @property {boolean} coolant           emit M08 / M09
 * @property {boolean} rotary            can be commanded on a rotary axis at all
 * @property {string} programEnd         M30 or M02
 * @property {string[]} millSafeStart    the safety block at the top of a mill program
 * @property {string[]} turnSafeStart
 * @property {string[]} millHome         how this control goes home between tools
 * @property {string[]} turnHome
 * @property {string} [caveat]           printed in the header when set
 */

const FANUC_MILL_SAFE = ['G21 G17 G40 G49 G80 G90'];
const FANUC_TURN_SAFE = ['G21 G18 G40 G99'];

/** @type {Record<string, Dialect>} */
export const DIALECTS = {
  fanuc: {
    id: 'fanuc',
    label: 'Fanuc (0i / 30i)',
    tapeMarks: true,
    commentStyle: 'paren',
    programDigits: 4,
    toolChanges: true,
    toolLengthComp: true,
    workOffset: true,
    coolant: true,
    rotary: true,
    programEnd: 'M30',
    millSafeStart: FANUC_MILL_SAFE,
    turnSafeStart: FANUC_TURN_SAFE,
    millHome: ['G91 G28 Z0.', 'G90'],
    turnHome: ['G28 U0. W0.'],
  },

  haas: {
    id: 'haas',
    label: 'Haas (NGC)',
    tapeMarks: true,
    commentStyle: 'paren',
    // Haas takes O00001-style five-digit numbers.
    programDigits: 5,
    toolChanges: true,
    toolLengthComp: true,
    workOffset: true,
    coolant: true,
    rotary: true,
    programEnd: 'M30',
    millSafeStart: ['G20 G17 G40 G49 G80 G90', 'G21'],
    turnSafeStart: FANUC_TURN_SAFE,
    // Haas posts conventionally come home in machine coordinates rather than
    // through G28, which avoids an intermediate point left over from a
    // previous program.
    millHome: ['G53 Z0.'],
    turnHome: ['G53 X0. Z0.'],
  },

  brother: {
    id: 'brother',
    label: 'Brother Speedio (CNC-D00)',
    tapeMarks: true,
    commentStyle: 'paren',
    programDigits: 4,
    toolChanges: true,
    toolLengthComp: true,
    workOffset: true,
    coolant: true,
    rotary: true,
    programEnd: 'M30',
    millSafeStart: FANUC_MILL_SAFE,
    turnSafeStart: FANUC_TURN_SAFE,
    millHome: ['G91 G28 Z0.', 'G90'],
    turnHome: ['G28 U0. W0.'],
    caveat: 'BROTHER HIGH-SPEED MODES (G05.1) ARE NOT EMITTED',
  },

  'mazatrol-eia': {
    id: 'mazatrol-eia',
    label: 'Mazak (EIA / ISO mode)',
    tapeMarks: true,
    commentStyle: 'paren',
    programDigits: 4,
    toolChanges: true,
    toolLengthComp: true,
    workOffset: true,
    coolant: true,
    rotary: true,
    programEnd: 'M30',
    millSafeStart: FANUC_MILL_SAFE,
    turnSafeStart: FANUC_TURN_SAFE,
    millHome: ['G91 G28 Z0.', 'G90'],
    turnHome: ['G28 U0. W0.'],
    caveat: 'THIS IS EIA/ISO OUTPUT - THE CONTROL MUST NOT BE IN MAZATROL MODE',
  },

  siemens: {
    id: 'siemens',
    label: 'Siemens 840D (ISO mode)',
    tapeMarks: false,
    commentStyle: 'semicolon',
    programDigits: null,
    toolChanges: true,
    toolLengthComp: true,
    workOffset: true,
    coolant: true,
    rotary: true,
    programEnd: 'M30',
    millSafeStart: ['G71 G17 G40 G90'],
    turnSafeStart: ['G71 G18 G40 G95'],
    millHome: ['SUPA G0 Z0'],
    turnHome: ['SUPA G0 X0 Z0'],
    caveat: 'ISO-MODE OUTPUT - NOT SHOPMILL/SHOPTURN CYCLES',
  },

  okuma: {
    id: 'okuma',
    label: 'Okuma (OSP-P300)',
    tapeMarks: false,
    commentStyle: 'paren',
    programDigits: 4,
    toolChanges: true,
    toolLengthComp: true,
    workOffset: true,
    coolant: true,
    rotary: true,
    programEnd: 'M02',
    millSafeStart: ['G20 G17 G40 G90'],
    turnSafeStart: ['G20 G18 G40 G95'],
    millHome: ['G00 Z0 M05'],
    turnHome: ['G00 X0 Z0'],
    caveat: 'OSP DIFFERS FROM FANUC ON ZERO OFFSETS - CHECK G15/H BEFORE RUNNING',
  },

  grbl: {
    id: 'grbl',
    label: 'GRBL / Mach3 router',
    tapeMarks: false,
    commentStyle: 'paren',
    programDigits: null,
    // No changer, no offset table, no tool-length compensation to cancel.
    toolChanges: false,
    toolLengthComp: false,
    workOffset: false,
    coolant: false,
    rotary: false,
    programEnd: 'M30',
    millSafeStart: ['G21 G17 G40 G90'],
    turnSafeStart: ['G21 G18 G40 G90'],
    millHome: [],
    turnHome: [],
    caveat: 'SINGLE TOOL ASSUMED - CHANGE AND RE-ZERO BETWEEN OPERATIONS',
  },
};

export const DEFAULT_DIALECT = 'fanuc';

/** Look a dialect up by controller key, falling back to Fanuc rather than throwing. */
export function dialectFor(controller) {
  return DIALECTS[controller] || DIALECTS[DEFAULT_DIALECT];
}

/** Every dialect, for a `<Select>`. */
export const DIALECT_LIST = Object.values(DIALECTS);

/**
 * The program number as this control writes it.
 *
 * Returns null when the dialect has no O-number at all, which is the case for
 * Siemens ISO and for GRBL — emitting `O0001` there is at best noise and at
 * worst a syntax error.
 */
export function programHeader(dialect, number, name) {
  const clean = String(name || 'PART').toUpperCase().replace(/[()]/g, '');
  if (dialect.programDigits == null) return null;
  return `O${String(number).padStart(dialect.programDigits, '0')} (${clean})`;
}
