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
