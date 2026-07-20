import { describe, it, expect } from 'vitest';
import { planJob, planSummary } from './plan.js';
import { parseSTL, weld } from '../mesh/stl.js';
import { post } from './post/fanuc.js';
import { interpret } from '../gcode/interpreter.js';
import {
  box, cylinder, turnedShaft, groovedShaft, tube, revolveOutline,
} from '../mesh/fixtures.js';

const plan = (soup, opts) => planJob(soup, weld(soup), opts);

describe('planJob — routing', () => {
  it('sends a solid of revolution to the lathe', () => {
    expect(plan(cylinder(15, 40, 48)).mode).toBe('turn');
  });

  it('sends a prismatic part to the mill', () => {
    expect(plan(box(60, 40, 20)).mode).toBe('mill');
  });

  it('honours an explicit mode over the recommendation', () => {
    expect(plan(cylinder(15, 40, 48), { mode: 'mill' }).mode).toBe('mill');
  });
});

describe('planJob — turning', () => {
  const p = plan(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 }), { material: 'mild-steel' });

  it('orders the operations the way the machining forces', () => {
    expect(p.steps.map((s) => s.kind)).toEqual(['face', 'rough', 'finish', 'part']);
  });

  it('gives every step a reason naming a measurement', () => {
    for (const s of p.steps) {
      expect(s.why.length).toBeGreaterThan(20);
      expect(s.tool).toBeTruthy();
    }
    expect(p.steps[1].why).toMatch(/mm of stock/);
  });

  it('recommends a spindle speed and feed for every step', () => {
    for (const s of p.steps) {
      expect(s.speeds.rpm).toBeGreaterThan(0);
      expect(s.speeds.vc).toBeGreaterThan(0);
      expect(s.speeds.fn).toBeGreaterThan(0);
    }
  });

  it('finishes lighter than it roughs', () => {
    const rough = p.steps.find((s) => s.kind === 'rough');
    const finish = p.steps.find((s) => s.kind === 'finish');
    expect(finish.speeds.fn).toBeLessThan(rough.speeds.fn);
  });

  it('estimates a cycle time', () => {
    expect(p.totalMinutes).toBeGreaterThan(0);
    expect(p.totalMinutes).toBeLessThan(600);
  });

  it('sizes the bar over the largest diameter', () => {
    expect(p.stock.radius).toBeGreaterThan(15);
    expect(p.stock.radius).toBeLessThan(18);
  });

  it('adds a grooving operation, with the right blade, when there is a groove', () => {
    const g = plan(groovedShaft({ radius: 15, length: 60, grooveZ: 30, grooveWidth: 4, grooveDepth: 3 }));
    const groove = g.steps.find((s) => s.kind === 'groove');
    expect(groove).toBeTruthy();
    // A 4 mm groove takes the 3 mm blade, not the 2 mm one.
    expect(groove.tool).toMatch(/3 mm/);
    expect(groove.why).toMatch(/cannot reach it/);
  });

  it('warns instead of guessing when no blade fits the groove', () => {
    const narrow = plan(revolveOutline([
      { z: 0, r: 0 }, { z: 0, r: 15 },
      { z: 20, r: 15 }, { z: 20, r: 13 }, { z: 21, r: 13 }, { z: 21, r: 15 },
      { z: 40, r: 15 }, { z: 40, r: 0 },
    ], 64));
    expect(narrow.steps.some((s) => s.kind === 'groove')).toBe(false);
    expect(narrow.warnings.some((w) => /narrower than any blade/.test(w))).toBe(true);
  });

  it('plans a boring pass for a tube', () => {
    const t = plan(tube(25, 12, 40, 64));
    expect(t.mode).toBe('turn');
    expect(t.steps.some((s) => s.kind === 'bore')).toBe(true);
  });

  it('can be told to leave the part on the bar', () => {
    const noPart = plan(turnedShaft(), { partOff: false });
    expect(noPart.steps.some((s) => s.kind === 'part')).toBe(false);
  });
});

