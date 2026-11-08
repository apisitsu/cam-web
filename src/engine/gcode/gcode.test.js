import { describe, it, expect } from 'vitest';
import { tokenizeLine, stripComments } from './tokenizer.js';
import { tessellateArc } from './arc.js';
import { interpret } from './interpreter.js';
import { parseGcode } from './index.js';
import { parseToolTable } from './tools.js';

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

  it('G81/G83/G86 rapid out, but G84 backs the tap out at the plunge feed', () => {
    // A rigid tap never runs its axis and spindle out of sync — the retract
    // is synchronized the same as the plunge, not an instant rapid the way
    // a real G81/G86 retract is. Modelling it as a rapid (as an earlier
    // version of this did) understated every tapped hole's own cycle time
    // by the whole length of that leg.
    const tap = interpret('G21 G90 G0 Z5\nG84 X10 Y10 Z-10 R2 F200\nG80');
    const drill = interpret('G21 G90 G0 Z5\nG81 X10 Y10 Z-10 R2 F200\nG80');
    // Same plunge (R2 to Z-10 = 12mm). G84's retract runs all the way back
    // to the initial Z (5, the default retract plane with no G98/G99 in the
    // program — R2 to Z5 = 15mm) and, unlike G81's, counts as feed, so the
    // tap cuts a longer "feed" length and takes meaningfully longer than the
    // drill's rapid-retract cycle.
    expect(near(tap.stats.feedLength, 27)).toBe(true);
    expect(near(drill.stats.feedLength, 12)).toBe(true);
    expect(tap.stats.cycleTime).toBeGreaterThan(drill.stats.cycleTime);
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

  it('replays a rapid leg inside the profile as a rapid in the semi-finish pass, not a feed', () => {
    // The semi-finish pass used to force 'feed' for every leg after the
    // profile's first point — right for a profile that is all G1 after its
    // opening G0, wrong the moment a profile has a *second* rapid partway
    // through (here, `G0 X36`, a legitimate repositioning jump). Forcing it
    // to feed turned a non-cutting move into a bogus cut along the way.
    const prog = [
      'G21 G90 G99 S1000', 'G0 X52 Z1', 'G71 U2.0 R1.0',
      'G71 P100 Q200 U0.5 W0.1 F0.25',
      'N100 G0 X40', 'G1 Z0 F0.12', 'G0 X36', 'G1 Z-10',
      'N200 G1 X52', 'G70 P100 Q200', 'G0 X60 Z20',
    ].join('\n');
    const { segments } = interpret(prog, { mode: 'turn' });
    // The semi-finish pass's replay of `G0 X36`: radius 18+0.25 (U0.5 on
    // diameter) at Z 0+0.1 (W0.1), reached from the previous point at the
    // same Z — the one leg in the whole G71 call with neither endpoint
    // moving in Z, other than the roughing passes' own 45° pull-offs.
    const leg = segments.find((s) => s.line === 4 && near(s.a[0], 20.25) && near(s.b[0], 18.25));
    expect(leg).toBeDefined();
    expect(leg.type).toBe('rapid');
  });
});

