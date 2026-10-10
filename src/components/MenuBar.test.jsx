/**
 * @vitest-environment jsdom
 *
 * The File/Edit/View/Window/Help bar. Only the bar itself is asserted here —
 * each top-level label is the normal, always-in-the-page part of an antd
 * horizontal `Menu`. What a label opens is a submenu popup, which antd
 * portals outside the render tree and times its own visibility; that
 * plumbing isn't this component's logic to re-verify, and was checked by
 * hand in a real browser (File/Edit/View/Window/Help all open, Export
 * G-code greys out with no program loaded, Undo/Redo/Delete grey out
 * outside the Sketch page, and a View preset click reaches `setViewPreset`).
 */
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import MenuBar from './MenuBar.jsx';

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MenuBar', () => {
  it('shows the five top-level menus', async () => {
    await render();
    const labels = [...container.querySelectorAll('.ant-menu-submenu-title, .ant-menu-item')]
      .map((el) => el.textContent.trim());
    for (const label of ['File', 'Edit', 'View', 'Window', 'Help']) {
      expect(labels).toContain(label);
    }
  });

  it('renders a hidden file input for "Open program…" wired to the accepted extensions', async () => {
    await render();
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input.accept).toContain('.nc');
    expect(input.accept).toContain('.gcode');
  });
});
