/**
 * @vitest-environment jsdom
 *
 * The two run-mode behaviours, in the real `App`.
 *
 * `engine/view/sidebar.js` decides *what* is shown and is tested on its own;
 * `Viewport.arbor.test.jsx` proves the arbor flag reaches the scene graph. Neither
 * proves the thing the operator asked for actually happens when they press Play,
 * because that depends on App's own JSX gates and on the switch being wired to
 * the store at all. So this mounts App.
 *
 * Only the R3F canvas is stubbed — it needs WebGL and has its own scene-graph
 * tests. Everything else here is the shipping component and the real store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('./components/Viewport.jsx', () => ({
  default: () => React.createElement('div', { 'data-testid': 'viewport-stub' }),
}));

const { default: App } = await import('./App.jsx');
const { useCamStore } = await import('./stores/camStore.js');
const { interpret } = await import('./engine/gcode/interpreter.js');
const { buildPath, nextBlockEnd } = await import('./engine/gcode/path.js');
const { setBuffers, clearBuffers, getBuf } = await import('./engine/bufferCache.js');

let container;
let root;

async function mount() {
  await act(async () => {
    root.render(React.createElement(App));
  });
}

/** Set store state and let React settle. */
async function setStore(patch) {
  await act(async () => { useCamStore.setState(patch); });
}

/** The sidebar element, or null when the page has none (the sketch page). */
const sider = () => container.querySelector('.ant-layout-sider');

/**
 * Every command currently offered in the sidebar, by id.
 *
 * The toolbars are icon-only (see `engine/view/commands.js`), so there is no
 * text in a button to match on. `data-cmd` is what `CommandButton` stamps on
 * every one of them, and it is a far better handle than a label was: renaming
 * a command in the catalogue no longer silently breaks these.
 */
function siderCommands() {
  const el = sider();
  if (!el) return [];
  return [...el.querySelectorAll('button[data-cmd]')].map((b) => b.dataset.cmd);
}

/** A command button anywhere in the app, by id. */
const cmd = (id) => container.querySelector(`button[data-cmd="${id}"]`);

// jsdom has no layout, so it has no scrollIntoView; GcodePanel calls it to keep
// the executing line in view whenever the playhead moves.
Element.prototype.scrollIntoView = () => {};

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Milling page with a program loaded and parsed, paused at the start.
  useCamStore.setState({
    page: 'mill', mode: 'mill', gcode: 'G0 X0\nG1 X10 F100',
    playing: false, playhead: 0, showArbor: true, error: null,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the sidebar while setting up', () => {
  it('offers the file, project and setup controls', async () => {
    await mount();
    expect(siderCommands()).toEqual(
      expect.arrayContaining(['parse', 'saveProject', 'simulate']),
    );
  });

  it('names every icon-only button it offers', async () => {
    // The trade for dropping the words: a button with no text and no name is
    // unusable by anyone not already fluent in the glyph.
    await mount();
    for (const b of sider().querySelectorAll('button[data-cmd]')) {
      expect(b.getAttribute('aria-label'), b.dataset.cmd).toBeTruthy();
    }
  });

  it('shows the program listing', async () => {
    await mount();
    expect(sider().textContent).toContain('Program');
  });
});

describe('pressing Play collapses the sidebar to the program', () => {
  it('drops the file and project buttons', async () => {
    await mount();
    expect(siderCommands()).toContain('parse');
    await setStore({ playing: true });
    const cmds = siderCommands();
    expect(cmds).not.toContain('parse');
    expect(cmds).not.toContain('saveProject');
    expect(cmds).not.toContain('openProgram');
  });

  it('drops the material-removal controls', async () => {
    await mount();
    await setStore({ playing: true });
    expect(sider().textContent).not.toContain('Material removal');
    expect(siderCommands()).not.toContain('simulate');
  });

  it('drops the machine settings and the cycle-time figures', async () => {
    await mount();
    await setStore({ playing: true });
    expect(sider().textContent).not.toContain('Rapid');
    expect(sider().textContent).not.toContain('Cycle time');
  });

  it('keeps the program listing — the whole point of the collapse', async () => {
    await mount();
    await setStore({ playing: true });
    expect(sider().textContent).toContain('Program');
  });

  it('says why the rest went away', async () => {
    // A panel that empties itself with no explanation reads as a crash.
    await mount();
    await setStore({ playing: true });
    expect(sider().textContent).toMatch(/pause to edit/i);
  });

  it('never hides a parse failure', async () => {
    await mount();
    await setStore({ playing: true, error: 'Unbalanced bracket on line 4' });
    expect(sider().textContent).toContain('Parse failed');
  });

  it('brings the setup back on pause', async () => {
    await mount();
    await setStore({ playing: true });
    expect(siderCommands()).not.toContain('parse');
    await setStore({ playing: false });
    expect(siderCommands()).toContain('parse');
    expect(sider().textContent).toContain('Material removal');
  });
});

