/**
 * Indexed 4th-axis milling, end to end.
 *
 * The claim under test is narrow and worth stating plainly: an indexed rotary
 * is the *same* 3-axis toolpath run on the part as it looks from a new angle.
 * So these check that the geometry really is re-measured per index, that the
 * table turns before anything approaches the work, and that a job which never
 * leaves A0 is still an ordinary 3-axis program that will run anywhere.
 */
import { describe, it, expect } from 'vitest';
import { planJob, planContext, indexContext } from './plan.js';
import { autoRecipe, addStep, buildPlan, indexableKinds, toolChoicesFor } from './recipe.js';
import { post } from './post/fanuc.js';
import { checkEnvelope } from './envelope.js';
import { machineById } from './machines.js';
import { interpret } from '../gcode/interpreter.js';
import { weld } from '../mesh/stl.js';
import { box } from '../mesh/fixtures.js';

// A bar: long in X, and shallow enough in both Y and Z that a cutter can
// actually reach the full depth from either side. That is the shape indexed
// 4-axis work is *for*, and it is also the only shape where the comparison
// below means anything — roll a deep block onto its side and the honest answer
// is that nothing in the library reaches, which is a different test.
const soup = box(120, 30, 20);
const ctxFor = (opts) => planContext(soup, weld(soup), { mode: 'mill', ...opts });

/** A recipe that roughs the part from two opposite sides. */
function twoSided(ctx) {
  return addStep(autoRecipe(ctx), 'rough', ctx, { angle: 180 });
}

const ncFor = (plan, controller = 'fanuc') => post(
  {
    name: 'indexed', mode: 'mill', material: plan.material,
    stock: plan.stock, operations: plan.operations,
  },
  { controller },
);

describe('indexContext', () => {
  it('returns the part itself at A0, without re-measuring it', () => {
    const ctx = ctxFor();
    expect(indexContext(ctx, 0)).toBe(ctx);
    expect(indexContext(ctx, 360)).toBe(ctx);
  });

  it('re-measures the part at an index', () => {
    // A 120 × 30 × 20 bar rolled 90° is 120 × 20 × 30: deeper, and narrower
    // across. Both of those change which cutter fits.
    const ctx = ctxFor();
    const at90 = indexContext(ctx, 90);
    expect(at90).not.toBe(ctx);
    expect(ctx.depth).toBeCloseTo(20, 3);
    expect(at90.depth).toBeCloseTo(30, 3);
    expect(at90.footprint).toBeCloseTo(20, 3);
  });

  it('measures the same part the same way each time it is asked', () => {
    const ctx = ctxFor();
    expect(indexContext(ctx, 90)).toBe(indexContext(ctx, 90));
  });

  it('treats a negative index as the same face as its positive twin', () => {
    const ctx = ctxFor();
    expect(indexContext(ctx, -90)).toBe(indexContext(ctx, 270));
  });

  it('does not offer indexing on a lathe', () => {
    const turnCtx = planContext(soup, weld(soup), { mode: 'turn' });
    expect(indexContext(turnCtx, 90)).toBe(turnCtx);
  });
});

