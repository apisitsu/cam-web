/**
 * @vitest-environment jsdom
 *
 * Render gates for the library panel. The record shape is
 * `engine/savedWork.test.js` and the sequencing is `stores/libraryStore.test.js`;
 * what needs the DOM is whether the rows an operator has to click are actually
 * on screen — a saved item with no Open button is a saved item that is gone.
 *
 * The panel's contents live in a popover, which antd renders into a portal, so
 * assertions run against `document.body` rather than the container.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../lib/workDb.js', () => ({
  dbAvailable: () => true,
  putRecord: async ({ meta }) => meta,
  listMeta: async () => [],
  getData: async () => undefined,
  deleteRecord: async (k) => k,
  clearAll: async () => {},
  storageUse: async () => null,
}));

const { default: LibraryPanel } = await import('./LibraryPanel.jsx');
const { useLibraryStore } = await import('../stores/libraryStore.js');

let container;
let root;

const ITEMS = [
  {
    key: 'project/OR35128 OP10',
    kind: 'project',
    name: 'OR35128 OP10',
    savedAt: '2026-08-05T09:00:00.000Z',
    bytes: 41200,
    note: '412 blocks · 3 ops · a part',
  },
  {
    key: 'program/Facing test',
    kind: 'program',
    name: 'Facing test',
    savedAt: '2026-08-01T09:00:00.000Z',
    bytes: 812,
    note: '18 blocks',
  },
];

/** Open the panel and hand back the portal-rendered body. */
async function openPanel(props = {}) {
  await act(async () => {
    root.render(React.createElement(LibraryPanel, {
      trigger: React.createElement('button', { 'data-cmd': 'openLibrary' }, 'Library'),
      ...props,
    }));
  });
  await act(async () => {
    container.querySelector('[data-cmd="openLibrary"]').click();
  });
  return document.body;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useLibraryStore.setState({
    items: ITEMS, loaded: true, busy: false, error: null, available: true,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('LibraryPanel — what is on screen', () => {
  it('stays shut until the trigger is pressed', async () => {
    await act(async () => {
      root.render(React.createElement(LibraryPanel, {
        trigger: React.createElement('button', { 'data-cmd': 'openLibrary' }, 'Library'),
      }));
    });
    expect(document.querySelector('[data-testid="library-panel"]')).toBeNull();
  });

  it('lists every saved item once opened', async () => {
    const body = await openPanel();
    expect(body.querySelector('[data-testid="library-panel"]')).not.toBeNull();
    expect(body.querySelectorAll('[data-library-item]')).toHaveLength(2);
  });

  it('gives every row a way to open it and a way to delete it', async () => {
    const body = await openPanel();
    for (const item of ITEMS) {
      expect(body.querySelector(`[data-library-open="${item.key}"]`)).not.toBeNull();
      expect(body.querySelector(`[data-library-delete="${item.key}"]`)).not.toBeNull();
    }
  });

  it('says what each item is, so two saves of one job can be told apart', async () => {
    const body = await openPanel();
    const row = body.querySelector('[data-library-item="project/OR35128 OP10"]');
    expect(row.textContent).toContain('OR35128 OP10');
    expect(row.textContent).toContain('412 blocks · 3 ops · a part');
    expect(row.textContent).toContain('41.2 kB');
  });

  it('offers both things worth saving, under one name', async () => {
    const body = await openPanel();
    expect(body.querySelector('[data-library-save="project"]')).not.toBeNull();
    expect(body.querySelector('[data-library-save="program"]')).not.toBeNull();
    expect(body.querySelector('[data-library-name]')).not.toBeNull();
  });

  it('offers a name to save under without one being typed', async () => {
    const body = await openPanel();
    expect(body.querySelector('[data-library-name]').value.length).toBeGreaterThan(0);
  });

  it('says so when the library is empty rather than showing a blank panel', async () => {
    useLibraryStore.setState({ items: [], loaded: true });
    const body = await openPanel();
    expect(body.textContent).toContain('Nothing saved yet');
  });

  it('puts the store\'s error where the button that caused it is', async () => {
    useLibraryStore.setState({ error: 'The disk is full.' });
    const body = await openPanel();
    expect(body.textContent).toContain('The disk is full.');
  });

  it('says the browser has no library, instead of buttons that cannot work', async () => {
    useLibraryStore.setState({ available: false });
    const body = await openPanel();
    expect(body.textContent).toContain('No library in this browser');
    expect(body.querySelector('[data-library-save="project"]')).toBeNull();
  });
});

describe('LibraryPanel — saving', () => {
  it('saves under the name in the box, and reports it back', async () => {
    const saveProject = vi.fn(async () => ({ name: 'OP10 setup' }));
    useLibraryStore.setState({ saveProject });
    const onDone = vi.fn();
    const body = await openPanel({ onDone });

    await act(async () => {
      body.querySelector('[data-library-save="project"]').click();
    });
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(expect.stringContaining('OP10 setup'));
  });

  it('does not report a save that failed', async () => {
    useLibraryStore.setState({
      saveProgram: vi.fn(async () => { throw new Error('no'); }),
    });
    const onDone = vi.fn();
    const body = await openPanel({ onDone });
    await act(async () => {
      body.querySelector('[data-library-save="program"]').click();
    });
    expect(onDone).not.toHaveBeenCalled();
  });
});
