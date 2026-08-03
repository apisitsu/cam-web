/**
 * The blank is fitted to the CUTTING, never to the rapids.
 *
 * The reported symptom was "material is removed in the wrong place": the stock
 * block sat off to one side with the toolpath only clipping its edge. The cause
 * was not in the carver at all — the blank was being centred on the full
 * toolpath bounds, and a program that rapids out to clear the vice has bounds
 * reaching wherever it rapids to. A 60 mm blank centred on a path that cuts at
 * X0…20 and rapids to X200 lands at X70…130: beside the job, not around it.
 *
 * `billet.js` always documented "centred on the cutting". This is the test that
 * makes the code mean it, at every entry the app can take.
 */
import { describe, it, expect } from 'vitest';
import { createSession, carveTo } from './session.js';
import { runSimulation, runVoxelSimulation } from './index.js';
import { billetBox, suggestBillet, billetWarnings, cuttingExtent } from './billet.js';
import { interpret } from '../gcode/interpreter.js';

/** Cuts a pocket at X0…20 / Y0…20, but rapids out to X200 to clear. */
const PROGRAM = [
  'G21 G90',
  'G0 X200 Y0 Z50',
  'G0 X0 Y0 Z5',
  'G1 Z-5 F200',
  'G1 X20 F400',
  'G1 Y20',
  'G0 Z50',
  'G0 X200',
].join('\n');

const SIZE = { x: 60, y: 60, z: 20 };

describe('the height-field session', () => {
  const session = (opts) => createSession(PROGRAM, {
    radius: 3, cellSize: 0.5, cutter: 'endmill', ...opts,
  });

  it('centres a stated blank on the cut, not on the clearance rapid', () => {
    const s = session({ stockSize: SIZE });
    // The cut spans X0…20, centre X10, so a 60 mm blank runs -20…40.
    expect(s.stock.xMin).toBeCloseTo(-20);
    expect(s.stock.xMax).toBeCloseTo(40);
  });

  it('actually removes material, which the old fit did not', () => {
    const s = session({ stockSize: SIZE });
    expect(carveTo(s, s.totalFeeds).removedVolume).toBeGreaterThan(500);
  });

  it('wraps the cut, not the rapid, when no size is stated', () => {
    const s = session({ margin: 5 });
    expect(s.stock.xMax).toBeLessThan(50);
  });

  it('still honours a stated origin — the rapid changes nothing there', () => {
    const s = session({ stockSize: SIZE, stockOrigin: { x: -5, y: -5, z: -20 } });
    expect(s.stock.xMin).toBeCloseTo(-5);
    expect(s.stock.xMax).toBeCloseTo(55);
  });
});

describe('the one-shot carvers agree', () => {
  it('runSimulation fits the cut', () => {
    const r = runSimulation(PROGRAM, { radius: 3, cellSize: 0.5, stockSize: SIZE });
    expect(r.removedVolume).toBeGreaterThan(500);
  });

  it('runVoxelSimulation fits the cut', () => {
    const r = runVoxelSimulation(PROGRAM, { radius: 3, voxelSize: 1, stockSize: SIZE });
    expect(r.removedVolume).toBeGreaterThan(500);
  });
});

describe('the parsed bounds object carries both, and the cut wins', () => {
  const bounds = interpret(PROGRAM, { mode: 'mill' }).bounds;

  it('the interpreter really does separate them', () => {
    expect(bounds.max[0]).toBeCloseTo(200);      // the rapid
    expect(bounds.feedMax[0]).toBeCloseTo(20);   // the cut
  });

  it('cuttingExtent prefers the feed bounds', () => {
    expect(cuttingExtent(bounds).max[0]).toBeCloseTo(20);
  });

  it('cuttingExtent passes a plain bounds object through unchanged', () => {
    const plain = { min: [0, 0, 0], max: [1, 2, 3] };
    expect(cuttingExtent(plain)).toBe(plain);
    expect(cuttingExtent(null)).toBeNull();
  });

  it('billetBox centres on the cut — the viewport preview does too', () => {
    const box = billetBox(bounds, SIZE);
    expect(box.xMin).toBeCloseTo(-20);
    expect(box.xMax).toBeCloseTo(40);
  });

  it('no longer reports a false "cuts past the billet" for a clearance rapid', () => {
    // A rapid to X200 outside a 60 mm blank is the tool clear of the work, not
    // a cut running off the side — and saying otherwise trains people to
    // ignore the warning.
    expect(billetWarnings(billetBox(bounds, SIZE), bounds)).toEqual([]);
  });

  it('still reports a real overrun', () => {
    const tiny = billetBox(bounds, { x: 5, y: 60, z: 20 });
    expect(billetWarnings(tiny, bounds).join(' ')).toMatch(/past the billet in \+X/);
  });

  it('suggests a blank sized to the cut, not to the rapid', () => {
    const { size } = suggestBillet(bounds, { margin: 5 });
    expect(size.x).toBe(30);        // 20 wide + 5 each side
    expect(size.x).toBeLessThan(60);
  });
});
