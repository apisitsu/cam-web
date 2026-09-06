import { describe, it, expect } from 'vitest';
import {
  createFeature, parseFeatures, rebuildFeatures, needsMeshBoolean,
  describeFeature, FEATURE_KINDS, MERGE_MODES, seedFeatureIds,
} from './featureTree.js';
import { meshBoolean } from '../../lib/csg.js';
import { createSketch, addPoint, addLine } from '../sketch/model.js';
import { volume } from './solidAssert.js';

/** Add a closed rectangle to an existing sketch. */
function addRect(sk, x0, y0, x1, y1) {
  const p1 = addPoint(sk, x0, y0);
  const p2 = addPoint(sk, x1, y0);
  const p3 = addPoint(sk, x1, y1);
  const p4 = addPoint(sk, x0, y1);
  addLine(sk, p1, p2);
  addLine(sk, p2, p3);
  addLine(sk, p3, p4);
  addLine(sk, p4, p1);
  return [p1, p2, p3, p4];
}

/** A closed rectangle as a sketch document of its own. */
function rectSketch(x0, y0, x1, y1) {
  const sk = createSketch();
  addRect(sk, x0, y0, x1, y1);
  return sk;
}


/** A context over a plain map of sketches. */
function ctx(sketches, imports = {}) {
  return {
    sketchOf: (id) => sketches[id] || null,
    importOf: (f) => imports[f.id] || null,
    meshBoolean,
  };
}

const XY = { preset: 'XY', offset: 0 };

