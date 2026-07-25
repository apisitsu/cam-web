/**
 * Process planner — from an analysed mesh to an ordered, tooled, NC-ready job.
 *
 * This is the "what do I do with this part" layer, and it is **deterministic**
 * by design. Every choice below comes from a measured property of the geometry
 * and a rule that can be stated in one sentence, which is what makes the plan
 * testable, repeatable, and explainable. Each step carries a `why` string
 * naming the measurement that drove it, so the UI never has to present a number
 * the operator cannot interrogate.
 *
 * A language model is a good fit for *narrating and critiquing* a plan like
 * this — spotting that a part is too thin to hold, suggesting a different
 * order — and a poor fit for generating the toolpath itself, where a plausible
 * wrong answer breaks a machine. So the split is deliberate: geometry and rules
 * decide, and any commentary layer sits on top of the result rather than
 * inside it.
 *
 * Pure functions. No React, no store, no DOM.
 */

import { analyzeMesh } from '../mesh/analyze.js';
import { turningProfile } from '../mesh/profile.js';
import { sliceLoops } from '../mesh/slice.js';
import { orientForMilling } from '../mesh/orient.js';
import { applyDatum, pointFromRawFrame } from '../mesh/datum.js';
import { rotateAboutX, normalizeAngle } from '../mesh/rotate.js';
import { detectFeatures } from '../mesh/features.js';
import { materialById } from './library.js';
import { DEFAULT_MACHINE } from './feeds.js';
import { machineById } from './machines.js';
import { fitWarnings, checkEnvelope } from './envelope.js';
import { autoRecipe, buildPlan, reconcile } from './recipe.js';
import * as mill from './toolpath/mill.js';

/**
 * Plan a job from a parsed STL.
 *
 * Two halves, deliberately separable. `planContext` measures the part; the
 * recipe says what to do about it. Pass `opts.recipe` and the operator's own
 * choices are used verbatim — same code path, same feeds, same post — so a
 * hand-edited plan is not a second-class citizen of an "automatic" one.
 *
 * @param {object} soup    triangle soup from `parseSTL`
 * @param {object} welded  indexed mesh from `weld`
 * @param {{material?:string, machine?:object, machineId?:string,
 *   mode?:'mill'|'turn'|'auto', partOff?:boolean, stockMargin?:number,
 *   datum?:{planeNormal:number[]|null, point:number[]|null}, recipe?:object[]}} opts
 * @returns {{mode, analysis, recipe, operations, steps, warnings, totalMinutes, stock}}
 */
export function planJob(soup, welded, opts = {}) {
  const { material = 'aluminium' } = opts;
  const machine = resolveMachine(opts);
  // A caller that is re-planning the same part — the store, after the operator
  // changed one tool — passes the context it already measured. Slicing a mesh
  // again to answer "what if it were a Ø8" would make every edit feel slow.
  const ctx = opts.ctx ?? planContext(soup, welded, opts);

  // An incoming recipe is reconciled against this part first: the shop's tool
  // choices survive a new STL, a groove that part does not have cannot.
  const recipe = opts.recipe ? reconcile(opts.recipe, ctx) : autoRecipe(ctx);
  const built = buildPlan(ctx, recipe, { material, machine });

  // Checked against the *program*, not the part. A part can fit the table and
  // still produce a toolpath that does not, because the toolpath also contains
  // the stock, the approach moves and the safe-Z retract.
  const envelope = checkEnvelope(machine, {
    operations: built.operations,
    mode: ctx.mode,
    bounds: ctx.analysisSource.bounds,
  });

  const totalMinutes = built.operations.reduce((s, o) => s + (o.estMinutes || 0), 0);
  return {
    mode: ctx.mode,
    material,
    machine,
    machineId: machine.id ?? null,
    analysis: ctx.analysisSource,
    recipe,
    operations: built.operations,
    steps: built.steps,
    stock: ctx.stock,
    profile: ctx.profile,
    part: ctx.part,
    holes: ctx.holes,
    neck: ctx.neck,
    orientation: ctx.orientation,
    orientedMesh: ctx.orientedMesh,
    analysisOriented: ctx.analysisOriented,
    envelope,
    warnings: [
      ...ctx.analysisSource.warnings, ...ctx.warnings, ...built.warnings,
      ...envelope.warnings,
    ],
    totalMinutes: Number(totalMinutes.toFixed(2)),
  };
}

