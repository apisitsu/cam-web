import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { useCamPlanStore, getMesh, registerSketchSource } from './camPlanStore.js';
import { useCamStore } from './camStore.js';
import { turnedShaft, box, groovedShaft, tube } from '../engine/mesh/fixtures.js';
import { translate } from '../engine/mesh/datum.js';
import { circleAtPick } from '../engine/mesh/circlePick.js';
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
    expect(store().meshVer).toBeGreaterThan(before);
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

  it('lays the part down on import, before anything is planned', async () => {
    // The model and the toolpath must share one frame, or the viewport shows a
    // setup that is not the one being programmed. Since the operator now picks
    // faces straight after import, the frame has to be right by then — waiting
    // until a plan exists would have them picking faces off the wrong setup.
    await store().loadStl(stlFile(box(18, 17, 67), 'fork.stl'));
    expect(store().analysis.bounds.size[2]).toBeCloseTo(17, 2);
    const { boundsOf } = await import('../engine/mesh/analyze.js');
    expect(boundsOf(getMesh().soup).size[2]).toBeCloseTo(17, 2);

    // Every measurement re-derives from the mesh exactly as imported, never
    // from whatever the viewport currently shows — the operator still needs
    // to be told "lay it down this way" every time the plan is rebuilt, and a
    // datum change later must not compound on top of an already-laid-down
    // mesh. So the setup instruction keeps appearing, consistently, and the
    // depth it reports stays the true 17mm either way.
    const plan = await store().makePlan();
    expect(plan.orientation.changed).toBe(true);
    expect(plan.warnings[0]).toMatch(/^Setup:/);
    expect(plan.part.top - plan.part.bottom).toBeCloseTo(17, 2);
  });

  it('bumps meshVer when the import reorients the part', async () => {
    const before = store().meshVer;
    await store().loadStl(stlFile(box(18, 17, 67)));
    // Twice: once for the new mesh, once for laying it down.
    expect(store().meshVer).toBeGreaterThan(before + 1);
  });

  it('leaves a part that already lies flat exactly where it was', async () => {
    await store().loadStl(stlFile(box(60, 40, 12)));
    const before = Array.from(getMesh().soup.positions.slice(0, 30));
    await store().makePlan();
    expect(Array.from(getMesh().soup.positions.slice(0, 30))).toEqual(before);
  });

  it('does not bump meshVer for a part that needs no laying down', async () => {
    await store().loadStl(stlFile(box(60, 40, 12)));
    const before = store().meshVer;
    await store().makePlan();
    expect(store().meshVer).toBe(before);
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

    // No re-planning: importing reconciles the recipe against the new part, so
    // the shop's tool choice is simply still there.
    await store().loadStl(stlFile(box(80, 50, 20)));
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

describe('camPlanStore — the datum: where X0/Y0/Z0 physically is', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'auto', material: 'aluminium' });
  });

  it('does nothing until picked, so an untouched part behaves exactly as before', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    const plan = await store().makePlan();
    expect(plan.part.top).toBeCloseTo(7.5, 3);
    expect(plan.part.bottom).toBeCloseTo(-7.5, 3);
  });

  it('picking one axis zeros only that axis — the part is never reoriented', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    // Touch off Z on the +Z face — as a machinist would, one axis at a time.
    const datum = store().pickAxisOrigin(2, [0, 0, 7.5]);
    expect(datum.point).toEqual([0, 0, 7.5]);
    expect(datum.axesSet).toEqual([false, false, true]);

    const plan = await store().makePlan();
    // The picked point is now Z0, so the top face sits at Z0.
    expect(plan.part.top).toBeCloseTo(0, 3);
    expect(plan.part.bottom).toBeCloseTo(-15, 3);
  });

  it('a pick never overrides the automatic lay-down — no plane, no reorientation', async () => {
    // The whole point of per-axis picking: unlike the old face pick, touching
    // off an axis must leave the part laid down exactly as it was.
    await store().loadStl(stlFile(box(18, 17, 67), 'fork.stl'));
    const before = await store().makePlan();
    expect(before.orientation.changed).toBe(true); // laid the 17mm axis onto Z
    store().pickAxisOrigin(2, [0, 0, 0]);
    const after = await store().makePlan();
    expect(after.orientation.changed).toBe(true);
    // Same depth on Z as before — the orientation did not move.
    expect(after.part.top - after.part.bottom)
      .toBeCloseTo(before.part.top - before.part.bottom, 2);
  });

  it('setting one axis leaves the others where they are', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().setAxisOrigin(2, -7.5); // bottom face to Z0
    expect(store().datum.axesSet).toEqual([false, false, true]);
    const plan = await store().makePlan();
    expect(plan.part.bottom).toBeCloseTo(0, 3);
    expect(plan.part.top).toBeCloseTo(15, 3);
    // X and Y were never touched, so their displayed origin is still 0.
    expect(store().displayedDatumPoint()[0]).toBeCloseTo(0, 6);
    expect(store().displayedDatumPoint()[1]).toBeCloseTo(0, 6);
  });

  it('reports the current origin in the frame on screen', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    expect(store().displayedDatumPoint()).toBeNull();
    store().pickAxisOrigin(2, [0, 0, 7.5]);
    expect(store().displayedDatumPoint()).toEqual([0, 0, 7.5]);
  });

  it('picking the same axis spot twice lands in the same place, not compounded', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    // First pick: the top face, on screen at Z=7.5 (nothing shifted yet).
    store().pickAxisOrigin(2, [0, 0, 7.5]);
    // That spot is now Z0, so on screen it sits at Z=0 — picking Z there again
    // must recover the exact same raw point, not shift a second time.
    const datum = store().pickAxisOrigin(2, [0, 0, 0]);
    expect(datum.point).toEqual([0, 0, 7.5]);

    const plan = await store().makePlan();
    expect(plan.part.top).toBeCloseTo(0, 3);
    expect(plan.part.bottom).toBeCloseTo(-15, 3);
  });

  it('unlocking one axis releases it while the others stay set', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().setAxisOrigin(2, -7.5); // Z at the bottom
    store().setAxisOrigin(0, 30);   // X at one side
    expect(store().datum.axesSet).toEqual([true, false, true]);
    store().clearAxisOrigin(0);     // release X only
    expect(store().datum.axesSet).toEqual([false, false, true]);
    const plan = await store().makePlan();
    // Z is still zeroed at the bottom; X went back to native.
    expect(plan.part.bottom).toBeCloseTo(0, 3);
  });

  it('clears every axis back to the mesh as imported', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().pickAxisOrigin(2, [0, 0, 7.5]);
    store().clearDatum();
    expect(store().displayedDatumPoint()).toBeNull();
    expect(store().datum.axesSet).toEqual([false, false, false]);
    const plan = await store().makePlan();
    expect(plan.part.top).toBeCloseTo(7.5, 3);
    expect(plan.part.bottom).toBeCloseTo(-7.5, 3);
  });

  it('for turning, only shifts the axial origin — never reorients', async () => {
    await store().loadStl(stlFile(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 })));
    const before = await store().makePlan();
    // Zero Z at the far (right-hand) face instead of the modelled end.
    store().pickAxisOrigin(2, [0, 0, before.stock.zMax - 2]);
    const after = await store().makePlan();
    expect(after.orientation).toBeUndefined();
    expect(after.stock.zMax).toBeCloseTo(before.stock.zMax - (before.stock.zMax - 2), 2);
  });

  it('a new import drops the previous part\'s datum', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().pickAxisOrigin(2, [0, 0, 7.5]);
    await store().loadStl(stlFile(box(60, 40, 15), 'second.stl'));
    expect(store().displayedDatumPoint()).toBeNull();
    expect(store().datum.axesSet).toEqual([false, false, false]);
  });
});