describe('the physical location of the A-axis (rotaryCenter)', () => {
  const withCenter = (yz) => ctxFor({ datum: { planeNormal: null, point: null, rotaryCenter: [0, ...yz] } });

  it('defaults to the frame origin — unchanged for anyone who never sets it', () => {
    expect(ctxFor().rotaryCenter).toEqual([0, 0]);
  });

  it('is derived from a picked datum point, in the working frame', () => {
    // Picked at the top face centre, Y15/Z0 in the raw (here: unreoriented) frame.
    const ctx = withCenter([15, 0]);
    expect(ctx.rotaryCenter[0]).toBeCloseTo(15, 3);
    expect(ctx.rotaryCenter[1]).toBeCloseTo(0, 3);
  });

  it('indexing rotates about the picked centre, not the frame origin', () => {
    // Rolling the bar 90° changes its *shape as measured* the same way either
    // way — depth and footprint only care about relative dimensions — but
    // *where* the result ends up depends entirely on the pivot.
    const at90Origin = indexContext(ctxFor(), 90);
    const at90Center = indexContext(withCenter([15, 0]), 90);
    expect(at90Center.depth).toBeCloseTo(at90Origin.depth, 3);
    expect(at90Center.footprint).toBeCloseTo(at90Origin.footprint, 3);
    // Rotating about a point 15mm off-axis shifts the whole result away from
    // where it would land pivoting on the origin.
    expect(at90Center.part.top).not.toBeCloseTo(at90Origin.part.top, 1);
    expect(at90Origin.part.top).toBeCloseTo(15, 2);
    expect(at90Origin.part.bottom).toBeCloseTo(-15, 2);
    expect(at90Center.part.top).toBeCloseTo(30, 2);
    expect(at90Center.part.bottom).toBeCloseTo(0, 2);
  });

  it('carries the same centre onto every derived index', () => {
    const ctx = withCenter([15, 0]);
    expect(indexContext(ctx, 90).rotaryCenter).toEqual(ctx.rotaryCenter);
    expect(indexContext(ctx, 270).rotaryCenter).toEqual(ctx.rotaryCenter);
  });
});

describe('building an indexed step', () => {
  it('tags the operation with the angle the table must be at', () => {
    const ctx = ctxFor();
    const built = buildPlan(ctx, twoSided(ctx), { material: 'aluminium' });
    const flipped = built.steps.find((s) => s.indexA === 180);
    expect(flipped).toBeTruthy();
    expect(flipped.title).toMatch(/at A180/);
    // The A0 steps stay untagged, so a 3-axis job carries no rotary baggage.
    expect(built.steps.filter((s) => s.indexA == null).length).toBeGreaterThan(0);
  });

  it('gives the indexed step its own key, so both sides survive an edit', () => {
    const ctx = ctxFor();
    const recipe = twoSided(ctx);
    const keys = recipe.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('rough');
    expect(keys).toContain('rough@A180');
  });

  it('cuts different geometry at a different index', () => {
    // The whole point: this is not the same toolpath emitted twice.
    const ctx = ctxFor();
    const recipe = addStep(autoRecipe(ctx), 'rough', ctx, { angle: 90 });
    const built = buildPlan(ctx, recipe, { material: 'aluminium' });
    const front = built.steps.find((s) => s.kind === 'rough' && s.indexA == null);
    const side = built.steps.find((s) => s.indexA === 90);
    expect(side.cutLength).not.toBeCloseTo(front.cutLength, 1);
  });

  it('judges which tools fit from the indexed orientation', () => {
    // Rolled on its side the bar is 20 mm across instead of 30, so the biggest
    // cutter that can get round it is smaller.
    const ctx = ctxFor();
    const flat = toolChoicesFor('rough', ctx).filter((c) => c.fits).map((c) => c.tool.diameter);
    const rolled = toolChoicesFor('rough', ctx, { angle: 90 }).filter((c) => c.fits).map((c) => c.tool.diameter);
    expect(Math.max(...rolled)).toBeLessThan(Math.max(...flat));
  });

  it('refuses to index an operation that cannot be indexed', () => {
    // Holes are detected against one orientation; an indexed drill step would
    // silently drill nothing.
    const ctx = ctxFor();
    const recipe = autoRecipe(ctx);
    expect(addStep(recipe, 'drill', ctx, { angle: 90 })).toBe(recipe);
    expect(indexableKinds('mill').map((k) => k.kind)).not.toContain('drill');
  });
});