/** A machine may arrive as an id (from the UI) or as a raw envelope (from tests). */
function resolveMachine(opts) {
  if (opts.machine) return opts.machine;
  if (opts.machineId) return machineById(opts.machineId);
  return DEFAULT_MACHINE;
}

/**
 * Measure the part and everything a toolpath will need from it.
 *
 * This is the expensive half — slicing, profiling, hole detection — and it does
 * not depend on a single tool choice. Keeping it separate is what makes
 * swapping a cutter instant: the geometry is already measured, only the
 * operations are rebuilt.
 */
export function planContext(soup, welded, opts = {}) {
  const { mode = 'auto', datum = null } = opts;
  const analysis = analyzeMesh(soup, welded);
  const chosen = mode === 'auto' ? analysis.recommend : mode;

  if (chosen === 'turn') {
    // Turning needs no re-framing: `turningProfile` works about whichever axis
    // the symmetry test found, and the spindle is that axis by definition. A
    // datum here only ever translates — see `applyDatum` — and only its
    // component along the spindle axis has any visible effect.
    const shifted = datum ? applyDatum({ soup, welded }, datum, { mode: 'turn' }) : { soup, welded, orientation: null };
    const shiftedAnalysis = shifted.soup === soup ? analysis : analyzeMesh(shifted.soup, shifted.welded);
    const ctx = turnContext(shifted.welded, shiftedAnalysis, opts);
    ctx.analysisSource = analysis;
    ctx.orientedMesh = shifted;
    ctx.analysisOriented = shiftedAnalysis;
    return ctx;
  }

  // Milling does. A part modelled standing on end reads as an unreachably deep
  // pocket, so it is laid down first and everything after — bounds, slices,
  // holes, toolpaths — is computed in the orientation it will actually be
  // clamped in. A picked datum plane overrides that automatic decision
  // outright (see `applyDatum`); with none picked this is byte-for-byte the
  // automatic lay-down that always ran here.
  const laid = datum
    ? applyDatum({ soup, welded }, datum, { mode: 'mill' })
    : orientForMilling(soup, welded);
  const oriented = (laid.orientation.changed || datum?.point)
    ? analyzeMesh(laid.soup, laid.welded)
    : analysis;
  const ctx = millContext(laid.welded, oriented, opts);
  ctx.analysisSource = analysis;
  ctx.orientation = laid.orientation;
  ctx.orientedMesh = laid;
  ctx.analysisOriented = oriented;
  // Where the physical A-axis passes through, in this same laid-down frame —
  // `[0,0]` (the frame's own origin) reproduces exactly what indexing always
  // assumed before an operator could say otherwise.
  const rotaryPoint = datum?.rotaryCenter ? pointFromRawFrame(datum.rotaryCenter, laid.orientation) : null;
  ctx.rotaryCenter = rotaryPoint ? [rotaryPoint[1], rotaryPoint[2]] : [0, 0];
  // The setter has to reproduce this orientation at the vice, and cannot work
  // it out from a toolpath — so it leads the warnings rather than hiding in the
  // plan object.
  if (laid.orientation.changed) ctx.warnings.unshift(`Setup: ${laid.orientation.description}`);
  // Handed to the recipe as a function rather than imported by it, so the
  // builder can ask for "this part at A90" without `recipe.js` having to import
  // the planner and close an import cycle.
  ctx.indexAt = (angle) => indexContext(ctx, angle);
  return ctx;
}