describe('camPlanStore — flipping an axis', () => {
  const NONE = [false, false, false];

  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'auto', material: 'aluminium' });
  });

  it('is off by default, so an untouched part behaves exactly as before', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    expect(store().datum.flip).toEqual(NONE);
    const plan = await store().makePlan();
    expect(plan.orientation.flip).toBeUndefined();
  });

  it.each([
    [0, [true, true, false]],
    [1, [false, true, true]],
    [2, [true, false, true]],
  ])('axis %i toggles on as a 180° turn, reversing two axes', async (axis, expected) => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().toggleFlip(axis);
    expect(store().datum.flip).toEqual(expected);
    const plan = await store().makePlan();
    expect(plan.orientation.flip).toEqual(expected);
  });

  it('toggles back off', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().toggleFlip(0);
    store().toggleFlip(0);
    expect(store().datum.flip).toEqual(NONE);
  });

  it('composes correctly with an already-picked origin point', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().pickAxisOrigin(2, [0, 0, 7.5]);
    store().toggleFlip(0);
    const plan = await store().makePlan();
    // The pick already put the top face at Z0 — flipping X/Y about Z leaves
    // Z (and therefore this) untouched.
    expect(plan.part.top).toBeCloseTo(0, 3);
    expect(plan.part.bottom).toBeCloseTo(-15, 3);
  });

  it('flipping Z keeps the picked plane on Z0 and puts the part above it', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().pickAxisOrigin(2, [0, 0, 7.5]);
    store().toggleFlip(2);
    const plan = await store().makePlan();
    expect(plan.part.bottom).toBeCloseTo(0, 3);
    expect(plan.part.top).toBeCloseTo(15, 3);
  });

  it('a later pick lands where it was clicked on a flipped part', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().toggleFlip(1);
    store().pickAxisOrigin(2, [0, 0, 7.5]);
    const plan = await store().makePlan();
    expect(plan.part.top).toBeCloseTo(0, 3);
    expect(plan.part.bottom).toBeCloseTo(-15, 3);
  });

  it('clearing the datum drops the flip too', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().toggleFlip(2);
    store().clearDatum();
    expect(store().datum.flip).toEqual(NONE);
  });

  it('is dropped when a new part is imported', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().toggleFlip(0);
    await store().loadStl(stlFile(box(60, 40, 15), 'second.stl'));
    expect(store().datum.flip).toEqual(NONE);
  });
});

