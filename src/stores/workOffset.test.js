import { describe, it, expect, beforeEach } from 'vitest';
import { useCamPlanStore } from './camPlanStore.js';
import { useCamStore } from './camStore.js';
import { box } from '../engine/mesh/fixtures.js';
import { homeInWork, homeEstimate, machineById } from '../engine/cam/machines.js';

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

const plan = () => useCamPlanStore.getState();
const vf2 = machineById('haas-vf2');

describe('homeInWork', () => {
  it('is the machine home less the work offset, per axis', () => {
    expect(homeInWork(vf2, { X: -400, Y: -250.5, Z: -300 })).toEqual({ X: 400, Y: 250.5, Z: 300 });
    expect(homeInWork({ ...vf2, home: { X: 0, Y: 0, Z: -10 } }, { X: -400, Y: -250, Z: -300 }).Z).toBe(290);
  });

  it('an axis with no offset value falls back to the stroke estimate', () => {
    const est = homeEstimate(vf2);
    expect(homeInWork(vf2, { X: -400, Y: null })).toEqual({ X: 400, Y: est.Y, Z: est.Z });
    expect(homeInWork(vf2)).toEqual(est);
  });
});

describe('work offsets in the plan store', () => {
  beforeEach(() => {
    plan().clear();
    useCamPlanStore.setState({
      workOffsets: [{ code: 'G54', X: null, Y: null, Z: null, note: '' }], activeOffset: 'G54',
    });
    plan().setMachine('haas-vf2');
  });

  it('the offset in use sets the G28 distance the viewport times', () => {
    plan().setWorkOffset('G54', { X: -381, Y: -203, Z: -400 });
    expect(useCamStore.getState().home).toEqual({ X: 381, Y: 203, Z: 400 });
  });

  it('adds G55…G59 in order and stops there; removing the one in use moves to the first', () => {
    const added = [];
    for (let i = 0; i < 6; i++) added.push(plan().addWorkOffset());
    expect(added).toEqual(['G55', 'G56', 'G57', 'G58', 'G59', null]);
    plan().setWorkOffset('G56', { X: -100, Y: -100, Z: -100 });
    plan().setActiveOffset('G56');
    expect(useCamStore.getState().home).toEqual({ X: 100, Y: 100, Z: 100 });
    plan().removeWorkOffset('G56');
    expect(plan().activeOffset).toBe('G54');
    expect(plan().workOffsets.map((o) => o.code)).toEqual(['G54', 'G55', 'G57', 'G58', 'G59']);
  });

  it('the last offset cannot be removed', () => {
    plan().removeWorkOffset('G54');
    expect(plan().workOffsets).toHaveLength(1);
  });

  it('the program is posted with the offset in use', async () => {
    await plan().loadStl(stlFile(box(60, 40, 20)));
    await plan().makePlan();
    expect(plan().nc).toMatch(/\bG54\b/);
    plan().addWorkOffset();
    plan().setActiveOffset('G55');
    expect(plan().nc).toMatch(/\bG55\b/);
    expect(plan().nc).not.toMatch(/\bG54\b/);
  });

  it('offsets are saved with the project and come back', async () => {
    await plan().loadStl(stlFile(box(60, 40, 20)));
    await plan().makePlan();
    plan().addWorkOffset();
    plan().setWorkOffset('G55', { X: -500, Y: -200, Z: -350, note: 'vise 2' });
    plan().setActiveOffset('G55');
    const saved = plan().serializeSetup();
    useCamPlanStore.setState({ workOffsets: [{ code: 'G54', X: null, Y: null, Z: null, note: '' }], activeOffset: 'G54' });
    plan().restoreSetup(saved);
    expect(plan().activeOffset).toBe('G55');
    expect(plan().workOffsets[1]).toEqual({ code: 'G55', X: -500, Y: -200, Z: -350, note: 'vise 2' });
    expect(useCamStore.getState().home).toEqual({ X: 500, Y: 200, Z: 350 });
  });

  it('a project saved before offsets existed opens with a blank G54', async () => {
    await plan().loadStl(stlFile(box(60, 40, 20)));
    await plan().makePlan();
    const saved = plan().serializeSetup();
    delete saved.settings.workOffsets;
    delete saved.settings.activeOffset;
    plan().addWorkOffset();
    plan().setActiveOffset('G55');
    plan().restoreSetup(saved);
    expect(plan().workOffsets).toEqual([{ code: 'G54', X: null, Y: null, Z: null, note: '' }]);
    expect(plan().activeOffset).toBe('G54');
  });
});
