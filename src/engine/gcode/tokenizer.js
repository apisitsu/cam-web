/**
 * G-code tokenizer.
 *
 * Turns one physical line of G-code into an ordered list of address words
 * ({ letter, value }). Comments and line numbers are stripped here so the
 * interpreter never has to think about them.
 *
 * Supported comment styles:
 *   ( inline paren comment )   — RS-274 standard, may appear mid-line
 *   ; trailing comment         — common on LinuxCNC / hobby controllers
 */

/** Remove `( ... )` and `; ...` comments from a single line. */
export function stripComments(line) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '(') {
      depth++;
      continue;
    }
    if (c === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth > 0) continue;
    if (c === ';') break; // rest of line is a comment
    out += c;
  }
  return out;
}

// One address word: a letter followed by a signed decimal number.
const WORD_RE = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;

/**
 * Tokenize a single line into address words.
 * The leading block-number word (N123) is dropped — it carries no motion.
 * @returns {{letter: string, value: number}[]}
 */
export function tokenizeLine(line) {
  const clean = stripComments(line).trim();
  if (!clean) return [];

  const tokens = [];
  let m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(clean)) !== null) {
    const letter = m[1].toUpperCase();
    if (letter === 'N') continue; // block number, not a motion word
    tokens.push({ letter, value: parseFloat(m[2]) });
  }
  return tokens;
}