describe('camPlanStore — picking a flat face turns it square to the axis', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'mill', material: 'aluminium' });
  });

  // A part laid along X, like a bushing: its end faces are on +X and -X.
  const longPart = async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
  };

  it('stands the part up on the end face picked for Z0', async () => {
    await longPart();
    const plan0 = store().plan;
    expect(plan0.part.top - plan0.part.bottom).toBeCloseTo(20, 3);
    store().pickAxisOrigin(2, [60, 0, 0], [1, 0, 0]);
    const plan = await store().makePlan();
    expect(plan.part.top).toBeCloseTo(0, 3);
    expect(plan.part.bottom).toBeCloseTo(-120, 3);
    expect(store().datum.axesSet).toEqual([false, false, true]);
  });

  it('can still be flipped afterwards, with that face staying on Z0', async () => {
    await longPart();
    store().pickAxisOrigin(2, [60, 0, 0], [1, 0, 0]);
    store().toggleFlip(2);
    const plan = await store().makePlan();
    expect(plan.part.bottom).toBeCloseTo(0, 3);
    expect(plan.part.top).toBeCloseTo(120, 3);
  });

  it('squaring a second face to another axis leaves the part standing', async () => {
    await longPart();
    store().pickAxisOrigin(2, [60, 0, 0], [1, 0, 0]);
    // Standing up, the raw +Y side still faces +Y; bring it round to +X.
    store().pickAxisOrigin(0, [0, 15, -60], [0, 1, 0]);
    const plan = await store().makePlan();
    expect(plan.part.top).toBeCloseTo(0, 3);
    expect(plan.part.bottom).toBeCloseTo(-120, 3);
    expect(store().datum.axesSet).toEqual([true, false, true]);
  });

  it('only sets the origin on a face already square to that axis', async () => {
    await longPart();
    const before = store().meshVer;
    store().pickAxisOrigin(2, [0, 0, 10], [0, 0, 1]);
    expect(store().datum.axes).toBeNull();
    const plan = await store().makePlan();
    expect(plan.part.top).toBeCloseTo(0, 3);
    expect(store().meshVer).toBeGreaterThan(before);
  });

  it('only sets the origin on a curved surface', async () => {
    await longPart();
    store().pickAxisOrigin(2, [0, 10, 5], [0, 0.7071, 0.7071]);
    expect(store().datum.axes).toBeNull();
    const plan = await store().makePlan();
    expect(plan.part.top).toBeCloseTo(5, 3);
  });

  it('is undone by clearing the origin', async () => {
    await longPart();
    store().pickAxisOrigin(2, [60, 0, 0], [1, 0, 0]);
    store().clearDatum();
    const plan = await store().makePlan();
    expect(plan.part.top - plan.part.bottom).toBeCloseTo(20, 3);
  });

  it('leaves a part with an A0 face set as it is', async () => {
    await longPart();
    store().pickRotaryZero([0, 0, 1]);
    store().pickAxisOrigin(2, [60, 0, 0], [1, 0, 0]);
    expect(store().datum.axes).toBeNull();
  });

  it('does not turn a lathe job', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    useCamPlanStore.setState({ forceMode: 'turn' });
    store().prepare();
    store().pickAxisOrigin(2, [60, 0, 0], [1, 0, 0]);
    expect(store().datum.axes).toBeNull();
  });
});

