import { describe, it, expect, beforeEach } from 'vitest';
import { useCamPlanStore } from './camPlanStore.js';
import { box } from '../engine/mesh/fixtures.js';
import { pocketOp, profileOp } from '../engine/cam/toolpath/sketchOps.js';
import { toolById } from '../engine/cam/library.js';
import { machineById } from '../engine/cam/machines.js';
import { setStepParams } from '../engine/cam/recipe.js';

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
const cut = { material: 'aluminium', tool: toolById('em6'), machine: machineById('haas-vf2') };
const square = { z: 0, loops: [[-20, -20, 20, -20, 20, 20, -20, 20]] };
const zs = (op) => [...new Set(op.moves.filter((m) => m.t === 'feed').map((m) => m.z))];

describe('pocket / profile: rough and finish', () => {
  it('rough steps down by the depth step and leaves stock on the floor', () => {
    const op = pocketOp(square, { ...cut, depth: 6, pass: 'rough', stepdown: 2, leave: 0.5 });
    expect(Math.min(...zs(op))).toBeCloseTo(-5.5, 6);
    expect(zs(op)).toHaveLength(3);
    expect(op.engagement).toMatchObject({ pass: 'rough', stepdown: 2, leave: 0.5 });
  });

  it('finish cuts the full depth in one pass and leaves nothing', () => {
    const op = pocketOp(square, { ...cut, depth: 6, pass: 'finish', leave: 0.5 });
    expect(zs(op)).toEqual([-6]);
    expect(op.engagement.leave).toBe(0);
  });

  it('a side step override is used for the rings', () => {
    const auto = pocketOp(square, { ...cut, depth: 1 });
    const wide = pocketOp(square, { ...cut, depth: 1, stepover: 5 });
    expect(wide.engagement.stepover).toBe(5);
    expect(wide.cutLength).toBeLessThan(auto.cutLength);
  });

  it('a rough profile stands off the wall by the stock left', () => {
    const op = profileOp(square, { ...cut, depth: 2, pass: 'rough', leave: 1 });
    const xs = op.moves.filter((m) => m.t === 'feed').map((m) => m.x);
    expect(Math.max(...xs)).toBeCloseTo(20 + 3 + 1, 1);
  });

  it('no pass at all (an older recipe) cuts as before: stepped, nothing left', () => {
    const op = pocketOp(square, { ...cut, depth: 6 });
    expect(Math.min(...zs(op))).toBeCloseTo(-6, 6);
    expect(op.engagement.leave).toBe(0);
  });
});

describe('setStepParams', () => {
  it('sets values, and an empty one goes back to automatic', () => {
    let r = [{ key: 'pocket', kind: 'pocket', params: { stepdown: 2 } }];
    r = setStepParams(r, 'pocket', { pass: 'finish', stepover: 3 });
    expect(r[0].params).toEqual({ stepdown: 2, pass: 'finish', stepover: 3 });
    r = setStepParams(r, 'pocket', { stepdown: null });
    expect(r[0].params).toEqual({ pass: 'finish', stepover: 3 });
  });
});

describe('pocket / profile from a picked face', () => {
  beforeEach(() => { store().clear(); });

  it('adds rough + finish on a face, with the depth down to it', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const top = store().features().faces.find((f) => f.facing === 'up');
    store().addFaceShapeStep('profile', top.id, { depth: 4, side: 'outside', pass: 'both' });
    const rows = store().recipe.filter((e) => e.kind === 'profile');
    expect(rows.map((e) => e.params.pass)).toEqual(['rough', 'finish']);
    expect(rows[0].params.leave).toBe(0.2);
    const steps = store().plan.steps.filter((s) => s.kind === 'profile');
    expect(steps).toHaveLength(2);
    expect(steps[0].cut).toMatchObject({ pass: 'rough', leave: 0.2 });
    expect(steps[1].cut).toMatchObject({ pass: 'finish', leave: 0 });
    expect(store().nc).toBeTruthy();
  });

  it('table edits change the built step', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const top = store().features().faces.find((f) => f.facing === 'up');
    store().addFaceShapeStep('profile', top.id, { depth: 6, pass: 'rough' });
    const key = store().recipe.find((e) => e.kind === 'profile').key;
    store().setStepParams(key, { stepdown: 1.5 });
    const step = store().plan.steps.find((s) => s.key === key);
    expect(step.cut.stepdown).toBe(1.5);
    expect(step.notes[0]).toMatch(/4 level/);
  });

  it('roughing shows its automatic steps, and takes an override', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const rough = store().plan.steps.find((s) => s.kind === 'rough');
    expect(rough.cut.stepdown).toBeGreaterThan(0);
    expect(rough.cut.leave).toBe(0.3);
    store().setStepParams(rough.key, { leave: 0.1 });
    expect(store().plan.steps.find((s) => s.key === rough.key).cut.leave).toBe(0.1);
  });
});
