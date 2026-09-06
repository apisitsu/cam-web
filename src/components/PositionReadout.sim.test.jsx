/**
 * @vitest-environment jsdom
 *
 * The readout **while a program actually runs** — not a fixed prop, a real run.
 *
 * The other two suites cover the pieces: `engine/view/dro.test.js` the arithmetic,
 * `PositionReadout.test.jsx` the render gates with hand-written props. Neither
 * would catch the failure that matters most here — the panel being wired to the
 * wrong thing, so it renders beautifully and reads a number that has nothing to
 * do with where the tool is, or freezes while the playhead moves.
 *
 * So this drives the whole chain the app drives, in the same order App.jsx does:
 *
 *   interpret() → buildPath() → the playback clock → toolPointAt() → the DOM
 *
 * `readoutProps` below is deliberately a transcription of App.jsx's own memos. If
 * that wiring changes, this is where it should break.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import PositionReadout from './PositionReadout.jsx';
import { interpret } from '../engine/gcode/interpreter.js';
import {
  buildPath, toolPointAt, blockTargetAt, timeAt, segmentAtTime, rotaryAt,
  toolAt, lineAt, runningAt,
} from '../engine/gcode/path.js';
import { perTick } from '../engine/view/playback.js';

let container;
let root;

/** Parse and build exactly as the gcode worker does for the store. */
function load(program, opts = {}) {
  const { segments, stats } = interpret(program, opts);
  return { path: buildPath(segments), stats };
}

/**
 * What App.jsx hands the readout at a given machine time — a transcription of
 * its `toolPos` / `toolRotary` / `currentToolNum` / `activeLine` memos.
 *
 * The `playing` branch is App's, and it matters more than it looks: `playhead`
 * counts segments *entered*, so `segmentAtTime` returns `count` the moment the
 * final segment starts, and the app pauses right there. Riding the continuous
 * clock would then freeze the readout part-way through the last move. Paused, App
 * reads `timeAt(playhead)` — the segment boundary — which is what parks the
 * numbers on the programmed end point.
 */
function readoutProps(path, stats, playT, playing, view = {}) {
  const playhead = segmentAtTime(path, playT);
  const t = playing ? playT : timeAt(path, playhead);
  return {
    point: playhead > 0 ? toolPointAt(path, t) : null,
    target: playhead > 0 ? blockTargetAt(path, t) : null,
    rotary: playhead > 0 ? rotaryAt(path, playhead) : null,
    aIndices: stats?.aIndices ?? [0],
    toolNumber: toolAt(path, playhead),
    // The footer's own two memos: what the control is running at, and what the
    // tool in the spindle is. App builds the description from `effectiveTool`;
    // here the program's own comment is all there is, which is the case the
    // fallback exists for.
    running: runningAt(path, playhead),
    tool: { desc: stats?.tools?.find((x) => x.n === toolAt(path, playhead))?.desc ?? '' },
    line: lineAt(path, playhead),
    count: path.count,
    ...view,
  };
}

async function render(props) {
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => {
    root.render(React.createElement(PositionReadout, props));
  });
}

/** The value cell of an axis row, or null when the row is absent. */
function axisText(label) {
  const rows = [...container.querySelectorAll('[data-testid="position-readout"] > div')];
  const row = rows.find((r) => r.firstChild?.textContent?.startsWith(label));
  return row ? row.children[1].textContent : null;
}

/** A footer field by its data-dro name. */
function field(name) {
  return container.querySelector(`[data-dro="${name}"]`)?.textContent ?? null;
}

/** The distance-to-go cell of an axis row, as a number. */
function dtg(label) {
  const cell = container.querySelector(`[data-dtg="${label}"]`);
  return cell ? Number(cell.textContent) : null;
}

/**
 * Play the program from zero to the end at the real tick rate, sampling the
 * rendered readout each tick. Returns every frame's readout, so a test can ask
 * both "did it move?" and "where did it finish?".
 */