describe('camPlanStore — turning the part 90°', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'mill', material: 'aluminium' });
  });

  it('keeps X0/Y0 on the bore while the part turns about Z', async () => {
    await store().loadStl(stlFile(translate(tube(20, 10, 30), [-5, -7, 0])));
    await store().makePlan();
    store().pickCircleCenter([15, 7, 15], [-1, 0, 0]);
    store().turnPart(2);
    // The bore is on the Z axis through the origin, whichever way the part faces.
    const c = circleAtPick(getMesh().welded, [10, 0, 15], [-1, 0, 0]);
    expect(c.center[0]).toBeCloseTo(0, 2);
    expect(c.center[1]).toBeCloseTo(0, 2);
    expect(store().datum.axesSet).toEqual([true, true, false]);
  });

  it('swaps the other two extents and rebuilds the plan', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().turnPart(1);
    const plan = await store().makePlan();
    expect(plan.part.top - plan.part.bottom).toBeCloseTo(120, 3);
  });

  it('is undone by clearing the origin', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().turnPart(1);
    store().clearDatum();
    const plan = await store().makePlan();
    expect(plan.part.top - plan.part.bottom).toBeCloseTo(20, 3);
  });

  it('leaves a part with an A0 face set as it is', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().pickRotaryZero([0, 0, 1]);
    expect(store().turnPart(2)).toBeNull();
    expect(store().datum.axes).toBeNull();
  });

  it('does nothing on a lathe job', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    useCamPlanStore.setState({ forceMode: 'turn' });
    store().prepare();
    expect(store().turnPart(2)).toBeNull();
  });
});

describe('camPlanStore — origin at the centre of a circle', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'mill', material: 'aluminium' });
  });

  // Bore and boss on the Z axis through (5, 7), from z = 0 to z = 30.
  const offCentreTube = async () => {
    await store().loadStl(stlFile(translate(tube(20, 10, 30), [-5, -7, 0])));
    await store().makePlan();
  };

  it('puts X0 and Y0 on the centre and leaves Z alone', async () => {
    await offCentreTube();
    store().startPickCircle();
    store().pickCircleCenter([15, 7, 15], [-1, 0, 0]);
    const shown = store().displayedDatumPoint();
    expect(shown[0]).toBeCloseTo(5, 2);
    expect(shown[1]).toBeCloseTo(7, 2);
    expect(shown[2]).toBeCloseTo(0, 3);
    expect(store().datum.axesSet).toEqual([true, true, false]);
    expect(store().datumPickMode).toBeNull();
  });

  it('lands on the same centre when picked again from the shifted part', async () => {
    await offCentreTube();
    store().pickCircleCenter([15, 7, 15], [-1, 0, 0]);
    store().pickCircleCenter([10, 0, 15], [-1, 0, 0]);
    const shown = store().displayedDatumPoint();
    expect(shown[0]).toBeCloseTo(5, 2);
    expect(shown[1]).toBeCloseTo(7, 2);
  });

  it('keeps a Z already set', async () => {
    await offCentreTube();
    store().pickAxisOrigin(2, [15, 7, 30], [0, 0, 1]);
    store().pickCircleCenter([15, 7, -15], [-1, 0, 0]);
    expect(store().displayedDatumPoint()[2]).toBeCloseTo(30, 2);
    expect(store().datum.axesSet).toEqual([true, true, true]);
  });

  it('takes the circle on show, whatever surface the click landed on', async () => {
    await offCentreTube();
    store().startPickCircle();
    useCamPlanStore.setState({
      datumHover: { id: 'c', circle: { axis: 2, center: [5, 7, 15], radius: 10 } },
    });
    store().pickCircleCenter();
    const shown = store().displayedDatumPoint();
    expect(shown[0]).toBeCloseTo(5, 3);
    expect(shown[1]).toBeCloseTo(7, 3);
    expect(store().datumPickMode).toBeNull();
    expect(store().datumHover).toBeNull();
  });

  it('stays armed and says so when there is no circle', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    await store().makePlan();
    store().startPickCircle();
    expect(store().pickCircleCenter([0, 0, 7.5], [0, 0, 1])).toBeNull();
    expect(store().datumPickMode).toBe('circle');
    expect(store().datumPickHint).toMatch(/No circle/);
    expect(store().datum.point).toBeNull();
  });
});

