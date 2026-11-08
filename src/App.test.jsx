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

// The canvas needs WebGL, so it is stubbed — but the marker props are exactly
// what "does the tool on screen follow the tool that is cutting?" comes down to,
// so the stub reports them.
vi.mock('./components/Viewport.jsx', () => ({
  default: (props) => React.createElement('div', {
    'data-testid': 'viewport-stub',
    'data-tool-cutter': props.toolCutter ?? '',
    'data-tool-type': props.toolType ?? '',
    'data-tool-radius': String(props.toolRadius ?? ''),
    'data-tool-thickness': String(props.toolThickness ?? ''),
    'data-tool-shank': String(props.toolShank ?? ''),
  }),
}));

const { default: App } = await import('./App.jsx');
const { useCamStore } = await import('./stores/camStore.js');
const { interpret } = await import('./engine/gcode/interpreter.js');
const { buildPath, nextBlockEnd } = await import('./engine/gcode/path.js');
const { setBuffers, clearBuffers, getBuf } = await import('./engine/bufferCache.js');
const { useCamPlanStore } = await import('./stores/camPlanStore.js');

let container;
let root;

async function mount({ setup = true } = {}) {
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => {
    root.render(React.createElement(App));
  });
  // What used to be a permanent sidebar is now the **Setup drawer**, opened
  // from the toolbar — the left column belongs to the feature tree, the way a
  // CAD lays a part window out. These tests are about what setup offers in each
  // run state, so they open it; the drawer is closed by default because setting
  // a job up is done once, not watched while cutting.
  if (setup) await openSetup();
}

/** Press the toolbar's Setup button and let the drawer mount. */
async function openSetup() {
  const btn = q('[data-open-setup]');
  if (!btn) return;
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Set store state and let React settle. */
async function setStore(patch) {
  await act(async () => { useCamStore.setState(patch); });
}

/**
 * The setup panel's body, or null when the drawer has never been opened.
 * Portalled to `document.body`, not inside `container`.
 */
const sider = () => document.querySelector('.ant-drawer-body');

/**
 * Query the whole document, not just the render container.
 *
 * The Setup drawer is portalled to `document.body`, so a helper scoped to the
 * container stopped seeing most of what these tests are about the moment the
 * sidebar became a drawer. `container` is inside the document, so widening the
 * search costs nothing and misses nothing.
 */
const q = (sel) => document.querySelector(sel);

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

/** The same, for the two rails that float over the viewport: the view toolbar, then the bottom one. */
function railCommands() {
  return [...document.querySelectorAll('[data-cam-hud], [data-cam-overlay="bottom"]')]
    .flatMap((el) => [...el.querySelectorAll('button[data-cmd]')])
    .map((b) => b.dataset.cmd);
}

/** The same, for the Ribbon. */
function ribbonCommands() {
  const el = document.querySelector('[data-cam-ribbon]');
  if (!el) return [];
  return [...el.querySelectorAll('button[data-cmd]')].map((b) => b.dataset.cmd);
}

/** A command button anywhere in the app, by id. */
const cmd = (id) => q(`button[data-cmd="${id}"]`);

/** The tool the viewport is being asked to draw — see the Viewport stub. */
function marker() {
  const el = q('[data-testid="viewport-stub"]');
  return {
    cutter: el.dataset.toolCutter,
    type: el.dataset.toolType,
    radius: Number(el.dataset.toolRadius),
    thickness: el.dataset.toolThickness,
    shank: el.dataset.toolShank,
  };
}

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
  try { window.localStorage.clear(); } catch { /* no localStorage in this env */ }
});

describe('the sidebar while setting up', () => {
  it('offers the setup controls — open/sample/library/export moved to the File menu', async () => {
    await mount();
    expect(siderCommands()).toEqual(expect.arrayContaining(['simulateVoxel']));
    expect(siderCommands()).not.toEqual(
      expect.arrayContaining(['openProgram', 'openLibrary', 'exportGcode']),
    );
  });

  it('keeps Parse on the Ribbon, on screen and once only — it is pressed after every edit', async () => {
    // Parse is pressed after every edit and redraws the backplot; from the drawer
    // it was behind the picture it redraws. Opening a file is not a mid-session
    // action — see the File menu, `MenuBar.test.jsx`.
    await mount();
    expect(siderCommands()).not.toContain('parse');
    expect(ribbonCommands()).toContain('parse');
    expect(railCommands()).not.toContain('parse');
  });

  it('keeps Simulate on the Ribbon and its grid size in the drawer', async () => {
    // The number it is judged AT is a setting typed once per job. Splitting them
    // that way is the point — a button on screen and a drawer you fill in.
    await mount();
    expect(siderCommands()).not.toContain('simulate');
    expect(ribbonCommands()).toContain('simulate');
    expect(railCommands()).not.toContain('simulate');
    // The height-field grid box is still in the drawer, and now says which
    // resolution it is now that the glyph beside it has gone.
    expect(sider().textContent).toContain('Height field');
  });

  it('names every icon-only button it offers', async () => {
    // The trade for dropping the words: a button with no text and no name is
    // unusable by anyone not already fluent in the glyph.
    await mount();
    for (const b of sider().querySelectorAll('button[data-cmd]')) {
      // eslint-disable-next-line jest/valid-expect
      expect(b.getAttribute('aria-label'), b.dataset.cmd).toBeTruthy();
    }
  });

  it('shows the program listing', async () => {
    await mount();
    expect(sider().textContent).toContain('Program');
  });
});

