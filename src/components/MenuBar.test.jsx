/**
 * @vitest-environment jsdom
 *
 * The File/Edit/View/Window/Help bar. Each top-level label is the normal,
 * always-in-the-page part of an antd horizontal `Menu`; what each one opens
 * is a submenu popup, which antd portals onto `document.body` on a click and
 * only finishes mounting after a tick — `openMenu` below waits one before
 * the tests go looking for its items.
 */
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MenuBar from './MenuBar.jsx';
import { useCamStore } from '../stores/camStore.js';
import { useSketchStore } from '../stores/sketchStore.js';

let container;
let root;

const noop = () => {};

async function render(props = {}) {
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => {
    root.render(React.createElement(MenuBar, {
      onExportGcode: noop, libraryOpen: false, onToggleLibrary: noop, onOpenSetup: noop, ...props,
    }));
  });
}

const settle = () => act(async () => { await new Promise((r) => { setTimeout(r, 30); }); });

/** The top-level label in the bar itself (not a popup item). */
function topLevel(label) {
  return [...container.querySelectorAll('.ant-menu-submenu-title, .ant-menu-item')]
    .find((el) => el.textContent.trim().startsWith(label));
}

/** Click a top-level label and wait for its popup to finish mounting. */
async function openMenu(label) {
  await act(async () => {
    topLevel(label).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** An item inside whichever submenu is currently open — portaled to body. */
function openItem(label) {
  return [...document.body.querySelectorAll('li.ant-menu-item')]
    .find((el) => el.textContent.includes(label));
}

const click = async (el) => {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await settle();
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  // A submenu popup portals onto document.body and outlives the component
  // once it's open; nothing else in the suite re-queries stale ones, but
  // clear them so the next test's `document.body.querySelectorAll` starts clean.
  document.querySelectorAll('.ant-menu-submenu-popup, [id$="-popup"]').forEach((el) => el.remove());
  useCamStore.setState({ page: 'sketch', mode: 'mill', gcode: '' });
  useSketchStore.setState({ selection: [] });
});

describe('MenuBar', () => {
  it('shows the five top-level menus', async () => {
    await render();
    for (const label of ['File', 'Edit', 'View', 'Window', 'Help']) {
      expect(topLevel(label)).toBeTruthy();
    }
  });

  it('renders a hidden file input for "Open program…" wired to the accepted extensions', async () => {
    await render();
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input.accept).toContain('.nc');
    expect(input.accept).toContain('.gcode');
  });

  it('File opens with Open program / Library / Export G-code, and no sample', async () => {
    await render();
    await openMenu('File');
    expect(openItem('Open program')).toBeTruthy();
    expect(openItem('Load sample')).toBeFalsy();
    expect(openItem('Library')).toBeTruthy();
    expect(openItem('Export G-code')).toBeTruthy();
  });

  it('Export G-code is disabled with no program loaded, enabled once there is one', async () => {
    useCamStore.setState({ gcode: '' });
    await render();
    await openMenu('File');
    expect(openItem('Export G-code').className).toMatch(/disabled/);

    useCamStore.setState({ gcode: 'G0 X0' });
    await render();
    await openMenu('File');
    expect(openItem('Export G-code').className).not.toMatch(/disabled/);
  });

  it('clicking Library calls onToggleLibrary', async () => {
    let called = 0;
    await render({ onToggleLibrary: () => { called += 1; } });
    await openMenu('File');
    await click(openItem('Library'));
    expect(called).toBe(1);
  });

  it('clicking Export G-code calls onExportGcode when a program is loaded', async () => {
    useCamStore.setState({ gcode: 'G0 X0' });
    let called = 0;
    await render({ onExportGcode: () => { called += 1; } });
    await openMenu('File');
    await click(openItem('Export G-code'));
    expect(called).toBe(1);
  });

  // Edit/View/Window's own items aren't re-tested here the same way: opening
  // a *second* horizontal submenu in jsdom (no real pointer/hover sequence to
  // drive rc-menu's overflow logic) wasn't reliable enough to assert on —
  // the File-menu interaction above already proves clicking a real popup item
  // reaches the store. Edit/View/Window's wiring (undo/redo/delete,
  // setViewPreset, treeOpen) is each covered directly at the store/component
  // level elsewhere (sketchStore.test.js, featureStore.test.js); this file's
  // job is the bar itself, not re-proving those.
});