describe('camPlanStore — offset from the picked plane', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'auto', material: 'aluminium' });
  });

  const pickedTop = async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().pickAxisOrigin(2, [0, 0, 7.5]);
  };

  it('puts Z0 that far above the picked top face, so the face reads minus the distance', async () => {
    await pickedTop();
    store().setAxisOffset(2, 0.5);
    const plan = await store().makePlan();
    expect(plan.part.top).toBeCloseTo(-0.5, 3);
    expect(store().displayedDatumOffset()[2]).toBeCloseTo(0.5);
    expect(store().displayedDatumPoint()[2]).toBeCloseTo(8, 3);
  });

  it('does not stack when the distance is edited', async () => {
    await pickedTop();
    store().setAxisOffset(2, 0.5);
    store().setAxisOffset(2, 2);
    const plan = await store().makePlan();
    expect(plan.part.top).toBeCloseTo(-2, 3);
  });

  it('carries over to a new pick, whichever was done first', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().setAxisOffset(2, 0.5);
    store().pickAxisOrigin(2, [0, 0, 7]);
    const plan = await store().makePlan();
    // The click is measured on the part as drawn, 0.5 shifted: the true top is
    // at 7 there, and Z0 goes 0.5 above that.
    expect(plan.part.top).toBeCloseTo(-0.5, 3);
  });

  it('locks the axis, and leaves the others free', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    store().setAxisOffset(0, 1);
    expect(store().datum.axesSet).toEqual([true, false, false]);
  });

  it('is replaced by a typed absolute value', async () => {
    await pickedTop();
    store().setAxisOffset(2, 0.5);
    store().setAxisOrigin(2, 4);
    expect(store().displayedDatumOffset()[2]).toBeCloseTo(0);
    expect(store().displayedDatumPoint()[2]).toBeCloseTo(4, 3);
  });

  it('is released with the axis', async () => {
    await pickedTop();
    store().setAxisOffset(2, 0.5);
    store().clearAxisOrigin(2);
    expect(store().datum.point).toBeNull();
    expect(store().displayedDatumOffset()[2]).toBeCloseTo(0);
  });

  it('stays on the same physical spot when the part is flipped', async () => {
    await pickedTop();
    store().setAxisOffset(2, 0.5);
    store().toggleFlip(2);
    const plan = await store().makePlan();
    // Z0 is still 0.5 clear of that face; the part now lies above it, on +Z.
    expect(plan.part.bottom).toBeCloseTo(0.5, 3);
    expect(plan.part.top).toBeCloseTo(15.5, 3);
    expect(store().displayedDatumOffset()[2]).toBeCloseTo(-0.5);
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

describe('camPlanStore — where the physical A-axis passes through', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({
      machineId: 'mazak-vcn530c-4th', forceMode: 'mill', material: 'aluminium', indexAngle: 0,
    });
  });

  it('defaults to null — indexing about the frame origin, as before this existed', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    expect(store().displayedRotaryCenter()).toBeNull();
  });

  it('a click sets it — only Y/Z matter, the plane/point origin is untouched', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    const before = store().datum.point;

    store().pickRotaryCenter([0, 15, 0]);
    expect(store().displayedRotaryCenter()).toEqual([15, 0]);
    expect(store().datum.point).toBe(before);
    expect(store().datumPickMode).toBeNull();
  });

  it('a typed Y/Z updates it without needing a click', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().setRotaryCenter([15, 0]);
    expect(store().displayedRotaryCenter()).toEqual([15, 0]);
  });

  it('shifts where an indexed operation is measured from', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().setIndexAngle(90);
    const atOrigin = store().features().faces.find((f) => f.facing === 'up');

    store().pickRotaryCenter([0, 15, 0]);
    const atCentre = store().features().faces.find((f) => f.facing === 'up');

    // Rolling 90° about an off-axis pivot moves the whole part, so the face
    // now facing up sits at a different height than pivoting on the origin —
    // same 120×20 face, different Z.
    expect(atCentre.area).toBeCloseTo(atOrigin.area, 1);
    expect(atCentre.centroid[2]).not.toBeCloseTo(atOrigin.centroid[2], 1);
  });

  it('clears back to the frame origin', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().pickRotaryCenter([0, 15, 0]);
    store().clearRotaryCenter();
    expect(store().displayedRotaryCenter()).toBeNull();
  });

  it('is dropped when a new part is imported', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().pickRotaryCenter([0, 15, 0]);
    await store().loadStl(stlFile(box(120, 30, 20), 'second.stl'));
    expect(store().displayedRotaryCenter()).toBeNull();
  });
});