describe('posting a rotary index', () => {
  it('writes the A word', () => {
    const ctx = ctxFor();
    const plan = planJob(soup, weld(soup), { ctx, recipe: twoSided(ctx), machineId: 'mazak-vcn530c-4th' });
    expect(ncFor(plan)).toMatch(/^G00 A180\.$/m);
  });

  it('turns the table before the tool approaches the work', () => {
    // Turning a table with the cutter down in a pocket destroys both.
    const ctx = ctxFor();
    const plan = planJob(soup, weld(soup), { ctx, recipe: twoSided(ctx), machineId: 'mazak-vcn530c-4th' });
    const lines = ncFor(plan).split('\n');
    const index = lines.findIndex((l) => /A180\./.test(l));
    const firstZ = lines.findIndex((l, i) => i > index && /Z-/.test(l));
    expect(index).toBeGreaterThan(-1);
    expect(firstZ).toBeGreaterThan(index);
    // ...and it follows a tool change, where the spindle is clear.
    expect(lines.slice(0, index).some((l) => /M06/.test(l))).toBe(true);
  });

  it('keeps the A word modal', () => {
    const ctx = ctxFor();
    let recipe = addStep(autoRecipe(ctx), 'rough', ctx, { angle: 180 });
    recipe = addStep(recipe, 'finish', ctx, { angle: 180 });
    const plan = planJob(soup, weld(soup), { ctx, recipe, machineId: 'mazak-vcn530c-4th' });
    const written = ncFor(plan).split('\n').filter((l) => /A180\./.test(l));
    expect(written).toHaveLength(1);
  });

  it('tells the operator to index by hand on a control with no rotary', () => {
    const ctx = ctxFor();
    const plan = planJob(soup, weld(soup), { ctx, recipe: twoSided(ctx), machineId: 'router-grbl' });
    const nc = ncFor(plan, 'grbl');
    // No rotary *word* — but the operator is told, in the file, at the point
    // where the table would have turned.
    expect(nc).not.toMatch(/^G00 A/m);
    expect(nc).toMatch(/INDEX TO A180 BY HAND/);
  });

  it('writes no A at all for a job that never leaves A0', () => {
    // A 3-axis job must stay a 3-axis file, or it stops running on the 3-axis
    // machines that make up most of the shop.
    const plan = planJob(soup, weld(soup), { mode: 'mill', machineId: 'haas-vf2' });
    expect(ncFor(plan)).not.toMatch(/\bA-?\d/);
  });

  it('still parses back through our own interpreter', () => {
    const ctx = ctxFor();
    const plan = planJob(soup, weld(soup), { ctx, recipe: twoSided(ctx), machineId: 'mazak-vcn530c-4th' });
    const { segments } = interpret(ncFor(plan), { mode: 'mill' });
    expect(segments.length).toBeGreaterThan(20);
  });
});

describe('the envelope knows it is a 4-axis program', () => {
  it('counts A once the table is used', () => {
    const ctx = ctxFor();
    const plan = planJob(soup, weld(soup), { ctx, recipe: twoSided(ctx), machineId: 'mazak-vcn530c-4th' });
    expect(plan.envelope.axes.required).toEqual(['X', 'Y', 'Z', 'A']);
    expect(plan.envelope.axes.missing).toEqual([]);
    expect(plan.envelope.axes.unused).toEqual([]);
  });

  it('stops warning about an idle rotary once the rotary is used', () => {
    const ctx = ctxFor();
    const plan = planJob(soup, weld(soup), { ctx, recipe: twoSided(ctx), machineId: 'mazak-vcn530c-4th' });
    expect(plan.warnings.some((w) => /rotary on A/.test(w))).toBe(false);
  });

  it('refuses the same program on a 3-axis machine, by name', () => {
    const ctx = ctxFor();
    const plan = planJob(soup, weld(soup), { ctx, recipe: twoSided(ctx), machineId: 'haas-vf2' });
    expect(plan.envelope.axes.missing).toEqual(['A']);
    expect(plan.warnings.some((w) => /commands A.*does not have/.test(w))).toBe(true);
  });

  it('counts a program parked at one non-zero angle as needing the rotary', () => {
    // It never *moves* A, and it still cannot run without one.
    const check = checkEnvelope(machineById('haas-vf2'), {
      mode: 'mill',
      operations: [{ indexA: 90, moves: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 5, z: -2 }] }],
    });
    expect(check.axes.required).toContain('A');
    expect(check.axes.missing).toEqual(['A']);
  });
});
