/**
 * The feature tree — an ordered list of operations, and the fold that turns it
 * back into a solid.
 *
 * Until now a build was a one-way street: press Build, get a part, and the
 * sketch it came from was forgotten. Changing a dimension meant doing the whole
 * sequence again by hand. A feature tree is what makes the model *editable*:
 * the operations are kept, and the part is whatever replaying them produces.
 *
 * ## Why this is small
 *
 * Every geometric step already exists as a **pure function on triangle soups** —
 * `sketchRegions`, `combineRegions`, `buildSolid`, and the mesh boolean. So a
 * rebuild is a fold over functions that are already written and already tested;
 * there is no new geometry here at all, only bookkeeping and replay. That is the
 * whole reason a feature tree is days rather than months in this codebase.
 *
 * ## The one hard problem, and how it is sidestepped
 *
 * Feature trees classically founder on **topological naming**: a feature that
 * refers to "the seventh face of the previous body" refers to nothing reliable
 * once an earlier feature changes the shape. Nothing here names a face by
 * index. A sketch placed on a face stores the **resolved plane** — numbers that
 * cannot go stale (`planeFromFace`) — and, when that face is an *axis-aligned end*
 * of one feature's own solid (the top of an extrude, the floor of a pocket), a
 * **link** to that end (`plane.ref`, see `linkFaceToSolids`). On replay the link
 * is re-resolved against the bounds of that feature's solid, so editing the
 * feature's depth or sketch moves the sketches placed on it.
 *
 * What is still not followed, stated rather than hidden: an **angled** face, and
 * a face that is not an end of a feature's bounding box, keep their numbers. A
 * link whose feature is suppressed, failed, or later in the tree also falls back
 * to the numbers. That is a limitation, but a predictable one, and predictable
 * beats a reference that silently re-binds to the wrong face.
 *
 * ## Failure is per feature
 *
 * A feature that cannot build — its sketch no longer closes, a revolve now
 * crosses its axis — is recorded and **skipped**, and the fold carries on with
 * what it had. One broken operation costs you that operation, not the part.
 *
 * Pure, and three.js-free like the rest of `engine/`: the mesh boolean is
 * **injected**, the same way `planegcs.js` takes its module loader, because the
 * only implementation of it speaks `BufferGeometry` and lives in `lib/`.
 */
import { sketchRegions } from '../sketch/loops.js';
import { combineRegions } from './regionBoolean.js';
import { buildSolid } from './extrude.js';
import { resolvePlaneRef, lineFrame, planeBasis } from '../sketch/plane.js';
import { centerlines } from '../sketch/model.js';
import {
  HOLE_TYPES, THREADS, holeSolid, holePositions,
} from './hole.js';
import { boundsOf } from '../mesh/analyze.js';

/**
 * How far an extrude runs. Blind is the depth typed; Through All is past the far
 * side of whatever is on the machine when the feature is replayed, so it still
 * goes through after the part grows; Mid Plane is the depth split either side.
 */
export const END_CONDITIONS = {
  blind: 'Blind',
  through: 'Through All',
  mid: 'Mid Plane',
};

/** How far past the part's far side Through All runs, so its end is never flush with a face. */
const THROUGH_PAST = 1;

/** The far side of the part from a plane: how far it reaches along +n and along −n. */
export function partReach(plane, bounds) {
  const { origin, n } = planeBasis(plane);
  let ahead = -Infinity;
  let behind = -Infinity;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const d = (x - origin[0]) * n[0] + (y - origin[1]) * n[1] + (z - origin[2]) * n[2];
        ahead = Math.max(ahead, d);
        behind = Math.max(behind, -d);
      }
    }
  }
  return { ahead, behind };
}

/**
 * Which way a new extrude should run by default: a cut into the part, a boss out
 * of it. `true` means reversed — against the plane's normal. Only a part wholly
 * on one side of the plane decides it; one the plane passes through does not.
 */
export function defaultReverse(plane, bounds, cut) {
  if (!bounds) return false;
  const { ahead, behind } = partReach(plane, bounds);
  const behindOnly = ahead <= 1e-6 && behind > 1e-6;
  const aheadOnly = behind <= 1e-6 && ahead > 1e-6;
  return cut ? behindOnly : aheadOnly;
}

/**
 * The signed depth and lift an extrude feature builds with, on `plane`, against
 * the part built so far (`partBounds`, for Through All).
 */
