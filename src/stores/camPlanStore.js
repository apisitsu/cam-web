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
import { parseSTL, weld } from '../engine/mesh/stl.js';
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
    const modeChanged = get().plan && get().plan.mode !== machine.kind;
    set({ machineId: machine.id, forceMode: machine.kind });
    if (!_mesh.welded) return;
    if (modeChanged || !_ctx) get().makePlan();
    else get().rebuild();
  },

  /** Choose the process directly; the machine follows it. */
  setMode(mode) {
    const machine = mode === 'auto'
      ? machineById(get().machineId)
      : machineForMode(mode, get().machineId);
    set({ forceMode: mode, machineId: machine.id });
    if (_mesh.welded) get().makePlan();
  },

  /**
   * Read an STL and analyse it. Planning is a separate step so the operator can
   * see what the file actually is — and fix the material or the machine — before
   * committing to a toolpath.
   */
  async loadStl(file) {
    set({ status: 'loading', error: null, plan: null, nc: null });
    try {
      const buffer = await file.arrayBuffer();
      const soup = parseSTL(buffer);
      if (soup.triangleCount === 0) throw new Error('That STL contains no triangles.');
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
        analysis,
        meshVer: get().meshVer + 1,
        status: 'ready',
        forceMode: 'auto',
      });

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

  /**
   * Measure the part and propose a plan for it.
   *
   * This is the expensive half — slicing, profiling, hole detection — so it
   * runs when the part or the process changes, and *not* when a tool does.
   * Tool edits go through `rebuild`.
   */
  async makePlan() {
    if (!_mesh.welded) return null;
    set({ status: 'planning', error: null });
    try {
      const { material, forceMode, partOff, machineId } = get();
      _ctx = planContext(_mesh.soup, _mesh.welded, {
        mode: forceMode, partOff, machineId,
      });

      // A milling plan may have laid the part down to make it reachable. Show
      // the part in that orientation, or the model on screen and the toolpath
      // beside it would disagree about where everything is — and the operator
      // would be looking at a setup that is not the one being programmed.
      const laid = _ctx.orientedMesh;
      if (laid && _ctx.orientation?.changed) {
        _mesh.soup = laid.soup;
        _mesh.welded = laid.welded;
      }

      // Keep the operator's choices where they still apply to this part; the
      // planner fills in the rest.
      const previous = get().recipe;
      const recipe = previous.length
        ? recipeOps.reconcile(previous, _ctx)
        : recipeOps.autoRecipe(_ctx);

      set({
        recipe,
        analysis: _ctx.analysisOriented ?? get().analysis,
        meshVer: get().meshVer + 1,
        // The machine has to match the process actually chosen — dropping a
        // round part while a mill is selected routes it to the lathe, and the
        // machine label must follow or the posted program names the wrong one.
        machineId: machineForMode(_ctx.mode, machineId).id,
      });
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
          name: (get().stlName || 'part').replace(/\.stl$/i, ''),
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
    set({ indexAngle: angle ? normalizeAngle(angle) : 0, selectedFeature: null });
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

  /** Highlighted in the viewport; null when nothing is picked. */
  selectedFeature: null,

  selectFeature(feature) {
    set({ selectedFeature: feature });
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
    await useCamStore.getState().parse(nc, `${(get().stlName || 'part').replace(/\.stl$/i, '')}.nc`);
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
      stlName: null, analysis: null, plan: null, nc: null, recipe: [],
      selectedFeature: null, indexAngle: 0,
      status: 'idle', error: null, meshVer: get().meshVer + 1,
    });
  },
}));