async function play(path, stats, view = {}, speed = 100) {
  const total = path.totalTime || 1;
  const frames = [];
  let t = 0;
  let playing = true;
  for (let i = 0; i < 5000; i++) {
    // The app's own guard: reaching the last segment pauses the run, which also
    // switches the readout onto the segment-boundary time (see readoutProps).
    if (segmentAtTime(path, t) >= path.count) playing = false;
    await render(readoutProps(path, stats, t, playing, view));
    frames.push({
      t,
      playing,
      X: axisText('X'), Y: axisText('Y'), Z: axisText('Z'), A: axisText('A'),
      line: lineAt(path, segmentAtTime(path, t)),
      dX: dtg('X'), dY: dtg('Y'), dZ: dtg('Z'),
      feed: field('feed'), spindle: field('spindle'), toolName: field('toolName'),
      text: container.textContent,
    });
    if (!playing) break;
    t += perTick(total, speed);
  }
  return frames;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const MILL = [
  'G21 G90 G17',
  'T3 M6',
  'G0 X0 Y0 Z10',
  'G1 Z-2 F200',
  'G1 X50 F400',
  'G1 Y25',
  'G0 Z10',
].join('\n');

describe('PositionReadout during a real milling run', () => {
  it('is on screen for the whole run, from parked to finished', async () => {
    const { path, stats } = load(MILL);
    const frames = await play(path, stats);
    expect(frames.length).toBeGreaterThan(5);
    // Never disappears mid-run — a readout that blinks out looks like a crash.
    expect(frames.every((f) => f.X !== null)).toBe(true);
  });

  it('actually counts — the numbers move as the playhead advances', async () => {
    const { path, stats } = load(MILL);
    const frames = await play(path, stats);
    const distinctX = new Set(frames.map((f) => f.X));
    const distinctZ = new Set(frames.map((f) => f.Z));
    // If the panel were wired to a constant, these would each be size 1.
    expect(distinctX.size).toBeGreaterThan(3);
    expect(distinctZ.size).toBeGreaterThan(1);
  });

  it('finishes on the programmed end point', async () => {
    const { path, stats } = load(MILL);
    const frames = await play(path, stats);
    const last = frames[frames.length - 1];
    // G1 X50 / G1 Y25 / G0 Z10 — the readout must post exactly that.
    expect(last.X).toBe('50.000');
    expect(last.Y).toBe('25.000');
    expect(last.Z).toBe('10.000');
  });

  it('agrees with the interpreter at every single tick', async () => {
    // The strongest form of "wired to the right thing": the readout is compared
    // against toolPointAt for the same time, independently recomputed.
    const { path, stats } = load(MILL);
    const total = path.totalTime || 1;
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += perTick(total, 100);
      if (segmentAtTime(path, t) >= path.count) break;
      await render(readoutProps(path, stats, t, true));
      const expected = toolPointAt(path, t);
      expect(axisText('X')).toBe(expected[0].toFixed(3));
      expect(axisText('Y')).toBe(expected[1].toFixed(3));
      expect(axisText('Z')).toBe(expected[2].toFixed(3));
    }
  });

  it('reads zero while parked, before the run starts', async () => {
    const { path, stats } = load(MILL);
    await render(readoutProps(path, stats, 0, false));
    expect(axisText('X')).toBe('0.000');
    expect(container.querySelector('[data-testid="position-readout"]')).not.toBeNull();
  });

  it('parks on the end point when the run ends, not part-way through the last move', async () => {
    // Regression guard for a subtlety that cost this suite a red run: the app
    // pauses as the final segment *starts*, so a readout riding the continuous
    // clock would stop at Z1.603 in the middle of the retract instead of Z10.
    const { path, stats } = load(MILL);
    const frames = await play(path, stats);
    const last = frames[frames.length - 1];
    expect(last.playing).toBe(false);
    expect(last.Z).toBe('10.000');
  });

  it('names the tool the program selected', async () => {
    const { path, stats } = load(MILL);
    const frames = await play(path, stats);
    expect(frames[frames.length - 1].text).toContain('T3');
  });

  it('counts the distance to go down, never up, within a block', async () => {
    // The property that makes the column trustworthy: inside one source line the
    // remaining distance only shrinks. It would climb if the readout were
    // targeting the *segment* end, or the tessellated end of the wrong block.
    const { path, stats } = load(MILL);
    const frames = await play(path, stats);
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].line !== frames[i - 1].line) continue; // a new block resets it
      for (const axis of ['dX', 'dY', 'dZ']) {
        // A micron of slack: both ends are rounded to three places.
        expect(Math.abs(frames[i][axis])).toBeLessThanOrEqual(Math.abs(frames[i - 1][axis]) + 0.001);
      }
    }
  });

  it('reaches zero on the axis that was moving, as its block lands', async () => {
    const { path, stats } = load(MILL);
    const frames = await play(path, stats);
    // G1 X50 is a block that moves X alone: somewhere in the run X must be
    // counting down through a real distance...
    expect(frames.some((f) => Math.abs(f.dX) > 5)).toBe(true);
    // ...and the program must finish with nothing left to go on any axis.
    const last = frames[frames.length - 1];
    expect(last.dX).toBe(0);
    expect(last.dY).toBe(0);
    expect(last.dZ).toBe(0);
  });

  it('agrees with the block end the path reports, at every tick', async () => {
    const { path, stats } = load(MILL);
    const total = path.totalTime || 1;
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += perTick(total, 100);
      if (segmentAtTime(path, t) >= path.count) break;
      await render(readoutProps(path, stats, t, true));
      const here = toolPointAt(path, t);
      const to = blockTargetAt(path, t);
      expect(dtg('X')).toBeCloseTo(to[0] - here[0], 3);
      expect(dtg('Z')).toBeCloseTo(to[2] - here[2], 3);
    }
  });

  it('grows no A row for a 3-axis program, start to finish', async () => {
    const { path, stats } = load(MILL);
    const frames = await play(path, stats);
    expect(frames.every((f) => f.A === null)).toBe(true);
  });
});