describe('the holder toggle', () => {
  // A pressed toolbar glyph now, not a labelled switch — so "on" reads off
  // antd's primary styling rather than aria-checked. Asserting the class is the
  // point: the pressed look IS the state readout once the words are gone, and a
  // toggle that flips the store without changing appearance is the bug here.
  const arborButton = () => cmd('showArbor');
  const isOn = () => arborButton().classList.contains('ant-btn-primary');

  it('is offered on the milling page', async () => {
    await mount();
    expect(arborButton()).not.toBeNull();
  });

  it('carries its name for anyone who does not read the glyph', async () => {
    await mount();
    expect(arborButton().getAttribute('aria-label')).toBe('Show holder');
  });

  it('starts on, with the arbor shown', async () => {
    await mount();
    expect(useCamStore.getState().showArbor).toBe(true);
    expect(isOn()).toBe(true);
  });

  it('hides the arbor when clicked, and brings it back', async () => {
    await mount();
    await act(async () => { arborButton().click(); });
    expect(useCamStore.getState().showArbor).toBe(false);
    expect(isOn()).toBe(false);

    await act(async () => { arborButton().click(); });
    expect(useCamStore.getState().showArbor).toBe(true);
    expect(isOn()).toBe(true);
  });

  it('stays available while the program runs', async () => {
    // The collapse is the sidebar's business; the viewport toolbar keeps working.
    await mount();
    await setStore({ playing: true });
    expect(arborButton()).not.toBeNull();
  });

  it('is withheld on the lathe, where it would do nothing', async () => {
    await setStore({ page: 'turn', mode: 'turn' });
    await mount();
    expect(arborButton()).toBeNull();
  });
});

describe('the single-block controls', () => {
  // Three plainly separate blocks, so a step lands somewhere identifiable.
  const PROGRAM = ['G0 X0 Y0 Z5', 'G1 Z-1 F200', 'G1 X20 F400'].join('\n');

  /** A toolbar button, found by the icon it carries. */
  const iconBtn = (name) =>
    container.querySelector(`[aria-label="${name}"]`)?.closest('button') ?? null;

  /** The distance-to-go cell of an axis row in the position readout. */
  const dtg = (label) =>
    container.querySelector(`[data-dtg="${label}"]`)?.textContent ?? null;

  /** Put a real parsed path in the buffer cache, the way parse() does. */
  async function loadProgram() {
    const { segments } = interpret(PROGRAM, { mode: 'mill' });
    const path = buildPath(segments);
    setBuffers({ path });
    await setStore({ gcode: PROGRAM, bufVer: 1, playhead: 0, playT: 0, playing: false });
    return path;
  }

  afterEach(() => clearBuffers());

  it('sits either side of Play', async () => {
    await mount();
    await loadProgram();
    expect(iconBtn('step-forward')).not.toBeNull();
    expect(iconBtn('step-backward')).not.toBeNull();
    // Restart is still there, and is no longer wearing the step icon.
    expect(iconBtn('fast-backward')).not.toBeNull();
  });

  it('advances exactly one block per press', async () => {
    await mount();
    const path = await loadProgram();
    await act(async () => { iconBtn('step-forward').click(); });
    const first = useCamStore.getState().playhead;
    expect(first).toBe(nextBlockEnd(path, 0));
    expect(first).toBeGreaterThan(0);

    await act(async () => { iconBtn('step-forward').click(); });
    expect(useCamStore.getState().playhead).toBe(nextBlockEnd(path, first));
  });

  it('stops a run in progress, like a cycle stop', async () => {
    await mount();
    await loadProgram();
    await setStore({ playing: true });
    await act(async () => { iconBtn('step-forward').click(); });
    expect(useCamStore.getState().playing).toBe(false);
  });

  it('steps back off the start of the program without moving', async () => {
    await mount();
    await loadProgram();
    // Disabled at the start — there is no block behind the playhead to replay.
    expect(iconBtn('step-backward').disabled).toBe(true);
    expect(useCamStore.getState().playhead).toBe(0);
  });

  it('posts the queued block on the dist-to-go column after a step', async () => {
    // Stopped at the end of `G0 Z5`, what is queued is `G1 Z-1`: 6 mm of Z.
    await mount();
    await loadProgram();
    await act(async () => { iconBtn('step-forward').click(); });
    expect(dtg('Z')).toBe('-6.000');
    expect(dtg('X')).toBe('0.000');
  });
});

