/**
 * camStore — Zustand state for the CAM viewport (Phase 0–1 + playback).
 *
 * Owns the G-code text, the machine mode, parsed backplot buffers, the ordered
 * path (for scrubbing), the camera view preset, and the material-removal
 * session. Heavy work is delegated to two Comlink workers so the store stays a
 * thin orchestration layer (the Engine Layer in cam_web.txt).
 */
import { create } from 'zustand';
import * as Comlink from 'comlink';
import {
  feedProgressAt, nextBlockEnd, prevBlockStart, timeAt,
} from '../engine/gcode/path.js';
import { setBuffers, clearBuffers, getBuf } from '../engine/bufferCache.js';
import { removalDiagnosis } from '../engine/sim/removal.js';
import { simMethodFor } from '../engine/sim/method.js';
import { rotaryFrameFor } from '../engine/view/rotaryFrame.js';
import {
  cutterById, simTypeOf, clampFlutes, defaultFlutes, clampThickness, clampShank,
  DEFAULT_CUTTER,
} from '../engine/cam/cutters.js';
import { getPlanContext } from './camPlanStore.js';

// Lazily create the workers so tests / SSR don't spin them up on import.
let gcodeApi = null;
function getGcodeWorker() {
  if (!gcodeApi) {
    const worker = new Worker(new URL('../workers/gcode.worker.js', import.meta.url), {
      type: 'module',
    });
    gcodeApi = Comlink.wrap(worker);
  }
  return gcodeApi;
}

let simApi = null;
function getSimWorker() {
  if (!simApi) {
    const worker = new Worker(new URL('../workers/sim.worker.js', import.meta.url), {
      type: 'module',
    });
    simApi = Comlink.wrap(worker);
  }
  return simApi;
}

