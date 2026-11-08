/**
 * @vitest-environment jsdom
 *
 * Render gates for the standard-speed dialog. What it proposes is
 * `engine/cam/stdVc.test.js` and the sequencing is `stores/stdStore.test.js`;
 * what needs the DOM is whether the operator can see what would change and has
 * both ways out — a dialog that proposes but has no visible "keep as is", or an
 * Apply that does nothing, would be worse than no dialog.
 *
 * antd renders a Modal into a portal, so assertions run against `document.body`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntdApp } from 'antd';

vi.mock('../lib/stdApi.js', () => ({
  listStd: async () => [
    {
      key: '17-4PH', label: '17-4PH H1025', isoGroup: 'ISO M/H', aliases: ['17-4PH'], status: 'draft', sourceNote: '',
      vc: { turning: [70, 120], milling: [60, 100], drilling: [40, 70], reaming: [30, 50], tap: [5, 12] },
    },
  ],
  saveStd: async () => undefined,
}));

const { default: StdVcDialog } = await import('./StdVcDialog.jsx');
const { useStdStore } = await import('../stores/stdStore.js');
const { useCamStore } = await import('../stores/camStore.js');

const SLOW = 'O1\nT1(ENDMILL D8)\nM6\nS1700M3\nG1X10.F400.\nM30';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let parsed;

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<AntdApp><StdVcDialog /></AntdApp>);
  });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const q = (sel) => document.body.querySelector(sel);

beforeEach(() => {
  // antd's responsive observers (the Table) need a matchMedia in jsdom.
  window.matchMedia ??= () => ({
    matches: false, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  });
  parsed = [];
  useStdStore.setState({
    materials: [], loaded: false, loading: false, error: null, open: false, detection: null,
    selectedKey: null, proposal: null, off: {}, lastSeen: null, lastLoadSeq: null, lastFileName: null, undo: null, result: null, withinStandard: false,
  });
  useCamStore.setState({
    gcode: SLOW, fileName: '17-4PH_FORK.nc', mode: 'mill',
    parse: async (t) => { parsed.push(t); useCamStore.setState({ gcode: t }); },
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  document.body.innerHTML = '';
});

describe('StdVcDialog', () => {
  it('opens by itself on a program outside the standard, and shows the change and the draft warning', async () => {
    await mount();
    await flush();
    expect(q('[data-std-apply]')).not.toBeNull();
    expect(q('[data-std-keep]')).not.toBeNull();
    expect(q('[data-std-draft]')).not.toBeNull();
    const text = document.body.textContent;
    expect(text).toContain('17-4PH H1025');
    expect(text).toContain('T1');
    expect(text).toContain('60–100 m/min');
    expect(text).toContain('Use standard (1 tool)');
  });

  it('shows the estimated cycle time with and without the change', async () => {
    await mount();
    await flush();
    expect(q('[data-std-timing]')).not.toBeNull();
    expect(q('[data-std-timing]').textContent).toContain('Estimated cycle time');
  });

  it('Keep as is closes it and writes nothing', async () => {
    await mount();
    await flush();
    await act(async () => { q('[data-std-keep]').click(); });
    await flush();
    expect(useStdStore.getState().open).toBe(false);
    expect(parsed).toEqual([]);
  });

  it('Use standard rewrites the program', async () => {
    await mount();
    await flush();
    await act(async () => { q('[data-std-apply]').click(); });
    await flush();
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toContain('S2390M3');
    expect(useStdStore.getState().open).toBe(false);
  });

  it('opens for a program already inside the range, with nothing to apply', async () => {
    useCamStore.setState({ gcode: SLOW.replace('S1700M3', 'S2400M3').replace('F400', 'F600') });
    await mount();
    await flush();
    expect(q('[data-std-apply]')).not.toBeNull();
    expect(q('[data-std-apply]').disabled).toBe(true);
    expect(q('[data-std-timing]').textContent).toContain('Estimated cycle time');
  });
});
