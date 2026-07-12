import { describe, it, expect } from 'vitest';
import { tokenizeLine, stripComments } from './tokenizer.js';
import { tessellateArc } from './arc.js';
import { interpret } from './interpreter.js';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

describe('tokenizer', () => {
  it('strips paren and semicolon comments', () => {
    expect(stripComments('G1 X10 (rapid) Y20 ; done').trim()).toBe('G1 X10  Y20');
  });
  it('parses letters and signed decimals, drops N word', () => {
    const t = tokenizeLine('N5 G1 X-1.5 Y.5 Z2.');
    expect(t).toEqual([
      { letter: 'G', value: 1 },
      { letter: 'X', value: -1.5 },
      { letter: 'Y', value: 0.5 },
      { letter: 'Z', value: 2 },
    ]);
  });
  it('returns nothing for blank / comment-only lines', () => {
    expect(tokenizeLine('   ; just a note')).toEqual([]);
    expect(tokenizeLine('( header )')).toEqual([]);
  });
});

describe('arc tessellation', () => {
  const XY = [0, 1, 2];
  it('CCW quarter arc via I/J has centre at origin', () => {
    // start (1,0) -> end (0,1), centre offset i=-1 j=0
    const { points } = tessellateArc([1, 0, 0], [0, 1, 0], { i: -1, j: 0 }, XY, false);
    for (const p of points) {
      expect(near(Math.hypot(p[0], p[1]), 1)).toBe(true); // on unit circle
    }
    expect(near(points[0][0], 1) && near(points[0][1], 0)).toBe(true);
    const last = points[points.length - 1];
    expect(near(last[0], 0) && near(last[1], 1)).toBe(true);
  });
  it('radius-form minor arc (R>0) matches I/J-form centre', () => {
    const r = tessellateArc([1, 0, 0], [0, 1, 0], { r: 1 }, XY, false).points;
    for (const p of r) expect(near(Math.hypot(p[0], p[1]), 1)).toBe(true);
  });
  it('full circle when start == end with offset', () => {
    const { points } = tessellateArc([1, 0, 0], [1, 0, 0], { i: -1, j: 0 }, XY, false);
    // last point returns to start
    const last = points[points.length - 1];
    expect(near(last[0], 1) && near(last[1], 0)).toBe(true);
    expect(points.length).toBeGreaterThan(16);
  });
  it('helical Z interpolates linearly', () => {
    const { points } = tessellateArc([1, 0, 0], [0, 1, 4], { i: -1, j: 0 }, XY, false);
    expect(near(points[points.length - 1][2], 4)).toBe(true);
    expect(points[0][2]).toBe(0);
  });
});

describe('interpreter — linear motion', () => {
  it('classifies rapid vs feed and accumulates lengths', () => {
    const { stats } = interpret('G21 G90\nG0 X0 Y0\nG1 X10 F100\nG1 Y10');
    expect(near(stats.rapidLength, 0)).toBe(true); // G0 to origin from origin = 0
    expect(near(stats.feedLength, 20)).toBe(true); // 10 + 10
  });
  it('incremental mode (G91) accumulates from current position', () => {
    const { bounds } = interpret('G21 G91\nG1 X10 F100\nG1 X10\nG1 X10');
    expect(near(bounds.max[0], 30)).toBe(true);
  });
  it('inch mode (G20) scales to mm', () => {
    const { bounds } = interpret('G20 G90\nG1 X1 F10'); // 1 inch = 25.4 mm
    expect(near(bounds.max[0], 25.4)).toBe(true);
  });
  it('modal motion repeats on bare coordinate blocks', () => {
    const { stats } = interpret('G21 G90 G1 F100\nX10\nX20');
    expect(near(stats.feedLength, 20)).toBe(true);
  });
});

describe('interpreter — canned drilling cycle', () => {
  it('G81 expands to traverse + plunge + retract and repeats per hole', () => {
    const prog = [
      'G21 G90 G0 Z5',
      'G81 X10 Y10 Z-6 R2 F100',
      'X25 Y20',
      'G80',
    ].join('\n');
    const { stats, bounds } = interpret(prog);
    // Two holes drilled to Z-6.
    expect(near(bounds.min[2], -6)).toBe(true);
    // Each hole contributes cutting feed from R(2) down to Z(-6) = 8mm.
    expect(near(stats.feedLength, 16)).toBe(true);
  });
});

describe('interpreter — lathe cycles in milling mode', () => {
  it('warns that G71 needs Turning mode instead of expanding it', () => {
    const { stats } = interpret('G21 G90\nG71 P10 Q20 U0.5 W0.1 D2 F150');
    expect(stats.warnings.some((w) => w.includes('G71') && w.includes('Turning'))).toBe(true);
  });
  it('explains a zero-radius arc caused by a lathe I/K arc in the XY plane', () => {
    const { stats } = interpret('G21 G90\nG0 X20 Z0\nG3 X30 Z-5 I0 K-5 F100');
    const w = stats.warnings.find((x) => x.includes('zero-radius arc'));
    expect(w).toContain('K offset is ignored in the XY plane');
  });
});

