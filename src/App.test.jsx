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
const { setBuffers, clearBuffers } = await import('./engine/bufferCache.js');

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

/** Every button label currently in the sidebar. */
function siderButtons() {
  const el = sider();
  if (!el) return [];
  return [...el.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);
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
});

describe('the sidebar while setting up', () => {
  it('offers the file, project and setup controls', async () => {
    await mount();
    const labels = siderButtons().join(' | ');
    expect(labels).toContain('Parse');
    expect(labels).toContain('Save project');
    expect(labels).toMatch(/Simulate/);
  });

  it('shows the program listing', async () => {
    await mount();
    expect(sider().textContent).toContain('Program');
  });
});

describe('pressing Play collapses the sidebar to the program', () => {
  it('drops the file and project buttons', async () => {
    await mount();
    expect(siderButtons().join(' | ')).toContain('Parse');
    await setStore({ playing: true });
    const labels = siderButtons().join(' | ');
    expect(labels).not.toContain('Parse');
    expect(labels).not.toContain('Save project');
    expect(labels).not.toContain('Open file');
  });

  it('drops the material-removal controls', async () => {
    await mount();
    await setStore({ playing: true });
    expect(sider().textContent).not.toContain('Material removal');
    expect(siderButtons().join(' | ')).not.toMatch(/Simulate/);
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
    expect(siderButtons().join(' | ')).not.toContain('Parse');
    await setStore({ playing: false });
    expect(siderButtons().join(' | ')).toContain('Parse');
    expect(sider().textContent).toContain('Material removal');
  });
});

describe('the Arbor switch', () => {
  /** The switch whose label sits next to it in the viewport toolbar. */
  function arborSwitch() {
    const label = [...container.querySelectorAll('span')]
      .find((s) => s.textContent === 'Arbor' && s.children.length === 0);
    if (!label) return null;
    // antd renders the Switch as a button just before the label, inside a Space.
    return label.closest('.ant-space')?.querySelector('button.ant-switch') ?? null;
  }

  it('is offered on the milling page', async () => {
    await mount();
    expect(arborSwitch()).not.toBeNull();
  });

  it('starts on, with the arbor shown', async () => {
    await mount();
    expect(useCamStore.getState().showArbor).toBe(true);
    expect(arborSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('hides the arbor when clicked, and brings it back', async () => {
    await mount();
    await act(async () => { arborSwitch().click(); });
    expect(useCamStore.getState().showArbor).toBe(false);
    expect(arborSwitch().getAttribute('aria-checked')).toBe('false');

    await act(async () => { arborSwitch().click(); });
    expect(useCamStore.getState().showArbor).toBe(true);
  });

  it('stays available while the program runs', async () => {
    // The collapse is the sidebar's business; the viewport toolbar keeps working.
    await mount();
    await setStore({ playing: true });
    expect(arborSwitch()).not.toBeNull();
  });

  it('is withheld on the lathe, where it would do nothing', async () => {
    await setStore({ page: 'turn', mode: 'turn' });
    await mount();
    expect(arborSwitch()).toBeNull();
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
