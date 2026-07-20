/**
 * The recipe — the operator's editable version of the plan.
 *
 * `plan.js` decides what a part *probably* needs. That is a good starting point
 * and a bad final answer: the planner cannot know that the Ø10 is chipped, that
 * this shop always roughs with a Ø12, or that the groove is going to be cut on
 * the second op. So the plan is split in two.
 *
 * - A **recipe** is a plain, ordered, serialisable list of intentions:
 *   `{ key, kind, toolId, enabled, target }`. Nothing computed, nothing heavy.
 *   It is what the UI edits and what a project file stores.
 * - **Building** turns a recipe plus geometry into real operations, with real
 *   speeds and a real `why`. It is a pure function, so changing one tool and
 *   rebuilding is the same code path as planning from scratch.
 *
 * That split is the whole point. Swapping a tool is not a special case that
 * patches one step — it edits the recipe and rebuilds, so the feeds, the cycle
 * time, the warnings and the posted NC all move together and cannot drift out
 * of agreement with each other.
 *
 * `why` is generated at build time from the tool actually chosen, not baked in
 * when the plan was first made. Pick a smaller rougher and the explanation says
 * so — an explanation that still describes the tool you replaced is worse than
 * no explanation at all.
 *
 * ### The context it builds against
 *
 * A `ctx` comes from `plan.js` and is everything measured about the part:
 *
 * - turning: `{ mode:'turn', analysis, profile, stock, stockDepth }`
 * - milling: `{ mode:'mill', analysis, welded, stock, part, depth, footprint,
 *   neck, holeGroups }`
 *
 * Pure functions. No React, no store, no DOM.
 */

import {
  ALL_TOOLS, MILL_TOOLS, DRILL_TOOLS, TURN_TOOLS, toolById,
} from './library.js';
import { DEFAULT_MACHINE } from './feeds.js';
import { normalizeAngle } from '../mesh/rotate.js';
import * as turn from './toolpath/turn.js';
import * as mill from './toolpath/mill.js';
import { faceRegionOp, traceOp } from './toolpath/feature.js';

/**
 * The operations the app can generate, and what each one may be cut with.
 *
 * `toolTypes` is the honest constraint — a grooving blade cannot profile and a
 * boring bar cannot part off — and it is what the UI filters its tool list by.
 * `needs` marks an operation that only exists when the geometry has something
 * for it to do: there is no groove pass without a groove.
 */
export const OPERATION_KINDS = [
  // -- turning --
  {
    kind: 'face', mode: 'turn', label: 'Face', order: 10,
    toolTypes: ['turn-od'],
    hint: 'Squares the free end and sets Z0 for everything after it.',
  },
  {
    kind: 'rough', mode: 'turn', label: 'OD roughing', order: 20,
    toolTypes: ['turn-od'],
    hint: 'Takes the bulk off the diameter in heavy passes.',
  },
  {
    kind: 'bore', mode: 'turn', label: 'Boring', order: 30,
    toolTypes: ['turn-id'], needs: 'bore',
    hint: 'Opens an existing hole to size from the inside.',
  },
  {
    kind: 'finish', mode: 'turn', label: 'OD finishing', order: 40,
    toolTypes: ['turn-od'],
    hint: 'One light pass along the finished profile.',
  },
  {
    kind: 'groove', mode: 'turn', label: 'Grooving', order: 50,
    toolTypes: ['turn-groove'], needs: 'recess',
    hint: 'Plunges a blade into a recess a profiling insert cannot reach.',
  },
  {
    kind: 'part', mode: 'turn', label: 'Part off', order: 60,
    toolTypes: ['turn-part', 'turn-groove'],
    hint: 'Cuts the finished part off the bar. Nothing can follow it.',
  },
  // -- milling --
  {
    kind: 'face', mode: 'mill', label: 'Face', order: 10,
    toolTypes: ['facemill', 'endmill'], indexable: true,
    hint: 'Flattens the top of the stock and fixes Z0.',
  },
  {
    kind: 'drill', mode: 'mill', label: 'Drill', order: 20,
    toolTypes: ['drill'], needs: 'hole',
    hint: 'Canned cycle through a detected round hole.',
  },
  {
    kind: 'rough', mode: 'mill', label: 'Z-level roughing', order: 30,
    toolTypes: ['endmill'], indexable: true,
    hint: 'Clears bulk material level by level. Wants the biggest cutter that fits.',
  },
  {
    kind: 'finish', mode: 'mill', label: 'Contour finishing', order: 40,
    toolTypes: ['endmill', 'ballmill'], indexable: true,
    hint: 'Follows the finished wall. Bound by the narrowest passage.',
  },
  // -- picked from the model, rather than derived from the whole part --
  {
    kind: 'region', mode: 'mill', label: 'Clear a face', order: 35,
    toolTypes: ['endmill', 'facemill'], needs: 'face', indexable: true,
    hint: 'Pick a flat face; the cutter clears it in concentric rings.',
  },
  {
    kind: 'trace', mode: 'mill', label: 'Trace an edge', order: 45,
    toolTypes: ['endmill', 'ballmill'], needs: 'edge', indexable: true,
    hint: 'Pick an edge; the cutter follows it. Engraving, chamfer runs, slots.',
  },
];