describe('camPlanStore — which face reads as A0', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({
      machineId: 'mazak-vcn530c-4th', forceMode: 'mill', material: 'aluminium', indexAngle: 0,
    });
  });

  it('defaults to null — the modelled face stays at A0, as before this existed', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    expect(store().rotaryZeroAngle()).toBeNull();
  });

  it('a click on a side face turns the part so that face reads as A0', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    const before = store().datum.point;

    // The +Y face, not the current top — a part rarely arrives modelled with
    // the desired face already facing the spindle.
    const datum = store().pickRotaryZero([0, 1, 0]);
    expect(datum.rotaryZero).toEqual([0, 1, 0]);
    expect(store().rotaryZeroAngle()).toBeCloseTo(270, 3);
    expect(store().datum.point).toBe(before);
    expect(store().datumPickMode).toBeNull();

    // A0 itself (indexAngle 0, no indexing at all) must already show that
    // face up — not just a later index angle relative to the old zero. The
    // picked +Y face spans X and Z (120 × 20), not X and the old Y (120 × 30)
    // — rotating it onto +Z doesn't change its own area.
    const upNow = store().features().faces.find((f) => f.facing === 'up');
    expect(upNow.area).toBeCloseTo(120 * 20, 1);
  });

  it('does not disturb an already-picked rotary centre or origin', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().pickRotaryCenter([0, 15, 0]);
    store().pickAxisOrigin(2, [0, 0, 10]);

    store().pickRotaryZero([0, 1, 0]);
    expect(store().displayedRotaryCenter()).not.toBeNull();
    expect(store().displayedDatumPoint()).not.toBeNull();
  });

  it('clears back to the modelled orientation', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().pickRotaryZero([0, 1, 0]);
    store().clearRotaryZero();
    expect(store().rotaryZeroAngle()).toBeNull();
  });

  it('is dropped when a new part is imported', async () => {
    await store().loadStl(stlFile(box(120, 30, 20)));
    await store().makePlan();
    store().pickRotaryZero([0, 1, 0]);
    await store().loadStl(stlFile(box(120, 30, 20), 'second.stl'));
    expect(store().rotaryZeroAngle()).toBeNull();
  });
});

describe('camPlanStore — the workflow starts at the part, not at a plan', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'auto', material: 'aluminium' });
  });

  it('makes the geometry pickable the moment the part is imported', async () => {
    // The point of the change: no "analyse & plan" gate between importing a
    // part and being able to point at it.
    await store().loadStl(stlFile(box(60, 40, 20)));
    expect(store().plan).toBeNull();
    expect(store().recipe).toEqual([]);
    expect(store().features().faces).toHaveLength(6);
  });

  it('decides nothing on import', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    expect(store().recipe).toEqual([]);
    expect(store().nc).toBeNull();
  });

  it('builds a program from one picked face, with no plan ever made', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    const top = store().features().faces.find((f) => f.facing === 'up');

    store().addFaceStep(top.id);
    expect(store().plan.steps).toHaveLength(1);
    expect(store().plan.steps[0].kind).toBe('region');
    expect(store().nc).toContain('M30');
  });

  it('keeps picked operations when the machine changes', async () => {
    // Changing machine re-measures; it must not throw away what was picked.
    await store().loadStl(stlFile(box(60, 40, 20)));
    const top = store().features().faces.find((f) => f.facing === 'up');
    store().addFaceStep(top.id);

    store().setMachine('brother-s700');
    expect(store().plan.steps.some((s) => s.kind === 'region')).toBe(true);
    expect(store().nc).toMatch(/MACHINE: BROTHER/);
  });

  it('auto-plan replaces the recipe, and only when asked', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    const top = store().features().faces.find((f) => f.facing === 'up');
    store().addFaceStep(top.id);
    expect(store().recipe).toHaveLength(1);

    await store().makePlan();
    expect(store().recipe.length).toBeGreaterThan(1);
    expect(store().recipe.some((e) => e.kind === 'region')).toBe(false);
  });

  it('separates the sticky pick from the passing hover', async () => {
    // Hovering the list is how you find a face; it must not look like picking
    // one, and it must not undo the one you picked.
    await store().loadStl(stlFile(box(60, 40, 20)));
    const [a, b] = store().features().faces;

    store().previewFeatureAt(a);
    expect(store().highlightedFeature().id).toBe(a.id);
    expect(store().selectedFeature).toBeNull();

    store().selectFeature(a);
    store().previewFeatureAt(b);
    expect(store().highlightedFeature().id).toBe(a.id);
  });

  it('clears the pick when the same feature is clicked again', async () => {
    await store().loadStl(stlFile(box(60, 40, 20)));
    const face = store().features().faces[0];
    store().selectFeature(face);
    store().selectFeature({ ...face });
    expect(store().selectedFeature).toBeNull();
  });
});

