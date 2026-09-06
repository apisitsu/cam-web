import { describe, it, expect } from 'vitest';
import { postTurning, postMilling, post } from './fanuc.js';
import { interpret } from '../../gcode/interpreter.js';
import { weld } from '../../mesh/stl.js';
import { turningProfile } from '../../mesh/profile.js';
import { turnedShaft, groovedShaft } from '../../mesh/fixtures.js';
import { roughingOp, finishingOp, facingOp, groovingOp, partingOp, cutLengthOf } from '../toolpath/turn.js';
import { toolById } from '../library.js';

const roughTool = toolById('cnmg-rough');
const finishTool = toolById('dnmg-finish');
const grooveTool = toolById('groove-3');
const partTool = toolById('part-3');

/** Build a real turning program from a real mesh, the way the planner will. */
function turningProgram(mesh, extra = {}) {
  const profile = turningProfile(weld(mesh), 'z');
  const stock = { radius: profile.maxRadius + 1.5, zMin: profile.zMin, zMax: profile.zMax + 2 };
  const base = { material: 'mild-steel', stock, machine: undefined };
  const operations = [
    facingOp(profile, { ...base, tool: roughTool }),
    roughingOp(profile, { ...base, tool: roughTool }),
    finishingOp(profile, { ...base, tool: finishTool }),
    ...profile.recesses.map((r) => groovingOp(r, { ...base, tool: grooveTool })),
    partingOp(profile, { ...base, tool: partTool }),
  ].filter(Boolean);
  return { name: 'test part', mode: 'turn', material: 'mild-steel', stock, operations, profile, ...extra };
}

describe('postTurning', () => {
  const program = turningProgram(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 }));
  const nc = postTurning(program);

  it('wraps the program in the standard Fanuc envelope', () => {
    const lines = nc.split('\n');
    expect(lines[0]).toBe('%');
    expect(lines[lines.length - 1]).toBe('%');
    expect(lines[1]).toMatch(/^O0001 \(TEST PART\)$/);
    expect(nc).toContain('M30');
  });

  it('carries the safety warnings the operator has to see', () => {
    expect(nc).toContain('VERIFY BEFORE CUTTING');
    expect(nc).toContain('(NO COLLISION OR HOLDER CHECK WAS PERFORMED)');
    expect(nc).toContain('(SPEEDS AND FEEDS ARE STARTING POINTS ONLY)');
    expect(nc).toContain('(DRY RUN WITH THE TOOL CLEAR OF THE PART FIRST)');
  });

  it('never nests parentheses, which Fanuc cannot parse', () => {
    for (const line of nc.split('\n')) {
      if (!line.startsWith('(')) continue;
      expect(line.slice(1, -1)).not.toMatch(/[()]/);
    }
  });

  it('sets the lathe modes a turning program needs', () => {
    expect(nc).toContain('G21 G18 G40 G99'); // metric, ZX plane, feed per rev
    expect(nc).toMatch(/G50 S\d+/);          // clamp before constant surface speed
    expect(nc).toMatch(/G96 S\d+ M03/);
  });

  it('doubles X into diameter, and leaves it alone when told not to', () => {
    // The part's big diameter is 30, so a roughing pass must show X30-ish.
    const dia = postTurning(program, { diameterMode: true });
    const rad = postTurning(program, { diameterMode: false });
    const maxX = (text) => Math.max(...[...text.matchAll(/X(-?[\d.]+)/g)].map((m) => parseFloat(m[1])));
    expect(maxX(dia)).toBeCloseTo(maxX(rad) * 2, 1);
    expect(dia).toContain('(X IS DIAMETER)');
    expect(rad).toContain('(X IS RADIUS)');
  });

  it('numbers turret stations and offsets together', () => {
    expect(nc).toContain('T0101');
    expect(nc).toContain('T0202');
  });

  it('writes every number with a decimal point', () => {
    // A bare X10 is microns on some controls — every coordinate must be explicit.
    const words = [...nc.matchAll(/(?:^|\s)([XYZRF])(-?[\d.]+)/g)];
    expect(words.length).toBeGreaterThan(10);
    for (const [, letter, value] of words) {
      // eslint-disable-next-line jest/valid-expect
      expect(value, `${letter}${value}`).toMatch(/\./);
    }
  });

  it('drops words that have not changed', () => {
    // Consecutive Z-only feeds must not repeat X.
    expect(nc).toMatch(/^G01 Z-?[\d.]+/m);
  });
});

