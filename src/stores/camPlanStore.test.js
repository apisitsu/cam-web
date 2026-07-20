import { describe, it, expect, beforeEach } from 'vitest';
import { useCamPlanStore, getMesh } from './camPlanStore.js';
import { useCamStore } from './camStore.js';
import { turnedShaft, box, groovedShaft } from '../engine/mesh/fixtures.js';
import { machineById, DEFAULT_MILL_ID } from '../engine/cam/machines.js';

/** Wrap a triangle soup as a binary STL File-alike the store can read. */
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

describe('camPlanStore', () => {
  beforeEach(() => { store().clear(); });

  it('starts empty', () => {
    expect(store().status).toBe('idle');
    expect(store().analysis).toBeNull();
    expect(store().nc).toBeNull();
  });

  it('analyses an imported STL without planning it yet', async () => {
    const analysis = await store().loadStl(stlFile(turnedShaft(), 'shaft.stl'));
    expect(analysis.recommend).toBe('turn');
    expect(store().status).toBe('ready');
    expect(store().stlName).toBe('shaft.stl');
    // Planning is a separate, deliberate step.
    expect(store().plan).toBeNull();
    expect(store().nc).toBeNull();
  });

  it('keeps mesh arrays out of React state', async () => {
    await store().loadStl(stlFile(box(30, 20, 10)));
    const state = store();
    expect(state.analysis).toBeTruthy();
    // The typed arrays live in the module cache, not in the store.
    expect(state.soup).toBeUndefined();
    expect(state.welded).toBeUndefined();
    expect(getMesh().welded.positions).toBeInstanceOf(Float32Array);
  });

  it('bumps meshVer so views re-render on a new import', async () => {
    const before = store().meshVer;
    await store().loadStl(stlFile(box()));
    expect(store().meshVer).toBe(before + 1);
  });

  it('plans and posts in one step', async () => {
    await store().loadStl(stlFile(turnedShaft(), 'shaft.stl'));
    const plan = await store().makePlan();
    expect(plan.mode).toBe('turn');
    expect(store().nc).toContain('M30');
    expect(store().nc).toContain('O0001 (SHAFT)'); // name comes off the file
    expect(store().status).toBe('ready');
  });

  it('re-plans when the material changes', async () => {
    await store().loadStl(stlFile(turnedShaft()));
    store().setOption({ material: 'aluminium' });
    const al = await store().makePlan();
    store().setOption({ material: 'titanium' });
    const ti = await store().makePlan();
    const vc = (p) => p.steps.find((s) => s.kind === 'rough').speeds.vc;
    expect(vc(ti)).toBeLessThan(vc(al));
  });

  it('honours a forced machine mode', async () => {
    await store().loadStl(stlFile(turnedShaft()));
    store().setOption({ forceMode: 'mill' });
    expect((await store().makePlan()).mode).toBe('mill');
  });

  it('drops the part-off operation when asked', async () => {
    await store().loadStl(stlFile(turnedShaft()));
    store().setOption({ partOff: false });
    const plan = await store().makePlan();
    expect(plan.steps.some((s) => s.kind === 'part')).toBe(false);
  });

  it('posts radius instead of diameter when the switch is off', async () => {
    await store().loadStl(stlFile(turnedShaft()));
    store().setOption({ diameterMode: false });
    await store().makePlan();
    expect(store().nc).toContain('(X IS RADIUS)');
  });

  it('surfaces a groove as an operation and a warning', async () => {
    await store().loadStl(stlFile(groovedShaft({
      radius: 15, length: 60, grooveZ: 30, grooveWidth: 4, grooveDepth: 3,
    })));
    const plan = await store().makePlan();
    expect(plan.steps.some((s) => s.kind === 'groove')).toBe(true);
    expect(plan.warnings.some((w) => /recess/i.test(w))).toBe(true);
  });

  it('reports an unreadable file instead of throwing', async () => {
    const bad = { name: 'broken.stl', arrayBuffer: async () => new ArrayBuffer(10) };
    const result = await store().loadStl(bad);
    expect(result).toBeNull();
    expect(store().status).toBe('error');
    expect(store().error).toBeTruthy();
    expect(getMesh().welded).toBeNull();
  });

  it('rejects an STL with no triangles', async () => {
    const empty = { name: 'empty.stl', arrayBuffer: async () => stlFileEmpty() };
    await store().loadStl(empty);
    expect(store().status).toBe('error');
    expect(store().error).toMatch(/no triangles/);
  });

  it('will not plan with nothing loaded', async () => {
    expect(await store().makePlan()).toBeNull();
  });

  it('produces a summary small enough for a commentary layer', async () => {
    await store().loadStl(stlFile(turnedShaft()));
    await store().makePlan();
    const summary = store().summary();
    expect(summary.steps.length).toBeGreaterThan(0);
    expect(JSON.stringify(summary).length).toBeLessThan(6000);
  });

  it('clears everything back to empty', async () => {
    await store().loadStl(stlFile(turnedShaft()));
    await store().makePlan();
    store().clear();
    expect(store().plan).toBeNull();
    expect(store().nc).toBeNull();
    expect(store().stlName).toBeNull();
    expect(getMesh().soup).toBeNull();
  });
});