/**
 * The operations that can be run from a rotary index.
 *
 * Drilling is deliberately absent: holes are detected against one orientation
 * of the mesh, and re-detecting them per index is real work that has not been
 * done. Offering it would produce a step that silently drills nothing.
 */
export function indexableKinds(mode) {
  return operationKindsFor(mode).filter((o) => o.indexable);
}

/** The operation kinds available on a given process. */
export function operationKindsFor(mode) {
  return OPERATION_KINDS.filter((o) => o.mode === mode);
}

/** Metadata for one kind on one process. */
export function operationKind(kind, mode) {
  return OPERATION_KINDS.find((o) => o.kind === kind && o.mode === mode) || null;
}

/**
 * Every tool that could legitimately run this operation, largest first, each
 * annotated with whether it actually fits the part.
 *
 * Tools that do not fit are **returned, not hidden**. The operator is allowed
 * to know that the Ø16 exists and why the planner refused it; a dropdown that
 * silently omits half the crib looks broken. `fits:false` carries the reason,
 * so the UI can show it disabled with an explanation rather than absent.
 *
 * @returns {{tool:object, fits:boolean, reason:string|null}[]}
 */
export function toolChoicesFor(kind, ctx, target = null) {
  const meta = operationKind(kind, ctx.mode);
  if (!meta) return [];
  // Asked of the part as it looks from this step's index: a cutter that cannot
  // pass a slot from the front may have a clear run at it from the side.
  const at = ctxAt(ctx, target);
  const pool = ALL_TOOLS.filter((t) => meta.toolTypes.includes(t.type));
  const sorted = [...pool].sort((a, b) => (b.diameter ?? b.width ?? 0) - (a.diameter ?? a.width ?? 0));
  return sorted.map((tool) => {
    const reason = toolMisfit(kind, tool, at, target);
    return { tool, fits: reason == null, reason };
  });
}

/**
 * Why a tool cannot do this job, or null when it can.
 *
 * Every branch is a physical fact — the bar will not enter the hole, the blade
 * is wider than the groove, the flutes do not reach the bottom. Preferences
 * ("the shop likes Ø10") deliberately do not appear: those belong to the
 * operator, and the whole reason the recipe is editable is so this function
 * does not have to guess at them.
 */
