import { describe, it, expect } from 'vitest';
import { planContext, planJob } from './plan.js';
import {
  autoRecipe, buildPlan, toolChoicesFor, operationKindsFor, defaultToolFor,
  setStepTool, toggleStep, moveStep, removeStep, addStep, reconcile,
} from './recipe.js';
import { machineById } from './machines.js';
import { weld } from '../mesh/stl.js';
import { box, cylinder, turnedShaft, groovedShaft, tube } from '../mesh/fixtures.js';

const ctxFor = (soup, opts) => planContext(soup, weld(soup), opts);
const build = (ctx, recipe, opts = {}) => buildPlan(ctx, recipe, { material: 'aluminium', ...opts });

describe('toolChoicesFor', () => {
  const ctx = ctxFor(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 }));

  it('offers only tools that could physically do the operation', () => {
    const types = new Set(toolChoicesFor('groove', ctx).map((c) => c.tool.type));
    expect(types).toEqual(new Set(['turn-groove']));
  });

  it('keeps tools that do not fit, with the reason', () => {
    // The operator is allowed to know the Ø16 bar exists and why it was
    // refused. A dropdown that silently omits half the crib looks broken.
    const bores = toolChoicesFor('bore', ctx);
    expect(bores.length).toBeGreaterThan(0);
    expect(bores.every((c) => !c.fits)).toBe(true);       // this shaft is solid
    expect(bores[0].reason).toMatch(/no bore/i);
  });

  it('rules a blade out of a groove it is wider than', () => {
    const grooved = ctxFor(groovedShaft({ radius: 15, length: 60, grooveZ: 30, grooveWidth: 2.5, grooveDepth: 3 }));
    const choices = toolChoicesFor('groove', grooved, { index: 0 });
    const wide = choices.find((c) => c.tool.width === 3);
    const narrow = choices.find((c) => c.tool.width === 2);
    expect(wide.fits).toBe(false);
    expect(wide.reason).toMatch(/wider|3 mm wide/);
    expect(narrow.fits).toBe(true);
  });

  it('lets a facemill overhang the part but not an endmill that has to go round it', () => {
    const mill = ctxFor(box(60, 40, 15));
    const face = toolChoicesFor('face', mill).find((c) => c.tool.id === 'fm50');
    const rough = toolChoicesFor('rough', mill).find((c) => c.tool.id === 'em20');
    expect(face.fits).toBe(true);      // Ø50 skimming a 40 mm wide part is fine
    expect(rough.fits).toBe(true);     // Ø20 is exactly half of 40
    const tooBig = toolChoicesFor('rough', mill).find((c) => c.tool.diameter > 20);
    if (tooBig) expect(tooBig.fits).toBe(false);
  });
});

describe('autoRecipe', () => {
  it('proposes the conventional turning order', () => {
    const ctx = ctxFor(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 }));
    expect(autoRecipe(ctx).map((e) => e.kind)).toEqual(['face', 'rough', 'finish', 'part']);
  });

  it('adds a bore step for a tube and puts it before finishing', () => {
    const ctx = ctxFor(tube(25, 12, 40, 64));
    const kinds = autoRecipe(ctx).map((e) => e.kind);
    expect(kinds).toContain('bore');
    expect(kinds.indexOf('bore')).toBeLessThan(kinds.indexOf('finish'));
  });

  it('keeps a step it cannot tool, disabled and with a reason', () => {
    // A missing row is indistinguishable from an operation nobody thought of.
    const ctx = ctxFor(groovedShaft({ radius: 15, length: 60, grooveZ: 30, grooveWidth: 1.2, grooveDepth: 3 }));
    const groove = autoRecipe(ctx).find((e) => e.kind === 'groove');
    expect(groove).toBeTruthy();
    expect(groove.enabled).toBe(false);
    expect(groove.toolId).toBeNull();
    expect(groove.warning).toMatch(/narrower than any blade/);
  });

  it('marks every automatic choice as automatic', () => {
    const ctx = ctxFor(box(60, 40, 15));
    expect(autoRecipe(ctx).every((e) => e.auto)).toBe(true);
  });
});

