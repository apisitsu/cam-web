import { describe, it, expect, beforeEach } from 'vitest';
import { useCamStore } from './camStore.js';
import { useCamPlanStore } from './camPlanStore.js';
import { box } from '../engine/mesh/fixtures.js';

/** A binary-STL File-alike, the way camPlanStore receives one from a drop. */
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

describe('camStore.machineOpts — reading the rotary centre off the loaded part', () => {
  beforeEach(() => {
    useCamPlanStore.getState().clear();
    useCamStore.setState({ mode: 'mill' });
  });

  it('has no rotaryCenter with nothing loaded in camPlanStore', () => {
    expect(useCamStore.getState().machineOpts().rotaryCenter).toBeUndefined();
  });

  it('picks up the rotary centre set on the imported part', async () => {
    await useCamPlanStore.getState().loadStl(stlFile(box(120, 30, 20)));
    await useCamPlanStore.getState().makePlan();
    useCamPlanStore.getState().pickRotaryCenter([0, 15, 0]);

    const opts = useCamStore.getState().machineOpts();
    expect(opts.rotaryCenter[0]).toBeCloseTo(15, 3);
    expect(opts.rotaryCenter[1]).toBeCloseTo(0, 3);
  });

  it('carries no rotaryCenter when the viewport is set to turn — the concept does not apply', async () => {
    await useCamPlanStore.getState().loadStl(stlFile(box(120, 30, 20)));
    await useCamPlanStore.getState().makePlan();
    useCamPlanStore.getState().pickRotaryCenter([0, 15, 0]);
    useCamStore.setState({ mode: 'turn' });

    expect(useCamStore.getState().machineOpts().rotaryCenter).toBeUndefined();
  });
});
