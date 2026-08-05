import { describe, it, expect } from 'vitest';
import {
  usesRotary, droAxisLabels, formatCoord, absoluteValue, distToGo, droRows,
  showDro, droXNote, droTool, droFeed, droSpindle, droFooter,
} from './dro.js';

describe('usesRotary', () => {
  it('is false for a 3-axis program that never leaves A0', () => {
    expect(usesRotary([0])).toBe(false);
    expect(usesRotary([])).toBe(false);
    expect(usesRotary(null)).toBe(false);
  });

  it('is true once a program indexes anywhere else', () => {
    expect(usesRotary([0, 90, 180, 270])).toBe(true);
  });

  it('is true for a program that sits at a single non-zero index', () => {
    // A fixture already clocked to 90° still has a rotary axis to report.
    expect(usesRotary([90])).toBe(true);
  });
});

describe('droAxisLabels', () => {
  it('lists X Y Z for milling', () => {
    expect(droAxisLabels({ mode: 'mill' })).toEqual(['X', 'Y', 'Z']);
  });

  it('adds A only when the program indexes', () => {
    expect(droAxisLabels({ mode: 'mill', rotary: true })).toEqual(['X', 'Y', 'Z', 'A']);
  });

  it('drops Y on the lathe — turn mode works the ZX plane', () => {
    expect(droAxisLabels({ mode: 'turn' })).toEqual(['X', 'Z']);
  });

  it('defaults to milling with no options at all', () => {
    expect(droAxisLabels()).toEqual(['X', 'Y', 'Z']);
  });
});

describe('formatCoord', () => {
  it('posts microns, like the program', () => {
    expect(formatCoord(12.3456)).toBe('12.346');
    expect(formatCoord(-7)).toBe('-7.000');
  });

  it('folds a signed zero — -0.000 is not a position', () => {
    expect(formatCoord(-0)).toBe('0.000');
    expect(formatCoord(-1e-9)).toBe('0.000');
  });

  it('never goes exponential on a big or tiny number', () => {
    expect(formatCoord(1e-7)).toBe('0.000');
    expect(formatCoord(123456.789)).toBe('123456.789');
  });

  it('reads zero rather than NaN for a missing value', () => {
    expect(formatCoord(undefined)).toBe('0.000');
    expect(formatCoord(NaN)).toBe('0.000');
  });
});

describe('absoluteValue', () => {
  const point = [10, 20, -5];

  it('passes milling coordinates through untouched — they are already absolute', () => {
    expect(absoluteValue('X', point, { mode: 'mill' })).toBe(10);
    expect(absoluteValue('Y', point, { mode: 'mill' })).toBe(20);
    expect(absoluteValue('Z', point, { mode: 'mill' })).toBe(-5);
  });

  it('doubles X back to a diameter on a diameter lathe', () => {
    // interpreter.js halves the X word into a radius; the ABSOLUTE page shows
    // the diameter the programmer typed.
    expect(absoluteValue('X', [12.5, 0, -30], { mode: 'turn', diameterMode: true })).toBe(25);
  });

  it('leaves X alone on a radius-programmed lathe', () => {
    expect(absoluteValue('X', [12.5, 0, -30], { mode: 'turn', diameterMode: false })).toBe(12.5);
  });

  it('never doubles X for milling, whatever diameterMode says', () => {
    // diameterMode is a lathe setting; it must not leak into a mill readout.
    expect(absoluteValue('X', point, { mode: 'mill', diameterMode: true })).toBe(10);
  });

  it('reads the rotary index for A', () => {
    expect(absoluteValue('A', point, { rotary: { a: 90, b: 0 } })).toBe(90);
    expect(absoluteValue('B', point, { rotary: { a: 90, b: 45 } })).toBe(45);
  });

  it('reads zero before the playhead has moved', () => {
    expect(absoluteValue('X', null)).toBe(0);
    expect(absoluteValue('A', null)).toBe(0);
  });
});