describe('interpreter — G74 peck drilling', () => {
  const G74_PROG = [
    'G21 G90 G99 S1000',
    'G0 X0 Z2',
    'G74 R0.5',            // retract 0.5 mm between pecks
    'G74 Z-10 Q2000 F0.05', // peck 2 mm (2000 microns) per step
  ].join('\n');

  it('expands into feed pecks instead of warning', () => {
    const { stats } = interpret(G74_PROG, { mode: 'turn' });
    expect(stats.warnings).toEqual([]);
  });

  it('pecks by the programmed depth (Q in microns) and ends at the target Z', () => {
    const { segments } = interpret(G74_PROG, { mode: 'turn' });
    const cycle = segments.filter((s) => s.line === 4);
    const pecks = cycle.filter((s) => s.type === 'feed');
    // 12 mm of travel at a 2 mm peck: 6 full steps, the last landing exactly
    // on Z-10 rather than overshooting it.
    expect(pecks.length).toBe(6);
    expect(pecks.every((s) => near(s.a[0], 0) && near(s.b[0], 0))).toBe(true);
    expect(near(pecks.at(-1).b[2], -10)).toBe(true);
    // Retract between pecks (not after the last one): 5 chip-break hops.
    const retracts = cycle.filter((s) => s.type === 'rapid');
    expect(retracts.length).toBe(10); // 5 hops × (up, back down)
  });

  it('retreats by R from the current depth, not back to a fixed plane', () => {
    const { segments } = interpret(G74_PROG, { mode: 'turn' });
    const firstHopUp = segments.filter((s) => s.line === 4 && s.type === 'rapid')[0];
    // First peck lands at Z0 (2 - 2); the hop retreats 0.5 mm back to Z0.5.
    expect(near(firstHopUp.b[2], 0.5)).toBe(true);
  });

  it('warns and does not expand the combined X/P face-grooving form', () => {
    const prog = 'G21 G90\nG0 X10 Z2\nG74 R0.5\nG74 X20 Z-10 P2 Q2000 F0.05';
    const { stats } = interpret(prog, { mode: 'turn' });
    expect(stats.warnings.some((w) => w.includes('face-grooving'))).toBe(true);
  });
});

