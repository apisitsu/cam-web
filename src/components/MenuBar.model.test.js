import { describe, it, expect } from 'vitest';
import { buildMenuItems, flattenMenu, searchMenu } from './MenuBar.jsx';

const ctx = (over = {}) => ({
  libraryOpen: false,
  hasProgram: false,
  sketching: true,
  hasSelection: false,
  view: 'iso',
  treeOpen: true,
  canRestore: false,
  hasFace: false,
  hasFeatures: false,
  ...over,
});

const leaf = (items, key) => items.flatMap((t) => t.children).find((c) => c.key === key);

describe('buildMenuItems', () => {
  it('has the seven menus, with Insert between View and Tools', () => {
    expect(buildMenuItems(ctx()).map((m) => m.label))
      .toEqual(['File', 'Edit', 'View', 'Insert', 'Tools', 'Window', 'Help']);
  });

  it('turns sketch-only commands off outside the Sketch page', () => {
    const items = buildMenuItems(ctx({ sketching: false, hasFace: true, hasSelection: true }));
    for (const key of ['undo', 'redo', 'delete', 'new-sketch', 'sketch-on-face', 'import-dxf', 'export-dxf']) {
      // eslint-disable-next-line jest/valid-expect
      expect(leaf(items, key).disabled, key).toBe(true);
    }
  });

  it('offers Sketch on picked face only once a face is picked', () => {
    expect(leaf(buildMenuItems(ctx({ hasFace: false })), 'sketch-on-face').disabled).toBe(true);
    expect(leaf(buildMenuItems(ctx({ hasFace: true })), 'sketch-on-face').disabled).toBe(false);
  });

  it('offers Rebuild only when there is a tree to rebuild', () => {
    expect(leaf(buildMenuItems(ctx()), 'rebuild').disabled).toBe(true);
    expect(leaf(buildMenuItems(ctx({ hasFeatures: true })), 'rebuild').disabled).toBe(false);
  });

  it('keeps every way of saving and opening a project in the File menu', () => {
    const file = buildMenuItems(ctx()).find((m) => m.key === 'file').children.map((c) => c.key);
    for (const key of ['open-project', 'save-project', 'save-project-as', 'library', 'import-dxf', 'export-dxf']) {
      // eslint-disable-next-line jest/valid-expect
      expect(file, key).toContain(key);
    }
    expect(file).not.toContain('sample');
  });

  it('offers Clear sketch only on the Sketch page', () => {
    expect(leaf(buildMenuItems(ctx({ sketching: false })), 'clear-sketch').disabled).toBe(true);
    expect(leaf(buildMenuItems(ctx({ sketching: true })), 'clear-sketch').disabled).toBe(false);
  });

  it('gives every command a unique key', () => {
    const keys = buildMenuItems(ctx()).flatMap((t) => t.children).filter((c) => c.type !== 'divider').map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('flattenMenu', () => {
  it('drops dividers, names the menu each command is in, and strips menu punctuation', () => {
    const flat = flattenMenu(buildMenuItems(ctx({ libraryOpen: true, view: 'top' })));
    expect(flat.every((c) => c.label !== '')).toBe(true);
    expect(flat.find((c) => c.key === 'library')).toMatchObject({ label: 'Library', group: 'File' });
    expect(flat.find((c) => c.key === 'open')).toMatchObject({ label: 'Open program', group: 'File' });
    expect(flat.find((c) => c.key === 'view:top').label).toBe('Top');
  });
});

describe('searchMenu', () => {
  const flat = flattenMenu(buildMenuItems(ctx({ hasFeatures: true, hasProgram: true })));

  it('finds a command by any part of its name, ignoring case', () => {
    expect(searchMenu(flat, 'DXF').map((c) => c.key).sort()).toEqual(['export-dxf', 'import-dxf']);
    expect(searchMenu(flat, 'rebu').map((c) => c.key)).toEqual(['rebuild']);
  });

  it('wants every word, and lets a word match the menu name as well', () => {
    expect(searchMenu(flat, 'import dxf').map((c) => c.key)).toEqual(['import-dxf']);
    // "Sketch on picked face" also matches both words, but no face is picked in this ctx, so it is not offered.
    expect(searchMenu(flat, 'insert sketch').map((c) => c.key)).toEqual(['new-sketch']);
  });

  it('ranks a name match above a menu-only match', () => {
    // "file" is in no command's name but is the menu of nine; "library" is a name.
    const hits = searchMenu(flat, 'library');
    expect(hits[0].key).toBe('library');
  });

  it('never offers a command that is disabled right now', () => {
    const off = flattenMenu(buildMenuItems(ctx({ sketching: false })));
    expect(searchMenu(off, 'dxf')).toEqual([]);
    expect(searchMenu(off, 'undo')).toEqual([]);
  });

  it('returns nothing for an empty or blank query, and respects the limit', () => {
    expect(searchMenu(flat, '')).toEqual([]);
    expect(searchMenu(flat, '   ')).toEqual([]);
    expect(searchMenu(flat, 'e', 3).length).toBeLessThanOrEqual(3);
  });
});
