/**
 * `sk` and the active sketch's `doc` are one object. A solve replaces the
 * document, and a rebuild reads the entry: if only `sk` moves, the part is built
 * from the sketch as it was before the solve.
 */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { useSketchStore } from './sketchStore.js';
import { addPoint } from '../engine/sketch/model.js';

let finish = null;
vi.mock('comlink', () => ({
  wrap: () => ({
    solve: (sketch) => new Promise((resolve) => {
      finish = () => resolve({
        success: true, status: 0, conflicting: [], redundant: [], sketch,
      });
      if (!globalThis.holdSolve) finish();
    }),
  }),
  proxy: (x) => x,
  expose: () => {},
}));

const sketch = () => useSketchStore.getState();

beforeEach(() => {
  vi.stubGlobal('Worker', class { terminate() {} });
  globalThis.holdSolve = false;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a solve keeps the open document and its entry together', () => {
  it('the entry points at the solved document', async () => {
    const id = sketch().addSketch({});
    addPoint(sketch().sk, 5, 5);
    const before = sketch().sk;
    await sketch().solve();
    expect(sketch().sk).not.toBe(before);
    expect(sketch().sketches.find((s) => s.id === id).doc).toBe(sketch().sk);
    expect(sketch().error).toBeNull();
  });

  it('a solve that finishes after another sketch was opened changes neither', async () => {
    const first = sketch().addSketch({});
    addPoint(sketch().sk, 5, 5);
    globalThis.holdSolve = true;
    const pending = sketch().solve();
    const second = sketch().addSketch({});
    const open = sketch().sk;
    finish();
    await pending;
    expect(sketch().activeId).toBe(second);
    expect(sketch().sk).toBe(open);
    expect(sketch().sketches.find((s) => s.id === second).doc).toBe(open);
    expect(sketch().sketches.find((s) => s.id === first).doc.entities.size).toBe(2);
  });
});
