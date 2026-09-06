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
  deleteEntity, removeConstraint, chamfer as chamferEdit, fillet as filletEdit,
  filletLineArc as filletLineArcEdit, filletArcArc as filletArcArcEdit,
  filletCircleCircle as filletCircleCircleEdit,
  trimLine, trimCircle, trimArc, mirror as mirrorEdit, offsetChain,
  distancePointToLine, farEndpointFromLine, nearestRimPoint, nearestTangent,
  nearestIntersection, nearestQuadrant, nearestMidpoint, entitiesInBox,
  measureConstraint, lineArcMeet, arcArcMeet, angleSpec, interiorAngleToModel,
  axisFromPlacement, dimensionLockDir, projectOnto,
} from '../engine/sketch/edit.js';
import {
  DEFAULT_PLANE, parsePlane, planeFromFace, planeLabel,
} from '../engine/sketch/plane.js';
import { sketchRegions } from '../engine/sketch/loops.js';
import { dxfToSketch } from '../engine/sketch/dxfImport.js';
import { buildSlot, buildPolygon, axisDistance } from '../engine/sketch/shapes.js';
import { combineRegions } from '../engine/solid/regionBoolean.js';
import { useCamPlanStore } from './camPlanStore.js';

const DEG = Math.PI / 180;

const SNAP = 1.5; // mm — click snap / pick tolerance
const ANGLE_SNAP_DEG = 5; // ° — lock the line rubber-band to the nearest 45° axis within this
const HISTORY = 50; // max undo depth

/** Pin `pointId` onto a line / circle / arc with the matching relation. No-op on any other type; a redundant relation is swallowed. */
function pinPointOn(sk, pointId, entId) {
  const kind = { line: 'pointOnLine', circle: 'pointOnCircle', arc: 'pointOnArc' }[sk.entities.get(entId)?.type];
  if (kind) { try { addConstraint(sk, kind, [pointId, entId]); } catch { /* leave that side free */ } }
}

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

/** The first sketch of a session, so `sketches` is never empty. */
function firstSketch(doc) {
  return [{
    id: 1, name: 'Sketch1', plane: { ...DEFAULT_PLANE }, doc, past: [], future: [],
  }];
}

const INITIAL_DOC = newSketch();

