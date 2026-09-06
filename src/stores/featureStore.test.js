import {
  describe, it, expect, beforeEach, vi,
} from 'vitest';
import {
  useFeatureStore, TREE_W_DEFAULT, TREE_W_MIN, TREE_W_MAX,
} from './featureStore.js';
import { useSketchStore } from './sketchStore.js';
import { useCamPlanStore, getMesh } from './camPlanStore.js';
import { addPoint, addLine, createSketch } from '../engine/sketch/model.js';

const features = () => useFeatureStore.getState();
const sketch = () => useSketchStore.getState();
const cam = () => useCamPlanStore.getState();

/** Add a closed rectangle to a sketch document. */
function addRect(sk, x0, y0, x1, y1) {
  const p1 = addPoint(sk, x0, y0);
  const p2 = addPoint(sk, x1, y0);
  const p3 = addPoint(sk, x1, y1);
  const p4 = addPoint(sk, x0, y1);
  addLine(sk, p1, p2);
  addLine(sk, p2, p3);
  addLine(sk, p3, p4);
  addLine(sk, p4, p1);
}

/** Reset both stores and give back a sketch id holding `rect`. */
function withSketches(specs) {
  const docs = specs.map(([x0, y0, x1, y1]) => {
    const sk = createSketch();
    addRect(sk, x0, y0, x1, y1);
    return sk;
  });
  useSketchStore.setState({
    sk: docs[0],
    sketches: docs.map((doc, i) => ({
      id: i + 1, name: `Sketch${i + 1}`, plane: { preset: 'XY', offset: 0 }, doc, past: [], future: [],
    })),
    activeId: 1,
    nextSketchId: docs.length + 1,
    past: [],
    future: [],
    error: null,
  });
  return docs;
}

beforeEach(() => {
  features().clear();
  withSketches([[0, 0, 40, 40]]);
});

describe('the docked column width', () => {
  beforeEach(() => { useFeatureStore.setState({ treeWidth: TREE_W_DEFAULT }); });

  it('starts at the default', () => {
    expect(features().treeWidth).toBe(TREE_W_DEFAULT);
  });

  it('clamps a drag past either end', () => {
    features().setTreeWidth(10000);
    expect(features().treeWidth).toBe(TREE_W_MAX);
    features().setTreeWidth(-50);
    expect(features().treeWidth).toBe(TREE_W_MIN);
  });

  it('rounds to a whole pixel', () => {
    features().setTreeWidth(457.6);
    expect(features().treeWidth).toBe(458);
  });
});

describe('editing the tree', () => {
  it('adds a feature, selects it and marks the tree stale', () => {
    const f = features().addFeature('extrude', { sketchId: 1, depth: 6 });
    expect(features().features).toHaveLength(1);
    expect(features().selectedId).toBe(f.id);
    expect(features().dirty).toBe(true);
  });

  it('updates a parameter without disturbing the rest', () => {
    const f = features().addFeature('extrude', { sketchId: 1, depth: 6, name: 'Base' });
    expect(features().updateFeature(f.id, { depth: 12 })).toBe(true);
    const got = features().features[0];
    expect(got).toMatchObject({ depth: 12, name: 'Base', sketchId: 1, id: f.id });
  });

  it('refuses a patch that would put a field the replay cannot read into a feature', () => {
    const f = features().addFeature('extrude', { sketchId: 1 });
    features().updateFeature(f.id, { merge: 'squish', nonsense: 1 });
    expect(features().features[0].merge).toBe('new');
    expect(features().features[0].nonsense).toBeUndefined();
  });

  it('removes a feature, and says so when there is none to remove', () => {
    const f = features().addFeature('extrude', { sketchId: 1 });
    expect(features().removeFeature(f.id)).toBe(true);
    expect(features().features).toHaveLength(0);
    expect(features().removeFeature(999)).toBe(false);
  });

  it('reorders, and refuses to move past either end', () => {
    const a = features().addFeature('extrude', { sketchId: 1, name: 'A' });
    const b = features().addFeature('extrude', { sketchId: 1, name: 'B' });
    expect(features().moveFeature(b.id, -1)).toBe(true);
    expect(features().features.map((f) => f.name)).toEqual(['B', 'A']);
    expect(features().moveFeature(b.id, -1)).toBe(false);
    expect(features().moveFeature(a.id, 1)).toBe(false);
  });

  it('toggles suppression both ways', () => {
    const f = features().addFeature('extrude', { sketchId: 1 });
    features().toggleSuppress(f.id);
    expect(features().features[0].suppressed).toBe(true);
    features().toggleSuppress(f.id);
    expect(features().features[0].suppressed).toBe(false);
  });
});

