/**
 * The feature tree, as the app holds it.
 *
 * `engine/solid/featureTree.js` is the pure replay; this is the list, the edits
 * to it, and the wiring that turns a rebuild into the part on the machine.
 *
 * ## Why this is its own store
 *
 * A feature reads a **sketch** and produces the **part**, so it sits downstream
 * of both: `featureStore → sketchStore` and `featureStore → camPlanStore`, and
 * neither of those learns about features. Putting the tree in either one would
 * have made the import cycle real — `sketchStore` already imports `camPlanStore`
 * — and cycles between zustand stores are the kind of thing that works until the
 * bundler reorders two modules.
 *
 * ## Rebuild is a button, not a subscription
 *
 * Editing a sketch marks the tree **dirty**; it does not rebuild it. Rebuilding
 * on every change sounds better and is not: dragging one point in a sketch emits
 * a solve per frame, and a tree with a solid boolean in it would fire a CSG
 * evaluation per frame with it. SolidWorks lights up a rebuild button for the
 * same reason. The one exception is a sketch the Hole Wizard has drilled and left
 * open: its holes follow its points (`scheduleHoleRebuild`). Wider auto-rebuild is
 * a later option, debounced on solve completion —
 * the plumbing for it is `dirty` plus `rebuild()`.
 *
 * The mesh boolean is `import()`ed on demand, and only when the tree actually
 * needs one (`needsMeshBoolean`), so a session of plain extrudes never downloads
 * the CSG chunk.
 */
import { create } from 'zustand';
import {
  createFeature, parseFeatures, rebuildFeatures, needsMeshBoolean, seedFeatureIds,
} from '../engine/solid/featureTree.js';
import { holePointIds, unusedHoleSites } from '../engine/solid/hole.js';
import { openFaceRef } from '../engine/solid/shell.js';
import { linkFaceToSolids, planeBasis } from '../engine/sketch/plane.js';
import { isSketchableFace } from '../engine/mesh/sketchFace.js';
import { useSketchStore } from './sketchStore.js';
import { useCamPlanStore, getMesh, getRawMesh } from './camPlanStore.js';
import { useCamStore } from './camStore.js';
import { useEdgeTreatStore } from './edgeTreatStore.js';
import { useMeasureStore } from './measureStore.js';

const MAX_FOLLOW_PASSES = 3; // two is the normal case; the limit is for sketches that chase each other

const usedSketchIds = (features) => features.map((f) => f.sketchId).filter((id) => id != null);

/** A set view rather than `normalTo`, which turns to the far side if already square. */
function lookSquareAt(plane) {
  const { n, v } = planeBasis(plane);
  useCamStore.getState().setViewPreset({ dir: [...n], up: [...v] });
}

/** Close the open sketch; on the Sketch page, back to a view that shows all three planes. */
function closeOpenSketch() {
  if (useSketchStore.getState().closeSketch() && useCamStore.getState().page === 'sketch') {
    useCamStore.getState().setViewPreset('iso');
  }
}

/**
 * Soups for `import` features, by feature id.
 *
 * Module-level rather than in the store for the reason `camPlanStore` keeps its
 * meshes outside too: these are large `Float32Array`s that nothing renders from
 * directly, and putting them in state makes every subscriber re-render when a
 * part is swapped.
 */
const _imports = new Map();

/** How many tree states Undo can go back through. */
const HISTORY_LIMIT = 100;
/** Edits to the same field of the same feature closer together than this are one step (typing a number). */
const COALESCE_MS = 1500;
let _lastRecord = { key: null, at: 0 };

/**
 * The docked left column's open width, in px.
 *
 * It carries both the feature tree and the Program listing (`LeftColumn`), and
 * those want different room — a line of G-code is ~40 monospace chars. So the
 * edge is draggable (`App.jsx` puts the handle on it) rather than a fixed
 * number, `TREE_W_DEFAULT` is only the starting point, and the last size is
 * mirrored to localStorage. Every localStorage access is wrapped: a browser in
 * private mode can throw on the property itself, not just on read/write.
 */
export const TREE_W_DEFAULT = 420;
export const TREE_W_MIN = 280;
export const TREE_W_MAX = 760;
const TREE_W_KEY = 'cam.treeWidth';

function clampTreeWidth(px) {
  return Math.round(Math.min(TREE_W_MAX, Math.max(TREE_W_MIN, px)));
}

