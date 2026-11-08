/**
 * stdStore — the standard-cutting-speed check on a loaded program.
 *
 * Thin, as the store layer is meant to be: *what* is proposed is
 * `engine/cam/stdVc.js` (pure, tested), *where* the ranges come from is
 * `lib/stdApi.js`. This sequences them around the program that is loaded in
 * `camStore` and holds what the operator is being asked.
 *
 * It only ever PROPOSES. Nothing in the program changes until `apply()` — which
 * the operator presses after reading the table — and `apply()` keeps the text it
 * replaced so `restore()` can put it back. The program sets what a machine does;
 * a silent rewrite of its feeds and speeds is not a thing a helper may do.
 *
 * A program is checked once per distinct text (`lastSeen`): opening a file asks,
 * applying the answer does not ask again about its own output, and re-parsing for
 * a settings change does not either.
 */
import { create } from 'zustand';
import { useCamStore } from './camStore.js';
import { useCamPlanStore } from './camPlanStore.js';
import { machineById } from '../engine/cam/machines.js';
import { listStd, saveStd } from '../lib/stdApi.js';
import { interpret } from '../engine/gcode/interpreter.js';
import {
  detectMaterial, detectProgramMode, scanProgram, proposeStd, applyStd, rowTimes, DEFAULT_LIMITS,
} from '../engine/cam/stdVc.js';

/** Spindle ceiling for the program on screen: the picked machine's, else a safe default. */
function limitFor(mode) {
  const cam = useCamStore.getState();
  if (mode === 'turn') return cam.machineMaxTurnRpm > 0 ? cam.machineMaxTurnRpm : DEFAULT_LIMITS.turn;
  const m = machineById(useCamPlanStore.getState().machineId);
  // Never more than 8000 rpm, whatever the library says the machine could do: that
  // is the highest speed the shop's own programs are known to run on its mills, and
  // a proposal that asks for more rpm than the real spindle has would be clamped by
  // the control while F (mm/min) stays where it was — chip load jumps. A machine
  // with a lower ceiling still wins.
  return Math.min(m?.maxRpm > 0 ? m.maxRpm : DEFAULT_LIMITS.mill, DEFAULT_LIMITS.mill);
}

/**
 * The kind of program on screen: what its text says, and only when the text is
 * silent, the CAM tab's mode. The tab is whatever the operator last picked, so
 * trusting it alone read a lathe program opened under "Milling" as milling.
 */
export function modeOf(text, fileName, fallback) {
  return useStdStore.getState().modeOverride || detectProgramMode(text, fileName || '') || fallback;
}

function buildProposal(material, text, mode) {
  return proposeStd(scanProgram(text, { mode }), material, {
    maxRpm: limitFor(mode), diameters: useStdStore.getState().diameters,
  });
}

/**
 * Cycle time of the program as it is, and as it would be with the rows still
 * switched on — the same interpreter and machine options the viewport uses, so
 * the figure matches the Cycle time readout once applied. Never throws: a program
 * the interpreter cannot read just has no estimate.
 */
function estimate(text, proposal, off) {
  try {
    const cam = useCamStore.getState();
    const opts = { ...cam.machineOpts(), mode: modeOf(text, cam.fileName, cam.mode) };
    const run0 = interpret(text, opts);
    const before = run0.stats.cycleTime;
    const t0 = rowTimes(run0.segments, proposal.rows);
    const rowsOf = (t1) => Object.fromEntries(proposal.rows.map((r) => [r.id, { before: t0[r.id], after: t1[r.id] }]));
    const out = applyStd(text, proposal, { skip: new Set(Object.keys(off)) });
    if (out.applied === 0) return { before, after: before, rows: rowsOf(t0) };
    const run1 = interpret(out.text, opts);
    return { before, after: run1.stats.cycleTime, rows: rowsOf(rowTimes(run1.segments, proposal.rows)) };
  } catch {
    return null;
  }
}

