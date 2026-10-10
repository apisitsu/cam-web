/**
 * @vitest-environment jsdom
 *
 * The sketch confirmation corner: one checkmark, one job — leave the sketch
 * for whichever machine mode (mill/turn) was active before it was opened.
 */
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import SketchConfirmCorner from './SketchConfirmCorner.jsx';
import { useCamStore } from '../stores/camStore.js';

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
  useCamStore.setState({ page: 'sketch' });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('SketchConfirmCorner', () => {
  it('renders the exit button', async () => {
    useCamStore.setState({ mode: 'mill' });
    await render();
    expect(container.querySelector('[data-exit-sketch]')).not.toBeNull();
  });

  it('clicking it returns to the milling page when that was the last machine mode', async () => {
    useCamStore.setState({ mode: 'mill' });
    await render();
    await click(container.querySelector('[data-exit-sketch]'));
    expect(useCamStore.getState().page).toBe('mill');
  });

  it('returns to turning instead when that was the machine mode', async () => {
    useCamStore.setState({ mode: 'turn' });
    await render();
    await click(container.querySelector('[data-exit-sketch]'));
    expect(useCamStore.getState().page).toBe('turn');
  });
});
