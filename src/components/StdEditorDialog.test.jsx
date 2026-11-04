/**
 * @vitest-environment jsdom
 *
 * The table editor: that it opens on the stored material, sends the ranges that
 * were filled in (and only those), and shows the server's refusal as a sentence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntdApp } from 'antd';

const calls = { saved: [], fail: null };
vi.mock('../lib/stdApi.js', () => ({
  listStd: async () => [
    {
      key: '17-4PH', label: '17-4PH H1025', isoGroup: 'ISO M/H', aliases: ['17-4PH'], status: 'draft', sourceNote: '',
      vc: { turning: [70, 120], milling: [60, 100] },
    },
  ],
  saveStd: async (key, body) => {
    if (calls.fail) throw new Error(calls.fail);
    calls.saved.push({ key, body });
  },
}));

const { default: StdEditorDialog } = await import('./StdEditorDialog.jsx');
const { useStdStore } = await import('../stores/stdStore.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const q = (sel) => document.body.querySelector(sel);

beforeEach(async () => {
  window.matchMedia ??= () => ({
    matches: false, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  });
  calls.saved = [];
  calls.fail = null;
  useStdStore.setState({ materials: [], loaded: false, loading: false, editorOpen: false, error: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<AntdApp><StdEditorDialog /></AntdApp>); });
  await act(async () => { await useStdStore.getState().openEditor(); });
  await flush();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  document.body.innerHTML = '';
});

describe('StdEditorDialog', () => {
  it('opens on the stored material with its ranges filled in', () => {
    expect(q('[data-std-editor-save]')).not.toBeNull();
    expect(q('[data-std-editor-min="turning"]').value).toBe('70');
    expect(q('[data-std-editor-max="milling"]').value).toBe('100');
    expect(q('[data-std-editor-min="drilling"]').value).toBe('');
  });

  it('saves only the operations that have a range', async () => {
    await act(async () => { q('[data-std-editor-save]').click(); });
    await flush();
    expect(calls.saved).toHaveLength(1);
    expect(calls.saved[0].key).toBe('17-4PH');
    expect(Object.keys(calls.saved[0].body.vc).sort()).toEqual(['milling', 'turning']);
    expect(q('[data-std-editor-saved]')).not.toBeNull();
  });

  it("shows the server's refusal as a sentence", async () => {
    calls.fail = 'Only an administrator can mark a standard as approved.';
    await act(async () => { q('[data-std-editor-save]').click(); });
    await flush();
    expect(q('[data-std-editor-error]').textContent).toContain('Only an administrator');
  });
});
