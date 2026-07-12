/**
 * Dependency-free validation of the G-code engine using Node's built-in test
 * runner. Lets us prove Phase 0 correctness before the UI toolchain (vite/
 * three) is installable through the corporate proxy.
 *
 * Run:  node --test src/engine/gcode/_node_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeLine, stripComments } from './tokenizer.js';
import { tessellateArc } from './arc.js';
import { interpret } from './interpreter.js';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const XY = [0, 1, 2];

test('tokenizer strips comments and drops N word', () => {
  assert.equal(stripComments('G1 X10 (rapid) Y20 ; done').trim(), 'G1 X10  Y20');
  assert.deepEqual(tokenizeLine('N5 G1 X-1.5 Y.5 Z2.'), [
    { letter: 'G', value: 1 },
    { letter: 'X', value: -1.5 },
    { letter: 'Y', value: 0.5 },
    { letter: 'Z', value: 2 },
  ]);
  assert.deepEqual(tokenizeLine('( header only )'), []);
});

test('CCW quarter arc (I/J) stays on unit circle, centre at origin', () => {
  const { points } = tessellateArc([1, 0, 0], [0, 1, 0], { i: -1, j: 0 }, XY, false);
  for (const p of points) assert.ok(near(Math.hypot(p[0], p[1]), 1));
  const last = points[points.length - 1];
  assert.ok(near(last[0], 0) && near(last[1], 1));
});

test('radius-form minor arc matches I/J centre', () => {
  const pts = tessellateArc([1, 0, 0], [0, 1, 0], { r: 1 }, XY, false).points;
  for (const p of pts) assert.ok(near(Math.hypot(p[0], p[1]), 1));
});

test('CW radius arc picks the correct (opposite) centre', () => {
  // G2 (1,0)->(0,1) R1 minor arc -> centre (1,1)
  const pts = tessellateArc([1, 0, 0], [0, 1, 0], { r: 1 }, XY, true).points;
  for (const p of pts) assert.ok(near(Math.hypot(p[0] - 1, p[1] - 1), 1));
});

test('full circle returns to start with helical Z ignored', () => {
  const { points } = tessellateArc([1, 0, 0], [1, 0, 0], { i: -1, j: 0 }, XY, false);
  const last = points[points.length - 1];
  assert.ok(near(last[0], 1) && near(last[1], 0));
  assert.ok(points.length > 16);
});

test('linear feed vs rapid classification and lengths', () => {
  const { stats } = interpret('G21 G90\nG0 X0 Y0\nG1 X10 F100\nG1 Y10');
  assert.ok(near(stats.rapidLength, 0));
  assert.ok(near(stats.feedLength, 20));
});

test('incremental G91 accumulates', () => {
  const { bounds } = interpret('G21 G91\nG1 X10 F100\nG1 X10\nG1 X10');
  assert.ok(near(bounds.max[0], 30));
});

test('inch mode G20 scales to mm', () => {
  const { bounds } = interpret('G20 G90\nG1 X1 F10');
  assert.ok(near(bounds.max[0], 25.4));
});

test('modal motion repeats on bare coordinate blocks', () => {
  const { stats } = interpret('G21 G90 G1 F100\nX10\nX20');
  assert.ok(near(stats.feedLength, 20));
});

test('G81 canned cycle: two holes to Z-6, 8mm cut each', () => {
  const prog = ['G21 G90 G0 Z5', 'G81 X10 Y10 Z-6 R2 F100', 'X25 Y20', 'G80'].join('\n');
  const { stats, bounds } = interpret(prog);
  assert.ok(near(bounds.min[2], -6));
  assert.ok(near(stats.feedLength, 16));
});

test('G71 turning cycle recognised but warned (Phase 0)', () => {
  const { stats } = interpret('G21 G90\nG71 P10 Q20 U0.5 W0.1 D2 F150');
  assert.ok(stats.warnings.some((w) => w.includes('G71')));
});

test('sample-like program parses without throwing and produces geometry', () => {
  const prog = [
    'G21 G90 G17',
    'G0 Z5',
    'G1 Z-2 F150',
    'G1 X50 F400',
    'G2 X40 Y40 I-10 J0',
    'G3 X0 Y30 I0 J-10',
  ].join('\n');
  const { stats } = interpret(prog);
  assert.ok(stats.feedLength > 0);
  assert.ok(stats.blocks > 5);
});