/**
 * Turning context.
 *
 * The default *order* of turning operations is not a preference — it is forced
 * by the geometry, and `recipe.js` encodes it as each kind's `order`. Facing
 * first establishes the Z datum every later move is measured from. Roughing
 * before finishing because a finishing insert cannot take a heavy cut. Grooving
 * after finishing because a groove removes the continuous surface a profiling
 * pass needs to run along. Parting last, because everything after it would be
 * machining a part that is no longer attached to anything.
 *
 * The operator can still reorder it. Making that possible is the point; making
 * the sensible order the default is what keeps it from being a footgun.
 */
function turnContext(welded, analysis, opts) {
  const { partOff = true, stockMargin = 1.5 } = opts;
  const profile = turningProfile(welded, analysis.axis.axis);

  const stock = {
    radius: profile.maxRadius + stockMargin,
    zMin: profile.zMin,
    zMax: profile.zMax + 2,
  };
  const machine = resolveMachine(opts);

  return {
    mode: 'turn',
    analysis,
    analysisSource: analysis,
    welded,
    profile,
    stock,
    partOff,
    // How much has to come off radially — what the roughing insert's depth of
    // cut is judged against.
    stockDepth: stock.radius - Math.min(...profile.outer.map((p) => p.r)),
    steepProfile: hasSteepProfile(profile),
    warnings: [...profile.warnings, ...fitWarnings(machine, analysis.bounds)],
  };
}

/**
 * The milling context as seen from one rotary index.
 *
 * An indexed 4th axis is not a different kind of toolpath — it is the *same*
 * 3-axis toolpath run on the part as it looks from a new angle. So this rolls
 * the mesh back by the table angle and re-measures it, and everything
 * downstream is the code that already works.
 *
 * Memoised onto the parent context, because the operator flipping through tools
 * must not re-slice four orientations of the mesh on every click. A0 is the
 * parent itself, not a copy — the overwhelmingly common case costs nothing.
 */
export function indexContext(ctx, angle = 0) {
  const a = normalizeAngle(angle);
  if (a === 0 || ctx.mode !== 'mill') return ctx;

  if (!ctx._indexed) ctx._indexed = new Map();
  const hit = ctx._indexed.get(a);
  if (hit) return hit;

  const rotated = rotateAboutX(ctx.welded, a, { center: ctx.rotaryCenter ?? [0, 0] });
  const derived = millContext(rotated, analyzeMesh(rotated, rotated), { stockMargin: 2 });
  derived.analysisSource = derived.analysis;
  derived.indexA = a;
  // The table's physical axis does not move when the operator flips through
  // indices — it is still the same offset the part was measured against.
  derived.rotaryCenter = ctx.rotaryCenter;
  // The parent's warnings already told the operator about this part; repeating
  // them once per index would bury the one warning that is about this side.
  derived.warnings = derived.warnings.filter((w) => !ctx.warnings.includes(w));
  ctx._indexed.set(a, derived);
  return derived;
}

/** True when the profile has a shoulder steep enough to need a profiling insert. */
function hasSteepProfile(profile) {
  for (let i = 1; i < profile.outer.length; i++) {
    const dz = Math.abs(profile.outer[i].z - profile.outer[i - 1].z);
    const dr = Math.abs(profile.outer[i].r - profile.outer[i - 1].r);
    if (dr > 0.5 && dz < dr * 0.3) return true;
  }
  return false;
}

/**
 * Milling context.
 *
 * Default order again follows from the machining, not from taste. Facing first
 * gives a flat reference and a known Z0. Drilling before roughing, because a
 * drill entering an already-roughed wall wanders off the hole centre, and
 * because a drilled hole gives a later endmill somewhere to plunge. Roughing
 * before finishing so the finish pass takes a light, even cut everywhere.
 * Finishing last, so nothing touches the finished wall afterwards.
 *
 * The two constraints that used to be collapsed into one tool choice are kept
 * apart here and handed to `recipe.js` separately, because they genuinely are
 * different: a rougher is limited by depth and footprint, a finisher by the
 * narrowest passage. Requiring one cutter to both reach 17 mm down and pass a
 * 2.8 mm gap between fork tines rules out the whole library, when in the shop
 * you would obviously rough with a Ø10 and detail with a Ø2.
 */