describe('rebuild', () => {
  it('puts the replayed solid on the machine', async () => {
    features().addFeature('extrude', { sketchId: 1, depth: 6 });
    const analysis = await features().rebuild();
    expect(analysis).toBeTruthy();
    expect(features().dirty).toBe(false);
    expect(features().errors).toEqual([]);
    expect(cam().status).toBe('ready');
    expect(analysis.volume).toBeCloseTo(40 * 40 * 6, 2);
  });

  it('follows a parameter change — the whole point', async () => {
    const f = features().addFeature('extrude', { sketchId: 1, depth: 6 });
    await features().rebuild();
    features().updateFeature(f.id, { depth: 12 });
    expect(features().dirty).toBe(true);
    const analysis = await features().rebuild();
    expect(analysis.volume).toBeCloseTo(40 * 40 * 12, 2);
  });

  it('follows an edit to the sketch itself', async () => {
    features().addFeature('extrude', { sketchId: 1, depth: 5 });
    await features().rebuild();
    // Redraw the sketch bigger, the way an operator would.
    const doc = createSketch();
    addRect(doc, 0, 0, 80, 40);
    useSketchStore.setState({ sketches: sketch().sketches.map((s) => ({ ...s, doc })), sk: doc });
    const analysis = await features().rebuild();
    expect(analysis.volume).toBeCloseTo(80 * 40 * 5, 2);
  });

  it('cuts one feature out of another', async () => {
    withSketches([[0, 0, 40, 40], [15, 15, 25, 25]]);
    features().addFeature('extrude', { sketchId: 1, depth: 10 });
    features().addFeature('extrude', {
      sketchId: 2, depth: 30, base: -10, merge: 'cut',
    });
    const analysis = await features().rebuild();
    expect(features().errors).toEqual([]);
    expect(analysis.volume).toBeCloseTo(16000 - 1000, 1);
  });

  it('keeps the datum across a rebuild — it is the same part, recomputed', async () => {
    features().addFeature('extrude', { sketchId: 1, depth: 6 });
    await features().rebuild();
    // Set an origin the way the operator would, then rebuild.
    cam().pickAxisOrigin(2, [0, 0, 6]);
    const datumBefore = cam().datum;
    expect(datumBefore.point).toBeTruthy();
    await features().rebuild();
    expect(cam().datum.point).toEqual(datumBefore.point);
  });

  it('reports a broken feature and keeps the rest of the part', async () => {
    withSketches([[0, 0, 40, 40]]);
    features().addFeature('extrude', { sketchId: 1, depth: 10 });
    features().addFeature('extrude', { sketchId: 404, depth: 5, merge: 'cut', name: 'Pocket' });
    const analysis = await features().rebuild();
    expect(features().errors).toHaveLength(1);
    expect(features().errors[0].name).toBe('Pocket');
    expect(analysis.volume).toBeCloseTo(16000, 1);
  });

  it('records a step per feature, suppressed ones included', async () => {
    withSketches([[0, 0, 40, 40], [15, 15, 25, 25]]);
    features().addFeature('extrude', { sketchId: 1, depth: 10 });
    const cut = features().addFeature('extrude', {
      sketchId: 2, depth: 30, base: -10, merge: 'cut',
    });
    features().toggleSuppress(cut.id);
    const analysis = await features().rebuild();
    expect(features().steps).toHaveLength(2);
    expect(features().steps[1].suppressed).toBe(true);
    expect(analysis.volume).toBeCloseTo(16000, 1); // the cut did not happen
  });

  it('does nothing for an empty tree, and clears the stale flag', async () => {
    features().markDirty();
    expect(await features().rebuild()).toBeNull();
    expect(features().dirty).toBe(false);
  });
});

describe('dirty tracking', () => {
  it('goes stale when a sketch under the tree changes', () => {
    features().addFeature('extrude', { sketchId: 1, depth: 6 });
    useFeatureStore.setState({ dirty: false });
    // Any sketch mutation bumps `version`, which is what the subscription reads.
    addRect(sketch().sk, 50, 50, 60, 60);
    sketch()._bump();
    expect(features().dirty).toBe(true);
  });

  it('stays quiet while there is no tree to invalidate', () => {
    features().clear();
    sketch()._bump();
    expect(features().dirty).toBe(false);
  });
});

