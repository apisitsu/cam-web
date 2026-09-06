/**
 * @vitest-environment jsdom
 *
 * What this panel has to keep doing, on a program the size of a real one.
 *
 * The arithmetic is `engine/view/listing.js`'s and is tested there. What is only
 * checkable here is that the component *uses* it: that a 5,000-line program puts
 * a screenful of rows in the DOM rather than 5,000 of them, and that the
 * executing line is still marked and still brought into view. Those two pull
 * against each other — a highlight on a row that was never rendered is exactly
 * the bug a naive window introduces — so neither is worth asserting alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import GcodePanel from './GcodePanel.jsx';
import { LINE_H } from '../engine/view/listing.js';

/** A 5,000-line program, each line naming itself so a row can be identified. */
const program = (n = 5000) => Array.from({ length: n }, (_, i) => `N${i + 1} G1 X${i}`).join('\n');

const BOX_H = 360; // ~20 rows at LINE_H

let host;
let root;

// jsdom has no layout: clientHeight is 0 and scrollTop is a no-op, so the panel
// would measure itself as zero rows tall and never scroll. Stand both up — this
// is what the browser supplies, not something the component should work around.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true, get() { return BOX_H; },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() { return this.__scrollTop ?? 0; },
    set(v) { this.__scrollTop = v; },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete HTMLElement.prototype.clientHeight;
  delete HTMLElement.prototype.scrollTop;
});

// eslint-disable-next-line testing-library/no-unnecessary-act
const render = (props) => act(() => {
  root.render(<GcodePanel gcode={program()} activeLine={0} onChange={() => {}} {...props} />);
});

const rows = () => [...host.querySelectorAll('[data-gcode-line]')];
const activeRow = () => host.querySelector('[data-gcode-active]');

describe('GcodePanel', () => {
  it('puts a screenful of rows in the DOM, not the whole program', () => {
    render({ activeLine: 1 });
    // ~20 on screen plus overscan either side — the point is that it is bounded
    // by the box, and nowhere near 5,000.
    expect(rows().length).toBeGreaterThan(BOX_H / LINE_H);
    expect(rows().length).toBeLessThan(60);
  });

  it('still measures the scrollbar against the whole program', () => {
    render({ activeLine: 1 });
    const box = host.querySelector('[data-gcode-listing]');
    // The two pads plus the drawn rows have to come to the whole program's
    // height, or the scrollbar would report a 40-line file.
    const heights = [...box.children]
      .map((c) => parseFloat(c.style.height) || 0)
      .reduce((a, b) => a + b, 0);
    expect(heights).toBe(5000 * LINE_H);
  });

  it('marks the executing line, and its number and text are the right ones', () => {
    render({ activeLine: 12 });
    const row = activeRow();
    expect(row).toBeTruthy();
    expect(row.getAttribute('data-gcode-line')).toBe('12');
    expect(row.textContent).toContain('N12 G1 X11');
  });

  it('scrolls a line deep in the program into the window and renders it there', () => {
    render({ activeLine: 3000 });
    const box = host.querySelector('[data-gcode-listing]');
    expect(box.scrollTop).toBeGreaterThan(0);
    // The row it highlights must be one it actually drew.
    const row = activeRow();
    expect(row).toBeTruthy();
    expect(row.getAttribute('data-gcode-line')).toBe('3000');
    expect(rows().length).toBeLessThan(60);
  });

  it('follows the playhead as it advances', () => {
    render({ activeLine: 1 });
    const box = host.querySelector('[data-gcode-listing]');
    expect(box.scrollTop).toBe(0);
    render({ activeLine: 900 });
    const first = box.scrollTop;
    expect(first).toBeGreaterThan(0);
    expect(activeRow().getAttribute('data-gcode-line')).toBe('900');
    render({ activeLine: 940 });
    expect(box.scrollTop).toBeGreaterThan(first);
    expect(activeRow().getAttribute('data-gcode-line')).toBe('940');
  });

  it('leaves the box alone while the executing line is already in view', () => {
    render({ activeLine: 900 });
    const box = host.querySelector('[data-gcode-listing]');
    const at = box.scrollTop;
    render({ activeLine: 901 });
    expect(box.scrollTop).toBe(at);
    expect(activeRow().getAttribute('data-gcode-line')).toBe('901');
  });

  it('highlights nothing before the program starts', () => {
    render({ activeLine: 0 });
    expect(activeRow()).toBeNull();
    expect(rows().length).toBeGreaterThan(0);
  });

  it('swaps to a plain textarea to edit, with no rows left behind', () => {
    render({ activeLine: 12 });
    act(() => host.querySelector('button[data-cmd="editGcode"]').click());
    expect(host.querySelector('textarea')).toBeTruthy();
    expect(rows()).toHaveLength(0);
  });
});
