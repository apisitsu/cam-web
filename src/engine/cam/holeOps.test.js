import { describe, it, expect } from 'vitest';
import { planJob } from './plan.js';
import { post } from './post/fanuc.js';
import { verifyCut } from './verify.js';
import { entry } from './recipe.js';
import { interpret } from '../gcode/interpreter.js';
import { weld } from '../mesh/stl.js';
import { extrudeRegion } from '../solid/extrude.js';
import { holeSolid, holeRecords, holeSection } from '../solid/hole.js';
import { meshBoolean } from '../../lib/csg.js';

const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const top = { preset: 'XY', offset: 20 };

/** A 60 × 40 × 20 plate with every kind of Hole Wizard hole in it. */
function drilledPlate() {
  const kinds = [
    [{ holeType: 'drill', diameter: 6, chamfer: 0.5 }, [[-20, -10]], { depth: 12 }],
    [{ holeType: 'tap', thread: 'M8', threadDepth: 10, chamfer: 0.5 }, [[0, -10]], { depth: 15 }],
    [{ holeType: 'cbore', diameter: 6.6, cbDiameter: 11, cbDepth: 6.5 }, [[20, -10]], { depth: 21, through: true }],
    [{ holeType: 'csk', diameter: 6.6, cskDiameter: 12, cskAngle: 90 }, [[-20, 10]], { depth: 21, through: true }],
  ];
  let soup = extrudeRegion({ outer: square(-30, -20, 30, 20) }, { depth: 20 });
  const holes = [];
  for (const [spec, at, shape] of kinds) {
    soup = meshBoolean(soup, holeSolid(at, top, spec, shape), 'cut');
    holes.push(...holeRecords(at, top, spec, shape));
  }
  return { soup, holes };
}

const program = (plan) => post({
  name: 'p', mode: 'mill', operations: plan.operations, stock: plan.stock,
});

describe('holeSection with a mouth chamfer', () => {
  it('opens the mouth 45° wider by the chamfer', () => {
    const pts = holeSection({ holeType: 'drill', diameter: 6, chamfer: 1 }, 10, false);
    const pairs = [];
    for (let i = 0; i < pts.length; i += 2) pairs.push([pts[i], pts[i + 1]]);
    expect(pairs).toContainEqual([1, 3]);
    expect(pairs.some(([a, r]) => a < 0 && Math.abs(r - (3 + 1 - a)) < 1e-9)).toBe(true);
  });
});

describe('Hole Wizard holes through to NC', () => {
  const { soup, holes } = drilledPlate();
  const plan = planJob(soup, weld(soup), { material: 'aluminium', mode: 'mill', cad: { holes } });
  const kinds = plan.steps.map((s) => s.kind);
  const nc = program(plan);

  it('plans spot, drill, countersink, tap and counterbore', () => {
    for (const k of ['spot', 'drill', 'csink', 'tap', 'cbore']) expect(kinds).toContain(k);
    expect(kinds.indexOf('spot')).toBeLessThan(kinds.indexOf('drill'));
    expect(kinds.indexOf('drill')).toBeLessThan(kinds.indexOf('tap'));
  });

  it('drills each hole with the drill of its exact size, never over it', () => {
    const drills = plan.steps.filter((s) => s.kind === 'drill').map((s) => s.tool).sort();
    expect(drills).toEqual(['Drill Ø6', 'Drill Ø6.6', 'Drill Ø6.8']);
  });

  it('taps with G84 at S × pitch', () => {
    const line = nc.split('\n').find((l) => l.startsWith('G84'));
    expect(line).toMatch(/X0\. Y-10\. Z10\./);
    const tap = plan.steps.find((s) => s.kind === 'tap');
    const feed = Number(line.match(/F([\d.]+)/)[1]);
    expect(feed).toBeCloseTo(tap.speeds.rpm * 1.25, 3);
  });

  it('spots the chamfered holes to the chamfer diameter', () => {
    const spot = plan.operations.find((o) => o.kind === 'spot');
    // Ø6 + 2 × 0.5 chamfer with a 90° point: 3.5 mm down from the face.
    const plain = spot.moves.find((m) => m.x === -20);
    expect(plain.z).toBeCloseTo(20 - 3.5, 3);
  });

  it('drills the counterbored hole at the hole size and mills the counterbore', () => {
    const cbore = plan.operations.find((o) => o.kind === 'cbore');
    expect(cbore.tool.diameter).toBeLessThan(11);
    const deepest = Math.min(...cbore.moves.filter((m) => m.t === 'feed').map((m) => m.z));
    expect(deepest).toBeCloseTo(20 - 6.5, 3);
    expect(nc).toMatch(/^G0[23] /m);
  });

  it('reads back through the interpreter', () => {
    expect(() => interpret(nc, { mode: 'mill' })).not.toThrow();
  });

  it('cuts no part material', () => {
    const result = verifyCut(plan, nc);
    expect(result.gouge.cells).toBe(0);
  });
});

