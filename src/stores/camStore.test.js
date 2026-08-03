import { describe, it, expect, beforeEach } from 'vitest';
import { useCamStore } from './camStore.js';
import { useCamPlanStore } from './camPlanStore.js';
import { box } from '../engine/mesh/fixtures.js';
import { interpret } from '../engine/gcode/interpreter.js';
import { buildPath, timeAt, lineAt } from '../engine/gcode/path.js';
import { setBuffers, clearBuffers } from '../engine/bufferCache.js';

/** A binary-STL File-alike, the way camPlanStore receives one from a drop. */
function stlFile(soup, name = 'part.stl') {
  const buf = new ArrayBuffer(84 + soup.triangleCount * 50);
  const view = new DataView(buf);
  view.setUint32(80, soup.triangleCount, true);
  let o = 84;
  for (let t = 0; t < soup.triangleCount; t++) {
    o += 12;
    for (let v = 0; v < 9; v++) { view.setFloat32(o, soup.positions[t * 9 + v], true); o += 4; }
    o += 2;
  }
  return { name, arrayBuffer: async () => buf };
}

describe('camStore.machineOpts — reading the rotary centre off the loaded part', () => {
  beforeEach(() => {
    useCamPlanStore.getState().clear();
    useCamStore.setState({ mode: 'mill' });
  });

  it('has no rotaryCenter with nothing loaded in camPlanStore', () => {
    expect(useCamStore.getState().machineOpts().rotaryCenter).toBeUndefined();
  });

  it('picks up the rotary centre set on the imported part', async () => {
    await useCamPlanStore.getState().loadStl(stlFile(box(120, 30, 20)));
    await useCamPlanStore.getState().makePlan();
    useCamPlanStore.getState().pickRotaryCenter([0, 15, 0]);

    const opts = useCamStore.getState().machineOpts();
    expect(opts.rotaryCenter[0]).toBeCloseTo(15, 3);
    expect(opts.rotaryCenter[1]).toBeCloseTo(0, 3);
  });

  it('carries no rotaryCenter when the viewport is set to turn — the concept does not apply', async () => {
    await useCamPlanStore.getState().loadStl(stlFile(box(120, 30, 20)));
    await useCamPlanStore.getState().makePlan();
    useCamPlanStore.getState().pickRotaryCenter([0, 15, 0]);
    useCamStore.setState({ mode: 'turn' });

    expect(useCamStore.getState().machineOpts().rotaryCenter).toBeUndefined();
  });
});