describe('the rails over the viewport', () => {
  const inHud = (id) => q(`[data-cam-hud] button[data-cmd="${id}"]`);
  const onBottom = (id) => q(`[data-cam-overlay="bottom"] button[data-cmd="${id}"]`);

  it('keeps only framing and what is drawn in the view toolbar', async () => {
    await mount();
    for (const id of ['fitView', 'showToolpath']) {
      // eslint-disable-next-line jest/valid-expect
      expect(inHud(id), id).not.toBeNull();
    }
    expect(onBottom('showToolpath')).toBeNull();
    expect(inHud('simulate')).toBeNull();
  });

  it('keeps only playback on the bottom rail', async () => {
    await mount();
    for (const id of ['restart', 'play']) {
      // eslint-disable-next-line jest/valid-expect
      expect(onBottom(id), id).not.toBeNull();
    }
    expect(q('[data-cam-overlay="bottom"] [data-open-setup]')).toBeNull();
    expect(inHud('play')).toBeNull();
  });

  it('has no bottom rail on the Sketch page, where there is nothing to play', async () => {
    await setStore({ page: 'sketch' });
    await mount({ setup: false });
    expect(q('[data-cam-overlay="bottom"]')).toBeNull();
  });

  it('offers Setup once, on the Ribbon', async () => {
    await mount({ setup: false });
    expect(document.querySelectorAll('[data-open-setup]')).toHaveLength(1);
    expect(q('[data-cam-ribbon] [data-open-setup]')).not.toBeNull();
  });

  it('declares the view toolbar as top chrome, so Fit leaves room for it', async () => {
    await mount();
    expect(q('[data-cam-hud]').getAttribute('data-cam-overlay')).toBe('top');
  });
});

describe('the tabs under the viewport', () => {
  const tab = (value) => q(`[data-workspace-tab="${value}"]`);
  const selected = () => [...document.querySelectorAll('[data-workspace-tab][aria-selected="true"]')]
    .map((b) => b.dataset.workspaceTab);
  const press = (value) => act(async () => { tab(value).click(); });

  it('starts on Model', async () => {
    await mount({ setup: false });
    expect(selected()).toEqual(['model']);
  });

  it('shows the program in the left column from Program', async () => {
    await mount({ setup: false });
    await press('program');
    expect(selected()).toEqual(['program']);
    expect(q('[data-column-pane]').getAttribute('data-column-pane')).toBe('program');
  });

  it('follows the left column when playback moves it to the program', async () => {
    await mount({ setup: false });
    await setStore({ playing: true });
    expect(selected()).toEqual(['program']);
  });

  it('does not light Simulation for Setup opened from the Ribbon', async () => {
    await mount();
    expect(sider()).not.toBeNull();
    expect(selected()).toEqual(['model']);
  });

  it('opens the drawer from Library, and Model closes it again', async () => {
    await mount({ setup: false });
    await press('library');
    expect(selected()).toEqual(['library']);
    await press('model');
    expect(selected()).toEqual(['model']);
  });

  it('opens Setup from Simulation', async () => {
    await mount({ setup: false });
    await press('simulation');
    expect(selected()).toEqual(['simulation']);
    expect(sider().textContent).toContain('Material removal');
  });
});

