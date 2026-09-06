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
 * once an earlier feature changes the shape. Nothing here names a face. A sketch
 * placed on a face stores the **resolved plane** — an origin and two axes — which
 * is just numbers and cannot go stale (`planeFromFace`).
 *
 * The price is stated rather than hidden: changing an early feature does **not**
 * move a sketch that was placed on its face. That is a limitation, but it is a
 * predictable one, and predictable beats a reference that silently re-binds to
 * the wrong face.
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

/** What a feature can be. `import` is the mesh a file was read into. */
export const FEATURE_KINDS = {
  import: { label: 'Import', needsSketch: false },
  extrude: { label: 'Extrude', needsSketch: true },
  revolve: { label: 'Revolve', needsSketch: true },
};

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
  return {
    ...base,
    sketchId: Number.isFinite(props.sketchId) ? props.sketchId : null,
    // Boolean applied to the sketch's own profiles, before anything is built.
    combine: props.combine || null,
    depth: Number.isFinite(props.depth) ? props.depth : 10,
    base: Number.isFinite(props.base) ? props.base : 0,
    axis: props.axis === 'y' ? 'y' : 'x',
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
function makeFeatureSolid(feature, { sketchOf, importOf }) {
  if (feature.kind === 'import') {
    const soup = importOf?.(feature);
    if (!soup?.triangleCount) {
      throw new Error('the imported mesh this was built from is no longer loaded');
    }
    return soup;
  }
  const entry = sketchOf?.(feature.sketchId);
  if (!entry?.doc) throw new Error('its sketch is gone');

  const found = sketchRegions(entry.doc);
  let regions = found.regions;
  if (feature.combine && regions.length > 1) regions = combineRegions(regions, feature.combine);
  if (!regions.length) {
    throw new Error(found.open.length
      ? 'its sketch no longer encloses a closed profile'
      : 'its sketch is empty');
  }
  return buildSolid(regions, {
    op: feature.kind,
    plane: entry.plane,
    depth: feature.depth,
    base: feature.base,
    axis: feature.axis,
    angle: feature.angle,
    segments: feature.segments ?? undefined,
  });
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
 * @returns {{soup:object|null, steps:object[], errors:object[]}}
 */
export function rebuildFeatures(features, ctx = {}, { keepIntermediates = false } = {}) {
  const { meshBoolean } = ctx;
  let current = null;
  const steps = [];
  const errors = [];

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
      made = makeFeatureSolid(f, ctx);
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

    steps.push({
      id: f.id,
      name: f.name,
      kind: f.kind,
      ok: true,
      triangleCount: current.triangleCount,
      ...(keepIntermediates ? { soup: current } : {}),
    });
  }

  return { soup: current, steps, errors };
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
  const where = sketchName ? ` · ${sketchName}` : '';
  const how = f.merge === 'new' ? '' : ` · ${f.merge}`;
  if (f.kind === 'revolve') {
    const deg = Math.round((f.angle * 180) / Math.PI);
    return `Revolve ${deg}° about ${f.axis.toUpperCase()}${where}${how}`;
  }
  return `Extrude ${f.depth} mm${f.base ? ` from ${f.base}` : ''}${where}${how}`;
}