export const useSketchStore = create((set, get) => ({
  // A sketch is a document plus the plane it is drawn on. `sk` is the *active*
  // document and is the **same object** as `sketches[active].doc`, not a copy —
  // every edit mutates in place and bumps `version`, so the two cannot drift.
  // Anything that swaps `sk` for a different document (undo, clear, open) has to
  // go through `_docs()` to keep the entry pointing at it.
  sketches: firstSketch(INITIAL_DOC),
  activeId: 1,
  nextSketchId: 2,
  sk: INITIAL_DOC,
  version: 0, // bump to re-render after any mutation
  tool: 'select', // select | point | line | rectangle | slot | polygon | circle | arc | dimension | trim
  polygonSides: 6, // sides the Polygon tool draws — hex is the shop's default
  pending: null, // first click while drawing (line/rect/circle centre, arc centre)
  pending2: null, // second click for a 3-click tool — the arc's start point
  cursor: null, // { x, y } live pointer on the plane — drives rubber-band preview
  boxSelect: null, // { x0, y0, x1, y1 } while a marquee drag is on screen (select tool)
  _boxStart: null, // { x, y } armed marquee origin, before it grows past the click slop
  snap: null, // positional snap target: { x, y, id? (vertex) | onCurve+curveType (rim) | tangent+tangentOf+curveType }
  axisSnap: null, // { x, y, deg } line-tool angle lock to the nearest 45° axis, or null
  lineAngle: null, // ° the line rubber-band currently points at (readout while drawing a line)
  chamferKind: 'C', // 'C' straight chamfer | 'R' rounded fillet — which the Chamfer tool applies
  chamferPick: null, // { x, y } of the last chamfer/fillet pick — picks the corner when two curves meet at more than one
  chamferPicks: {}, // entity id → { x, y } it was picked at — decides which half of a circle survives an auto-trim fillet
  dimensionAxis: 'aligned', // 'aligned' true distance | 'x' horizontal (dX) | 'y' vertical (dY) — SW's dimension orientation
  hoverId: null, // entity id a click would pick right now — drives the pre-select highlight
  selection: [], // selected entity ids — points, lines, circles, and/or arcs (mixed)
  dimensionPending: null, // { kind, refs, label, current } set on a dimension-mode empty-click → shows the inline value input
  offsetPending: false, // true while the Offset rail button is waiting for its distance
  editingConstraint: null, // { index, kind, label, angular, value } set when a placed dimension is double-clicked → shows the edit input
  pickTol: SNAP, // world-unit pick/snap tolerance — kept ~constant on screen (set per camera zoom)
  dragging: null, // { id, wasFixed, moved } while a point is being dragged (SW drag-to-modify)
  _dragTarget: null, // latest cursor pos during a drag (coalesced into the solve loop)
  _dragBusy: false, // a drag-solve is in flight (dedupes the async loop)
  past: [], // undo stack (serialized snapshots, oldest first)
  future: [], // redo stack
  solveResult: null, // { success, status, conflicting, redundant }
  dofState: null,
  error: null,

  _bump() {
    set({ version: get().version + 1, dofState: dof(get().sk) });
  },

  /** `sketches` with the active entry re-pointed at `doc`. */
  _docs(doc) {
    const { sketches, activeId } = get();
    return sketches.map((s) => (s.id === activeId ? { ...s, doc } : s));
  },

  /**
   * `sketches` with the active entry holding the undo stacks that are currently
   * live in the store.
   *
   * History is **per sketch**, but only the active one's is kept in store state
   * — `past`/`future` are read all over the sketcher and every one of those
   * reads would otherwise have to learn which sketch it meant. So the stacks
   * move: stashed onto the entry being left, restored from the entry being
   * opened. Switching away and back now returns the history intact, where it
   * used to be thrown away because a snapshot carried no note of which sketch
   * it came from and undoing after a switch would restore one sketch's geometry
   * into another.
   */
  _stash() {
    const {
      sketches, activeId, past, future,
    } = get();
    return sketches.map((s) => (s.id === activeId ? { ...s, past, future } : s));
  },

  /** The active sketch's entry — its name and, more usefully, its plane. */
  activeSketch() {
    const { sketches, activeId } = get();
    return sketches.find((s) => s.id === activeId) || sketches[0];
  },

  /**
   * Start a new sketch and make it active. `plane` defaults to the table; the
   * point of the argument is drawing a profile on the front or on a face part
   * way up the part.
   */
  addSketch({ name, plane } = {}) {
    // The list itself comes from `_stash()` below, which carries the outgoing
    // sketch's undo history onto it — reading `sketches` here as well would take
    // a copy from before that and drop the history it was stashing.
    const { nextSketchId } = get();
    const doc = newSketch();
    const entry = {
      id: nextSketchId,
      name: name || `Sketch${nextSketchId}`,
      plane: parsePlane(plane || DEFAULT_PLANE),
      doc,
      past: [],
      future: [],
    };
    set({
      // The sketch being left keeps its own history — see `_stash`.
      sketches: get()._stash().concat([entry]),
      activeId: entry.id,
      nextSketchId: nextSketchId + 1,
      sk: doc,
      past: [], future: [],
      selection: [], pending: null, pending2: null, snap: null, axisSnap: null,
      lineAngle: null, solveResult: null, error: null,
      dimensionPending: null, editingConstraint: null,
    });
    get()._bump();
    return entry.id;
  },

  /**
   * Switch which sketch is being edited, carrying each one's undo history with
   * it — see `_stash` for why the stacks travel rather than staying put.
   */
  setActiveSketch(id) {
    if (id === get().activeId) return false;
    const stashed = get()._stash();
    const entry = stashed.find((s) => s.id === id);
    if (!entry) return false;
    set({
      sketches: stashed,
      activeId: id,
      sk: entry.doc,
      past: entry.past || [], future: entry.future || [],
      selection: [], pending: null, pending2: null, snap: null, axisSnap: null,
      lineAngle: null, solveResult: null, error: null,
      dimensionPending: null, editingConstraint: null,
    });
    get()._bump();
    return true;
  },

  renameSketch(id, name) {
    const clean = String(name ?? '').trim();
    if (!clean) return false;
    set({ sketches: get().sketches.map((s) => (s.id === id ? { ...s, name: clean } : s)) });
    return true;
  },

  /** Move a sketch onto a different plane. The geometry keeps its 2D coordinates. */
  setSketchPlane(id, plane) {
    const parsed = parsePlane(plane);
    set({ sketches: get().sketches.map((s) => (s.id === id ? { ...s, plane: parsed } : s)) });
    get()._bump();
    return parsed;
  },

  /**
   * Start a sketch on the face the operator has picked on the part — how a
   * second operation actually begins: point at the floor of a pocket or the top
   * of a boss and draw on it, rather than working out its height and typing an
   * offset.
   *
   * The face comes from `camPlanStore.selectedFeature`, which is already what a
   * click on the part sets; nothing new has to be picked. `onto` re-planes the
   * *current* sketch instead of starting a new one, for a sketch drawn before
   * the operator realised which face it belonged on.
   */
  sketchOnFace({ onto = null } = {}) {
    const face = useCamPlanStore.getState().selectedFeature;
    if (!face?.normal || !face?.centroid) {
      set({ error: 'Pick a face on the part first — click it in the viewport.' });
      return null;
    }
    const plane = planeFromFace(face);
    if (onto != null) {
      get().setSketchPlane(onto, plane);
      set({ error: null });
      return onto;
    }
    const id = get().addSketch({ name: `Face ${planeLabel(plane)}`, plane });
    set({ error: null });
    return id;
  },

  /** Delete a sketch. The last one is never removed — there is always one to draw on. */
  removeSketch(id) {
    const { sketches, activeId } = get();
    if (sketches.length <= 1) return false;
    if (!sketches.some((s) => s.id === id)) return false;
    if (id === activeId) {
      // The removed sketch's history goes with it; the one opened in its place
      // gets its own back.
      const next = get()._stash().filter((s) => s.id !== id);
      set({
        sketches: next,
        activeId: next[0].id,
        sk: next[0].doc,
        past: next[0].past || [],
        future: next[0].future || [],
        selection: [],
      });
    } else {
      set({ sketches: sketches.filter((s) => s.id !== id) });
    }
    get()._bump();
    return true;
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
    const doc = deserialize(past[past.length - 1]);
    set({
      sk: doc,
      sketches: get()._docs(doc),
      past: past.slice(0, -1),
      future: future.concat([serialize(sk)]),
      selection: [], pending: null, pending2: null, snap: null, axisSnap: null, lineAngle: null, error: null,
    });
    get()._bump();
  },

  redo() {
    const { past, future, sk } = get();
    if (!future.length) return;
    const doc = deserialize(future[future.length - 1]);
    set({
      sk: doc,
      sketches: get()._docs(doc),
      future: future.slice(0, -1),
      past: past.concat([serialize(sk)]),
      selection: [], pending: null, pending2: null, snap: null, axisSnap: null, lineAngle: null, error: null,
    });
    get()._bump();
  },

  setTool(tool) {
    set({ tool, pending: null, pending2: null, cursor: null, snap: null, axisSnap: null, lineAngle: null, hoverId: null, error: null, dimensionPending: null, editingConstraint: null, offsetPending: false, boxSelect: null, _boxStart: null });
  },

  /** Show a message on the sketcher's error line (used by save/open failures). */
  setError(error) {
    set({ error });
  },

  /** Pick whether the Chamfer tool cuts a straight chamfer ('C') or rounds ('R'). */
  /** How many sides the Polygon tool draws. Clamped to what it can build. */
  setPolygonSides(n) {
    const sides = Math.min(64, Math.max(3, Math.round(Number(n) || 6)));
    set({ polygonSides: sides });
    return sides;
  },

  setChamferKind(chamferKind) {
    set({ chamferKind });
  },

  /**
   * Pick the orientation a point-to-point dimension measures in: 'aligned' (the
   * true slanted distance), 'x' (horizontal gap only), or 'y' (vertical gap
   * only). Normally set for you from where the dimension was placed (see the
   * dimension branch of `clickAt`, which mirrors SolidWorks reading it off the
   * drag); this is the manual override behind the toggle. Re-resolves an open
   * dimension input so the value shown switches with the mode.
   */
  setDimensionAxis(dimensionAxis) {
    set({ dimensionAxis });
    if (get().dimensionPending) {
      const spec = get().resolveDimension();
      if (spec) set({ dimensionPending: spec });
    }
  },

  /**
   * Set the world-unit pick/snap tolerance so it stays a constant size on screen
   * regardless of zoom (SolidWorks picks by pixels, not model units). The view
   * feeds `targetPixels / cameraZoom` each time the zoom changes materially.
   */
  setPickTol(t) {
    if (Number.isFinite(t) && t > 0 && Math.abs(t - get().pickTol) > 1e-9) set({ pickTol: t });
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
    const { sk, tool, pending } = get();
    const tol = get().pickTol || SNAP;
    // While drawing a line, the pending point is the anchor the rubber-band (and
    // the tangent / angle guides) are measured from.
    const anchor = tool === 'line' && pending != null ? sk.entities.get(pending) : null;

    const pid = hitTestPoint(sk, x, y, tol);
    const p = pid != null ? sk.entities.get(pid) : null;
    // Snap target priority: an existing vertex first; then (line only) the point
    // where the line from the anchor would touch a nearby ring **tangentially**;
    // then the nearest circle/arc rim point. `id` marks a real vertex, `tangent`
    // a tangent target, `onCurve` a plain rim landing.
    let snap = p ? { x: p.x, y: p.y, id: pid } : null;
    if (!snap && anchor) {
      const tan = nearestTangent(sk, anchor.x, anchor.y, x, y, tol);
      if (tan) snap = { x: tan.x, y: tan.y, tangent: true, tangentOf: tan.id, curveType: tan.type };
    }
    // Where two curves cross — more specific than a plain rim landing, so it
    // wins over it. A click here lands on the crossing and pins the new point to
    // both curves (see `_pointAt`). Only while a point-placing tool is active:
    // the pairwise scan is O(n²) and means nothing to select / dimension / trim.
    const placing = tool === 'point' || tool === 'line' || tool === 'rectangle'
      || tool === 'circle' || tool === 'arc' || tool === 'slot' || tool === 'polygon';
    if (!snap && placing) {
      const xn = nearestIntersection(sk, x, y, tol);
      if (xn) snap = { x: xn.x, y: xn.y, intersection: true, of: xn.ids };
    }
    if (!snap && placing) {
      // A circle/arc quadrant (top/bottom/left/right on the axes) — the "high
      // points". More specific than a plain rim landing, so it comes first.
      const q = nearestQuadrant(sk, x, y, tol);
      if (q) {
        snap = {
          x: q.x, y: q.y, quadrant: true, onCurve: q.id, curveType: q.curveType,
          quadCenter: q.center, quadAxis: q.axis,
        };
      }
    }
    if (!snap && placing) {
      const mid = nearestMidpoint(sk, x, y, tol);
      if (mid) snap = { x: mid.x, y: mid.y, midpoint: true, midOf: mid.id };
    }
    if (!snap) {
      const rim = nearestRimPoint(sk, x, y, tol);
      if (rim) snap = { x: rim.x, y: rim.y, onCurve: rim.id, curveType: rim.type };
    }

    // Angle guide (line only): report the current rubber-band angle, and — when no
    // positional snap already owns the endpoint — lock it to the nearest standard
    // 45° axis (0/45/90/…/315) once it's within ANGLE_SNAP_DEG.
    let axisSnap = null;
    let lineAngle = null;
    if (anchor) {
      let deg = ((Math.atan2(y - anchor.y, x - anchor.x) / DEG) % 360 + 360) % 360;
      if (!snap) {
        const step = ((Math.round(deg / 45) * 45) % 360 + 360) % 360;
        if (Math.abs(deg - Math.round(deg / 45) * 45) <= ANGLE_SNAP_DEG) {
          const lockRad = step * DEG;
          const len = Math.hypot(x - anchor.x, y - anchor.y);
          axisSnap = { x: anchor.x + Math.cos(lockRad) * len, y: anchor.y + Math.sin(lockRad) * len, deg: step };
          deg = step;
        }
      }
      lineAngle = deg;
    }

    let hoverId = pid;
    if (hoverId == null) hoverId = hitTestLine(sk, x, y, tol);
    if (hoverId == null) hoverId = hitTestCircle(sk, x, y, tol);
    if (hoverId == null) hoverId = hitTestArc(sk, x, y, tol);
    set({ cursor: { x, y }, snap, axisSnap, lineAngle, hoverId });
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
    const tol = get().pickTol || SNAP;
    const hit = hitTestPoint(sk, x, y, tol);
    if (hit != null) return hit;
    // Where two curves cross: place the point exactly on it and pin it to both,
    // so it tracks the intersection through solves. Checked before the plain rim
    // landing because it is the more specific target.
    const xn = nearestIntersection(sk, x, y, tol);
    if (xn) {
      const id = addPoint(sk, xn.x, xn.y);
      for (const entId of xn.ids) pinPointOn(sk, id, entId);
      return id;
    }
    // A circle/arc quadrant: place it on the rim and lock it to the quadrant with
    // a horizontal / vertical relation to the centre, so it stays a "high point"
    // through solves.
    const q = nearestQuadrant(sk, x, y, tol);
    if (q) {
      const id = addPoint(sk, q.x, q.y);
      pinPointOn(sk, id, q.id);
      try {
        addConstraint(sk, q.axis === 'v' ? 'vertical' : 'horizontal', [id, q.center]);
      } catch { /* a redundant relation is fine — the point is already placed */ }
      return id;
    }
    // A line-segment midpoint: pin it there with a `midpoint` relation so it
    // stays centred as the line changes.
    const mid = nearestMidpoint(sk, x, y, tol);
    if (mid) {
      const id = addPoint(sk, mid.x, mid.y);
      try { addConstraint(sk, 'midpoint', [id, mid.id]); } catch { /* leave it a plain point on the line */ }
      return id;
    }
    const rim = nearestRimPoint(sk, x, y, tol);
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
    set({ cursor: null, snap: null, axisSnap: null, lineAngle: null, hoverId: null });
  },

  /** Escape: drop the in-progress draw (line/rectangle/circle/arc) without committing it. */
  cancelPending() {
    if (get().pending != null || get().pending2 != null) {
      set({ pending: null, pending2: null, axisSnap: null, lineAngle: null });
    }
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

  // ---- Rubber-band (marquee) selection --------------------------------------
  //
  // Only the Select tool, and only from empty space (a point pointer-down starts
  // a drag-to-modify, which stops the event before it reaches the pick plane).
  // Left→right encloses; right→left also grabs anything the box touches —
  // SolidWorks' window / crossing rule. `Viewport` turns OrbitControls' left-drag
  // rotate off while the Select tool is active so the drag is ours to use.

  /** Arm a marquee at (x, y). Nothing shows until it grows past the click slop. */
  beginBoxSelect(x, y) {
    if (get().tool === 'select') set({ _boxStart: { x, y } });
  },

  /** Grow the armed marquee to (x, y); reveals it once it is bigger than a click. */
  updateBoxSelect(x, y) {
    const s = get()._boxStart;
    if (!s) return;
    if (!get().boxSelect && Math.hypot(x - s.x, y - s.y) < (get().pickTol || SNAP)) return;
    set({ boxSelect: { x0: s.x, y0: s.y, x1: x, y1: y } });
  },

  /**
   * Finish a marquee: replace the selection with what the box caught. Returns
   * true when a real box was committed (so the caller can eat the trailing
   * click), false for a bare press that never grew into one.
   */
  endBoxSelect() {
    const box = get().boxSelect;
    set({ boxSelect: null, _boxStart: null });
    if (!box) return false;
    const crossing = box.x1 < box.x0;
    set({ selection: entitiesInBox(get().sk, box.x0, box.y0, box.x1, box.y1, { crossing }) });
    return true;
  },

  cancelBoxSelect() {
    if (get().boxSelect || get()._boxStart) set({ boxSelect: null, _boxStart: null });
  },

  /** A pointer-down on the sketch plane at sketch coords (x, y). */
  clickAt(x, y) {
    const { sk, tool } = get();
    const tol = get().pickTol || SNAP;
    if (tool === 'point') {
      get()._snapshot();
      get()._pointAt(x, y);
      get()._bump();
    } else if (tool === 'line') {
      const { pending, snap, axisSnap } = get();
      if (pending == null) {
        set({ pending: get()._pointAt(x, y), axisSnap: null, lineAngle: null });
      } else {
        // Resolve the endpoint from the active snap so the click lands exactly where
        // the guides showed: tangent → point on the ring + a tangency constraint;
        // vertex → reuse it; rim → point on the ring; axis lock → the locked point;
        // otherwise the plain click (with its own vertex/rim snapping).
        let p;
        let tangentKind = null;
        let hvKind = null; // auto horizontal/vertical relation from an orthogonal axis lock
        if (snap?.tangent) {
          p = addPoint(sk, snap.x, snap.y);
          const onKind = snap.curveType === 'arc' ? 'pointOnArc' : 'pointOnCircle';
          try { addConstraint(sk, onKind, [p, snap.tangentOf]); } catch { /* leave endpoint free */ }
          tangentKind = { kind: snap.curveType === 'arc' ? 'tangentArc' : 'tangent', curve: snap.tangentOf };
        } else if (snap?.id != null) {
          p = snap.id;
        } else if (snap?.quadrant) {
          // A quadrant needs its horizontal/vertical-to-centre lock too, which
          // only `_pointAt` adds — so route it there rather than the plain
          // on-curve branch below.
          p = get()._pointAt(x, y);
        } else if (snap?.onCurve != null) {
          p = addPoint(sk, snap.x, snap.y);
          const onKind = snap.curveType === 'arc' ? 'pointOnArc' : 'pointOnCircle';
          try { addConstraint(sk, onKind, [p, snap.onCurve]); } catch { /* leave endpoint free */ }
        } else if (axisSnap) {
          p = addPoint(sk, axisSnap.x, axisSnap.y);
          // SolidWorks-style automatic relation: a line locked to a horizontal or
          // vertical axis gets a real Horizontal/Vertical constraint, so drawing
          // + dimensioning alone can fully define the sketch.
          if (axisSnap.deg === 0 || axisSnap.deg === 180) hvKind = 'horizontal';
          else if (axisSnap.deg === 90 || axisSnap.deg === 270) hvKind = 'vertical';
        } else {
          p = get()._pointAt(x, y);
        }
        if (p !== pending) {
          get()._snapshot();
          const line = addLine(sk, pending, p);
          if (tangentKind) {
            try { addConstraint(sk, tangentKind.kind, [line, tangentKind.curve]); } catch { /* skip if redundant */ }
          }
          if (hvKind) {
            try { addConstraint(sk, hvKind, [pending, p]); } catch { /* skip if redundant */ }
          }
        }
        set({ pending: null, snap: null, axisSnap: null, lineAngle: null });
        get()._bump();
        if (tangentKind || hvKind) get().solve();
      }
    } else if (tool === 'circle') {
      // Circle tool: first click sets the centre (held in `pending`, same as the
      // line tool); second click sets the radius from the distance to the centre.
      const { pending } = get();
      if (pending == null) {
        set({ pending: getOrCreatePoint(sk, x, y, tol) });
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
        set({ pending: getOrCreatePoint(sk, x, y, tol) });
      } else if (pending2 == null) {
        const s = getOrCreatePoint(sk, x, y, tol);
        if (s === pending) {
          set({ error: 'The start point landed on the centre — zoom in, or click further out.' });
        } else {
          set({ pending2: s, error: null });
        }
      } else {
        const center = sk.entities.get(pending);
        const start = sk.entities.get(pending2);
        const r = Math.hypot(start.x - center.x, start.y - center.y);
        const dx = x - center.x;
        const dy = y - center.y;
        const d = Math.hypot(dx, dy);
        if (r > 1e-6 && d > 1e-6) {
          const end = getOrCreatePoint(sk, center.x + (dx / d) * r, center.y + (dy / d) * r, tol);
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
    } else if (tool === 'slot') {
      // Slot tool — three clicks, the way SolidWorks draws a straight slot:
      // the two ends of the axis, then a point whose distance from that axis
      // sets the radius. Built as flanks + caps by `engine/sketch/shapes.js`.
      const { pending, pending2 } = get();
      if (pending == null) {
        set({ pending: getOrCreatePoint(sk, x, y, tol) });
      } else if (pending2 == null) {
        const s = getOrCreatePoint(sk, x, y, tol);
        // Zoomed far enough out, two clicks a few pixels apart are the same
        // point as far as the pick tolerance is concerned — which is right, but
        // absorbing the click without a word makes the tool look dead.
        if (s === pending) {
          set({ error: 'Both ends of the axis landed on one point — zoom in, or click further apart.' });
        } else {
          set({ pending2: s, error: null });
        }
      } else {
        const a = sk.entities.get(pending);
        const b = sk.entities.get(pending2);
        const r = axisDistance(x, y, a, b);
        get()._snapshot();
        const built = buildSlot(sk, a.x, a.y, b.x, b.y, r, tol);
        set({ pending: null, pending2: null });
        if (!built) {
          // Saying nothing is what this used to do, and three clicks that
          // produce silence read as a broken tool.
          get()._undoSnapshot();
          set({ error: r > 1e-6
            ? 'That slot is too small to build — click further from the axis.'
            : 'The third click sets the radius — click to one side of the axis, not on it.' });
          get()._bump();
          return;
        }
        get()._bump();
        get().solve();
        return;
      }
    } else if (tool === 'polygon') {
      // Polygon tool — centre, then a vertex, which sets size and rotation at
      // once. The side count is the toolbar's, not a third click.
      const { pending } = get();
      if (pending == null) {
        set({ pending: getOrCreatePoint(sk, x, y, tol) });
      } else {
        const c = sk.entities.get(pending);
        get()._snapshot();
        const built = buildPolygon(sk, c.x, c.y, x, y, get().polygonSides, tol);
        set({ pending: null });
        if (!built) {
          get()._undoSnapshot();
          set({ error: 'That polygon is too small to build — click further from the centre.' });
          get()._bump();
          return;
        }
        get()._bump();
        get().solve();
        return;
      }
    } else if (tool === 'rectangle') {
      // Rectangle tool: first click sets corner A; second click sets the opposite
      // corner. Builds 4 axis-aligned lines that *share* their corner points, plus
      // horizontal/vertical constraints so the solver keeps it a true rectangle.
      const { pending } = get();
      if (pending == null) {
        set({ pending: getOrCreatePoint(sk, x, y, tol) });
      } else {
        const a = sk.entities.get(pending);
        if (Math.abs(x - a.x) > 1e-6 && Math.abs(y - a.y) > 1e-6) {
          get()._snapshot();
          const b = getOrCreatePoint(sk, x, a.y, tol); // A→B along x
          const c = getOrCreatePoint(sk, x, y, tol); // opposite corner
          const d = getOrCreatePoint(sk, a.x, y, tol); // A→D along y
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
      const lineHit = hitTestLine(sk, x, y, tol);
      const circleHit = lineHit == null ? hitTestCircle(sk, x, y, tol) : null;
      const arcHit = lineHit == null && circleHit == null ? hitTestArc(sk, x, y, tol) : null;
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
      // Chamfer / fillet tool: pick the two elements that share a corner. Lines
      // take priority under the cursor, then arcs (so a fillet can round a
      // line↔arc or arc↔arc junction, not just line↔line). The inline
      // ChamferInput applies the size once two are picked. Empty space clears.
      const lineHit = hitTestLine(sk, x, y, tol);
      const arcHit = lineHit == null ? hitTestArc(sk, x, y, tol) : null;
      // Full circles are pickable too — not because a fillet can round one (it
      // has no corner), but so the tool can say *why* instead of ignoring the
      // click and looking broken.
      const circleHit = lineHit == null && arcHit == null ? hitTestCircle(sk, x, y, tol) : null;
      const hitId = lineHit ?? arcHit ?? circleHit;
      if (hitId != null) {
        // Remember where the pick landed — both the last one (which corner of a
        // multi-corner junction was meant) and per entity (which half of a whole
        // circle the user is pointing at, for an auto-trim fillet).
        set({ chamferPick: { x, y }, chamferPicks: { ...get().chamferPicks, [hitId]: { x, y } } });
        get().toggleSelect(hitId);
      } else set({ selection: [], chamferPicks: {} });
    } else {
      // select / dimension: points take priority over lines, then circles, under
      // the cursor; all route through toggleSelect. Empty space clears the
      // selection — except in dimension mode, where an empty click with a
      // dimensionable selection asks the view to prompt for a value.
      const hit = hitTestPoint(sk, x, y, tol);
      if (hit != null) { get().toggleSelect(hit); return; }
      const lineHit = hitTestLine(sk, x, y, tol);
      if (lineHit != null) { get().toggleSelect(lineHit); return; }
      const circleHit = hitTestCircle(sk, x, y, tol);
      if (circleHit != null) { get().toggleSelect(circleHit); return; }
      const arcHit = hitTestArc(sk, x, y, tol);
      if (arcHit != null) { get().toggleSelect(arcHit); return; }
      if (tool === 'dimension') {
        // Where the dimension is placed picks its orientation, the way
        // SolidWorks reads it off the drag: click below/above a pair for a
        // horizontal (dX) dimension, out to the side for a vertical (dY) one,
        // square off the line for the aligned true distance. The toggle in the
        // input still overrides it afterwards.
        let spec = get().resolveDimension();
        if (spec?.axial) {
          const axis = axisFromPlacement(sk, spec.refs[0], spec.refs[1], { x, y });
          if (axis !== get().dimensionAxis) {
            set({ dimensionAxis: axis });
            spec = get().resolveDimension() || spec;
          }
        }
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
    get().solve({ revertOnConflict: true });
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
    get().solve({ revertOnConflict: true });
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

    // A point-to-point dimension, measured along whichever axis `dimensionAxis`
    // selects. Refs are ordered so the value the user types is positive (a
    // dimension reads as a magnitude), since distanceX/Y are signed p2−p1.
    const p2p = (aId, bId, label) => {
      const axis = get().dimensionAxis;
      const a = sk.entities.get(aId);
      const b = sk.entities.get(bId);
      if (axis !== 'x' && axis !== 'y') {
        return { kind: 'distance', refs: [aId, bId], label, current: pdist(aId, bId), axial: true };
      }
      const d = axis === 'x' ? b.x - a.x : b.y - a.y;
      const refs = d < 0 ? [bId, aId] : [aId, bId];
      return {
        kind: axis === 'x' ? 'distanceX' : 'distanceY',
        refs, label: `${label} (${axis === 'x' ? 'dX' : 'dY'})`,
        current: Math.abs(d), axial: true,
      };
    };

    // A single non-origin point → dimension its distance to the origin, the most
    // common "locate this relative to the datum" case (2 points where one is the
    // origin works too, but that needs the origin explicitly picked).
    if (ents.length === 1 && ents[0].type === 'point' && !ents[0].origin && originId != null) {
      return p2p(originId, selection[0], 'To origin');
    }
    if (ents.length === 2 && ents.every((e) => e.type === 'point')) {
      return p2p(selection[0], selection[1], 'Distance');
    }
    if (ents.length === 1 && ents[0].type === 'line') {
      return p2p(ents[0].p1, ents[0].p2, 'Length');
    }
    if (ents.length === 1 && ents[0].type === 'circle') {
      // SolidWorks defaults a circle dimension to diameter (Ø); radius is still
      // available via the popover Radius button.
      return { kind: 'diameter', refs: [selection[0]], label: 'Diameter', prefix: 'Ø', current: ents[0].r * 2 };
    }
    if (ents.length === 1 && ents[0].type === 'arc') {
      return { kind: 'arcRadius', refs: [selection[0]], label: 'Radius', current: ents[0].r };
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
        // Show the intuitive interior angle at the corner (a 60° corner reads 60°,
        // not the 120° directed angle); carry sign/offset to convert on apply.
        const asp = angleSpec(sk, l1, l2);
        return {
          kind: 'angle', refs: [l1, l2], label: 'Angle', unit: '°', angular: true,
          current: asp.interiorDeg, angleSign: asp.sign, angleOffsetDeg: asp.offsetDeg,
        };
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
      return p2p(ents[0].center, ents[1].center, 'Centre ↔ centre');
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
      set({ error: 'Dimension needs 1 point (to origin), 2 points, 1 line, 1 circle, 1 arc, a point + line, 2 lines, a line + circle, or 2 circles' });
      return;
    }
    const { sk } = get();
    // Angular dimensions are entered as the interior corner angle (degrees) and
    // stored as the planegcs directed angle (radians); other dims store as-is.
    const modelValue = spec.angular
      ? interiorAngleToModel({ sign: spec.angleSign ?? 1, offsetDeg: spec.angleOffsetDeg ?? 0 }, value)
      : value;
    get()._snapshot();
    let idx;
    try {
      idx = addConstraint(sk, spec.kind, spec.refs, modelValue);
    } catch (e) {
      get()._undoSnapshot();
      set({ error: String(e?.message || e) });
      return;
    }
    set({ selection: [], error: null, dimensionPending: null });
    get()._bump();
    // If it over-defines, keep it as a driven (reference) dimension (SW default).
    get().solve({ drivenFallback: idx });
  },

  /** Dismiss the inline dimension input without applying. */
  cancelDimension() {
    set({ dimensionPending: null });
  },

  /**
   * Open the inline editor for an already-placed dimension (its index in
   * `sk.constraints`), seeding it with the current value — degrees for an angle,
   * mm otherwise. Non-dimensional constraints (no value) can't be edited. Driven
   * by double-clicking a dimension label in the viewport.
   */
  beginEditConstraint(index) {
    const c = get().sk.constraints[index];
    if (!c || c.value == null) return;
    const angular = c.kind === 'angle';
    const LABELS = { distance: 'Distance', distanceX: 'Horizontal', distanceY: 'Vertical', pointLineDistance: 'Distance', radius: 'Radius', arcRadius: 'Radius', diameter: 'Diameter', angle: 'Angle', lockX: 'Lock X', lockY: 'Lock Y' };
    // For an angle, seed the interior corner angle (what's shown) and carry the
    // conversion so applyEditConstraint stores the right planegcs value.
    const asp = angular ? angleSpec(get().sk, c.refs[0], c.refs[1]) : null;
    set({
      editingConstraint: {
        index, kind: c.kind, angular,
        label: LABELS[c.kind] || c.kind,
        value: angular ? (asp?.interiorDeg ?? c.value / DEG) : c.value,
        angleSign: asp?.sign ?? 1,
        angleOffsetDeg: asp?.offsetDeg ?? 0,
      },
    });
  },

  /**
   * Commit a new value for the dimension being edited (`editingConstraint`), then
   * re-solve. Angles are entered in degrees and stored in radians. The index is
   * re-validated against the live sketch (it may have shifted if a constraint was
   * removed meanwhile) before writing.
   */
  applyEditConstraint(value) {
    const ec = get().editingConstraint;
    if (!ec) return;
    const { sk } = get();
    const c = sk.constraints[ec.index];
    if (!c || c.kind !== ec.kind || c.value == null || !Number.isFinite(value)) {
      set({ editingConstraint: null });
      return;
    }
    get()._snapshot();
    c.value = ec.angular
      ? interiorAngleToModel({ sign: ec.angleSign ?? 1, offsetDeg: ec.angleOffsetDeg ?? 0 }, value)
      : value;
    set({ editingConstraint: null, error: null });
    get()._bump();
    get().solve({ revertOnConflict: true });
  },

  /** Dismiss the dimension edit input without applying. */
  cancelEditConstraint() {
    set({ editingConstraint: null });
  },

  /**
   * Flip an angular dimension's base/rotating line (swap refs[0]/refs[1]) and
   * re-read the current angle for the new order, so the seeded value stays
   * truthful. No-op for non-angular dimensions.
   */
  swapDimensionRefs() {
    const dp = get().dimensionPending;
    if (!dp || !dp.angular) return;
    const refs = [dp.refs[1], dp.refs[0]];
    const asp = angleSpec(get().sk, refs[0], refs[1]);
    set({ dimensionPending: { ...dp, refs, current: asp.interiorDeg, angleSign: asp.sign, angleOffsetDeg: asp.offsetDeg } });
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

  /**
   * Round a shared corner with a tangent arc of `radius`. Works on any pairing
   * that meets at a point: 2 lines (`fillet`), 1 line + 1 arc (`filletLineArc`),
   * or 2 arcs (`filletArcArc`) — so a fillet can be placed at a junction that
   * involves a curve, not just two straight edges.
   */
  fillet(radius) {
    const { sk, selection } = get();
    if (selection.length !== 2) {
      set({ error: 'Fillet needs exactly 2 elements (2 lines, 1 line + 1 arc, or 2 arcs)' });
      return;
    }
    const lines = selection.filter((id) => sk.entities.get(id)?.type === 'line');
    const arcs = selection.filter((id) => sk.entities.get(id)?.type === 'arc');
    const circles = selection.filter((id) => sk.entities.get(id)?.type === 'circle');
    // "Touching" = within the on-screen pick tolerance (so two endpoints drawn to
    // the same spot but never merged still count), clamped to a sane mm range.
    const touchTol = Math.min(Math.max(get().pickTol || 1.5, 0.75), 3);
    // Where the user last clicked in the tool — picks the corner when the two
    // curves meet at more than one (two trimmed circles meet at both crossings).
    const hint = get().chamferPick;
    if (circles.length === 2) {
      // Two whole circles: round where they cross and auto-trim both into arcs,
      // the way SolidWorks does — no need to trim by hand first. Which half of
      // each circle survives comes from where each was picked.
      get()._snapshot();
      const res = filletCircleCircleEdit(sk, circles[0], circles[1], radius, hint, get().chamferPicks);
      if (res == null) {
        get()._undoSnapshot();
        set({
          error: 'Those two circles don\'t cross, or R is too large to fit where they do — check they overlap and try a smaller radius.',
        });
        return;
      }
      set({ selection: [], error: null, chamferPicks: {} });
      get()._bump();
      get().solve();
      return;
    }
    if (circles.length) {
      // One circle paired with a line/arc: there's no crossing pair to trim
      // against, so this still needs a manual trim first.
      set({ error: 'A whole circle has no corner to round — trim it to an arc first, then apply R.' });
      return;
    }
    let run = null;
    // `meets` = do the two picks actually touch at a corner? (drives the message)
    let meets = true;
    if (lines.length === 2) run = (s) => filletEdit(s, lines[0], lines[1], radius);
    else if (lines.length === 1 && arcs.length === 1) {
      meets = lineArcMeet(sk, lines[0], arcs[0], touchTol);
      run = (s) => filletLineArcEdit(s, lines[0], arcs[0], radius, touchTol);
    } else if (arcs.length === 2) {
      meets = arcArcMeet(sk, arcs[0], arcs[1], touchTol);
      run = (s) => filletArcArcEdit(s, arcs[0], arcs[1], radius, touchTol, hint);
    } else { set({ error: 'Fillet needs 2 lines, 1 line + 1 arc, or 2 arcs' }); return; }
    get()._snapshot();
    const res = run(sk);
    if (res == null) {
      get()._undoSnapshot();
      // Tell the user which problem it is so it's fixable.
      set({
        error: meets
          ? `R${radius} is too large to fit that corner — try a smaller radius.`
          : "The two picks don't meet at a corner — trim them so they touch first (the arc's end must lie on the line).",
      });
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

  /**
   * Solve the whole sketch in the worker and adopt the result. With
   * `revertOnConflict`, a solve that actually **fails** (planegcs can't satisfy the
   * constraints — a genuine over-definition) is rolled back to the snapshot the
   * caller pushed and reported, like SolidWorks blocking an over-defining dimension.
   * A *redundant-but-consistent* constraint still solves (`success` stays true) and
   * is kept — SW allows those — even though planegcs lists it as conflicting; that's
   * why the test is `!success`, not `conflicting.length` (e.g. a tangent-locked
   * fillet stays put when you edit its radius).
   */
  async solve({ revertOnConflict = false, drivenFallback = null } = {}) {
    try {
      const res = await worker().solve(serialize(get().sk));
      const result = {
        success: res.success,
        status: res.status,
        conflicting: res.conflicting,
        redundant: res.redundant,
      };
      if (!res.success) {
        // SolidWorks "Make Dimension Driven?" (default yes): a new smart dimension
        // that would over-define is kept as a driven (reference) dimension instead
        // of being blocked, then re-solved clean.
        if (drivenFallback != null && get().sk.constraints[drivenFallback]) {
          get().sk.constraints[drivenFallback].driven = true;
          set({ error: 'Would over-define — kept as a driven (reference) dimension' });
          return get().solve();
        }
        if (revertOnConflict && get().past.length) {
          const past = get().past;
          set({
            sk: deserialize(past[past.length - 1]), // undo the offending constraint
            past: past.slice(0, -1),
            selection: [],
            error: 'That would over-define the sketch — constraint reverted',
            solveResult: result,
          });
          get()._bump();
          return;
        }
      }
      const solved = deserialize(res.sketch);
      // A driven (reference) dimension just reports — refresh its value to the
      // freshly solved geometry so it always shows the true measurement.
      for (const con of solved.constraints) {
        if (!con.driven) continue;
        const v = measureConstraint(solved, con.kind, con.refs);
        if (Number.isFinite(v)) con.value = v;
      }
      set({ sk: solved, solveResult: result });
      get()._bump();
    } catch (e) {
      set({ error: String(e?.message || e) });
    }
  },

  /**
   * Arm a drag on point `id` (SolidWorks drag-to-modify). The point is pinned
   * (temporarily fixed) so the live solve holds it under the cursor while the
   * rest of the sketch follows its constraints. No undo snapshot yet — that's
   * taken on the first actual move, so a click that never drags leaves the undo
   * stack clean. The origin (fixed datum) is never draggable. Returns true if a
   * drag started.
   */
  beginDrag(id) {
    const pt = get().sk.entities.get(id);
    if (!pt || pt.type !== 'point' || pt.origin) return false;
    set({ dragging: { id, wasFixed: !!pt.fixed, moved: false }, _dragTarget: null });
    pt.fixed = true;
    return true;
  },

  /** Update the drag target to (x, y) and kick the coalesced solve loop. */
  dragTo(x, y) {
    const d = get().dragging;
    if (!d) return;
    if (!d.moved) { get()._snapshot(); set({ dragging: { ...d, moved: true } }); }
    set({ _dragTarget: { x, y } });
    get()._dragSolveLoop();
  },

  /**
   * Solve repeatedly while the drag target keeps changing, coalescing rapid
   * pointer moves into as few worker round-trips as possible: each pass pins the
   * dragged point at the newest target and re-solves the rest. `_dragBusy` keeps
   * only one loop running at a time.
   */
  async _dragSolveLoop() {
    if (get()._dragBusy) return;
    set({ _dragBusy: true });
    try {
      while (get().dragging && get()._dragTarget) {
        const d = get().dragging;
        const t = get()._dragTarget;
        set({ _dragTarget: null });
        const sk = get().sk;
        const pt = sk.entities.get(d.id);
        if (!pt) break;
        pt.x = t.x; pt.y = t.y; pt.fixed = true;
        let res;
        try { res = await worker().solve(serialize(sk)); }
        catch (e) { set({ error: String(e?.message || e) }); break; }
        // Bail if the drag ended (or switched points) while we were solving.
        if (get().dragging?.id !== d.id) break;
        set({
          sk: deserialize(res.sketch),
          solveResult: { success: res.success, status: res.status, conflicting: res.conflicting, redundant: res.redundant },
        });
        get()._bump();
      }
    } finally {
      set({ _dragBusy: false });
    }
  },

  /**
   * End a drag. Restores the point's original fixed flag and clears drag state.
   * Returns whether the point actually moved, so the view can tell a drag from a
   * plain click (a no-move drag is treated as a selection click by the caller).
   */
  endDrag() {
    const d = get().dragging;
    if (!d) return false;
    const pt = get().sk.entities.get(d.id);
    if (pt) pt.fixed = d.wasFixed;
    set({ dragging: null, _dragTarget: null });
    get()._bump();
    // Settle once the pin is released: a genuinely free point stays where it was
    // dragged, but a fully-constrained one the drag deformed snaps back to satisfy
    // its constraints — matching how SolidWorks resists dragging defined geometry.
    if (d.moved) get().solve();
    return d.moved;
  },

  deleteSelected() {
    const { sk, selection } = get();
    // The origin is a fixed reference — never delete it.
    const ids = selection.filter((id) => !sk.entities.get(id)?.origin);
    if (!ids.length) { set({ selection: [] }); return; }
    get()._snapshot();
    ids.forEach((id) => deleteEntity(sk, id, true)); // prune dangling endpoints (SW-style)
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

  /**
   * Toggle the selected geometry between normal and **construction** (reference)
   * — SolidWorks construction geometry: still solvable/dimensionable, drawn dashed,
   * and left out of the extrude/revolve profile later. Points aren't toggled (the
   * origin/vertices are inherently reference). No solve needed (flag only).
   */
  toggleConstruction() {
    const { sk, selection } = get();
    const geom = selection.filter((id) => {
      const t = sk.entities.get(id)?.type;
      return t === 'line' || t === 'circle' || t === 'arc';
    });
    if (!geom.length) { set({ error: 'Select lines/circles/arcs to toggle construction' }); return; }
    get()._snapshot();
    // If any are normal, make all construction; else clear it (SW-like toggle).
    const makeConstruction = geom.some((id) => !sk.entities.get(id).construction);
    geom.forEach((id) => { sk.entities.get(id).construction = makeConstruction; });
    set({ error: null });
    get()._bump();
  },

  /**
   * Mirror the selected entities about an axis line (SW "Mirror Entities"). The
   * axis is a construction line in the selection if present (the usual SW setup),
   * else the single selected line; everything else in the selection is mirrored.
   */
  mirror() {
    const { sk, selection } = get();
    const lines = selection.filter((id) => sk.entities.get(id)?.type === 'line');
    const axis = lines.find((id) => sk.entities.get(id).construction) ?? (lines.length === 1 ? lines[0] : null);
    if (axis == null) {
      set({ error: 'Mirror needs one axis line (make it construction) plus entities to mirror' });
      return;
    }
    const toMirror = selection.filter((id) => id !== axis);
    if (!toMirror.length) { set({ error: 'Select entities to mirror (besides the axis line)' }); return; }
    get()._snapshot();
    const created = mirrorEdit(sk, toMirror, axis);
    if (!created) { get()._undoSnapshot(); set({ error: 'Nothing could be mirrored' }); return; }
    set({ selection: [], error: null });
    get()._bump();
    get().solve();
  },

  /**
   * Open the inline distance entry for Offset (the rail button). Offset is a
   * sketch *tool*, not a relation, so it lives on the toolbar and asks for its
   * distance the same way Chamfer/Dimension do.
   */
  beginOffset() {
    const { sk, selection } = get();
    const geom = selection.filter((id) => {
      const t = sk.entities.get(id)?.type;
      return t === 'line' || t === 'circle' || t === 'arc';
    });
    if (!geom.length) { set({ error: 'Select lines/circles/arcs to offset' }); return; }
    set({ offsetPending: true, error: null });
  },

  /** Dismiss the inline offset input without applying. */
  cancelOffset() {
    set({ offsetPending: false });
  },

  /** Offset the selected line(s)/circle(s)/arc(s) by signed distance `dist`. */
  offset(dist) {
    const { sk, selection } = get();
    const geom = selection.filter((id) => {
      const t = sk.entities.get(id)?.type;
      return t === 'line' || t === 'circle' || t === 'arc';
    });
    if (!geom.length) { set({ error: 'Select lines/circles/arcs to offset' }); return; }
    if (!(Number.isFinite(dist) && dist !== 0)) { set({ error: 'Offset needs a non-zero distance' }); return; }
    get()._snapshot();
    // `offsetChain`, not one `offsetEntity` per selection: offsetting a profile
    // entity by entity leaves a gap at every corner, because a line moved along
    // its own normal ends where it ended and nothing extends or trims it to
    // where the neighbour now runs. A selection that is not a chain falls
    // through it unchanged — see `engine/sketch/edit.js`.
    const created = offsetChain(sk, geom, dist);
    if (!created.length) { get()._undoSnapshot(); set({ error: 'Nothing could be offset (radius would collapse?)' }); return; }
    set({ selection: [], error: null, offsetPending: false });
    get()._bump();
    get().solve();
  },

  /**
   * Toggle a dimension between driving and **driven** (reference) — SolidWorks lets
   * a dimension merely report a measurement (removes no DOF) instead of forcing it,
   * the standard way out of an over-definition. Only dimensional constraints can be
   * driven.
   */
  toggleDriven(index) {
    const { sk } = get();
    const c = sk.constraints[index];
    if (!c || c.value == null) { set({ error: 'Only a dimension can be driven' }); return; }
    get()._snapshot();
    c.driven = !c.driven;
    set({ error: null });
    get()._bump();
    get().solve();
  },

  /**
   * Slide a placed dimension (its line and value together) to `offset`, in
   * sketch units, from where the annotation would otherwise draw it. The offset
   * is **projected onto the dimension's own axis** (`dimensionLockDir`), so a
   * horizontal dimension can only move its standoff, a radius only along its
   * leader, etc. — the caller passes the raw pointer delta and this constrains
   * it. Purely how the dimension is *shown* — no DOF, no solve — but it lives on
   * the constraint so it is saved and undoable like any other edit.
   *
   * The drag emits one call per pointer move; `snapshot` is true only on the
   * first of a gesture, so a whole drag collapses to one undo step (the same
   * trick the point drag uses).
   */
  setDimensionOffset(index, offset, { snapshot = true } = {}) {
    const { sk } = get();
    const c = sk.constraints[index];
    if (!c || c.value == null) return;
    if (snapshot) get()._snapshot();
    c.labelOffset = projectOnto(offset, dimensionLockDir(sk, c.kind, c.refs));
    get()._bump();
  },

  loadDemo() {
    get()._snapshot();
    const doc = demoSketch();
    set({ sk: doc, sketches: get()._docs(doc), selection: [], pending: null, pending2: null, snap: null, solveResult: null, error: null });
    get()._bump();
  },

  clear() {
    get()._snapshot();
    const doc = newSketch();
    set({ sk: doc, sketches: get()._docs(doc), selection: [], pending: null, pending2: null, snap: null, solveResult: null, error: null });
    get()._bump();
  },

  /**
   * Replace the sketch with one loaded from a project file (the serialized form
   * `model.serialize` produces). Snapshotted like any other mutation, so opening
   * a project can be undone. Returns false if the data won't deserialize.
   */
  loadSerialized(data) {
    let sk;
    try {
      sk = deserialize(data);
    } catch (e) {
      set({ error: `Could not read the sketch in that project: ${e?.message || e}` });
      return false;
    }
    get()._snapshot();
    set({
      sk, sketches: get()._docs(sk),
      selection: [], pending: null, pending2: null, snap: null,
      solveResult: null, error: null, dimensionPending: null, editingConstraint: null,
    });
    get()._bump();
    return true;
  },

  /**
   * Import a DXF as a new sketch on the current plane.
   *
   * A **new** sketch rather than merged into the open one: an imported drawing
   * arrives with its own origin and its own coordinates, and dropping it on top
   * of existing geometry produces overlaps nobody asked for. Starting a sketch
   * for it is reversible in one click; untangling a merge is not.
   *
   * Returns the summary so the caller can say what arrived, warnings included —
   * a file with splines in it imports its lines *and* has to say the splines
   * were left out, or the operator machines a part with a side missing.
   */
  importDxf(text, { name = 'DXF', plane = null } = {}) {
    let result;
    try {
      result = dxfToSketch(text);
    } catch (e) {
      set({ error: e?.message || String(e) });
      return null;
    }
    const id = get().addSketch({
      name,
      plane: plane || get().activeSketch()?.plane || DEFAULT_PLANE,
    });
    set({
      sk: result.sk,
      sketches: get()._docs(result.sk),
      error: result.warnings.length ? result.warnings.join(' ') : null,
    });
    get()._bump();
    return { ...result, id };
  },

  /**
   * What the active sketch would build: its closed regions, plus what is stopping
   * the rest of it from counting. Cheap and pure, so the toolbar can call it on
   * every render to decide whether Extrude is offered and what to say when it is
   * not.
   */
  regions(combine = null) {
    const found = sketchRegions(get().sk);
    if (!combine || found.regions.length < 2) return found;
    try {
      return { ...found, regions: combineRegions(found.regions, combine) };
    } catch (e) {
      // A bad op is a programming error, not something to take the panel down
      // for; report it where every other sketch failure is reported.
      set({ error: e?.message || String(e) });
      return found;
    }
  },

  /**
   * Every sketch, as a project file carries them: the document plus the plane it
   * belongs on. `sketch` (singular) stays in the file alongside this for the
   * benefit of an older build — see `projectFile.js`.
   */
  serializeSketches() {
    const { sketches, activeId } = get();
    return {
      active: activeId,
      // Undo history is deliberately **not** written. It is a stack of whole
      // serialized documents — the largest thing in the store by far — and it
      // means nothing in a session that has not happened yet.
      items: sketches.map((s) => ({
        id: s.id, name: s.name, plane: s.plane, doc: serialize(s.doc),
      })),
    };
  },

  /**
   * Replace every sketch from a project file. Falsy input leaves the store
   * alone, so opening a v1/v2 project (which carries one sketch and no list)
   * goes through `loadSerialized` as it always did.
   */
  loadSketches(data) {
    const items = Array.isArray(data?.items) ? data.items : null;
    if (!items || !items.length) return false;
    const sketches = [];
    // Ids have to come out unique whatever the file says. They are what every
    // action addresses a sketch by, so two entries sharing one means editing
    // either edits neither predictably — and `removeSketch` would take both.
    const taken = new Set();
    let free = 1;
    const claim = (want) => {
      if (Number.isFinite(want) && want > 0 && !taken.has(want)) { taken.add(want); return want; }
      while (taken.has(free)) free += 1;
      taken.add(free);
      return free;
    };
    const remap = new Map();
    try {
      items.forEach((raw, i) => {
        const id = claim(raw.id);
        if (Number.isFinite(raw.id)) remap.set(raw.id, remap.has(raw.id) ? remap.get(raw.id) : id);
        sketches.push({
          id,
          name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : `Sketch${i + 1}`,
          plane: parsePlane(raw.plane),
          doc: deserialize(raw.doc),
          past: [],
          future: [],
        });
      });
    } catch (e) {
      set({ error: `Could not read the sketches in that project: ${e?.message || e}` });
      return false;
    }
    const wantActive = remap.has(data.active) ? remap.get(data.active) : data.active;
    const active = sketches.find((s) => s.id === wantActive) || sketches[0];
    set({
      sketches,
      activeId: active.id,
      nextSketchId: Math.max(...sketches.map((s) => s.id)) + 1,
      sk: active.doc,
      past: [], future: [],
      selection: [], pending: null, pending2: null, snap: null, axisSnap: null,
      lineAngle: null, solveResult: null, error: null,
      dimensionPending: null, editingConstraint: null,
    });
    get()._bump();
    return true;
  },
}));
