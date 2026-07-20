/**
 * camPlanStore — state for the STL → plan → NC pipeline.
 *
 * Thin, as the store layer is meant to be: every decision lives in
 * `engine/mesh/` and `engine/cam/`, and this only sequences those calls and
 * holds what came back. The one piece of real logic here is `sendToViewport`,
 * which hands the generated program to `camStore` so the NC is checked by the
 * app's own interpreter and simulator the moment it exists — the same round
 * trip the post-processor's tests run, but visible.
 *
 * Mesh buffers are kept in a module-level cache rather than in Zustand state,
 * for the same reason `bufferCache` exists: React DevTools structured-clones
 * state, and a million-float STL kills it.
 */
import { create } from 'zustand';
import { weld } from '../engine/mesh/stl.js';
import { parsePart } from '../engine/mesh/import.js';
import { analyzeMesh } from '../engine/mesh/analyze.js';
import { planJob, planContext, planSummary } from '../engine/cam/plan.js';
import { post } from '../engine/cam/post/fanuc.js';
import { DEFAULT_MATERIAL } from '../engine/cam/library.js';
import {
  machineById, machineForMode, DEFAULT_MILL_ID,
} from '../engine/cam/machines.js';
import * as recipeOps from '../engine/cam/recipe.js';
import { normalizeAngle } from '../engine/mesh/rotate.js';
import { useCamStore } from './camStore.js';

/** Large mesh arrays, out of React state. */
const _mesh = { soup: null, welded: null };
export const getMesh = () => _mesh;

/**
 * The measured context, cached beside the mesh for the same reason.
 *
 * It holds the welded mesh and every slice taken off it, and it is what makes
 * editing cheap: changing a tool rebuilds operations against a context that was
 * already measured, instead of re-slicing the part on every click.
 */
let _ctx = null;
export const getPlanContext = () => _ctx;