function stlFileEmpty() {
  const buf = new ArrayBuffer(84);
  new DataView(buf).setUint32(80, 0, true);
  return buf;
}

describe('camPlanStore — work orientation', () => {
  beforeEach(() => { store().clear(); });

  it('shows the part laid down once a milling plan has laid it down', async () => {
    // The model and the toolpath must share one frame, or the viewport shows a
    // setup that is not the one being programmed.
    await store().loadStl(stlFile(box(18, 17, 67), 'fork.stl'));
    const before = store().analysis.bounds.size;
    expect(before[2]).toBeCloseTo(67, 3); // standing on end as modelled

    const plan = await store().makePlan();
    expect(plan.orientation.changed).toBe(true);
    // Both the reported analysis and the cached mesh follow the plan.
    expect(store().analysis.bounds.size[2]).toBeCloseTo(17, 2);
    const { boundsOf } = await import('../engine/mesh/analyze.js');
    expect(boundsOf(getMesh().soup).size[2]).toBeCloseTo(17, 2);
  });

  it('bumps meshVer so the viewport redraws in the new orientation', async () => {
    await store().loadStl(stlFile(box(18, 17, 67)));
    const before = store().meshVer;
    await store().makePlan();
    expect(store().meshVer).toBeGreaterThan(before);
  });

  it('leaves a part that already lies flat exactly where it was', async () => {
    await store().loadStl(stlFile(box(60, 40, 12)));
    const before = Array.from(getMesh().soup.positions.slice(0, 30));
    await store().makePlan();
    expect(Array.from(getMesh().soup.positions.slice(0, 30))).toEqual(before);
  });

  it('does not reorient a turned part', async () => {
    await store().loadStl(stlFile(turnedShaft()));
    const plan = await store().makePlan();
    expect(plan.mode).toBe('turn');
    expect(plan.orientation).toBeUndefined();
  });
});

describe('camPlanStore — landing on a page that can show the part', () => {
  beforeEach(() => {
    store().clear();
    useCamStore.setState({ page: 'sketch', mode: 'mill', gcode: '' });
  });

  it('leaves the Sketch page when an STL arrives', async () => {
    // The bug this guards: Sketch hides both the CAM panel and the 3D part, so
    // an STL dropped there imported successfully and changed nothing on screen.
    await store().loadStl(stlFile(box(60, 40, 12)));
    expect(useCamStore.getState().page).not.toBe('sketch');
  });

  it('lands a prismatic part on Milling', async () => {
    await store().loadStl(stlFile(box(60, 40, 12)));
    expect(useCamStore.getState().page).toBe('mill');
  });

  it('lands a solid of revolution on Turning', async () => {
    await store().loadStl(stlFile(turnedShaft()));
    expect(useCamStore.getState().page).toBe('turn');
  });

  it('does not move a user who already picked a machine', async () => {
    // Being on Milling is a choice; the panel's mode selector is the override.
    useCamStore.setState({ page: 'mill', mode: 'mill' });
    await store().loadStl(stlFile(turnedShaft()));
    expect(useCamStore.getState().page).toBe('mill');
  });

  it('stays put when the STL cannot be read', async () => {
    await store().loadStl({ name: 'broken.stl', arrayBuffer: async () => new ArrayBuffer(10) });
    expect(useCamStore.getState().page).toBe('sketch');
  });
});

