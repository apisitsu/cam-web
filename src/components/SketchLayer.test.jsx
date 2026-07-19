/**
 * @vitest-environment jsdom
 *
 * Scene-graph tests for the sketch layer. `@react-three/test-renderer` builds the
 * real R3F scene without WebGL, so these check what the component actually puts
 * on screen — how many lines, in what colour — which the pure geometry tests
 * cannot see. (drei's `<Html>` labels portal out of the scene graph and are not
 * visible here; their content is covered by `annotations.test.js`.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ReactThreeTestRenderer from '@react-three/test-renderer';
import SketchLayer from './SketchLayer.jsx';
import { useSketchStore } from '../stores/sketchStore.js';
import {
  createSketch, addPoint, addLine, addCircle, addConstraint,
} from '../engine/sketch/model.js';

// Colours the layer draws with, from SketchLayer's palette.
const DIM = 'facc15';        // placed dimensions
const UNDER = '38bdf8';      // under-defined geometry (SolidWorks blue)
const FULL = 'd1d5db';       // fully defined
const OVER = 'fb7185';       // over-defined / conflicting

/** Put a sketch into the store the way the app would, without a worker. */
function setSketch(sk, patch = {}) {
  useSketchStore.setState({
    sk,
    version: (useSketchStore.getState().version ?? 0) + 1,
    selection: [], tool: 'select', hoverId: null,
    dimensionPending: null, editingConstraint: null,
    snap: null, axisSnap: null, pending: null, pending2: null,
    dofState: null, solveResult: null, error: null,
    ...patch,
  });
}

/** Every material colour in the rendered scene, as hex strings. */
function colours(root) {
  const out = [];
  const walk = (n) => {
    const c = n.instance?.material?.color;
    if (c) out.push(c.getHexString());
    (n.children ?? []).forEach(walk);
  };
  walk(root);
  return out;
}
const countOf = (root, hex) => colours(root).filter((c) => c === hex).length;

let renderer;
const render = async (el) => {
  renderer = await ReactThreeTestRenderer.create(el);
  return renderer;
};
const update = (fn) => ReactThreeTestRenderer.act(async () => fn());

/** A line with a distance dimension on it. */
function dimensionedLine() {
  const sk = createSketch();
  const a = addPoint(sk, 0, 0);
  const b = addPoint(sk, 10, 0);
  addLine(sk, a, b);
  addConstraint(sk, 'distance', [a, b], 10);
  return sk;
}

beforeEach(() => setSketch(createSketch()));
afterEach(async () => {
  await renderer?.unmount();
  renderer = undefined;
});

describe('SketchLayer renders the sketch', () => {
  it('mounts an empty sketch without throwing', async () => {
    const r = await render(<SketchLayer />);
    expect(r.scene).toBeTruthy();
  });

  it('draws geometry for the lines in the sketch', async () => {
    const sk = createSketch();
    addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0));
    addLine(sk, addPoint(sk, 0, 5), addPoint(sk, 10, 5));
    setSketch(sk);
    const r = await render(<SketchLayer />);
    expect(countOf(r.scene, UNDER)).toBeGreaterThanOrEqual(2);
  });

  it('picks up geometry added after mount', async () => {
    const r = await render(<SketchLayer />);
    const before = countOf(r.scene, UNDER);
    const sk = createSketch();
    for (let i = 0; i < 4; i++) addLine(sk, addPoint(sk, 0, i), addPoint(sk, 10, i));
    await update(() => setSketch(sk));
    expect(countOf(r.scene, UNDER)).toBeGreaterThan(before);
  });

  it('renders circles as well as lines', async () => {
    const sk = createSketch();
    addCircle(sk, addPoint(sk, 0, 0), 10);
    setSketch(sk);
    const r = await render(<SketchLayer />);
    expect(countOf(r.scene, UNDER)).toBeGreaterThanOrEqual(1);
  });
});

describe('SketchLayer — dimensions are drawn on canvas', () => {
  it('draws the witness and dimension lines for a placed dimension', async () => {
    setSketch(dimensionedLine());
    const r = await render(<SketchLayer />);
    // Two witness lines plus the dimension line itself.
    expect(countOf(r.scene, DIM)).toBe(3);
  });

  it('draws nothing extra for a relation that carries no value', async () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    addLine(sk, a, b);
    addConstraint(sk, 'horizontal', [a, b]);
    setSketch(sk);
    const r = await render(<SketchLayer />);
    expect(countOf(r.scene, DIM)).toBe(0);
  });

  it('removes the annotation when the dimension is deleted', async () => {
    const sk = dimensionedLine();
    setSketch(sk);
    const r = await render(<SketchLayer />);
    expect(countOf(r.scene, DIM)).toBe(3);
    sk.constraints.length = 0;
    await update(() => setSketch(sk));
    expect(countOf(r.scene, DIM)).toBe(0);
  });
});

describe('SketchLayer — solve-state colouring (SolidWorks blue → black)', () => {
  // This is a render decision: the pure layer knows the DOF state, but only the
  // component turns it into a colour.
  const withState = async (patch) => {
    const sk = createSketch();
    addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0));
    setSketch(sk, patch);
    return render(<SketchLayer />);
  };

  it('is blue while under-defined', async () => {
    const r = await withState({ dofState: { state: 'under' } });
    expect(countOf(r.scene, UNDER)).toBeGreaterThan(0);
    expect(countOf(r.scene, FULL)).toBe(0);
  });

  it('goes light grey once fully defined', async () => {
    const r = await withState({ dofState: { state: 'full' } });
    expect(countOf(r.scene, FULL)).toBeGreaterThan(0);
    expect(countOf(r.scene, UNDER)).toBe(0);
  });

  it('turns rose when the solver reports a conflict', async () => {
    const r = await withState({
      dofState: { state: 'over' },
      solveResult: { success: false, conflicting: [0] },
    });
    expect(countOf(r.scene, OVER)).toBeGreaterThan(0);
  });

  it('re-colours in place when the sketch becomes fully defined', async () => {
    const r = await withState({ dofState: { state: 'under' } });
    expect(countOf(r.scene, UNDER)).toBeGreaterThan(0);
    await update(() => useSketchStore.setState({
      dofState: { state: 'full' },
      version: useSketchStore.getState().version + 1,
    }));
    expect(countOf(r.scene, FULL)).toBeGreaterThan(0);
    expect(countOf(r.scene, UNDER)).toBe(0);
  });
});

describe('SketchLayer — tool modes', () => {
  it('mounts in every drawing tool without throwing', async () => {
    for (const tool of ['select', 'point', 'line', 'rectangle', 'circle', 'arc', 'dimension', 'trim', 'chamfer']) {
      const sk = createSketch();
      addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0));
      setSketch(sk, { tool });
      // eslint-disable-next-line no-await-in-loop
      const r = await render(<SketchLayer />);
      expect(r.scene, tool).toBeTruthy();
      // eslint-disable-next-line no-await-in-loop
      await renderer.unmount();
      renderer = undefined;
    }
  });
});
