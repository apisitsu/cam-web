/**
 * @vitest-environment jsdom
 *
 * The sketch confirmation corner: one checkmark, one job — close the sketch and
 * stay on the Sketch page, whichever machine mode was last active.
 */
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import SketchConfirmCorner from './SketchConfirmCorner.jsx';
import { useCamStore } from '../stores/camStore.js';
import { useSketchStore } from '../stores/sketchStore.js';

let container;
let root;

async function render() {
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => { root.render(React.createElement(SketchConfirmCorner)); });
}

const click = async (el) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useCamStore.setState({ page: 'sketch', mode: 'mill' });
  useSketchStore.setState({ sketchOpen: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('SketchConfirmCorner', () => {
  it('renders the exit button while a sketch is open', async () => {
    await render();
    expect(container.querySelector('[data-exit-sketch]')).not.toBeNull();
  });

  it('is not there with no sketch open', async () => {
    useSketchStore.setState({ sketchOpen: false });
    await render();
    expect(container.querySelector('[data-exit-sketch]')).toBeNull();
  });

  it.each(['mill', 'turn'])('closes the sketch and stays on the Sketch page (last mode %s)', async (mode) => {
    useCamStore.setState({ mode });
    await render();
    await click(container.querySelector('[data-exit-sketch]'));
    expect(useCamStore.getState().page).toBe('sketch');
    expect(useSketchStore.getState().sketchOpen).toBe(false);
  });
});