// Blank ⌀52 (radius 26) roughed down to a ⌀40 shank with a ⌀50 shoulder.
const G71_PROG = [
  'G21 G90 G99 S1000',   // 1
  'G0 X52 Z1',           // 2  cycle start: radius 26, Z1
  'G71 U2.0 R1.0',       // 3  depth 2 mm (radius), retract 1 mm
  'G71 P100 Q200 U0.5 W0.1 F0.25', // 4  leave 0.5 on ⌀, 0.1 on Z
  'N100 G0 X40',         // 5  profile start: radius 20
  'N110 G1 Z-30 F0.12',  // 6
  'N200 G1 X52',         // 7  face out to the blank
  'G70 P100 Q200',       // 8  finish pass
  'G0 X60 Z20',          // 9
].join('\n');

describe('interpreter — G71 roughing / G70 finishing', () => {
  it('expands G71 into roughing passes instead of warning', () => {
    const { segments, stats } = interpret(G71_PROG, { mode: 'turn' });
    expect(stats.warnings).toEqual([]);
    expect(segments.length).toBeGreaterThan(10);
    expect(stats.feedLength).toBeGreaterThan(0);
  });

  it('never cuts inside the finishing allowance', () => {
    const { segments } = interpret(G71_PROG, { mode: 'turn' });
    // Profile radius is 20; U0.5 on the diameter leaves the rough at 20.25.
    const roughing = segments.filter((s) => s.line === 4 && s.type === 'feed');
    expect(roughing.length).toBeGreaterThan(0);
    for (const s of roughing) {
      expect(s.a[0]).toBeGreaterThanOrEqual(20.25 - 1e-6);
      expect(s.b[0]).toBeGreaterThanOrEqual(20.25 - 1e-6);
    }
  });

  it('steps down by the programmed depth of cut and returns to the start point', () => {
    const { segments } = interpret(G71_PROG, { mode: 'turn' });
    const levels = [...new Set(
      segments.filter((s) => s.line === 4 && s.type === 'feed' && near(s.a[0], s.b[0]))
        .map((s) => +s.a[0].toFixed(3))
    )].sort((a, b) => b - a);
    // 26 - 2k, floored at the offset profile radius 20.25.
    expect(levels).toEqual([24, 22, 20.25]);

    const lastOfCycle = segments.filter((s) => s.line === 4).pop();
    expect(near(lastOfCycle.b[0], 26)).toBe(true); // radius of ⌀52
    expect(near(lastOfCycle.b[2], 1)).toBe(true);  // Z1
  });

  it('G70 walks the real profile, not the offset one', () => {
    const { segments } = interpret(G71_PROG, { mode: 'turn' });
    // The finishing pass is emitted from the profile's own lines (5..7).
    const finish = segments.filter((s) => s.line >= 5 && s.line <= 7);
    expect(finish.length).toBeGreaterThan(0);
    expect(finish.some((s) => near(s.b[0], 20))).toBe(true); // on-size, no allowance
  });

  it('skips the profile blocks in the main stream (the control jumps past them)', () => {
    // Without the jump, N100..N200 would run twice more as ordinary motion.
    const withCycles = interpret(G71_PROG, { mode: 'turn' }).segments;
    const profileRuns = withCycles.filter((s) => s.line === 6).length;
    // Exactly one run: G70's finishing pass. G71 traced it without emitting.
    expect(profileRuns).toBe(1);
  });

  it('warns and skips when the P/Q sequence numbers do not exist', () => {
    const prog = 'G21 G90\nG0 X52 Z1\nG71 U2 R1\nG71 P900 Q999 U0.5 W0.1 F0.2';
    const { stats } = interpret(prog, { mode: 'turn' });
    expect(stats.warnings.some((w) => w.includes("doesn't define"))).toBe(true);
  });

  it('warns and skips when no depth of cut was given', () => {
    const prog = ['G21 G90', 'G0 X52 Z1', 'G71 P100 Q200 U0.5 W0.1 F0.2',
      'N100 G0 X40', 'N200 G1 Z-30'].join('\n');
    const { stats } = interpret(prog, { mode: 'turn' });
    expect(stats.warnings.some((w) => w.includes('no depth of cut'))).toBe(true);
  });
});

