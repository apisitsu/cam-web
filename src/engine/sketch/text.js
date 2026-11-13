/**
 * Text for engraving: a single-stroke font drawn as ordinary sketch lines.
 *
 * Part and lot numbers are engraved with a V-cutter or a small endmill that runs
 * ALONG each stroke, so the letters are centre lines, not outlines — the kind of
 * font an engraving machine uses. Outline fonts (TrueType) would be cut round
 * twice and need a cutter far smaller than the letter. So the glyphs here are
 * hand-drawn on a 4 × 6 grid: upper-case letters, digits (with a slashed zero,
 * so it cannot be read as O) and the marks that appear in part numbers.
 * Lower-case is written as upper-case.
 *
 * Each letter becomes plain lines in the sketch: they can be moved, deleted,
 * dimensioned or engraved like anything drawn by hand. Pure: the sketch
 * document only.
 */
import { addPoint, addLine } from './model.js';

/** Glyph cell: 4 wide, 6 tall (the cap height); letters are spaced 1.5 apart. */
export const GLYPH_W = 4;
export const GLYPH_H = 6;
const SPACING = 1.5;

const RING = [[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]];
const BOWL_P = [[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]];
const dot = (x, y) => [[x - 0.25, y], [x + 0.25, y], [x + 0.25, y + 0.5], [x - 0.25, y + 0.5], [x - 0.25, y]];

/** Strokes per character, each a polyline of [x, y] on the glyph grid. */
export const GLYPHS = {
  0: [RING, [[0.8, 1], [3.2, 5]]],
  1: [[[1, 5], [2, 6], [2, 0]], [[1, 0], [3, 0]]],
  2: [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [0, 0], [4, 0]]],
  3: [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1.5, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  4: [[[3, 0], [3, 6], [0, 2], [4, 2]]],
  5: [[[4, 6], [0, 6], [0, 3.5], [3, 3.5], [4, 2.5], [4, 1], [3, 0], [1, 0], [0, 1]]],
  6: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2.5], [3, 3.5], [1, 3.5], [0, 2.5]]],
  7: [[[0, 6], [4, 6], [1.5, 0]]],
  8: [[[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
  9: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 3.5], [1, 2.5], [3, 2.5], [4, 3.5]]],
  A: [[[0, 0], [0, 4], [2, 6], [4, 4], [4, 0]], [[0, 2.5], [4, 2.5]]],
  B: [BOWL_P, [[3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  C: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1]]],
  D: [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
  E: [[[4, 6], [0, 6], [0, 0], [4, 0]], [[0, 3], [3, 3]]],
  F: [[[4, 6], [0, 6], [0, 0]], [[0, 3], [3, 3]]],
  G: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 3], [2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[1, 6], [3, 6]], [[2, 6], [2, 0]], [[1, 0], [3, 0]]],
  J: [[[1, 6], [4, 6]], [[3, 6], [3, 1], [2, 0], [1, 0], [0, 1]]],
  K: [[[0, 0], [0, 6]], [[4, 6], [0, 2]], [[1.3, 3.3], [4, 0]]],
  L: [[[0, 6], [0, 0], [4, 0]]],
  M: [[[0, 0], [0, 6], [2, 3], [4, 6], [4, 0]]],
  N: [[[0, 0], [0, 6], [4, 0], [4, 6]]],
  O: [RING],
  P: [BOWL_P],
  Q: [RING, [[2.5, 1.5], [4, 0]]],
  R: [BOWL_P, [[2, 3], [4, 0]]],
  S: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  T: [[[0, 6], [4, 6]], [[2, 6], [2, 0]]],
  U: [[[0, 6], [0, 1], [1, 0], [3, 0], [4, 1], [4, 6]]],
  V: [[[0, 6], [2, 0], [4, 6]]],
  W: [[[0, 6], [1, 0], [2, 4], [3, 0], [4, 6]]],
  X: [[[0, 0], [4, 6]], [[0, 6], [4, 0]]],
  Y: [[[0, 6], [2, 3], [4, 6]], [[2, 3], [2, 0]]],
  Z: [[[0, 6], [4, 6], [0, 0], [4, 0]]],
  '-': [[[0.5, 3], [3.5, 3]]],
  _: [[[0, -0.5], [4, -0.5]]],
  '.': [dot(2, 0)],
  ',': [[[2, 0.5], [2, 0], [1.5, -0.8]]],
  ':': [dot(2, 1), dot(2, 4)],
  '/': [[[0, 0], [4, 6]]],
  '#': [[[1.2, 0], [1.8, 6]], [[2.8, 0], [3.4, 6]], [[0, 2], [4, 2]], [[0, 4], [4, 4]]],
  '+': [[[2, 1], [2, 5]], [[0, 3], [4, 3]]],
  '=': [[[0.5, 2], [3.5, 2]], [[0.5, 4], [3.5, 4]]],
  '(': [[[3, 6], [2, 5], [2, 1], [3, 0]]],
  ')': [[[1, 6], [2, 5], [2, 1], [1, 0]]],
  ' ': [],
};

/** Characters the font cannot draw, so the caller can say which. */
export function unsupportedChars(text) {
  return [...new Set([...String(text).toUpperCase()].filter((c) => !(c in GLYPHS)))];
}

/** How long a line of text is, in mm, at a cap height of `height`. */
export function textWidth(text, height) {
  const n = String(text).length;
  if (!n) return 0;
  return ((n * (GLYPH_W + SPACING) - SPACING) * height) / GLYPH_H;
}

/**
 * The strokes of a line of text in sketch coordinates: bottom-left of the first
 * letter at (x, y), letters `height` tall, the baseline turned `angle` degrees.
 *
 * @returns {number[][][]} polylines of [x, y]
 */
export function textStrokes(text, {
  x = 0, y = 0, height = 5, angle = 0,
} = {}) {
  const k = height / GLYPH_H;
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const out = [];
  [...String(text).toUpperCase()].forEach((ch, i) => {
    const ox = i * (GLYPH_W + SPACING);
    for (const stroke of GLYPHS[ch] || []) {
      out.push(stroke.map(([gx, gy]) => {
        const lx = (ox + gx) * k;
        const ly = gy * k;
        return [x + lx * c - ly * s, y + lx * s + ly * c];
      }));
    }
  });
  return out;
}

/**
 * Put a line of text into a sketch as lines.
 *
 * @returns {number[]} the ids of the lines added
 */
export function buildText(sk, text, opts) {
  const ids = [];
  for (const stroke of textStrokes(text, opts)) {
    let prev = null;
    let first = null;
    stroke.forEach(([px, py], i) => {
      const closing = i === stroke.length - 1 && i > 1
        && Math.hypot(px - stroke[0][0], py - stroke[0][1]) < 1e-9;
      const p = closing ? first : addPoint(sk, px, py);
      if (i === 0) first = p;
      if (prev != null && p !== prev) ids.push(addLine(sk, prev, p));
      prev = p;
    });
  }
  return ids;
}
