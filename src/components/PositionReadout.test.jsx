/**
 * @vitest-environment jsdom
 *
 * Render gates for the POSITION (ABSOLUTE) readout. The arithmetic is covered in
 * `engine/view/dro.test.js`; what needs the DOM is whether the panel *appears*
 * for a given state, and whether the axis rows an operator expects are actually
 * on screen — a readout that silently renders nothing looks like a broken sim,
 * and one that quietly drops the A row on a 4-axis job hides where the tool is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import PositionReadout from './PositionReadout.jsx';

let container;
let root;

/** Render the readout with a set of props and hand back the container. */
async function render(props) {
  await act(async () => {
    root.render(React.createElement(PositionReadout, props));
  });
  return container;
}

/** The value cell of a given axis row, or null when that row is absent. */
function axisText(label) {
  const rows = [...container.querySelectorAll('[data-testid="position-readout"] > div')];
  const row = rows.find((r) => r.firstChild?.textContent?.startsWith(label));
  if (!row) return null;
  return row.children[1]?.textContent ?? null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('PositionReadout — when it is on screen', () => {
  it('appears once a program is loaded', async () => {
    await render({ count: 500, point: [1, 2, 3] });
    expect(container.querySelector('[data-testid="position-readout"]')).not.toBeNull();
  });

  it('renders nothing with no program — not an empty panel', async () => {
    await render({ count: 0 });
    expect(container.querySelector('[data-testid="position-readout"]')).toBeNull();
  });

  it('renders nothing on the sketch page', async () => {
    await render({ count: 500, sketching: true, point: [1, 2, 3] });
    expect(container.querySelector('[data-testid="position-readout"]')).toBeNull();
  });

  it('stays on screen parked at zero, like a real control', async () => {
    // playhead 0 means toolPos is null; the page still posts a position.
    await render({ count: 500, point: null });
    expect(container.querySelector('[data-testid="position-readout"]')).not.toBeNull();
    expect(axisText('X')).toBe('0.000');
  });
});

describe('PositionReadout — the rows it posts', () => {
  it('shows X Y Z for a 3-axis milling program', async () => {
    await render({ count: 500, mode: 'mill', point: [12.3456, -7, 0.5] });
    expect(axisText('X')).toBe('12.346');
    expect(axisText('Y')).toBe('-7.000');
    expect(axisText('Z')).toBe('0.500');
    expect(axisText('A')).toBeNull();
  });

  it('adds the A row for a 4-axis program', async () => {
    await render({
      count: 500, mode: 'mill', point: [1, 2, 3],
      aIndices: [0, 90, 180, 270], rotary: { a: 270, b: 0 },
    });
    expect(axisText('A')).toBe('270.000');
  });

  it('posts the lathe X as a diameter, and has no Y row', async () => {
    // The interpreter stored X as a radius (12.5); the page shows ⌀25.
    await render({
      count: 500, mode: 'turn', diameterMode: true, point: [12.5, 0, -30],
    });
    expect(axisText('X')).toBe('25.000');
    expect(axisText('Z')).toBe('-30.000');
    expect(axisText('Y')).toBeNull();
  });

  it('marks the lathe X as a diameter so the number is not ambiguous', async () => {
    await render({ count: 500, mode: 'turn', diameterMode: true, point: [12.5, 0, -30] });
    expect(container.textContent).toContain('⌀');
  });

  it('drops the ⌀ mark when the lathe is programmed on radius', async () => {
    await render({ count: 500, mode: 'turn', diameterMode: false, point: [12.5, 0, -30] });
    expect(container.textContent).not.toContain('⌀');
    expect(axisText('X')).toBe('12.500');
  });

  it('is titled as the absolute page, not a relative one', async () => {
    await render({ count: 500, point: [1, 2, 3] });
    expect(container.textContent).toMatch(/Absolute/i);
  });
});

describe('PositionReadout — where it sits', () => {
  /** The panel element itself. */
  const panel = () => container.querySelector('[data-testid="position-readout"]');

  it('is pinned to the top-right of the viewport', async () => {
    await render({ count: 500, point: [1, 2, 3] });
    const s = panel().style;
    expect(s.position).toBe('absolute');
    expect(s.top).toBe('12px');
    expect(s.right).toBe('12px');
    // Left/bottom must stay unset or the panel stretches across the viewport.
    expect(s.left).toBe('');
    expect(s.bottom).toBe('');
  });

  it('never swallows a mouse drag — the canvas still gets to orbit', async () => {
    // The readout covers a corner of the canvas; orbit/zoom must pass through it.
    await render({ count: 500, point: [1, 2, 3] });
    expect(panel().style.pointerEvents).toBe('none');
  });

  it('floats over the canvas but under the drag-and-drop prompt', async () => {
    // App's drop overlay is zIndex 10 and should cover this; the canvas is 0.
    await render({ count: 500, point: [1, 2, 3] });
    const z = Number(panel().style.zIndex);
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(10);
  });

  it('uses tabular figures so the digits do not shimmer as they count', async () => {
    await render({ count: 500, point: [1, 2, 3] });
    const value = panel().querySelectorAll('div')[1].children[1];
    expect(value.style.fontVariantNumeric).toBe('tabular-nums');
  });
});

describe('PositionReadout — the footer', () => {
  it('names the tool and line in effect', async () => {
    await render({ count: 500, point: [1, 2, 3], toolNumber: 5, line: 1234 });
    expect(container.textContent).toContain('T5');
    expect(container.textContent).toContain('N1234');
  });

  it('says nothing definite before a tool or line is known', async () => {
    await render({ count: 500, point: null, toolNumber: 0, line: 0 });
    expect(container.textContent).toContain('T—');
    expect(container.textContent).toContain('N—');
  });
});