describe('distToGo', () => {
  it('is what is left of the move, signed the way the axis travels', () => {
    // Half way from X0 to X50: 25 to go, positive because X is going positive.
    expect(distToGo('X', [25, 0, 0], [50, 0, 0], { mode: 'mill' })).toBe(25);
    // Plunging Z0 → Z-2 with 0.5 cut: still 1.5 to go, negative direction.
    expect(distToGo('Z', [0, 0, -0.5], [0, 0, -2], { mode: 'mill' })).toBe(-1.5);
  });

  it('reads zero on an axis the block does not move', () => {
    expect(distToGo('Y', [10, 7, 0], [50, 7, 0], { mode: 'mill' })).toBe(0);
  });

  it('reaches zero exactly at the end point', () => {
    expect(distToGo('X', [50, 0, 0], [50, 0, 0], { mode: 'mill' })).toBe(0);
  });

  it('reads zero with nothing commanded — parked, or no program', () => {
    expect(distToGo('X', null, null, { mode: 'mill' })).toBe(0);
    expect(distToGo('X', [10, 0, 0], null, { mode: 'mill' })).toBe(0);
  });

  it('counts down in diameter on a diameter lathe, like the position beside it', () => {
    // Stored radii: 30 → 20. The slide travels 10 mm; the page says 20 to go,
    // matching an ABSOLUTE column that counts ⌀60 → ⌀40.
    const opts = { mode: 'turn', diameterMode: true };
    expect(distToGo('X', [30, 0, 0], [20, 0, 0], opts)).toBe(-20);
    expect(distToGo('X', [30, 0, 0], [20, 0, 0], { ...opts, diameterMode: false })).toBe(-10);
  });
});

describe('droRows', () => {
  it('gives a mill three rows in mm', () => {
    const rows = droRows([1, 2, 3], { mode: 'mill' });
    expect(rows.map((r) => r.label)).toEqual(['X', 'Y', 'Z']);
    expect(rows.map((r) => r.text)).toEqual(['1.000', '2.000', '3.000']);
    expect(rows.every((r) => r.unit === 'mm')).toBe(true);
  });

  it('adds an A row in degrees for a 4-axis program', () => {
    const rows = droRows([1, 2, 3], { aIndices: [0, 90], rotary: { a: 90, b: 0 } });
    const a = rows.find((r) => r.label === 'A');
    expect(a.text).toBe('90.000');
    expect(a.unit).toBe('deg');
  });

  it('posts the lathe X as a diameter and skips Y', () => {
    const rows = droRows([12.5, 0, -30], { mode: 'turn', diameterMode: true });
    expect(rows.map((r) => r.label)).toEqual(['X', 'Z']);
    expect(rows[0].text).toBe('25.000');
    expect(rows[1].text).toBe('-30.000');
  });

  it('reads all zeros with no position yet, rather than blanks', () => {
    const rows = droRows(null, { mode: 'mill' });
    expect(rows.map((r) => r.text)).toEqual(['0.000', '0.000', '0.000']);
  });

  it('carries the numeric value alongside the text, for the view to style on', () => {
    const rows = droRows([-1.5, 0, 0], { mode: 'mill' });
    expect(rows[0].value).toBe(-1.5);
  });

  it('carries a distance to go per row, counting down to the block end', () => {
    const rows = droRows([25, 0, -2], { mode: 'mill', target: [50, 0, -2] });
    expect(rows.map((r) => r.dtgText)).toEqual(['25.000', '0.000', '0.000']);
    expect(rows[0].dtg).toBe(25);
  });

  it('posts a zero distance to go when no block is running', () => {
    const rows = droRows(null, { mode: 'mill' });
    expect(rows.map((r) => r.dtgText)).toEqual(['0.000', '0.000', '0.000']);
  });

  it('has nothing to go on the rotary row — an indexer is where it was sent', () => {
    const rows = droRows([1, 2, 3], {
      aIndices: [0, 90], rotary: { a: 90, b: 0 }, target: [9, 9, 9],
    });
    expect(rows.find((r) => r.label === 'A').dtgText).toBe('0.000');
  });

  it('never posts a signed-zero distance to go', () => {
    // Floating point lands a hair past the end point all the time; -0.000 on a
    // position page reads as a fault.
    const rows = droRows([50.0000001, 0, 0], { mode: 'mill', target: [50, 0, 0] });
    expect(rows[0].dtgText).toBe('0.000');
  });
});

describe('showDro', () => {
  it('appears once a program is loaded', () => {
    expect(showDro({ count: 1200 })).toBe(true);
  });

  it('stays on screen while parked — a control does not blank its position page', () => {
    // No playhead argument at all: parked at 0 is still a position.
    expect(showDro({ count: 1200, sketching: false })).toBe(true);
  });

  it('is hidden with no program', () => {
    expect(showDro({ count: 0 })).toBe(false);
    expect(showDro()).toBe(false);
  });

  it('is hidden on the sketch page — no machine there', () => {
    expect(showDro({ sketching: true, count: 1200 })).toBe(false);
  });
});

