/**
 * Fanuc Macro-B preprocessor.
 *
 * NAME: the trailing `s` is not a typo and must stay. CRA's babel preset always
 * loads `babel-plugin-macros`, which claims every import matching
 * `/[./]macro(\.c?js)?$/` as a *babel* macro and fails the build demanding
 * `createMacro()`. Nothing about this file is a babel macro — it is Fanuc's.
 * (It was `macro.js` in the cam-web original this came from.)
 *
 * Real shop programs are rarely a flat list of coordinates. They carry
 * variables (`#502=28.85`), arithmetic (`#13=[#12/2]`), functions (`FUP`,
 * `ABS`), and control flow (`WHILE[#6GE#3]DO1 … END1`). The motion interpreter
 * downstream understands none of that: its tokenizer wants a number after every
 * address letter, so `X#16` simply vanishes.
 *
 * expandProgram() runs the macro layer to completion and hands back a flat list
 * of literal blocks — loops unrolled, every expression evaluated. Each block
 * remembers the source line it came from, so a toolpath segment can still be
 * traced back to the line the operator sees in the editor.
 *
 * A program with no `#` / WHILE / GOTO passes through untouched.
 */
import { stripComments } from './tokenizer.js';

const DEG = Math.PI / 180;

// Fanuc rounds away from zero: FIX truncates toward zero, FUP raises the
// magnitude, ROUND takes .5 away from zero (not JS's toward +Infinity).
const FUNCS = {
  SIN: (x) => Math.sin(x * DEG),
  COS: (x) => Math.cos(x * DEG),
  TAN: (x) => Math.tan(x * DEG),
  ASIN: (x) => Math.asin(x) / DEG,
  ACOS: (x) => Math.acos(x) / DEG,
  ATAN: (x) => Math.atan(x) / DEG,
  SQRT: Math.sqrt,
  ABS: Math.abs,
  LN: Math.log,
  EXP: Math.exp,
  FIX: Math.trunc,
  FUP: (x) => Math.sign(x) * Math.ceil(Math.abs(x)),
  ROUND: (x) => Math.sign(x) * Math.round(Math.abs(x)),
  // BCD/BIN convert between packed decimal and binary. Rare on a machining
  // program and trivial to support, and a program that uses one failed to open
  // at all rather than failing to use it.
  BCD: (x) => Number(String(Math.trunc(Math.abs(x))).split('').reduce((a, d) => a * 16 + Number(d), 0)),
  BIN: (x) => Number(Math.trunc(Math.abs(x)).toString(16)),
};
const FUNC_RE = new RegExp(`^(${Object.keys(FUNCS).join('|')})\\s*\\[`, 'i');

const COMPARISONS = {
  EQ: (a, b) => a === b,
  NE: (a, b) => a !== b,
  GT: (a, b) => a > b,
  GE: (a, b) => a >= b,
  LT: (a, b) => a < b,
  LE: (a, b) => a <= b,
};

// A runaway WHILE would otherwise expand until the heap dies.
const MAX_BLOCKS_EXECUTED = 2_000_000;
const MAX_BLOCKS_EMITTED = 400_000;

/** Format an evaluated value as a G-code number the tokenizer can read back. */
function num(v) {
  if (!isFinite(v)) return '0';
  const r = Math.abs(v) < 1e-9 ? 0 : v;
  // Six decimals is well past machine resolution and never goes exponential.
  return String(Number(r.toFixed(6)));
}

/**
 * Recursive-descent evaluator over one line, sharing a cursor so callers can
 * keep reading the rest of the block after an expression ends.
 */
