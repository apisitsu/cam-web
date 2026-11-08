/**
 * @vitest-environment jsdom
 */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceTabs from './WorkspaceTabs.jsx';

let container;
let root;

const render = (props) => act(async () => {
  root.render(React.createElement(WorkspaceTabs, { onSelect: () => {}, active: 'model', ...props }));
});
const tab = (value) => container.querySelector(`[data-workspace-tab="${value}"]`);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('WorkspaceTabs', () => {
  it('names all four, and marks the active one', async () => {
    await render({ active: 'program' });
    expect(['model', 'program', 'simulation', 'library'].every((t) => tab(t))).toBe(true);
    expect(tab('program').getAttribute('aria-selected')).toBe('true');
    expect(tab('model').getAttribute('aria-selected')).toBe('false');
  });

  it('reports the tab clicked', async () => {
    const onSelect = vi.fn();
    await render({ onSelect });
    await act(async () => { tab('library').click(); });
    expect(onSelect).toHaveBeenCalledWith('library');
  });

  it('lines up under the viewport', async () => {
    await render({ indent: 300 });
    expect(container.querySelector('[data-workspace-tabs]').style.paddingLeft).toBe('306px');
  });
});
