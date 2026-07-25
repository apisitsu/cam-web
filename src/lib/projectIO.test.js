/**
 * Save/open wiring: `currentProject` must gather the CAM setup from
 * `camPlanStore` (not just the G-code from `camStore`), and a full
 * serialize → parse → restore cycle must bring the machine, material, origin and
 * operations back. This guards the seam the two store-level and engine-level
 * suites can't: that projectIO actually reads and writes the `cam` block.
 *
 * `openProjectFile` itself drives the G-code worker, so it isn't exercised here;
 * the store's `restoreSetup` (the half that rebuilds the part) is called
 * directly instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { currentProject } from './projectIO.js';
import { serializeProject, parseProject } from '../engine/projectFile.js';
import { useCamStore } from '../stores/camStore.js';
import { useCamPlanStore, getMesh } from '../stores/camPlanStore.js';
import { box } from '../engine/mesh/fixtures.js';

const plan = () => useCamPlanStore.getState();

/** A binary-STL File-alike, as the store receives one from a drop. */
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

describe('projectIO — the project carries the whole CAM setup', () => {
  beforeEach(() => {
    plan().clear();
    useCamStore.setState({ gcode: '', fileName: null });
  });

  it('a saved project includes machine, material and origin — not just the code', async () => {
    await plan().loadStl(stlFile(box(60, 40, 15), 'bracket.stl'));
    plan().setMachine('haas-vf2');
    plan().setOption({ material: 'steel' });
    plan().setAxisOrigin(2, -7.5);
    await plan().makePlan();
    useCamStore.setState({ gcode: 'G21 G90\n', fileName: 'bracket.stl' });

    const doc = currentProject();
    expect(doc.cam).toBeTruthy();
    expect(doc.cam.settings.machineId).toBe('haas-vf2');
    expect(doc.cam.settings.material).toBe('steel');
    expect(doc.cam.datum.axesSet).toEqual([false, false, true]);
    expect(doc.cam.part.name).toBe('bracket.stl');
    expect(doc.cam.recipe.length).toBeGreaterThan(0);
    // The G-code is still there too — the setup is additive, not a replacement.
    expect(doc.gcode).toBe('G21 G90\n');
  });

  it('survives serialize → file text → parse → restore', async () => {
    await plan().loadStl(stlFile(box(60, 40, 15), 'bracket.stl'));
    plan().setMachine('haas-vf2');
    plan().setOption({ material: 'steel' });
    plan().setAxisOrigin(2, -7.5);
    await plan().makePlan();

    // Write to text and read back, exactly as save-to-disk / open-file would.
    const text = serializeProject(currentProject());
    const parsed = parseProject(text);

    plan().clear();
    const mode = plan().restoreSetup(parsed.cam);

    expect(mode).toBe('mill');
    expect(plan().machineId).toBe('haas-vf2');
    expect(plan().material).toBe('steel');
    expect(plan().stlName).toBe('bracket.stl');
    expect(plan().plan.part.bottom).toBeCloseTo(0, 3); // origin restored
    expect(getMesh().soup.triangleCount).toBe(12);
  });

  it('a part-less project has no cam block, staying v1-shaped', () => {
    useCamStore.setState({ gcode: 'G0 X0', fileName: 'hand.nc' });
    const doc = currentProject();
    expect(doc.cam).toBeNull();
    expect(doc.gcode).toBe('G0 X0');
  });
});