describe('interpreter — G76 threading', () => {
  // ⌀20 blank threaded down to ⌀16 over 20 mm: 2 mm of radius to remove,
  // taken in one rough pass (Q = the full 2 mm) plus 2 finishing passes.
  const G76_PROG = [
    'G21 G90 G99 S1000',
    'G0 X20 Z2',
    'G0 Z0',
    'G76 P020060 Q100 R0',
    'G76 X16 Z-20 P2000 Q2000 F1.5',
  ].join('\n');

  it('expands into threading passes instead of warning', () => {
    const { stats } = interpret(G76_PROG, { mode: 'turn' });
    expect(stats.warnings).toEqual([]);
  });

  it('cuts the rough pass plus the finishing passes named by the packed P, all to the final X', () => {
    const { segments } = interpret(G76_PROG, { mode: 'turn' });
    const cuts = segments.filter((s) => s.line === 5 && s.type === 'feed');
    // 1 rough pass (reaches the full depth in one step) + 2 finishing passes.
    expect(cuts.length).toBe(3);
    for (const s of cuts) {
      expect(near(s.a[0], 8)).toBe(true); // ⌀16 -> radius 8
      expect(near(s.b[0], 8)).toBe(true);
      expect(near(s.b[2], -20)).toBe(true);
    }
  });

  it('returns to the cycle start point, like G71', () => {
    const { segments } = interpret(G76_PROG, { mode: 'turn' });
    const last = segments.filter((s) => s.line === 5).pop();
    expect(near(last.b[0], 10)).toBe(true); // ⌀20 -> radius 10
    expect(near(last.b[2], 0)).toBe(true);
  });

  it('threads at the lead per revolution, regardless of the modal feed mode', () => {
    const { segments } = interpret(G76_PROG, { mode: 'turn' });
    const cut = segments.find((s) => s.line === 5 && s.type === 'feed');
    expect(cut.fm).toBe(95); // forced per-rev
    expect(near(cut.f, 1.5 * 1000)).toBe(true); // lead 1.5 mm/rev × 1000 rpm
  });

  describe('minimum cut per pass (Q of the first block)', () => {
    // A 24 TPI internal thread, 0.6 mm deep, first cut 0.1 mm, 0.02 mm left for the finish passes.
    const prog = (q) => ['G21 G90 G99 S400', 'G0 X8. Z3.', `G76 P020060 Q${q} R0.02`, 'G76 X9.525 Z-25. P600 Q100 F1.0583'].join('\n');
    const passes = (q) => interpret(prog(q), { mode: 'turn', diameterMode: true })
      .segments.filter((s) => s.line === 4 && s.type === 'feed').length;

    it('floors the shrinking increment, as a Fanuc does', () => {
      // 0.1, 0.1414, 0.1732 (the √n steps still above 0.03), then 0.03 a pass to 0.58 deep = 17 rough
      // passes, + the 2 finishing passes named by P020060. Without the floor it is 34 + 2.
      expect(passes(30)).toBe(19);
    });

    it('a tiny minimum leaves the plain √n progression', () => {
      expect(passes(1)).toBeGreaterThanOrEqual(34);
    });
  });

  it('warns and skips when the X/Z block has no thread height or first cut', () => {
    const prog = 'G21 G90\nG0 X20 Z0\nG76 P020060 Q100 R0\nG76 X16 Z-20 F1.5';
    const { stats } = interpret(prog, { mode: 'turn' });
    expect(stats.warnings.some((w) => w.includes('thread height'))).toBe(true);
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

  it('bills a tool change only when the T word actually differs, and not at all with no toolChangeSeconds', () => {
    const prog = 'G21 G90\nT0101\nG0 X10\nT0202\nG0 X20\nT0202\nG0 X30\nT0303\nG0 X40';
    const unmodelled = interpret(prog);
    expect(unmodelled.stats.toolChangeTime).toBe(0); // default: not modelled at all
    const { stats } = interpret(prog, { toolChangeSeconds: 5 });
    // T0101 (from nothing), T0202, T0303 are changes; the repeated T0202 is not.
    expect(near(stats.toolChangeTime, 15)).toBe(true);
    expect(near(stats.cycleTime, stats.rapidTime + stats.feedTime + stats.toolChangeTime)).toBe(true);
  });

  it('bills an axis index only when the A/B word actually moves to a new angle, and not at all by default', () => {
    const prog = 'G21 G90\nG0 A0\nG1 X10\nG0 A90\nG1 X20\nG0 A90\nG1 X30\nG0 A180\nG1 X40';
    const unmodelled = interpret(prog);
    expect(unmodelled.stats.rotaryIndexTime).toBe(0); // default: not modelled at all
    const { stats } = interpret(prog, { rotaryIndexSeconds: 3 });
    // A0 restates the aAxis default (0) — no real index, so it is not
    // billed. A90 and A180 each move to a genuinely new angle and are; the
    // repeated A90 right after is not. Two real indexes × 3s = 6s.
    expect(near(stats.rotaryIndexTime, 6)).toBe(true);
    expect(near(
      stats.cycleTime,
      stats.rapidTime + stats.feedTime + stats.rotaryIndexTime,
    )).toBe(true);
  });

  it('counts a B-axis index on a mill the same way, and ignores B on a lathe', () => {
    // B is a rotary index on a mill but a cycle parameter (e.g. G76's angle)
    // on a lathe — only the mill reading should ever bill it.
    const prog = 'G21 G90\nG0 B45\nG1 X10';
    const mill = interpret(prog, { mode: 'mill', rotaryIndexSeconds: 4 });
    expect(near(mill.stats.rotaryIndexTime, 4)).toBe(true);
    const turn = interpret(prog, { mode: 'turn', rotaryIndexSeconds: 4 });
    expect(turn.stats.rotaryIndexTime).toBe(0);
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

describe('parseGcode — scene coordinates are machine coordinates', () => {
  // The turned profile must stay in the X-Z plane (X = radius, Z = spindle), so
  // the viewport's Top preset — looking down Y — is the view the toolpath reads
  // in. parseGcode must not rotate anything on its way to the scene.
  const prog = 'G21 G90\nG0 X50 Z0\nG1 X50 Z-30 F0.2';

  it('keeps the turning radius on X, with Y unused', () => {
    const { bounds, feeds } = parseGcode(prog, { mode: 'turn' });
    expect(near(bounds.max[0], 25)).toBe(true); // Ø50 → radius 25, on X
    expect(near(bounds.max[1], 0)).toBe(true); // the lathe never leaves Y=0
    expect(near(bounds.min[2], -30)).toBe(true);
    expect(near(feeds[0], 25)).toBe(true); // a.x
    expect(near(feeds[1], 0)).toBe(true); // a.y
  });

  it('matches the interpreter exactly, so the simulator and the scene agree', () => {
    const machine = interpret(prog, { mode: 'turn' }).bounds;
    const scene = parseGcode(prog, { mode: 'turn' }).bounds;
    for (const key of ['min', 'max', 'feedMin', 'feedMax']) {
      expect(scene[key]).toEqual(machine[key]);
    }
  });

  it('leaves milling alone too', () => {
    const { bounds } = parseGcode('G21 G90\nG0 X10 Y20 Z-5', { mode: 'mill' });
    expect(near(bounds.max[0], 10)).toBe(true);
    expect(near(bounds.max[1], 20)).toBe(true);
  });
});

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

describe('interpreter — constant surface speed (G96 / G97 / G50)', () => {
  const turn = { mode: 'turn', diameterMode: true };
  /** Cutting minutes for one feed move at a given diameter. */
  const minutes = (src) => interpret(src, turn).stats.cycleTime / 60;
  /** Same, with extra interpreter opts (e.g. `maxTurnRpm`) merged in. */
  const minutes2 = (src, extra) => interpret(src, { ...turn, ...extra }).stats.cycleTime / 60;

  it('reads S under G96 as a surface speed, not as RPM', () => {
    // Ø30 at 200 m/min is ~2122 rpm, so 0.2 mm/rev feeds ~424 mm/min.
    // Reading S=200 as RPM would give 40 mm/min — an order of magnitude out,
    // which is what made generated lathe programs look ten times slower than
    // they run.
    const src = 'G21 G18 G99\nG96 S200 M03\nG00 X30. Z2.\nG01 Z-100. F0.2';
    expect(minutes(src)).toBeCloseTo(102 / 424, 1);
  });

  it('G97 puts the S word back to plain RPM', () => {
    const css = 'G21 G18 G99\nG96 S200 M03\nG00 X30. Z2.\nG01 Z-100. F0.2';
    const rpm = 'G21 G18 G99\nG97 S200 M03\nG00 X30. Z2.\nG01 Z-100. F0.2';
    expect(minutes(rpm)).toBeGreaterThan(minutes(css) * 5);
  });

  it('spins faster as the tool works toward centre', () => {
    // Same feed and length, smaller diameter: higher rpm, so less time.
    const big = 'G21 G18 G99\nG96 S200 M03\nG00 X60. Z2.\nG01 Z-100. F0.2';
    const small = 'G21 G18 G99\nG96 S200 M03\nG00 X10. Z2.\nG01 Z-100. F0.2';
    expect(minutes(small)).toBeLessThan(minutes(big));
  });

  it('honours the G50 clamp near centre instead of running away', () => {
    const clamped = 'G21 G18 G99\nG50 S1000\nG96 S200 M03\nG00 X0.4 Z2.\nG01 Z-100. F0.2';
    const free = 'G21 G18 G99\nG96 S200 M03\nG00 X0.4 Z2.\nG01 Z-100. F0.2';
    // Without a clamp the implied rpm is enormous and the time collapses.
    expect(minutes(clamped)).toBeGreaterThan(minutes(free));
    // 1000 rpm at 0.2 mm/rev = 200 mm/min over 102 mm.
    expect(minutes(clamped)).toBeCloseTo(102 / 200, 1);
  });

  it('leaves milling programs alone', () => {
    // G50 on a mill cancels scaling and carries no S; G96/G97 are not used.
    const { stats } = interpret('G21 G17 G94\nS2000 M03\nG00 X0 Y0\nG01 X100 F500', { mode: 'mill' });
    expect(stats.cycleTime).toBeCloseTo((100 / 500) * 60, 1);
  });

  it("honours the selected machine's own spindle ceiling when the program has no G50 of its own", () => {
    // Same regression as the G50 test above, but for a program that simply
    // never states one — which a real control would still never run past
    // its own spindle regardless. Without `maxTurnRpm` the implied rpm is
    // enormous and the time collapses toward zero.
    const free = 'G21 G18 G99\nG96 S200 M03\nG00 X0.4 Z2.\nG01 Z-100. F0.2';
    expect(minutes(free)).toBeLessThan(0.05);
    const capped = minutes2(free, { maxTurnRpm: 1000 });
    expect(capped).toBeGreaterThan(minutes(free));
    // 1000 rpm at 0.2 mm/rev = 200 mm/min over 102 mm, same arithmetic as
    // the program's-own-G50 case above.
    expect(capped).toBeCloseTo(102 / 200, 1);
  });

  it('applies whichever of the program G50 and the machine ceiling is lower', () => {
    const src = 'G21 G18 G99\nG50 S1000\nG96 S200 M03\nG00 X0.4 Z2.\nG01 Z-100. F0.2';
    // Program clamps to 1000; a slower machine clamps harder still.
    const slowMachine = minutes2(src, { maxTurnRpm: 400 });
    expect(slowMachine).toBeCloseTo(102 / (400 * 0.2), 1);
    // A faster machine than the program's own clamp changes nothing — the
    // program's G50 is still the tighter of the two.
    const fastMachine = minutes2(src, { maxTurnRpm: 5000 });
    expect(fastMachine).toBeCloseTo(minutes(src), 6);
  });
});

describe('interpreter — G96 spindle speed inside a G71 roughing cycle', () => {
  // The cycle's passes used to be timed at the rpm of the START diameter, because the expansion
  // never moved `state.pos`. A Ø35 start on a 70 m/min program ran every pass at 637 rpm instead
  // of climbing as the diameter fell, so a roughing cycle came out ~40 % too slow.
  const src = [
    'G50 S2200', 'G96 S70 M3',
    'G0 X35. Z2.',
    'G71 U1. R0.5', 'G71 P10 Q20 U0.3 W0.1 F0.2',
    'N10 G0 X10.', 'G1 Z-30.', 'N20 G1 X35.',
  ].join('\n');
  const passes = () => interpret(src, { mode: 'turn', diameterMode: true, rapidRate: 5000 })
    .segments.filter((s) => s.type !== 'rapid' && Math.abs(s.b[2] - s.a[2]) > 20);

  it('runs each rough pass at the rpm of ITS diameter, rising as the diameter falls', () => {
    const rpms = passes().map((s) => s.rpm);
    expect(rpms.length).toBeGreaterThanOrEqual(8);
    // first pass: Ø33 at 70 m/min
    expect(near(rpms[0], (1000 * 70) / (Math.PI * 33), 1)).toBe(true);
    for (let i = 1; i < rpms.length; i++) expect(rpms[i]).toBeGreaterThanOrEqual(rpms[i - 1] - 1e-6);
    expect(rpms[rpms.length - 1]).toBeGreaterThan(rpms[0] * 2.5);
    expect(Math.max(...rpms)).toBeLessThanOrEqual(2200 + 1e-6); // the G50 clamp still applies
  });

  it('feeds faster per minute on the smaller passes (F is per revolution)', () => {
    const p = passes();
    expect(p[p.length - 1].f).toBeGreaterThan(p[0].f * 2.5);
  });
});

describe('interpreter — what the control would be posting', () => {
  // Every segment carries the feed, the spindle speed and the feed mode in
  // effect while it runs, so the position page can post them beside the
  // coordinates without re-deriving a rate from a distance and a time — which
  // a dwell folded into the same segment would quietly falsify.
  it('stamps each cutting move with its feed and rpm', () => {
    const { segments } = interpret('G21 G90 G94\nS6000 M03\nG0 X10\nG1 X50 F850');
    const cut = segments[segments.length - 1];
    expect(cut.f).toBe(850);
    expect(cut.rpm).toBe(6000);
    expect(cut.fm).toBe(94);
  });

  it('keeps the feed modal across a rapid — G00 does not clear the F word', () => {
    const { segments } = interpret('G21 G90\nG1 X10 F250\nG0 X50\nG1 X60');
    expect(segments.map((s) => s.f)).toEqual([250, 250, 250]);
  });

  it('has no feed to report before the program states one', () => {
    const { segments } = interpret('G21 G90\nS1000 M03\nG0 X50');
    expect(segments[0].f).toBe(0);
    expect(segments[0].rpm).toBe(1000);
  });

  it('reports a lathe feed in mm/min but says it was programmed per rev', () => {
    // F0.15 at 1200 rpm: the stored rate is what the time is built from, and
    // `fm` is what lets the readout turn it back into the 0.15 that was typed.
    const src = 'G21 G18 G99\nG97 S1200 M03\nG00 X30. Z2.\nG01 Z-10. F0.15';
    const { segments } = interpret(src, { mode: 'turn', diameterMode: true });
    const cut = segments[segments.length - 1];
    expect(cut.fm).toBe(95);
    expect(cut.rpm).toBe(1200);
    expect(cut.f).toBeCloseTo(0.15 * 1200, 6);
  });

  it('posts the rpm G96 is actually chasing, not its S word', () => {
    const src = 'G21 G18 G99\nG96 S200 M03\nG00 X30. Z2.\nG01 Z-10. F0.2';
    const { segments } = interpret(src, { mode: 'turn', diameterMode: true });
    // Ø30 at 200 m/min: 1000·200/(π·30) ≈ 2122 rpm.
    expect(segments[segments.length - 1].rpm).toBeCloseTo(2122, 0);
  });

  it('agrees with the cycle time it was measured from', () => {
    const { segments } = interpret('G21 G90\nG1 X100 F400');
    const cut = segments[segments.length - 1];
    expect(cut.t).toBeCloseTo((100 / cut.f) * 60, 9);
  });
});

describe('parseToolTable — the tool a program says it is using', () => {
  it('reads the comment on the tool-change line', () => {
    const t = parseToolTable('T3(ENDMILL D7 L48-54 - ROUGH B2)\nM6');
    expect(t.get(3)).toMatchObject({ type: 'endmill', cutter: 'endmill', diameter: 7, length: 48 });
  });

  it("reads this app's own posted form, where the tool number is inside the comment", () => {
    // `fanuc.js` writes `(TOOL: T1 FACEMILL Ø50)` and then a bare `T1 M06`, so
    // there is no comment on the tool-change line to read. Missing this meant
    // every posted program simulated with the fallback cutter — choosing a tool
    // in the CAM panel changed nothing you could see.
    const posted = [
      '(OP1: FACE)',
      '(TOOL: T1 FACEMILL Ø50)',
      'T1 M06',
      'S1200 M03',
      '(OP2: FINISH)',
      '(TOOL: T2 BALL Ø6)',
      'T2 M06',
    ].join('\n');
    const t = parseToolTable(posted);
    expect(t.get(1)).toMatchObject({ type: 'facemill', cutter: 'face', diameter: 50, radius: 25 });
    expect(t.get(2)).toMatchObject({ type: 'ballmill', cutter: 'ball', simType: 'ball', diameter: 6 });
  });

  it('reads a decorated header comment with no TOOL keyword', () => {
    // A lathe program's own block headers — no `TOOL` keyword, just a
    // T-number, a colon and a description framed by dashes. Missing this
    // left the whole table empty, so every tool (including a drill) carved
    // as an unclassified 'od' tool — a drill at X0 then collapsed the OD to
    // 0 along the drilled length instead of boring a hole.
    const lathe = [
      '(--- T0606: FACING ---)',
      'T0606',
      '(--- T0202: DRILL DIA 8.5 MM ---)',
      'T0202',
    ].join('\n');
    const t = parseToolTable(lathe);
    expect(t.get(606)).toMatchObject({ desc: 'FACING' });
    expect(t.get(202)).toMatchObject({ type: 'drill', diameter: 8.5, radius: 4.25, desc: 'DRILL DIA 8.5 MM' });
  });

  it('reads Ø as a diameter, the way the tool library writes it', () => {
    expect(parseToolTable('T1(ENDMILL Ø12)\nM6').get(1).diameter).toBe(12);
    expect(parseToolTable('T1(DRILL Ø3.3)\nM6').get(1).radius).toBeCloseTo(1.65);
  });

  it('is not fooled by other comments that begin with TOOL', () => {
    expect(parseToolTable('(TOOLPATH: CONTOUR)\n(TOOL CHANGE POSITION)\nG0 Z50').size).toBe(0);
  });

  it('carries the cutter shape through to the whole program table', () => {
    const { stats } = interpret('(TOOL: T1 FACEMILL Ø50)\nT1 M06\nG0 X0 Y0\nG1 X10 F300', { mode: 'mill' });
    expect(stats.tools[0]).toMatchObject({ n: 1, cutter: 'face', radius: 25 });
  });
});