describe('editing a recipe', () => {
  const ctx = ctxFor(box(60, 40, 15));
  const base = autoRecipe(ctx);

  it('swaps the tool on one step and rebuilds the feeds to match', () => {
    const before = build(ctx, base).steps.find((s) => s.kind === 'rough');
    const edited = setStepTool(base, 'rough', 'em6');
    const after = build(ctx, edited).steps.find((s) => s.kind === 'rough');

    expect(before.toolId).not.toBe('em6');
    expect(after.toolId).toBe('em6');
    // A smaller cutter spins faster and takes longer — the whole plan moves
    // together rather than one row being patched.
    expect(after.speeds.rpm).toBeGreaterThan(before.speeds.rpm);
    expect(after.estMinutes).toBeGreaterThan(before.estMinutes);
  });

  it('regenerates the explanation from the tool actually chosen', () => {
    // A `why` still describing the tool you replaced is worse than none.
    const after = build(ctx, setStepTool(base, 'rough', 'em6')).steps.find((s) => s.kind === 'rough');
    expect(after.why).toMatch(/Ø6/);
    expect(after.why).not.toMatch(/Ø20/);
  });

  it('drops a disabled step from the output but keeps its row', () => {
    const off = toggleStep(base, 'face', false);
    expect(off).toHaveLength(base.length);
    expect(build(ctx, off).steps.some((s) => s.kind === 'face')).toBe(false);
    // ...and switching it back on restores it in place.
    expect(build(ctx, toggleStep(off, 'face', true)).steps[0].kind).toBe('face');
  });

  it('reorders operations, because machining order is the operator’s call', () => {
    const moved = moveStep(base, 'rough', -1);
    const kinds = build(ctx, moved).steps.map((s) => s.kind);
    expect(kinds.indexOf('rough')).toBeLessThan(kinds.indexOf('face'));
  });

  it('will not move a step off either end', () => {
    expect(moveStep(base, base[0].key, -1)).toBe(base);
    expect(moveStep(base, base[base.length - 1].key, 1)).toBe(base);
  });

  it('removes a step entirely', () => {
    const cut = removeStep(base, 'finish');
    expect(cut.some((e) => e.kind === 'finish')).toBe(false);
    expect(build(ctx, cut).steps.some((s) => s.kind === 'finish')).toBe(false);
  });

  it('inserts an added operation where it belongs, not at the end', () => {
    // A facing pass appended last would be posted last — and face the finished
    // part.
    const stripped = removeStep(base, 'face');
    const restored = addStep(stripped, 'face', ctx);
    expect(restored[0].kind).toBe('face');
    expect(restored.find((e) => e.kind === 'face').auto).toBe(false);
  });

  it('gives a second copy of an operation its own key', () => {
    const twice = addStep(base, 'finish', ctx);
    const keys = twice.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(build(ctx, twice).steps.filter((s) => s.kind === 'finish')).toHaveLength(2);
  });

  it('numbers the built steps consecutively however the recipe was edited', () => {
    const edited = moveStep(removeStep(base, 'face'), 'finish', -1);
    const ns = build(ctx, edited).steps.map((s) => s.n);
    expect(ns).toEqual(ns.map((_, i) => i + 1));
  });
});

describe('reconcile', () => {
  it('keeps tool choices across a new part but drops targets that are gone', () => {
    const grooved = ctxFor(groovedShaft({ radius: 15, length: 60, grooveZ: 30, grooveWidth: 4, grooveDepth: 3 }));
    const edited = setStepTool(autoRecipe(grooved), 'rough', 'dnmg-finish');
    expect(edited.some((e) => e.kind === 'groove')).toBe(true);

    const plain = ctxFor(turnedShaft({ r1: 15, z1: 25, r2: 8, z2: 45 }));
    const kept = reconcile(edited, plain);
    expect(kept.some((e) => e.kind === 'groove')).toBe(false);
    expect(kept.find((e) => e.kind === 'rough').toolId).toBe('dnmg-finish');
  });

  it('drops operations that do not exist on the other process', () => {
    const turning = ctxFor(cylinder(15, 40, 48));
    const milling = ctxFor(box(60, 40, 15));
    expect(reconcile(autoRecipe(turning), milling).some((e) => e.kind === 'part')).toBe(false);
  });
});