describe('the imported mesh as the base of the tree', () => {
  /**
   * A real 40×40×10 soup, built by the app's own extruder — so the boolean
   * below has something with genuine topology to cut into rather than a stub.
   */
  async function plateSoup() {
    withSketches([[0, 0, 40, 40]]);
    features().addFeature('extrude', { sketchId: 1, depth: 10 });
    await features().rebuild();
    return useCamPlanStore.getState().analysis && getMesh().soup;
  }

  it('cuts a sketch feature out of a mesh that arrived as a file', async () => {
    const soup = await plateSoup();
    features().clear();

    // The same soup, now standing in for one an STL was read into.
    withSketches([[15, 15, 25, 25]]);
    const base = features().captureImport(soup, 'plate.stl');
    expect(base.kind).toBe('import');
    expect(features().features[0].id).toBe(base.id);

    features().addFeature('extrude', {
      sketchId: 1, depth: 30, base: -10, merge: 'cut', name: 'Pocket',
    });
    const analysis = await features().rebuild();
    expect(features().errors).toEqual([]);
    expect(analysis.volume).toBeCloseTo(16000 - 1000, 1);
  });

  it('replaces an earlier import — a second file is a different job', () => {
    const a = features().captureImport({ positions: new Float32Array(9), triangleCount: 1 }, 'a.stl');
    const b = features().captureImport({ positions: new Float32Array(9), triangleCount: 1 }, 'b.stl');
    expect(features().features.filter((f) => f.kind === 'import')).toHaveLength(1);
    expect(features().features[0].id).toBe(b.id);
    expect(features().importSoup(a)).toBeNull();
  });

  it('keeps the features that were built on top of it', () => {
    features().addFeature('extrude', { sketchId: 1, depth: 5, name: 'Pocket' });
    features().captureImport({ positions: new Float32Array(9), triangleCount: 1 }, 'a.stl');
    expect(features().features.map((f) => f.kind)).toEqual(['import', 'extrude']);
  });

  it('ignores an empty mesh', () => {
    expect(features().captureImport(null, 'x.stl')).toBeNull();
    expect(features().features).toHaveLength(0);
  });
});

describe('serialize / load', () => {
  it('round-trips the tree', () => {
    features().addFeature('extrude', { sketchId: 1, depth: 6, name: 'Base' });
    features().addFeature('extrude', {
      sketchId: 1, depth: 3, merge: 'cut', name: 'Pocket', suppressed: true,
    });
    const saved = JSON.parse(JSON.stringify(features().serialize()));
    features().clear();
    expect(features().load(saved)).toBe(true);
    expect(features().features).toHaveLength(2);
    expect(features().features[1]).toMatchObject({
      name: 'Pocket', merge: 'cut', suppressed: true, depth: 3,
    });
  });

  it('re-points a loaded import feature at the part the file restored', () => {
    const soup = { positions: new Float32Array(9), triangleCount: 1 };
    features().captureImport(soup, 'a.stl');
    const saved = JSON.parse(JSON.stringify(features().serialize()));
    features().clear();
    features().load(saved, soup);
    expect(features().importSoup(features().features[0])).toBe(soup);
  });

  it('comes back stale, because nothing has been rebuilt from it yet', () => {
    features().addFeature('extrude', { sketchId: 1 });
    const saved = JSON.parse(JSON.stringify(features().serialize()));
    features().clear();
    features().load(saved);
    expect(features().dirty).toBe(true);
  });

  it('treats a project with no tree as no tree', () => {
    expect(features().load(null)).toBe(false);
    expect(features().features).toHaveLength(0);
  });

  it('hands the next new feature an id that cannot collide with a loaded one', () => {
    features().load([{ kind: 'extrude', id: 900, sketchId: 1 }]);
    expect(features().addFeature('extrude', { sketchId: 1 }).id).toBeGreaterThan(900);
  });
});

describe('a rebuild that goes wrong reports rather than rejects', () => {
  it('says so when the solid boolean chunk cannot be loaded', async () => {
    // The boolean is a lazily-loaded chunk, so it can fail for a reason nothing
    // on the page did: the file not reaching the host, or the network dropping.
    // Unhandled, that surfaced as a rejected promise and no message at all.
    vi.resetModules();
    vi.doMock('../lib/csg.js', () => { throw new Error('Loading chunk 799 failed'); });
    const { useFeatureStore: fresh } = await import('./featureStore.js');
    const { useSketchStore: freshSketch } = await import('./sketchStore.js');

    const doc = createSketch();
    addRect(doc, 0, 0, 40, 40);
    const doc2 = createSketch();
    addRect(doc2, 10, 10, 20, 20);
    freshSketch.setState({
      sk: doc,
      sketches: [
        { id: 1, name: 'A', plane: { preset: 'XY', offset: 0 }, doc, past: [], future: [] },
        { id: 2, name: 'B', plane: { preset: 'XY', offset: 0 }, doc: doc2, past: [], future: [] },
      ],
      activeId: 1,
    });
    fresh.getState().clear();
    fresh.getState().addFeature('extrude', { sketchId: 1, depth: 10 });
    fresh.getState().addFeature('extrude', { sketchId: 2, depth: 30, base: -10, merge: 'cut' });

    // The point: this resolves rather than rejecting.
    await expect(fresh.getState().rebuild()).resolves.toBeNull();
    expect(fresh.getState().errors[0].message).toMatch(/Could not load the solid boolean/i);
    expect(fresh.getState().building).toBe(false);
    expect(fresh.getState().dirty).toBe(true); // still needs replaying
    vi.doUnmock('../lib/csg.js');
    vi.resetModules();
  });

  it('leaves `building` false after a failure, so the button is not stuck', async () => {
    features().clear();
    features().addFeature('extrude', { sketchId: 404, depth: 5 });
    await features().rebuild();
    expect(features().building).toBe(false);
  });
});
