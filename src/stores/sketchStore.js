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
  deleteEntity, removeConstraint, chamfer as chamferEdit, trimLine, trimCircle, trimArc,
  distancePointToLine, farEndpointFromLine, nearestRimPoint,
} from '../engine/sketch/edit.js';

const DEG = Math.PI / 180;

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
  tool: 'select', // select | point | line | rectangle | circle | arc | dimension | trim
  pending: null, // first click while drawing (line/rect/circle centre, arc centre)
  pending2: null, // second click for a 3-click tool — the arc's start point
  cursor: null, // { x, y } live pointer on the plane — drives rubber-band preview
  snap: null, // { x, y, id } existing point the cursor is snapping to, or null
  hoverId: null, // entity id a click would pick right now — drives the pre-select highlight
  selection: [], // selected entity ids — points, lines, circles, and/or arcs (mixed)
  dimensionPending: null, // { kind, refs, label, current } set on a dimension-mode empty-click → shows the inline value input
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
    set({ tool, pending: null, pending2: null, cursor: null, snap: null, hoverId: null, error: null, dimensionPending: null });
  },

  /**
   * Live pointer position on the plane (sketch coords) — preview only, no
   * mutation. Resolves two things for the view:
   *  - `snap`: the nearest existing **point** within SNAP, so the rubber-band can
   *    lock onto it (matching where `getOrCreatePoint` will place the click);
   *  - `hoverId`: the entity a click would pick *right now*, using the same
   *    point→line→circle→arc priority as `clickAt`, so the view can pre-highlight
   *    ("lock") the target **before** you click it.
   */
  hover(x, y) {
    const { sk } = get();
    const pid = hitTestPoint(sk, x, y, SNAP);
    const p = pid != null ? sk.entities.get(pid) : null;
    // Snap target: an existing vertex first; otherwise the nearest circle/arc rim
    // point, so a draw click can latch onto (and stay tangent-connectable with)
    // the ring. `id` is set only for a real vertex; a rim snap carries `onCurve`.
    let snap = p ? { x: p.x, y: p.y, id: pid } : null;
    if (!snap) {
      const rim = nearestRimPoint(sk, x, y, SNAP);
      if (rim) snap = { x: rim.x, y: rim.y, onCurve: rim.id, curveType: rim.type };
    }
    let hoverId = pid;
    if (hoverId == null) hoverId = hitTestLine(sk, x, y, SNAP);
    if (hoverId == null) hoverId = hitTestCircle(sk, x, y, SNAP);
    if (hoverId == null) hoverId = hitTestArc(sk, x, y, SNAP);
    set({ cursor: { x, y }, snap, hoverId });
  },

  /**
   * Resolve a draw click at (x, y) to a point id, honouring snaps: an existing
   * vertex within SNAP is reused; otherwise, if the click lands on a circle/arc
   * rim, a new point is created *on* the rim and pinned there with a
   * point-on-circle / point-on-arc constraint (so a line drawn to a circle stays
   * attached through solves); failing both, a plain point is created at (x, y).
   */
  _pointAt(x, y) {
    const { sk } = get();
    const hit = hitTestPoint(sk, x, y, SNAP);
    if (hit != null) return hit;
    const rim = nearestRimPoint(sk, x, y, SNAP);
    if (rim) {
      const id = addPoint(sk, rim.x, rim.y);
      try {
        addConstraint(sk, rim.type === 'arc' ? 'pointOnArc' : 'pointOnCircle', [id, rim.id]);
      } catch { /* leave the point unconstrained if the coupling can't be added */ }
      return id;
    }
    return addPoint(sk, x, y);
  },

  /** Clear all hover state (pointer left the plane). */
  clearHover() {
    set({ cursor: null, snap: null, hoverId: null });
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
      get()._pointAt(x, y);
      get()._bump();
    } else if (tool === 'line') {
      const { pending } = get();
      if (pending == null) {
        set({ pending: get()._pointAt(x, y) });
      } else {
        const p = get()._pointAt(x, y);
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
    } else if (tool === 'trim') {
      // Trim: click a line, circle, or arc to cut away the piece under the cursor
      // at its intersections with the other geometry. Empty space is a no-op, and
      // a curve with nothing crossing it is left whole (trim never deletes an
      // entity outright — use Delete for that). Line takes priority under the
      // cursor, then circle rim, then arc.
      const lineHit = hitTestLine(sk, x, y, SNAP);
      const circleHit = lineHit == null ? hitTestCircle(sk, x, y, SNAP) : null;
      const arcHit = lineHit == null && circleHit == null ? hitTestArc(sk, x, y, SNAP) : null;
      if (lineHit == null && circleHit == null && arcHit == null) return;
      get()._snapshot();
      const res = lineHit != null ? trimLine(sk, lineHit, x, y)
        : circleHit != null ? trimCircle(sk, circleHit, x, y)
        : trimArc(sk, arcHit, x, y);
      if (res == null) { get()._undoSnapshot(); return; }
      set({ selection: [], error: null });
      get()._bump();
      get().solve();
    } else if (tool === 'chamfer') {
      // Chamfer tool: pick the two lines that share a corner (line-only); the
      // inline ChamferInput applies the size once two are selected. Empty space
      // clears the pick.
      const lineHit = hitTestLine(sk, x, y, SNAP);
      if (lineHit != null) get().toggleSelect(lineHit);
      else set({ selection: [] });
    } else {
      // select / dimension: points take priority over lines, then circles, under
      // the cursor; all route through toggleSelect. Empty space clears the
      // selection — except in dimension mode, where an empty click with a
      // dimensionable selection asks the view to prompt for a value.
      const hit = hitTestPoint(sk, x, y, SNAP);
      if (hit != null) { get().toggleSelect(hit); return; }
      const lineHit = hitTestLine(sk, x, y, SNAP);
      if (lineHit != null) { get().toggleSelect(lineHit); return; }
      const circleHit = hitTestCircle(sk, x, y, SNAP);
      if (circleHit != null) { get().toggleSelect(circleHit); return; }
      const arcHit = hitTestArc(sk, x, y, SNAP);
      if (arcHit != null) { get().toggleSelect(arcHit); return; }
      if (tool === 'dimension') {
        const spec = get().resolveDimension();
        // Empty click with a dimensionable selection → open the inline input;
        // otherwise clear (a click on nothing with nothing to dimension).
        set(spec ? { dimensionPending: spec } : { selection: [] });
        return;
      }
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
   * Resolve the current selection into a "smart dimension" — the constraint kind,
   * the ordered refs it applies to, a human label, and the current geometric
   * value (to seed the input). Pure: no mutation, so the view can use it both to
   * enable the Dimension control and to prefill a prompt. Returns null when the
   * selection is not dimensionable. Supported combos:
   *   - 1 point           → distance from that point to the origin
   *   - 2 points          → point-to-point distance
   *   - 1 line            → the line's length
   *   - 1 circle          → radius
   *   - 1 point + 1 line  → perpendicular point-to-line distance
   *   - 2 lines           → angle, or the gap when (near) parallel
   *   - 1 line + 1 circle → line to the circle's centre (point-to-line)
   *   - 2 circles         → centre-to-centre distance
   */
  resolveDimension() {
    const { sk, selection } = get();
    const ents = selection.map((id) => sk.entities.get(id)).filter(Boolean);
    if (ents.length !== selection.length) return null;
    const pdist = (aId, bId) => {
      const a = sk.entities.get(aId);
      const b = sk.entities.get(bId);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const originId = [...sk.entities.values()].find((e) => e.origin)?.id;

    // A single non-origin point → dimension its distance to the origin, the most
    // common "locate this relative to the datum" case (2 points where one is the
    // origin works too, but that needs the origin explicitly picked).
    if (ents.length === 1 && ents[0].type === 'point' && !ents[0].origin && originId != null) {
      return { kind: 'distance', refs: [originId, selection[0]], label: 'To origin', current: pdist(originId, selection[0]) };
    }
    if (ents.length === 2 && ents.every((e) => e.type === 'point')) {
      return { kind: 'distance', refs: selection.slice(), label: 'Distance', current: pdist(selection[0], selection[1]) };
    }
    if (ents.length === 1 && ents[0].type === 'line') {
      return { kind: 'distance', refs: [ents[0].p1, ents[0].p2], label: 'Length', current: pdist(ents[0].p1, ents[0].p2) };
    }
    if (ents.length === 1 && ents[0].type === 'circle') {
      return { kind: 'radius', refs: [selection[0]], label: 'Radius', current: ents[0].r };
    }
    // Point + line (either pick order) → perpendicular distance. This is what
    // dimensions a point (e.g. the origin) to a line.
    const pForLine = ents.find((e) => e.type === 'point');
    const lForPoint = ents.find((e) => e.type === 'line');
    if (ents.length === 2 && pForLine && lForPoint) {
      return {
        kind: 'pointLineDistance', refs: [pForLine.id, lForPoint.id],
        label: 'Point ↔ line', current: distancePointToLine(sk, pForLine.id, lForPoint.id),
      };
    }
    if (ents.length === 2 && ents.every((e) => e.type === 'line')) {
      const [l1, l2] = selection;
      // Smart dimension on two lines: their angle when they actually meet at an
      // angle, the perpendicular gap when they're (near) parallel. Directed angle
      // l1→l2 in degrees, normalised to (−180, 180].
      const dir = (id) => {
        const l = sk.entities.get(id);
        const a = sk.entities.get(l.p1);
        const b = sk.entities.get(l.p2);
        return Math.atan2(b.y - a.y, b.x - a.x);
      };
      let deg = ((dir(l2) - dir(l1)) * 180) / Math.PI;
      deg = ((deg % 360) + 360) % 360;
      if (deg > 180) deg -= 360;
      const parallel = Math.abs(deg) < 0.5 || Math.abs(Math.abs(deg) - 180) < 0.5;
      if (!parallel) {
        return { kind: 'angle', refs: [l1, l2], label: 'Angle', unit: '°', angular: true, current: deg };
      }
      const pid = farEndpointFromLine(sk, l1, l2);
      return { kind: 'pointLineDistance', refs: [pid, l2], label: 'Line ↔ line', current: distancePointToLine(sk, pid, l2) };
    }
    const lineEnt = ents.find((e) => e.type === 'line');
    const circEnt = ents.find((e) => e.type === 'circle');
    if (ents.length === 2 && lineEnt && circEnt) {
      return {
        kind: 'pointLineDistance', refs: [circEnt.center, lineEnt.id],
        label: 'Line ↔ centre', current: distancePointToLine(sk, circEnt.center, lineEnt.id),
      };
    }
    if (ents.length === 2 && ents.every((e) => e.type === 'circle')) {
      return { kind: 'distance', refs: [ents[0].center, ents[1].center], label: 'Centre ↔ centre', current: pdist(ents[0].center, ents[1].center) };
    }
    return null;
  },

  /**
   * Dimension the current selection with `value`, driving the constraint that
   * `resolveDimension` picked for whatever is selected, then re-solve. Prefers a
   * `dimensionPending` spec captured at empty-click time (so it applies even if
   * `resolveDimension` would re-derive differently), else resolves from the
   * live selection (the popover Dimension button).
   */
  dimension(value) {
    const spec = get().dimensionPending || get().resolveDimension();
    if (!spec) {
      set({ error: 'Dimension needs 1 point (to origin), 2 points, 1 line, 1 circle, a point + line, 2 lines, a line + circle, or 2 circles' });
      return;
    }
    const { sk } = get();
    // Angular dimensions are entered/seeded in degrees but stored in radians.
    const modelValue = spec.angular ? value * DEG : value;
    get()._snapshot();
    try {
      addConstraint(sk, spec.kind, spec.refs, modelValue);
    } catch (e) {
      get()._undoSnapshot();
      set({ error: String(e?.message || e) });
      return;
    }
    set({ selection: [], error: null, dimensionPending: null });
    get()._bump();
    get().solve();
  },

  /** Dismiss the inline dimension input without applying. */
  cancelDimension() {
    set({ dimensionPending: null });
  },

  /**
   * Flip an angular dimension's base/rotating line (swap refs[0]/refs[1]) and
   * re-read the current angle for the new order, so the seeded value stays
   * truthful. No-op for non-angular dimensions.
   */
  swapDimensionRefs() {
    const dp = get().dimensionPending;
    if (!dp || !dp.angular) return;
    const { sk } = get();
    const refs = [dp.refs[1], dp.refs[0]];
    const dir = (id) => {
      const l = sk.entities.get(id);
      const a = sk.entities.get(l.p1);
      const b = sk.entities.get(l.p2);
      return Math.atan2(b.y - a.y, b.x - a.x);
    };
    let deg = ((dir(refs[1]) - dir(refs[0])) * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    if (deg > 180) deg -= 360;
    set({ dimensionPending: { ...dp, refs, current: deg } });
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
