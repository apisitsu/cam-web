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
  createSketch, addLine, addCircle, addConstraint, dof, serialize, deserialize,
} from '../engine/sketch/model.js';
import {
  getOrCreatePoint, hitTestPoint, hitTestLine, hitTestCircle, deleteEntity, removeConstraint,
} from '../engine/sketch/edit.js';

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
  tool: 'select', // select | point | line | circle
  pending: null, // first endpoint while drawing a line/circle
  selection: [], // selected entity ids — points, lines, and/or circles (mixed)
  solveResult: null, // { success, status, conflicting, redundant }
  dofState: null,
  error: null,

  _bump() {
    set({ version: get().version + 1, dofState: dof(get().sk) });
  },

  setTool(tool) {
    set({ tool, pending: null, error: null });
  },

  /**
   * Toggle an entity id (point, line, or circle) in/out of the current
   * selection. Shared by every picker so nothing pokes `selection` directly.
   */
  toggleSelect(id) {
    const sel = get().selection.slice();
    const i = sel.indexOf(id);
    if (i >= 0) sel.splice(i, 1);
    else sel.push(id);
    set({ selection: sel });
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
    } else if (tool === 'circle') {
      // Circle tool: first click sets the centre (held in `pending`, same as the
      // line tool); second click sets the radius from the distance to the centre.
      const { pending } = get();
      if (pending == null) {
        const c = getOrCreatePoint(sk, x, y, SNAP);
        set({ pending: c });
      } else {
        const center = sk.entities.get(pending);
        const r = Math.hypot(x - center.x, y - center.y);
        if (r > 1e-6) addCircle(sk, pending, r);
        set({ pending: null });
        get()._bump();
      }
    } else {
      // select: points take priority over lines, then circles, under the
      // cursor; empty space clears the selection. All route through toggleSelect.
      const hit = hitTestPoint(sk, x, y, SNAP);
      if (hit != null) { get().toggleSelect(hit); return; }
      const lineHit = hitTestLine(sk, x, y, SNAP);
      if (lineHit != null) { get().toggleSelect(lineHit); return; }
      const circleHit = hitTestCircle(sk, x, y, SNAP);
      if (circleHit != null) { get().toggleSelect(circleHit); return; }
      set({ selection: [] });
    }
  },

  /** Apply a constraint to the current selection, then re-solve. */
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

  /**
   * Apply a constraint to explicit `refs` (ignoring the store's `selection`),
   * then re-solve. Needed for constraints whose ref order matters and can't
   * be recovered from an unordered selection array — e.g. pointOnLine wants
   * [pointId, lineId], but selection order is "click order", not "type order".
   */
  applyConstraintRefs(kind, refs, value) {
    const { sk } = get();
    try {
      addConstraint(sk, kind, refs, value);
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

  /** Remove one constraint (by its index in sk.constraints), then re-solve. */
  removeConstraintAt(index) {
    const { sk } = get();
    removeConstraint(sk, index);
    get()._bump();
    get().solve();
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