export const useStdStore = create((set, get) => ({
  materials: [],
  loaded: false,
  loading: false,
  /** Why the table could not be read, as a sentence — or null. */
  error: null,

  open: false,
  /** The table editor (Tools ▸ Edit standard…). */
  editorOpen: false,
  /** What detectMaterial found for the current program, or null. */
  detection: null,
  selectedKey: null,
  proposal: null,
  /** { before, after } cycle time in seconds for the rows switched on, or null. */
  timing: null,
  /** 'mill' | 'turn' as read from the program text (see modeOf). */
  programMode: null,
  /** What the text alone says ('mill' | 'turn'), or null — shown beside "Auto". */
  detectedMode: null,
  /** The operator's own answer ('mill' | 'turn'); null means follow the program. */
  modeOverride: null,
  /** Row ids the operator switched off. */
  off: {},
  /** Ø (mm) the operator typed for tools whose header has none, by row id. Used for the sum only; never written to the program. */
  diameters: {},
  /** Text of the program as last offered, so the same program is not asked twice. */
  lastSeen: null,
  /** camStore.loadSeq / fileName at the last auto-check: tells opening a file from editing one. */
  lastLoadSeq: null,
  lastFileName: null,
  /** { text, fileName } to put back — set by apply(). */
  undo: null,
  /** { applied, stale } from the last apply(), for the one line that confirms it. */
  result: null,

  /** Read the table once; `force` re-reads it. Never throws. */
  async loadStandard(force = false) {
    if (get().loaded && !force) return get().materials;
    if (get().loading) return get().materials;
    set({ loading: true, error: null });
    try {
      const materials = await listStd();
      set({ materials, loaded: true, loading: false });
      return materials;
    } catch (err) {
      set({ loading: false, error: err?.message || String(err) });
      return [];
    }
  },

  /**
   * Look at the loaded program against the standard.
   *
   * Both automatic (a file was just opened) and manual (the menu) open the
   * dialog whenever a standard table is available, including a program already
   * inside its range. With no table at all, an automatic check stays silent.
   */
  async check({ manual = false, quiet = false } = {}) {
    const cam = useCamStore.getState();
    if (!cam.gcode) {
      if (manual) set({ open: true, error: 'Open a program first.', proposal: null, detection: null });
      return;
    }
    set({ result: null });
    const materials = await get().loadStandard();
    if (!materials.length) {
      // No standard to compare with (table not created yet, or the server is down).
      // An automatic check stays out of the way; a manual one says why.
      if (manual) set({ open: true });
      return;
    }
    const detection = detectMaterial({ fileName: cam.fileName || '', text: cam.gcode }, materials);
    const keep = get().selectedKey && materials.some((m) => m.key === get().selectedKey) ? get().selectedKey : null;
    const selectedKey = detection?.key ?? keep;
    const material = materials.find((m) => m.key === selectedKey);
    const proposal = material ? buildProposal(material, cam.gcode, modeOf(cam.gcode, cam.fileName, cam.mode)) : null;
    set({
      detection, selectedKey, proposal, off: {},
      programMode: modeOf(cam.gcode, cam.fileName, cam.mode),
      detectedMode: detectProgramMode(cam.gcode, cam.fileName || ''),
      timing: proposal ? estimate(cam.gcode, proposal, {}) : null,
      error: null,
    });
    // Always show it, even when everything is already in range: the table is also the
    // per-tool time breakdown, and "nothing to change" should be something the operator sees.
    // `quiet` (an edit of the open program) refreshes the proposal without opening the dialog.
    if (!quiet) set({ open: true });
  },

  /** Called when a program arrives: once per distinct text. */
  async autoCheck() {
    const cam = useCamStore.getState();
    if (!cam.gcode || !cam.fileName || cam.gcode === get().lastSeen) return;
    // A file was OPENED (a different name, or the same one loaded again) versus the same
    // program EDITED and re-parsed. Opening asks; editing only refreshes what Tools ▸ Standard
    // cutting speeds would show, so the dialog does not jump up after every keystroke-and-Parse.
    const fresh = cam.loadSeq !== get().lastLoadSeq || cam.fileName !== get().lastFileName;
    set({
      lastSeen: cam.gcode, lastLoadSeq: cam.loadSeq, lastFileName: cam.fileName,
      ...(fresh ? { modeOverride: null, diameters: {} } : {}),
    });
    await get().check({ manual: false, quiet: !fresh });
  },

  /** The operator names the material (nothing was detected, or the guess was wrong). */
  choose(key) {
    const cam = useCamStore.getState();
    const material = get().materials.find((m) => m.key === key);
    set({
      selectedKey: key, off: {}, error: null,
      proposal: material ? buildProposal(material, cam.gcode, modeOf(cam.gcode, cam.fileName, cam.mode)) : null,
      timing: null,
    });
    const { proposal } = get();
    if (proposal) set({ timing: estimate(cam.gcode, proposal, {}) });
  },

  /** 'auto' follows the program; 'turn' / 'mill' is the operator's answer. Re-proposes at once. */
  setProgramType(value) {
    const cam = useCamStore.getState();
    set({ modeOverride: value === 'turn' || value === 'mill' ? value : null, off: {}, error: null });
    const material = get().materials.find((m) => m.key === get().selectedKey);
    const programMode = modeOf(cam.gcode, cam.fileName, cam.mode);
    const proposal = material ? buildProposal(material, cam.gcode, programMode) : null;
    set({
      programMode, proposal,
      timing: proposal ? estimate(cam.gcode, proposal, {}) : null,
    });
  },

  /** The operator types a tool's Ø (blank / 0 clears it). Re-proposes; other rows' on/off choices stay. */
  setDiameter(id, value) {
    const cam = useCamStore.getState();
    const diameters = { ...get().diameters };
    const v = Number(value);
    if (v > 0) diameters[id] = v; else delete diameters[id];
    set({ diameters });
    const material = get().materials.find((x) => x.key === get().selectedKey);
    if (!material || !cam.gcode) return;
    const proposal = buildProposal(material, cam.gcode, modeOf(cam.gcode, cam.fileName, cam.mode));
    const off = { ...get().off };
    // A row that has just become a change starts switched on.
    delete off[id];
    set({ proposal, off, timing: estimate(cam.gcode, proposal, off) });
  },

  toggle(id) {
    const off = { ...get().off };
    if (off[id]) delete off[id]; else off[id] = true;
    set({ off });
    const { proposal } = get();
    if (proposal) set({ timing: estimate(useCamStore.getState().gcode, proposal, off) });
  },

  async openEditor() {
    await get().loadStandard(true);
    set({ editorOpen: true });
  },
  closeEditor() { set({ editorOpen: false }); },

  /** Save one material, re-read the table, and re-propose for the program on screen. Rejects with the server's sentence. */
  async saveMaterial(key, body) {
    await saveStd(key, body);
    const materials = await get().loadStandard(true);
    const cam = useCamStore.getState();
    const material = materials.find((m) => m.key === get().selectedKey);
    if (material && cam.gcode) {
      const proposal = buildProposal(material, cam.gcode, modeOf(cam.gcode, cam.fileName, cam.mode));
      set({ proposal, off: {}, timing: estimate(cam.gcode, proposal, {}) });
    }
  },

  /** Keep the program exactly as it is. */
  dismiss() {
    set({ open: false });
  },

  /** Rewrite the program with the rows still switched on, then reload it. */
  async apply() {
    const { proposal, off } = get();
    const cam = useCamStore.getState();
    if (!proposal) return;
    const out = applyStd(cam.gcode, proposal, { skip: new Set(Object.keys(off)) });
    if (out.applied === 0) {
      set({ error: out.stale > 0 ? 'The program changed since it was checked — check it again.' : 'Nothing selected to change.' });
      return;
    }
    set({
      undo: { text: cam.gcode, fileName: cam.fileName },
      lastSeen: out.text,
      result: { applied: out.applied, stale: out.stale },
      open: false, error: null,
    });
    await cam.parse(out.text);
    // Show where the program stands now, so a menu re-check starts from the truth.
    const material = get().materials.find((m) => m.key === get().selectedKey);
    if (material) {
      const proposal = buildProposal(material, out.text, modeOf(out.text, cam.fileName, cam.mode));
      set({ proposal, off: {}, timing: estimate(out.text, proposal, {}) });
    }
  },

  /** Put back the program as it was before the last apply(). */
  async restore() {
    const { undo } = get();
    if (!undo) return;
    set({ lastSeen: undo.text, undo: null, result: null });
    await useCamStore.getState().parse(undo.text);
  },

  clearResult() { set({ result: null }); },
}));