describe('camPlanStore — part formats other than STL', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'auto', material: 'aluminium' });
  });

  /** The same box as an OBJ file-alike. */
  function objFile(name = 'part.obj') {
    const text = [
      'v -30 -20 -10', 'v 30 -20 -10', 'v 30 20 -10', 'v -30 20 -10',
      'v -30 -20 10', 'v 30 -20 10', 'v 30 20 10', 'v -30 20 10',
      'f 1 3 2', 'f 1 4 3', 'f 5 6 7', 'f 5 7 8',
      'f 1 2 6', 'f 1 6 5', 'f 2 3 7', 'f 2 7 6',
      'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8',
    ].join('\n');
    const buf = new TextEncoder().encode(text).buffer;
    return { name, arrayBuffer: async () => buf };
  }

  it('imports an OBJ and plans it exactly like an STL', async () => {
    const analysis = await store().loadPart(objFile());
    expect(analysis).toBeTruthy();
    expect(store().partFormat).toBe('obj');
    expect(analysis.bounds.size[0]).toBeCloseTo(60, 3);
    // ...and everything downstream is unaware it was ever an OBJ.
    expect(store().features().faces).toHaveLength(6);
    const top = store().features().faces.find((f) => f.facing === 'up');
    store().addFaceStep(top.id);
    expect(store().nc).toContain('M30');
  });

  it('names the output after the part, whatever the extension was', async () => {
    await store().loadPart(objFile('bracket.obj'));
    const top = store().features().faces.find((f) => f.facing === 'up');
    store().addFaceStep(top.id);
    expect(store().nc).toMatch(/\(BRACKET\)/);
  });

  it('still answers to the old name', async () => {
    // Anything still calling loadStl keeps working.
    expect(await store().loadStl(objFile())).toBeTruthy();
  });

  it('refuses a format it cannot read, and says which it can', async () => {
    const buf = new TextEncoder().encode('ISO-10303-21;').buffer;
    await store().loadPart({ name: 'assembly.step', arrayBuffer: async () => buf });
    expect(store().status).toBe('error');
    expect(store().error).toMatch(/\.step is not a part format/);
    expect(store().error).toMatch(/\.stl/);
  });
});

