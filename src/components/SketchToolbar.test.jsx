/**
 * @vitest-environment jsdom
 *
 * Render-gate tests for the sketch toolbar. These exist because of a real bug:
 * picking two circles for a fillet rendered **nothing at all** — no input, no
 * message — so the tool simply looked broken. That is invisible to the pure
 * geometry tests and to the scene-graph tests; it needs the DOM.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import SketchToolbar from './SketchToolbar.jsx';
import { useSketchStore } from '../stores/sketchStore.js';
import {
  createSketch, addPoint, addLine, addCircle, addArc, addConstraint,
} from '../engine/sketch/model.js';

let container;
let root;

/** Render the toolbar against a given store state and return the page text. */
async function renderWith(patch) {
  useSketchStore.setState({
    selection: [], tool: 'select', chamferKind: 'C',
    dimensionPending: null, editingConstraint: null, offsetPending: false,
    dofState: null, solveResult: null, error: null, past: [], future: [],
    version: (useSketchStore.getState().version ?? 0) + 1,
    ...patch,
  });
  await act(async () => {
    root.render(React.createElement(SketchToolbar));
  });
  return container.textContent;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useSketchStore.setState({ sk: createSketch() });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('SketchToolbar — the rail is always there', () => {
  it('renders a button for every drawing tool plus the actions', async () => {
    await renderWith({});
    // The rail is icon-only, so it carries no text — count the buttons instead.
    // 9 tools + construction/mirror/offset + solve/undo/redo/delete + popovers.
    expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(16);
  });

  it('marks the active tool as selected', async () => {
    await renderWith({ tool: 'circle' });
    expect(container.querySelector('.ant-btn-primary')).toBeTruthy();
  });
});

describe('SketchToolbar — chamfer / fillet input gate', () => {
  /** A sketch with two lines meeting at a corner. */
  const corner = () => {
    const sk = createSketch();
    const o = addPoint(sk, 0, 0);
    const l1 = addLine(sk, o, addPoint(sk, 10, 0));
    const l2 = addLine(sk, o, addPoint(sk, 0, 10));
    return { sk, l1, l2 };
  };
  /** Two circles that cross. */
  const twoCircles = () => {
    const sk = createSketch();
    const c1 = addCircle(sk, addPoint(sk, 0, 0), 50);
    const c2 = addCircle(sk, addPoint(sk, 80, 0), 50);
    return { sk, c1, c2 };
  };

  it('offers C/R for two lines', async () => {
    const { sk, l1, l2 } = corner();
    const text = await renderWith({ sk, tool: 'chamfer', selection: [l1, l2] });
    expect(text).toContain('Chamfer');
  });

  it('forces fillet when a curve is involved', async () => {
    const sk = createSketch();
    const o = addPoint(sk, 0, 0);
    const line = addLine(sk, o, addPoint(sk, 10, 0));
    const arc = addArc(sk, addPoint(sk, 10, 10), o, addPoint(sk, 20, 10), 10);
    const text = await renderWith({ sk, tool: 'chamfer', selection: [line, arc] });
    expect(text).toContain('Fillet');
  });

  it('offers the fillet input for two whole circles instead of rendering nothing', async () => {
    // The regression: this used to return null, so picking two circles produced
    // no UI whatsoever and the tool looked broken.
    const { sk, c1, c2 } = twoCircles();
    const text = await renderWith({ sk, tool: 'chamfer', selection: [c1, c2] });
    expect(text).toContain('Fillet');
    expect(text).not.toBe('');
  });

  it('explains why a circle paired with a line needs trimming first', async () => {
    const sk = createSketch();
    const circle = addCircle(sk, addPoint(sk, 0, 0), 50);
    const line = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 90, 0));
    const text = await renderWith({ sk, tool: 'chamfer', selection: [circle, line] });
    expect(text).toMatch(/[Tt]rim/);
  });

  it('shows nothing when the chamfer tool has an unusable selection', async () => {
    const { sk, l1 } = corner();
    const text = await renderWith({ sk, tool: 'chamfer', selection: [l1] });
    expect(text).not.toContain('Fillet');
  });

  it('shows nothing when the tool is not chamfer, whatever is selected', async () => {
    const { sk, c1, c2 } = twoCircles();
    const text = await renderWith({ sk, tool: 'select', selection: [c1, c2] });
    expect(text).not.toContain('Fillet');
  });
});

describe('SketchToolbar — inline inputs appear only when armed', () => {
  it('shows the dimension input when a dimension is pending', async () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    const text = await renderWith({
      sk,
      dimensionPending: { kind: 'distance', refs: [a, b], label: 'Distance', current: 10, axial: true },
    });
    expect(text).toContain('Distance');
  });

  it('offers the aligned / dX / dY toggle for an axial dimension', async () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 4);
    const text = await renderWith({
      sk,
      dimensionPending: { kind: 'distance', refs: [a, b], label: 'Distance', current: 10.8, axial: true },
    });
    // The inline input labels the three orientations with glyphs.
    expect(text).toContain('⤢'); // aligned
    expect(text).toContain('↔'); // dX
    expect(text).toContain('↕'); // dY
  });

  it('hides that toggle for a dimension with no axial variant', async () => {
    const sk = createSketch();
    const c = addCircle(sk, addPoint(sk, 0, 0), 5);
    const text = await renderWith({
      sk,
      dimensionPending: { kind: 'diameter', refs: [c], label: 'Diameter', current: 10 },
    });
    expect(text).toContain('Diameter');
    expect(text).not.toContain('↔');
  });

  it('shows the offset input only once armed', async () => {
    const sk = createSketch();
    addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0));
    expect(await renderWith({ sk })).not.toContain('Offset');
    expect(await renderWith({ sk, offsetPending: true })).toContain('Offset');
  });

  it('shows the edit box for a dimension being edited', async () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    addConstraint(sk, 'distance', [a, b], 10);
    const text = await renderWith({
      sk,
      editingConstraint: { index: 0, kind: 'distance', label: 'Distance', value: 10, angular: false },
    });
    expect(text).toContain('Distance');
  });
});

describe('SketchToolbar — status readout', () => {
  it('shows the free degrees of freedom while under-defined', async () => {
    const sk = createSketch();
    const text = await renderWith({ sk, dofState: { state: 'under', free: 4 } });
    expect(text).toContain('4');
  });

  it('shows a tick once the sketch is fully defined', async () => {
    const sk = createSketch();
    const text = await renderWith({ sk, dofState: { state: 'full', free: 0 } });
    expect(text).toContain('✓');
  });

  it('flags a failed solve', async () => {
    const sk = createSketch();
    const text = await renderWith({ sk, solveResult: { success: false, status: 2 } });
    expect(text).toContain('!');
  });

  it('flags an error (the message itself lives in the tooltip)', async () => {
    const sk = createSketch();
    const text = await renderWith({ sk, error: 'R5 is too large to fit that corner' });
    expect(text).toContain('?');
  });

  it('shows no status flags when everything is clean', async () => {
    const text = await renderWith({ sk: createSketch() });
    expect(text).not.toContain('!');
    expect(text).not.toContain('?');
  });
});