describe('PositionReadout during a real 4-axis run', () => {
  const INDEXED = [
    'G21 G90',
    'G0 A0.',
    'G1 X10 Y0 Z-1 F300',
    'G0 A90.',
    'G1 X20',
    'G0 A270.',
    'G1 X30',
  ].join('\n');

  it('posts the rotary index in force, and follows it as the program indexes', async () => {
    const { path, stats } = load(INDEXED);
    const frames = await play(path, stats);
    const seen = new Set(frames.map((f) => f.A).filter(Boolean));
    // The A row must exist and must visit more than one index.
    expect(frames.some((f) => f.A !== null)).toBe(true);
    expect(seen.size).toBeGreaterThan(1);
    expect(seen).toContain('270.000');
  });

  it('ends at the last commanded index', async () => {
    const { path, stats } = load(INDEXED);
    const frames = await play(path, stats);
    expect(frames[frames.length - 1].A).toBe('270.000');
  });
});

describe('PositionReadout during a real turning run', () => {
  // Programmed on diameter, the lathe convention: X60 is a Ø60 bar.
  const TURN = [
    'G21 G90 G18',
    'S1000 M3',
    'G0 X60 Z5',
    'G1 Z-30 F100',
    'G1 X40',
  ].join('\n');

  it('posts the diameter the programmer typed, not the radius it stores', async () => {
    // This is the round trip that matters: interpreter.js halves the X word into
    // a radius, dro.js doubles it back. If either side changes, this fails —
    // which is the point. A unit test with a hand-made point could not catch a
    // change of convention inside the interpreter.
    const { path, stats } = load(TURN, { mode: 'turn', diameterMode: true });
    const view = { mode: 'turn', diameterMode: true };
    const frames = await play(path, stats, view);
    const last = frames[frames.length - 1];
    expect(last.X).toBe('40.000');
    expect(last.Z).toBe('-30.000');
    // And the stored geometry really is the radius — proving the doubling is
    // doing work rather than passing a coincidence through.
    const raw = toolPointAt(path, timeAt(path, path.count));
    expect(raw[0]).toBeCloseTo(20, 6);
  });

  it('never shows a Y row on the lathe, for the whole run', async () => {
    const { path, stats } = load(TURN, { mode: 'turn', diameterMode: true });
    const frames = await play(path, stats, { mode: 'turn', diameterMode: true });
    expect(frames.every((f) => f.Y === null)).toBe(true);
  });

  it('marks X as a diameter throughout', async () => {
    const { path, stats } = load(TURN, { mode: 'turn', diameterMode: true });
    const frames = await play(path, stats, { mode: 'turn', diameterMode: true });
    expect(frames.every((f) => f.text.includes('⌀'))).toBe(true);
  });
});

describe('the footer during a real run', () => {
  const NAMED = [
    'G21 G90 G17',
    'T3(ENDMILL D7 - ROUGH B2)',
    'S6000 M03',
    'G0 X0 Y0 Z10',
    'G1 Z-2 F200',
    'G1 X50 F400',
    'G0 Z10',
  ].join('\n');

  it('follows the feed as the program changes it', async () => {
    const { path, stats } = load(NAMED);
    const frames = await play(path, stats);
    const feeds = [...new Set(frames.map((f) => f.feed))];
    // The plunge runs at F200 and the cut at F400, and both are posted.
    expect(feeds).toContain('200');
    expect(feeds).toContain('400');
    // The rapid out at the end keeps the last feed — G00 does not clear F.
    expect(frames[frames.length - 1].feed).toBe('400');
  });

  it('posts the spindle speed the program commanded', async () => {
    const { path, stats } = load(NAMED);
    const frames = await play(path, stats);
    // Parked at t=0 nothing has run yet and the fields dash, exactly as the
    // position rows read 0.000 there. From the first move on, S is the S word.
    expect(frames[0].spindle).toBe('—');
    expect(frames.slice(1).every((f) => f.spindle === '6000')).toBe(true);
  });

  it('names the tool from the program comment when nothing else knows better', async () => {
    const { path, stats } = load(NAMED);
    const frames = await play(path, stats);
    expect(frames[frames.length - 1].toolName).toBe('ENDMILL D7');
  });

  it('posts a lathe feed in mm/min and the rpm CSS is chasing', async () => {
    // G96 S200 at Ø30 is ~2122 rpm, and F0.2 is a feed per rev under G99, so
    // the machine is running at 0.2 × 2122 ≈ 424 mm/min. That is the rate the
    // field posts; the F0.2 the programmer typed comes back as the note under
    // it, so neither number has to be reconstructed by the operator. S is the
    // rpm CSS is actually holding, never the S200 surface speed.
    const CSS = [
      'G21 G90 G18 G99',
      'G96 S200 M03',
      'G0 X30 Z2',
      'G1 Z-20 F0.2',
    ].join('\n');
    const { path, stats } = load(CSS, { mode: 'turn', diameterMode: true });
    const frames = await play(path, stats, { mode: 'turn', diameterMode: true });
    const last = frames[frames.length - 1];
    expect(Number(last.feed)).toBeCloseTo(424, 0);
    expect(Number(last.spindle)).toBeCloseTo(2122, 0);
    expect(last.text).toContain('mm/min');
    expect(last.text).toContain('0.2 mm/rev');
  });
});
