/**
 * Dependency-free validation of the playback additions:
 * ordered path (buildPath/sliceUpTo/feedsBefore) and the stateful sim session.
 * Run:  node --test src/engine/playback_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from './gcode/interpreter.js';
import { buildPath, sliceUpTo, feedsBefore, lineAt, rotaryAt, timeAt, segmentAtTime, toolPointAt } from './gcode/path.js';
import { createSession, carveTo } from './sim/session.js';

const PROG = ['G21 G90 G0 Z5', 'G0 X0 Y0', 'G1 Z-2 F100', 'G1 X30', 'G1 Y10', 'G0 Z10'].join('\n');

test('buildPath preserves order, types and feed prefix', () => {
  const { segments } = interpret(PROG);
  const path = buildPath(segments);
  assert.equal(path.count, segments.length);
  // types: 0 rapid / 1 feed, matching segment order
  segments.forEach((s, i) => assert.equal(path.types[i], s.type === 'rapid' ? 0 : 1));
  // feedPrefix is monotonic non-decreasing and ends at total feed count
  const totalFeeds = segments.filter((s) => s.type !== 'rapid').length;
  assert.equal(path.feedPrefix[path.count - 1], totalFeeds);
  for (let i = 1; i < path.count; i++) assert.ok(path.feedPrefix[i] >= path.feedPrefix[i - 1]);
});

test('sliceUpTo reveals k segments and reports the tool tip', () => {
  const { segments } = interpret(PROG);
  const path = buildPath(segments);
  // Nothing shown at k=0, no tool.
  const s0 = sliceUpTo(path, 0);
  assert.equal(s0.rapids.length, 0);
  assert.equal(s0.feeds.length, 0);
  assert.equal(s0.tool, null);
  // Full path at k=count: rapid+feed vertex counts add up to all segments.
  const sAll = sliceUpTo(path, path.count);
  const shownSegs = sAll.rapids.length / 6 + sAll.feeds.length / 6;
  assert.equal(shownSegs, path.count);
  // Tool tip equals the very last segment's end point.
  const o = (path.count - 1) * 6;
  assert.deepEqual(sAll.tool, [
    path.positions[o + 3], path.positions[o + 4], path.positions[o + 5],
  ]);
});

test('feedsBefore maps an all-segment playhead to feed count', () => {
  const { segments } = interpret(PROG);
  const path = buildPath(segments);
  assert.equal(feedsBefore(path, 0), 0);
  assert.equal(feedsBefore(path, path.count), path.feedPrefix[path.count - 1]);
});

test('lineAt maps playhead to the source line, monotonic and in range', () => {
  const { segments } = interpret(PROG);
  const path = buildPath(segments);
  assert.equal(lineAt(path, 0), 0); // nothing executed yet
  const nLines = PROG.split('\n').length;
  let prev = 0;
  for (let k = 1; k <= path.count; k++) {
    const ln = lineAt(path, k);
    assert.ok(ln >= 1 && ln <= nLines, `line ${ln} out of range at k=${k}`);
    assert.ok(ln >= prev, 'source line should not go backwards for sequential moves');
    prev = ln;
  }
  // Last segment maps to the last motion line (the final G0 Z10).
  assert.equal(lineAt(path, path.count), 6);
});

test('rotary index follows the A/B word so the tool can tilt onto the face', () => {
  // A0 cut, then index A90 and cut, then B90 and cut.
  const prog = [
    'G21 G90 G0 X0 Y0 Z0',
    'G1 X10 F500',   // A0 B0
    'A90', 'G1 Y10',  // machine +Y under A90 -> part frame -Z
    'B90', 'G1 X-10', // B added on top of A
  ].join('\n');
  const { segments } = interpret(prog);
  const path = buildPath(segments);

  // Nothing indexed at the very start.
  assert.deepEqual(rotaryAt(path, 0), { a: 0, b: 0 });
  // The first cut is at A0/B0.
  assert.deepEqual(rotaryAt(path, 1), { a: 0, b: 0 });
  // The last cut carries both indices.
  assert.deepEqual(rotaryAt(path, path.count), { a: 90, b: 90 });

  // The A90 cut of a machine +Y move must land along -Z in the part frame —
  // proof toPartFrame actually rotated the geometry the tool marker tilts to.
  const a90feed = segments.find((s) => s.a4 === 90 && s.b4 === 0 && s.type === 'feed');
  assert.ok(a90feed, 'expected a feed segment machined at A90');
  assert.ok(Math.abs(a90feed.b[2] - -10) < 1e-6, `A90 +Y cut should reach Z-10, got ${a90feed.b[2]}`);
  assert.ok(Math.abs(a90feed.b[1]) < 1e-6, 'A90 +Y cut should leave Y at 0 in the part frame');
});

test('segmentAtTime inverts timeAt so playback can pace by machine time', () => {
  const { segments } = interpret(PROG);
  const path = buildPath(segments);
  assert.equal(segmentAtTime(path, 0), 0);
  assert.equal(segmentAtTime(path, -5), 0);
  assert.equal(segmentAtTime(path, path.totalTime + 100), path.count); // past the end
  // Round-trip: the time at playhead k lands back on k (monotonic, so the first
  // segment reaching that time).
  for (let k = 1; k <= path.count; k++) {
    const t = timeAt(path, k);
    const k2 = segmentAtTime(path, t);
    assert.ok(k2 <= k && timeAt(path, k2) === t, `k=${k} t=${t} -> ${k2}`);
  }
  // Advancing time monotonically never moves the playhead backwards.
  let prev = 0;
  for (let t = 0; t <= path.totalTime; t += path.totalTime / 20) {
    const k = segmentAtTime(path, t);
    assert.ok(k >= prev, 'playhead must not go backwards as time advances');
    prev = k;
  }
});

test('toolPointAt interpolates within a segment for a smooth marker', () => {
  const { segments } = interpret(PROG);
  const path = buildPath(segments);
  // Pick the long X0->X30 cut; sample its start, middle and end by time.
  const iCut = segments.findIndex((s) => s.b[0] === 30 && s.a[0] === 0);
  const t0 = iCut > 0 ? path.timePrefix[iCut - 1] : 0;
  const t1 = path.timePrefix[iCut];
  const mid = toolPointAt(path, (t0 + t1) / 2);
  // Halfway in time is roughly halfway along the 0..30 move — not pinned to an end.
  assert.ok(mid[0] > 5 && mid[0] < 25, `mid-move X should be interior, got ${mid[0]}`);
  const end = toolPointAt(path, t1);
  assert.ok(Math.abs(end[0] - 30) < 1e-6, `segment end lands at X30, got ${end[0]}`);
  // Past the program end clamps to the final tip.
  const fin = toolPointAt(path, path.totalTime + 5);
  const o = (path.count - 1) * 6;
  assert.deepEqual(fin, [path.positions[o + 3], path.positions[o + 4], path.positions[o + 5]]);
});

test('session carves forward incrementally to a stable final state', () => {
  const s = createSession(PROG, { radius: 2, cellSize: 0.5 });
  const full = carveTo(s, s.totalFeeds);
  assert.ok(full.removedVolume > 0);
  assert.equal(full.cursor, s.totalFeeds);

  // Re-carving to the same point from a fresh session gives identical volume.
  const s2 = createSession(PROG, { radius: 2, cellSize: 0.5 });
  // step one feed at a time — incremental path
  let last = 0;
  for (let k = 1; k <= s2.totalFeeds; k++) last = carveTo(s2, k).removedVolume;
  assert.ok(Math.abs(last - full.removedVolume) < 1e-6, `${last} vs ${full.removedVolume}`);
});

test('scrubbing backward resets and matches a direct carve', () => {
  const s = createSession(PROG, { radius: 2, cellSize: 0.5 });
  const half = Math.max(1, Math.floor(s.totalFeeds / 2));
  const forwardHalf = carveTo(s, half).removedVolume;
  carveTo(s, s.totalFeeds); // go to end
  const backHalf = carveTo(s, half).removedVolume; // scrub back
  assert.ok(Math.abs(backHalf - forwardHalf) < 1e-6, `${backHalf} vs ${forwardHalf}`);
});