export function extrudeSpan(feature, plane, partBounds) {
  const sign = feature.reverse ? -1 : 1;
  if (feature.end === 'mid') {
    const d = Math.abs(feature.depth);
    return { depth: d, base: feature.base - d / 2 };
  }
  if (feature.end === 'through') {
    if (!partBounds) throw new Error('Through All needs a part to go through — build or import one first');
    const { ahead, behind } = partReach(plane, partBounds);
    const reach = sign > 0 ? ahead : behind;
    if (!(reach > 1e-6)) throw new Error('Through All points away from the part — reverse it');
    return { depth: sign * (reach + THROUGH_PAST), base: 0 };
  }
  return { depth: sign * feature.depth, base: feature.base };
}

/** What a feature can be. `import` is the mesh a file was read into. */
export const FEATURE_KINDS = {
  import: { label: 'Import', needsSketch: false },
  extrude: { label: 'Extrude', needsSketch: true },
  revolve: { label: 'Revolve', needsSketch: true },
  hole: { label: 'Hole', needsSketch: true },
};

/** Numbers that come back as themselves when sane, else the default given. */
const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);

/**
 * How a feature joins what came before it. `new` starts again — the first
 * feature is always `new` in effect, whatever it says, because there is nothing
 * yet for it to combine with.
 */
export const MERGE_MODES = {
  new: 'New — replace what is there with this',
  add: 'Add — join it to the part',
  cut: 'Cut — remove it from the part',
  common: 'Common — keep only where they overlap',
};

let _nextId = 1;
/** Ids are unique within a session; a loaded tree re-seeds the counter. */
export function nextFeatureId() { return _nextId++; }
export function seedFeatureIds(from) {
  _nextId = Math.max(_nextId, Math.floor(from) + 1 || 1);
}

/** A feature with everything filled in. Unknown fields are dropped. */
export function createFeature(kind, props = {}) {
  if (!FEATURE_KINDS[kind]) throw new Error(`unknown feature kind: ${kind}`);
  const id = Number.isFinite(props.id) ? props.id : nextFeatureId();
  seedFeatureIds(id);
  const base = {
    id,
    kind,
    name: props.name || FEATURE_KINDS[kind].label,
    suppressed: !!props.suppressed,
    merge: MERGE_MODES[props.merge] ? props.merge : 'new',
  };
  if (kind === 'import') return base;
  if (kind === 'hole') {
    // A hole only ever takes material away.
    return {
      ...base,
      merge: 'cut',
      sketchId: Number.isFinite(props.sketchId) ? props.sketchId : null,
      holeType: HOLE_TYPES[props.holeType] ? props.holeType : 'drill',
      diameter: positive(props.diameter, 6),
      thread: THREADS[props.thread] ? props.thread : 'M6',
      threadDepth: positive(props.threadDepth, 12),
      cbDiameter: positive(props.cbDiameter, 11),
      cbDepth: positive(props.cbDepth, 6.5),
      cskDiameter: positive(props.cskDiameter, 12),
      cskAngle: positive(props.cskAngle, 90),
      depth: positive(props.depth, 15),
      end: props.end === 'through' ? 'through' : 'blind',
      reverse: !!props.reverse,
    };
  }
  return {
    ...base,
    sketchId: Number.isFinite(props.sketchId) ? props.sketchId : null,
    // Boolean applied to the sketch's own profiles, before anything is built.
    combine: props.combine || null,
    depth: Number.isFinite(props.depth) ? props.depth : 10,
    base: Number.isFinite(props.base) ? props.base : 0,
    // How far an extrude runs (SolidWorks' end condition) and which way.
    end: END_CONDITIONS[props.end] ? props.end : 'blind',
    reverse: !!props.reverse,
    axis: props.axis === 'y' ? 'y' : 'x',
    // A centerline on the sketch to turn about, by its line id. When set it wins
    // over `axis`, which then only says what to fall back to.
    axisLine: Number.isFinite(props.axisLine) ? props.axisLine : null,
    angle: Number.isFinite(props.angle) ? props.angle : Math.PI * 2,
    segments: Number.isFinite(props.segments) ? props.segments : null,
  };
}

/** Validate a tree read from a project file. Anything unusable is dropped. */
export function parseFeatures(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const f of raw) {
    if (!f || !FEATURE_KINDS[f.kind]) continue;
    try {
      out.push(createFeature(f.kind, f));
    } catch {
      // A single malformed entry must not cost the whole tree.
    }
  }
  return out;
}