describe('camPlanStore — saving and restoring the whole setup', () => {
  beforeEach(() => {
    store().clear();
    useCamPlanStore.setState({ machineId: DEFAULT_MILL_ID, forceMode: 'auto', material: 'aluminium' });
  });

  it('serializes nothing when there is no part', () => {
    expect(store().serializeSetup()).toBeNull();
  });

  it('round-trips machine, material, origin and operations through save/restore', async () => {
    // Build a real setup: import, choose machine + material, touch off Z, plan.
    await store().loadStl(stlFile(box(60, 40, 15), 'bracket.stl'));
    store().setMachine('haas-vf2');
    store().setOption({ material: 'steel' });
    store().setAxisOrigin(2, -7.5); // Z0 at the bottom face
    await store().makePlan();

    const setup = store().serializeSetup();
    expect(setup.part.name).toBe('bracket.stl');
    expect(setup.settings.machineId).toBe('haas-vf2');
    expect(setup.settings.material).toBe('steel');
    const savedRecipeLen = store().recipe.length;
    expect(savedRecipeLen).toBeGreaterThan(0);

    // Wipe everything, as a fresh page would be, then restore.
    store().clear();
    expect(store().stlName).toBeNull();
    expect(store().serializeSetup()).toBeNull();

    const mode = store().restoreSetup(setup);
    expect(mode).toBe('mill');
    expect(store().stlName).toBe('bracket.stl');
    expect(store().machineId).toBe('haas-vf2');
    expect(store().material).toBe('steel');
    expect(store().datum.axesSet).toEqual([false, false, true]);
    // The part came back, and the origin still puts the bottom at Z0.
    expect(store().recipe.length).toBe(savedRecipeLen);
    expect(store().plan).toBeTruthy();
    expect(store().plan.part.bottom).toBeCloseTo(0, 3);
    expect(store().nc).toContain('%'); // a posted program exists again
    // The restored mesh matches the original triangle count.
    expect(getMesh().soup.triangleCount).toBe(12);
  });

  it('restores the exact vertices, so the datum lands in the same place', async () => {
    await store().loadStl(stlFile(box(60, 40, 15)));
    const before = Array.from(getMesh().soup.positions);
    const setup = store().serializeSetup();
    store().clear();
    store().restoreSetup(setup);
    expect(Array.from(getMesh().soup.positions)).toEqual(before);
  });

  it('leaves the current state untouched when the project carried no part', async () => {
    await store().loadStl(stlFile(box(30, 20, 10), 'keep.stl'));
    store().restoreSetup(null);
    expect(store().stlName).toBe('keep.stl'); // not wiped
    store().restoreSetup({ settings: {} }); // a cam block with no part
    expect(store().stlName).toBe('keep.stl');
  });

  it('reports an error rather than throwing on a corrupt part buffer', () => {
    const mode = store().restoreSetup({ part: { name: 'x', positions: '!!!not-base64!!!', triangleCount: 1 } });
    // Either it decodes to garbage that weld survives, or it errors — but it
    // must never throw out of the store. A null return with an error status is
    // the contract.
    // eslint-disable-next-line jest/no-conditional-expect
    if (mode === null) expect(store().status).toBe('error');
  });
});

describe('camPlanStore — checking the cut, and steps from a sketch', () => {
  beforeEach(() => { store().clear(); });
  afterEach(() => { registerSketchSource(() => []); });

  const checked = () => vi.waitFor(() => expect(store().verification).not.toBeNull());

  it('checks every plan against the part, just after it is made', async () => {
    await store().loadStl(stlFile(box(30, 20, 10)));
    await store().makePlan();
    await checked();
    expect(store().verification.ok).toBe(true);
    expect(store().verification.gouge.cells).toBe(0);
  });

  it('pockets a sketch, and the check says the model has no such pocket', async () => {
    // The box is centred: its top face is Z5.
    registerSketchSource(() => [{
      id: 5, name: 'Slot', plane: { preset: 'XY', offset: 5 }, regions: [{ outer: [-6, -4, 6, -4, 6, 4, -6, 4] }],
    }]);
    await store().loadStl(stlFile(box(30, 20, 10)));
    expect(store().sketchList()).toEqual([{ id: 5, name: 'Slot', closed: true }]);
    await store().addSketchStep('pocket', 5, { depth: 2 });
    expect(store().plan.steps.map((s) => s.kind)).toEqual(['pocket']);
    await checked();
    expect(store().verification.ok).toBe(false);
    expect(store().verification.gouge.max).toBeCloseTo(2, 1);
  });

  it('cuts the sketch as it is now when the plan is rebuilt', async () => {
    let width = 6;
    registerSketchSource(() => [{
      id: 5, name: 'Slot', plane: { preset: 'XY', offset: 5 }, regions: [{ outer: [-width, -4, width, -4, width, 4, -width, 4] }],
    }]);
    await store().loadStl(stlFile(box(30, 20, 10)));
    await store().addSketchStep('pocket', 5, { depth: 2 });
    const reach = () => Math.max(...store().plan.operations[0].moves.map((m) => Math.abs(m.x)));
    const before = reach();
    width = 10;
    store().rebuild();
    expect(reach()).toBeCloseTo(before + 4, 3);
  });

  it('offers every milling operation to Manual Toolpath, sketch steps included', async () => {
    await store().loadStl(stlFile(box(30, 20, 10)));
    const kinds = store().addableKinds().map((k) => k.kind);
    expect(kinds).toEqual(expect.arrayContaining(['face', 'drill', 'tap', 'pocket', 'profile', 'region', 'trace']));
  });

  it('says what a hole operation can be aimed at, and when the part has none', async () => {
    await store().loadStl(stlFile(box(30, 20, 10)));
    expect(store().targetChoices('rough')).toBeNull();
    expect(store().targetChoices('tap')).toEqual([]);
    expect(store().targetChoices('drill')).toEqual([]);
  });
});
