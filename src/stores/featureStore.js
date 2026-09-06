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
 * same reason. Auto-rebuild is a later option, debounced on solve completion —
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
import { useSketchStore } from './sketchStore.js';
import { useCamPlanStore, getMesh } from './camPlanStore.js';

/**
 * Soups for `import` features, by feature id.
 *
 * Module-level rather than in the store for the reason `camPlanStore` keeps its
 * meshes outside too: these are large `Float32Array`s that nothing renders from
 * directly, and putting them in state makes every subscriber re-render when a
 * part is swapped.
 */
const _imports = new Map();

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

  /** Append a feature and return it. */
  addFeature(kind, props = {}) {
    const feature = createFeature(kind, props);
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
    set({ features, dirty: true });
    return true;
  },

  removeFeature(id) {
    const features = get().features.filter((f) => f.id !== id);
    if (features.length === get().features.length) return false;
    _imports.delete(id);
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
      // than leave a permanently broken entry in the tree.
      get().removeFeature(feature.id);
      sketch.setError(`Could not build: ${failed.message}`);
      await get().rebuild();
      return null;
    }
    sketch.setError(null);
    return analysis;
  },

  /**
   * Replay the tree and put the result on the machine.
   *
   * The datum and the current page are **kept**: this is the same part
   * recomputed, not a new one arriving, and losing the origin every time a
   * dimension changed would make the feature tree worse than not having one.
   */
  async rebuild() {
    const { features } = get();
    if (!features.length) {
      set({ dirty: false, steps: [], errors: [] });
      return null;
    }
    set({ building: true });
    try {
      const sketch = useSketchStore.getState();
      let meshBoolean;
      if (needsMeshBoolean(features)) {
        try {
          ({ meshBoolean } = await import('../lib/csg.js'));
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
      const { soup, steps, errors } = rebuildFeatures(features, {
        sketchOf: (id) => {
          const entry = sketch.sketches.find((s) => s.id === id);
          return entry ? { doc: entry.doc, plane: entry.plane } : null;
        },
        importOf: (f) => get().importSoup(f),
        meshBoolean,
      });
      set({ steps, errors, dirty: false });
      if (!soup) return null;
      const name = features.filter((f) => !f.suppressed).length > 1
        ? `${features[0].name} +${features.filter((f) => !f.suppressed).length - 1}`
        : features[0].name;
      return await useCamPlanStore.getState().loadSoup(soup, name, {
        keepDatum: true,
        keepPage: true,
      });
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
    set({
      features, dirty: features.length > 0, steps: [], errors: [], selectedId: null,
    });
    return features.length > 0;
  },

  /** Forget everything — a new project, not a rebuild. */
  clear() {
    _imports.clear();
    set({
      features: [], dirty: false, steps: [], errors: [], selectedId: null,
    });
  },
}));

/**
 * A sketch edit makes the tree stale.
 *
 * Subscribed here rather than called from `sketchStore` so the dependency keeps
 * pointing one way: the sketcher has no idea features exist, and it should not
 * have to. `version` is the token the sketcher already bumps on every mutation.
 */
let _lastVersion = null;
useSketchStore.subscribe((state) => {
  if (state.version === _lastVersion) return;
  _lastVersion = state.version;
  const store = useFeatureStore.getState();
  if (store.features.length) store.markDirty();
});
