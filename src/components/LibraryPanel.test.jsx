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

// `lib/workApi.js` — the module the store actually imports. This used to mock
// `lib/workDb.js`, which the store stopped importing when the library moved onto
// the server, so the mock had quietly stopped standing in for anything.
vi.mock('../lib/workApi.js', () => ({
  putRecord: async ({ meta }) => meta,
  listMeta: async () => [],
  getData: async () => undefined,
  deleteRecord: async (k) => k,
  clearAll: async () => {},
}));

const { default: LibraryPanel } = await import('./LibraryPanel.jsx');
const { useLibraryStore } = await import('../stores/libraryStore.js');

/**
 * The store's real write actions, captured before any test swaps them for a spy.
 *
 * Several tests below replace `saveProject` / `saveProgram` on the store to
 * watch what the panel calls — which leaves the stub in place for whatever runs
 * next. Anything exercising the real thing restores these first.
 */
const REAL_ACTIONS = {
  saveProject: useLibraryStore.getState().saveProject,
  saveProgram: useLibraryStore.getState().saveProgram,
};

let container;
let root;

/**
 * Two of mine and one a colleague published — the arrangement the panel exists
 * to keep distinguishable. Rows carry the server's own permission answers
 * (`canShare` / `canUnshare` / `canDelete`), because that is what the panel
 * renders from; it does not work them out for itself.
 */
const MINE = [
  {
    id: '1',
    key: 'project/OR35128 OP10',
    kind: 'project',
    name: 'OR35128 OP10',
    savedAt: '2026-08-05T09:00:00.000Z',
    bytes: 41200,
    note: '412 blocks · 3 ops · a part',
    shared: false, mine: true,
    canShare: true, canUnshare: false, canDelete: true,
  },
  {
    id: '2',
    key: 'program/Facing test',
    kind: 'program',
    name: 'Facing test',
    savedAt: '2026-08-01T09:00:00.000Z',
    bytes: 812,
    note: '18 blocks',
    shared: false, mine: true,
    canShare: true, canUnshare: false, canDelete: true,
  },
];

const THEIRS = {
  id: '3',
  key: 'program/Shop standard',
  kind: 'program',
  name: 'Shop standard',
  savedAt: '2026-08-04T09:00:00.000Z',
  bytes: 400,
  note: '9 blocks',
  shared: true, mine: false,
  owner_empno: 'XX999', owner_name: 'Somchai',
  canShare: false, canUnshare: false, canDelete: false,
};

const ITEMS = [...MINE, THEIRS];