function makeParser(text, vars, warn) {
  let i = 0;
  const skip = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const peek = () => { skip(); return text[i]; };
  const eat = (ch) => {
    skip();
    if (text[i] !== ch) throw new Error(`expected '${ch}' at column ${i + 1}`);
    i++;
  };

  const readVar = () => {
    eat('#');
    skip();
    let n;
    if (text[i] === '[') n = Math.round(bracket());
    else if (text[i] === '#') n = Math.round(readVar()); // #[#100] style indirection
    else {
      const m = /^\d+/.exec(text.slice(i));
      if (!m) throw new Error(`malformed variable reference at column ${i + 1}`);
      i += m[0].length;
      n = Number(m[0]);
    }
    const v = vars.get(n);
    if (v === undefined) {
      warn(`#${n} is read before it is assigned — treated as 0`);
      return 0;
    }
    return v;
  };

  const bracket = () => {
    eat('[');
    const v = expr();
    eat(']');
    return v;
  };

  const factor = () => {
    skip();
    const c = text[i];
    if (c === '-') { i++; return -factor(); }
    if (c === '+') { i++; return factor(); }
    if (c === '[') return bracket();
    if (c === '#') return readVar();

    const fn = FUNC_RE.exec(text.slice(i));
    if (fn) {
      i += fn[1].length;
      return FUNCS[fn[1].toUpperCase()](bracket());
    }
    const m = /^(?:\d+\.?\d*|\.\d+)/.exec(text.slice(i));
    if (!m) throw new Error(`expected a value at column ${i + 1}`);
    i += m[0].length;
    return Number(m[0]);
  };

  // An operator lookahead must not commit the whitespace it skipped: an
  // expression that ends at `N100 G1` has to leave the space for the caller,
  // which is copying the block through verbatim.
  const term = () => {
    let v = factor();
    for (;;) {
      const save = i;
      skip();
      const c = text[i];
      if (c === '*') { i++; v *= factor(); }
      else if (c === '/') { i++; const d = factor(); v = d === 0 ? 0 : v / d; }
      else if (/^MOD\b/i.test(text.slice(i))) {
        // Fanuc spells the remainder `MOD`, at the same precedence as `*` and
        // `/`. Without it `[27 MOD 4]` stopped at the M and read as a missing
        // bracket, which said nothing about the real problem.
        i += 3;
        const d = factor();
        v = d === 0 ? 0 : v % d;
      } else { i = save; return v; }
    }
  };

  const expr = () => {
    let v = term();
    for (;;) {
      const save = i;
      skip();
      const c = text[i];
      // Any +/- here is binary: an address word always starts with a letter, so
      // a sign can never belong to what follows.
      if (c === '+') { i++; v += term(); }
      else if (c === '-') { i++; v -= term(); }
      else { i = save; return v; }
    }
  };

  /** One `expr OP expr`, e.g. `#6GE[#3-0.001]`. */
  const comparison = () => {
    const left = expr();
    skip();
    const m = /^(EQ|NE|GT|GE|LT|LE)/i.exec(text.slice(i));
    if (!m) throw new Error(`expected a comparison operator at column ${i + 1}`);
    i += m[1].length;
    const right = expr();
    return COMPARISONS[m[1].toUpperCase()](left, right);
  };

  /**
   * A whole condition: comparisons joined by `AND` / `OR` / `XOR`.
   *
   * Fanuc allows them and programs use them; the parser stopped at the first
   * one and reported a missing comparison operator, so `IF [#1 EQ 1 AND #2 EQ
   * 2]` could not be opened at all. Left-associative and un-precedenced, which
   * is what the control does — brackets are how you say otherwise, and every
   * real program brackets them anyway.
   */
  const condition = () => {
    let v = comparison();
    for (;;) {
      const save = i;
      skip();
      const m = /^(AND|OR|XOR)\b/i.exec(text.slice(i));
      if (!m) { i = save; return v; }
      i += m[1].length;
      const right = comparison();
      const op = m[1].toUpperCase();
      if (op === 'AND') v = Boolean(v) && Boolean(right);
      else if (op === 'OR') v = Boolean(v) || Boolean(right);
      else v = Boolean(v) !== Boolean(right);
    }
  };

  return {
    expr,
    bracket,
    condition,
    get pos() { return i; },
    set pos(v) { i = v; },
    peek,
    rest: () => text.slice(i),
  };
}

/**
 * Rewrite one motion block, replacing every `#var` / `[expr]` value with the
 * number it evaluates to. `G1X[#21-#9]Y-#14F1000.` → `G1X-3.7Y-5.2F1000.`
 */
function substitute(clean, vars, warn) {
  const p = makeParser(clean, vars, warn);
  let out = '';
  let i = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (/\s/.test(c)) { out += c; i++; continue; }
    if (!/[A-Za-z]/.test(c)) { out += c; i++; continue; }
    // An address letter: everything up to the next letter is its value.
    out += c;
    p.pos = i + 1;
    const value = p.expr();
    out += num(value);
    i = p.pos;
  }
  return out;
}