describe('planJob — milling', () => {
  const p = plan(box(60, 40, 15), { material: 'aluminium' });

  it('faces, roughs, then finishes', () => {
    const kinds = p.steps.map((s) => s.kind);
    expect(kinds).toContain('face');
    expect(kinds).toContain('rough');
    expect(kinds.indexOf('face')).toBeLessThan(kinds.indexOf('rough'));
  });

  it('picks a bigger tool for roughing than the part is narrow', () => {
    const rough = p.steps.find((s) => s.kind === 'rough');
    expect(rough.speeds.rpm).toBeGreaterThan(0);
    expect(rough.speeds.feed).toBeGreaterThan(0);
  });

  it('lays a part modelled on end down before planning it', () => {
    // Regression, from a real fork STL: modelled standing up its long axis, it
    // read as a 67 mm deep pocket, no cutter in the library reached it, and the
    // planner returned an empty program.
    const standing = box(18, 17, 67);
    const q = plan(standing, { material: 'stainless' });
    expect(q.orientation.changed).toBe(true);
    expect(q.orientation.depth).toBeCloseTo(17, 3);
    expect(q.steps.length).toBeGreaterThan(0);
    expect(q.warnings[0]).toMatch(/^Setup:/);
  });

  it('roughs with a big cutter even when a narrow slot needs a small one', () => {
    // The two are different constraints. Requiring one tool to satisfy both is
    // what made a real part come back unmachinable.
    const p2 = plan(box(60, 40, 15), { material: 'aluminium' });
    const rough = p2.steps.find((s) => s.kind === 'rough');
    expect(rough).toBeTruthy();
    expect(rough.tool).toMatch(/Endmill/);
  });

  it('still produces a plan when no cutter reaches full depth, and says so', () => {
    // A 50 mm cube is 50 mm deep whichever way it is laid down, and the longest
    // endmill in the library has 45 mm of flute. Better a partial plan with an
    // explicit warning than silence.
    const q = plan(box(50, 50, 50), { material: 'mild-steel' });
    expect(q.steps.length).toBeGreaterThan(0);
    expect(q.warnings.some((w) => /flute/.test(w))).toBe(true);
  });

  it('is candid that inside corners are not analysed yet', () => {
    expect(p.warnings.some((w) => /Inside corner radii are not analysed/.test(w))).toBe(true);
  });

  it('leaves stock around the part on every side', () => {
    expect(p.stock.minX).toBeLessThan(-30);
    expect(p.stock.maxX).toBeGreaterThan(30);
    expect(p.stock.top).toBeGreaterThan(7.5);
  });

  it('drills a round hole before roughing it', () => {
    // A plate with a through hole: the hole must be drilled, and drilled first.
    const plate = box(60, 40, 12);
    // The void must span the plate exactly. A cylinder sticking out past the
    // faces would enlarge the part bounds, and the planner would then probe for
    // holes above the plate entirely — where there is no plate to have one.
    const holeMesh = cylinder(5, 12, 48);
    for (let i = 2; i < holeMesh.positions.length; i += 3) holeMesh.positions[i] -= 6;
    // Flip the cylinder inside out so it reads as a void.
    for (let t = 0; t < holeMesh.triangleCount; t++) {
      const b = t * 9;
      for (let k = 0; k < 3; k++) {
        const tmp = holeMesh.positions[b + 3 + k];
        holeMesh.positions[b + 3 + k] = holeMesh.positions[b + 6 + k];
        holeMesh.positions[b + 6 + k] = tmp;
      }
    }
    const merged = new Float32Array(plate.positions.length + holeMesh.positions.length);
    merged.set(plate.positions);
    merged.set(holeMesh.positions, plate.positions.length);
    const soup = { positions: merged, triangleCount: plate.triangleCount + holeMesh.triangleCount };

    const q = plan(soup, { material: 'aluminium' });
    const drill = q.steps.find((s) => s.kind === 'drill');
    expect(drill).toBeTruthy();
    expect(drill.tool).toMatch(/Drill/);
    expect(q.steps.indexOf(drill)).toBeLessThan(q.steps.findIndex((s) => s.kind === 'rough'));
    expect(drill.why).toMatch(/cannot wander/);
  });
});

