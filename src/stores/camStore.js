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
import { feedsBeforeAt, feedsBefore } from '../engine/gcode/path.js';
import { setBuffers, clearBuffers, getBuf } from '../engine/bufferCache.js';

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
  page: 'mill',        // mill | turn | sketch
  diameterMode: true,  // turn only: the X word is a diameter
  rapidRate: 5000,     // mm/min — times G0 moves for the cycle-time estimate

  // ---- Camera ----
  view: 'iso',      // iso | top | front | back | left | right
  viewNonce: 0,     // bumped on every setView so re-picking the same view refits

  // ---- Playback ----
  playhead: 0,
  playT: 0,       // continuous machine time (s) under the playhead, for a smooth marker
  playing: false,

  // ---- Phase 1: material removal simulation ----
  toolRadius: 3,
  toolType: 'flat',
  cellSize: 0.5,
  voxelSize: 1,        // voxel sim resolution (mm) — coarser than the dexel cell
  simMethod: 'height', // 'height' (dexel) | 'voxel' (undercut) | 'turning' (revolved)
  // ---- Turning ----
  turnTool: 'mvjnr',   // selected OD toolholder type (marker appearance)
  stockOversize: 1,    // raw bar diameter over the largest turned diameter (mm)
  // ---- Tool table (user edits, keyed by tool number) ----
  // { [n]: { diameter?, simType?, length? } } — override the auto-detected values
  // so the simulated cutter matches the program's real tooling (milling).
  toolOverrides: {},
  stockTop: null,
  stockBase: null,
  stockMargin: 5,
  simStatus: 'idle',
  simReady: false,
  totalFeeds: 0,
  cutFollowsPlayback: true, // watch the stock carve as playback runs, by default
  showStock: true,
  _carving: false,
  // 4th-axis: the height-field simulator carves one rotary index at a time.
  // null = let the engine pick the one that does the most cutting.
  aIndex: null,

  setGcode: (gcode) => set({ gcode }),
  setTool: (patch) => set(patch),
  toggleStock: () => set((s) => ({ showStock: !s.showStock })),
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

  /** Machine options the interpreter needs, in both workers. */
  machineOpts() {
    const { mode, rapidRate, diameterMode } = get();
    return { mode, rapidRate, diameterMode };
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
    // A multi-axis program machines different tools on different rotary faces,
    // and a single Z-up height field can only carve one of them — which looked
    // like "only T3 cuts". Route those to the voxel sim, which carves every face
    // (and every tool) into one block. Single-axis jobs keep the scrub-able
    // height field.
    const idx = getBuf().stats?.aIndices ?? [0];
    if (idx.length > 1) return get().simulateVoxel(text);
    const source = text ?? get().gcode;
    const { toolRadius, toolType, cellSize, stockTop, stockBase, stockMargin } = get();
    set({ simStatus: 'running', error: null });
    try {
      const api = getSimWorker();
      const init = await api.init(source, {
        ...get().machineOpts(),
        radius: toolRadius, toolType, cellSize,
        margin: stockMargin,
        top: stockTop ?? undefined,
        base: stockBase ?? undefined,
        aIndex: get().aIndex ?? undefined,
        toolOverrides: get().toolOverrides,
      });
      const full = await api.carve(init.totalFeeds);
      // Store sim geometry outside React state.
      setBuffers({ sim: full });
      set({
        bufVer: get().bufVer + 1,
        simStatus: 'done',
        showStock: true,
        simReady: true,
        totalFeeds: init.totalFeeds,
        aIndex: init.aIndex, // the engine's pick, if we didn't make one
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
    const { toolRadius, toolType, voxelSize, stockMargin } = get();
    set({ simStatus: 'running', error: null, cutFollowsPlayback: false });
    try {
      const api = getSimWorker();
      const result = await api.runVoxel(source, {
        ...get().machineOpts(),
        radius: toolRadius, toolType,
        voxelSize, margin: stockMargin,
        toolOverrides: get().toolOverrides,
      });
      setBuffers({ sim: result });
      set({
        bufVer: get().bufVer + 1,
        simStatus: 'done',
        showStock: true,
        simReady: false, // voxel is not a scrub-able session
        totalFeeds: 0,
        simMethod: 'voxel',
      });
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
    set({ simStatus: 'running', error: null });
    try {
      const api = getSimWorker();
      const init = await api.initTurning(source, {
        ...get().machineOpts(),
        cellSize: Math.min(cellSize, 0.25), margin: stockMargin, stockOversize,
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

  /** Edit one tool's simulation geometry (merges into the override for that T). */
  setToolOverride(n, patch) {
    const cur = get().toolOverrides;
    const next = { ...cur, [n]: { ...(cur[n] || {}), ...patch } };
    set({ toolOverrides: next });
  },

  /** Clear a tool's overrides, reverting it to the auto-detected values. */
  clearToolOverride(n) {
    const next = { ...get().toolOverrides };
    delete next[n];
    set({ toolOverrides: next });
  },

  /** Carve the session up to the feed move implied by the current playhead. */
  async carveToPlayhead() {
    const { playhead, simReady, _carving, aIndex, simMethod } = get();
    const path = getBuf().path;
    if (!path || !simReady || _carving) return;
    set({ _carving: true });
    try {
      const api = getSimWorker();
      let sim;
      if (simMethod === 'turning') {
        // Turning carves every feed in order — no rotary index to filter.
        sim = await api.carveTurningStep(feedsBefore(path, playhead));
      } else {
        // The mill session only holds the feeds of one rotary index — count those.
        sim = await api.carve(feedsBeforeAt(path, playhead, aIndex ?? 0));
      }
      setBuffers({ sim });
      set({ bufVer: get().bufVer + 1, _carving: false });
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
    });
  },
}));
