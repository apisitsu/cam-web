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
import { buildSolid, mergeSoups } from './extrude.js';
import { resolvePlaneRef, lineFrame, planeBasis } from '../sketch/plane.js';
import { centerlines } from '../sketch/model.js';
import {
  HOLE_TYPES, THREADS, holeSolid, holePositions, holeRecords,
} from './hole.js';
import { boundsOf } from '../mesh/analyze.js';
import { applyEdgeTreatment, parseEdgeRef } from './edgeTreat.js';
import {
  PATTERN_TYPES, patternTransforms, transformSoup, transformHole,
} from './pattern.js';
import { shellSolid, parseOpenFace } from './shell.js';
import { sweepSolid, loftSolid } from './sweep.js';

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
  chamfer: { label: 'Chamfer', needsSketch: false },
  fillet: { label: 'Fillet', needsSketch: false },
  pattern: { label: 'Pattern', needsSketch: false },
  shell: { label: 'Shell', needsSketch: false },
  sweep: { label: 'Sweep', needsSketch: true },
  loft: { label: 'Loft', needsSketch: true },
};

/** Every sketch a feature is built from: its own, a sweep's path, a loft's profiles. */
export function featureSketchIds(f) {
  const ids = [f.sketchId, f.pathSketchId, ...(f.sketchIds || [])];
  return [...new Set(ids.filter((id) => id != null))];
}

/** Chamfer and fillet work on edges of the part, not on a sketch. */
export const isEdgeTreatment = (f) => f?.kind === 'chamfer' || f?.kind === 'fillet';

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
  if (kind === 'chamfer' || kind === 'fillet') {
    // Cuts an outside edge, fills an inside one — decided per edge on replay.
    return {
      ...base,
      merge: 'cut',
      size: positive(props.size, 1),
      edges: (Array.isArray(props.edges) ? props.edges : []).map(parseEdgeRef).filter(Boolean),
    };
  }
  if (kind === 'sweep' || kind === 'loft') {
    const ids = (Array.isArray(props.sketchIds) ? props.sketchIds : []).filter(Number.isFinite);
    return {
      ...base,
      merge: MERGE_MODES[props.merge] ? props.merge : 'add',
      // Sweep: the profile sketch and the path sketch. Loft: the profiles in order
      // (`sketchId` is the first, so the rest of the app finds one sketch to show).
      sketchId: kind === 'loft' ? (ids[0] ?? null) : (Number.isFinite(props.sketchId) ? props.sketchId : null),
      pathSketchId: kind === 'sweep' && Number.isFinite(props.pathSketchId) ? props.pathSketchId : null,
      sketchIds: kind === 'loft' ? ids : [],
    };
  }
  if (kind === 'shell') {
    return {
      ...base,
      merge: 'cut',
      thickness: positive(props.thickness, 2),
      // The faces left open, as planes (`openFaceRef`); none hollows it closed.
      openFaces: (Array.isArray(props.openFaces) ? props.openFaces : []).map(parseOpenFace).filter(Boolean),
    };
  }
  if (kind === 'pattern') {
    const pattern = PATTERN_TYPES[props.pattern] ? props.pattern : 'linear';
    const axis = (v, d) => (v === 'x' || v === 'y' || v === 'z' ? v : d);
    const count = (v) => (Number.isFinite(v) ? Math.max(1, Math.min(500, Math.round(v))) : 2);
    return {
      ...base,
      name: props.name || PATTERN_TYPES[pattern],
      merge: 'add', // each copy takes its seed's own merge on replay
      pattern,
      // The features copied, by id; none (a mirror only) copies the whole body.
      seeds: (Array.isArray(props.seeds) ? props.seeds : []).filter(Number.isFinite),
      dir: axis(props.dir, 'x'),
      count: count(props.count),
      spacing: Number.isFinite(props.spacing) ? props.spacing : 20,
      dir2: props.dir2 ? axis(props.dir2, null) : null,
      count2: count(props.count2),
      spacing2: Number.isFinite(props.spacing2) ? props.spacing2 : 20,
      axis: axis(props.axis, 'z'),
      center: Array.isArray(props.center) && props.center.length === 3 ? props.center.map(Number) : [0, 0, 0],
      angle: Number.isFinite(props.angle) ? props.angle : 360,
      mirrorPlane: ['XY', 'XZ', 'YZ'].includes(props.mirrorPlane) ? props.mirrorPlane : 'YZ',
      mirrorOffset: Number.isFinite(props.mirrorOffset) ? props.mirrorOffset : 0,
    };
  }
  if (kind === 'hole') {
    // A hole only ever takes material away.
    return {
      ...base,
      merge: 'cut',
      sketchId: Number.isFinite(props.sketchId) ? props.sketchId : null,
      pointIds: Array.isArray(props.pointIds) ? props.pointIds : null,
      holeType: HOLE_TYPES[props.holeType] ? props.holeType : 'drill',
      diameter: positive(props.diameter, 6),
      thread: THREADS[props.thread] ? props.thread : 'M6',
      threadDepth: positive(props.threadDepth, 12),
      cbDiameter: positive(props.cbDiameter, 11),
      cbDepth: positive(props.cbDepth, 6.5),
      cskDiameter: positive(props.cskDiameter, 12),
      cskAngle: positive(props.cskAngle, 90),
      // A 45° mouth chamfer on a drilled or tapped hole; 0 is none.
      chamfer: Number.isFinite(props.chamfer) && props.chamfer > 0 ? props.chamfer : 0,
      // A counterbore's second chamfer: on the hole's edge at the counterbore floor.
      holeChamfer: Number.isFinite(props.holeChamfer) && props.holeChamfer > 0 ? props.holeChamfer : 0,
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
    // Extrude only: walls leaning in by this many degrees (negative leans out).
    draft: Number.isFinite(props.draft) && Math.abs(props.draft) < 89 ? props.draft : 0,
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
  sketchOf, importOf, refBounds, planes, used, partBounds, meshBoolean,
}) {
  if (feature.kind === 'import') {
    const soup = importOf?.(feature);
    if (!soup?.triangleCount) {
      throw new Error('the imported mesh this was built from is no longer loaded');
    }
    return soup;
  }
  if (feature.kind === 'loft') {
    return makeLoft(feature, {
      sketchOf, refBounds, planes, used, meshBoolean,
    });
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
  if (feature.kind === 'sweep') return makeSweep(feature, entry.doc, plane, { sketchOf, refBounds, planes, used });

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
    draft: feature.kind === 'extrude' ? feature.draft : 0,
    mid: feature.kind === 'extrude' && feature.end === 'mid',
    axis: feature.axis,
    angle: feature.angle,
    segments: feature.segments ?? undefined,
  };
  if (feature.kind === 'revolve' && feature.axisLine != null) {
    return revolveAboutLine(regions, entry.doc, feature.axisLine, shape);
  }
  return buildSolid(regions, shape);
}