describe('the Material removal panel', () => {
  /** Put a parsed program (and optionally a detected tool table) in the cache. */
  async function loadWithTools(tools) {
    const src = 'G0 X0 Y0 Z5\nG1 Z-8 F200\nG1 X60 Y40 F400';
    const { segments, bounds } = interpret(src, { mode: 'mill' });
    setBuffers({ path: buildPath(segments), bounds, stats: { tools, aIndices: [0] } });
    await setStore({ gcode: src, bufVer: 1, playing: false });
  }

  afterEach(() => clearBuffers());

  it('keeps the fallback cutter behind a + when the program names its tools', async () => {
    await mount();
    await loadWithTools([{ n: 1, radius: 3, cutLength: 40 }]);
    expect(cmd('toolFallback')).not.toBeNull();
    expect(sider().textContent).not.toContain('Tool ⌀');
  });

  it('opens the fallback on click, with every cutter type offered', async () => {
    await mount();
    await loadWithTools([{ n: 1, radius: 3, cutLength: 40 }]);
    await act(async () => { cmd('toolFallback').click(); });
    for (const id of ['endmill', 'shoulder', 'face', 'slot', 'ball', 'chamfer']) {
      expect(container.querySelector(`button[data-cutter="${id}"]`), id).not.toBeNull();
    }
  });

  it('stays behind the + even when the program names no tool', async () => {
    // The first cut at this opened the form automatically whenever nothing was
    // detected — which is the common case, so the + was never actually seen and
    // the row looked as permanent as the one it replaced.
    await mount();
    await loadWithTools([]);
    expect(cmd('toolFallback')).not.toBeNull();
    expect(container.querySelector('button[data-cutter="endmill"]')).toBeNull();
    // ...but it says which cutter the sim will use, since nothing else can.
    expect(sider().textContent).toMatch(/the program names none/);
  });

  it('asks for the billet as a size and an origin, not top/base/margin', async () => {
    await mount();
    await loadWithTools([]);
    const text = sider().textContent;
    expect(text).toContain('Stock');
    expect(text).toContain('Origin');
    expect(text).not.toMatch(/top auto|bot auto/);
  });

  it('prints the resulting extents, so "origin" cannot be misread', async () => {
    // Which corner the origin is cannot be settled by a label. An 80 x 60 x 20
    // block with no origin is centred on the cutting with its top on Z0.
    await mount();
    await loadWithTools([]);
    await act(async () => { useCamStore.getState().setStockSize({ x: 80, y: 60, z: 20 }); });
    expect(sider().textContent).toMatch(/Z -20\.0 … 0\.0/);
  });

  it('lets a stated Z origin lift the blank off Z0', async () => {
    // The forcing is gone: a datum on the vice, not on the raw top.
    await mount();
    await loadWithTools([]);
    await act(async () => {
      useCamStore.getState().setStockSize({ x: 80, y: 60, z: 20 });
      useCamStore.getState().setStockOrigin({ z: -12 });
    });
    expect(sider().textContent).toMatch(/Z -12\.0 … 8\.0/);
  });

  it('treats a Z origin of 0 as stated, not as blank', async () => {
    await mount();
    await loadWithTools([]);
    await act(async () => {
      useCamStore.getState().setStockSize({ x: 80, y: 60, z: 20 });
      useCamStore.getState().setStockOrigin({ z: 0 });
    });
    expect(sider().textContent).toMatch(/Z 0\.0 … 20\.0/);
  });

  it('writes a typed dimension through to the store', async () => {
    await mount();
    await loadWithTools([]);
    await act(async () => { useCamStore.getState().setStockSize({ x: 80 }); });
    expect(useCamStore.getState().stockSize.x).toBe(80);
  });

  it('warns when the program cuts outside the stated blank', async () => {
    // The program spans 60 mm in X and cuts 8 mm deep; a 20 × 20 × 2 blank
    // cannot hold it, and saying so before the sim runs is the point.
    await mount();
    await loadWithTools([]);
    await act(async () => { useCamStore.getState().setStockSize({ x: 20, y: 20, z: 2 }); });
    expect(sider().textContent).toMatch(/The program cuts outside the blank/);
  });

  it('offers a fit that clears its own warning', async () => {
    await mount();
    await loadWithTools([]);
    await act(async () => { useCamStore.getState().setStockSize({ x: 20, y: 20, z: 2 }); });
    await act(async () => { cmd('fitStock').click(); });
    expect(sider().textContent).not.toMatch(/The program cuts outside the blank/);
  });

  it('says how the two simulators differ, where the choice is made', async () => {
    await mount();
    await loadWithTools([]);
    expect(sider().textContent).toMatch(/height field/);
    expect(sider().textContent).toMatch(/voxel block/);
  });
});