/** Open the panel and hand back the portal-rendered body. */
async function openPanel(props = {}) {
  // eslint-disable-next-line testing-library/no-unnecessary-act
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
    items: ITEMS, loaded: true, busy: false, error: null,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('LibraryPanel — what is on screen', () => {
  it('stays shut until the trigger is pressed', async () => {
    // eslint-disable-next-line testing-library/no-unnecessary-act
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
    expect(body.querySelectorAll('[data-library-item]')).toHaveLength(3);
  });

  it('separates my own work from the shared shelf, and names both', async () => {
    const body = await openPanel();
    expect(body.textContent).toContain('My work');
    expect(body.textContent).toContain('Shared library');
  });

  it('gives every row a way to open it', async () => {
    const body = await openPanel();
    for (const item of ITEMS) {
      expect(body.querySelector(`[data-library-open="${item.id}"]`)).not.toBeNull();
    }
  });

  it('offers Share and Delete on my own work', async () => {
    const body = await openPanel();
    for (const item of MINE) {
      expect(body.querySelector(`[data-library-share="${item.id}"]`)).not.toBeNull();
      expect(body.querySelector(`[data-library-delete="${item.id}"]`)).not.toBeNull();
    }
  });

  it('offers neither on what somebody else shared — a button that would fail is worse than none', async () => {
    const body = await openPanel();
    expect(body.querySelector(`[data-library-delete="${THEIRS.id}"]`)).toBeNull();
    expect(body.querySelector(`[data-library-unshare="${THEIRS.id}"]`)).toBeNull();
    expect(body.querySelector(`[data-library-share="${THEIRS.id}"]`)).toBeNull();
  });

  it('says whose a shared item is, so it is clear it is not yours', async () => {
    const body = await openPanel();
    const row = body.querySelector(`[data-library-item="${THEIRS.id}"]`);
    expect(row.textContent).toContain('by Somchai');
  });

  it('offers Unshare on what I published myself', async () => {
    useLibraryStore.setState({
      items: [{ ...THEIRS, mine: true, owner_name: 'Me', canUnshare: true, canDelete: true }],
    });
    const body = await openPanel();
    expect(body.querySelector(`[data-library-unshare="${THEIRS.id}"]`)).not.toBeNull();
  });

  it('says what each item is, so two saves of one job can be told apart', async () => {
    const body = await openPanel();
    const row = body.querySelector('[data-library-item="1"]');
    expect(row.textContent).toContain('OR35128 OP10');
    expect(row.textContent).toContain('412 blocks · 3 ops · a part');
    expect(row.textContent).toContain('41.2 kB');
  });

  it('offers both things worth saving', async () => {
    const body = await openPanel();
    expect(body.querySelector('[data-library-save="project"]')).not.toBeNull();
    expect(body.querySelector('[data-library-save="program"]')).not.toBeNull();
  });

  it('asks for no name until a save is asked for — opening the library only shows the library', async () => {
    const body = await openPanel();
    expect(body.querySelector('[data-library-name]')).toBeNull();
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

  it('says a save is private, because the previous design made every save a publish', async () => {
    const body = await openPanel();
    expect(body.textContent).toContain('your own');
    expect(body.textContent).toContain("nobody else's work is touched");
  });
});

/** Press one of the save buttons and wait for the naming dialog to settle. */
async function beginSave(body, kind) {
  await act(async () => {
    body.querySelector(`[data-library-save="${kind}"]`).click();
  });
  // The suggested name is fetched, so it arrives a microtask after the click.
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => {});
  return body;
}

describe('LibraryPanel — saving', () => {
  it('asks for a name before writing anything', async () => {
    const saveProject = vi.fn(async () => ({ name: 'x' }));
    useLibraryStore.setState({ saveProject });
    const body = await beginSave(await openPanel(), 'project');

    expect(body.querySelector('[data-library-name]')).not.toBeNull();
    expect(saveProject).not.toHaveBeenCalled();
  });

  it('fills the box with a suggestion, so the common case is one keystroke', async () => {
    const body = await beginSave(await openPanel(), 'project');
    expect(body.querySelector('[data-library-name]').value.length).toBeGreaterThan(0);
  });

  it('saves under the name in the box once the dialog is confirmed, and reports it back', async () => {
    const saveProject = vi.fn(async () => ({ name: 'OP10 setup' }));
    useLibraryStore.setState({ saveProject });
    const onDone = vi.fn();
    const body = await beginSave(await openPanel({ onDone }), 'project');

    await act(async () => {
      body.querySelector('[data-library-confirm="true"]').click();
    });
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(expect.stringContaining('OP10 setup'));
  });

  it('writes nothing when the dialog is cancelled', async () => {
    const saveProgram = vi.fn(async () => ({ name: 'x' }));
    useLibraryStore.setState({ saveProgram });
    const body = await beginSave(await openPanel(), 'program');

    await act(async () => {
      body.querySelector('[data-library-cancel="true"]').click();
    });
    expect(saveProgram).not.toHaveBeenCalled();
  });

  it('does not report a save that failed', async () => {
    useLibraryStore.setState({
      saveProgram: vi.fn(async () => { throw new Error('no'); }),
    });
    const onDone = vi.fn();
    const body = await beginSave(await openPanel({ onDone }), 'program');
    await act(async () => {
      body.querySelector('[data-library-confirm="true"]').click();
    });
    expect(onDone).not.toHaveBeenCalled();
  });

  it('warns that a name already on my shelf will be replaced', async () => {
    const body = await beginSave(await openPanel(), 'project');
    const input = body.querySelector('[data-library-name]');
    await act(async () => {
      // React tracks the value on the node; set it through the prototype setter
      // so the change event is not swallowed as a no-op.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'OR35128 OP10');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(body.textContent).toContain('saving replaces it');
  });
});

describe('saving the project you already have open', () => {
  /** Pretend a project was opened from the library. */
  const opened = (patch = {}) => useLibraryStore.setState({
    openItem: {
      id: '1', name: 'OR35128 OP10', kind: 'project', shared: false, ...patch,
    },
  });

  it('says which project is open, so Save has a visible meaning', async () => {
    opened();
    const body = await openPanel();
    expect(body.querySelector('[data-library-current]').textContent).toContain('OR35128 OP10');
  });

  it('offers Save over the open project, and Save as… beside it', async () => {
    opened();
    const body = await openPanel();
    expect(body.querySelector('[data-library-save-open]').disabled).toBe(false);
    expect(body.querySelector('[data-library-save="project"]').textContent).toContain('Save as');
  });

  it('has nothing to save over before anything has been opened or saved', async () => {
    // The old panel had one shape — type a name — and this is the state where
    // that is still the only honest option.
    useLibraryStore.setState({ openItem: null });
    const body = await openPanel();
    expect(body.querySelector('[data-library-current]')).toBeNull();
    expect(body.querySelector('[data-library-save-open]').disabled).toBe(true);
  });

  it('will not write back over a colleague\'s shared item', async () => {
    // A save always lands on your own shelf, so "save over" cannot mean what it
    // says here — the panel says it will copy instead of pretending otherwise.
    opened({ shared: true });
    const body = await openPanel();
    expect(body.querySelector('[data-library-save-open]').disabled).toBe(true);
    expect(body.querySelector('[data-library-current]').textContent).toContain('your own copy');
  });

  it('will not offer to save a program back as a project', async () => {
    opened({ kind: 'program' });
    const body = await openPanel();
    expect(body.querySelector('[data-library-save-open]').disabled).toBe(true);
  });

  it('offers a New project button', async () => {
    const body = await openPanel();
    expect(body.querySelector('[data-library-new]')).not.toBeNull();
  });
});

describe('the store behind it', () => {
  beforeEach(() => useLibraryStore.setState({ ...REAL_ACTIONS }));

  it('remembers what was saved, so the next Save needs no name', async () => {
    useLibraryStore.setState({ openItem: null, items: [], loaded: true });
    await useLibraryStore.getState().saveProject('OP20');
    const open = useLibraryStore.getState().openItem;
    expect(open).toMatchObject({ name: 'OP20', kind: 'project', shared: false });
    expect(useLibraryStore.getState().canSaveOpen()).toBe(true);
  });

  it('refuses saveOpen when there is nothing of yours open', async () => {
    useLibraryStore.setState({ openItem: null });
    await expect(useLibraryStore.getState().saveOpen()).rejects.toThrow(/no project of your own open/i);
    useLibraryStore.setState({ openItem: { id: 'x', name: 'A', kind: 'project', shared: true } });
    await expect(useLibraryStore.getState().saveOpen()).rejects.toThrow();
  });

  it('forgets what was open when a new project is started', async () => {
    useLibraryStore.setState({
      openItem: { id: '1', name: 'OP10', kind: 'project', shared: false },
    });
    await useLibraryStore.getState().newProject();
    expect(useLibraryStore.getState().openItem).toBeNull();
    expect(useLibraryStore.getState().canSaveOpen()).toBe(false);
  });
});
