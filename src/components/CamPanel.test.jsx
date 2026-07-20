/**
 * @vitest-environment jsdom
 *
 * Render-gate tests for the CAM panel.
 *
 * The engine tests already prove that a tool can be swapped and a machine
 * chosen. What they cannot prove is that the controls to do either are on
 * screen — and a planner the operator cannot overrule is exactly the complaint
 * this panel was rebuilt to answer. So these check reachability, not maths:
 * does every operation row offer a tool, does the machine list contain real
 * machines, does a skipped step still appear.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import CamPanel from './CamPanel.jsx';
import { useCamPlanStore } from '../stores/camPlanStore.js';
import { DEFAULT_MILL_ID } from '../engine/cam/machines.js';
import { box, turnedShaft } from '../engine/mesh/fixtures.js';

/** A binary-STL File-alike, the way the store receives one from a drop. */
function stlFile(soup, name = 'part.stl') {
  const buf = new ArrayBuffer(84 + soup.triangleCount * 50);
  const view = new DataView(buf);
  view.setUint32(80, soup.triangleCount, true);
  let o = 84;
  for (let t = 0; t < soup.triangleCount; t++) {
    o += 12;
    for (let v = 0; v < 9; v++) { view.setFloat32(o, soup.positions[t * 9 + v], true); o += 4; }
    o += 2;
  }
  return { name, arrayBuffer: async () => buf };
}

const store = () => useCamPlanStore.getState();

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  store().clear();
  useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'auto', material: 'aluminium' });
  // antd's responsive observers need a matchMedia in jsdom.
  window.matchMedia ??= () => ({
    matches: false, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => { root.render(React.createElement(CamPanel)); });
  return container;
}

/** Plan a part, then render the panel against the result. */
async function planned(soup) {
  await store().loadStl(stlFile(soup));
  await act(async () => { await store().makePlan(); });
  return render();
}

describe('before an STL arrives', () => {
  it('shows the import prompt and no machine controls', async () => {
    const el = await render();
    expect(el.textContent).toMatch(/Import an .stl/);
    expect(el.textContent).not.toMatch(/Machine/);
  });
});

describe('choosing the machine', () => {
  it('names a real machine, not just "mill" or "lathe"', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    const el = await render();
    expect(el.textContent).toMatch(/Machine/);
    // The selected value is rendered by make and model.
    expect(el.textContent).toMatch(/Generic · 3-axis VMC/);
  });

  it('says which control the program will be posted for', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    useCamPlanStore.setState({ machineId: 'haas-vf2' });
    const el = await render();
    expect(el.textContent).toMatch(/Haas · VF-2/);
    expect(el.textContent).toMatch(/posts as Haas/);
  });

  it('follows the part onto a lathe and shows the lathe', async () => {
    const el = await planned(turnedShaft());
    expect(store().plan.mode).toBe('turn');
    expect(el.textContent).toMatch(/2-axis CNC lathe/);
    expect(el.textContent).toMatch(/Turning/);
  });
});