describe('buildPlan', () => {
  const ctx = ctxFor(box(60, 40, 15));

  it('skips a step naming a tool that is not in the library, and says so', () => {
    const bad = setStepTool(autoRecipe(ctx), 'rough', 'em999');
    const out = build(ctx, bad);
    expect(out.steps.some((s) => s.kind === 'rough')).toBe(false);
    expect(out.warnings.some((w) => /unknown tool/i.test(w))).toBe(true);
  });

  it('warns when the operator picks a tool that does not reach', () => {
    // Deliberately overriding a fit check is allowed — silently is not.
    const shallow = setStepTool(autoRecipe(ctx), 'rough', 'em2');
    expect(build(ctx, shallow).warnings.some((w) => /flute/.test(w))).toBe(true);
  });
});

describe('planJob with an operator recipe', () => {
  const soup = box(60, 40, 15);

  it('takes the recipe it is handed instead of planning its own', () => {
    const ctx = ctxFor(soup);
    const recipe = setStepTool(removeStep(autoRecipe(ctx), 'face'), 'rough', 'em8');
    const p = planJob(soup, weld(soup), { recipe });
    expect(p.steps.some((s) => s.kind === 'face')).toBe(false);
    expect(p.steps.find((s) => s.kind === 'rough').toolId).toBe('em8');
  });

  it('returns the recipe it used, so the UI can edit it again', () => {
    const p = planJob(soup, weld(soup));
    expect(p.recipe.length).toBeGreaterThan(0);
    expect(p.recipe[0]).toHaveProperty('key');
    expect(p.recipe[0]).toHaveProperty('toolId');
  });
});

describe('the machine changes the numbers', () => {
  const soup = cylinder(15, 40, 48);

  it('clamps a small lathe lower than a fast one', () => {
    const slow = planJob(soup, weld(soup), { machineId: 'toolroom-lathe' });
    const fast = planJob(soup, weld(soup), { machineId: 'citizen-l20' });
    const rpm = (p) => p.steps.find((s) => s.kind === 'rough').speeds.rpm;
    expect(rpm(slow)).toBeLessThan(rpm(fast));
    expect(rpm(slow)).toBeLessThanOrEqual(machineById('toolroom-lathe').maxTurnRpm);
  });

  it('reports the clamp that bit', () => {
    const p = planJob(soup, weld(soup), { machineId: 'toolroom-lathe' });
    expect(p.steps.find((s) => s.kind === 'rough').speeds.limitedBy).toBe('maxRpm');
  });

  it('warns when the part will not fit the machine at all', () => {
    const huge = box(1500, 900, 40);
    const p = planJob(huge, weld(huge), { machineId: 'haas-minimill', mode: 'mill' });
    expect(p.warnings.some((w) => /travel/.test(w))).toBe(true);
  });
});

describe('operationKindsFor', () => {
  it('offers a different menu on each process', () => {
    expect(operationKindsFor('turn').map((o) => o.kind)).toContain('part');
    expect(operationKindsFor('mill').map((o) => o.kind)).toContain('drill');
    expect(operationKindsFor('mill').map((o) => o.kind)).not.toContain('part');
  });

  it('has a default tool for every kind the geometry supports', () => {
    const mill = ctxFor(box(60, 40, 15));
    for (const kind of ['face', 'rough', 'finish']) {
      expect(defaultToolFor(kind, mill), kind).toBeTruthy();
    }
  });
});