export const useCamStore = create((set, get) => ({
  gcode: '',
  fileName: null,
  // Large binary buffers (rapids, feeds, bounds, stats, path, sim) live in
  // bufferCache — NOT here — to prevent React DevTools DataCloneError.
  bufVer: 0,        // incremented every time bufferCache is updated
  status: 'idle',   // idle | parsing | done | error
  error: null,

  // ---- Machine ----
  mode: 'mill',        // mill | turn — machine interpretation of the program
  // Top-level workspace tab. Milling / Turning map 1:1 to the machine `mode`;
  // Sketch is a standalone design page that leaves the loaded program (and its
  // machine mode) untouched — it just swaps the viewport UI to the sketcher.
  page: 'sketch',      // mill | turn | sketch — start on the Sketch design page
  diameterMode: true,  // turn only: the X word is a diameter
  rapidRate: 5000,     // mm/min — times G0 moves for the cycle-time estimate
  // Which frame the 4th axis is drawn in — see `engine/view/rotaryFrame.js`.
  // 'part' keeps the workpiece still and tilts the tool onto each face;
  // 'machine' leaves the program's coordinates alone, so the tool stays upright
  // and the WORK turns, the way a rotary table actually behaves. Picking a
  // 4-axis machine switches this to 'machine' on its own (`applyMachine`); the
  // toggle in the viewport pins it either way until the machine changes again.
  rotaryFrame: 'part',
  // The A angle the carved stock buffer is already expressed at. The height
  // field carves one index in the machine frame, so its stock arrives
  // pre-rotated and must only be turned the rest of the way; the voxel sim
  // works in the part frame and leaves this at 0.
  simFrameA: 0,

  // ---- Camera ----
  view: 'iso',      // iso | top | front | back | left | right
  viewNonce: 0,     // bumped on every setView so re-picking the same view refits

  // ---- Playback ----
  playhead: 0,
  playT: 0,       // continuous machine time (s) under the playhead, for a smooth marker
  playing: false,

  // ---- Phase 1: material removal simulation ----
  toolRadius: 3,
  // The cutter TYPE (see `engine/cam/cutters.js`) — endmill / shoulder / face /
  // slot / ball / chamfer. `toolType` is the flat|ball the older carving code
  // speaks and is kept in step by `setCutter`, never set by hand.
  toolCutter: DEFAULT_CUTTER,
  toolFlutes: defaultFlutes(DEFAULT_CUTTER),
  toolAngle: 90,       // chamfer/spot mills: included angle
  // Slot cutters: the thickness of the cutting body, which is the width of the
  // slot it leaves. null = let the type imply it from the diameter, which is
  // all any other type does. See `defaultThickness` in `cam/cutters.js`.
  toolThickness: null,
  // Slot cutters: the shank diameter, for a necked tool whose shank is narrower
  // than what it cuts. null = the type's own (just under the cutting diameter).
  toolShank: null,
  toolType: 'flat',
  cellSize: 0.5,
  voxelSize: 1,        // voxel sim resolution (mm) — coarser than the dexel cell
  // What the last voxel run actually carved at, and whether the grid budget
  // (not the cutter) decided it. The requested size is only a request: a cut is
  // rounded out to whole voxels, so a thin cutting body forces a finer grid —
  // see `engine/sim/method.js`.
  voxelSizeUsed: null,
  voxelLimited: false,
  simMethod: 'height', // 'height' (dexel) | 'voxel' (undercut) | 'turning' (revolved)
  // ---- Turning ----
  turnTool: 'mvjnr',   // selected OD toolholder type (marker appearance)
  stockOversize: 1,    // raw bar diameter over the largest turned diameter (mm)
  // ---- Tool table (user edits, keyed by tool number) ----
  // { [n]: { diameter?, simType?, length? } } — override the auto-detected values
  // so the simulated cutter matches the program's real tooling (milling).
  toolOverrides: {},
  // The billet the operator has in the vice: X × Y × Z in mm, and the corner it
  // sits on in work coordinates (its X−/Y−/Z− face). `null` on an axis means
  // "work it out from the toolpath" — a blank Z origin still defaults the top
  // to Z0, which is now a default rather than a rule. See `engine/sim/billet.js`.
  stockSize: { x: null, y: null, z: null },
  stockOrigin: { x: null, y: null, z: null },
  // Whether the stated billet is used at all. Off hands the blank back to the
  // automatic fit around the toolpath — which is what this always did — and
  // takes the live preview out of the viewport with it. On is the default
  // because, with every dimension still null, "on" IS the automatic fit; the
  // only difference is that you can now see the block it picked.
  stockEnabled: true,
  // Legacy T/B/M. `stockMargin` is still the XY fallback for an axis the
  // operator has not sized; top/base are no longer surfaced (the top is Z0 by
  // definition now) but stay readable so a project saved before this still
  // restores rather than throwing.
  stockTop: null,
  stockBase: null,
  stockMargin: 5,
  simStatus: 'idle',
  simReady: false,
  // One sentence saying why the last simulation took nothing off, or null when
  // it took something off. A block that looks uncut is otherwise indistinguishable
  // from a simulator that never ran — see `engine/sim/removal.js`.
  removalNote: null,
  removedVolume: 0,
  totalFeeds: 0,
  cutFollowsPlayback: true, // watch the stock carve as playback runs, by default
  showStock: true,
  // The arbor is the widest thing on the tool marker, so it is what hides the cut
  // being made — worth being able to drop without losing the cutter itself.
  // Deliberately not a saved setting (see projectFile's SETTING_KEYS): it is how
  // you are looking at the job right now, not part of the job.
  showArbor: true,
  _carving: false,
  // The feed-move target `carveToPlayhead` last actually carved to. Scrubbing
  // ticks every 40ms regardless of whether the playhead crossed a new feed
  // move — most of a slow move's many ticks land on the same target — so this
  // is what turns "ask the worker to re-carve and re-triangulate the whole
  // grid" into a no-op for every tick that has nothing new to show.
  _lastCarveTarget: null,
  // 4th-axis: the height-field simulator carves one rotary index at a time.
  // null = let the engine pick the one that does the most cutting.
  aIndex: null,

  setGcode: (gcode) => set({ gcode }),
  setTool: (patch) => set(patch),

  /**
   * Pick the cutter type for the sim's fallback tool.
   *
   * Resets the flute count to the type's own default rather than carrying the
   * old one across: 6 flutes is right for a face mill and not a thing on a slot
   * drill, and flutes multiply the feed rate directly — so a stale count is a
   * cycle time quietly several times wrong. `toolType` is derived here so the
   * flat/ball the carvers already speak can never drift from the type on screen.
   */
  setCutter(id) {
    const c = cutterById(id);
    set({
      toolCutter: c.id,
      toolType: simTypeOf(c.id),
      toolFlutes: defaultFlutes(c.id),
      ...(c.angle ? { toolAngle: c.angle } : {}),
      // A thickness or a shank typed in for one type means nothing on the next:
      // 4 mm is a slot cutter and would be a Ø10 endmill with 4 mm of flute.
      // Back to what the type implies.
      toolThickness: null,
      toolShank: null,
    });
  },

  /** Flute count, clamped to what the chosen type is actually made in. */
  setFlutes(n) {
    set((s) => ({ toolFlutes: clampFlutes(s.toolCutter, n) }));
  },

  /**
   * Cutting-body thickness for the fallback tool — for a slot cutter, the width
   * of the slot. `null` hands it back to the type's implied body.
   */
  setThickness(mm) {
    set((s) => ({ toolThickness: mm == null ? null : clampThickness(s.toolCutter, mm) }));
  },

  /**
   * Shank diameter for the fallback tool — the plain part the holder grips.
   * `null` hands it back to the type's own (just under the cutting diameter).
   */
  setShank(mm) {
    set((s) => ({ toolShank: mm == null ? null : clampShank(s.toolCutter, mm) }));
  },
  toggleStock: () => set((s) => ({ showStock: !s.showStock })),

  /**
   * Use the stated billet, or hand the blank back to the automatic fit.
   *
   * Does NOT drop the carved block: the toggle changes which blank the *next*
   * simulation starts from, and throwing away a result the operator is looking
   * at to make that point would be picking a fight with them. The preview
   * appearing (or vanishing) is the feedback.
   */
  toggleStockEnabled() {
    set((s) => ({ stockEnabled: !s.stockEnabled }));
  },

  /**
   * Resize the billet on one axis (or several). `null` hands that axis back to
   * the automatic fit.
   */
  setStockSize(patch) {
    set((s) => ({ stockSize: { ...s.stockSize, ...patch } }));
    get()._dropCarvedStock();
  },

  /**
   * Move the billet: its minimum corner (X−, Y−, Z−) in work coordinates.
   * `null` on an axis hands it back to the default — centred on the cutting in
   * X/Y, top on Z0 in Z.
   */
  setStockOrigin(patch) {
    set((s) => ({ stockOrigin: { ...s.stockOrigin, ...patch } }));
    get()._dropCarvedStock();
  },

  /**
   * The billet as the carver wants it — or nothing at all when the toggle is
   * off. One place, so the two sim paths cannot disagree about whether the
   * operator's blank counts.
   */
  billetOpts() {
    const { stockEnabled, stockSize, stockOrigin } = get();
    return stockEnabled ? { stockSize, stockOrigin } : {};
  },

  /** Fill both at once, from `suggestBillet`. */
  setBillet({ size, origin }) {
    set((s) => ({
      stockSize: { ...s.stockSize, ...(size ?? {}) },
      stockOrigin: { ...s.stockOrigin, ...(origin ?? {}) },
    }));
    get()._dropCarvedStock();
  },

  /**
   * Throw away a carved block whose blank has just changed under it.
   *
   * Not merely stale: a block cut out of a different-sized or differently-placed
   * blank is not a rough version of the right answer, it is the wrong shape
   * sitting where the right one should be — and it would go on being drawn as
   * if it meant something. Clearing it makes the operator press Simulate again,
   * which is the honest state.
   */
  _dropCarvedStock() {
    if (!getBuf().sim) return;
    setBuffers({ sim: null });
    set({
      bufVer: get().bufVer + 1,
      simStatus: 'idle',
      simReady: false,
      totalFeeds: 0,
      _lastCarveTarget: null,
    });
  },
  toggleArbor: () => set((s) => ({ showArbor: !s.showArbor })),
  setCutFollows: (v) => {
    set({ cutFollowsPlayback: v });
    if (v) get().carveToPlayhead();
  },

  /** Snap the camera to a named preset. Re-picking the current one refits it. */
  setViewPreset: (view) => set((s) => ({ view, viewNonce: s.viewNonce + 1 })),

  /**
   * Switch the top-level workspace tab. Milling / Turning are machine modes and
   * re-interpret the program (delegated to setMode); Sketch is a standalone
   * design page that leaves the loaded program and its machine mode as they were.
   */
  async setPage(page) {
    if (page === get().page) return;
    if (page === 'sketch') {
      set({ page: 'sketch', playing: false });
      return;
    }
    // Milling / Turning: the tab *is* the machine mode. setMode re-parses when it
    // actually changes and is a no-op when the mode already matches.
    set({ page });
    await get().setMode(page);
  },

  /**
   * Switch between milling and turning. The two modes disagree about what the
   * X word and G98/G99 mean, so the program has to be re-interpreted. Turning
   * has no dexel simulation, so any carved stock is dropped.
   */
  async setMode(mode) {
    if (mode === get().mode) return;
    setBuffers({ sim: null });
    set({
      mode,
      page: mode, // Milling / Turning tabs mirror the machine mode
      bufVer: get().bufVer + 1, // drop the stale carved stock from the viewport
      // Lathe: the Front preset is remapped (in CameraRig) to the correct lathe
      // side view — +Z (face) right, −Z (chuck) left, X up — so default to it.
      view: mode === 'turn' ? 'front' : 'iso',
      viewNonce: get().viewNonce + 1,
      simStatus: 'idle',
      simReady: false,
      cutFollowsPlayback: true,
      totalFeeds: 0,
    });
    if (get().gcode) await get().parse();
  },

  /**
   * Machine options the interpreter needs, in both workers.
   *
   * `rotaryCenter` is read off whatever part is loaded in `camPlanStore`, not
   * stored here — it's how a `.nc` program loaded into this viewport (CAM's
   * own "Verify in viewport", or an independently dropped file) ends up
   * pivoting its A-axis moves on the same physical line the plan was indexed
   * about, without the interpreter needing any G54-style offset table of its
   * own. Absent for anything but a milling part, since turning has no A-axis
   * concept here.
   */
  machineOpts() {
    const { mode, rapidRate, diameterMode, rotaryFrame } = get();
    const ctx = getPlanContext();
    const rotaryCenter = mode === 'mill' && ctx?.mode === 'mill' ? ctx.rotaryCenter : undefined;
    return {
      mode, rapidRate, diameterMode, rotaryFrame,
      ...(rotaryCenter ? { rotaryCenter } : {}),
    };
  },

  /**
   * Draw the 4th axis in the part's frame or the machine's.
   *
   * The interpreter is what actually changes frame (`rotaryFrame` in its opts),
   * so this has to re-parse: the backplot, the bounds and every tool position
   * are different numbers in the two frames. The carved stock is *not* thrown
   * away — rotation is rigid, so the same segments cut the same material and
   * only where it is drawn changes.
   */
  setRotaryFrame(frame) {
    if (frame === get().rotaryFrame) return;
    set({ rotaryFrame: frame });
    if (get().gcode) get().parse();
  },

  /**
   * Follow the selected machine: a 4-axis mill turns the work, so show it
   * turning. Called by `camPlanStore.setMachine` rather than watched from here,
   * because camStore must not import the plan store back (it already imports
   * this one).
   */
  applyMachine(machine) {
    get().setRotaryFrame(rotaryFrameFor(machine));
  },

  setRapidRate(rapidRate) {
    set({ rapidRate });
    if (get().gcode) get().parse(); // cycle time depends on it
  },

  setDiameterMode(diameterMode) {
    set({ diameterMode });
    if (get().gcode) get().parse();
  },

  /** Pick which A-axis orientation the material-removal sim carves. */
  setAIndex(aIndex) {
    set({ aIndex, simReady: false, cutFollowsPlayback: false });
    setBuffers({ sim: null });
    set({ bufVer: get().bufVer + 1, simStatus: 'idle' });
  },

  async parse(text, fileName) {
    const source = text ?? get().gcode;
    set({ status: 'parsing', error: null });
    try {
      const api = getGcodeWorker();
      const { rapids, feeds, bounds, stats, path } = await api.parse(source, get().machineOpts());
      // Store large buffers outside React state to avoid DevTools DataCloneError.
      setBuffers({ rapids, feeds, bounds, stats, path });
      set({
        bufVer: get().bufVer + 1,
        status: 'done',
        gcode: source,
        playhead: path.count,
        playing: false,
        simStatus: 'idle',
        simReady: false,
        totalFeeds: 0,
        aIndex: null,
        _lastCarveTarget: null,
        ...(fileName ? { fileName } : {}),
      });
    } catch (err) {
      set({ status: 'error', error: err.message || String(err) });
    }
  },

  /** Load a dropped/selected G-code file, then parse it. */
  async loadFile(file) {
    const text = await file.text();
    await get().parse(text, file.name);
  },

  // ---- Playback controls ----
  setPlayhead(k) {
    const path = getBuf().path;
    const count = path ? path.count : 0;
    const clamped = Math.max(0, Math.min(k, count));
    set({ playhead: clamped });
    if (get().cutFollowsPlayback && get().simReady) get().carveToPlayhead();
  },
  play() {
    // `path` lives in bufferCache, not store state — reading it from get() here
    // yielded undefined, so play() always bailed and playback never started.
    const path = getBuf().path;
    if (!path) return;
    // Restart from the beginning if we're already at the end.
    if (get().playhead >= path.count) set({ playhead: 0 });
    set({ playing: true });
  },
  pause: () => set({ playing: false }),
  togglePlay() {
    get().playing ? get().pause() : get().play();
  },

  /**
   * SINGLE BLOCK — run one block and stop, the way the switch on a control does.
   *
   * A block is one source line, so a tessellated arc steps as the single move it
   * was written as rather than a thousand chords. `dir = -1` steps back to the
   * start of the block that just ran, so it can be watched again.
   *
   * Stepping always drops out of playback: the two are the same cycle-start, and
   * leaving the timer running would carry the playhead straight past the stop.
   */
  stepBlock(dir = 1) {
    const path = getBuf().path;
    if (!path || path.count === 0) return;
    // A parsed program parks the playhead at the end (the whole backplot drawn),
    // so stepping forward from there means "start it again" — the same restart
    // play() does, rather than a dead button on a program just loaded.
    const at = dir > 0 && get().playhead >= path.count ? 0 : get().playhead;
    const next = dir < 0 ? prevBlockStart(path, at) : nextBlockEnd(path, at);
    // playT is the continuous clock the tool marker rides; park it on the block
    // boundary too, or resuming would rewind to wherever the timer left off.
    set({ playing: false, playT: timeAt(path, next) });
    get().setPlayhead(next);
  },

  /** Advance the playhead by n segments (used by the animation loop). */
  step(n = 1) {
    const path = getBuf().path;
    if (!path) return;
    const next = Math.min(path.count, get().playhead + n);
    get().setPlayhead(next);
    if (next >= path.count) set({ playing: false });
  },

  /** Start / refresh a material-removal session and carve the full program. */
  async simulate(text) {
    // Turning is a solid of revolution — a different model (radial profile),
    // routed to its own sim.
    if (get().mode === 'turn') return get().simulateTurning(text);
    if (get().mode !== 'mill') return;
    // Which model can actually show this cut — see `engine/sim/method.js`. A
    // multi-axis program (a Z-up height field carves one face, so the others
    // look uncut) and a cutter that only cuts near its tip (its groove has a
    // roof, and a column has one top-Z) both need the voxel block. Everything
    // else keeps the scrub-able height field.
    const plan = get().simPlan();
    if (plan.method === 'voxel') return get().simulateVoxel(text);
    const source = text ?? get().gcode;
    const {
      toolRadius, toolType, cellSize, stockTop, stockBase, stockMargin,
    } = get();
    // Off → no size, no origin, and the carver fits the blank to the toolpath
    // exactly as it did before any of this existed.
    const { stockSize, stockOrigin } = get().billetOpts();
    // A brand new session's targets start over; a stale value here could
    // coincidentally match the new session's and wrongly skip its first carve.
    set({ simStatus: 'running', error: null, _lastCarveTarget: null });
    try {
      const api = getSimWorker();
      const init = await api.init(source, {
        ...get().machineOpts(),
        radius: toolRadius, toolType, cellSize,
        cutter: get().toolCutter, flutes: get().toolFlutes, angle: get().toolAngle,
        // A slot cutter's thickness IS the slot it leaves — without it the
        // carvers would take out a channel the full diameter wide.
        thickness: get().toolThickness ?? undefined,
        margin: stockMargin,
        top: stockTop ?? undefined,
        base: stockBase ?? undefined,
        stockSize,
        stockOrigin,
        aIndex: get().aIndex ?? undefined,
        toolOverrides: get().toolOverrides,
      });
      const full = await api.carve(init.totalFeeds);
      // Store sim geometry outside React state.
      setBuffers({ sim: full });
      // Pressing Simulate means "run the program through the material", so the
      // playhead moves to the end to match what is now on screen. Without this
      // the full carve was immediately undone by `carveToPlayhead` whenever the
      // playhead sat at 0 — handing back an uncut block that read as a
      // simulator that had not run.
      const path = getBuf().path;
      if (path && get().playhead <= 0) set({ playhead: path.count, playT: 0 });
      set({
        bufVer: get().bufVer + 1,
        simStatus: 'done',
        showStock: true,
        simReady: true,
        removedVolume: full.removedVolume ?? 0,
        removalNote: removalDiagnosis({
          hasProgram: Boolean(source && source.trim()),
          feeds: init.totalFeeds,
          removedVolume: full.removedVolume ?? 0,
          cutBounds: init.cutBounds,
          box: init.box,
          followsPlayback: get().cutFollowsPlayback,
          playhead: get().playhead,
        }),
        totalFeeds: init.totalFeeds,
        aIndex: init.aIndex, // the engine's pick, if we didn't make one
        // The height field carves in the machine frame at exactly this index,
        // so the stock it returns is already turned that far.
        simFrameA: init.aIndex ?? 0,
      });
      set({ simMethod: 'height' });
      if (get().cutFollowsPlayback) get().carveToPlayhead();
    } catch (err) {
      set({ simStatus: 'error', error: err.message || String(err) });
    }
  },

  /**
   * One-shot voxel simulation: the whole part with every rotary face carved into
   * a single 3D block, undercuts included. Heavier than the height field and not
   * scrub-able, so it disables cut-follows-playback and runs at a coarser cell.
   */
  async simulateVoxel(text) {
    if (get().mode !== 'mill') return;
    const source = text ?? get().gcode;
    const {
      toolRadius, toolType, voxelSize, stockMargin,
    } = get();
    const { stockSize, stockOrigin } = get().billetOpts();
    set({ simStatus: 'running', error: null, _lastCarveTarget: null });
    try {
      const api = getSimWorker();
      // A session, not a one-shot: an undercutting cutter needs this model for
      // ordinary work now, so losing playback with it is not a trade the
      // operator can opt out of. `initVoxel` returns the uncut block; the
      // playhead carves it from there, exactly like the height field.
      const init = await api.initVoxel(source, {
        ...get().machineOpts(),
        radius: toolRadius, toolType,
        cutter: get().toolCutter, flutes: get().toolFlutes, angle: get().toolAngle,
        // How far up the tool cuts. Without it the carvers clear the whole
        // flute length and the groove comes back with its roof taken off.
        thickness: get().toolThickness ?? undefined,
        voxelSize, margin: stockMargin,
        stockSize, stockOrigin,
        toolOverrides: get().toolOverrides,
      });
      // Pressing Simulate means "run the program through the material", so the
      // whole thing is carved here and the playhead moves to the end to match
      // what is on screen — the same contract the height field has. Leaving it
      // to `carveToPlayhead` handed back an UNCUT block to anyone whose
      // cut-with-playback switch was off, which the old one-shot voxel run
      // turned off for them.
      const full = await api.carveVoxelStep(init.totalFeeds);
      setBuffers({ sim: full });
      set({
        bufVer: get().bufVer + 1,
        simStatus: 'done',
        showStock: true,
        simReady: true,          // scrub-able, like the height field
        // The one-shot voxel run turned this OFF, and nothing ever turned it
        // back on — so anyone who had used it got a playhead that carved
        // nothing, for a model that can now carve step by step.
        cutFollowsPlayback: true,
        totalFeeds: init.totalFeeds,
        _lastCarveTarget: init.totalFeeds,
        simMethod: 'voxel',
        // The grid may have been refined to hold the thinnest cut, or held back
        // by the budget — either way it is no longer the number in the box, so
        // the UI reads it from here.
        voxelSizeUsed: init.cellSizeZ,
        voxelLimited: !!init.limited,
        // The voxel sim assembles every face onto the part in the part frame,
        // so its block turns with the model from zero.
        simFrameA: 0,
      });
      const path = getBuf().path;
      if (path && get().playhead <= 0) set({ playhead: path.count, playT: 0 });
    } catch (err) {
      set({ simStatus: 'error', error: err.message || String(err) });
    }
  },

  /**
   * Turning material-removal: sweep the ZX profile with a sharp corner and
   * revolve the remaining radius into a solid. Runs as a stateful session so the
   * bar can be watched turning down with playback (cut-with-playback). Uses a
   * finer axial resolution than the mill grid so the turned profile is smooth.
   */
  async simulateTurning(text) {
    if (get().mode !== 'turn') return;
    const source = text ?? get().gcode;
    const { cellSize, stockMargin, stockOversize } = get();
    set({ simStatus: 'running', error: null, _lastCarveTarget: null });
    try {
      const api = getSimWorker();
      const init = await api.initTurning(source, {
        ...get().machineOpts(),
        // The radial field is cheap (one float per slice) and its resolution is
        // what curved features — an R, a spherical end — are limited by: near a
        // vertical tangent the radius swings across a single slice. The mesh no
        // longer costs a ring per slice (turningMesh simplifies the profile), so
        // the field can afford to be much finer than the milling cell size.
        cellSize: Math.min(cellSize, 0.05), margin: stockMargin, stockOversize,
      });
      setBuffers({ sim: init });
      set({
        bufVer: get().bufVer + 1,
        simStatus: 'done',
        showStock: true,
        simReady: true,        // enables cut-with-playback
        totalFeeds: init.totalFeeds,
        simMethod: 'turning',
      });
      if (get().cutFollowsPlayback) get().carveToPlayhead();
    } catch (err) {
      set({ simStatus: 'error', error: err.message || String(err) });
    }
  },

  /** Pick a standard turning tool subtype (drives the marker's appearance). */
  setTurnTool(turnTool) {
    set({ turnTool });
  },

  /**
   * Which simulator this setup needs, and why — the rule is pure, in
   * `engine/sim/method.js`. The UI asks the same question so the button can say
   * up front what pressing it will do, instead of the model changing under the
   * operator with no explanation.
   */
  simPlan() {
    return simMethodFor({
      rotaryIndices: getBuf().stats?.aIndices ?? [0],
      fallbackTool: { thickness: get().toolThickness ?? undefined },
      overrides: get().toolOverrides,
    });
  },

  /** Edit one tool's simulation geometry (merges into the override for that T). */
  setToolOverride(n, patch) {
    const cur = get().toolOverrides;
    const next = { ...cur, [n]: { ...(cur[n] || {}), ...patch } };
    set({ toolOverrides: next });
  },

  /**
   * Pick one tool's cutter type in the Tool table.
   *
   * `simType` is written alongside so the flat/ball the older carving code
   * speaks can never drift from the type on screen — the same rule `setCutter`
   * follows for the fallback tool. A type with its own angle brings that angle
   * with it, so switching to a chamfer mill does not leave a stale 30° behind
   * from whatever was picked before.
   */
  setToolCutter(n, id) {
    const c = cutterById(id);
    get().setToolOverride(n, {
      cutter: c.id,
      simType: simTypeOf(c.id),
      ...(c.angle ? { angle: c.angle } : {}),
      // A thickness and a shank belong to the type they were typed for — see
      // `setCutter`.
      thickness: undefined,
      shank: undefined,
    });
  },

  /**
   * One tool's cutting-body thickness (the slot width, for a slot cutter).
   *
   * `cutter` is the type the row is showing — which may have come from the
   * program's comment rather than from an override, so the store cannot look it
   * up on its own. It only bounds the clamp.
   */
  setToolThickness(n, mm, cutter) {
    get().setToolOverride(n, {
      thickness: mm == null ? undefined : clampThickness(cutter, mm),
    });
  },

  /** One tool's shank diameter — the plain part above the flutes. */
  setToolShank(n, mm, cutter) {
    get().setToolOverride(n, {
      shank: mm == null ? undefined : clampShank(cutter, mm),
    });
  },

  /** Clear a tool's overrides, reverting it to the auto-detected values. */
  clearToolOverride(n) {
    const next = { ...get().toolOverrides };
    delete next[n];
    set({ toolOverrides: next });
  },

  /** Carve the session up to the feed move implied by the current playhead. */
  async carveToPlayhead() {
    const {
      playhead, simReady, _carving, aIndex, simMethod, _lastCarveTarget,
    } = get();
    const path = getBuf().path;
    if (!path || !simReady || _carving) return;
    // Ticks fire every 40ms regardless of the toolpath's own pacing, so most
    // ticks during a slow or long move land on the same feed-move target as
    // the last one already carved — re-asking the worker (and re-building the
    // whole grid's mesh) for an answer that would come back byte-identical is
    // exactly the wasted, repeated work that showed up as stutter.
    // Where the cut has actually got, on the same clock the tool marker rides —
    // fractional, so the material comes off *under the tool* instead of a whole
    // block at a time. A 50 mm `G1` is one feed move: counting whole moves let
    // the tool cross the part with nothing happening, then dropped the entire
    // cut in at the end of it.
    //
    // The height field carves ONE rotary index, so it counts only that index's
    // feeds; turning and the voxel block carve every move there is.
    const seconds = get().playing ? get().playT : timeAt(path, playhead);
    const target = simMethod === 'height'
      ? feedProgressAt(path, seconds, aIndex ?? 0)
      : feedProgressAt(path, seconds);
    if (target === _lastCarveTarget) return;
    set({ _carving: true });
    try {
      const api = getSimWorker();
      let sim;
      if (simMethod === 'turning') sim = await api.carveTurningStep(target);
      else if (simMethod === 'voxel') sim = await api.carveVoxelStep(target);
      else sim = await api.carve(target);
      setBuffers({ sim });
      set({ bufVer: get().bufVer + 1, _carving: false, _lastCarveTarget: target });
    } catch (err) {
      set({ error: err.message || String(err), _carving: false });
    }
  },

  reset: () => {
    clearBuffers();
    set({
      bufVer: 0,
      status: 'idle',
      simStatus: 'idle',
      simReady: false,
      totalFeeds: 0,
      playhead: 0,
      playing: false,
      error: null,
      _lastCarveTarget: null,
    });
  },
}));