describe('pressing Play collapses the sidebar to the program', () => {
  it('drops the material-removal controls', async () => {
    await mount();
    await setStore({ playing: true });
    expect(sider().textContent).not.toContain('Material removal');
    expect(siderCommands()).not.toContain('simulate');
  });

  it('drops the machine settings', async () => {
    await mount();
    await setStore({ playing: true });
    expect(sider().textContent).not.toContain('Rapid');
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

  it('never hides a parse failure — and needs nothing opened to show it', async () => {
    // The oldest rule in `engine/view/sidebar.js`: a failure must not be
    // suppressed by a mode change. It is stronger now than when the listing
    // lived in the sidebar — the error is in the **left column**, which is
    // always on screen, so it does not depend on Setup being open at all.
    await mount({ setup: false });
    await setStore({ playing: true, error: 'Unbalanced bracket on line 4' });
    expect(container.textContent).toContain('Parse failed');
    expect(container.textContent).toContain('Unbalanced bracket on line 4');
  });

  it('shows the program while it runs, without Setup being open', async () => {
    // What broke when setup became a drawer: pressing Play left nothing to
    // watch, because the listing had gone into the drawer with everything else.
    await mount({ setup: false });
    const src = ['G0 X0 Y0 Z5', 'G1 Z-2 F200', 'G1 X40 F400'].join(String.fromCharCode(10));
    await setStore({ gcode: src, playing: true });
    // The column switched itself to Program, and the text is on screen.
    expect(container.textContent).toContain('G1 X40 F400');
  });

  it('brings the setup back on pause', async () => {
    await mount();
    await setStore({ playing: true });
    expect(sider().textContent).not.toContain('Material removal');
    await setStore({ playing: false });
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

describe('the tool toggle', () => {
  // Turning's counterpart to the holder toggle: the lathe marker is one piece
  // (holder + insert), so there is nothing to drop separately — this hides the
  // whole thing, which is what sits over the cut an operator wants to see.
  const toolButton = () => cmd('showTool');
  const isOn = () => toolButton().classList.contains('ant-btn-primary');

  it('is offered on the lathe page', async () => {
    await setStore({ page: 'turn', mode: 'turn' });
    await mount();
    expect(toolButton()).not.toBeNull();
  });

  it('carries its name for anyone who does not read the glyph', async () => {
    await setStore({ page: 'turn', mode: 'turn' });
    await mount();
    expect(toolButton().getAttribute('aria-label')).toBe('Show tool');
  });

  it('starts on, with the tool shown', async () => {
    await setStore({ page: 'turn', mode: 'turn' });
    await mount();
    expect(useCamStore.getState().showTool).toBe(true);
    expect(isOn()).toBe(true);
  });

  it('hides the tool when clicked, and brings it back', async () => {
    await setStore({ page: 'turn', mode: 'turn' });
    await mount();
    await act(async () => { toolButton().click(); });
    expect(useCamStore.getState().showTool).toBe(false);
    expect(isOn()).toBe(false);

    await act(async () => { toolButton().click(); });
    expect(useCamStore.getState().showTool).toBe(true);
    expect(isOn()).toBe(true);
  });

  it('stays available while the program runs', async () => {
    await setStore({ page: 'turn', mode: 'turn' });
    await mount();
    await setStore({ playing: true });
    expect(toolButton()).not.toBeNull();
  });

  it('is withheld on the milling page, where it would do nothing', async () => {
    await mount();
    expect(toolButton()).toBeNull();
  });

  it('sits on the viewport rail, next to the toolpath toggle', async () => {
    await setStore({ page: 'turn', mode: 'turn' });
    await mount();
    const rail = railCommands();
    expect(rail).toContain('showTool');
    expect(Math.abs(rail.indexOf('showTool') - rail.indexOf('showToolpath'))).toBe(1);
  });
});

describe('the toolpath toggle', () => {
  // The backplot covers the very surface it describes on a dense program, so it
  // drops the same way the holder does — and sits beside it, because they are
  // the same question asked of two different things in the way of the cut.
  const pathButton = () => cmd('showToolpath');
  const isOn = () => pathButton().classList.contains('ant-btn-primary');

  it('sits on the viewport rail, next to the holder toggle', async () => {
    await mount();
    expect(pathButton()).not.toBeNull();
    const rail = railCommands();
    expect(rail).toContain('showToolpath');
    expect(Math.abs(rail.indexOf('showToolpath') - rail.indexOf('showArbor'))).toBe(1);
  });

  it('carries its name for anyone who does not read the glyph', async () => {
    await mount();
    expect(pathButton().getAttribute('aria-label')).toBe('Show toolpath');
  });

  it('starts on, with the backplot drawn', async () => {
    await mount();
    expect(useCamStore.getState().showToolpath).toBe(true);
    expect(isOn()).toBe(true);
  });

  it('hides the toolpath when clicked, and brings it back', async () => {
    await mount();
    await act(async () => { pathButton().click(); });
    expect(useCamStore.getState().showToolpath).toBe(false);
    expect(isOn()).toBe(false);

    await act(async () => { pathButton().click(); });
    expect(useCamStore.getState().showToolpath).toBe(true);
    expect(isOn()).toBe(true);
  });

  it('stays available while the program runs', async () => {
    await mount();
    await setStore({ playing: true });
    expect(pathButton()).not.toBeNull();
  });
});

describe('Simulate is on the Ribbon in both modes', () => {
  // Carving the material and then hiding the backplot to look at what came off is
  // one motion, so neither end of it may be behind the drawer. Turning was once left
  // there, which made the lathe the one mode where that motion crossed the screen.
  const ribbonSim = () => ribbonCommands().find((c) => c.startsWith('simulate'));

  it('is on the Ribbon for milling', async () => {
    await mount();
    expect(ribbonSim()).toBe('simulate');
  });

  it('is on the Ribbon for turning, not in the drawer', async () => {
    await setStore({ page: 'turn', mode: 'turn' });
    await mount();
    expect(ribbonSim()).toBe('simulateTurning');
    expect(siderCommands()).not.toContain('simulateTurning');
  });

  it('names itself for the lathe', async () => {
    await setStore({ page: 'turn', mode: 'turn' });
    await mount();
    expect(cmd('simulateTurning').getAttribute('aria-label')).toBe('Simulate turning');
  });
});

describe('the program figures float over the viewport', () => {
  // They are read against the simulation, so they sit on it. In the sidebar they
  // were behind the Setup drawer — which covers the viewport — so judging a run by
  // them meant opening a panel over the thing being judged.
  const panel = () => q('[data-cam-overlay="stats"]');
  const SRC = 'G0 X0 Y0 Z5\nG1 Z-2 F200\nG1 X60 Y40 F400';

  async function loadProgram(mode = 'mill') {
    const { segments, bounds, stats } = interpret(SRC, { mode });
    setBuffers({ path: buildPath(segments), bounds, stats });
    await setStore({ gcode: SRC, bufVer: 1, playing: false });
  }

  afterEach(() => clearBuffers());

  it('is on the viewport, not in the drawer', async () => {
    await mount();
    await loadProgram();
    expect(panel()).not.toBeNull();
    expect(sider().textContent).not.toContain('Cycle time');
  });

  it('carries all four figures', async () => {
    await mount();
    await loadProgram();
    const text = panel().textContent;
    for (const label of ['Cycle time', 'Cutting length', 'Rapid', 'Segments']) {
      // eslint-disable-next-line jest/valid-expect
      expect(text, label).toContain(label);
    }
  });

  it('shows the two lengths in mm', async () => {
    await mount();
    await loadProgram();
    expect(panel().textContent).toContain('Cutting length (mm)');
    expect(panel().textContent).toContain('Rapid (mm)');
  });

  it('posts real numbers, not placeholders', async () => {
    await mount();
    await loadProgram();
    // 60/40 diagonal + the 7 mm plunge — the figures come off the interpreter,
    // so an empty or dashed panel means the stats never reached the view.
    expect(panel().textContent).not.toContain('—');
    expect(panel().textContent).toMatch(/\d/);
  });

  it('survives playback, unlike the sidebar block it replaced', async () => {
    // The rail keeps working while the program runs, and cycle time is the figure
    // the elapsed clock on the bottom bar is measured against.
    await mount();
    await loadProgram();
    await setStore({ playing: true });
    expect(panel()).not.toBeNull();
  });

  it('is there on the lathe too', async () => {
    await setStore({ page: 'turn', mode: 'turn' });
    await mount();
    await loadProgram('turn');
    expect(panel()).not.toBeNull();
  });

  it('stays away until there is a program to describe', async () => {
    // An unparsed program has no stats; a rail of dashes over the viewport is
    // worse than no rail.
    await mount();
    expect(panel()).toBeNull();
  });
});

describe('the single-block controls', () => {
  // Three plainly separate blocks, so a step lands somewhere identifiable.
  const PROGRAM = ['G0 X0 Y0 Z5', 'G1 Z-1 F200', 'G1 X20 F400'].join('\n');

  /** A toolbar button, found by the icon it carries. */
  const iconBtn = (name) =>
    q(`[aria-label="${name}"]`)?.closest('button') ?? null;

  /** The distance-to-go cell of an axis row in the position readout. */
  const dtg = (label) =>
    q(`[data-dtg="${label}"]`)?.textContent ?? null;

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
      expect(
        q(`button[data-cutter="${id}"][data-cutter-scope="fallback"]`),
        // eslint-disable-next-line jest/valid-expect
        id,
      ).not.toBeNull();
    }
  });

  it('stays behind the + even when the program names no tool', async () => {
    // The first cut at this opened the form automatically whenever nothing was
    // detected — which is the common case, so the + was never actually seen and
    // the row looked as permanent as the one it replaced.
    await mount();
    await loadWithTools([]);
    expect(cmd('toolFallback')).not.toBeNull();
    expect(q('button[data-cutter="endmill"]')).toBeNull();
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
  const cutterBtn = (id) => q(`button[data-cutter="${id}"][data-cutter-scope="fallback"]`);

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

  it('asks for the thickness only of a slot cutter, and draws it', async () => {
    // The slot mill is the one type whose cutting body its diameter cannot
    // imply. Every other type follows `bodyRatio` and is not worth a field.
    const field = () => q('input[aria-label="Cutter thickness"]');
    await mount();
    await openPicker();
    expect(field()).toBeNull();
    await act(async () => { cutterBtn('slot').click(); });
    expect(field()).not.toBeNull();
    await act(async () => { useCamStore.getState().setThickness(4); });
    expect(marker().thickness).toBe('4');
    await act(async () => { cutterBtn('face').click(); });
    expect(field()).toBeNull();
  });

  it('asks for the shank diameter on the same one type, and draws it', async () => {
    // A necked slot mill is wide where it cuts and narrow where it is held —
    // two independent numbers, and the marker has to show both.
    const field = () => q('input[aria-label="Shank diameter"]');
    await mount();
    await openPicker();
    expect(field()).toBeNull();
    await act(async () => { cutterBtn('slot').click(); });
    expect(field()).not.toBeNull();
    await act(async () => { useCamStore.getState().setShank(8); });
    expect(marker().shank).toBe('8');
    await act(async () => { cutterBtn('endmill').click(); });
    expect(field()).toBeNull();
  });

  it('switches to the voxel sim for a cutter that leaves a roof, and says so', async () => {
    // A slot cutter with a stated cutting body leaves a groove with material
    // over it. The height field holds one top-Z per column, so it takes the
    // roof off and the result reads as "the slot cutter did not cut a slot".
    await mount();
    await openPicker();
    expect(cmd('simulate')).not.toBeNull();
    await act(async () => { cutterBtn('slot').click(); });
    await act(async () => { useCamStore.getState().setThickness(3); });
    expect(cmd('simulateUndercut')).not.toBeNull();
    expect(cmd('simulate')).toBeNull();
    expect(sider().textContent).toMatch(/leaves an undercut/i);
    expect(sider().textContent).toMatch(/3 mm/);
    // ...and the store routes the run the same way, off the same rule.
    expect(useCamStore.getState().simPlan().method).toBe('voxel');
  });

  it('keeps the scrub-able height field until a cutting body is stated', async () => {
    await mount();
    await openPicker();
    await act(async () => { cutterBtn('slot').click(); });
    expect(useCamStore.getState().simPlan().method).toBe('height');
    expect(sider().textContent).not.toMatch(/leaves an undercut/i);
  });

  it('drops a shank typed for one type when another is picked', async () => {
    // Ø8 is the shank of a necked slot mill; on the next tool it is a guess.
    await mount();
    await openPicker();
    await act(async () => { cutterBtn('slot').click(); });
    await act(async () => { useCamStore.getState().setShank(8); });
    await act(async () => { cutterBtn('ball').click(); });
    expect(useCamStore.getState().toolShank).toBeNull();
  });

  it('drops a thickness typed for one type when another is picked', async () => {
    // 4 mm is a slot cutter; on a Ø10 endmill it would be 4 mm of flute.
    await mount();
    await openPicker();
    await act(async () => { cutterBtn('slot').click(); });
    await act(async () => { useCamStore.getState().setThickness(4); });
    await act(async () => { cutterBtn('endmill').click(); });
    expect(useCamStore.getState().toolThickness).toBeNull();
  });

  it('keeps the stated thickness inside what the type is made in', async () => {
    await mount();
    await openPicker();
    await act(async () => { cutterBtn('slot').click(); });
    await act(async () => { useCamStore.getState().setThickness(9999); });
    expect(useCamStore.getState().toolThickness).toBe(200);
  });

  it('draws the fallback tool the picker just chose', async () => {
    // Nothing else on screen says what "face mill" did; the marker is the answer.
    await mount();
    await openPicker();
    await act(async () => { cutterBtn('face').click(); });
    expect(marker()).toMatchObject({ cutter: 'face', type: 'flat' });
  });
});

/**
 * The Tool table's own cutter type.
 *
 * The picker under the table only ever described the tool the program did NOT
 * name. Once a program named its tools — the normal case — the type stopped
 * reaching the marker entirely: a Ø50 face mill was drawn as a Ø50 endmill
 * stick, and every attempt to change it did nothing. The type now lives on the
 * row, and `cam/effectiveTool.js` decides which source wins.
 */
describe('the cutter type of a tool the program named', () => {
  // The picker, diameter, angle, thickness and shank fields moved off the
  // compact row into the per-tool Edit dialog (`ToolEditDialog`) — see
  // "the Tool table row is a glance, the dialog is where it's edited" below.
  // Every test that reads or clicks one of them opens that dialog first.
  const rowBtn = (n, id) => q(`button[data-cutter="${id}"][data-cutter-scope="T${n}"]`);
  const pressed = (b) => b.classList.contains('ant-btn-primary');

  async function openToolEdit(n) {
    await act(async () => { q(`button[aria-label="Edit T${n}"]`).click(); });
  }

  /** Load a program whose comments describe its tools, parked at the end. */
  async function loadProgramWithTools(src) {
    const { segments, bounds, stats } = interpret(src, { mode: 'mill' });
    const path = buildPath(segments);
    setBuffers({ path, bounds, stats });
    await setStore({ gcode: src, bufVer: 1, playing: false, playhead: path.count });
  }

  const FACE = 'T1(FACEMILL D50 - FACE)\nM6\nG0 X0 Y0 Z5\nG1 Z-2 F200\nG1 X60 F400';

  afterEach(() => {
    clearBuffers();
    useCamStore.setState({ toolOverrides: {}, toolEditDialog: null });
  });

  it('draws the tool the program described, not the fallback', async () => {
    await mount();
    await loadProgramWithTools(FACE);
    expect(marker()).toMatchObject({ cutter: 'face', radius: 25 });
  });

  it('shows that type as the pressed glyph in the edit dialog', async () => {
    await mount();
    await loadProgramWithTools(FACE);
    await openToolEdit(1);
    expect(pressed(rowBtn(1, 'face'))).toBe(true);
    expect(pressed(rowBtn(1, 'endmill'))).toBe(false);
  });

  it('re-types a tool from the dialog, and the marker follows', async () => {
    await mount();
    await loadProgramWithTools(FACE);
    await openToolEdit(1);
    await act(async () => { rowBtn(1, 'ball').click(); });
    expect(useCamStore.getState().toolOverrides[1]).toMatchObject({
      cutter: 'ball',
      simType: 'ball',      // kept in step for the carvers, never set by hand
    });
    expect(marker()).toMatchObject({ cutter: 'ball', type: 'ball', radius: 25 });
  });

  it('asks for the included angle only once a chamfer mill is picked', async () => {
    await mount();
    await loadProgramWithTools(FACE);
    await openToolEdit(1);
    await act(async () => { rowBtn(1, 'chamfer').click(); });
    expect(useCamStore.getState().toolOverrides[1].angle).toBe(90);
    expect(marker().type).toBe('cone');
  });

  it('reverts to the detected type when the row is reset', async () => {
    await mount();
    await loadProgramWithTools(FACE);
    await openToolEdit(1);
    await act(async () => { rowBtn(1, 'slot').click(); });
    expect(marker().cutter).toBe('slot');
    // The reset button stays on the compact row itself, not in the dialog.
    await act(async () => { cmd('resetTool').click(); });
    expect(marker().cutter).toBe('face');
  });

  it('takes a thickness per tool, and the marker takes that shape', async () => {
    // The Ø50 the program named, cut to the 4 mm slot cutter actually on the
    // shelf: same tool number, same diameter, a different tool.
    const field = () => q('input[aria-label="T1 cutter thickness"]');
    await mount();
    await loadProgramWithTools(FACE);
    await openToolEdit(1);
    expect(field()).toBeNull();                       // a face mill is not asked
    await act(async () => { rowBtn(1, 'slot').click(); });
    expect(field()).not.toBeNull();
    // Empty until it is measured — the implied value is only a placeholder, so
    // "nothing is set here" is visible rather than looking already in force.
    expect(field().value).toBe('');
    expect(field().placeholder).toBe('150');          // Ø50 x bodyRatio 3
    await act(async () => { useCamStore.getState().setToolThickness(1, 12, 'slot'); });
    expect(marker()).toMatchObject({ cutter: 'slot', radius: 25, thickness: '12' });
  });

  it('takes a shank diameter per tool, independent of what it cuts', async () => {
    const field = () => q('input[aria-label="T1 shank diameter"]');
    await mount();
    await loadProgramWithTools(FACE);
    await openToolEdit(1);
    expect(field()).toBeNull();                       // a face mill is not asked
    await act(async () => { rowBtn(1, 'slot').click(); });
    expect(field()).not.toBeNull();
    expect(field().value).toBe('');
    expect(Number(field().placeholder)).toBeCloseTo(49, 6);   // just under Ø50
    await act(async () => { useCamStore.getState().setToolShank(1, 16, 'slot'); });
    expect(marker()).toMatchObject({ cutter: 'slot', radius: 25, shank: '16' });
  });

  it('gives a drill its point — a blind hole does not have a square floor', async () => {
    // This used to assert the opposite: no shape here was a drill, so one
    // carved as a flat-bottomed disc. `drill` is now a cutter of its own, at
    // the 118° every general-purpose drill is ground to.
    await mount();
    await loadProgramWithTools('T2(DRILL 9)\nM6\nG0 X0 Y0 Z5\nG1 Z-2 F200\nG1 X60 F400');
    expect(marker()).toMatchObject({ cutter: 'drill', type: 'cone', radius: 4.5 });
    await openToolEdit(2);
    expect(pressed(rowBtn(2, 'drill'))).toBe(true);
    expect(pressed(rowBtn(2, 'endmill'))).toBe(false);
  });

  it('still leaves a tap on the plain stick — a tap cuts no bore of its own', async () => {
    await mount();
    await loadProgramWithTools('T4(TAP D8)\nM6\nG0 X0 Y0 Z5\nG1 Z-2 F200\nG1 X60 F400');
    expect(marker()).toMatchObject({ cutter: '', type: 'flat', radius: 4 });
  });
});

/**
 * The Tool table row itself: a glance (T number, editable name, a one-line
 * spec, cut length, reset) — everything that USED to live there now lives
 * behind the Edit button, in `ToolEditDialog`.
 */
describe("the Tool table row is a glance, the dialog is where it's edited", () => {
  async function loadProgramWithTools(src) {
    const { segments, bounds, stats } = interpret(src, { mode: 'mill' });
    const path = buildPath(segments);
    setBuffers({ path, bounds, stats });
    await setStore({ gcode: src, bufVer: 1, playing: false, playhead: path.count });
  }

  const FACE = 'T1(FACEMILL D50 - FACE)\nM6\nG0 X0 Y0 Z5\nG1 Z-2 F200\nG1 X60 F400';

  afterEach(() => {
    clearBuffers();
    useCamStore.setState({ toolOverrides: {}, toolEditDialog: null });
  });

  it('offers no cutter picker, diameter or Edit dialog on the row itself', async () => {
    await mount();
    await loadProgramWithTools(FACE);
    expect(q('button[data-cutter="face"][data-cutter-scope="T1"]')).toBeNull();
    expect(q('input[aria-label="T1 diameter"]')).toBeNull();
    expect(q('.ant-modal-content')).toBeNull();
  });

  it('names the tool with its own override — blank, not the detected type, until one is set', async () => {
    await mount();
    await loadProgramWithTools(FACE);
    const name = () => q('input[aria-label="T1 name"]');
    expect(name().value).toBe('');
    // Not `facemill` as a ghost value — that would read as an already-chosen
    // name this row never had. The detected type is still on the row's own
    // tooltip and in the Edit dialog's title.
    expect(name().placeholder).toBe('Name');
    await act(async () => { useCamStore.getState().setToolOverride(1, { label: 'Roughing face mill' }); });
    expect(name().value).toBe('Roughing face mill');
  });

  it('opens the one shared editor for the row that was clicked', async () => {
    await mount();
    await loadProgramWithTools('T1(FACEMILL D50)\nT2(DRILL 9)\nM6\nG0 X0 Y0 Z5\nG1 Z-2 F200\nG1 X60 F400');
    await act(async () => { q('button[aria-label="Edit T1"]').click(); });
    expect(q('.ant-modal-title').textContent).toContain('T1');
    await act(async () => { q('button[aria-label="Edit T2"]').click(); });
    expect(q('.ant-modal-title').textContent).toContain('T2');
    // Still exactly one dialog mounted — opening a different row's editor
    // replaced it rather than stacking a second one.
    expect(document.querySelectorAll('.ant-modal-content').length).toBe(1);
  });

  it('closes from Done, leaving the override it made in place', async () => {
    await mount();
    await loadProgramWithTools(FACE);
    await act(async () => { q('button[aria-label="Edit T1"]').click(); });
    await act(async () => { q('button[data-cutter="ball"][data-cutter-scope="T1"]').click(); });
    await act(async () => {
      [...document.querySelectorAll('.ant-modal-footer button')]
        .find((b) => b.textContent.trim() === 'Done').click();
    });
    expect(q('.ant-modal-content')).toBeNull();
    expect(useCamStore.getState().toolOverrides[1].cutter).toBe('ball');
  });
});

/**
 * A turning tool's diameter — the ⌀ field the Tool table was missing. A
 * drill, reamer or tap runs down the centreline at X~0, so the program's own
 * path states no diameter at all; this field is the only thing that can,
 * and it is the same number the sim now bores with (`turningCutRadiusResolver`).
 */
describe('the diameter of a turning tool', () => {
  async function loadTurnProgramWithTools(src) {
    const { segments, bounds, stats } = interpret(src, { mode: 'turn' });
    const path = buildPath(segments);
    setBuffers({ path, bounds, stats });
    await setStore({
      page: 'turn', mode: 'turn', gcode: src, bufVer: 1, playing: false, playhead: path.count,
    });
  }

  async function openToolEdit(n) {
    await act(async () => { q(`button[aria-label="Edit T${n}"]`).click(); });
  }

  const DRILL = 'T0202(DRILL DIA 8.5 MM)\nG97 S600 M3\nG0 X0 Z2\nG1 Z-20 F0.1\nG0 Z2\nM30';

  afterEach(() => {
    clearBuffers();
    useCamStore.setState({ toolOverrides: {}, toolEditDialog: null });
  });

  it('shows the diameter the program\'s own comment named', async () => {
    await mount();
    await loadTurnProgramWithTools(DRILL);
    await openToolEdit(202);
    expect(q('input[aria-label="T202 diameter"]').value).toBe('8.5');
  });

  it('resizes the marker when the operator overrides it', async () => {
    await mount();
    await loadTurnProgramWithTools(DRILL);
    await openToolEdit(202);
    await act(async () => { useCamStore.getState().setToolOverride(202, { diameter: 12 }); });
    expect(marker().radius).toBeCloseTo(6, 6);
    expect(q('input[aria-label="T202 diameter"]').value).toBe('12.0');
  });

  it('states a diameter for a tool whose comment gave none at all', async () => {
    await mount();
    await loadTurnProgramWithTools('T0303(UNDERCUT)\nG97 S600 M3\nG0 X10 Z2\nG1 Z-5 F0.1\nM30');
    await openToolEdit(303);
    expect(q('input[aria-label="T303 diameter"]').value).toBe('');
    await act(async () => { useCamStore.getState().setToolOverride(303, { diameter: 4 }); });
    expect(marker().radius).toBeCloseTo(2, 6);
  });

  it('offers a groove-width field only for a parting tool, not an OD or drill one', async () => {
    await mount();
    await loadTurnProgramWithTools(DRILL);
    await openToolEdit(202);
    expect(q('input[aria-label="T202 groove width"]')).toBeNull();
    await loadTurnProgramWithTools('T0505(PARTING OFF)\nG97 S600 M3\nG0 X22 Z-10\nG1 X0 F0.06\nM30');
    await openToolEdit(505);
    expect(q('input[aria-label="T505 groove width"]')).not.toBeNull();
  });
});

describe('the library and Setup share one drawer, titled for whichever is open', () => {
  // Open program / Load sample / Library / Export G-code used to double as
  // their own icon row at the top of the Setup drawer; now that the File menu
  // carries the same four actions, that row is gone and these are reached
  // from there instead — `MenuBar.test.jsx` covers the menu itself. Library
  // also used to show its content *inside* the "Setup"-titled drawer, which
  // made it look like a sub-mode of Setup rather than the separate thing it
  // is — the title now switches to say plainly which one is open, and
  // Setup's own content is hidden while Library's is showing.
  //
  // They were briefly two separate Drawer components before this. That broke
  // in a way worth remembering: antd's default mask sits at z-index 1000 over
  // the whole page, including whichever button was about to open the *other*
  // drawer — so switching from one to the other via a toolbar button landed
  // the click on the mask instead, which just closed what was open. One
  // Drawer with `mask={false}` sidesteps it; see the comment on the Drawer
  // itself in App.jsx.
  async function openFileMenu() {
    const title = [...document.querySelectorAll('.ant-menu-submenu-title')]
      .find((el) => el.textContent.trim().startsWith('File'));
    await act(async () => { title.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await new Promise((r) => { setTimeout(r, 30); }); });
  }
  const fileMenuItem = (label) => [...document.querySelectorAll('li.ant-menu-item')]
    .find((el) => el.textContent.includes(label));
  const drawerTitle = () => q('.ant-drawer-title')?.textContent ?? null;

  it('is no longer its own row in the drawer — File carries it instead', async () => {
    await mount();
    const ids = siderCommands();
    expect(ids).not.toContain('openProgram');
    expect(ids).not.toContain('openLibrary');
    expect(ids).not.toContain('exportGcode');
    await openFileMenu();
    expect(fileMenuItem('Open program')).toBeTruthy();
    expect(fileMenuItem('Library')).toBeTruthy();
    expect(fileMenuItem('Export G-code')).toBeTruthy();
  });

  it('stays shut until the library item is chosen', async () => {
    await mount({ setup: false });
    expect(q('[data-testid="library-panel"]')).toBeNull();
  });

  it('opens titled "Library", and stays open', async () => {
    await mount({ setup: false });
    await openFileMenu();
    await act(async () => { fileMenuItem('Library').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(drawerTitle()).toBe('Library');
    const panel = sider()?.querySelector('[data-testid="library-panel"]');
    expect(panel).not.toBeNull();
    // A real drawer, not a floating layer that shuts on an outside click.
    expect(document.body.contains(panel)).toBe(true);
    // Choosing it again closes it.
    await openFileMenu();
    await act(async () => { fileMenuItem('Library').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(q('[data-testid="library-panel"]')).toBeNull();
  });

  it('opens on its own, without Setup ever having been opened', async () => {
    await mount({ setup: false });
    await openFileMenu();
    await act(async () => { fileMenuItem('Library').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(drawerTitle()).toBe('Library');
    expect(sider()?.textContent).not.toContain('CAM from a model');
  });

  it('and the Setup button switch the same drawer back and forth', async () => {
    await mount({ setup: false });
    await openFileMenu();
    await act(async () => { fileMenuItem('Library').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(drawerTitle()).toBe('Library');
    expect(q('[data-testid="library-panel"]')).not.toBeNull();

    // The toolbar's Setup button, clicked while Library is showing — this is
    // the exact click that landed on the mask before `mask={false}`.
    await openSetup();
    expect(drawerTitle()).toBe('Setup');
    expect(sider()?.textContent).toContain('CAM from a model');
    expect(q('[data-testid="library-panel"]')).toBeNull();

    await openFileMenu();
    await act(async () => { fileMenuItem('Library').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(drawerTitle()).toBe('Library');
    expect(q('[data-testid="library-panel"]')).not.toBeNull();
  });
});

describe('simulating on its own, once the setup says what to simulate', () => {
  /** Watch `simulate` without a worker to run it in. */
  function spySimulate() {
    const spy = vi.fn(async () => {});
    useCamStore.setState({ simulate: spy });
    return spy;
  }

  beforeEach(() => {
    useCamPlanStore.setState({
      datum: { planeNormal: null, point: null, rotaryCenter: null, rotaryZero: null, reverseX: false, axesSet: [false, false, false] },
    });
    useCamStore.setState({
      // The whole suite is about when it DOES run; the toggle that gates it is
      // off by default and has its own test below.
      autoSimEnabled: true,
      stockEnabled: false, stockSize: { x: null, y: null, z: null },
      stockOrigin: { x: null, y: null, z: null }, simStatus: 'idle',
    });
  });

  it('does not run with a program alone — there is no billet and no datum', async () => {
    const spy = spySimulate();
    await mount();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does nothing at all while the Auto-simulate toggle is off', async () => {
    const spy = spySimulate();
    useCamStore.setState({ autoSimEnabled: false });
    await mount();
    // A complete setup that would otherwise carve immediately.
    await setStore({ stockEnabled: true, stockSize: { x: 100, y: 60, z: 20 } });
    await act(async () => {
      useCamPlanStore.setState({
        datum: { planeNormal: null, point: [0, 0, 0], rotaryCenter: null, rotaryZero: null, reverseX: false, axesSet: [true, true, true] },
      });
    });
    expect(spy).not.toHaveBeenCalled();
    // Flipping it on picks up the setup already in place.
    await setStore({ autoSimEnabled: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not run on a stated billet with no origin', async () => {
    const spy = spySimulate();
    await mount();
    await setStore({ stockEnabled: true, stockSize: { x: 100, y: 60, z: 20 } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('runs the moment both are stated', async () => {
    const spy = spySimulate();
    await mount();
    await setStore({ stockEnabled: true, stockSize: { x: 100, y: 60, z: 20 } });
    await act(async () => {
      useCamPlanStore.setState({
        datum: { planeNormal: null, point: [0, 0, 0], rotaryCenter: null, rotaryZero: null, reverseX: false, axesSet: [true, true, true] },
      });
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('holds off until milling has all three axes touched off', async () => {
    const spy = spySimulate();
    await mount();
    await setStore({ stockEnabled: true, stockSize: { x: 100, y: 60, z: 20 } });
    // X and Y only — Z is still on the model's native zero, so the carve would
    // be against a half-set datum.
    await act(async () => {
      useCamPlanStore.setState({
        datum: { planeNormal: null, point: [0, 0, 0], rotaryCenter: null, rotaryZero: null, reverseX: false, axesSet: [true, true, false] },
      });
    });
    expect(spy).not.toHaveBeenCalled();
    // The last axis lands.
    await act(async () => {
      useCamPlanStore.setState({
        datum: { planeNormal: null, point: [0, 0, 0], rotaryCenter: null, rotaryZero: null, reverseX: false, axesSet: [true, true, true] },
      });
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('runs once per setup, not once per render', async () => {
    const spy = spySimulate();
    await mount();
    await setStore({ stockEnabled: true, stockSize: { x: 100, y: 60, z: 20 } });
    await act(async () => {
      useCamPlanStore.setState({
        datum: { planeNormal: null, point: [0, 0, 0], rotaryCenter: null, rotaryZero: null, reverseX: false, axesSet: [true, true, true] },
      });
    });
    // Something unrelated changes and the component re-renders.
    await setStore({ showArbor: false });
    await setStore({ showArbor: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('runs again when the billet is resized — the answer on screen went stale', async () => {
    const spy = spySimulate();
    await mount();
    await setStore({ stockEnabled: true, stockSize: { x: 100, y: 60, z: 20 } });
    await act(async () => {
      useCamPlanStore.setState({
        datum: { planeNormal: null, point: [0, 0, 0], rotaryCenter: null, rotaryZero: null, reverseX: false, axesSet: [true, true, true] },
      });
    });
    await setStore({ stockSize: { x: 120, y: 60, z: 20 } });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('holds off while a program is playing', async () => {
    const spy = spySimulate();
    await mount();
    await setStore({ playing: true });
    await setStore({ stockEnabled: true, stockSize: { x: 100, y: 60, z: 20 } });
    await act(async () => {
      useCamPlanStore.setState({
        datum: { planeNormal: null, point: [0, 0, 0], rotaryCenter: null, rotaryZero: null, reverseX: false, axesSet: [true, true, true] },
      });
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