describe('the stock toggle and its live preview', () => {
  async function loadProgramOnly() {
    const src = 'G0 X0 Y0 Z5\nG1 Z-8 F200\nG1 X60 Y40 F400';
    const { segments, bounds } = interpret(src, { mode: 'mill' });
    setBuffers({ path: buildPath(segments), bounds, stats: { tools: [], aIndices: [0] } });
    await setStore({ gcode: src, bufVer: 1, playing: false });
  }

  afterEach(() => {
    clearBuffers();
    useCamStore.setState({
      stockEnabled: true,
      stockSize: { x: null, y: null, z: null },
      stockOrigin: { x: null, y: null, z: null },
    });
  });

  it('offers an on/off button for the stock', async () => {
    await mount();
    await loadProgramOnly();
    expect(cmd('stockEnabled')).not.toBeNull();
    expect(cmd('stockEnabled').getAttribute('aria-label')).toBe('Use this stock');
  });

  it('starts on, so the blank is used and drawn', async () => {
    await mount();
    await loadProgramOnly();
    expect(useCamStore.getState().stockEnabled).toBe(true);
    expect(cmd('stockEnabled').classList.contains('ant-btn-primary')).toBe(true);
  });

  it('switches off and back on', async () => {
    await mount();
    await loadProgramOnly();
    await act(async () => { cmd('stockEnabled').click(); });
    expect(useCamStore.getState().stockEnabled).toBe(false);
    expect(cmd('stockEnabled').classList.contains('ant-btn-primary')).toBe(false);
    await act(async () => { cmd('stockEnabled').click(); });
    expect(useCamStore.getState().stockEnabled).toBe(true);
  });

  it('greys the size fields out when the stock is off', async () => {
    await mount();
    await loadProgramOnly();
    await act(async () => { cmd('stockEnabled').click(); });
    expect(sider().textContent).toMatch(/Stock off/);
    expect(cmd('fitStock')).toBeNull();
  });

  it('stops the sim using the stated blank when switched off', async () => {
    // The toggle has to reach the carver, not just the drawing.
    await mount();
    await loadProgramOnly();
    await act(async () => { useCamStore.getState().setStockSize({ x: 80, y: 60, z: 20 }); });
    expect(useCamStore.getState().billetOpts().stockSize).toBeTruthy();
    await act(async () => { cmd('stockEnabled').click(); });
    expect(useCamStore.getState().billetOpts()).toEqual({});
  });

  it('updates the extents readout as the numbers change, with no Simulate', async () => {
    // The whole feature: type, and the blank follows. No worker, no carve.
    await mount();
    await loadProgramOnly();
    await act(async () => {
      useCamStore.getState().setStockSize({ x: 50, y: 50, z: 28 });
      useCamStore.getState().setStockOrigin({ x: -25, y: -25, z: 0 });
    });
    expect(useCamStore.getState().simStatus).toBe('idle');
    expect(sider().textContent).toMatch(/X -25\.0 … 25\.0/);

    await act(async () => { useCamStore.getState().setStockOrigin({ x: 15 }); });
    expect(sider().textContent).toMatch(/X 15\.0 … 65\.0/);
  });

  it('leaves the carved block alone when the stock is toggled', async () => {
    // Flipping the toggle changes which blank the NEXT run starts from. Binning
    // a result the operator is reading to make that point is picking a fight.
    await mount();
    await loadProgramOnly();
    setBuffers({ sim: { positions: new Float32Array(9), indices: new Uint32Array(3) } });
    await act(async () => { cmd('stockEnabled').click(); });
    expect(getBuf().sim).toBeTruthy();
  });
});