function readStoredTreeWidth() {
  try {
    const v = Number(window.localStorage.getItem(TREE_W_KEY));
    if (Number.isFinite(v) && v > 0) return clampTreeWidth(v);
  } catch { /* private mode, or no window */ }
  return TREE_W_DEFAULT;
}

export const useFeatureStore = create((set, get) => ({
  features: [],
  /** The tree has changed, or a sketch under it has, since the last rebuild. */
  dirty: false,
  building: false,
  shellPick: null, // { faces } while Shell waits for the faces to leave open
  /** Per-feature outcome of the last rebuild, and the failures among them. */
  steps: [],
  errors: [],
  selectedId: null,
  /**
   * Whether the docked tree is showing.
   *
   * In the store rather than the component because the sketch rail has to move
   * out of its way — the two both live at the top-left of the viewport and
   * overlapped otherwise. One piece of shared state is cheaper than either
   * measuring the other's box or nesting them.
   */
  treeOpen: true,
  setTreeOpen(treeOpen) { set({ treeOpen }); },

  /** The open column's width in px — see the notes on `TREE_W_DEFAULT`. */
  treeWidth: readStoredTreeWidth(),
  setTreeWidth(px) {
    const treeWidth = clampTreeWidth(px);
    if (treeWidth === get().treeWidth) return;
    set({ treeWidth });
    try { window.localStorage.setItem(TREE_W_KEY, String(treeWidth)); } catch { /* private mode */ }
  },

  markDirty() {
    if (!get().dirty) set({ dirty: true });
  },

  select(id) { set({ selectedId: id }); },

  // ── Undo / Redo of the tree ───────────────────────────────────────────────
  // Every change to the list of features — adding, editing, deleting, moving,
  // suppressing — is a step. The sketcher keeps its own history for what is
  // drawn; this is the tree's. Features are immutable (an edit makes a new
  // object), so a step is just the array as it was.
  past: [],
  future: [],

  /**
   * Remember the tree as it is now, before a change. `key` names the change so
   * that a run of the same edit (one number typed a digit at a time) is one step.
   */
  _record(key = null) {
    const now = Date.now();
    if (key && key === _lastRecord.key && now - _lastRecord.at < COALESCE_MS) {
      _lastRecord.at = now;
      return;
    }
    _lastRecord = { key, at: now };
    set({ past: [...get().past, get().features].slice(-HISTORY_LIMIT), future: [] });
  },

  /** Take back the last `n` steps recorded without making them undoable — a build that failed and was put back. */
  _discard(n = 1) {
    const { past } = get();
    _lastRecord = { key: null, at: 0 };
    set({ past: past.slice(0, Math.max(0, past.length - n)) });
  },

  canUndo() { return get().past.length > 0; },
  canRedo() { return get().future.length > 0; },

  /** Step back one change to the tree, and rebuild the part to match. */
  async undo() {
    const { past, future, features } = get();
    if (!past.length) return null;
    _lastRecord = { key: null, at: 0 };
    const prev = past[past.length - 1];
    set({
      past: past.slice(0, -1),
      future: [...future, features],
      features: prev,
      dirty: true,
      selectedId: prev.some((f) => f.id === get().selectedId) ? get().selectedId : null,
    });
    return get().rebuild();
  },

  /** Step forward again after an undo. */
  async redo() {
    const { past, future, features } = get();
    if (!future.length) return null;
    _lastRecord = { key: null, at: 0 };
    const next = future[future.length - 1];
    set({
      past: [...past, features],
      future: future.slice(0, -1),
      features: next,
      dirty: true,
      selectedId: next.some((f) => f.id === get().selectedId) ? get().selectedId : null,
    });
    return get().rebuild();
  },

  /** Append a feature and return it. */
  addFeature(kind, props = {}) {
    const feature = createFeature(kind, props);
    get()._record();
    set({ features: get().features.concat([feature]), dirty: true, selectedId: feature.id });
    return feature;
  },

  /** Change a feature's parameters. Anything not named is left alone. */
  updateFeature(id, patch) {
    let found = false;
    const features = get().features.map((f) => {
      if (f.id !== id) return f;
      found = true;
      // Rebuilt through `createFeature` so a patch cannot introduce a field the
      // replay does not understand, or a merge mode that is not one.
      return createFeature(f.kind, { ...f, ...patch, id: f.id });
    });
    if (!found) return false;
    get()._record(`update:${id}:${Object.keys(patch).sort().join(',')}`);
    set({ features, dirty: true });
    return true;
  },

  removeFeature(id) {
    const features = get().features.filter((f) => f.id !== id);
    if (features.length === get().features.length) return false;
    // An imported mesh is kept (not dropped from `_imports`): Undo can bring its
    // feature back. `clear` and `load` forget them.
    get()._record();
    set({
      features,
      dirty: true,
      selectedId: get().selectedId === id ? null : get().selectedId,
    });
    return true;
  },

  /** Move a feature `delta` places. Order is not decoration — a cut before the
   *  thing it cuts into does something different. */
  moveFeature(id, delta) {
    const features = get().features.slice();
    const at = features.findIndex((f) => f.id === id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= features.length) return false;
    const [f] = features.splice(at, 1);
    features.splice(to, 0, f);
    get()._record();
    set({ features, dirty: true });
    return true;
  },

  toggleSuppress(id) {
    return get().updateFeature(id, { suppressed: !get().features.find((f) => f.id === id)?.suppressed });
  },

  /**
   * Record the mesh a file was just imported into as the base of the tree.
   *
   * Called after `camPlanStore.loadPart`. It replaces any existing import
   * feature: a second file is a different job, not another body.
   */
  captureImport(soup, name) {
    if (!soup?.triangleCount) return null;
    const kept = get().features.filter((f) => {
      if (f.kind !== 'import') return true;
      _imports.delete(f.id);
      return false;
    });
    const feature = createFeature('import', { name: name || 'Imported mesh' });
    _imports.set(feature.id, soup);
    get()._record();
    set({ features: [feature, ...kept], dirty: true });
    return feature;
  },

  /** The soup behind an import feature, for the replay. */
  importSoup(feature) { return _imports.get(feature.id) || null; },

  /**
   * Read a part file and make it the base of the tree.
   *
   * The single door for importing, so a file can never arrive without the tree
   * hearing about it — `camPlanStore` cannot do this itself without importing
   * this store, and that is the cycle this store exists to avoid.
   */
  async importPart(file) {
    const analysis = await useCamPlanStore.getState().loadPart(file);
    if (!analysis) return null;
    get().captureImport(getMesh().soup, file?.name || 'Imported mesh');
    // The mesh *is* the current part already; nothing is stale until something
    // is built on top of it.
    set({ dirty: false, steps: [], errors: [] });
    return analysis;
  },

  /**
   * Build the active sketch and add it to the tree.
   *
   * This is what the Build button does, and it is the **only** way a solid gets
   * made: a one-shot build that left no feature behind would mean the tree and
   * the part disagreed the moment it was used, and a tree that does not describe
   * the part on the machine is worse than no tree.
   *
   * Failures are reported on the sketcher's own error line, which is where every
   * other sketch problem already appears.
   */
  async buildFromSketch({
    op = 'extrude', combine = null, merge = 'new', name, ...params
  } = {}) {
    const sketch = useSketchStore.getState();
    const entry = sketch.activeSketch();
    if (!entry) return null;

    // Checked before a feature is created, so a build that cannot work leaves
    // nothing behind in the tree to clean up.
    const { regions, open } = sketch.regions(combine);
    if (!regions.length) {
      // Three different things, needing three different fixes: the combination
      // ate everything, the profile does not close, or nothing is drawn.
      const drew = sketch.regions(null).regions.length > 0;
      if (combine && drew) {
        sketch.setError(`Nothing left after ${combine} — the profiles do not overlap the way that needs.`);
      } else {
        sketch.setError(`Nothing to build. ${open.length
          ? 'The profile is not closed — the ends of some lines do not meet.'
          : 'Draw a closed profile first.'}`);
      }
      return null;
    }
    if (merge !== 'new' && !get().features.length) {
      sketch.setError('There is nothing on the machine yet to combine with — build the first solid on its own.');
      return null;
    }

    const snapshot = get().features;
    const feature = get().addFeature(op, {
      ...params,
      sketchId: entry.id,
      combine,
      merge,
      name: name || `${op === 'revolve' ? 'Revolve' : 'Extrude'} · ${entry.name}`,
    });
    const analysis = await get().rebuild();
    const failed = get().errors.find((e) => e.id === feature.id);
    if (failed) {
      // Its own build failed, so the feature describes nothing — drop it rather
      // than leave a permanently broken entry in the tree, or an Undo step.
      set({ features: snapshot, selectedId: null });
      get()._discard(1);
      sketch.setError(`Could not build: ${failed.message}`);
      await get().rebuild();
      return null;
    }
    sketch.setError(null);
    closeOpenSketch();
    return analysis;
  },

  /**
   * Hole Wizard: holes of one kind at the points picked on the open sketch. The
   * sketch stays open while it has points no hole has used, for the next kind.
   *
   * Not `buildFromSketch`: a hole needs positions, not a closed profile, and it
   * always cuts the part already on the machine. A hole that cannot be made is
   * dropped from the tree with the reason, the same as a build that fails.
   */
  async buildHole({ name, ...params } = {}) {
    const sketch = useSketchStore.getState();
    const entry = sketch.activeSketch();
    if (!entry) return null;
    if (!get().features.length) {
      sketch.setError('There is no part yet to put a hole in — build or import one first.');
      return null;
    }
    const pointIds = holePointIds(sketch.sk, sketch.selection);
    if (!pointIds.length) {
      sketch.setError('Click the points where these holes go — or circles, and their centres are used.');
      return null;
    }
    const snapshot = get().features;
    const feature = get().addFeature('hole', {
      ...params, pointIds, sketchId: entry.id, name: name || `Hole · ${entry.name}`,
    });
    const analysis = await get().rebuild();
    const failed = get().errors.find((e) => e.id === feature.id);
    if (failed) {
      set({ features: snapshot, selectedId: null });
      get()._discard(1);
      sketch.setError(`Could not make the hole: ${failed.message}`);
      await get().rebuild();
      return null;
    }
    sketch.setError(null);
    useSketchStore.setState({ selection: [] });
    const holes = get().features.filter((f) => f.kind === 'hole' && f.sketchId === entry.id);
    if (!unusedHoleSites(entry.doc, holes.map((f) => f.pointIds)).length) closeOpenSketch();
    return analysis;
  },

  /**
   * Add a Pattern or Mirror and rebuild. One that cannot build is taken back
   * out again; its message is returned (null when it built).
   */
  async buildPattern(props) {
    return get().buildOnPart('pattern', props);
  },

  /** `buildPattern` for any feature that works on the part rather than a sketch. */
  async buildOnPart(kind, props) {
    const snapshot = get().features;
    const feature = get().addFeature(kind, props);
    await get().rebuild();
    const failed = get().errors.find((e) => e.id === feature.id);
    if (!failed) return null;
    set({ features: snapshot, selectedId: null });
    get()._discard(1);
    await get().rebuild();
    return failed.message;
  },

  /**
   * Shell: picking the faces to leave open. `shellPick.faces` holds each picked
   * face's stored reference and, for drawing it lit, its triangles in the part as
   * it is now — valid only until the next rebuild, which is why picking ends there.
   */
  async startShellPick() {
    if (useSketchStore.getState().sketchOpen) await get().finishSketch();
    useMeasureStore.getState().stop();
    useCamStore.getState().setPage('sketch');
    set({ shellPick: { faces: [] } });
  },

  toggleShellFace(face) {
    const pick = get().shellPick;
    const ref = openFaceRef(face);
    if (!pick || !ref) return;
    const key = JSON.stringify(ref);
    const has = pick.faces.some((f) => f.key === key);
    set({
      shellPick: {
        faces: has ? pick.faces.filter((f) => f.key !== key) : [...pick.faces, { key, ref, triangles: face.triangles }],
      },
    });
  },

  stopShellPick() {
    if (get().shellPick) set({ shellPick: null });
  },

  /**
   * Begin picking edges for a Chamfer or Fillet (or for `feature` again). Edges
   * are picked on the part as built, so the Sketch page is shown, with any open
   * sketch closed first — its clicks would otherwise land on the sketch.
   */
  async startEdgeTreatment(kind, feature = null) {
    if (useSketchStore.getState().sketchOpen) await get().finishSketch();
    useMeasureStore.getState().stop();
    useCamStore.getState().setPage('sketch');
    useEdgeTreatStore.getState().start(kind, feature);
  },

  /**
   * Chamfer / Fillet: the edges picked in `useEdgeTreatStore`, as a new feature
   * or onto the one being edited. One that cannot be made is left out of the
   * tree (or put back as it was) and the reason shown in the panel.
   */
  async buildEdgeTreatment() {
    const pick = useEdgeTreatStore.getState();
    const { active: kind, size, edges, editingId } = pick;
    if (!kind) return null;
    if (!edges.length) {
      pick.setError('Click the edges to treat first.');
      return null;
    }
    const before = editingId != null ? get().features.find((f) => f.id === editingId) : null;
    const snapshot = get().features;
    let feature;
    if (before) {
      get().updateFeature(editingId, { size, edges });
      feature = before;
    } else {
      const n = get().features.filter((f) => f.kind === kind).length + 1;
      feature = get().addFeature(kind, {
        size, edges, name: `${kind === 'fillet' ? 'Fillet' : 'Chamfer'}${n}`,
      });
    }
    const analysis = await get().rebuild();
    const failed = get().errors.find((e) => e.id === feature.id);
    if (failed) {
      set({ features: snapshot });
      get()._discard(1);
      await get().rebuild();
      useEdgeTreatStore.getState().setError(`Could not make the ${kind}: ${failed.message}`);
      return null;
    }
    useEdgeTreatStore.getState().stop();
    return analysis;
  },

  /** Picked a plane: a new sketch on it, opened and seen square. */
  startSketch(plane) {
    const id = useSketchStore.getState().beginSketch({ plane, keep: usedSketchIds(get().features) });
    lookSquareAt(useSketchStore.getState().activeSketch().plane);
    return id;
  },

  /** Open a sketch for editing, from whichever page the tree was clicked on. */
  editSketch(id) {
    if (!useSketchStore.getState().openSketch(id)) return false;
    useCamStore.getState().setPage('sketch');
    lookSquareAt(useSketchStore.getState().activeSketch().plane);
    return true;
  },

  /** Done with the sketch: close it, and bring the part up to date with any edit. */
  async finishSketch() {
    closeOpenSketch();
    return get().dirty && get().features.length ? get().rebuild() : null;
  },

  /**
   * Replay the tree and put the result on the machine.
   *
   * The datum and the current page are **kept**: this is the same part
   * recomputed, not a new one arriving, and losing the origin every time a
   * dimension changed would make the feature tree worse than not having one.
   */
  async rebuild(pass = 0) {
    const { features } = get();
    if (!features.length) {
      set({ dirty: false, steps: [], errors: [] });
      return null;
    }
    set({ building: true });
    try {
      const sketch = useSketchStore.getState();
      const meshBefore = getRawMesh().welded;
      const planesBefore = new Map(sketch.sketches.map((s) => [s.id, s.plane]));
      let meshBoolean;
      if (needsMeshBoolean(features)) {
        try {
          meshBoolean = await (await import('../lib/csg.js')).loadMeshBoolean();
        } catch (e) {
          // The solid boolean is a lazily-loaded chunk, so this is the one part
          // of a rebuild that can fail for a reason nothing on this page did —
          // the file not reaching the host, or the network dropping mid-fetch.
          // `cam-deploy.md` describes the same shape of failure for the wasm.
          // Left to reject it would surface as an unhandled promise and no
          // message at all.
          const message = `Could not load the solid boolean (${e?.message || e}). Reload the page; if it persists the deploy is missing a file.`;
          set({ errors: [{ id: null, name: 'Rebuild', message }], dirty: true });
          useSketchStore.getState().setError(message);
          return null;
        }
      }
      const {
        soup, steps, errors, planes, holes,
      } = rebuildFeatures(features, {
        sketchOf: (id) => {
          const entry = sketch.sketches.find((s) => s.id === id);
          return entry ? { doc: entry.doc, plane: entry.plane } : null;
        },
        sketchList: () => sketch.sketches.map((s) => ({ id: s.id, plane: s.plane })),
        importOf: (f) => get().importSoup(f),
        meshBoolean,
      });
      // Sketches placed on a feature's face follow it: write the plane they were
      // just built on back onto them, so what is drawn sits where the solid is.
      // `setSketchPlane` bumps the sketcher's version, which marks the tree
      // dirty — hence `dirty: false` is set AFTER this, not before.
      for (const [sketchId, plane] of planes) {
        useSketchStore.getState().setSketchPlane(sketchId, plane);
      }
      set({ steps, errors, dirty: false });
      if (!soup) return null;
      const name = features.filter((f) => !f.suppressed).length > 1
        ? `${features[0].name} +${features.filter((f) => !f.suppressed).length - 1}`
        : features[0].name;
      const analysis = await useCamPlanStore.getState().loadSoup(soup, name, {
        keepDatum: true,
        keepPage: true,
        cad: { holes },
      });
      // Dimensions taken to the part's edges: a sketch they moved may be what a
      // later feature is built from, and that feature was just built from it as
      // it was. Replay once more; the second pass finds nothing further to move.
      const { moved, lost } = await useSketchStore.getState().followPartChange(meshBefore, planesBefore);
      if (lost) {
        useSketchStore.getState().setError(`${lost} dimension reference${lost > 1 ? 's' : ''} lost: the part edge is gone. Kept where it was.`);
      }
      const used = usedSketchIds(features);
      if (moved.some((id) => used.includes(id)) && pass < MAX_FOLLOW_PASSES) return await get().rebuild(pass + 1);
      return analysis;
    } catch (e) {
      // A rebuild replays arbitrary geometry; anything it throws that the
      // per-feature handling did not already catch becomes a message rather
      // than a rejection nobody is waiting for.
      const message = e?.message || String(e);
      set({ errors: [{ id: null, name: 'Rebuild', message }], dirty: true });
      useSketchStore.getState().setError(`Rebuild failed: ${message}`);
      return null;
    } finally {
      set({ building: false });
    }
  },

  /**
   * "Sketch on the picked face", and link it to the feature that made the face.
   *
   * The sketcher's own `sketchOnFace` resolves the face to a plane and stops
   * there — it cannot know about features (see the note at the top of this file).
   * This wraps it: when the face is an axis-aligned end of one feature's solid,
   * the plane also records which, so changing that feature later moves the sketch
   * with it on the next rebuild. A face that is not (angled, or no feature built
   * yet) behaves exactly as before.
   *
   * @returns the sketch id, or null when no face is picked
   */
  sketchOnFace(opts) {
    // The picked face is in the frame on screen (laid down, datum-shifted); the
    // solids' bounds — and the sketch itself — are in the raw frame. Both the
    // plane and the link are made from the RAW face, so they cannot disagree and
    // the sketch sits where the solid really is however the part is laid down.
    // (Taking the plane from the displayed face was right only while the two
    // frames agreed; a taller extrude is laid down on another face entirely.)
    // A face picked on the Sketch page is already in the raw frame: that page
    // draws the part as built (`opts.face`).
    const cam = useCamPlanStore.getState();
    // A face chosen on a machining page may be one strip of a bore or a fillet;
    // that is not a face to sketch on (see `isSketchableFace`).
    if (!opts?.face && cam.selectedFeature?.triangles && getMesh().welded
      && !isSketchableFace(getMesh().welded, cam.selectedFeature)) {
      useSketchStore.getState().setError('That is part of a round surface — pick a flat face to sketch on.');
      return null;
    }
    const face = opts?.face ?? cam.faceInRawFrame(cam.selectedFeature);
    const keep = usedSketchIds(get().features);
    const id = useSketchStore.getState().sketchOnFace({ ...opts, face, keep });
    if (id == null) return null;
    // `common` is left out: its result is the overlap of two solids, so neither
    // solid's bounds are the faces on the part.
    const solids = get().steps
      .filter((s) => s.ok && !s.suppressed && s.bounds && s.merge !== 'common')
      .map((s) => ({ id: s.id, bounds: s.bounds, cut: s.merge === 'cut' }));
    const ref = linkFaceToSolids(face, solids);
    if (ref) {
      const sketch = useSketchStore.getState();
      const entry = sketch.sketches.find((s) => s.id === id);
      if (entry) sketch.setSketchPlane(id, { ...entry.plane, ref });
    }
    return id;
  },

  /** The tree as a project file carries it. Imported soups are not repeated
   *  here — `camPlanStore.serializeSetup` already writes the part's triangles. */
  serialize() {
    return get().features.map((f) => ({ ...f }));
  },

  /**
   * Replace the tree from a project file. The import feature, if there is one,
   * is re-pointed at whatever part the file restored, since that is the mesh it
   * described.
   */
  load(raw, importedSoup = null) {
    const features = parseFeatures(raw);
    _imports.clear();
    for (const f of features) {
      seedFeatureIds(f.id);
      if (f.kind === 'import' && importedSoup) _imports.set(f.id, importedSoup);
    }
    _lastRecord = { key: null, at: 0 };
    set({
      features, dirty: features.length > 0, steps: [], errors: [], selectedId: null, past: [], future: [],
    });
    return features.length > 0;
  },

  /** Forget everything — a new project, not a rebuild. */
  clear() {
    _imports.clear();
    cancelHoleRebuild();
    _lastRecord = { key: null, at: 0 };
    set({
      features: [], dirty: false, steps: [], errors: [], selectedId: null, past: [], future: [],
    });
  },
}));

