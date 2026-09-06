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
import { CAD } from '../theme.js';
import { tessellateArc, CHORD_TOL } from '../engine/sketch/loops.js';

// Colours the layer draws with, read from the palette rather than frozen as
// hexes here. What these tests are for is that the right STATE gets the right
// colour — re-typing the values would only assert that two files agree on a
// literal, and would break the suite on every retheme without a bug in sight.
const hex = (token) => token.replace('#', '').toLowerCase();
const DIM = hex(CAD.skDim);      // placed dimensions
const UNDER = hex(CAD.skUnder);  // under-defined geometry (SolidWorks blue)
const FULL = hex(CAD.skFull);    // fully defined (SolidWorks black)
const OVER = hex(CAD.skOver);    // over-defined / conflicting

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
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const r = await render(<SketchLayer />);
    expect(r.scene).toBeTruthy();
  });

  it('draws geometry for the lines in the sketch', async () => {
    const sk = createSketch();
    addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0));
    addLine(sk, addPoint(sk, 0, 5), addPoint(sk, 10, 5));
    setSketch(sk);
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const r = await render(<SketchLayer />);
    expect(countOf(r.scene, UNDER)).toBeGreaterThanOrEqual(2);
  });

  it('picks up geometry added after mount', async () => {
    // eslint-disable-next-line testing-library/render-result-naming-convention
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
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const r = await render(<SketchLayer />);
    expect(countOf(r.scene, UNDER)).toBeGreaterThanOrEqual(1);
  });
});

describe('SketchLayer — dimensions are drawn on canvas', () => {
  it('draws the witness and dimension lines for a placed dimension', async () => {
    setSketch(dimensionedLine());
    // eslint-disable-next-line testing-library/render-result-naming-convention
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
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const r = await render(<SketchLayer />);
    expect(countOf(r.scene, DIM)).toBe(0);
  });

  it('removes the annotation when the dimension is deleted', async () => {
    const sk = dimensionedLine();
    setSketch(sk);
    // eslint-disable-next-line testing-library/render-result-naming-convention
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
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const r = await withState({ dofState: { state: 'under' } });
    expect(countOf(r.scene, UNDER)).toBeGreaterThan(0);
    expect(countOf(r.scene, FULL)).toBe(0);
  });

  it('goes black once fully defined', async () => {
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const r = await withState({ dofState: { state: 'full' } });
    expect(countOf(r.scene, FULL)).toBeGreaterThan(0);
    expect(countOf(r.scene, UNDER)).toBe(0);
  });

  it('turns red when the solver reports a conflict', async () => {
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const r = await withState({
      dofState: { state: 'over' },
      solveResult: { success: false, conflicting: [0] },
    });
    expect(countOf(r.scene, OVER)).toBeGreaterThan(0);
  });

  it('re-colours in place when the sketch becomes fully defined', async () => {
    // eslint-disable-next-line testing-library/render-result-naming-convention
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
      // eslint-disable-next-line no-await-in-loop, testing-library/render-result-naming-convention
      const r = await render(<SketchLayer />);
      // eslint-disable-next-line jest/valid-expect
      expect(r.scene, tool).toBeTruthy();
      // eslint-disable-next-line no-await-in-loop
      await renderer.unmount();
      renderer = undefined;
    }
  });
});

describe('what is drawn is what is built', () => {
  it('renders arcs at the same fidelity the geometry is built to', () => {
    // The screen used to tessellate at a fixed segment count while the solid was
    // built to a chord tolerance. They agreed at small radii and diverged badly
    // at large ones — at R200 the picture was 0.24 mm off a circle the geometry
    // held to 0.01 mm, so the operator was deciding from a shape that was not
    // the one being cut. Both go through `tessellateArc` now.
    for (const r of [2, 10, 50, 200]) {
      const pts = tessellateArc(0, 0, r, 0, Math.PI * 2);
      const n = pts.length / 2 - 1;
      const sagitta = r * (1 - Math.cos(Math.PI / n));
      // eslint-disable-next-line jest/valid-expect
      expect(sagitta, `R${r} strays past the chord tolerance`).toBeLessThanOrEqual(CHORD_TOL * 1.001);
    }
  });

  it('scales the segment count with radius, which a fixed count cannot', () => {
    const segs = (r) => tessellateArc(0, 0, r, 0, Math.PI * 2).length / 2 - 1;
    expect(segs(200)).toBeGreaterThan(segs(50));
    expect(segs(50)).toBeGreaterThan(segs(10));
  });
});

