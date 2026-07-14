/**
 * Sketch store (Phase 2) — orchestrates the interactive sketcher and the
 * sketch-worker, mirroring camStore.
 *
 * The live sketch model is held in the store and mutated in place; a scalar
 * `version` token drives re-render (the same view-cache/version pattern camStore
 * uses for buffers, so React never walks the model). Only the *solve* crosses to
 * the worker, serialized. The worker is created lazily so tests/SSR don't spin
 * it up on import.
 *
 * Undo/redo keep serialized snapshots (`past`/`future`); `_snapshot()` is called
 * at the start of every user mutation, so one undo reverts the edit *and* the
 * solve it triggered.
 */
import { create } from 'zustand';
import * as Comlink from 'comlink';
import {
  createSketch, addPoint, addLine, addCircle, addArc, addConstraint, dof, serialize, deserialize,
} from '../engine/sketch/model.js';
import {
  getOrCreatePoint, hitTestPoint, hitTestLine, hitTestCircle, hitTestArc,
  deleteEntity, removeConstraint, chamfer as chamferEdit,
} from '../engine/sketch/edit.js';

const SNAP = 1.5; // mm — click snap / pick tolerance
const HISTORY = 50; // max undo depth

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

/**
 * A fresh sketch seeded with a fixed **origin** point at (0,0). Kept here (not in
 * the pure engine `createSketch`, which the node checks assume is empty) because
 * "every sketch has an origin to dimension from" is an app-level policy. The
 * origin is `fixed` (grounds the solve, contributes no DOF) and tagged so the UI
 * can style it and refuse to delete it.
 */
function newSketch() {
  const sk = createSketch();
  const id = addPoint(sk, 0, 0, true);
  sk.entities.get(id).origin = true;
  return sk;
}

/** A deliberately skewed quad anchored at the origin; horizontals/verticals solve it square. */
function demoSketch() {
  const sk = newSketch();
  const p1 = getOrCreatePoint(sk, 0, 0); // snaps to the origin (fixed → grounds the quad)
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
  return sk;
}

