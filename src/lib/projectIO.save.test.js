// @vitest-environment jsdom
/**
 * Save and Save As: which file each writes to, and what happens where the browser
 * has no Save dialog, which is how the shop reaches this page over plain HTTP.
 */
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {
  saveProject, saveProjectAs, canPickSaveLocation, currentProjectFileName, newProject,
  openProgramFile, currentProject,
} from './projectIO.js';
import { serializeProject } from '../engine/projectFile.js';
import { useCamStore } from '../stores/camStore.js';

const fakeHandle = (name) => {
  const written = [];
  return {
    name,
    written,
    createWritable: async () => ({
      write: async (text) => { written.push(text); },
      close: async () => {},
    }),
  };
};

let downloads;

beforeEach(async () => {
  // `newProject` ends by parsing an empty program, which needs the G-code worker.
  useCamStore.setState({ parse: vi.fn(async () => {}) });
  await newProject();
  useCamStore.setState({ fileName: 'bracket.nc' });
  downloads = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    downloads.push(this.download);
  });
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  delete window.showSaveFilePicker;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.showSaveFilePicker;
});

describe('with no Save dialog (plain HTTP)', () => {
  it('says so, so the menu can ask for the name itself', () => {
    expect(canPickSaveLocation()).toBe(false);
  });

  it('Save downloads under the name the work already has', async () => {
    expect(await saveProject()).toBe('bracket.camweb.json');
    expect(downloads).toEqual(['bracket.camweb.json']);
  });

  it('Save As downloads under the typed name, and Save keeps using it', async () => {
    expect(await saveProjectAs('OP10 rev.2')).toBe('OP10 rev.2.camweb.json');
    expect(currentProjectFileName()).toBe('OP10 rev.2.camweb.json');
    await saveProject();
    expect(downloads).toEqual(['OP10 rev.2.camweb.json', 'OP10 rev.2.camweb.json']);
  });
});

describe('opening a file through the program door', () => {
  const file = (name, text) => ({ name, text: async () => text });

  it('opens a project as a project, whatever it is called', async () => {
    useCamStore.setState({ gcode: 'G0 X1', loadFile: vi.fn() });
    const text = serializeProject(currentProject());
    expect(await openProgramFile(file('saved.txt', text))).toBe(true);
    expect(useCamStore.getState().loadFile).not.toHaveBeenCalled();
    expect(useCamStore.getState().parse).toHaveBeenLastCalledWith('G0 X1', expect.anything());
    expect(currentProjectFileName()).toBe('saved.txt');
  });

  it('opens anything else as a program', async () => {
    useCamStore.setState({ loadFile: vi.fn() });
    const nc = file('part.nc', '%\nO0001\nG0 X0\n%');
    expect(await openProgramFile(nc)).toBe(false);
    expect(useCamStore.getState().loadFile).toHaveBeenCalledWith(nc);
  });

  it('does not mistake other JSON for a project', async () => {
    useCamStore.setState({ loadFile: vi.fn() });
    expect(await openProgramFile(file('other.json', '{"kind":"something-else"}'))).toBe(false);
  });
});

describe('with a Save dialog', () => {
  it('Save asks once, then writes back over that file without asking', async () => {
    const handle = fakeHandle('chosen.camweb.json');
    window.showSaveFilePicker = vi.fn(async () => handle);
    expect(await saveProject()).toBe('chosen.camweb.json');
    expect(await saveProject()).toBe('chosen.camweb.json');
    expect(window.showSaveFilePicker).toHaveBeenCalledTimes(1);
    expect(handle.written).toHaveLength(2);
  });

  it('Save As always asks, and later saves go to the new file', async () => {
    const first = fakeHandle('first.camweb.json');
    const second = fakeHandle('second.camweb.json');
    window.showSaveFilePicker = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    await saveProject();
    await saveProjectAs();
    await saveProject();
    expect(window.showSaveFilePicker).toHaveBeenCalledTimes(2);
    expect(first.written).toHaveLength(1);
    expect(second.written).toHaveLength(2);
  });

  it('Save As suggests the current name', async () => {
    window.showSaveFilePicker = vi.fn(async () => fakeHandle('x.camweb.json'));
    await saveProjectAs();
    expect(window.showSaveFilePicker.mock.calls[0][0].suggestedName).toBe('bracket.camweb.json');
  });

  it('closing the dialog saves nothing and keeps the file as it was', async () => {
    const handle = fakeHandle('kept.camweb.json');
    window.showSaveFilePicker = vi.fn().mockResolvedValueOnce(handle);
    await saveProject();
    window.showSaveFilePicker.mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'AbortError' }));
    expect(await saveProjectAs()).toBeNull();
    await saveProject();
    expect(handle.written).toHaveLength(2);
  });

  it('asks again when the permission to write back is refused', async () => {
    const lost = fakeHandle('lost.camweb.json');
    const next = fakeHandle('next.camweb.json');
    window.showSaveFilePicker = vi.fn().mockResolvedValueOnce(lost).mockResolvedValueOnce(next);
    await saveProject();
    lost.createWritable = async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); };
    expect(await saveProject()).toBe('next.camweb.json');
  });

  it('a new project forgets the file', async () => {
    window.showSaveFilePicker = vi.fn(async () => fakeHandle('old.camweb.json'));
    await saveProject();
    await newProject();
    useCamStore.setState({ fileName: 'fresh.nc' });
    expect(currentProjectFileName()).toBe('fresh.camweb.json');
  });
});