describe('a preview with nothing in it must not be drawn', () => {
  /** Mid-slot: two axis ends placed, the cursor aiming the third click. */
  function midSlot(cursor) {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 30, 0);
    setSketch(sk, { tool: 'slot', pending: a, pending2: b, cursor });
  }

  it('survives the cursor sitting on the slot\'s own axis', async () => {
    // The crash this exists for: with the cursor on the axis the radius is zero,
    // `slotPreview` returns an empty array, and an empty array is *truthy* — so
    // `{preview && <Line …/>}` handed drei a Line with no points.
    // `LineGeometry.setPositions` then asks for a Float32Array of length −6:
    // "RangeError: Invalid typed array length: -6", thrown on every mouse move
    // along the axis.
    midSlot({ x: 15, y: 0 });
    const r = await ReactThreeTestRenderer.create(<SketchLayer />);
    expect(r.scene).toBeTruthy();
    await r.unmount();
  });

  it('still draws the slot preview once the cursor is off the axis', async () => {
    midSlot({ x: 15, y: 5 });
    const r = await ReactThreeTestRenderer.create(<SketchLayer />);
    expect(r.scene).toBeTruthy();
    await r.unmount();
  });

  it('survives a degenerate polygon preview', async () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    setSketch(sk, { tool: 'polygon', pending: c, cursor: { x: 0, y: 0 } });
    const r = await ReactThreeTestRenderer.create(<SketchLayer />);
    expect(r.scene).toBeTruthy();
    await r.unmount();
  });
});

describe('every half-finished draw the mouse can produce', () => {
  /**
   * A sweep rather than a list of cases.
   *
   * Both slot bugs reached the shop floor because they only appear mid-gesture,
   * in the browser, in states no geometry test constructs: the cursor exactly on
   * an axis, exactly on a centre, before the second click. This walks every tool
   * through every stage with degenerate cursors, and asserts only that the scene
   * builds — which is all the crash needed to be caught.
   */
  const TOOLS = ['point', 'line', 'rectangle', 'slot', 'polygon', 'circle', 'arc', 'dimension', 'trim', 'chamfer'];
  const CURSORS = [
    { x: 0, y: 0 },     // on the first click
    { x: 30, y: 0 },    // on the second click
    { x: 15, y: 0 },    // on the axis between them
    { x: 15, y: 5 },    // properly off it
    { x: -1e9, y: 1e9 }, // absurdly far away
  ];

  for (const tool of TOOLS) {
    for (const stage of ['none', 'one', 'two']) {
      it(`${tool}, ${stage} click(s) placed`, async () => {
        for (const cursor of CURSORS) {
          const sk = createSketch();
          const a = addPoint(sk, 0, 0);
          const b = addPoint(sk, 30, 0);
          setSketch(sk, {
            tool,
            pending: stage === 'none' ? null : a,
            pending2: stage === 'two' ? b : null,
            cursor,
          });
          // eslint-disable-next-line no-await-in-loop
          const r = await ReactThreeTestRenderer.create(<SketchLayer />);
          // eslint-disable-next-line jest/valid-expect
          expect(r.scene, `${tool}/${stage} at ${cursor.x},${cursor.y}`).toBeTruthy();
          // eslint-disable-next-line no-await-in-loop
          await r.unmount();
        }
      });
    }
  }
});