export const useSketchStore = create((set, get) => ({
  sk: newSketch(),
  version: 0, // bump to re-render after any mutation
  tool: 'select', // select | point | line | rectangle | circle | arc | dimension
  pending: null, // first click while drawing (line/rect/circle centre, arc centre)
  pending2: null, // second click for a 3-click tool — the arc's start point
  cursor: null, // { x, y } live pointer on the plane — drives rubber-band preview
  snap: null, // { x, y, id } existing point the cursor is snapping to, or null
  selection: [], // selected entity ids — points, lines, circles, and/or arcs (mixed)
  past: [], // undo stack (serialized snapshots, oldest first)
  future: [], // redo stack
  solveResult: null, // { success, status, conflicting, redundant }
  dofState: null,
  error: null,

  _bump() {
    set({ version: get().version + 1, dofState: dof(get().sk) });
  },

  /** Push the current sketch onto the undo stack and clear the redo stack. */
  _snapshot() {
    const past = get().past.concat([serialize(get().sk)]);
    if (past.length > HISTORY) past.shift();
    set({ past, future: [] });
  },

  undo() {
    const { past, future, sk } = get();
    if (!past.length) return;
    set({
      sk: deserialize(past[past.length - 1]),
      past: past.slice(0, -1),
      future: future.concat([serialize(sk)]),
      selection: [], pending: null, pending2: null, error: null,
    });
    get()._bump();
  },

  redo() {
    const { past, future, sk } = get();
    if (!future.length) return;
    set({
      sk: deserialize(future[future.length - 1]),
      future: future.slice(0, -1),
      past: past.concat([serialize(sk)]),
      selection: [], pending: null, pending2: null, error: null,
    });
    get()._bump();
  },

  setTool(tool) {
    set({ tool, pending: null, pending2: null, cursor: null, snap: null, error: null });
  },

  /**
   * Live pointer position on the plane (sketch coords) — preview only, no
   * mutation. Also resolves the current **snap target**: the nearest existing
   * point within SNAP, so the view can show a snap marker and the rubber-band
   * can lock onto it (matching where `getOrCreatePoint` will actually place the
   * click).
   */
  hover(x, y) {
    const { sk } = get();
    const id = hitTestPoint(sk, x, y, SNAP);
    const p = id != null ? sk.entities.get(id) : null;
    set({ cursor: { x, y }, snap: p ? { x: p.x, y: p.y, id } : null });
  },

  /** Escape: drop the in-progress draw (line/rectangle/circle/arc) without committing it. */
  cancelPending() {
    if (get().pending != null || get().pending2 != null) set({ pending: null, pending2: null });
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
      get()._snapshot();
      getOrCreatePoint(sk, x, y, SNAP);
      get()._bump();
    } else if (tool === 'line') {
      const { pending } = get();
      if (pending == null) {
        set({ pending: getOrCreatePoint(sk, x, y, SNAP) });
      } else {
        const p = getOrCreatePoint(sk, x, y, SNAP);
        if (p !== pending) {
          get()._snapshot();
          addLine(sk, pending, p);
        }
        set({ pending: null });
        get()._bump();
      }
    } else if (tool === 'circle') {
      // Circle tool: first click sets the centre (held in `pending`, same as the
      // line tool); second click sets the radius from the distance to the centre.
      const { pending } = get();
      if (pending == null) {
        set({ pending: getOrCreatePoint(sk, x, y, SNAP) });
      } else {
        const center = sk.entities.get(pending);
        const r = Math.hypot(x - center.x, y - center.y);
        if (r > 1e-6) {
          get()._snapshot();
          addCircle(sk, pending, r);
        }
        set({ pending: null });
        get()._bump();
      }
    } else if (tool === 'arc') {
      // Arc tool — three clicks: centre, then start (sets the radius), then end.
      // The end click is projected onto the rim so the arc starts consistent;
      // planegcs' arc_rules keep it that way through solves.
      const { pending, pending2 } = get();
      if (pending == null) {
        set({ pending: getOrCreatePoint(sk, x, y, SNAP) });
      } else if (pending2 == null) {
        const s = getOrCreatePoint(sk, x, y, SNAP);
        if (s !== pending) set({ pending2: s });
      } else {
        const center = sk.entities.get(pending);
        const start = sk.entities.get(pending2);
        const r = Math.hypot(start.x - center.x, start.y - center.y);
        const dx = x - center.x;
        const dy = y - center.y;
        const d = Math.hypot(dx, dy);
        if (r > 1e-6 && d > 1e-6) {
          const end = getOrCreatePoint(sk, center.x + (dx / d) * r, center.y + (dy / d) * r, SNAP);
          if (end !== pending && end !== pending2) {
            get()._snapshot();
            addArc(sk, pending, pending2, end, r);
            set({ pending: null, pending2: null });
            get()._bump();
            get().solve();
            return;
          }
        }
        set({ pending: null, pending2: null });
        get()._bump();
      }
    } else if (tool === 'rectangle') {
      // Rectangle tool: first click sets corner A; second click sets the opposite
      // corner. Builds 4 axis-aligned lines that *share* their corner points, plus
      // horizontal/vertical constraints so the solver keeps it a true rectangle.
      const { pending } = get();
      if (pending == null) {
        set({ pending: getOrCreatePoint(sk, x, y, SNAP) });
      } else {
        const a = sk.entities.get(pending);
        if (Math.abs(x - a.x) > 1e-6 && Math.abs(y - a.y) > 1e-6) {
          get()._snapshot();
          const b = getOrCreatePoint(sk, x, a.y, SNAP); // A→B along x
          const c = getOrCreatePoint(sk, x, y, SNAP); // opposite corner
          const d = getOrCreatePoint(sk, a.x, y, SNAP); // A→D along y
          addLine(sk, pending, b);
          addLine(sk, b, c);
          addLine(sk, c, d);
          addLine(sk, d, pending);
          addConstraint(sk, 'horizontal', [pending, b]);
          addConstraint(sk, 'horizontal', [d, c]);
          addConstraint(sk, 'vertical', [b, c]);
          addConstraint(sk, 'vertical', [pending, d]);
          set({ pending: null });
          get()._bump();
          get().solve();
          return;
        }
        set({ pending: null });
        get()._bump();
      }
    } else {
      // select / dimension: points take priority over lines, then circles, under
      // the cursor; empty space clears. All route through toggleSelect.
      const hit = hitTestPoint(sk, x, y, SNAP);
      if (hit != null) { get().toggleSelect(hit); return; }
      const lineHit = hitTestLine(sk, x, y, SNAP);
      if (lineHit != null) { get().toggleSelect(lineHit); return; }
      const circleHit = hitTestCircle(sk, x, y, SNAP);
      if (circleHit != null) { get().toggleSelect(circleHit); return; }
      const arcHit = hitTestArc(sk, x, y, SNAP);
      if (arcHit != null) { get().toggleSelect(arcHit); return; }
      set({ selection: [] });
    }
  },

  /** Apply a constraint to the current selection, then re-solve. */
  applyConstraint(kind, value) {
    const { sk, selection } = get();
    get()._snapshot();
    try {
      addConstraint(sk, kind, selection, value);
    } catch (e) {
      get()._undoSnapshot();
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
    get()._snapshot();
    try {
      addConstraint(sk, kind, refs, value);
    } catch (e) {
      get()._undoSnapshot();
      set({ error: String(e?.message || e) });
      return;
    }
    set({ selection: [], error: null });
    get()._bump();
    get().solve();
  },

  /**
   * Dimension the current selection — the CAD "smart dimension" flow: a single
   * line dimensions its length, two points their distance, a single circle its
   * radius. Drives the matching constraint from whatever is selected.
   */
  dimension(value) {
    const { sk, selection } = get();
    const ents = selection.map((id) => sk.entities.get(id)).filter(Boolean);
    let kind;
    let refs;
    if (ents.length === 1 && ents[0].type === 'line') {
      kind = 'distance'; refs = [ents[0].p1, ents[0].p2];
    } else if (ents.length === 2 && ents.every((e) => e.type === 'point')) {
      kind = 'distance'; refs = selection.slice();
    } else if (ents.length === 1 && ents[0].type === 'circle') {
      kind = 'radius'; refs = [selection[0]];
    } else {
      set({ error: 'Dimension needs 1 line, 2 points, or 1 circle' });
      return;
    }
    get()._snapshot();
    try {
      addConstraint(sk, kind, refs, value);
    } catch (e) {
      get()._undoSnapshot();
      set({ error: String(e?.message || e) });
      return;
    }
    set({ selection: [], error: null });
    get()._bump();
    get().solve();
  },

  /** Chamfer the corner between the two selected lines by `dist`. */
  chamfer(dist) {
    const { sk, selection } = get();
    const lines = selection.filter((id) => sk.entities.get(id)?.type === 'line');
    if (lines.length !== 2) {
      set({ error: 'Chamfer needs exactly 2 lines' });
      return;
    }
    get()._snapshot();
    const res = chamferEdit(sk, lines[0], lines[1], dist);
    if (res == null) {
      get()._undoSnapshot();
      set({ error: 'Lines must share a corner and the distance must fit' });
      return;
    }
    set({ selection: [], error: null });
    get()._bump();
    get().solve();
  },

  /** Discard the snapshot just pushed (used when a guarded mutation aborts). */
  _undoSnapshot() {
    set({ past: get().past.slice(0, -1) });
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
    // The origin is a fixed reference — never delete it.
    const ids = selection.filter((id) => !sk.entities.get(id)?.origin);
    if (!ids.length) { set({ selection: [] }); return; }
    get()._snapshot();
    ids.forEach((id) => deleteEntity(sk, id));
    set({ selection: [] });
    get()._bump();
    get().solve();
  },

  /** Remove one constraint (by its index in sk.constraints), then re-solve. */
  removeConstraintAt(index) {
    const { sk } = get();
    get()._snapshot();
    removeConstraint(sk, index);
    get()._bump();
    get().solve();
  },

  loadDemo() {
    get()._snapshot();
    set({ sk: demoSketch(), selection: [], pending: null, pending2: null, snap: null, solveResult: null, error: null });
    get()._bump();
  },

  clear() {
    get()._snapshot();
    set({ sk: newSketch(), selection: [], pending: null, pending2: null, snap: null, solveResult: null, error: null });
    get()._bump();
  },
}));