describe('round trip: post -> interpret', () => {
  // The whole point of building the reader first: the generated program is
  // checked by running it back through the interpreter the app already ships.
  const program = turningProgram(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 }));
  const nc = postTurning(program, { diameterMode: true });

  it('parses without error and produces motion', () => {
    const { segments } = interpret(nc, { mode: 'turn', diameterMode: true });
    expect(segments.length).toBeGreaterThan(20);
  });

  it('retraces the same envelope the toolpath described', () => {
    const { segments } = interpret(nc, { mode: 'turn', diameterMode: true });
    let maxR = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of segments) {
      for (const p of [s.a, s.b]) {
        maxR = Math.max(maxR, p[0]);
        minZ = Math.min(minZ, p[2]);
        maxZ = Math.max(maxZ, p[2]);
      }
    }
    // Interpreter halves the diameter back to a radius, so this closes the loop
    // on the diameter-mode conversion in both directions.
    const stockR = program.stock.radius;
    const clearance = 2;
    expect(maxR).toBeCloseTo(stockR + clearance, 1); // the clearance plane
    // Everything stays inside the bar: no move runs off the end of the stock,
    // and none reaches past the parting cut at the chuck end.
    expect(maxZ).toBeLessThanOrEqual(program.stock.zMax + clearance + 1e-6);
    expect(maxZ).toBeGreaterThan(program.profile.zMax);
    expect(minZ).toBeCloseTo(program.profile.zMin, 1);
  });

  it('reaches the finished radius of every diameter on the part', () => {
    const { segments } = interpret(nc, { mode: 'turn', diameterMode: true });
    const feedRadii = segments.filter((s) => s.type !== 'rapid').flatMap((s) => [s.a[0], s.b[0]]);
    // The 8 mm radius step and the 15 mm radius body must both be cut.
    expect(feedRadii.some((r) => Math.abs(r - 8) < 0.3)).toBe(true);
    expect(feedRadii.some((r) => Math.abs(r - 15) < 0.3)).toBe(true);
  });

  it('cuts the groove floor when the part has a groove', () => {
    const grooved = turningProgram(groovedShaft({
      radius: 15, length: 60, grooveZ: 30, grooveWidth: 4, grooveDepth: 3,
    }));
    expect(grooved.profile.recesses).toHaveLength(1);
    const text = postTurning(grooved);
    const { segments } = interpret(text, { mode: 'turn', diameterMode: true });
    const feedRadii = segments.filter((s) => s.type !== 'rapid').flatMap((s) => [s.a[0], s.b[0]]);
    // Groove floor sits at radius 12 and only the blade reaches it.
    expect(feedRadii.some((r) => Math.abs(r - 12) < 0.3)).toBe(true);
  });

  it('never plunges the profiling tool into the groove', () => {
    // Roughing and finishing run off the filled profile, so their deepest cut
    // in the groove's Z range must stop at the shoulder, not the floor.
    const profile = turningProfile(weld(groovedShaft({
      radius: 15, length: 60, grooveZ: 30, grooveWidth: 4, grooveDepth: 3,
    })), 'z');
    const stock = { radius: profile.maxRadius + 1.5, zMin: profile.zMin, zMax: profile.zMax + 2 };
    const finish = finishingOp(profile, { material: 'mild-steel', stock, tool: finishTool });
    const g = profile.recesses[0];
    const inGroove = finish.moves.filter((m) => m.z > g.zStart && m.z < g.zEnd);
    for (const m of inGroove) expect(m.x).toBeGreaterThan(g.minRadius + 1);
  });
});

describe('postMilling', () => {
  const op = {
    kind: 'contour', name: 'Contour', tool: toolById('em10'),
    speeds: { rpm: 3000, feed: 500 },
    moves: [
      { t: 'rapid', x: 0, y: 0, z: 5 },
      { t: 'feed', x: 0, y: 0, z: -2 },
      { t: 'feed', x: 50, y: 0, z: -2 },
      { t: 'feed', x: 50, y: 30, z: -2 },
      { t: 'rapid', x: 50, y: 30, z: 5 },
    ],
    notes: [],
  };
  const program = {
    name: 'plate', mode: 'mill', material: 'aluminium',
    stock: { sizeX: 100, sizeY: 60, sizeZ: 20 },
    operations: [op],
  };
  const nc = postMilling(program);

  it('sets the mill safety modes and clears them at the end', () => {
    expect(nc).toContain('G21 G17 G40 G49 G80 G90');
    expect(nc).toContain('G49');       // length comp cancelled
    expect(nc).toContain('G91 G28 Z0.'); // retract before end
    expect(nc).toContain('M30');
  });

  it('applies tool length compensation on the way in', () => {
    expect(nc).toMatch(/G43 H1 Z50\./);
    expect(nc).toContain('T1 M06');
    expect(nc).toContain('S3000 M03');
  });

  it('round trips through the interpreter to the same corner', () => {
    const { segments } = interpret(nc, { mode: 'mill' });
    const pts = segments.flatMap((s) => [s.a, s.b]);
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(50, 3);
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(30, 3);
    expect(Math.min(...pts.map((p) => p[2]))).toBeCloseTo(-2, 3);
  });

  it('emits a drilling cycle rather than point moves', () => {
    const drillOp = {
      kind: 'drill', name: 'Drill', tool: toolById('dr8'),
      speeds: { rpm: 2000, feed: 300 },
      moves: [
        { cycle: 'G83', x: 10, y: 10, z: -25, r: 2, peck: 6 },
        { cycle: 'G83', x: 30, y: 10, z: -25, r: 2, peck: 6 },
      ],
      notes: [],
    };
    const text = postMilling({ ...program, operations: [drillOp] });
    expect(text).toMatch(/G83 X10\. Y10\. Z-25\. R2\. Q6\. F300\./);
  });
});

describe('post dispatch', () => {
  it('routes by machine mode', () => {
    const turn = turningProgram(turnedShaft());
    expect(post(turn)).toContain('G18');
    expect(post({ name: 'x', mode: 'mill', operations: [] })).toContain('G17');
  });
});

describe('cutLengthOf', () => {
  it('counts feed moves only', () => {
    const moves = [
      { t: 'rapid', x: 0, z: 0 },
      { t: 'rapid', x: 100, z: 0 },
      { t: 'feed', x: 100, z: -50 },
    ];
    expect(cutLengthOf(moves)).toBeCloseTo(50, 6);
  });
});
