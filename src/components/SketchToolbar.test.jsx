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
// Where the docked Ribbon is drawn. It is deliberately NOT inside `container`:
// the rail's own labels ("Fillet", "Offset"…) would otherwise be in the page text,
// and the gate tests below read that text to tell whether an *overlay* appeared.
let slot;

/** Render the toolbar against a given store state and return the overlay text (the Ribbon is in `slot`). */
async function renderWith(patch) {
  useSketchStore.setState({
    selection: [], tool: 'select', chamferKind: 'C',
    dimensionPending: null, editingConstraint: null, offsetPending: false,
    dofState: null, solveResult: null, error: null, past: [], future: [],
    version: (useSketchStore.getState().version ?? 0) + 1,
    ...patch,
  });
  // eslint-disable-next-line testing-library/no-unnecessary-act
  await act(async () => {
    root.render(React.createElement(SketchToolbar, { ribbonSlot: slot }));
  });
  return container.textContent;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  slot = document.createElement('div');
  document.body.appendChild(slot);
  root = createRoot(container);
  useSketchStore.setState({ sk: createSketch(), sketchOpen: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  slot.remove();
});

describe('SketchToolbar — the rail is always there', () => {
  it('renders a button for every drawing tool plus the actions', async () => {
    await renderWith({});
    // 11 tools + construction/mirror/offset + relations/solve/undo/redo/delete + popovers.
    expect(slot.querySelectorAll('button').length).toBeGreaterThanOrEqual(16);
  });

  it('marks the active tool as selected', async () => {
    await renderWith({ tool: 'circle' });
    expect(slot.querySelector('.ant-btn-primary')).toBeTruthy();
  });
});

describe('SketchToolbar — docked as the Ribbon', () => {
  it('draws the rail into the slot it is given, not over the viewport', async () => {
    await renderWith({});
    expect(slot.querySelector('[data-sketch-ribbon]')).toBeTruthy();
    expect(container.querySelector('[data-sketch-ribbon]')).toBeNull();
    // Docked, it covers no viewport, so it must not claim to be an overlay the
    // camera fit has to avoid.
    expect(slot.querySelector('[data-cam-overlay]')).toBeNull();
  });

  it('writes the name under every button — the point of the Ribbon', async () => {
    await renderWith({});
    const labels = [...slot.querySelectorAll('[data-ribbon-button]')].map((b) => b.getAttribute('data-ribbon-button'));
    for (const name of ['Select', 'Line', 'Rectangle', 'Circle', 'Arc', 'Dimension', 'Trim',
      'Construction', 'Mirror', 'Offset', 'Relations', 'Solve', 'Undo', 'Redo', 'Delete',
      'Sketches', 'Build']) {
      // eslint-disable-next-line jest/valid-expect
      expect(labels, name).toContain(name);
    }
    // Saving, opening, DXF and the library all live in the File menu.
    expect(labels).not.toContain('Library');
    expect(labels).not.toContain('More');
    // The visible text is the name, so the accessible name is too.
    const line = slot.querySelector('[data-ribbon-button="Line"]');
    expect(line.textContent).toBe('Line');
  });

  it('still floats over the viewport, as an overlay, when there is no slot to dock in', async () => {
    useSketchStore.setState({ sk: createSketch(), tool: 'select', selection: [] });
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => { root.render(React.createElement(SketchToolbar)); });
    expect(container.querySelector('[data-cam-overlay="top"]')).toBeTruthy();
    expect(container.querySelector('[data-sketch-ribbon]')).toBeNull();
  });

  it('keeps a button working through the portal', async () => {
    await renderWith({ tool: 'select' });
    await act(async () => {
      slot.querySelector('[data-ribbon-button="Circle"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useSketchStore.getState().tool).toBe('circle');
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
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const text = await renderWith({ sk, tool: 'chamfer', selection: [l1, l2] });
    expect(text).toContain('Chamfer');
  });

  it('forces fillet when a curve is involved', async () => {
    const sk = createSketch();
    const o = addPoint(sk, 0, 0);
    const line = addLine(sk, o, addPoint(sk, 10, 0));
    const arc = addArc(sk, addPoint(sk, 10, 10), o, addPoint(sk, 20, 10), 10);
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const text = await renderWith({ sk, tool: 'chamfer', selection: [line, arc] });
    expect(text).toContain('Fillet');
  });

  it('offers the fillet input for two whole circles instead of rendering nothing', async () => {
    // The regression: this used to return null, so picking two circles produced
    // no UI whatsoever and the tool looked broken.
    const { sk, c1, c2 } = twoCircles();
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const text = await renderWith({ sk, tool: 'chamfer', selection: [c1, c2] });
    expect(text).toContain('Fillet');
    expect(text).not.toBe('');
  });

  it('explains why a circle paired with a line needs trimming first', async () => {
    const sk = createSketch();
    const circle = addCircle(sk, addPoint(sk, 0, 0), 50);
    const line = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 90, 0));
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const text = await renderWith({ sk, tool: 'chamfer', selection: [circle, line] });
    expect(text).toMatch(/[Tt]rim/);
  });

  it('shows nothing when the chamfer tool has an unusable selection', async () => {
    const { sk, l1 } = corner();
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const text = await renderWith({ sk, tool: 'chamfer', selection: [l1] });
    expect(text).not.toContain('Fillet');
  });

  it('shows nothing when the tool is not chamfer, whatever is selected', async () => {
    const { sk, c1, c2 } = twoCircles();
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const text = await renderWith({ sk, tool: 'select', selection: [c1, c2] });
    expect(text).not.toContain('Fillet');
  });
});

describe('SketchToolbar — inline inputs appear only when armed', () => {
  it('shows the dimension input when a dimension is pending', async () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    // eslint-disable-next-line testing-library/render-result-naming-convention
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
    // eslint-disable-next-line testing-library/render-result-naming-convention
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
    // eslint-disable-next-line testing-library/render-result-naming-convention
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
    // eslint-disable-next-line testing-library/render-result-naming-convention
    const text = await renderWith({
      sk,
      editingConstraint: { index: 0, kind: 'distance', label: 'Distance', value: 10, angular: false },
    });
    expect(text).toContain('Distance');
  });
});

// The status tags are the tail of the rail, so they are in the Ribbon's slot, not
// in the overlay text `renderWith` returns. (The labels in the slot contain no
// "!", "?", "✓" or digits, so these cannot be satisfied by a label by accident.)
describe('SketchToolbar — status readout', () => {
  it('shows the free degrees of freedom while under-defined', async () => {
    const sk = createSketch();
    await renderWith({ sk, dofState: { state: 'under', free: 4 } });
    expect(slot.textContent).toContain('4');
  });

  it('shows a tick once the sketch is fully defined', async () => {
    const sk = createSketch();
    await renderWith({ sk, dofState: { state: 'full', free: 0 } });
    expect(slot.textContent).toContain('✓');
  });

  it('flags a failed solve', async () => {
    const sk = createSketch();
    await renderWith({ sk, solveResult: { success: false, status: 2 } });
    expect(slot.textContent).toContain('!');
  });

  it('flags an error (the message itself lives in the tooltip)', async () => {
    const sk = createSketch();
    await renderWith({ sk, error: 'R5 is too large to fit that corner' });
    expect(slot.textContent).toContain('?');
  });

  it('shows no status flags when everything is clean', async () => {
    await renderWith({ sk: createSketch() });
    expect(slot.textContent).not.toContain('!');
    expect(slot.textContent).not.toContain('?');
  });
});
