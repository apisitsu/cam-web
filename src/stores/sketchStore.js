/**
 * Sketch store (Phase 2) — orchestrates the interactive sketcher and the
 * sketch-worker, mirroring camStore.
 *
 * The live sketch model is held in the store and mutated in place; a scalar
 * `version` token drives re-render (the same view-cache/version pattern camStore
 * uses for buffers, so React never walks the model). Only the *solve* crosses to
 * the worker, serialized. The worker is created lazily so tests/SSR don't spin
 * it up on import.
 */
import { create } from 'zustand';
import * as Comlink from 'comlink';
import {
  createSketch, addLine, addConstraint, dof, serialize, deserialize,
} from '../engine/sketch/model.js';
import { getOrCreatePoint, hitTestPoint, deleteEntity } from '../engine/sketch/edit.js';

const SNAP = 1.5; // mm — click snap / pick tolerance

let sketchApi = null;
function worker() {
  if (!sketchApi) {
    const w = new Worker(new URL('../workers/sketch.worker.js', import.meta.url), {
      type: 'module',
    });
    sketchApi = Comlink.wrap(w);
  }
  return sketchApi;
}

/** A deliberately skewed quad; horizontals/verticals + a side dim solve it square. */
function demoSketch() {
  const sk = createSketch();
  const p1 = getOrCreatePoint(sk, 0, 0);
  const p2 = getOrCreatePoint(sk, 30, 3);
  const p3 = getOrCreatePoint(sk, 27, 33);
  const p4 = getOrCreatePoint(sk, -3, 30);
  addLine(sk, p1, p2);
  addLine(sk, p2, p3);
  addLine(sk, p3, p4);
  addLine(sk, p4, p1);
  addConstraint(sk, 'horizontal', [p1, p2]);
  addConstraint(sk, 'horizontal', [p4, p3]);
  addConstraint(sk, 'vertical', [p1, p4]);
  addConstraint(sk, 'vertical', [p2, p3]);
  addConstraint(sk, 'lockX', [p1], 0);
  addConstraint(sk, 'lockY', [p1], 0);
  return sk;
}

export const useSketchStore = create((set, get) => ({
  sk: createSketch(),
  version: 0, // bump to re-render after any mutation
  tool: 'select', // select | point | line
  pending: null, // first endpoint while drawing a line
  selection: [], // selected point ids
  solveResult: null, // { success, status, conflicting, redundant }
  dofState: null,
  error: null,

  _bump() {
    set({ version: get().version + 1, dofState: dof(get().sk) });
  },

  setTool(tool) {
    set({ tool, pending: null, error: null });
  },

  /** A pointer-down on the sketch plane at sketch coords (x, y). */
  clickAt(x, y) {
    const { sk, tool } = get();
    if (tool === 'point') {
      getOrCreatePoint(sk, x, y, SNAP);
      get()._bump();
    } else if (tool === 'line') {
      const p = getOrCreatePoint(sk, x, y, SNAP);
      const { pending } = get();
      if (pending == null) {
        set({ pending: p });
      } else {
        if (p !== pending) addLine(sk, pending, p);
        set({ pending: null });
        get()._bump();
      }
    } else {
      // select: toggle the point under the cursor, or clear on empty space
      const hit = hitTestPoint(sk, x, y, SNAP);
      if (hit == null) {
        set({ selection: [] });
        return;
      }
      const sel = get().selection.slice();
      const i = sel.indexOf(hit);
      if (i >= 0) sel.splice(i, 1);
      else sel.push(hit);
      set({ selection: sel });
    }
  },

  /** Apply a constraint to the current point selection, then re-solve. */
  applyConstraint(kind, value) {
    const { sk, selection } = get();
    try {
      addConstraint(sk, kind, selection, value);
    } catch (e) {
      set({ error: String(e?.message || e) });
      return;
    }
    set({ selection: [], error: null });
    get()._bump();
    get().solve();
  },

  /** Solve the whole sketch in the worker and adopt the result. */
  async solve() {
    try {
      const res = await worker().solve(serialize(get().sk));
      set({
        sk: deserialize(res.sketch),
        solveResult: {
          success: res.success,
          status: res.status,
          conflicting: res.conflicting,
          redundant: res.redundant,
        },
      });
      get()._bump();
    } catch (e) {
      set({ error: String(e?.message || e) });
    }
  },

  deleteSelected() {
    const { sk, selection } = get();
    selection.forEach((id) => deleteEntity(sk, id));
    set({ selection: [] });
    get()._bump();
  },

  loadDemo() {
    set({ sk: demoSketch(), selection: [], pending: null, solveResult: null, error: null });
    get()._bump();
  },

  clear() {
    set({ sk: createSketch(), selection: [], pending: null, solveResult: null, error: null });
    get()._bump();
  },
}));