export const useCamPlanStore = create((set, get) => ({
  stlName: null,
  meshVer: 0,          // bumped whenever _mesh changes, so views re-render
  analysis: null,      // bounds / shell / axis / recommendation
  plan: null,          // steps, operations, stock, warnings
  nc: null,            // the posted program text
  status: 'idle',      // idle | loading | analysing | planning | ready | error
  error: null,

  // ---- Settings the planner reads ----
  material: DEFAULT_MATERIAL,
  forceMode: 'auto',   // auto | mill | turn
  machineId: DEFAULT_MILL_ID,
  partOff: true,
  diameterMode: true,
  programNumber: 1,

  // ---- The operator's editable plan ----
  // An ordered list of `{key, kind, toolId, enabled, target}`. Empty until a
  // part is planned, after which every edit rebuilds the program from it.
  recipe: [],

  setOption: (patch) => {
    set(patch);
    if (!get().plan) return;
    // "Part off" is a planner input the first time and a recipe row ever after.
    // Routing it to the row keeps one source of truth: the switch and the table
    // are the same fact, so they cannot end up disagreeing.
    if ('partOff' in patch && _ctx?.mode === 'turn') {
      const row = get().recipe.find((e) => e.kind === 'part');
      if (row) return get().toggleStep(row.key, patch.partOff);
      if (patch.partOff) return get().addStep('part');
    }
    // Material and the post options change the program too, so a plan already
    // on screen is rebuilt rather than left stale beside a control that no
    // longer describes it.
    return get().rebuild();
  },

  /**
   * Choose the machine — make and model.
   *
   * This is the one setting that can change the *process*: picking a lathe
   * means the part is turned. So it moves `forceMode` with it, and the context
   * is remeasured rather than rebuilt, because a turning profile and a milling
   * slice are different measurements of the same mesh.
   */
  setMachine(id) {
    const machine = machineById(id);
    const modeChanged = _ctx && _ctx.mode !== machine.kind;
    set({ machineId: machine.id, forceMode: machine.kind });
    if (!_mesh.welded) return;
    // Re-measure when the process changed — a turning profile and a milling
    // slice are different measurements of the same mesh — but *keep the
    // recipe*. Changing machine must not throw away the operations the
    // operator picked; `reconcile` drops only the ones that cannot apply.
    if (modeChanged || !_ctx) get().prepare();
    get().rebuild();
  },

  /** Choose the process directly; the machine follows it. */
  setMode(mode) {
    const machine = mode === 'auto'
      ? machineById(get().machineId)
      : machineForMode(mode, get().machineId);
    set({ forceMode: mode, machineId: machine.id });
    if (!_mesh.welded) return;
    get().prepare();
    get().rebuild();
  },

  /** Which format the loaded part came from, for the UI to name. */
  partFormat: null,

  /**
   * Read a part file and measure it.
   *
   * Any supported mesh format; `parsePart` decides which from the bytes rather
   * than the extension. Nothing downstream knows or cares which it was — the
   * whole engine works on the triangle soup that comes out.
   */
  async loadPart(file) {
    set({ status: 'loading', error: null, plan: null, nc: null });
    try {
      const buffer = await file.arrayBuffer();
      const soup = parsePart(buffer, file.name);
      const welded = weld(soup);
      _mesh.soup = soup;
      _mesh.welded = welded;
      // Measurements of the previous part must not survive it. Tool choices
      // may — they are the shop's, not the part's — and `reconcile` decides
      // which of them still apply.
      _ctx = null;

      // analyzeMesh runs inside planJob too, but showing the analysis before
      // planning is the whole point of splitting the two steps.
      const analysis = analyzeMesh(soup, welded);
      set({
        stlName: file.name,
        partFormat: soup.format,
        analysis,
        meshVer: get().meshVer + 1,
        status: 'ready',
        forceMode: 'auto',
      });

      // Measure it straight away, so the operator can pick a face the moment
      // the part appears. Nothing is decided by this — no operations, no tools
      // — it only makes the geometry available to point at.
      get().prepare();
      // Any operations that survive from the previous part are worth showing
      // against this one; an empty recipe stays empty until something is picked.
      if (get().recipe.length) get().rebuild();

      // Bring the user to a page that can actually show the part.
      //
      // The app opens on Sketch, where both the CAM panel and the 3D part are
      // deliberately hidden — so an STL dropped there loads perfectly and
      // produces no visible change whatsoever, which reads exactly like a
      // failed import. Landing on the machine the part suits fixes that and
      // makes the routing decision visible in one step.
      //
      // Someone already on Milling or Turning has made a choice, so it is left
      // alone; the panel's mode selector is there to override the analysis.
      const cam = useCamStore.getState();
      if (cam.page === 'sketch') await cam.setPage(analysis.recommend);

      return analysis;
    } catch (err) {
      _mesh.soup = _mesh.welded = null;
      _ctx = null;
      set({ status: 'error', error: err.message || String(err) });
      return null;
    }
  },

  /** The name this was called by before it read more than STL. */
  loadStl(file) { return get().loadPart(file); },

  /**
   * Measure the part. Do not decide anything about it.
   *
   * Split out from planning because the operator's workflow starts here: import
   * a part, look at its faces, pick one, cut it. Requiring a full automatic
   * plan first — which then has to be edited back down — put a decision in
   * front of them before they had made any.
   *
   * This is the expensive half (slicing, profiling, hole detection) so it runs
   * when the part or the process changes and never when a tool does.
   */
  prepare() {
    if (!_mesh.welded) return null;
    const { forceMode, partOff, machineId } = get();
    _ctx = planContext(_mesh.soup, _mesh.welded, {
      mode: forceMode, partOff, machineId,
    });

    // A milling plan may have laid the part down to make it reachable. Show it
    // in that orientation, or the model on screen and the toolpath beside it
    // would disagree about where everything is.
    const laid = _ctx.orientedMesh;
    const reoriented = Boolean(laid && _ctx.orientation?.changed);
    if (reoriented) {
      _mesh.soup = laid.soup;
      _mesh.welded = laid.welded;
    }

    set({
      analysis: _ctx.analysisOriented ?? get().analysis,
      // Only when the buffers actually changed. Bumping regardless would make
      // every re-measure look like a new mesh and rebuild the viewport's
      // geometry for nothing.
      meshVer: reoriented ? get().meshVer + 1 : get().meshVer,
      machineId: machineForMode(_ctx.mode, machineId).id,
      recipe: recipeOps.reconcile(get().recipe, _ctx),
      selectedFeature: null,
      previewFeature: null,
    });
    return _ctx;
  },

  /**
   * Propose a full plan for the part — the automatic route, now opt-in.
   *
   * Replaces the recipe wholesale, which is why it is a button the operator
   * presses rather than something that happens on import: it would otherwise
   * silently discard the operations they had picked by hand.
   */
  async makePlan() {
    if (!_mesh.welded) return null;
    set({ status: 'planning', error: null });
    try {
      // Always re-measured, never reused: this is the button that says "plan
      // the whole part with the settings as they stand", and material, process
      // and part-off all feed the measurement.
      get().prepare();
      set({ recipe: recipeOps.autoRecipe(_ctx) });
      return get().rebuild();
    } catch (err) {
      set({ status: 'error', error: err.message || String(err) });
      return null;
    }
  },

  /**
   * Rebuild the program from the current recipe.
   *
   * Cheap, because the geometry was measured once. Every recipe edit ends here,
   * which is what keeps the table, the warnings, the cycle time and the NC from
   * ever disagreeing with each other — there is only one path that produces them.
   */
  rebuild() {
    if (!_ctx) return null;
    set({ status: 'planning', error: null });
    try {
      const { material, machineId, recipe } = get();
      const machine = machineById(machineId);
      const plan = planJob(_mesh.soup, _mesh.welded, {
        ctx: _ctx, recipe, material, machineId,
      });
      const nc = post(
        {
          name: (get().stlName || 'part').replace(/\.[^.]+$/, ''),
          mode: plan.mode,
          material: plan.material,
          machineLabel: machine.label,
          stock: plan.stock,
          operations: plan.operations,
        },
        {
          diameterMode: get().diameterMode,
          programNumber: get().programNumber,
          controller: machine.controller,
        },
      );
      set({ plan, nc, recipe: plan.recipe, status: 'ready' });
      return plan;
    } catch (err) {
      set({ status: 'error', error: err.message || String(err) });
      return null;
    }
  },

  // ---- Recipe editing -------------------------------------------------------
  // Each of these is the pure function from `engine/cam/recipe.js` followed by
  // a rebuild. The store owns *when*; the engine owns *what*.

  setStepTool(key, toolId) {
    set({ recipe: recipeOps.setStepTool(get().recipe, key, toolId) });
    return get().rebuild();
  },

  toggleStep(key, enabled) {
    set({ recipe: recipeOps.toggleStep(get().recipe, key, enabled) });
    return get().rebuild();
  },

  moveStep(key, delta) {
    set({ recipe: recipeOps.moveStep(get().recipe, key, delta) });
    return get().rebuild();
  },

  removeStep(key) {
    set({ recipe: recipeOps.removeStep(get().recipe, key) });
    return get().rebuild();
  },

  addStep(kind, target) {
    if (!_ctx) return null;
    const angle = target?.angle ?? get().indexAngle;
    const full = angle ? { ...(target ?? {}), angle } : target;
    set({ recipe: recipeOps.addStep(get().recipe, kind, _ctx, { target: full }) });
    return get().rebuild();
  },

  /**
   * The rotary index new operations are added at.
   *
   * A mode, not a per-step argument, because indexing is how the operator is
   * *thinking* for a stretch of work: turn the part to A90, then program the
   * three things visible from there.
   */
  indexAngle: 0,

  setIndexAngle(angle) {
    set({ indexAngle: angle ? normalizeAngle(angle) : 0, selectedFeature: null, previewFeature: null });
  },

  /** Throw the edits away and take the planner's proposal again. */
  resetRecipe() {
    if (!_ctx) return null;
    set({ recipe: recipeOps.autoRecipe(_ctx) });
    return get().rebuild();
  },

  /** The tools that could run a given step, each with whether it fits. */
  toolChoices(key) {
    const e = get().recipe.find((r) => r.key === key);
    if (!e || !_ctx) return [];
    return recipeOps.toolChoicesFor(e.kind, _ctx, e.target);
  },

  /** The operations that could be added to this part. */
  addableKinds() {
    if (!_ctx) return [];
    return recipeOps.operationKindsFor(_ctx.mode);
  },

  // ---- Picking geometry off the model ---------------------------------------

  /**
   * The faces and edges of the loaded part, for the operator to choose from.
   *
   * Detection is lazy on the context, so the cost lands on the first call
   * rather than on every import — a part nobody points at is never analysed.
   */
  features() {
    if (!_ctx || _ctx.mode !== 'mill') return { faces: [], edges: [] };
    // Seen from the angle the table is currently indexed to, so "which faces
    // point up" is answered about the setup the operator is looking at.
    const angle = get().indexAngle;
    return (angle ? _ctx.indexAt(angle) : _ctx).features;
  },

  /**
   * What the viewport highlights.
   *
   * Two separate things, because they answer different questions. `selected` is
   * a decision — the operator picked this face and is about to cut it, and it
   * must not evaporate when the mouse moves away. `preview` is a hover, which
   * is how you *find* a face in a list of forty. The viewport shows the
   * selection when there is one and the hover otherwise.
   */
  selectedFeature: null,
  previewFeature: null,

  selectFeature(feature) {
    // Clicking the selected feature again clears it, which is the gesture
    // everyone tries first when they want to deselect.
    const current = get().selectedFeature;
    const same = feature && current && feature.id === current.id;
    set({ selectedFeature: same ? null : feature });
  },

  previewFeatureAt(feature) {
    set({ previewFeature: feature });
  },

  /** What the highlight should draw: the decision, or failing that the hover. */
  highlightedFeature() {
    return get().selectedFeature ?? get().previewFeature;
  },

  /**
   * Turn a picked face or edge into an operation.
   *
   * Identified by id rather than by index, because ids are what survive into
   * the recipe and a saved project — see `reconcile`.
   */
  addFaceStep(faceId, opts = {}) {
    if (!_ctx) return null;
    return get().addStep('region', { faceId, ...opts });
  },

  addEdgeStep(edgeId, opts = {}) {
    if (!_ctx) return null;
    return get().addStep('trace', { edgeId, ...opts });
  },

  /**
   * Push the generated program into the main viewport.
   *
   * This is the verification step, not a convenience: the NC is re-read by the
   * interpreter, drawn as a backplot, and can be carved by the simulator. If the
   * planner produced something wrong, it shows up here as visible geometry
   * rather than as a surprise at the machine.
   */
  async sendToViewport() {
    const { nc, plan } = get();
    if (!nc || !plan) return;
    const cam = useCamStore.getState();
    if (cam.mode !== plan.mode) await cam.setMode(plan.mode);
    await useCamStore.getState().parse(nc, `${(get().stlName || 'part').replace(/\.[^.]+$/, '')}.nc`);
  },

  /** The compact JSON a commentary layer would consume. */
  summary() {
    const { plan } = get();
    return plan ? planSummary(plan) : null;
  },

  clear() {
    _mesh.soup = _mesh.welded = null;
    _ctx = null;
    set({
      stlName: null, partFormat: null, analysis: null, plan: null, nc: null, recipe: [],
      selectedFeature: null, previewFeature: null, indexAngle: 0,
      status: 'idle', error: null, meshVer: get().meshVer + 1,
    });
  },
}));
