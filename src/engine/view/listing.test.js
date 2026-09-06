import { describe, it, expect } from 'vitest';
import { visibleRange, followScrollTop, LINE_H, OVERSCAN } from './listing.js';

// A 320 px box at the default 18 px row shows ~18 rows.
const BOX = 320;

describe('visibleRange', () => {
  it('draws a window, not the program — cost follows the panel, not the file', () => {
    const r = visibleRange({ total: 20000, scrollTop: 0, height: BOX });
    expect(r.start).toBe(0);
    // ~18 on screen + one overscan either side, and nowhere near 20000.
    expect(r.end).toBeLessThan(Math.ceil(BOX / LINE_H) + OVERSCAN * 2 + 1);
  });

  it('keeps the scrollbar the whole program long', () => {
    const total = 6000;
    const r = visibleRange({ total, scrollTop: 4000, height: BOX });
    const drawn = (r.end - r.start) * LINE_H;
    expect(r.padTop + drawn + r.padBottom).toBe(total * LINE_H);
  });

  it('overscans above the first visible row so a one-row scroll shows no gap', () => {
    const r = visibleRange({ total: 6000, scrollTop: 100 * LINE_H, height: BOX });
    expect(r.start).toBe(100 - OVERSCAN);
    expect(r.padTop).toBe((100 - OVERSCAN) * LINE_H);
  });

  it('does not overscan past either end of the program', () => {
    expect(visibleRange({ total: 6000, scrollTop: 0, height: BOX }).start).toBe(0);
    const bottom = visibleRange({ total: 40, scrollTop: 0, height: 4000 });
    expect(bottom.end).toBe(40);
    expect(bottom.padBottom).toBe(0);
  });

  it('returns an empty window for a box with no height, and no negative pad', () => {
    // The panel refuses a clientHeight of 0 rather than passing it in (see
    // GcodePanel's INITIAL_H), but the arithmetic still has to hold: a negative
    // pad would blow the scroll height out and the panel would jitter.
    expect(visibleRange({ total: 6000, scrollTop: 0, height: 0 }))
      .toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    expect(visibleRange({ total: 0, scrollTop: 0, height: BOX }).end).toBe(0);
  });
});

describe('followScrollTop', () => {
  it('leaves the box alone while the running line is comfortably in view', () => {
    // Rows 0..17 on screen; line 10 is well inside it.
    expect(followScrollTop({ line: 10, total: 6000, scrollTop: 0, height: BOX })).toBeNull();
  });

  it('scrolls the least it can when the playhead creeps off the bottom', () => {
    const at = followScrollTop({ line: 19, total: 6000, scrollTop: 0, height: BOX });
    // Just enough that row 19 plus its margin is inside the box.
    expect(at).toBe(19 * LINE_H + 3 * LINE_H - BOX);
  });

  it('scrolls back up when it creeps off the top (stepping backwards)', () => {
    const scrollTop = 100 * LINE_H;
    const at = followScrollTop({ line: 99, total: 6000, scrollTop, height: BOX });
    expect(at).toBe((99 - 1 - 3) * LINE_H);
  });

  it('keeps a margin, so the running line is never flush against the frame', () => {
    const at = followScrollTop({ line: 19, total: 6000, scrollTop: 0, height: BOX });
    const rowBottom = 19 * LINE_H;
    expect(at + BOX - rowBottom).toBe(3 * LINE_H);
  });

  it('centres on a jump — dragging the slider must not land hard on an edge', () => {
    const at = followScrollTop({ line: 3000, total: 6000, scrollTop: 0, height: BOX });
    const rowTop = 2999 * LINE_H;
    expect(at).toBe(Math.round(rowTop - (BOX - LINE_H) / 2));
    // Which means real program either side of it, not a line at the bottom edge.
    expect(rowTop - at).toBeGreaterThan(BOX / 3);
  });

  it('clamps at both ends rather than scrolling past the program', () => {
    expect(followScrollTop({ line: 1, total: 6000, scrollTop: 500, height: BOX })).toBe(0);
    const last = followScrollTop({ line: 6000, total: 6000, scrollTop: 0, height: BOX });
    expect(last).toBe(6000 * LINE_H - BOX);
  });

  it('does nothing when nothing is running, or before the box is measured', () => {
    expect(followScrollTop({ line: 0, total: 6000, scrollTop: 0, height: BOX })).toBeNull();
    expect(followScrollTop({ line: 40, total: 6000, scrollTop: 0, height: 0 })).toBeNull();
    expect(followScrollTop({ line: 40, total: 0, scrollTop: 0, height: BOX })).toBeNull();
  });

  it('reports null rather than the scrollTop the box already has', () => {
    // The panel writes the result straight to el.scrollTop; returning the
    // current value would fire a scroll event and re-render for nothing.
    const at = followScrollTop({ line: 19, total: 6000, scrollTop: 0, height: BOX });
    expect(followScrollTop({ line: 19, total: 6000, scrollTop: at, height: BOX })).toBeNull();
  });

  it('a program shorter than the box never scrolls at all', () => {
    for (let line = 1; line <= 10; line++) {
      expect(followScrollTop({ line, total: 10, scrollTop: 0, height: BOX })).toBeNull();
    }
  });
});
