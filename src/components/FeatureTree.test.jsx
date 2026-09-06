/**
 * @vitest-environment jsdom
 *
 * The feature tree in the DOM — now a docked panel rather than a popover, so
 * these render it directly instead of opening a trigger.
 *
 * The geometry and the replay are proved in `engine/solid/featureTree.test.js`
 * and `stores/featureStore.test.js`. What cannot be seen from there is the panel
 * itself: a tree that does not say it is out of date, or a Rebuild button that
 * is not reachable, makes the whole thing look like it does not work.
 */
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import FeatureTree, { TREE_SIZE } from './FeatureTree.jsx';
import { useFeatureStore } from '../stores/featureStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { createSketch, addPoint, addLine } from '../engine/sketch/model.js';

let container;
let root;

function rectSketch(x0, y0, x1, y1) {
  const sk = createSketch();
  const p1 = addPoint(sk, x0, y0);
  const p2 = addPoint(sk, x1, y0);
  const p3 = addPoint(sk, x1, y1);
  const p4 = addPoint(sk, x0, y1);
  addLine(sk, p1, p2);
  addLine(sk, p2, p3);
  addLine(sk, p3, p4);
  addLine(sk, p4, p1);
  return sk;
}

/** Render the docked tree; returns its text. */
async function open() {
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => { root.render(React.createElement(FeatureTree)); });
  return document.body.textContent;
}