describe('camPlanStore — the operator edits the plan', () => {
  beforeEach(async () => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'auto', material: 'aluminium' });
  });

  it('offers a recipe to edit as soon as it plans', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await store().makePlan();
    expect(store().recipe.length).toBeGreaterThan(0);
    expect(store().recipe.map((e) => e.key)).toEqual(store().plan.steps.map((s) => s.key));
  });

  it('rebuilds the program when a tool is swapped', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await store().makePlan();
    const before = store().nc;

    store().setStepTool('rough', 'em6');
    expect(store().plan.steps.find((s) => s.kind === 'rough').toolId).toBe('em6');
    // The posted NC moves with it — the table and the file cannot disagree.
    expect(store().nc).not.toBe(before);
    expect(store().status).toBe('ready');
  });

  it('drops a step from the program but keeps it in the recipe', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await store().makePlan();
    const rows = store().recipe.length;

    store().toggleStep('face', false);
    expect(store().recipe).toHaveLength(rows);
    expect(store().plan.steps.some((s) => s.kind === 'face')).toBe(false);

    store().toggleStep('face', true);
    expect(store().plan.steps[0].kind).toBe('face');
  });

  it('reorders, adds and removes operations', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await store().makePlan();

    store().moveStep('rough', -1);
    const kinds = store().plan.steps.map((s) => s.kind);
    expect(kinds.indexOf('rough')).toBeLessThan(kinds.indexOf('face'));

    store().removeStep('face');
    expect(store().plan.steps.some((s) => s.kind === 'face')).toBe(false);

    store().addStep('face');
    expect(store().plan.steps[0].kind).toBe('face');
  });

  it('puts the planner’s proposal back on reset', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await store().makePlan();
    const original = store().recipe.map((e) => e.toolId);

    store().setStepTool('rough', 'em2');
    store().removeStep('finish');
    store().resetRecipe();
    expect(store().recipe.map((e) => e.toolId)).toEqual(original);
  });

  it('lists the tools for a step, fits and misfits alike', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await store().makePlan();
    const choices = store().toolChoices('rough');
    expect(choices.length).toBeGreaterThan(3);
    expect(choices.some((c) => c.fits)).toBe(true);
    // Anything refused says why, so a greyed-out row is never a mystery.
    for (const c of choices.filter((x) => !x.fits)) expect(c.reason).toBeTruthy();
  });

  it('keeps the shop’s tool choice across a new part', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await store().makePlan();
    store().setStepTool('rough', 'em6');

    await store().loadStl(stlFile(box(80, 50, 20)));
    await store().makePlan();
    expect(store().recipe.find((e) => e.kind === 'rough').toolId).toBe('em6');
  });
});

describe('camPlanStore — choosing the machine', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'auto' });
  });

  it('changes the cutting data and names the machine in the NC', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await store().makePlan();

    store().setMachine('brother-s700');
    const fast = store().plan.steps.find((s) => s.kind === 'rough').speeds.rpm;
    expect(store().nc).toMatch(/MACHINE: BROTHER/);

    store().setMachine('knee-mill-cnc');
    const slow = store().plan.steps.find((s) => s.kind === 'rough').speeds.rpm;
    expect(slow).toBeLessThan(fast);
  });

  it('posts in the control’s own dialect', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await store().makePlan();

    store().setMachine('haas-vf2');
    expect(store().nc).toMatch(/^O00001 /m);   // five digits on a Haas
    store().setMachine('fanuc-generic-vmc');
    expect(store().nc).toMatch(/^O0001 /m);
  });

  it('picking a lathe turns the part', async () => {
    // The one routing decision geometry cannot make: is there a lathe here?
    await store().loadStl(stlFile(box(40, 40, 60)));
    await store().makePlan();
    expect(store().plan.mode).toBe('mill');

    store().setMachine('haas-st20');
    expect(store().plan.mode).toBe('turn');
    expect(store().forceMode).toBe('turn');
  });

  it('moves the machine when the process is chosen instead', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await store().makePlan();
    store().setMode('turn');
    expect(machineById(store().machineId).kind).toBe('turn');
    expect(store().plan.mode).toBe('turn');
  });

  it('follows the analysis onto a lathe when the mode is auto', async () => {
    await store().loadStl(stlFile(turnedShaft()));
    await store().makePlan();
    expect(store().plan.mode).toBe('turn');
    expect(machineById(store().machineId).kind).toBe('turn');
  });
});