describe('camStore.stepBlock — single block', () => {
  // The arc is the point of the fixture: G2 tessellates into many segments that
  // are all one block, so a step that landed on a segment would stop inside it.
  const PROGRAM = [
    'G21 G90 G17',
    'G0 X0 Y0 Z5',
    'G1 Z-1 F200',
    'G1 X20 F400',
    'G2 X40 Y20 R20',
    'G0 Z5',
  ].join('\n');

  /** Load a real parsed path into the buffer cache, the way parse() does. */
  function load() {
    const { segments } = interpret(PROGRAM, { mode: 'mill' });
    const path = buildPath(segments);
    setBuffers({ path });
    useCamStore.setState({ playhead: 0, playT: 0, playing: false });
    return path;
  }

  beforeEach(() => {
    clearBuffers();
    useCamStore.setState({ playhead: 0, playT: 0, playing: false, simReady: false });
  });

  it('advances a whole block, not a segment, through a tessellated arc', () => {
    const path = load();
    const seen = [];
    for (let i = 0; i < 50 && useCamStore.getState().playhead < path.count; i++) {
      useCamStore.getState().stepBlock();
      seen.push(lineAt(path, useCamStore.getState().playhead));
    }
    // One stop per source line that produced motion — an arc of dozens of
    // chords must not show up as dozens of stops.
    expect(seen.length).toBe(new Set(seen).size);
    expect(seen.length).toBeLessThan(10);
    expect(useCamStore.getState().playhead).toBe(path.count);
  });

  it('stops the run — stepping and playing are the same cycle start', () => {
    load();
    useCamStore.setState({ playing: true });
    useCamStore.getState().stepBlock();
    expect(useCamStore.getState().playing).toBe(false);
  });

  it('parks the marker clock on the block boundary it stopped at', () => {
    const path = load();
    useCamStore.getState().stepBlock();
    const { playhead, playT } = useCamStore.getState();
    expect(playT).toBe(timeAt(path, playhead));
  });

  it('steps back to the start of the block that just ran', () => {
    const path = load();
    useCamStore.getState().stepBlock();
    const after = useCamStore.getState().playhead;
    useCamStore.getState().stepBlock();
    useCamStore.getState().stepBlock(-1);
    // Back at the block boundary it had stepped to, ready to re-run that block.
    expect(useCamStore.getState().playhead).toBe(after);
    expect(useCamStore.getState().playhead).toBeLessThan(path.count);
  });

  it('starts the program again from the end, the way play() does', () => {
    // A parse parks the playhead at the end so the whole backplot is drawn; a
    // step from there has to mean the first block, or the button is dead on
    // every program the moment it loads.
    const path = load();
    useCamStore.setState({ playhead: path.count });
    useCamStore.getState().stepBlock();
    expect(useCamStore.getState().playhead).toBeGreaterThan(0);
    expect(useCamStore.getState().playhead).toBeLessThan(path.count);
  });

  it('holds at the start when stepping back off the beginning', () => {
    load();
    useCamStore.getState().stepBlock(-1);
    expect(useCamStore.getState().playhead).toBe(0);
  });

  it('does nothing with no program loaded', () => {
    clearBuffers();
    useCamStore.setState({ playhead: 0 });
    expect(() => useCamStore.getState().stepBlock()).not.toThrow();
    expect(useCamStore.getState().playhead).toBe(0);
  });
});

describe('camStore rotary frame — the machine picks how the 4th axis is drawn', () => {
  beforeEach(() => {
    useCamPlanStore.getState().clear();
    useCamStore.setState({ mode: 'mill', rotaryFrame: 'part', gcode: '' });
  });

  it('starts in the part frame — a 3-axis job has no table to turn', () => {
    expect(useCamStore.getState().rotaryFrame).toBe('part');
  });

  it('switches to the machine frame when a 4-axis mill is selected', () => {
    useCamPlanStore.getState().setMachine('generic-vmc-4axis');
    expect(useCamStore.getState().rotaryFrame).toBe('machine');
  });

  it('switches back when a 3-axis mill is selected again', () => {
    useCamPlanStore.getState().setMachine('generic-vmc-4axis');
    useCamPlanStore.getState().setMachine('haas-vf2');
    expect(useCamStore.getState().rotaryFrame).toBe('part');
  });

  it('leaves a lathe in the part frame — turning is already drawn spindle-first', () => {
    useCamPlanStore.getState().setMachine('okuma-lb3000');
    expect(useCamStore.getState().rotaryFrame).toBe('part');
  });

  it('carries the frame into the interpreter options, in both workers', () => {
    useCamPlanStore.getState().setMachine('generic-vmc-4axis');
    expect(useCamStore.getState().machineOpts().rotaryFrame).toBe('machine');
  });

  it('the toggle pins the frame the machine would not have chosen', () => {
    useCamPlanStore.getState().setMachine('generic-vmc-4axis');
    useCamStore.getState().setRotaryFrame('part');
    expect(useCamStore.getState().rotaryFrame).toBe('part');
    expect(useCamStore.getState().machineOpts().rotaryFrame).toBe('part');
  });

  it('re-picking the frame already drawn is a no-op, not a re-parse', () => {
    // setRotaryFrame re-parses, which needs a worker; the guard is what keeps
    // an idempotent set from reaching for one.
    useCamStore.setState({ gcode: 'G0 X0' });
    expect(() => useCamStore.getState().setRotaryFrame('part')).not.toThrow();
    expect(useCamStore.getState().rotaryFrame).toBe('part');
  });
});