describe('droXNote', () => {
  it('marks X as a diameter on a diameter lathe', () => {
    expect(droXNote({ mode: 'turn', diameterMode: true })).toBe('⌀');
  });

  it('says nothing when it would be noise', () => {
    expect(droXNote({ mode: 'turn', diameterMode: false })).toBe(null);
    expect(droXNote({ mode: 'mill', diameterMode: true })).toBe(null);
  });
});

describe('droTool — what is in the spindle', () => {
  it('names the cutter and its size, not just the T number', () => {
    expect(droTool({ number: 3, cutter: 'endmill', radius: 3.5 }))
      .toEqual({ number: 'T3', name: 'Endmill Ø7' });
  });

  it('drops trailing zeros from the diameter', () => {
    expect(droTool({ number: 1, cutter: 'face', radius: 25 }).name).toBe('Face mill Ø50');
    expect(droTool({ number: 1, cutter: 'ball', radius: 3.175 }).name).toBe('Ball nose Ø6.35');
  });

  it('names a lathe tool by its holder designation, which has no diameter', () => {
    const holder = { id: 'mvjnr', label: 'MVJNR · 93° OD (insert adj.)' };
    expect(droTool({ number: 101, holder }))
      .toEqual({ number: 'T101', name: 'MVJNR' });
  });

  it('falls back to the program comment, minus its operation tail', () => {
    expect(droTool({ number: 2, desc: 'DRILL 9 CB - PRE-DRILL' }).name).toBe('DRILL 9 CB');
  });

  it('posts a size alone when that is all that is known', () => {
    expect(droTool({ number: 4, radius: 4 }).name).toBe('Ø8');
  });

  it('invents nothing when the program never said', () => {
    expect(droTool({ number: 7 })).toEqual({ number: 'T7', name: null });
    expect(droTool()).toEqual({ number: 'T—', name: null });
  });
});

describe('droFeed — the rate in the units it was programmed in', () => {
  it('posts a milling feed in mm/min', () => {
    expect(droFeed({ feed: 850, feedMode: 94 })).toEqual({ text: '850', unit: 'mm/min' });
  });

  it('converts a lathe feed back to the mm/rev the programmer typed', () => {
    // F0.15 at 1200 rpm is stored as 180 mm/min; posting 180 would be a number
    // that appears nowhere in the program.
    expect(droFeed({ feed: 0.15 * 1200, rpm: 1200, feedMode: 95 }))
      .toEqual({ text: '0.15', unit: 'mm/rev' });
  });

  it('stays in mm/min under G95 with the spindle stopped — nothing to divide by', () => {
    expect(droFeed({ feed: 100, rpm: 0, feedMode: 95 }).unit).toBe('mm/min');
  });

  it('keeps the decimals of a slow feed and drops them from a fast one', () => {
    expect(droFeed({ feed: 7.5, feedMode: 94 }).text).toBe('7.5');
    expect(droFeed({ feed: 2499.6, feedMode: 94 }).text).toBe('2500');
  });

  it('dashes before the program has stated a feed', () => {
    expect(droFeed({ feed: 0 })).toEqual({ text: '—', unit: '' });
    expect(droFeed()).toEqual({ text: '—', unit: '' });
  });
});

describe('droSpindle — the rpm the machine is actually at', () => {
  it('posts a whole number of rev/min', () => {
    expect(droSpindle({ rpm: 8000 })).toEqual({ text: '8000', unit: 'rpm' });
    // Constant surface speed gives a fractional ideal rpm; a control posts none.
    expect(droSpindle({ rpm: 2122.07 }).text).toBe('2122');
  });

  it('dashes with the spindle stopped', () => {
    expect(droSpindle({ rpm: 0 })).toEqual({ text: '—', unit: '' });
    expect(droSpindle()).toEqual({ text: '—', unit: '' });
  });
});

describe('droFooter', () => {
  it('assembles the strip a control posts under the position', () => {
    const foot = droFooter({
      toolNumber: 3,
      tool: { cutter: 'chamfer', radius: 5 },
      running: { feed: 400, rpm: 6000, feedMode: 94 },
      line: 1234,
    });
    expect(foot.tool).toEqual({ number: 'T3', name: 'Chamfer mill Ø10' });
    expect(foot.feed).toEqual({ text: '400', unit: 'mm/min' });
    expect(foot.spindle).toEqual({ text: '6000', unit: 'rpm' });
    expect(foot.line).toBe('N1234');
  });

  it('says nothing definite with no program running', () => {
    const foot = droFooter();
    expect(foot.tool).toEqual({ number: 'T—', name: null });
    expect(foot.feed.text).toBe('—');
    expect(foot.spindle.text).toBe('—');
    expect(foot.line).toBe('N—');
  });
});