describe('camPlanStore — picking geometry off the model', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'auto', material: 'aluminium' });
  });

  it('offers the faces and edges of the loaded part', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const { faces, edges } = store().features();
    expect(faces).toHaveLength(6);
    expect(edges.length).toBeGreaterThan(0);
    expect(faces.some((f) => f.facing === 'up')).toBe(true);
  });

  it('offers nothing to pick on a lathe job', async () => {
    await store().loadStl(stlFile(turnedShaft()));
    await store().makePlan();
    expect(store().features().faces).toEqual([]);
  });

  it('turns a picked face into an operation', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const top = store().features().faces.find((f) => f.facing === 'up');

    store().addFaceStep(top.id);
    const step = store().plan.steps.find((s) => s.kind === 'region');
    expect(step).toBeTruthy();
    expect(step.title).toMatch(/picked face/);
    expect(store().nc).toBeTruthy();
  });

  it('turns a picked edge into an operation', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const edge = store().features().edges[0];

    store().addEdgeStep(edge.id, { depth: 0.5 });
    const step = store().plan.steps.find((s) => s.kind === 'trace');
    expect(step).toBeTruthy();
    expect(step.why).toMatch(/0.5 mm deep/);
  });

  it('refuses a face the tool axis cannot reach, and says why', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const side = store().features().faces.find((f) => f.facing === 'front');

    store().addFaceStep(side.id);
    // The row is in the recipe — the operator asked for it — but it produced no
    // motion, and the reason is on screen rather than in a silent no-op.
    expect(store().recipe.some((e) => e.kind === 'region')).toBe(true);
    expect(store().plan.steps.some((s) => s.kind === 'region')).toBe(false);
    expect(store().plan.warnings.some((w) => /cannot be reached along the tool axis/.test(w))).toBe(true);
  });

  it('keys a picked step by feature id, so two faces are two steps', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const faces = store().features().faces.filter((f) => f.facing === 'up' || f.facing === 'down');

    store().addFaceStep(faces[0].id);
    store().addFaceStep(faces[1].id);
    const keys = store().recipe.filter((e) => e.kind === 'region').map((e) => e.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('drops a picked step when a part without that feature is loaded', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const top = store().features().faces.find((f) => f.facing === 'up');
    store().addFaceStep(top.id);
    expect(store().recipe.some((e) => e.kind === 'region')).toBe(true);

    // A lathe part has no pickable faces at all, so the step cannot survive.
    await store().loadStl(stlFile(turnedShaft()));
    await store().makePlan();
    expect(store().recipe.some((e) => e.kind === 'region')).toBe(false);
  });

  it('remembers what is selected, for the viewport to highlight', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    await store().makePlan();
    const top = store().features().faces.find((f) => f.facing === 'up');
    store().selectFeature(top);
    expect(store().selectedFeature.id).toBe(top.id);
    store().selectFeature(null);
    expect(store().selectedFeature).toBeNull();
  });
});

describe('camPlanStore — indexing the rotary', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({
      machineId: 'mazak-vcn530c-4th', forceMode: 'mill', material: 'aluminium', indexAngle: 0,
    });
  });

  it('adds new operations at the current index', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();

    store().setIndexAngle(180);
    store().addStep('rough');
    const flipped = store().plan.steps.find((s) => s.indexA === 180);
    expect(flipped).toBeTruthy();
    expect(store().nc).toMatch(/A180\./);
  });

  it('shows the faces that point up from the indexed side', async () => {
    // A 120 × 30 × 20 bar: the top is 120 × 30, and rolling it a quarter turn
    // presents the 120 × 20 side to the spindle instead. Which face is
    // machinable is a property of the setup, not of the model.
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    const flat = store().features().faces.find((f) => f.facing === 'up');
    expect(flat.area).toBeCloseTo(120 * 30, 1);

    store().setIndexAngle(90);
    const rolled = store().features().faces.find((f) => f.facing === 'up');
    expect(rolled.area).toBeCloseTo(120 * 20, 1);
  });

  it('clears the selection when the table turns', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().selectFeature(store().features().faces[0]);
    store().setIndexAngle(90);
    expect(store().selectedFeature).toBeNull();
  });
});