/** Build the solid one feature describes, on its own. Throws with a message. */
function makeFeatureSolid(feature, {
  sketchOf, importOf, refBounds, planes, used, partBounds,
}) {
  if (feature.kind === 'import') {
    const soup = importOf?.(feature);
    if (!soup?.triangleCount) {
      throw new Error('the imported mesh this was built from is no longer loaded');
    }
    return soup;
  }
  const entry = sketchOf?.(feature.sketchId);
  if (!entry?.doc) throw new Error('its sketch is gone');

  // A sketch placed on an earlier feature's face is moved to where that face is
  // now. The moved plane is reported back (`planes`) so the store can write it
  // onto the sketch — the drawing on screen must sit where the solid was built.
  used?.add(feature.sketchId);
  const plane = resolvePlaneRef(entry.plane, refBounds);
  if (plane !== entry.plane) planes?.set(feature.sketchId, plane);

  if (feature.kind === 'hole') return makeHoles(feature, entry.doc, plane, partBounds);

  const found = sketchRegions(entry.doc);
  let regions = found.regions;
  if (feature.combine && regions.length > 1) regions = combineRegions(regions, feature.combine);
  if (!regions.length) {
    throw new Error(found.open.length
      ? 'its sketch no longer encloses a closed profile'
      : 'its sketch is empty');
  }
  const span = feature.kind === 'extrude'
    ? extrudeSpan(feature, plane, partBounds)
    : { depth: feature.depth, base: feature.base };
  const shape = {
    op: feature.kind,
    plane,
    depth: span.depth,
    base: span.base,
    axis: feature.axis,
    angle: feature.angle,
    segments: feature.segments ?? undefined,
  };
  if (feature.kind === 'revolve' && feature.axisLine != null) {
    return revolveAboutLine(regions, entry.doc, feature.axisLine, shape);
  }
  return buildSolid(regions, shape);
}

/**
 * The holes a Hole feature cuts: one at each of its sketch's points, as deep as
 * it says or through whatever is on the machine (`extrudeSpan`'s rule, with the
 * depth the hole's drill point starts at).
 */
function makeHoles(feature, doc, plane, partBounds) {
  if (!partBounds) throw new Error('a hole needs a part to go into — build or import one first');
  let depth = feature.depth;
  const through = feature.end === 'through';
  if (through) {
    const { ahead, behind } = partReach(plane, partBounds);
    const reach = feature.reverse ? ahead : behind;
    if (!(reach > 1e-6)) throw new Error('the hole points away from the part — reverse it');
    depth = reach + THROUGH_PAST;
  }
  return holeSolid(holePositions(doc), plane, feature, {
    depth, through, reverse: feature.reverse, segments: feature.segments ?? undefined,
  });
}

/**
 * Revolve about a centerline drawn on the sketch: the profile is re-expressed in a
 * frame whose X axis is that line, and turned about X there (`lineFrame`).
 */
function revolveAboutLine(regions, doc, lineId, shape) {
  const line = centerlines(doc).find((l) => l.id === lineId);
  if (!line) throw new Error('the centerline it turns about is gone from its sketch');
  const frame = lineFrame(shape.plane, line.a, line.b);
  const move = (loop) => {
    const out = new Array(loop.length);
    for (let i = 0; i < loop.length; i += 2) {
      const [x, y] = frame.local(loop[i], loop[i + 1]);
      out[i] = x;
      out[i + 1] = y;
    }
    return out;
  };
  const moved = regions.map((r) => ({ ...r, outer: move(r.outer), holes: (r.holes || []).map(move) }));
  return buildSolid(moved, { ...shape, plane: frame.plane, axis: 'x' });
}

/**
 * Replay the tree.
 *
 * @param {object[]} features  in order
 * @param {{sketchOf:Function, importOf:Function, meshBoolean:Function}} ctx
 *   `sketchOf(sketchId)` → `{ doc, plane }`; `importOf(feature)` → soup;
 *   `meshBoolean(a, b, op, format)` → soup, injected (see the module note).
 * @param {{keepIntermediates?:boolean}} [opts]
 *   `keepIntermediates` returns each step's soup as well — the basis for
 *   rebuilding only from the first changed feature, which is worth adding once
 *   a boolean on a real part is slow enough to notice. Off by default: every
 *   soup is a `Float32Array` and a deep tree of big parts is real memory.
 * @returns {{soup:object|null, steps:object[], errors:object[], planes:Map<number,object>}}
 *   `planes` maps a sketch id to the plane it was **built on** when that differs
 *   from the one it stores — i.e. a face link that moved. Each ok step also
 *   carries `bounds` (its own solid's) and `merge`, which is what a new link to
 *   its faces is made from.
 */