describe('createFeature / parseFeatures', () => {
  it('fills in the defaults for an extrude', () => {
    const f = createFeature('extrude', { sketchId: 1 });
    expect(f).toMatchObject({
      kind: 'extrude', sketchId: 1, depth: 10, base: 0, merge: 'new', suppressed: false,
    });
    expect(f.id).toBeGreaterThan(0);
  });

  it('gives every feature a distinct id', () => {
    const ids = [1, 2, 3].map(() => createFeature('extrude', {}).id);
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps an id it is handed and never hands it out again', () => {
    seedFeatureIds(500);
    expect(createFeature('extrude', { id: 900 }).id).toBe(900);
    expect(createFeature('extrude', {}).id).toBeGreaterThan(900);
  });

  it('refuses a kind it does not have, and falls back on a merge it does not', () => {
    expect(() => createFeature('emboss', {})).toThrow(/unknown feature kind/);
    expect(createFeature('extrude', { merge: 'squish' }).merge).toBe('new');
  });

  it('reads a tree from a file, dropping only the entries it cannot use', () => {
    const parsed = parseFeatures([
      { kind: 'import', id: 1, name: 'part.stl' },
      { kind: 'nonsense', id: 2 },
      null,
      { kind: 'extrude', id: 3, sketchId: 7, depth: 4 },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toMatchObject({ kind: 'extrude', sketchId: 7, depth: 4 });
  });

  it('reads an empty or missing tree as no features', () => {
    expect(parseFeatures(null)).toEqual([]);
    expect(parseFeatures('nope')).toEqual([]);
  });
});

describe('rebuildFeatures — the fold', () => {
  it('builds a single extrude', () => {
    const sketches = { 1: { doc: rectSketch(0, 0, 40, 20), plane: XY } };
    const f = createFeature('extrude', { sketchId: 1, depth: 6 });
    const { soup, steps, errors } = rebuildFeatures([f], ctx(sketches));
    expect(errors).toEqual([]);
    expect(steps[0].ok).toBe(true);
    expect(volume(soup)).toBeCloseTo(40 * 20 * 6, 2);
  });

  it('cuts a second feature out of the first', () => {
    const sketches = {
      1: { doc: rectSketch(0, 0, 40, 40), plane: XY },
      2: { doc: rectSketch(15, 15, 25, 25), plane: XY },
    };
    const tree = [
      createFeature('extrude', { sketchId: 1, depth: 10 }),
      createFeature('extrude', { sketchId: 2, depth: 30, base: -10, merge: 'cut' }),
    ];
    const { soup, errors } = rebuildFeatures(tree, ctx(sketches));
    expect(errors).toEqual([]);
    expect(volume(soup)).toBeCloseTo(40 * 40 * 10 - 10 * 10 * 10, 1);
  });

  it('replays the whole tree after a parameter changes — the point of all this', () => {
    const sketches = {
      1: { doc: rectSketch(0, 0, 40, 40), plane: XY },
      2: { doc: rectSketch(15, 15, 25, 25), plane: XY },
    };
    const tree = [
      createFeature('extrude', { sketchId: 1, depth: 10 }),
      createFeature('extrude', { sketchId: 2, depth: 30, base: -10, merge: 'cut' }),
    ];
    expect(volume(rebuildFeatures(tree, ctx(sketches)).soup))
      .toBeCloseTo(16000 - 1000, 1);

    // Edit the plate's thickness only. Everything downstream follows.
    tree[0] = { ...tree[0], depth: 20 };
    expect(volume(rebuildFeatures(tree, ctx(sketches)).soup))
      .toBeCloseTo(40 * 40 * 20 - 10 * 10 * 20, 1);
  });

  it('follows an edit to the **sketch**, not just to the parameters', () => {
    const sketches = { 1: { doc: rectSketch(0, 0, 40, 20), plane: XY } };
    const tree = [createFeature('extrude', { sketchId: 1, depth: 5 })];
    expect(volume(rebuildFeatures(tree, ctx(sketches)).soup)).toBeCloseTo(4000, 2);
    sketches[1].doc = rectSketch(0, 0, 80, 20);
    expect(volume(rebuildFeatures(tree, ctx(sketches)).soup)).toBeCloseTo(8000, 2);
  });

  it('rebuilds onto a different plane when the sketch is moved', () => {
    const sketches = { 1: { doc: rectSketch(0, 0, 40, 20), plane: XY } };
    const tree = [createFeature('extrude', { sketchId: 1, depth: 6 })];
    const flat = rebuildFeatures(tree, ctx(sketches)).soup;
    sketches[1].plane = { preset: 'XZ', offset: 0 };
    const upright = rebuildFeatures(tree, ctx(sketches)).soup;
    // Same volume, different orientation.
    expect(volume(upright)).toBeCloseTo(volume(flat), 2);
    const zOf = (s) => Math.max(...Array.from({ length: s.positions.length / 3 }, (_, i) => s.positions[i * 3 + 2]));
    expect(zOf(flat)).toBeCloseTo(6);
    expect(zOf(upright)).toBeCloseTo(20);
  });

  it('starts a new body when a feature says so, discarding what came before', () => {
    const sketches = {
      1: { doc: rectSketch(0, 0, 40, 40), plane: XY },
      2: { doc: rectSketch(0, 0, 10, 10), plane: XY },
    };
    const tree = [
      createFeature('extrude', { sketchId: 1, depth: 10 }),
      createFeature('extrude', { sketchId: 2, depth: 10, merge: 'new' }),
    ];
    expect(volume(rebuildFeatures(tree, ctx(sketches)).soup)).toBeCloseTo(1000, 2);
  });

  it('takes the first feature as the base whatever merge it carries', () => {
    // Nothing exists for it to cut into, so "cut" cannot mean anything yet.
    const sketches = { 1: { doc: rectSketch(0, 0, 10, 10), plane: XY } };
    const tree = [createFeature('extrude', { sketchId: 1, depth: 5, merge: 'cut' })];
    const { soup, errors } = rebuildFeatures(tree, ctx(sketches));
    expect(errors).toEqual([]);
    expect(volume(soup)).toBeCloseTo(500, 2);
  });

  it('builds on an imported mesh as the base of the tree', () => {
    const sketches = { 2: { doc: rectSketch(15, 15, 25, 25), plane: XY } };
    const imported = rebuildFeatures(
      [createFeature('extrude', { sketchId: 9, depth: 10 })],
      ctx({ 9: { doc: rectSketch(0, 0, 40, 40), plane: XY } }),
    ).soup;

    const base = createFeature('import', { name: 'plate.stl' });
    const tree = [
      base,
      createFeature('extrude', { sketchId: 2, depth: 30, base: -10, merge: 'cut' }),
    ];
    const { soup, errors } = rebuildFeatures(tree, ctx(sketches, { [base.id]: imported }));
    expect(errors).toEqual([]);
    expect(volume(soup)).toBeCloseTo(16000 - 1000, 1);
  });

  it('applies the profile boolean before it builds anything', () => {
    // Two overlapping profiles on one sketch. `sketchLoops` arranges them, so
    // the overlap is already its own region and is **not** counted twice either
    // way — the boolean's job here is to merge three arranged regions into one
    // outline, which is what the region count says and the volume confirms.
    const doc = rectSketch(0, 0, 20, 20);
    addRect(doc, 10, 10, 30, 30);
    const sketches = { 1: { doc, plane: XY } };
    const solid = 400 + 400 - 100;

    const apart = rebuildFeatures(
      [createFeature('extrude', { sketchId: 1, depth: 2 })], ctx(sketches),
    );
    expect(apart.errors).toEqual([]);
    expect(volume(apart.soup)).toBeCloseTo(solid * 2, 2);

    const merged = rebuildFeatures(
      [createFeature('extrude', { sketchId: 1, depth: 2, combine: 'union' })], ctx(sketches),
    );
    expect(merged.errors).toEqual([]);
    expect(volume(merged.soup)).toBeCloseTo(solid * 2, 2);
    // One outline instead of three abutting ones: fewer walls, same solid.
    expect(merged.soup.triangleCount).toBeLessThan(apart.soup.triangleCount);
  });
});

describe('rebuildFeatures — suppression and ordering', () => {
  const sketches = () => ({
    1: { doc: rectSketch(0, 0, 40, 40), plane: XY },
    2: { doc: rectSketch(15, 15, 25, 25), plane: XY },
  });

  it('skips a suppressed feature and says it did', () => {
    const tree = [
      createFeature('extrude', { sketchId: 1, depth: 10 }),
      createFeature('extrude', {
        sketchId: 2, depth: 30, base: -10, merge: 'cut', suppressed: true,
      }),
    ];
    const { soup, steps, errors } = rebuildFeatures(tree, ctx(sketches()));
    expect(errors).toEqual([]);
    expect(steps[1].suppressed).toBe(true);
    expect(volume(soup)).toBeCloseTo(16000, 1); // the cut did not happen
  });

  it('gives a different part when the order changes', () => {
    const s = sketches();
    const plate = createFeature('extrude', { sketchId: 1, depth: 10 });
    const pocket = createFeature('extrude', {
      sketchId: 2, depth: 30, base: -10, merge: 'cut',
    });
    const cutAfter = rebuildFeatures([plate, pocket], ctx(s)).soup;
    // Cutting before there is anything to cut leaves the pocket as the base and
    // the plate then replaces it — order is not decoration.
    const cutFirst = rebuildFeatures([pocket, plate], ctx(s)).soup;
    expect(volume(cutAfter)).toBeCloseTo(15000, 1);
    expect(volume(cutFirst)).toBeCloseTo(16000, 1);
  });
});

describe('rebuildFeatures — when a feature breaks', () => {
  it('keeps the part and names the feature that failed', () => {
    const open = createSketch();
    const a = addPoint(open, 0, 0);
    const b = addPoint(open, 10, 0);
    addLine(open, a, b); // never closes
    const sketches = {
      1: { doc: rectSketch(0, 0, 40, 40), plane: XY },
      2: { doc: open, plane: XY },
    };
    const tree = [
      createFeature('extrude', { sketchId: 1, depth: 10 }),
      createFeature('extrude', { sketchId: 2, depth: 5, merge: 'cut', name: 'Pocket' }),
    ];
    const { soup, steps, errors } = rebuildFeatures(tree, ctx(sketches));
    expect(errors).toHaveLength(1);
    expect(errors[0].name).toBe('Pocket');
    expect(errors[0].message).toMatch(/closed profile/i);
    expect(steps[1].ok).toBe(false);
    // The plate survives — one broken operation costs that operation, not the part.
    expect(volume(soup)).toBeCloseTo(16000, 1);
  });

  it('says so when a feature\'s sketch has been deleted', () => {
    const tree = [createFeature('extrude', { sketchId: 99, depth: 5 })];
    const { soup, errors } = rebuildFeatures(tree, ctx({}));
    expect(soup).toBeNull();
    expect(errors[0].message).toMatch(/sketch is gone/i);
  });

  it('says so when the imported mesh is no longer loaded', () => {
    const tree = [createFeature('import', { name: 'part.stl' })];
    const { errors } = rebuildFeatures(tree, ctx({}, {}));
    expect(errors[0].message).toMatch(/no longer loaded/i);
  });

  it('carries on past a broken feature to the ones after it', () => {
    const sketches = {
      1: { doc: rectSketch(0, 0, 40, 40), plane: XY },
      3: { doc: rectSketch(0, 0, 5, 5), plane: XY },
    };
    const tree = [
      createFeature('extrude', { sketchId: 1, depth: 10 }),
      createFeature('extrude', { sketchId: 99, depth: 5, merge: 'cut' }), // broken
      createFeature('extrude', { sketchId: 3, depth: 30, base: -10, merge: 'cut' }),
    ];
    const { soup, errors } = rebuildFeatures(tree, ctx(sketches));
    expect(errors).toHaveLength(1);
    expect(volume(soup)).toBeCloseTo(16000 - 250, 1); // the third one still cut
  });

  it('reports rather than throws when a boolean is needed and not supplied', () => {
    const sketches = {
      1: { doc: rectSketch(0, 0, 40, 40), plane: XY },
      2: { doc: rectSketch(15, 15, 25, 25), plane: XY },
    };
    const tree = [
      createFeature('extrude', { sketchId: 1, depth: 10 }),
      createFeature('extrude', { sketchId: 2, depth: 5, merge: 'cut' }),
    ];
    const { soup, errors } = rebuildFeatures(tree, {
      sketchOf: (id) => sketches[id] || null,
    });
    expect(errors[0].message).toMatch(/no solid boolean/i);
    expect(volume(soup)).toBeCloseTo(16000, 1);
  });

  it('is empty for an empty tree', () => {
    expect(rebuildFeatures([], ctx({}))).toEqual({ soup: null, steps: [], errors: [] });
    expect(rebuildFeatures(null, ctx({})).soup).toBeNull();
  });
});

describe('needsMeshBoolean', () => {
  it('is false while nothing combines with anything', () => {
    expect(needsMeshBoolean([createFeature('extrude', {})])).toBe(false);
    expect(needsMeshBoolean([
      createFeature('extrude', {}), createFeature('extrude', { merge: 'new' }),
    ])).toBe(false);
  });

  it('is true as soon as a later feature merges', () => {
    expect(needsMeshBoolean([
      createFeature('extrude', {}), createFeature('extrude', { merge: 'cut' }),
    ])).toBe(true);
  });

  it('ignores suppressed features, which do not run', () => {
    expect(needsMeshBoolean([
      createFeature('extrude', {}),
      createFeature('extrude', { merge: 'cut', suppressed: true }),
    ])).toBe(false);
  });
});

describe('keepIntermediates', () => {
  it('hands back each step\'s solid when asked, and not otherwise', () => {
    const sketches = {
      1: { doc: rectSketch(0, 0, 40, 40), plane: XY },
      2: { doc: rectSketch(15, 15, 25, 25), plane: XY },
    };
    const tree = [
      createFeature('extrude', { sketchId: 1, depth: 10 }),
      createFeature('extrude', { sketchId: 2, depth: 30, base: -10, merge: 'cut' }),
    ];
    expect(rebuildFeatures(tree, ctx(sketches)).steps[0].soup).toBeUndefined();
    const kept = rebuildFeatures(tree, ctx(sketches), { keepIntermediates: true });
    expect(volume(kept.steps[0].soup)).toBeCloseTo(16000, 1);
    expect(volume(kept.steps[1].soup)).toBeCloseTo(15000, 1);
  });
});

describe('describeFeature', () => {
  it('says what each kind is, in the words the tree shows', () => {
    expect(describeFeature(createFeature('import', {}))).toBe('Imported mesh');
    expect(describeFeature(createFeature('extrude', { depth: 12 }), 'Base'))
      .toBe('Extrude 12 mm · Base');
    expect(describeFeature(createFeature('extrude', { depth: 5, merge: 'cut' }), 'Pocket'))
      .toBe('Extrude 5 mm · Pocket · cut');
    expect(describeFeature(createFeature('revolve', { angle: Math.PI }), 'Profile'))
      .toBe('Revolve 180° about X · Profile');
  });
});

describe('the tables stay coherent', () => {
  it('names a label for every kind and a sentence for every merge mode', () => {
    for (const [kind, spec] of Object.entries(FEATURE_KINDS)) {
      // eslint-disable-next-line jest/valid-expect
      expect(spec.label, kind).toBeTruthy();
      expect(typeof spec.needsSketch).toBe('boolean');
    }
    for (const [mode, text] of Object.entries(MERGE_MODES)) {
      // eslint-disable-next-line jest/valid-expect
      expect(text, mode).toMatch(/—/);
    }
  });
});