function toolMisfit(kind, tool, ctx, target = null) {
  if (ctx.mode === 'turn') {
    const p = ctx.profile;
    if (kind === 'bore') {
      if (!p?.hasBore) return 'The part has no bore.';
      if (tool.minBore != null && p.boreDiameter < tool.minBore) {
        return `Needs a Ø${p.boreDiameter.toFixed(1)} bore; this bar wants at least Ø${tool.minBore}.`;
      }
    }
    if (kind === 'groove') {
      const width = grooveWidthOf(ctx, target);
      if (width != null && tool.width > width + 1e-6) {
        return `The blade is ${tool.width} mm wide; the groove is ${width.toFixed(2)} mm.`;
      }
    }
    return null;
  }

  // Milling.
  if (kind === 'drill') return null; // any drill can make some hole
  if (kind === 'trace') {
    // A tracing cutter is bounded by nothing but the part: it walks a line.
    return tool.diameter > ctx.footprint
      ? `Ø${tool.diameter} is wider than the ${ctx.footprint.toFixed(1)} mm part.`
      : null;
  }
  if (kind === 'region') {
    const face = featureFace(ctx, target);
    if (!face) return null;
    // The cutter has to fit inside the face it is clearing. Measured across the
    // face's own two largest dimensions — a flat face is flat in one axis, and
    // taking the minimum of X and Y would read that zero as the face's width
    // and rule out every cutter in the library.
    const across = [...face.bounds.size].sort((a, b) => b - a)[1];
    return tool.diameter > across
      ? `Ø${tool.diameter} will not fit inside a ${across.toFixed(1)} mm face.`
      : null;
  }
  if (kind === 'face') {
    // A facemill wider than the part is fine — it is only skimming the top —
    // but sweeping it far past the edges is wasted air time.
    return tool.diameter > ctx.footprint * 1.5
      ? `Ø${tool.diameter} is much wider than the ${ctx.footprint.toFixed(1)} mm part.`
      : null;
  }
  // Half the footprint is the working limit for a cutter that has to go *into*
  // the shape rather than over it: anything larger cannot get round the part.
  if (tool.diameter > ctx.footprint / 2) {
    return `Ø${tool.diameter} is more than half the ${ctx.footprint.toFixed(1)} mm part width.`;
  }
  if (kind === 'finish' && Number.isFinite(ctx.neck) && tool.diameter > ctx.neck) {
    return `Ø${tool.diameter} will not pass the ${ctx.neck.toFixed(2)} mm narrowest passage.`;
  }
  if (kind === 'rough' && tool.fluteLength < ctx.depth) {
    return `${tool.fluteLength} mm of flute against a ${ctx.depth.toFixed(1)} mm deep part.`;
  }
  return null;
}

/**
 * A stable key, so a recipe row survives a rebuild and the UI keeps its state.
 *
 * A0 gets no suffix. That is not cosmetic: the overwhelming majority of jobs
 * never index at all, and a key of `rough` rather than `rough@A0` keeps a
 * 3-axis recipe readable — and keeps every recipe written before the rotary
 * existed still valid.
 */
function keyFor(kind, target) {
  const angle = target?.angle ? `@A${target.angle}` : '';
  const feature = target?.faceId ?? target?.edgeId ?? null;
  const index = feature != null
    ? `#${feature}`
    : (target?.index != null ? `#${target.index}` : '');
  return `${kind}${index}${angle}`;
}

/**
 * The part as the cutter sees it from this step's rotary index.
 *
 * Everything a milling step needs — bounds, slices, the narrowest passage,
 * which tools fit — changes when the table turns, so every one of them is asked
 * of the indexed context rather than the original. A step at A0 gets the
 * original context unchanged.
 */
function ctxAt(ctx, target) {
  const angle = target?.angle;
  if (!angle || !ctx.indexAt) return ctx;
  return ctx.indexAt(angle);
}

/**
 * The face or edge a step was pointed at.
 *
 * Looked up **by id**, never by position. Feature ids are assigned by size
 * order, so loading a different STL renumbers everything — and a step that
 * silently re-aims itself at whatever is now called F3 would machine the wrong
 * part of the wrong part. Missing is the correct answer; `reconcile` drops it.
 */