export function rebuildFeatures(features, ctx = {}, { keepIntermediates = false } = {}) {
  const { meshBoolean } = ctx;
  let current = null;
  const steps = [];
  const errors = [];
  // Each built feature's own bounds, by id, filled as the fold goes — so a link
  // can only ever resolve against a feature that comes EARLIER and built fine.
  const refBounds = new Map();
  const planes = new Map();
  const used = new Set(); // sketches a feature was actually built from
  const fctx = { ...ctx, refBounds, planes, used };

  const fail = (f, message) => {
    const step = {
      id: f.id, name: f.name, kind: f.kind, ok: false, error: message,
    };
    steps.push(step);
    errors.push({ id: f.id, name: f.name, message });
  };

  for (const f of features || []) {
    if (f.suppressed) {
      steps.push({
        id: f.id, name: f.name, kind: f.kind, ok: true, suppressed: true,
      });
      continue;
    }

    let made;
    try {
      // What Through All has to get through: the part as it stands before this.
      made = makeFeatureSolid(f, { ...fctx, partBounds: current ? boundsOf(current) : null });
    } catch (e) {
      fail(f, e?.message || String(e));
      continue;
    }

    // Nothing to combine with yet: the first feature that builds is the base,
    // whatever merge mode it happens to carry.
    if (!current || f.merge === 'new') {
      current = made;
    } else if (!meshBoolean) {
      fail(f, 'no solid boolean is available to combine it with the part');
      continue;
    } else {
      try {
        current = meshBoolean(current, made, f.merge, f.kind);
      } catch (e) {
        fail(f, e?.message || String(e));
        continue;
      }
    }

    const bounds = boundsOf(made);
    refBounds.set(f.id, bounds);
    steps.push({
      id: f.id,
      name: f.name,
      kind: f.kind,
      ok: true,
      merge: f.merge,
      bounds: { min: bounds.min, max: bounds.max },
      triangleCount: current.triangleCount,
      ...(keepIntermediates ? { soup: current } : {}),
    });
  }

  // A sketch placed on a face but not built yet is the usual state — the
  // operator is about to draw on it. It must sit on the face's new position too,
  // or the profile gets drawn at the old height. Sketches a feature DID build from
  // are already settled above, at the moment that feature was built; resolving
  // them again here could move one after its solid was made.
  for (const s of ctx.sketchList?.() || []) {
    if (used.has(s.id)) continue;
    const plane = resolvePlaneRef(s.plane, refBounds);
    if (plane !== s.plane) planes.set(s.id, plane);
  }

  return { soup: current, steps, errors, planes };
}

/** Whether replaying this tree will need a solid boolean at all. */
export function needsMeshBoolean(features) {
  let seen = 0;
  for (const f of features || []) {
    if (f.suppressed) continue;
    if (seen > 0 && f.merge !== 'new') return true;
    seen += 1;
  }
  return false;
}

/** A one-line description for the tree panel. */
export function describeFeature(f, sketchName) {
  if (f.kind === 'import') return 'Imported mesh';
  if (f.kind === 'hole') {
    const size = f.holeType === 'tap' ? f.thread : `Ø${f.diameter}`;
    const kind = { drill: 'Drill', tap: 'Tapped', cbore: "C'bore", csk: "C'sink" }[f.holeType];
    const deep = f.end === 'through' ? 'through all' : `× ${f.depth} mm`;
    return `${kind} ${size} ${deep}${sketchName ? ` · ${sketchName}` : ''}`;
  }
  const where = sketchName ? ` · ${sketchName}` : '';
  const how = f.merge === 'new' ? '' : ` · ${f.merge}`;
  if (f.kind === 'revolve') {
    const deg = Math.round((f.angle * 180) / Math.PI);
    const about = f.axisLine != null ? 'the centerline' : f.axis.toUpperCase();
    return `Revolve ${deg}° about ${about}${where}${how}`;
  }
  const back = f.reverse ? ', reversed' : '';
  if (f.end === 'through') return `Extrude through all${back}${where}${how}`;
  if (f.end === 'mid') return `Extrude ${Math.abs(f.depth)} mm mid plane${where}${how}`;
  return `Extrude ${f.depth} mm${back}${f.base ? ` from ${f.base}` : ''}${where}${how}`;
}
