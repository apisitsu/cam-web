/**
 * @vitest-environment jsdom
 *
 * The viewport's right-click menu: renders nothing until `sketchStore`
 * opens it, offers Delete/Toggle construction against the live selection
 * (not a snapshot taken when it opened), and closes itself after acting.
 */
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import SketchContextMenu from './SketchContextMenu.jsx';
import { useSketchStore } from '../stores/sketchStore.js';
import { createSketch, addPoint, addLine } from '../engine/sketch/model.js';

let container;
let root;

async function render() {
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => { root.render(React.createElement(SketchContextMenu)); });
}

const click = async (el) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

function lineSketch() {
  const sk = createSketch();
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  const line = addLine(sk, a, b);
  return { sk, line };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSketchStore.setState({ contextMenu: null, selection: [] });
});

describe('SketchContextMenu', () => {
  it('renders nothing while closed', async () => {
    useSketchStore.setState({ contextMenu: null });
    await render();
    expect(container.querySelector('[data-sketch-context-menu]')).toBeNull();
  });

  it('opens at the stored position once the store opens it', async () => {
    const { sk, line } = lineSketch();
    useSketchStore.setState({ sk, selection: [line], contextMenu: { x: 40, y: 60 } });
    await render();
    const menu = container.querySelector('[data-sketch-context-menu]');
    expect(menu).not.toBeNull();
    expect(menu.style.left).toBe('40px');
    expect(menu.style.top).toBe('60px');
  });

  it('Delete acts on the selection and closes the menu', async () => {
    const { sk, line } = lineSketch();
    useSketchStore.setState({ sk, selection: [line], contextMenu: { x: 0, y: 0 }, past: [] });
    await render();
    const deleteItem = [...container.querySelectorAll('li.ant-menu-item')]
      .find((el) => el.textContent.includes('Delete'));
    await click(deleteItem);
    expect(sk.entities.has(line)).toBe(false);
    expect(useSketchStore.getState().contextMenu).toBeNull();
  });

  it('closes on an outside click without acting on anything', async () => {
    const { sk, line } = lineSketch();
    useSketchStore.setState({ sk, selection: [line], contextMenu: { x: 0, y: 0 } });
    await render();
    const catcher = container.querySelector('[data-sketch-context-menu]').previousElementSibling;
    await act(async () => {
      catcher.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(useSketchStore.getState().contextMenu).toBeNull();
    expect(sk.entities.has(line)).toBe(true); // nothing was deleted
  });
});
