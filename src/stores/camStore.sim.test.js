/**
 * @vitest-environment jsdom
 *
 * The store's side of material removal: which simulator it runs, and whether
 * the playhead actually carves.
 *
 * The engine is checked in `engine/sim/_node_check.mjs` and the routing rule in
 * `engine/sim/method.test.js`. Neither can see the thing that kept going wrong
 * here — the *orchestration*: a session that never gets carved, a switch left
 * off, a target computed the wrong way. That lives entirely in the store, and
 * the only untested layer is the one the bugs kept landing in.
 *
 * The worker is a stub that records what it was asked for.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls = [];
const worker = {
  init: vi.fn(async () => ({ positions: new Float32Array(3), indices: new Uint32Array(3), totalFeeds: 6, cutBounds: null, box: {} })),
  carve: vi.fn(async (k) => { calls.push(['carve', k]); return { positions: new Float32Array(3), indices: new Uint32Array(3), cursor: k }; }),
  initVoxel: vi.fn(async () => ({
    positions: new Float32Array(3), normals: new Float32Array(3), indices: new Uint32Array(3),
    totalFeeds: 6, cellSize: 1, cellSizeZ: 0.75, limited: false,
  })),
  carveVoxelStep: vi.fn(async (k) => {
    calls.push(['voxel', k]);
    return {
      positions: new Float32Array(3), normals: new Float32Array(3), indices: new Uint32Array(3),
      cursor: k, removedVolume: k * 10,
    };
  }),
};

vi.stubGlobal('Worker', class {
  // eslint-disable-next-line no-useless-constructor
  constructor() { /* never actually spawned */ }
  terminate() {}
});
vi.mock('comlink', () => ({
  wrap: () => worker,
  transfer: (obj) => obj,
  expose: () => {},
}));

const { useCamStore } = await import('./camStore.js');
const { setBuffers, clearBuffers } = await import('../engine/bufferCache.js');
const { interpret } = await import('../engine/gcode/interpreter.js');
const { buildPath } = await import('../engine/gcode/path.js');

// Six feed moves, so a playhead step is a feed step.
const SRC = [
  'G21 G90', 'G0 X0 Y0 Z5',
  'G1 Z-2 F200', 'G1 X10 F400', 'G1 X20', 'G1 X30', 'G1 X40', 'G1 X50',
].join('\n');

beforeEach(() => {
  calls.length = 0;
  for (const fn of Object.values(worker)) fn.mockClear?.();
  clearBuffers();
  const { segments, bounds, stats } = interpret(SRC, { mode: 'mill' });
  setBuffers({ path: buildPath(segments), bounds, stats });
  useCamStore.setState({
    mode: 'mill', page: 'mill', gcode: SRC, bufVer: 1, playing: false, playhead: 0,
    toolCutter: 'slot', toolThickness: null, toolOverrides: {},
    cutFollowsPlayback: true, simReady: false, simMethod: 'height', _lastCarveTarget: null,
  });
});

describe('Simulate runs the model the setup needs', () => {
  it('uses the height field for an ordinary cutter', async () => {
    await useCamStore.getState().simulate();
    expect(worker.init).toHaveBeenCalled();
    expect(worker.initVoxel).not.toHaveBeenCalled();
    expect(useCamStore.getState().simMethod).toBe('height');
  });

  it('uses the voxel block once a cutting body is stated', async () => {
    useCamStore.getState().setThickness(3);
    await useCamStore.getState().simulate();
    expect(worker.initVoxel).toHaveBeenCalled();
    expect(worker.init).not.toHaveBeenCalled();
    expect(useCamStore.getState().simMethod).toBe('voxel');
  });

  it('hands the thickness to the worker, or nothing carves the groove', async () => {
    useCamStore.getState().setThickness(3);
    await useCamStore.getState().simulate();
    expect(worker.initVoxel.mock.calls[0][1]).toMatchObject({ thickness: 3, cutter: 'slot' });
  });
});

describe('a voxel run leaves the operator able to watch it', () => {
  async function runVoxel() {
    useCamStore.getState().setThickness(3);
    await useCamStore.getState().simulate();
  }

  it('carves the whole program on the press, not an empty block', async () => {
    // Leaving it to the playhead handed back an UNCUT block to anyone whose
    // cut-with-playback switch was off — which the old one-shot run turned off.
    await runVoxel();
    expect(calls).toContainEqual(['voxel', 6]);
    expect(useCamStore.getState().simStatus).toBe('done');
  });

  it('turns cut-with-playback back on — the old run turned it off for good', async () => {
    useCamStore.setState({ cutFollowsPlayback: false });
    await runVoxel();
    expect(useCamStore.getState().cutFollowsPlayback).toBe(true);
  });

  it('leaves the session scrub-able', async () => {
    await runVoxel();
    expect(useCamStore.getState().simReady).toBe(true);
    expect(useCamStore.getState().totalFeeds).toBe(6);
  });

  it('carves step by step as the playhead moves', async () => {
    // The complaint this answers: the material came off all at once and then
    // never followed the tool again.
    await runVoxel();
    calls.length = 0;
    const path = (await import('../engine/bufferCache.js')).getBuf().path;
    const seen = [];
    for (let k = 0; k <= path.count; k++) {
      useCamStore.getState().setPlayhead(k);
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
      seen.push(useCamStore.getState()._lastCarveTarget);
    }
    const carved = calls.filter(([kind]) => kind === 'voxel').map(([, k]) => k);
    expect(carved.length).toBeGreaterThan(1);
    // ...and it walks up through the feeds rather than jumping to the end.
    expect(carved).toEqual([...carved].sort((a, b) => a - b));
    expect(carved[carved.length - 1]).toBe(6);
    expect(new Set(carved).size).toBeGreaterThan(2);
  });

  it('re-carves from the start when the playhead goes backwards', async () => {
    await runVoxel();
    calls.length = 0;
    useCamStore.getState().setPlayhead(0);
    await Promise.resolve();
    expect(calls).toContainEqual(['voxel', 0]);
  });

  it('carves part of the move in progress while playing', async () => {
    // One long `G1` is a single feed move. Counting whole moves let the tool
    // cross the part with nothing happening, then dropped the whole cut in at
    // the end of it — which is what "the material does not follow the tool"
    // looks like from the outside.
    const { getBuf } = await import('../engine/bufferCache.js');
    const { timeAt } = await import('../engine/gcode/path.js');
    await runVoxel();
    const path = getBuf().path;
    const end = timeAt(path, path.count);
    calls.length = 0;
    useCamStore.setState({ playing: true });
    const asked = [];
    for (let i = 1; i <= 8; i++) {
      useCamStore.setState({ playT: (end * i) / 8 });
      useCamStore.getState().setPlayhead(path.count);
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
      const last = calls[calls.length - 1];
      if (last) asked.push(last[1]);
    }
    // Fractions, not just whole numbers — and never going backwards.
    expect(asked.some((k) => !Number.isInteger(k))).toBe(true);
    expect(asked).toEqual([...asked].sort((a, b) => a - b));
  });
});