/**
 * The block number a `GOTO` names.
 *
 * Fanuc allows an expression, and `GOTO #100` is how a program picks a branch
 * at run time. Only a literal was read, so those failed to open — the parser
 * fell through to treating `GOTO` as address words and asked for a value after
 * the `G`.
 */
function gotoTarget(tail, vars, warn) {
  const literal = /^(\d+)\s*$/.exec(tail);
  if (literal) return Number(literal[1]);
  const p = makeParser(tail, vars, warn);
  const n = p.expr();
  if (!Number.isFinite(n)) throw new Error('GOTO needs a block number');
  return Math.round(n);
}

/**
 * @param {string} text raw program
 * @param {(msg:string)=>void} [warn]
 * @returns {{text:string, line:number}[]} literal blocks, loops unrolled
 */
export function expandProgram(text, warn = () => {}) {
  const raw = text.split(/\r?\n/);
  /**
   * Fanuc's **block delete**: a leading `/`, or `/1`…`/9`, means "skip this
   * block when the matching switch is on". The switch is off unless the
   * operator turns it on, so the block runs — which is what the motion
   * interpreter already does with these, and this has to agree with it.
   *
   * It matters here because the prefix hid the *control* words behind it.
   * `/IF[#532EQ1]GOTO9999` did not match `^IF`, fell through to being read as
   * address words, and asked for a value after the `I` — the reported
   * "expected a value at column 3", exactly. A motion block was unaffected:
   * `/G59` copies the slash through and reads `G59` as normal, which is why
   * only files with a *conditional* behind a slash ever failed.
   */
  const BLOCK_DELETE = /^\/[1-9]?\s*/;
  const lines = raw.map((s, idx) => {
    const clean = stripComments(s).trim();
    return {
      raw: s, clean, code: clean.replace(BLOCK_DELETE, ''), line: idx + 1,
    };
  });

  // Nothing to do for a plain coordinate program — and no risk of mangling it.
  if (!lines.some((l) => /#|\bWHILE\b|\bGOTO\b|\bIF\b|^END\s*\d/i.test(l.clean))) {
    return lines.map((l) => ({ text: l.raw, line: l.line }));
  }

  const seen = new Set();
  const warnOnce = (msg) => { if (!seen.has(msg)) { seen.add(msg); warn(msg); } };

  const WHILE_RE = /^WHILE\s*\[/i;
  const END_RE = /^END\s*(\d+)\s*$/i;
  const DO_RE = /DO\s*(\d+)\s*$/i;

  // Pair every `WHILE…DOn` with its `ENDn` up front. Matching by nesting (not
  // by scanning forward for the number) is what lets DO1 contain DO2.
  const endOf = new Map();
  const whileOf = new Map();
  const labels = new Map();
  const open = [];
  for (let i = 0; i < lines.length; i++) {
    const { code } = lines[i];
    if (!code) continue;
    const label = /^N\s*(\d+)/i.exec(code);
    if (label && !labels.has(Number(label[1]))) labels.set(Number(label[1]), i);
    if (WHILE_RE.test(code)) {
      const d = DO_RE.exec(code);
      if (!d) throw new Error(`Line ${lines[i].line}: WHILE without a DO number`);
      open.push({ n: Number(d[1]), i });
    } else {
      const e = END_RE.exec(code);
      if (!e) continue;
      const top = open.pop();
      if (!top || top.n !== Number(e[1])) {
        throw new Error(`Line ${lines[i].line}: END${e[1]} does not close a matching DO${e[1]}`);
      }
      endOf.set(top.i, i);
      whileOf.set(i, top.i);
    }
  }
  if (open.length) {
    throw new Error(`Line ${lines[open[0].i].line}: DO${open[0].n} is never closed by END${open[0].n}`);
  }

  const vars = new Map();
  const out = [];
  let pc = 0;
  let executed = 0;

  while (pc < lines.length) {
    if (++executed > MAX_BLOCKS_EXECUTED) {
      throw new Error('Macro expansion ran away — check the WHILE conditions for a loop that never ends');
    }
    const {
      raw: rawText, clean, code, line,
    } = lines[pc];
    if (!code) { pc++; continue; }

    /**
     * Wrap a parse failure with **the block it happened in**, and point at it.
     *
     * "Line 338: expected a value at column 3" is unactionable on its own — the
     * operator cannot see column 3 of a line they are not looking at, and
     * neither can anyone they report it to. The text and a caret cost nothing
     * and turn the message into the answer.
     */
    const fail = (err) => {
      const col = /column (\d+)/.exec(err.message);
      const parts = [`Line ${line}: ${err.message}`, `  ${clean}`];
      if (col) parts.push(`  ${' '.repeat(Math.max(0, Number(col[1]) - 1))}^`);
      return new Error(parts.join('\n'));
    };

    // ---- WHILE [cond] DOn ----
    if (WHILE_RE.test(code)) {
      let hold;
      try {
        const p = makeParser(code, vars, warnOnce);
        p.pos = code.search(/\[/);
        p.pos += 1;              // step inside WHILE's own bracket
        hold = p.condition();
      } catch (err) { throw fail(err); }
      pc = hold ? pc + 1 : endOf.get(pc) + 1;
      continue;
    }

    // ---- ENDn: jump back and re-test ----
    if (END_RE.test(code)) { pc = whileOf.get(pc); continue; }

    // ---- IF [cond] GOTOn | IF [cond] THEN #x=expr ----
    const ifm = /^IF\s*\[/i.exec(code);
    if (ifm) {
      try {
        const p = makeParser(code, vars, warnOnce);
        p.pos = code.search(/\[/) + 1;
        const hold = p.condition();
        const tail = p.rest().replace(/^\s*\]/, '').trim();
        if (hold) {
          const goto = /^GOTO\s*(.+)$/i.exec(tail);
          const then = /^THEN\s*(#.*)$/i.exec(tail);
          if (goto) { pc = jump(labels, gotoTarget(goto[1], vars, warnOnce), line); continue; }
          if (then) { assign(then[1], vars, warnOnce); pc++; continue; }
          throw new Error('IF must be followed by GOTO or THEN');
        }
      } catch (err) { throw fail(err); }
      pc++;
      continue;
    }

    // ---- GOTOn ----
    const gotom = /^GOTO\s*(.+)$/i.exec(code);
    if (gotom) {
      try { pc = jump(labels, gotoTarget(gotom[1], vars, warnOnce), line); } catch (err) { throw fail(err); }
      continue;
    }

    // ---- #var = expr ----
    if (code.startsWith('#')) {
      try { assign(code, vars, warnOnce); } catch (err) { throw fail(err); }
      pc++;
      continue;
    }

    // ---- an ordinary motion block ----
    if (out.length >= MAX_BLOCKS_EMITTED) {
      throw new Error(`Macro expansion produced over ${MAX_BLOCKS_EMITTED} blocks — the program is too large to simulate`);
    }
    if (/#|\[/.test(clean)) {
      try { out.push({ text: substitute(clean, vars, warnOnce), line }); }
      catch (err) { throw fail(err); }
    } else {
      out.push({ text: rawText, line });
    }
    pc++;
  }

  return out;
}

function jump(labels, n, line) {
  const target = labels.get(n);
  if (target === undefined) throw new Error(`Line ${line}: GOTO ${n} has no matching N${n}`);
  return target;
}

/** `#502=28.85`, `#6=#6-#4`, `#5=FUP[[#1-#3]/#4]`, `#[#100]=1` */
function assign(clean, vars, warn) {
  const eq = splitAssignment(clean);
  if (!eq) throw new Error('malformed macro assignment');
  const [lhs, rhs] = eq;

  let target;
  const inner = lhs.slice(1).trim();
  if (inner.startsWith('[')) {
    target = Math.round(makeParser(inner, vars, warn).bracket());
  } else {
    const m = /^\d+$/.exec(inner);
    if (!m) throw new Error('malformed macro assignment target');
    target = Number(m[0]);
  }

  const value = makeParser(rhs, vars, warn).expr();
  vars.set(target, value);
}

/** Split on the top-level `=` so `#[#1+1]=2` doesn't split inside the brackets. */
function splitAssignment(clean) {
  let depth = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '[') depth++;
    else if (clean[i] === ']') depth--;
    else if (clean[i] === '=' && depth === 0) {
      return [clean.slice(0, i).trim(), clean.slice(i + 1).trim()];
    }
  }
  return null;
}