describe('planJob — material sensitivity', () => {
  it('runs titanium slower than aluminium for the same part', () => {
    const al = plan(cylinder(15, 40, 48), { material: 'aluminium' });
    const ti = plan(cylinder(15, 40, 48), { material: 'titanium' });
    const rpmOf = (p) => p.steps.find((s) => s.kind === 'rough').speeds.vc;
    expect(rpmOf(ti)).toBeLessThan(rpmOf(al));
    expect(ti.totalMinutes).toBeGreaterThan(al.totalMinutes);
  });
});

describe('planSummary', () => {
  it('is small enough to hand to a language model', () => {
    const s = planSummary(plan(turnedShaft()));
    const json = JSON.stringify(s);
    expect(json.length).toBeLessThan(6000);
    expect(s.steps[0]).toHaveProperty('why');
    expect(s.steps[0]).toHaveProperty('rpm');
    expect(s.material).toMatch(/Alumin/);
  });

  it('reports the rotational axis only when there is one', () => {
    expect(planSummary(plan(cylinder(10, 30, 48))).rotationalAxis).toBe('z');
    expect(planSummary(plan(box(30, 20, 10))).rotationalAxis).toBeNull();
  });
});

describe('plan -> post -> interpret', () => {
  // The end-to-end contract: an STL goes in, and the NC that comes out parses
  // and describes motion inside the stock it was planned against.
  it('closes the loop for a turned part', () => {
    const p = plan(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 }), { material: 'mild-steel' });
    const nc = post({ name: 'shaft', mode: 'turn', material: p.material, stock: p.stock, operations: p.operations });
    const { segments } = interpret(nc, { mode: 'turn', diameterMode: true });
    expect(segments.length).toBeGreaterThan(20);
    const radii = segments.flatMap((s) => [s.a[0], s.b[0]]);
    expect(Math.max(...radii)).toBeLessThanOrEqual(p.stock.radius + 2.001);
  });

  it('closes the loop for a milled part', () => {
    const p = plan(box(60, 40, 15), { material: 'aluminium' });
    const nc = post({ name: 'plate', mode: 'mill', material: p.material, stock: p.stock, operations: p.operations });
    const { segments } = interpret(nc, { mode: 'mill' });
    expect(segments.length).toBeGreaterThan(20);
    const zs = segments.flatMap((s) => [s.a[2], s.b[2]]);
    // Nothing cuts below the bottom of the part.
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-7.5 - 0.01);
  });

  it('survives a round trip through a real STL file', () => {
    // Write the fixture out as binary STL and read it back, so the whole chain
    // from file bytes to NC is covered rather than just the in-memory path.
    const soup = turnedShaft({ r1: 12, z1: 20, r2: 7, z2: 35 });
    const buf = new ArrayBuffer(84 + soup.triangleCount * 50);
    const view = new DataView(buf);
    view.setUint32(80, soup.triangleCount, true);
    let o = 84;
    for (let t = 0; t < soup.triangleCount; t++) {
      o += 12; // leave the normal at zero; the reader recomputes what it needs
      for (let v = 0; v < 9; v++) { view.setFloat32(o, soup.positions[t * 9 + v], true); o += 4; }
      o += 2;
    }
    const reread = parseSTL(buf);
    expect(reread.triangleCount).toBe(soup.triangleCount);

    const p = planJob(reread, weld(reread), { material: 'mild-steel' });
    expect(p.mode).toBe('turn');
    const nc = post({ name: 'from stl', mode: 'turn', material: p.material, stock: p.stock, operations: p.operations });
    expect(() => interpret(nc, { mode: 'turn', diameterMode: true })).not.toThrow();
    expect(nc).toContain('M30');
  });
});