/** A sketch for a sweep or loft, on the plane it sits on now. */
function placedSketch(id, { sketchOf, refBounds, planes, used }, what) {
  const entry = sketchOf?.(id);
  if (!entry?.doc) throw new Error(`its ${what} sketch is gone`);
  used?.add(id);
  const plane = resolvePlaneRef(entry.plane, refBounds);
  if (plane !== entry.plane) planes?.set(id, plane);
  return { doc: entry.doc, plane };
}

/** Sweep each closed profile of the feature's sketch along its path sketch's open chain. */
function makeSweep(feature, doc, plane, ctx) {
  if (feature.pathSketchId == null) throw new Error('pick the sketch with the path to sweep along');
  if (feature.pathSketchId === feature.sketchId) throw new Error('the path must be in a sketch of its own');
  const path = placedSketch(feature.pathSketchId, ctx, 'path');
  const chain = sketchRegions(path.doc).open[0];
  if (!chain) throw new Error('the path sketch has no open line or arc chain to sweep along');
  const { regions } = sketchRegions(doc);
  if (!regions.length) throw new Error('its profile sketch does not enclose a closed profile');
  return mergeSoups(regions.map((r) => sweepSolid(r, plane, chain.points, path.plane)), 'sweep');
}

/** Loft through the biggest closed profile of each of the feature's sketches, in order. */
function makeLoft(feature, ctx) {
  if (feature.sketchIds.length < 2) throw new Error('pick two profile sketches or more, in order');
  const profiles = feature.sketchIds.map((id, i) => {
    const { doc, plane } = placedSketch(id, ctx, `profile ${i + 1}`);
    const { regions } = sketchRegions(doc);
    if (!regions.length) throw new Error(`profile ${i + 1} does not enclose a closed profile`);
    return { outer: regions[0].outer, holes: regions[0].holes || [], plane };
  });
  const body = loftSolid(profiles.map(({ outer, plane }) => ({ outer, plane })));
  const nh = profiles[0].holes.length;
  if (profiles.some((p) => p.holes.length !== nh)) {
    throw new Error('every profile needs the same number of holes for the holes to loft through');
  }
  if (!nh) return body;
  if (!ctx.meshBoolean) throw new Error('no solid boolean is available to cut the holes');
  // Each hole is lofted through the hole in the same place, measured from its
  // profile's own middle, of every other profile, and cut out of the body.
  const mid = (loop) => {
    let x = 0; let y = 0;
    for (let i = 0; i < loop.length; i += 2) { x += loop[i]; y += loop[i + 1]; }
    return [(x * 2) / loop.length, (y * 2) / loop.length];
  };
  const placeOf = (p, h) => { const a = mid(h); const o = mid(p.outer); return [a[0] - o[0], a[1] - o[1]]; };
  const tools = profiles[0].holes.map(() => []);
  profiles.forEach((p, k) => {
    const free = p.holes.slice();
    profiles[0].holes.forEach((h0, j) => {
      const want = placeOf(profiles[0], h0);
      let best = 0;
      free.forEach((h, i) => {
        const at = placeOf(p, h); const b = placeOf(p, free[best]);
        if (Math.hypot(at[0] - want[0], at[1] - want[1]) < Math.hypot(b[0] - want[0], b[1] - want[1])) best = i;
      });
      tools[j][k] = { outer: free.splice(best, 1)[0], plane: p.plane };
    });
  });
  const cutters = tools.map((t) => loftSolid(t));
  const once = cutters.length > 1 ? ctx.meshBoolean.many?.(body, cutters, 'cut', 'loft') : null;
  if (once) return once;
  return cutters.reduce((s, c) => ctx.meshBoolean(s, c, 'cut', 'loft'), body);
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
  const positions = holePositions(doc, feature.pointIds);
  const solid = holeSolid(positions, plane, feature, {
    depth, through, reverse: feature.reverse, segments: feature.segments ?? undefined,
  });
  return {
    ...solid,
    holes: holeRecords(positions, plane, feature, { depth, through, reverse: feature.reverse }),
  };
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
 * @returns {{soup:object|null, steps:object[], errors:object[], planes:Map<number,object>,
 *   holes:object[]}}
 *   `holes` are the Hole features' `holeRecords`, for CAM.
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
  let holes = [];
  // Each built feature's own solid and how it joined, for a pattern to copy.
  const solids = new Map();

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

    if (isEdgeTreatment(f)) {
      if (!current) { fail(f, `a ${f.kind} needs a part to work on`); continue; }
      try {
        current = applyEdgeTreatment(current, f, meshBoolean);
      } catch (e) {
        fail(f, e?.message || String(e));
        continue;
      }
      steps.push({
        id: f.id, name: f.name, kind: f.kind, ok: true, merge: f.merge, triangleCount: current.triangleCount,
        ...(keepIntermediates ? { soup: current } : {}),
      });
      continue;
    }

    if (f.kind === 'shell') {
      if (!current) { fail(f, 'a shell needs a part to hollow'); continue; }
      try {
        current = shellSolid(current, f, meshBoolean);
      } catch (e) {
        fail(f, e?.message || String(e));
        continue;
      }
      steps.push({
        id: f.id, name: f.name, kind: f.kind, ok: true, merge: f.merge, triangleCount: current.triangleCount,
        ...(keepIntermediates ? { soup: current } : {}),
      });
      continue;
    }

    if (f.kind === 'pattern') {
      if (!current) { fail(f, 'a pattern needs a part to work on'); continue; }
      try {
        const out = applyPattern(current, f, solids, meshBoolean);
        current = out.soup;
        holes.push(...out.holes);
      } catch (e) {
        fail(f, e?.message || String(e));
        continue;
      }
      steps.push({
        id: f.id, name: f.name, kind: f.kind, ok: true, merge: f.merge, triangleCount: current.triangleCount,
        ...(keepIntermediates ? { soup: current } : {}),
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

    // How a copy of this feature joins the part: the base of the part is a boss.
    const seedMerge = !current || f.merge === 'new' ? 'add' : f.merge;
    // Nothing to combine with yet: the first feature that builds is the base,
    // whatever merge mode it happens to carry.
    if (!current || f.merge === 'new') {
      current = made;
      holes = [];
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

    if (made.holes) holes.push(...made.holes);
    solids.set(f.id, { soup: made, merge: seedMerge, holes: made.holes || [] });
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

  return {
    soup: current, steps, errors, planes, holes,
  };
}

/**
 * Replay a Pattern or Mirror: every copy of each seed's solid, joined to the part
 * with that seed's merge in one pass where the boolean allows it. With no seeds a
 * mirror copies the whole body as it stands and joins the reflection to it.
 */
function applyPattern(current, f, solids, meshBoolean) {
  if (!meshBoolean) throw new Error('no solid boolean is available to combine the copies');
  const xforms = patternTransforms(f);
  if (!xforms.length) throw new Error('the pattern makes no copies — raise the count');
  const groups = [];
  if (!f.seeds.length) {
    if (f.pattern !== 'mirror') throw new Error('pick the features to pattern');
    groups.push({ soup: current, merge: 'add', holes: [] });
  } else {
    for (const id of f.seeds) {
      const seed = solids.get(id);
      if (!seed) throw new Error('a feature it copies is gone, failed, suppressed or comes after it');
      groups.push(seed);
    }
  }
  let soup = current;
  const holes = [];
  for (const g of groups) {
    const op = g.merge === 'cut' ? 'cut' : g.merge === 'common' ? 'common' : 'add';
    const tools = xforms.map((x) => transformSoup(g.soup, x));
    const many = tools.length > 1 && meshBoolean.many ? meshBoolean.many(soup, tools, op, 'pattern') : null;
    if (many) soup = many;
    else for (const t of tools) soup = meshBoolean(soup, t, op, 'pattern');
    for (const x of xforms) holes.push(...g.holes.map((h) => transformHole(h, x)));
  }
  return { soup, holes };
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
  if (isEdgeTreatment(f)) {
    const n = f.edges.length;
    const size = f.kind === 'fillet' ? `R${f.size}` : `${f.size} mm`;
    return `${f.kind === 'fillet' ? 'Fillet' : 'Chamfer'} ${size} · ${n} edge${n === 1 ? '' : 's'}`;
  }
  if (f.kind === 'sweep') return `Sweep${sketchName ? ` · ${sketchName}` : ''}${f.merge === 'cut' ? ' · cut' : ''}`;
  if (f.kind === 'loft') return `Loft through ${f.sketchIds.length} profiles${f.merge === 'cut' ? ' · cut' : ''}`;
  if (f.kind === 'shell') {
    const n = f.openFaces.length;
    return `Shell ${f.thickness} mm · ${n ? `${n} face${n === 1 ? '' : 's'} open` : 'closed'}`;
  }
  if (f.kind === 'pattern') {
    const n = f.seeds.length;
    const what = n ? `${n} feature${n === 1 ? '' : 's'}` : 'the body';
    if (f.pattern === 'mirror') return `Mirror ${what} in ${f.mirrorPlane}${f.mirrorOffset ? ` at ${f.mirrorOffset} mm` : ''}`;
    if (f.pattern === 'circular') return `Circular pattern ${what} × ${f.count} about ${f.axis.toUpperCase()}, ${f.angle}°`;
    const grid = f.dir2 ? ` × ${f.count2} along ${f.dir2.toUpperCase()}` : '';
    return `Linear pattern ${what} × ${f.count} along ${f.dir.toUpperCase()} @ ${f.spacing} mm${grid}`;
  }
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
  const drafted = f.draft ? `, draft ${f.draft}°` : '';
  if (f.end === 'through') return `Extrude through all${back}${drafted}${where}${how}`;
  if (f.end === 'mid') return `Extrude ${Math.abs(f.depth)} mm mid plane${drafted}${where}${how}`;
  return `Extrude ${f.depth} mm${back}${f.base ? ` from ${f.base}` : ''}${drafted}${where}${how}`;
}