function millContext(welded, analysis, opts) {
  const { stockMargin = 2 } = opts;
  const machine = resolveMachine(opts);
  const bounds = analysis.bounds;
  const stock = mill.stockFor(bounds, { side: stockMargin, top: 1 });
  const part = { top: bounds.max[2], bottom: bounds.min[2] };
  const depth = part.top - part.bottom;

  // The narrowest neck anywhere in the part is what a cutter has to pass
  // through, so it caps the finishing tool. Measured at mid-height, where a
  // typical part's features are fully formed.
  const midLoops = sliceLoops(welded, 2, (part.top + part.bottom) / 2).loops;
  const neck = mill.narrowestPassage(midLoops);
  const footprint = Math.min(bounds.size[0], bounds.size[1]);

  // Holes of the same size are one operation with several positions — one tool
  // change, several plunges — so they are grouped before anything picks a drill.
  const holes = mill.detectHoles(welded, part);
  const byDiameter = new Map();
  for (const h of holes) {
    const key = h.diameter.toFixed(2);
    if (!byDiameter.has(key)) byDiameter.set(key, []);
    byDiameter.get(key).push(h);
  }
  const holeGroups = [...byDiameter].map(([key, group]) => ({
    diameter: Number(key),
    holes: group,
  }));

  const ctx = {
    mode: 'mill',
    analysis,
    analysisSource: analysis,
    welded,
    stock,
    part,
    depth,
    footprint,
    neck,
    holes,
    holeGroups,
    warnings: [
      ...fitWarnings(machine, bounds),
      'Inside corner radii are not analysed yet — a sharp internal corner will keep the cutter radius.',
    ],
  };

  // Faces and edges the operator can point at.
  //
  // Lazy, and deliberately so: recovering features walks every edge of the mesh
  // twice, and the majority of jobs are planned automatically and never ask.
  // Attached as a getter rather than a method so consumers read `ctx.features`
  // without having to know it was expensive.
  let features = null;
  Object.defineProperty(ctx, 'features', {
    enumerable: false,
    get() {
      if (!features) features = detectFeatures(welded);
      return features;
    },
  });
  return ctx;
}

/**
 * A compact, human-readable summary of a plan.
 *
 * This is also exactly the payload worth handing to a language model for
 * commentary: it is a few hundred bytes of decisions and measurements rather
 * than a mesh, so a model can reason about the *process* without ever touching
 * the geometry.
 */
export function planSummary(plan) {
  const m = materialById(plan.material);
  return {
    mode: plan.mode,
    material: m.label,
    machine: plan.machine?.label ?? null,
    axes: plan.envelope
      ? {
        required: plan.envelope.axes.required.join(''),
        machine: plan.envelope.axes.machineCount,
        travel: plan.envelope.travel.map((t) => `${t.axis} ${t.used}%`),
      }
      : null,
    boundingBox: plan.analysis.bounds.size.map((v) => Number(v.toFixed(2))),
    volume: Number(plan.analysis.volume.toFixed(1)),
    rotationalAxis: plan.analysis.axis.symmetric ? plan.analysis.axis.axis : null,
    setup: plan.orientation?.description ?? null,
    steps: plan.steps.map((s) => ({
      n: s.n,
      title: s.title,
      why: s.why,
      tool: s.tool,
      rpm: s.speeds.rpm,
      feed: s.speeds.feed,
      minutes: s.estMinutes,
    })),
    totalMinutes: plan.totalMinutes,
    warnings: plan.warnings,
  };
}