describe('the operation table', () => {
  it('gives every operation a tool selector', async () => {
    const el = await planned(box(60, 40, 15));
    const selects = el.querySelectorAll('.ant-table-tbody .ant-select');
    expect(selects.length).toBe(store().recipe.length);
    expect(selects.length).toBeGreaterThan(1);
  });

  it('shows the tool actually in use on each row', async () => {
    const el = await planned(box(60, 40, 15));
    const rough = store().plan.steps.find((s) => s.kind === 'rough');
    expect(el.textContent).toContain(rough.tool);
  });

  it('re-renders with the new tool after a swap', async () => {
    await planned(box(60, 40, 15));
    await act(async () => { store().setStepTool('rough', 'em6'); });
    await render();
    expect(container.textContent).toContain('Endmill Ø6');
  });

  it('offers a switch, reorder and delete on every row', async () => {
    const el = await planned(box(60, 40, 15));
    const rows = el.querySelectorAll('.ant-table-tbody tr.ant-table-row');
    expect(rows).toHaveLength(store().recipe.length);
    for (const row of rows) {
      expect(row.querySelector('.ant-switch')).toBeTruthy();
      expect(row.querySelectorAll('button').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps a skipped operation visible, marked skipped', async () => {
    // A step that vanishes when switched off cannot be switched back on.
    await planned(box(60, 40, 15));
    const rows = store().recipe.length;
    await act(async () => { store().toggleStep('face', false); });
    const el = await render();
    expect(el.querySelectorAll('.ant-table-tbody tr.ant-table-row')).toHaveLength(rows);
    expect(el.textContent).toMatch(/skipped/);
  });

  it('offers to add an operation and to reset the plan', async () => {
    const el = await planned(box(60, 40, 15));
    expect(el.textContent).toMatch(/Add operation/);
    // "Edited" only appears once the operator has actually changed something.
    expect(el.textContent).not.toMatch(/edited/);
    await act(async () => { store().setStepTool('rough', 'em6'); });
    await render();
    expect(container.textContent).toMatch(/edited/);
  });
});

describe('the numbers on screen come from the machine', () => {
  it('changes the displayed rpm when the machine changes', async () => {
    await planned(box(60, 40, 15));
    await act(async () => { store().setMachine('brother-s700'); });
    await render();
    const fast = store().plan.steps.find((s) => s.kind === 'rough').speeds.rpm;
    expect(container.textContent).toContain(`${fast} rpm`);

    await act(async () => { store().setMachine('knee-mill-cnc'); });
    await render();
    const slow = store().plan.steps.find((s) => s.kind === 'rough').speeds.rpm;
    expect(slow).toBeLessThan(fast);
    expect(container.textContent).toContain(`${slow} rpm`);
  });
});

describe('stroke and axes on screen', () => {
  it('shows the chosen machine’s axis count and stroke', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    useCamPlanStore.setState({ machineId: 'haas-vf2' });
    const el = await render();
    expect(el.textContent).toMatch(/3-axis \(XYZ\)/);
    expect(el.textContent).toMatch(/stroke 762 × 406 × 508 mm/);
  });

  it('shows a lathe’s two strokes and its swing, not a fake Y', async () => {
    await store().loadStl(stlFile(turnedShaft()));
    useCamPlanStore.setState({ machineId: 'haas-st20' });
    const el = await render();
    expect(el.textContent).toMatch(/2-axis \(XZ\)/);
    expect(el.textContent).toMatch(/stroke 209 × 559 mm/);
    expect(el.textContent).toMatch(/Ø267 max/);
  });

  it('counts the spare axes on a 5-axis machine', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    useCamPlanStore.setState({ machineId: 'dmgmori-dmu50' });
    const el = await render();
    expect(el.textContent).toMatch(/5-axis \(XYZ\+BC\)/);
  });

  it('reports what the program itself needs once planned', async () => {
    const el = await planned(box(60, 40, 15));
    expect(el.textContent).toMatch(/3-axis program \(XYZ\)/);
    // ...and how much of each stroke it eats.
    for (const t of store().plan.envelope.travel) {
      expect(el.textContent).toContain(`${t.axis} ${t.used}%`);
    }
  });

  it('warns on screen when the toolpath will not fit', async () => {
    await store().loadStl(stlFile(box(500, 200, 10)));
    await act(async () => { await store().makePlan(); });
    await act(async () => { store().setMachine('haas-minimill'); });
    const el = await render();
    expect(el.textContent).toMatch(/travel/);
  });
});

describe('the machine list answers "which of ours can take it"', () => {
  /** Open the machine dropdown and read the option list. */
  async function machineOptions() {
    const select = container.querySelector('.ant-select-selector');
    await act(async () => {
      select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    return document.body.textContent;
  }

  it('flags the machines a big part will not fit', async () => {
    // A 500 mm plate: fine on a VCS-530C, not on a Mini Mill.
    await store().loadStl(stlFile(box(500, 200, 40)));
    await render();
    const text = await machineOptions();
    expect(text).toMatch(/part too big/);
  });

  it('flags nothing when everything in the shop can take it', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await render();
    const text = await machineOptions();
    expect(text).not.toMatch(/part too big/);
  });

  it('shows each machine’s stroke in the list', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await render();
    const text = await machineOptions();
    expect(text).toMatch(/1050 × 530 × 510 mm/);   // the VCS-530C
  });
});

describe('indexing and picking, on screen', () => {
  it('offers rotary angles only on a machine that has a rotary', async () => {
    await planned(box(120, 30, 20));
    await act(async () => { store().setMachine('haas-vf2'); });
    await render();
    expect(container.textContent).toMatch(/has no rotary/);

    await act(async () => { store().setMachine('mazak-vcn530c-4th'); });
    await render();
    expect(container.textContent).toMatch(/Rotary index/);
    expect(container.textContent).toMatch(/A180/);
  });

  it('lists the faces and edges of the part to pick from', async () => {
    const el = await planned(box(60, 40, 20));
    expect(el.textContent).toMatch(/Faces \(6\)/);
    expect(el.textContent).toMatch(/Edges \(\d+\)/);
  });

  it('offers nothing to pick on a lathe job', async () => {
    const el = await planned(turnedShaft());
    expect(el.textContent).not.toMatch(/Faces \(/);
  });

  it('adds an operation for a picked face', async () => {
    await planned(box(60, 40, 20));
    const top = store().features().faces.find((f) => f.facing === 'up');
    await act(async () => { store().addFaceStep(top.id); });
    await render();
    expect(container.textContent).toMatch(/Clear the picked face/);
  });

  it('shows why an unreachable face produced nothing', async () => {
    await planned(box(60, 40, 20));
    const side = store().features().faces.find((f) => f.facing === 'front');
    await act(async () => { store().addFaceStep(side.id); });
    await render();
    expect(container.textContent).toMatch(/cannot be reached along the tool axis/);
  });
});