/**
 * An edit to a sketch the tree is built from makes the tree stale.
 *
 * Subscribed here rather than called from `sketchStore` so the dependency keeps
 * pointing one way: the sketcher has no idea features exist, and it should not
 * have to. `version` is the token the sketcher already bumps on every mutation.
 *
 * `version` does not say *which* sketch changed, so two things are watched:
 *
 * - the **open** sketch, when a feature is built from it and it was already open
 *   at the last bump — opening a sketch bumps too, and looking at a sketch is not
 *   editing it;
 * - the **planes** of the sketches features are built from, which change without
 *   the sketch being open (the Sketches panel, a deleted sketch).
 *
 * Anything else — starting a sketch on a face, drawing on one no feature uses
 * yet — leaves the part as it was, and so leaves the tree up to date. Marking it
 * stale anyway lit Rebuild for nothing, and a warning that is usually wrong is a
 * warning nobody reads.
 */
// Every sketch's plane as text, by id. A sketch absent from the previous map is
// new, not moved: a feature just built from it has already marked the tree.
const planesById = (state) => new Map(state.sketches.map((s) => [s.id, JSON.stringify(s.plane)]));
const initial = useSketchStore.getState();
let _last = { version: initial.version, activeId: initial.activeId, planes: planesById(initial) };
useSketchStore.subscribe((state) => {
  if (state.version === _last.version) return;
  const { features, building } = useFeatureStore.getState();
  const planes = planesById(state);
  // A rebuild moves sketches itself — face-linked planes, dimensions taken to the
  // part's edges — and replays for them; that is not an edit that leaves it stale.
  // Closing a sketch tidies away unused references to the part's edges, which
  // changes nothing a feature is built from (`bumpReason: 'tidy'`).
  if (building || state.bumpReason === 'tidy') {
    _last = { version: state.version, activeId: state.activeId, planes };
    return;
  }
  const used = new Set(features.map((f) => f.sketchId).filter((id) => id != null));
  const editedUsed = state.activeId === _last.activeId && used.has(state.activeId);
  const moved = [...used].some((id) => _last.planes.has(id) && planes.get(id) !== _last.planes.get(id));
  _last = { version: state.version, activeId: state.activeId, planes };
  if (features.length && (editedUsed || moved)) useFeatureStore.getState().markDirty();
  // The Hole Wizard leaves its sketch open for more holes, so a point moved there
  // would leave its hole behind until Rebuild. Those holes follow the point.
  const drilled = features.some((f) => f.kind === 'hole' && f.sketchId === state.activeId);
  if (editedUsed && state.sketchOpen && drilled) scheduleHoleRebuild();
});

/** Quiet time after the last edit before the holes are moved, so typing and dragging settle first. */
const HOLE_REBUILD_MS = 600;
let _holeRebuild = null;

function cancelHoleRebuild() {
  clearTimeout(_holeRebuild);
  _holeRebuild = null;
}

function scheduleHoleRebuild() {
  cancelHoleRebuild();
  _holeRebuild = setTimeout(() => {
    _holeRebuild = null;
    const tree = useFeatureStore.getState();
    if (!tree.dirty) return;
    // Mid-drag or mid-rebuild: try again once that has finished.
    if (tree.building || useSketchStore.getState().dragging) {
      scheduleHoleRebuild();
      return;
    }
    tree.rebuild();
  }, HOLE_REBUILD_MS);
}

// Leaving the Sketch page by a tab finishes the sketch as the checkmark does, so
// the part reaching the machine page includes the edit.
useCamStore.subscribe((state, prev) => {
  if (prev.page === 'sketch' && state.page !== 'sketch' && useSketchStore.getState().sketchOpen) {
    useFeatureStore.getState().finishSketch();
  }
});