function featureFace(ctx, target) {
  const at = ctxAt(ctx, target);
  if (!target?.faceId) return null;
  return at.features?.faces.find((f) => f.id === target.faceId) ?? null;
}

function featureEdge(ctx, target) {
  const at = ctxAt(ctx, target);
  if (!target?.edgeId) return null;
  return at.features?.edges.find((e) => e.id === target.edgeId) ?? null;
}

/** One recipe entry. */
export function entry(kind, toolId, opts = {}) {
  const { target = null, enabled = true, warning = null, auto = true } = opts;
  return { key: keyFor(kind, target), kind, toolId, enabled, target, warning, auto };
}

// ---------------------------------------------------------------------------
// Editing — every one of these returns a new recipe, so history is free.
// ---------------------------------------------------------------------------

/** Swap the tool on one step. */
export function setStepTool(recipe, key, toolId) {
  return recipe.map((e) => (e.key === key ? { ...e, toolId, auto: false, warning: null } : e));
}

/** Turn a step on or off without losing its tool choice. */
export function toggleStep(recipe, key, enabled) {
  return recipe.map((e) => (e.key === key
    ? { ...e, enabled: enabled ?? !e.enabled, auto: false }
    : e));
}

/** Move a step up or down. Order is machining order, so this matters. */
export function moveStep(recipe, key, delta) {
  const i = recipe.findIndex((e) => e.key === key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= recipe.length) return recipe;
  const out = [...recipe];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Drop a step entirely. */
export function removeStep(recipe, key) {
  return recipe.filter((e) => e.key !== key);
}

/**
 * Add an operation the planner did not propose.
 *
 * Inserted at its conventional position rather than appended, because a facing
 * pass added last would be posted last — and face the finished part. The
 * operator can still drag it anywhere afterwards; the default is just the one
 * that is not a mistake.
 */
export function addStep(recipe, kind, ctx, opts = {}) {
  const meta = operationKind(kind, ctx.mode);
  if (!meta) return recipe;
  const target = opts.target ?? (opts.angle ? { angle: normalizeAngle(opts.angle) } : null);
  if (target?.angle && !meta.indexable) return recipe;
  const toolId = opts.toolId ?? defaultToolFor(kind, ctx, target)?.id ?? null;
  const fresh = {
    ...entry(kind, toolId, { target, auto: false }),
    key: uniqueKey(recipe, kind, target),
    // A step the geometry cannot support is still added — the operator asked
    // for it — but it carries the reason with it, so the row explains itself
    // instead of sitting there inert.
    warning: pickWarning(kind, meta, ctx, target),
  };

  const rank = (e) => operationKind(e.kind, ctx.mode)?.order ?? 999;
  const at = recipe.findIndex((e) => rank(e) > meta.order);
  const out = [...recipe];
  out.splice(at < 0 ? out.length : at, 0, fresh);
  return out;
}

/**
 * Why a picked feature cannot be machined as asked, or null.
 *
 * Only reachability, which is the one that actually stops the job. Tool fit is
 * left to `toolMisfit`, where the operator can see it per tool and overrule it.
 */
function pickWarning(kind, meta, ctx, target) {
  if (meta.needs === 'face') {
    const face = featureFace(ctx, target);
    if (!face) return `The picked face is not on this part.`;
    if (face.facing !== 'up') {
      return `The picked ${face.facing} face cannot be reached along the tool axis${target?.angle ? ` at A${target.angle}` : ''} — index the part until it faces up.`;
    }
  }
  if (meta.needs === 'edge' && !featureEdge(ctx, target)) {
    return `The picked edge is not on this part.`;
  }
  return null;
}

/** Keys must stay unique even when the same operation is added twice. */
function uniqueKey(recipe, kind, target) {
  const base = keyFor(kind, target);
  if (!recipe.some((e) => e.key === base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}~${n}`;
    if (!recipe.some((e) => e.key === candidate)) return candidate;
  }
}

/**
 * Drop entries whose target no longer exists.
 *
 * Loading a different STL keeps the shop's tool choices but cannot keep a
 * groove that part does not have. Silently posting an operation against a
 * recess that is gone is far worse than losing the row.
 */
export function reconcile(recipe, ctx) {
  return recipe.filter((e) => {
    const meta = operationKind(e.kind, ctx.mode);
    if (!meta) return false;
    if (!e.target) return true;
    if (meta.needs === 'recess') return e.target.index < (ctx.profile?.recesses.length ?? 0);
    if (meta.needs === 'hole') return e.target.index < (ctx.holeGroups?.length ?? 0);
    // A picked face or edge is identified by id, not position: a new STL that
    // happens to have an F3 is not the F3 the operator clicked on.
    if (meta.needs === 'face') return featureFace(ctx, e.target) != null;
    if (meta.needs === 'edge') return featureEdge(ctx, e.target) != null;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Automatic choices — the starting point, not the answer
// ---------------------------------------------------------------------------

/** The tool the planner would pick, given the geometry. */
export function defaultToolFor(kind, ctx, target = null) {
  const at = ctxAt(ctx, target);
  const choices = toolChoicesFor(kind, ctx, target)
    .filter((c) => c.fits)
    .map((c) => c.tool);
  if (choices.length === 0) return null;

  if (ctx.mode === 'turn') {
    if (kind === 'rough' || kind === 'face') return toolById('cnmg-rough') ?? choices[0];
    if (kind === 'finish') {
      // A 35 degree insert is the one that reaches into a steep shoulder; the
      // 55 degree finisher is stiffer and better everywhere else.
      const wantsProfiling = (ctx.profile?.recesses.length ?? 0) > 0 || ctx.steepProfile;
      return toolById(wantsProfiling ? 'vnmg-profile' : 'dnmg-finish') ?? choices[0];
    }
    if (kind === 'part') return toolById('part-3') ?? choices[0];
    // Grooving and boring: the widest blade / biggest bar that still fits, so
    // the fewest plunges and the stiffest bar.
    return choices[0];
  }

  if (kind === 'drill') {
    const dia = target?.diameter ?? at.holeGroups?.[target?.index ?? 0]?.diameter;
    return dia != null ? drillUnder(dia) : choices[0];
  }
  // Milling: biggest that fits. Stiffer, faster, deflects less — the only
  // reason to go smaller is that the geometry says so, and `fits` said it does not.
  return choices[0];
}

/** An STL hole always reads undersized, so round *down* to the nearest drill. */
function drillUnder(diameter, tol = 0.25) {
  return [...DRILL_TOOLS]
    .filter((d) => d.diameter <= diameter + tol)
    .sort((a, b) => b.diameter - a.diameter)[0] ?? null;
}

function grooveWidthOf(ctx, target) {
  if (!target || target.index == null) return null;
  return ctx.profile?.recesses?.[target.index]?.width ?? null;
}

/**
 * The recipe the planner proposes for a part.
 *
 * When nothing in the library fits, the entry is kept with `toolId:null` and a
 * warning rather than dropped. A missing row is indistinguishable from an
 * operation nobody thought of; a disabled row with a reason is a decision the
 * operator can overrule — which, now that tools are selectable, they can.
 */
export function autoRecipe(ctx) {
  return ctx.mode === 'turn' ? autoTurnRecipe(ctx) : autoMillRecipe(ctx);
}

function autoTurnRecipe(ctx) {
  const out = [];
  const add = (kind, target = null) => {
    const tool = defaultToolFor(kind, ctx, target);
    out.push(entry(kind, tool?.id ?? null, { target, enabled: tool != null }));
    return out[out.length - 1];
  };

  add('face');
  add('rough');

  if (ctx.profile.hasBore) {
    const e = add('bore');
    if (!e.toolId) {
      e.warning = `Bore Ø${ctx.profile.boreDiameter.toFixed(1)} is smaller than the smallest boring bar in the library — it needs drilling to size instead.`;
    }
  }

  add('finish');

  ctx.profile.recesses.forEach((recess, index) => {
    const e = add('groove', { index });
    if (!e.toolId) {
      e.warning = `Groove at Z${recess.zStart.toFixed(1)} is ${recess.width.toFixed(2)} mm wide — narrower than any blade in the library.`;
    }
  });

  if (ctx.partOff !== false) add('part');
  return out;
}

function autoMillRecipe(ctx) {
  const out = [];
  const add = (kind, target = null) => {
    const tool = defaultToolFor(kind, ctx, target);
    out.push(entry(kind, tool?.id ?? null, { target, enabled: tool != null }));
    return out[out.length - 1];
  };

  // Facing wants a big cutter over the whole footprint, and a facemill wider
  // than the part is fine — it is only skimming the top.
  const faceTool = [...MILL_TOOLS]
    .filter((t) => t.type === 'facemill' && t.diameter <= ctx.footprint * 1.5)
    .sort((a, b) => b.diameter - a.diameter)[0]
    ?? defaultToolFor('face', ctx);
  if (faceTool) out.push(entry('face', faceTool.id));

  ctx.holeGroups.forEach((group, index) => {
    const e = add('drill', { index, diameter: group.diameter });
    if (!e.toolId) e.warning = `No drill in the library matches the Ø${group.diameter.toFixed(2)} hole(s).`;
  });

  const rough = add('rough');
  if (!rough.toolId) {
    // Nothing reaches full depth. Take the longest-reaching cutter there is and
    // say so, rather than refusing to plan at all — a partial program the
    // operator can finish in a second setup beats an empty one.
    const reach = toolChoicesFor('rough', ctx)
      .filter((c) => c.tool.diameter <= ctx.footprint / 2)
      .map((c) => c.tool)
      .sort((a, b) => b.fluteLength - a.fluteLength || b.diameter - a.diameter)[0];
    if (reach) {
      rough.toolId = reach.id;
      rough.enabled = true;
    } else {
      rough.warning = `The part footprint is ${ctx.footprint.toFixed(1)} mm — smaller than the smallest endmill in the library.`;
    }
  }

  const finish = add('finish');
  if (!finish.toolId && Number.isFinite(ctx.neck)) {
    finish.warning = `The narrowest passage is ${ctx.neck.toFixed(2)} mm — no endmill in the library fits it, so that feature is left unmachined.`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building — recipe + geometry -> operations
// ---------------------------------------------------------------------------

/** A plan step: what to do, with what, and — crucially — why. */
function toStep(n, key, title, why, op) {
  return {
    n, key, title, why,
    kind: op.kind,
    indexA: op.indexA ?? null,
    tool: op.tool.label,
    toolId: op.tool.id,
    speeds: op.speeds,
    cutLength: op.cutLength,
    estMinutes: op.estMinutes,
    notes: op.notes,
  };
}

/**
 * Build operations from a recipe.
 *
 * Disabled steps contribute nothing but keep their place in the recipe, so
 * switching one back on restores it exactly where it was.
 *
 * @returns {{operations:object[], steps:object[], warnings:string[]}}
 */
export function buildPlan(ctx, recipe, opts = {}) {
  const { material = 'aluminium', machine = DEFAULT_MACHINE } = opts;
  const operations = [];
  const steps = [];
  const warnings = [];

  for (const e of recipe) {
    if (e.warning) warnings.push(e.warning);
    if (!e.enabled || !e.toolId) continue;

    const tool = toolById(e.toolId);
    if (!tool) {
      warnings.push(`Step "${e.kind}" names an unknown tool (${e.toolId}) and was skipped.`);
      continue;
    }

    const built = ctx.mode === 'turn'
      ? buildTurnStep(ctx, e, tool, { material, machine })
      : buildMillStep(ctx, e, tool, { material, machine });
    // Warnings survive a step that produced no motion — that is precisely the
    // case where the operator most needs to be told why nothing happened. A
    // refusal with no explanation is indistinguishable from a bug.
    for (const w of built?.warnings || []) warnings.push(w);
    if (!built?.op) continue;

    // The rotary index rides on the operation rather than on the moves: the
    // table turns once, before the tool approaches, and every move in the
    // operation happens at that angle.
    if (e.target?.angle) built.op.indexA = e.target.angle;

    operations.push(built.op);
    steps.push(toStep(steps.length + 1, e.key, built.title, built.why, built.op));
  }

  return { operations, steps, warnings };
}

function buildTurnStep(ctx, e, tool, cut) {
  const { profile, stock } = ctx;
  const common = { ...cut, stock, tool };
  const warnings = [];

  switch (e.kind) {
    case 'face':
      return {
        op: turn.facingOp(profile, common),
        title: 'Face the end',
        why: `The bar is ${(stock.zMax - profile.zMax).toFixed(1)} mm long at the free end; facing squares it and sets Z0 for every later move.`,
        warnings,
      };
    case 'rough': {
      const passes = Math.ceil(ctx.stockDepth / tool.maxDoc);
      return {
        op: turn.roughingOp(profile, common),
        title: 'Rough the outside diameter',
        why: `${ctx.stockDepth.toFixed(1)} mm of stock has to come off radially. The ${tool.label} takes ${tool.maxDoc} mm per pass — about ${passes} pass${passes === 1 ? '' : 'es'}.`,
        warnings,
      };
    }
    case 'finish':
      return {
        op: turn.finishingOp(profile, common),
        title: 'Finish the profile',
        why: `A ${tool.noseRadius} mm nose at a light feed. Roughing left 0.4 mm on for this pass.`,
        warnings,
      };
    case 'bore': {
      if (profile.hasBore && tool.minBore != null && profile.boreDiameter < tool.minBore) {
        warnings.push(`The ${tool.label} needs at least a Ø${tool.minBore} hole; this bore is Ø${profile.boreDiameter.toFixed(1)}.`);
      }
      return {
        op: turn.boringOp(profile, common),
        title: 'Bore the hole',
        why: `The part has a Ø${profile.boreDiameter.toFixed(1)} bore; the ${tool.label} works inside it.`,
        warnings,
      };
    }
    case 'groove': {
      const recess = profile.recesses[e.target?.index ?? 0];
      if (!recess) return null;
      if (tool.width > recess.width + 1e-6) {
        warnings.push(`The ${tool.width} mm blade is wider than the ${recess.width.toFixed(2)} mm groove at Z${recess.zStart.toFixed(1)} — it would cut the walls away.`);
      }
      return {
        op: turn.groovingOp(recess, common),
        title: `Cut the groove at Z${recess.zStart.toFixed(1)}`,
        why: `A ${recess.width.toFixed(2)} mm wide, ${recess.depth.toFixed(2)} mm deep recess. A profiling insert cannot reach it — it needs the ${tool.width} mm blade plunged in.`,
        warnings,
      };
    }
    case 'part':
      return {
        op: turn.partingOp(profile, common),
        title: 'Part off',
        why: `Separates the finished part from the bar at Z${profile.zMin.toFixed(1)}. Last, because nothing can be machined after it.`,
        warnings,
      };
    default:
      return null;
  }
}

/** Where a face-clearing pass starts from: the stock top, if it is above. */
function opts_from(ctx, face) {
  const top = ctx.stock?.top;
  return top != null && top > face.bounds.max[2] ? top : face.bounds.max[2];
}

function buildMillStep(parentCtx, e, tool, cut) {
  // Everything below is computed on the part as it presents itself at this
  // step's rotary index. At A0 — almost always — this is the parent context.
  const ctx = ctxAt(parentCtx, e.target);
  const { welded, stock, part, depth, neck } = ctx;
  const common = { ...cut, part, tool };
  const warnings = [];
  const angle = e.target?.angle ?? 0;
  const at = angle ? ` at A${angle}` : '';

  switch (e.kind) {
    case 'face':
      return {
        op: mill.facingOp(stock, part, common),
        title: `Face the top${at}`,
        why: `1 mm of stock sits above the part. The ${tool.label} skims it flat and fixes Z0.`,
        warnings,
      };
    case 'drill': {
      const group = ctx.holeGroups[e.target?.index ?? 0];
      if (!group) return null;
      if (tool.diameter > group.diameter + 0.3) {
        warnings.push(`A Ø${tool.diameter} drill in a Ø${group.diameter.toFixed(2)} hole would cut it oversize.`);
      }
      return {
        op: mill.drillingOp(group.holes, { ...common, stock }),
        title: `Drill ${group.holes.length} × Ø${group.diameter.toFixed(2)}${at}`,
        why: `Round inner loops of Ø${group.diameter.toFixed(2)} were found in the section. Drilled before roughing so the drill starts on solid, flat material and cannot wander.`,
        warnings,
      };
    }
    case 'rough': {
      if (tool.fluteLength < depth) {
        warnings.push(`The part is ${depth.toFixed(1)} mm deep but the Ø${tool.diameter} rougher has ${tool.fluteLength} mm of flute — plan a second setup, or a longer-reach tool.`);
      }
      return {
        op: mill.roughingOp(welded, stock, part, common),
        title: `Rough out the shape${at}`,
        why: `Ø${tool.diameter} clears the ${Number.isFinite(neck) ? `${neck.toFixed(1)} mm narrowest passage` : 'part footprint'} and reaches ${Math.min(tool.fluteLength, depth).toFixed(1)} mm of the ${depth.toFixed(1)} mm depth.`,
        warnings,
      };
    }
    case 'region': {
      const face = featureFace(parentCtx, e.target);
      if (!face) return null;
      if (face.facing !== 'up') {
        // 3-axis code. Machining a wall as its flattened shadow is the worst
        // thing this could do quietly, so it does not do it at all.
        warnings.push(`The picked ${face.facing} face cannot be reached along the tool axis${angle ? ` at A${angle}` : ''} — index the part until it faces up.`);
        return null;
      }
      const op = faceRegionOp(face, { ...common, from: opts_from(ctx, face) });
      if (!op) return null;
      return {
        op,
        title: `Clear the picked face${at}`,
        why: `A ${face.area.toFixed(0)} mm² flat face at Z${face.centroid[2].toFixed(2)}, cleared with Ø${tool.diameter} in concentric rings from its own outline.`,
        warnings,
      };
    }
    case 'trace': {
      const edge = featureEdge(parentCtx, e.target);
      if (!edge) return null;
      const op = traceOp(edge, { ...common, depth: e.target?.depth ?? 0 });
      if (!op) return null;
      return {
        op,
        title: `Trace the picked edge${at}`,
        why: `${edge.length.toFixed(1)} mm of ${edge.closed ? 'closed' : 'open'} edge, followed with Ø${tool.diameter}${e.target?.depth ? ` at ${e.target.depth} mm deep` : ' at its own height'}.`,
        warnings,
      };
    }
    case 'finish': {
      if (tool.fluteLength < depth) {
        warnings.push(`The Ø${tool.diameter} finisher has ${tool.fluteLength} mm of flute against a ${depth.toFixed(1)} mm part — it can only finish the upper part of the wall.`);
      }
      if (Number.isFinite(neck) && tool.diameter > neck) {
        warnings.push(`Ø${tool.diameter} will not pass the ${neck.toFixed(2)} mm narrowest passage — that feature stays unmachined.`);
      }
      return {
        op: mill.contourOp(welded, part, common),
        title: `Finish the walls${at}`,
        why: `Ø${tool.diameter} follows the finished wall, taking off the 0.3 mm roughing left behind.`,
        warnings,
      };
    }
    default:
      return null;
  }
}

export { MILL_TOOLS, TURN_TOOLS, DRILL_TOOLS };