const click = async (el) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useFeatureStore.getState().clear();
  const doc = rectSketch(0, 0, 40, 40);
  useSketchStore.setState({
    sk: doc,
    sketches: [{
      id: 1, name: 'Base sketch', plane: { preset: 'XY', offset: 0 }, doc, past: [], future: [],
    }],
    activeId: 1,
    nextSketchId: 2,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('FeatureTreePanel', () => {
  it('says there is nothing yet, and how to start', async () => {
    const text = await open();
    expect(text).toMatch(/Nothing built yet/i);
    expect(document.querySelector('[data-feature-rebuild]').disabled).toBe(true);
  });

  it('lists each feature with what it does and which sketch it came from', async () => {
    useFeatureStore.getState().addFeature('extrude', {
      sketchId: 1, depth: 12, name: 'Plate',
    });
    const text = await open();
    expect(text).toMatch(/Plate/);
    expect(text).toMatch(/Extrude 12 mm/);
    expect(text).toMatch(/Base sketch/);
  });

  it('offers Rebuild and says the tree is out of date', async () => {
    useFeatureStore.getState().addFeature('extrude', { sketchId: 1, depth: 6 });
    const text = await open();
    expect(text).toMatch(/Out of date/i);
    expect(document.querySelector('[data-feature-rebuild]').disabled).toBe(false);
  });

  it('replays the tree when Rebuild is pressed, and stops saying it is stale', async () => {
    useFeatureStore.getState().addFeature('extrude', { sketchId: 1, depth: 6 });
    await open();
    await click(document.querySelector('[data-feature-rebuild]'));
    expect(useFeatureStore.getState().dirty).toBe(false);
    expect(useFeatureStore.getState().errors).toEqual([]);
  });

  it('edits a parameter through the panel and marks the tree stale again', async () => {
    // `addFeature` selects what it added, so the editor is already open —
    // clicking the row here would *de*select it.
    const f = useFeatureStore.getState().addFeature('extrude', { sketchId: 1, depth: 6 });
    expect(useFeatureStore.getState().selectedId).toBe(f.id);
    await open();

    // antd puts extra props on the `<input>` for a bare InputNumber and on a
    // wrapper when it carries an addon, so accept either.
    const host = document.querySelector('[data-feature-depth]');
    const input = host?.tagName === 'INPUT' ? host : host?.querySelector('input');
    expect(input).toBeTruthy();
    await act(async () => {
      // antd's InputNumber commits on blur/Enter, not on every keystroke.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '25');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(useFeatureStore.getState().features[0].depth).toBe(25);
    expect(useFeatureStore.getState().dirty).toBe(true);
  });

  it('suppresses a feature from the panel', async () => {
    const f = useFeatureStore.getState().addFeature('extrude', { sketchId: 1, depth: 6 });
    await open();
    await click(document.querySelector(`[data-feature-suppress="${f.id}"]`));
    expect(useFeatureStore.getState().features[0].suppressed).toBe(true);
  });

  it('shows the failure against the feature that could not build', async () => {
    useFeatureStore.getState().addFeature('extrude', {
      sketchId: 404, depth: 6, name: 'Broken',
    });
    await act(async () => { await useFeatureStore.getState().rebuild(); });
    const text = await open();
    expect(text).toMatch(/Broken: .*sketch is gone/i);
  });

  it('says an imported base cannot be edited here, rather than offering nothing', async () => {
    const base = useFeatureStore.getState().captureImport(
      { positions: new Float32Array(9), triangleCount: 1 }, 'plate.stl',
    );
    await open();
    await click(document.querySelector(`[data-feature-item="${base.id}"]`));
    expect(document.body.textContent).toMatch(/cannot be edited here/i);
  });
});

describe('the tree shows the model the way a CAD does', () => {
  /** Two sketches in the store, only the first used by a feature. */
  function withSketches() {
    const a = rectSketch(0, 0, 40, 40);
    const b = rectSketch(0, 0, 10, 10);
    useSketchStore.setState({
      sk: a,
      sketches: [
        { id: 1, name: 'Base sketch', plane: { preset: 'XY', offset: 0 }, doc: a, past: [], future: [] },
        { id: 2, name: 'Spare', plane: { preset: 'XZ', offset: 12 }, doc: b, past: [], future: [] },
      ],
      activeId: 1,
      nextSketchId: 3,
    });
  }

  it('hangs the sketch under the feature that was built from it', async () => {
    withSketches();
    useFeatureStore.getState().addFeature('extrude', { sketchId: 1, depth: 6, name: 'Plate' });
    const text = await open();
    expect(text).toMatch(/Plate/);
    expect(text).toMatch(/Base sketch/);
    // And it names the plane, so you can tell two sketches apart at a glance.
    expect(text).toMatch(/Top \(XY\)/);
    expect(document.querySelector('[data-tree-sketch="1"]')).toBeTruthy();
  });

  it('opens a sketch for editing when its node is clicked', async () => {
    // The reason sketches are in this tree at all: it is how you get back to
    // the geometry behind an operation.
    withSketches();
    useFeatureStore.getState().addFeature('extrude', { sketchId: 2, depth: 6 });
    await open();
    expect(useSketchStore.getState().activeId).toBe(1);
    await click(document.querySelector('[data-tree-sketch="2"]'));
    expect(useSketchStore.getState().activeId).toBe(2);
  });

  it('lists a sketch no feature uses, rather than hiding it', async () => {
    withSketches();
    useFeatureStore.getState().addFeature('extrude', { sketchId: 1, depth: 6 });
    const text = await open();
    expect(text).toMatch(/Not used by a feature/i);
    expect(text).toMatch(/Spare/);
  });

  it('folds a feature\'s sketch away and back', async () => {
    withSketches();
    const f = useFeatureStore.getState().addFeature('extrude', { sketchId: 1, depth: 6 });
    await open();
    expect(document.querySelector('[data-tree-sketch="1"]')).toBeTruthy();
    await click(document.querySelector(`[data-tree-expand="${f.id}"]`));
    expect(document.querySelector('[data-tree-sketch="1"]')).toBeNull();
    await click(document.querySelector(`[data-tree-expand="${f.id}"]`));
    expect(document.querySelector('[data-tree-sketch="1"]')).toBeTruthy();
  });

  it('collapses to a strip and comes back', async () => {
    // A viewport is small on a tablet; a permanent panel has to be surrenderable.
    withSketches();
    useFeatureStore.getState().addFeature('extrude', { sketchId: 1, depth: 6 });
    await open();
    expect(document.body.textContent).toMatch(/Feature tree/);
    await click(document.querySelector('[data-tree-toggle]'));
    expect(document.body.textContent).not.toMatch(/Feature tree/);
    await click(document.querySelector('[data-tree-toggle]'));
    expect(document.body.textContent).toMatch(/Feature tree/);
  });

  it('is a column, not something floating over the model', async () => {
    // It began as an overlay and needed `data-cam-overlay="left"` so the camera
    // fit would dodge it. It is a real `Sider` now: the canvas is genuinely
    // narrower, so declaring itself to the camera would make the fit reserve
    // that width **twice**.
    withSketches();
    await open();
    expect(document.querySelector('[data-cam-overlay="left"]')).toBeNull();
  });
});

describe('the tree and the sketch rail share a corner without overlapping', () => {
  it('publishes its open state so the rail can step aside', () => {
    // Both are absolutely positioned at the top-left of the viewport. They
    // overlapped until the rail learned where the tree ends.
    useFeatureStore.setState({ treeOpen: true });
    expect(useFeatureStore.getState().treeOpen).toBe(true);
    useFeatureStore.getState().setTreeOpen(false);
    expect(useFeatureStore.getState().treeOpen).toBe(false);
  });

  it('collapsing through the panel sets it, so the rail follows', async () => {
    useFeatureStore.setState({ treeOpen: true });
    await open();
    await click(document.querySelector('[data-tree-toggle]'));
    expect(useFeatureStore.getState().treeOpen).toBe(false);
  });

  it('names both widths once, for the rail to offset by', () => {
    expect(TREE_SIZE.TREE_W).toBeGreaterThan(TREE_SIZE.TREE_STRIP);
    expect(TREE_SIZE.TREE_STRIP).toBeGreaterThan(0);
  });
});