describe('interpreter — cycle time', () => {
  it('times feed moves from F and rapid moves from the rapid rate', () => {
    // 100 mm of rapid at 5000 mm/min = 1.2 s; 100 mm of feed at 200 mm/min = 30 s.
    const { stats } = interpret('G21 G90\nG0 X100\nG1 X200 F200', { rapidRate: 5000 });
    expect(near(stats.rapidTime, 1.2)).toBe(true);
    expect(near(stats.feedTime, 30)).toBe(true);
    expect(near(stats.cycleTime, 31.2)).toBe(true);
  });

  it('cutting length counts only feed moves, totalLength counts both', () => {
    const { stats } = interpret('G21 G90\nG0 X10\nG1 X30 F100');
    expect(near(stats.feedLength, 20)).toBe(true);
    expect(near(stats.totalLength, 30)).toBe(true);
  });

  it('G4 dwell adds to cycle time and bills the preceding segment', () => {
    const { segments, stats } = interpret('G21 G90\nG1 X100 F6000\nG4 P2.5', {});
    expect(near(stats.dwellTime, 2.5)).toBe(true);
    // 100 mm at 6000 mm/min = 1 s, plus the 2.5 s dwell.
    expect(near(segments[segments.length - 1].t, 3.5)).toBe(true);
    expect(near(stats.cycleTime, 3.5)).toBe(true);
  });

  it('falls back to 100 mm/min and warns when a feed move has no F word', () => {
    const { stats } = interpret('G21 G90\nG1 X100');
    expect(near(stats.feedTime, 60)).toBe(true);
    expect(stats.warnings.some((w) => w.includes('F word'))).toBe(true);
  });

  it('cumulative segment times sum to the cycle time', () => {
    const { segments, stats } = interpret(SAMPLE_ISH, { rapidRate: 3000 });
    const sum = segments.reduce((a, s) => a + s.t, 0);
    expect(near(sum, stats.cycleTime)).toBe(true);
  });
});

const SAMPLE_ISH = [
  'G21 G90 G17',
  'G0 Z5',
  'G1 Z-2 F150',
  'G1 X50 F400',
  'G2 X40 Y40 I-10 J0',
  'G81 X10 Y10 Z-6 R2 F100',
  'G80',
].join('\n');

describe('interpreter — turning mode', () => {
  it('halves the X word into a radius (diameter mode)', () => {
    const { bounds } = interpret('G21 G90\nG0 X50 Z0', { mode: 'turn' });
    expect(near(bounds.max[0], 25)).toBe(true);
  });

  it('honours diameterMode: false (radius programming)', () => {
    const { bounds } = interpret('G21 G90\nG0 X50 Z0', { mode: 'turn', diameterMode: false });
    expect(near(bounds.max[0], 50)).toBe(true);
  });

  it('defaults to the ZX plane so I/K arcs stay in the profile', () => {
    // Quarter arc about centre (X=10, Z=-5); every point stays at Y=0.
    const { segments } = interpret(
      'G21 G90 G99 S1000\nG0 X20 Z0\nG3 X30 Z-5 I0 K-5 F0.1',
      { mode: 'turn' }
    );
    const arc = segments.filter((s) => s.type === 'feed');
    expect(arc.length).toBeGreaterThan(1);
    for (const s of arc) expect(near(s.b[1], 0)).toBe(true);
  });

  it('defaults to feed per revolution — a lathe powers up in G99', () => {
    // No G99 in the program: F0.2 is 0.2 mm/rev × 1000 rpm = 200 mm/min = 30 s,
    // not 0.2 mm/min (which would be 8h20m).
    const { stats } = interpret('G21 G90 S1000\nG0 Z0\nG1 Z-100 F0.2', { mode: 'turn' });
    expect(near(stats.feedTime, 30)).toBe(true);
    expect(stats.warnings).toEqual([]);
  });

  it('G98 switches a lathe back to feed per minute', () => {
    const { stats } = interpret('G21 G90 G98 S1000\nG0 Z0\nG1 Z-100 F200', { mode: 'turn' });
    expect(near(stats.feedTime, 30)).toBe(true);
  });

  it('warns when an F word contradicts the active feed mode', () => {
    // mm/rev-looking F while feed-per-minute is active.
    const perMin = interpret('G21 G90 G98 S1000\nG1 Z-10 F0.2', { mode: 'turn' });
    expect(perMin.stats.warnings.some((w) => w.includes('looks like a feed per revolution'))).toBe(true);

    // mm/min-looking F while feed-per-rev is active.
    const perRev = interpret('G21 G90 S1000\nG1 Z-10 F200', { mode: 'turn' });
    expect(perRev.stats.warnings.some((w) => w.includes('implausible as a feed per revolution'))).toBe(true);
  });

  it('milling still defaults to feed per minute', () => {
    const { stats } = interpret('G21 G90 S1000\nG1 X100 F200');
    expect(near(stats.feedTime, 30)).toBe(true);
  });

  it('G99 selects feed per revolution: F × spindle rpm', () => {
    // 100 mm of Z travel at 0.2 mm/rev × 1000 rpm = 200 mm/min = 30 s.
    const { stats } = interpret(
      'G21 G90 G99 S1000\nG0 Z0\nG1 Z-100 F0.2',
      { mode: 'turn' }
    );
    expect(near(stats.feedTime, 30)).toBe(true);
  });

  it('warns when feed-per-rev runs without a spindle speed', () => {
    const { stats } = interpret('G21 G90 G99\nG1 Z-10 F0.2', { mode: 'turn' });
    expect(stats.warnings.some((w) => w.includes('S word'))).toBe(true);
  });

  it('milling keeps G98/G99 as the canned-cycle retract plane', () => {
    // G99 retracts to the R plane (Z2), not the initial Z (Z5).
    const { segments } = interpret('G21 G90 G0 Z5\nG99 G81 X10 Y10 Z-6 R2 F100\nG80');
    const last = segments[segments.length - 1];
    expect(near(last.b[2], 2)).toBe(true);
  });
});