describe('pocket and profile from a sketch', () => {
  const pocket = { outer: square(-10, -6, 10, 6) };
  const base = () => extrudeRegion({ outer: square(-30, -20, 30, 20) }, { depth: 20 });
  const sketch = (regions, extra) => ({
    sketchId: 7, name: 'S7', plane: top, regions, ...extra,
  });

  it('pockets what the sketch encloses, to depth, without touching the rest', () => {
    const soup = meshBoolean(base(), extrudeRegion(pocket, { depth: 5, plane: top, base: -5 }), 'cut');
    const recipe = [entry('pocket', 'em6', { target: sketch([pocket], { depth: 5 }) })];
    const plan = planJob(soup, weld(soup), { material: 'aluminium', mode: 'mill', recipe });
    const op = plan.operations[0];
    expect(op.kind).toBe('pocket');
    const feeds = op.moves.filter((m) => m.t === 'feed');
    expect(Math.min(...feeds.map((m) => m.z))).toBeCloseTo(15, 3);
    for (const m of feeds) {
      expect(Math.abs(m.x)).toBeLessThanOrEqual(10 - 3 + 1e-3);
      expect(Math.abs(m.y)).toBeLessThanOrEqual(6 - 3 + 1e-3);
    }
    expect(verifyCut(plan, program(plan)).gouge.cells).toBe(0);
  });

  it('profiles outside a boss and writes its round end as arcs', () => {
    const n = 48;
    const disc = { outer: Array.from({ length: n }, (_, k) => [8 * Math.cos((2 * Math.PI * k) / n), 8 * Math.sin((2 * Math.PI * k) / n)]).flat() };
    // Shorter than it is wide, so the planner leaves it standing as drawn.
    const soup = extrudeRegion(disc, { depth: 5 });
    const recipe = [entry('profile', 'em6', {
      target: sketch([disc], { depth: 4, side: 'outside', plane: { preset: 'XY', offset: 5 } }),
    })];
    const plan = planJob(soup, weld(soup), { material: 'aluminium', mode: 'mill', recipe });
    const op = plan.operations[0];
    for (const m of op.moves.filter((x) => x.t === 'feed')) {
      expect(Math.hypot(m.x, m.y)).toBeGreaterThanOrEqual(8 + 3 - 0.02);
    }
    expect(program(plan)).toMatch(/^G0[23] /m);
  });

  it('refuses a sketch that is not flat in the setup', () => {
    const soup = base();
    const recipe = [entry('pocket', 'em6', {
      target: sketch([pocket], { depth: 2, plane: { preset: 'XZ', offset: 0 } }),
    })];
    const plan = planJob(soup, weld(soup), { material: 'aluminium', mode: 'mill', recipe });
    expect(plan.operations).toHaveLength(0);
    expect(plan.warnings.join(' ')).toMatch(/not flat/);
  });
});