describe('sizing stock before any program exists', () => {
  // The reported failure: with nothing parsed, the blank never appeared, so it
  // still looked as though pressing Simulate was what made material show up.
  // App gated the box on `bounds`, which is null until a program is read.
  beforeEach(async () => {
    clearBuffers();
    useCamStore.setState({
      gcode: '', bufVer: 1, stockEnabled: true,
      stockSize: { x: null, y: null, z: null },
      stockOrigin: { x: null, y: null, z: null },
    });
  });

  it('still offers the stock controls with no program loaded', async () => {
    await mount();
    expect(getBuf().bounds).toBeNull();
    expect(cmd('stockEnabled')).not.toBeNull();
  });

  it('reports the blank the moment a size is typed, no program needed', async () => {
    await mount();
    await act(async () => {
      useCamStore.getState().setStockSize({ x: 50, y: 50, z: 28 });
      useCamStore.getState().setStockOrigin({ x: -25, y: -25, z: 0 });
    });
    // Extents on screen means App built a box — the same box it hands the
    // viewport to draw.
    expect(sider().textContent).toMatch(/X -25\.0 … 25\.0/);
    expect(sider().textContent).toMatch(/Z 0\.0 … 28\.0/);
    expect(useCamStore.getState().simStatus).toBe('idle');
  });

  it('follows each keystroke without a simulation running', async () => {
    await mount();
    await act(async () => { useCamStore.getState().setStockSize({ x: 50, y: 50, z: 28 }); });
    expect(sider().textContent).toMatch(/X -25\.0 … 25\.0/);
    await act(async () => { useCamStore.getState().setStockSize({ x: 90 }); });
    expect(sider().textContent).toMatch(/X -45\.0 … 45\.0/);
    expect(useCamStore.getState().simStatus).toBe('idle');
  });

  it('says nothing at all with neither a program nor a size', async () => {
    // A margin box round the origin is not a billet, it is the absence of one.
    await mount();
    expect(sider().textContent).not.toMatch(/X -?\d+\.\d … /);
  });
});

describe('choosing the cutting tool', () => {
  const cutterBtn = (id) => container.querySelector(`button[data-cutter="${id}"]`);

  async function openPicker() {
    const src = 'G0 X0 Y0 Z5\nG1 Z-8 F200\nG1 X60 F400';
    const { segments, bounds } = interpret(src, { mode: 'mill' });
    setBuffers({ path: buildPath(segments), bounds, stats: { tools: [], aIndices: [0] } });
    await setStore({ gcode: src, bufVer: 1, playing: false });
    await act(async () => { cmd('toolFallback').click(); });
  }

  afterEach(() => {
    clearBuffers();
    useCamStore.getState().setCutter('endmill');
  });

  it('names every type for anyone who does not read the glyph', async () => {
    await mount();
    await openPicker();
    expect(cutterBtn('face').getAttribute('aria-label')).toBe('Face mill');
    expect(cutterBtn('chamfer').getAttribute('aria-label')).toBe('Chamfer mill');
  });

  it('picks a type and shows it pressed', async () => {
    await mount();
    await openPicker();
    await act(async () => { cutterBtn('ball').click(); });
    expect(useCamStore.getState().toolCutter).toBe('ball');
    expect(cutterBtn('ball').classList.contains('ant-btn-primary')).toBe(true);
    expect(cutterBtn('endmill').classList.contains('ant-btn-primary')).toBe(false);
  });

  it('moves the carving profile with the type', async () => {
    // The flat/ball the carvers speak is derived, never set by hand, so it
    // cannot drift from the type on screen.
    await mount();
    await openPicker();
    await act(async () => { cutterBtn('ball').click(); });
    expect(useCamStore.getState().toolType).toBe('ball');
    await act(async () => { cutterBtn('face').click(); });
    expect(useCamStore.getState().toolType).toBe('flat');
  });

  it('resets the flute count to what the new type is made in', async () => {
    // 6 flutes is right for a face mill and not a thing on a slot drill.
    await mount();
    await openPicker();
    await act(async () => { cutterBtn('face').click(); });
    expect(useCamStore.getState().toolFlutes).toBe(6);
    await act(async () => { cutterBtn('slot').click(); });
    expect(useCamStore.getState().toolFlutes).toBe(2);
  });

  it('clamps a flute count the type is not made in', async () => {
    await mount();
    await openPicker();
    await act(async () => { cutterBtn('slot').click(); });
    await act(async () => { useCamStore.getState().setFlutes(12); });
    expect(useCamStore.getState().toolFlutes).toBe(3);
  });

  it('offers the included angle only for a chamfer mill', async () => {
    await mount();
    await openPicker();
    expect(sider().textContent).not.toContain('∠');
    await act(async () => { cutterBtn('chamfer').click(); });
    expect(sider().textContent).toContain('∠');
  });

  it('warns about a diameter the type is not made in, without blocking it', async () => {
    await mount();
    await openPicker();
    await act(async () => { cutterBtn('face').click(); });   // default ⌀6
    expect(sider().textContent).toMatch(/not usually made below/);
    expect(useCamStore.getState().toolCutter).toBe('face');
  });

  it('hands the chosen type to the carver, not just the picture', async () => {
    await mount();
    await openPicker();
    await act(async () => { cutterBtn('chamfer').click(); });
    const s = useCamStore.getState();
    expect(s.toolCutter).toBe('chamfer');
    expect(s.toolAngle).toBe(90);
  });
});
