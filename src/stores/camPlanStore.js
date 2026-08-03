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
import {
  pointToRawFrame, pointFromRawFrame, displayedPointToRawFrame,
  originFromAxisPick, originFromAxisValue,
} from '../engine/mesh/datum.js';
import { encodeFloat32, decodeFloat32 } from '../engine/projectFile.js';
import { useCamStore } from './camStore.js';

/** Large mesh arrays, out of React state. */
const _mesh = { soup: null, welded: null };
export const getMesh = () => _mesh;

/**
 * The mesh exactly as imported, never overwritten again for the life of the
 * part — unlike `_mesh`, which `prepare()` replaces with the laid-down and/or
 * datum-shifted version to display and plan against.
 *
 * Every datum change re-derives from here rather than from whatever `_mesh`
 * currently holds, so picking a plane, then a point, then clearing the datum
 * always lands where it should instead of compounding transforms.
 */
const _raw = { soup: null, welded: null };

const NO_DATUM = {
  planeNormal: null, point: null, rotaryCenter: null, rotaryZero: null, reverseX: false,
  // Which of X/Y/Z the operator has explicitly touched off, so the panel can
  // show each axis locked or free independently. `point` still carries the
  // values; this only records which axes are the operator's rather than the
  // native origin's, for the lock UI and per-axis clearing.
  axesSet: [false, false, false],
};

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

  // ---- Where the operator says X0/Y0/Z0 (and, for a 4-axis mill, the A-axis)
  // physically is ----
  // Every field is in the *raw* import frame, so it survives a later
  // orientation change unchanged — see `pickAxisOrigin`/`pickRotaryCenter`. `null`
  // means "not set", which is the identical-to-today behaviour of just using
  // the mesh as imported (mill: laid down automatically, indexed about its
  // own frame origin; turn: as measured).
  datum: NO_DATUM,
  datumPickMode: null, // null | 'x' | 'y' | 'z' | 'rotary' | 'zero'

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
    // A 4-axis mill turns the work, so the viewport should show it turning.
    // Pushed rather than watched: camStore cannot import this store back.
    useCamStore.getState().applyMachine(machine);
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
    useCamStore.getState().applyMachine(machine);
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
      _raw.soup = soup;
      _raw.welded = welded;
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
        // A new part has no relationship to wherever the last one's origin
        // was picked — that point may not even exist on this geometry.
        datum: NO_DATUM,
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
      _raw.soup = _raw.welded = null;
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
    if (!_raw.welded) return null;
    const {
      forceMode, partOff, machineId, datum,
    } = get();
    // Always measured from the pristine import, never from whatever `_mesh`
    // currently holds — otherwise picking a plane, then a point, then
    // clearing the datum would compound transforms instead of each landing
    // where it should.
    const activeDatum = (datum.planeNormal || datum.point || datum.rotaryCenter
      || datum.rotaryZero || datum.reverseX)
      ? datum : null;
    _ctx = planContext(_raw.soup, _raw.welded, {
      mode: forceMode, partOff, machineId, datum: activeDatum,
    });

    // The plan may have laid the part down and/or shifted its origin. Show it
    // that way, or the model on screen and the toolpath beside it would
    // disagree about where everything is. Reference equality against `_raw`
    // is what `applyDatum`/`orientForMilling` guarantee when nothing changed.
    const laid = _ctx.orientedMesh;
    const reoriented = Boolean(laid && laid.soup !== _raw.soup);
    const previousSoup = _mesh.soup;
    _mesh.soup = reoriented ? laid.soup : _raw.soup;
    _mesh.welded = reoriented ? laid.welded : _raw.welded;

    set({
      analysis: _ctx.analysisOriented ?? get().analysis,
      // Only when the displayed buffers actually changed. Bumping regardless
      // would make every re-measure look like a new mesh and rebuild the
      // viewport's geometry for nothing.
      meshVer: _mesh.soup !== previousSoup ? get().meshVer + 1 : get().meshVer,
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

  // ---- The datum: where X0/Y0/Z0 (and the A-axis) physically is -------------
  //
  // This is what lets a *separately loaded* .nc program simulate correctly
  // against the imported part: neither the interpreter nor the simulator
  // needs to know about work offsets (the app deliberately doesn't model a
  // live G54 table), because once the part sits in the frame the operator
  // picked, any program zeroed at the same physical point already lines up
  // with it — see `engine/mesh/datum.js`. The rotary centre extends the same
  // idea to a 4-axis mill's A word: `camStore.machineOpts()` reads
  // `getPlanContext().rotaryCenter` so an indexed move in a loaded `.nc`
  // pivots on the same physical line the plan itself indexes about.

  /**
   * Arm the next click on the part to set the origin of ONE axis.
   *
   * `axis` is 0/1/2 for X/Y/Z. This is the deliberate replacement for the old
   * "pick a whole face" origin, which set a reference plane and re-laid the part
   * down so every axis jumped at once — the behaviour operators kept triggering
   * by accident. Touch-off is per axis on a real machine, and now here too.
   */
  startPickAxis(axis) { set({ datumPickMode: 'xyz'[axis] ?? null }); },

  /** Arm the next click to set where the physical A-axis passes through instead. */
  startPickRotaryCenter() { set({ datumPickMode: 'rotary' }); },

  /** Arm the next click to say "this face reads as A0" instead. */
  startPickRotaryZero() { set({ datumPickMode: 'zero' }); },

  cancelPickDatum() { set({ datumPickMode: null }); },

  /**
   * A click on the part sets the origin of a single axis, leaving the other two
   * where they are and never touching the part's orientation. `axis` is 0/1/2;
   * `point` is the clicked location in the frame currently drawn. The per-axis
   * arithmetic — and the conversion back to the raw import frame that survives a
   * later re-lay-down — lives in `engine/mesh/datum.js`.
   */
  pickAxisOrigin(axis, point) {
    if (!_ctx) return null;
    const orientation = _ctx.mode === 'mill' ? _ctx.orientation : null;
    const current = get().datum;
    const rawPoint = originFromAxisPick(current.point, orientation, axis, point);
    const axesSet = [...current.axesSet];
    axesSet[axis] = true;
    set({ datum: { ...current, point: rawPoint, axesSet }, datumPickMode: null });
    get().prepare();
    if (get().recipe.length) get().rebuild();
    return get().datum;
  },

  /** A typed value for one axis, in the frame on screen — for the numeric fields. */
  setAxisOrigin(axis, value) {
    if (!_ctx) return null;
    const orientation = _ctx.mode === 'mill' ? _ctx.orientation : null;
    const current = get().datum;
    const rawPoint = originFromAxisValue(current.point, orientation, axis, value ?? 0);
    const axesSet = [...current.axesSet];
    axesSet[axis] = true;
    set({ datum: { ...current, point: rawPoint, axesSet } });
    get().prepare();
    if (get().recipe.length) get().rebuild();
    return get().datum;
  },

  /** Unlock one axis — its origin returns to the part's native zero, the others stay. */
  clearAxisOrigin(axis) {
    if (!_ctx) return null;
    const orientation = _ctx.mode === 'mill' ? _ctx.orientation : null;
    const current = get().datum;
    const axesSet = [...current.axesSet];
    axesSet[axis] = false;
    // Zero this axis in the setup frame; if nothing is set any more, drop the
    // point entirely so the mesh passes through untouched (reference equality).
    const zeroed = originFromAxisValue(current.point, orientation, axis, 0);
    const point = axesSet.some(Boolean) ? zeroed : null;
    set({ datum: { ...current, point, axesSet } });
    get().prepare();
    if (get().recipe.length) get().rebuild();
    return get().datum;
  },

  /** Back to the mesh as imported (mill: automatic lay-down; turn: as measured). */
  clearDatum() {
    set({ datum: NO_DATUM, datumPickMode: null });
    get().prepare();
    if (get().recipe.length) get().rebuild();
  },

  /** The current datum point in the frame on screen, or `null` if unset — what the numeric fields show. */
  displayedDatumPoint() {
    const { datum } = get();
    if (!datum.point || !_ctx) return null;
    const orientation = _ctx.mode === 'mill' ? _ctx.orientation : null;
    return pointFromRawFrame(datum.point, orientation);
  },

  /**
   * A click on the part sets where the physical A-axis passes through — only
   * its Y/Z matter (the axis runs the length of X), so unlike a linear-axis
   * pick this never touches the origin point, whatever face was clicked.
   */
  pickRotaryCenter(point) {
    if (!_ctx) return null;
    const orientation = _ctx.mode === 'mill' ? _ctx.orientation : null;
    const current = get().datum;
    const rawPoint = displayedPointToRawFrame(point, orientation, current.point);
    set({ datum: { ...current, rotaryCenter: rawPoint }, datumPickMode: null });
    get().prepare();
    if (get().recipe.length) get().rebuild();
    return get().datum;
  },

  /** A typed Y/Z, in the frame currently on screen — for the numeric fields. */
  setRotaryCenter(displayedYZ) {
    if (!_ctx) return null;
    const orientation = _ctx.mode === 'mill' ? _ctx.orientation : null;
    const current = get().datum;
    const displayedPoint = [0, displayedYZ[0], displayedYZ[1]];
    const rawPoint = displayedPointToRawFrame(displayedPoint, orientation, current.point);
    set({ datum: { ...current, rotaryCenter: rawPoint } });
    get().prepare();
    if (get().recipe.length) get().rebuild();
    return get().datum;
  },

  /** Back to indexing about the frame's own origin. */
  clearRotaryCenter() {
    set({ datum: { ...get().datum, rotaryCenter: null } });
    get().prepare();
    if (get().recipe.length) get().rebuild();
  },

  /** The current rotary centre as `[y, z]` in the frame on screen, or `null` if unset. */
  displayedRotaryCenter() {
    const { datum } = get();
    if (!datum.rotaryCenter || !_ctx) return null;
    const orientation = _ctx.mode === 'mill' ? _ctx.orientation : null;
    const p = pointFromRawFrame(datum.rotaryCenter, orientation);
    return [p[1], p[2]];
  },

  /**
   * A click on the part says which face should read as A0, independent of
   * the reference plane — a 4-axis part is rarely modelled at the angle it
   * will actually be chucked at, and this is the "index by eye once" fix for
   * that. Only the normal matters (like `orientToNormal`, but as an
   * arbitrary, continuous rotation rather than a 90°-snapped permutation),
   * so unlike a linear-axis pick this never touches the origin point.
   */
  pickRotaryZero(normal) {
    if (!_ctx || _ctx.mode !== 'mill') return null;
    const rawNormal = pointToRawFrame(normal, _ctx.orientation);
    set({ datum: { ...get().datum, rotaryZero: rawNormal }, datumPickMode: null });
    get().prepare();
    if (get().recipe.length) get().rebuild();
    return get().datum;
  },

  /** Back to whatever face the automatic/picked plane already put at A0. */
  clearRotaryZero() {
    set({ datum: { ...get().datum, rotaryZero: null } });
    get().prepare();
    if (get().recipe.length) get().rebuild();
  },

  /** The angle (degrees) the picked A0 face was turned by, or `null` if unset. */
  rotaryZeroAngle() {
    if (!get().datum.rotaryZero || !_ctx || _ctx.mode !== 'mill') return null;
    return _ctx.orientation?.angle ?? 0;
  },

  /**
   * Turn the whole part 180° about Z — swapping which end reads as high X
   * (and, since a mirror would flip the model into scrap, which side reads
   * as high Y along with it) — for when a program written or posted
   * elsewhere counts X the other way along the same physical setup.
   */
  toggleReverseX() {
    set({ datum: { ...get().datum, reverseX: !get().datum.reverseX } });
    get().prepare();
    if (get().recipe.length) get().rebuild();
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

  /**
   * The whole CAM setup, for a saved project: the imported part plus every
   * choice made about it — machine, material, process, origin, and the ordered
   * operations. Returned as plain JSON-able data (the part's vertices base64'd)
   * so a project file no longer loses everything but the G-code on reload.
   *
   * `null` when no part is loaded — the project is then a bare sketch or a
   * hand-typed program, exactly the v1 case, and the file carries no `cam` block.
   */
  serializeSetup() {
    if (!_raw.soup) return null;
    const s = get();
    return {
      part: {
        name: s.stlName,
        format: s.partFormat,
        triangleCount: _raw.soup.triangleCount,
        positions: encodeFloat32(_raw.soup.positions),
      },
      settings: {
        material: s.material,
        forceMode: s.forceMode,
        machineId: s.machineId,
        partOff: s.partOff,
        diameterMode: s.diameterMode,
        programNumber: s.programNumber,
        indexAngle: s.indexAngle,
      },
      datum: s.datum,
      recipe: s.recipe,
    };
  },

  /**
   * Rebuild a CAM setup from a saved project's `cam` block: re-import the part
   * from its stored vertices, put back the machine / material / origin /
   * operations, and re-plan — the mirror of `serializeSetup`.
   *
   * A block with no part (or `null`) leaves the current state untouched, so
   * opening a sketch-only or v1 project never wipes a part already loaded. On
   * success it returns the restored process mode, so the caller can bring the
   * right page forward. Missing datum fields fall back to `NO_DATUM`, so a file
   * hand-edited or saved before a field existed cannot crash the panel.
   */
  restoreSetup(cam) {
    if (!cam || !cam.part || !cam.part.positions) return null;
    try {
      const positions = decodeFloat32(cam.part.positions);
      const triangleCount = cam.part.triangleCount ?? positions.length / 9;
      const soup = {
        positions,
        normals: new Float32Array(triangleCount * 3),
        triangleCount,
        format: cam.part.format ?? 'stl',
      };
      const welded = weld(soup);
      _raw.soup = soup;
      _raw.welded = welded;
      _mesh.soup = soup;
      _mesh.welded = welded;
      _ctx = null;

      const analysis = analyzeMesh(soup, welded);
      const settings = cam.settings ?? {};
      set({
        stlName: cam.part.name ?? null,
        partFormat: soup.format,
        analysis,
        meshVer: get().meshVer + 1,
        status: 'ready',
        error: null,
        material: settings.material ?? DEFAULT_MATERIAL,
        forceMode: settings.forceMode ?? 'auto',
        machineId: settings.machineId ?? get().machineId,
        partOff: settings.partOff ?? true,
        diameterMode: settings.diameterMode ?? true,
        programNumber: settings.programNumber ?? 1,
        indexAngle: settings.indexAngle ?? 0,
        datum: { ...NO_DATUM, ...(cam.datum ?? {}) },
        recipe: Array.isArray(cam.recipe) ? cam.recipe : [],
        selectedFeature: null,
        previewFeature: null,
        datumPickMode: null,
      });

      // A restored 4-axis machine should restore its viewport behaviour with it.
      useCamStore.getState().applyMachine(machineById(get().machineId));

      // Measure against the restored settings; `prepare` reconciles the saved
      // recipe against the freshly measured context (dropping any operation the
      // geometry no longer supports), then the program is rebuilt from it.
      get().prepare();
      if (get().recipe.length) get().rebuild();
      return _ctx?.mode ?? analysis.recommend;
    } catch (err) {
      set({ status: 'error', error: `Could not restore the saved part: ${err.message || String(err)}` });
      return null;
    }
  },

  /** The compact JSON a commentary layer would consume. */
  summary() {
    const { plan } = get();
    return plan ? planSummary(plan) : null;
  },

  clear() {
    _raw.soup = _raw.welded = null;
    _mesh.soup = _mesh.welded = null;
    _ctx = null;
    set({
      stlName: null, partFormat: null, analysis: null, plan: null, nc: null, recipe: [],
      selectedFeature: null, previewFeature: null, indexAngle: 0,
      datum: NO_DATUM, datumPickMode: false,
      status: 'idle', error: null, meshVer: get().meshVer + 1,
    });
  },
}));
