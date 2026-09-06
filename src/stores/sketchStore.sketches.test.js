import { describe, it, expect, beforeEach } from 'vitest';
import { useSketchStore } from './sketchStore.js';
import { addPoint, addLine } from '../engine/sketch/model.js';
import { useCamPlanStore } from './camPlanStore.js';
import { sketchLoops } from '../engine/sketch/loops.js';

const store = () => useSketchStore.getState();
/** Closed loops of the active sketch. */
const sketchRegionsOf = () => sketchLoops(store().sk);

/**
 * Put the store back to one empty sketch on the table. Written as a direct
 * setState rather than a loop of `removeSketch` so the id counter restarts too —
 * leaving it where the previous test left it hands the next `addSketch` an id
 * one of these entries already has.
 */
beforeEach(() => {
  store().clear(); // a fresh document on the active entry
  useSketchStore.setState({
    sketches: [{ id: 1, name: 'Sketch1', plane: { preset: 'XY', offset: 0 }, doc: store().sk }],
    activeId: 1,
    nextSketchId: 2,
    past: [], future: [], error: null,
  });
});

/** Two points joined by a line, so a sketch has something identifiable in it. */
function draw(sk, x) {
  const a = addPoint(sk, x, 0);
  const b = addPoint(sk, x + 10, 0);
  return addLine(sk, a, b);
}

describe('multi-sketch bookkeeping', () => {
  it('starts with exactly one sketch, active, on the table', () => {
    expect(store().sketches).toHaveLength(1);
    expect(store().activeId).toBe(store().sketches[0].id);
    expect(store().sketches[0].plane).toEqual({ preset: 'XY', offset: 0 });
  });

  it('keeps `sk` and the active entry as the same object, not a copy', () => {
    // This is the whole invariant: an edit mutates in place, so if these ever
    // became two objects every edit would land on one of them only.
    expect(store().sk).toBe(store().activeSketch().doc);
    draw(store().sk, 0);
    store()._bump();
    expect(store().activeSketch().doc.entities.size).toBe(store().sk.entities.size);
  });

  it('adds a sketch on a chosen plane and makes it active', () => {
    const id = store().addSketch({ name: 'Front profile', plane: { preset: 'XZ', offset: 12 } });
    expect(store().sketches).toHaveLength(2);
    expect(store().activeId).toBe(id);
    expect(store().activeSketch().name).toBe('Front profile');
    expect(store().activeSketch().plane).toEqual({ preset: 'XZ', offset: 12 });
    expect(store().sk).toBe(store().activeSketch().doc);
  });

  it('holds each sketch\'s geometry separately across a switch', () => {
    const first = store().activeId;
    draw(store().sk, 0);
    const firstCount = store().sk.entities.size;

    const second = store().addSketch({ plane: { preset: 'YZ', offset: 0 } });
    expect(store().sk.entities.size).toBe(1); // a fresh sketch: just its origin
    draw(store().sk, 100);
    draw(store().sk, 200);

    store().setActiveSketch(first);
    expect(store().sk.entities.size).toBe(firstCount);
    store().setActiveSketch(second);
    expect(store().sk.entities.size).toBe(7); // origin + 2 lines' worth
  });

  it('gives a new sketch an empty history of its own', () => {
    draw(store().sk, 0);
    store()._snapshot();
    expect(store().past.length).toBeGreaterThan(0);
    store().addSketch({});
    expect(store().past).toHaveLength(0);
    expect(store().future).toHaveLength(0);
  });

  it('carries each sketch\'s undo history across a switch, both ways', () => {
    // Undo used to be thrown away on every switch, because the stack held whole
    // documents with no note of which sketch they came from. The stacks travel
    // with the sketch now, so switching away and back is not destructive.
    const first = store().activeId;
    draw(store().sk, 0);
    store()._snapshot();
    draw(store().sk, 50);
    store()._bump();
    const firstDepth = store().past.length;
    const firstSize = store().sk.entities.size;

    const second = store().addSketch({});
    expect(store().past).toHaveLength(0);
    draw(store().sk, 0);
    store()._snapshot();

    store().setActiveSketch(first);
    expect(store().past).toHaveLength(firstDepth);
    // And it undoes *this* sketch, not the one that was open a moment ago.
    store().undo();
    expect(store().sk.entities.size).toBeLessThan(firstSize);

    store().setActiveSketch(second);
    expect(store().past).toHaveLength(1);
  });

  it('takes a removed sketch\'s history away with it', () => {
    const first = store().activeId;
    store()._snapshot();
    const second = store().addSketch({});
    draw(store().sk, 0);
    store()._snapshot();
    expect(store().past).toHaveLength(1);
    store().removeSketch(second);
    // Back on the first sketch, with the first sketch's own stack.
    expect(store().activeId).toBe(first);
    expect(store().past).toHaveLength(1);
  });

  it('keeps undo history out of a saved project', () => {
    // It is a stack of whole documents — the biggest thing in the store — and
    // it means nothing in a session that has not happened yet.
    draw(store().sk, 0);
    store()._snapshot();
    const saved = store().serializeSketches();
    expect(saved.items[0].past).toBeUndefined();
    expect(JSON.stringify(saved)).not.toMatch(/"past"/);
  });

  it('keeps undo pointed at the active entry, not at a document it replaced', () => {
    const sk0 = store().sk;
    store()._snapshot();
    draw(store().sk, 0);
    store()._bump();
    store().undo();
    // `undo` deserializes a *new* document; the entry has to follow it or the
    // next edit would be written into the one that was just undone.
    expect(store().sk).not.toBe(sk0);
    expect(store().sk).toBe(store().activeSketch().doc);
  });

  it('renames and re-planes a sketch without touching its geometry', () => {
    draw(store().sk, 0);
    const before = store().sk.entities.size;
    const id = store().activeId;
    store().renameSketch(id, '  OP20 face  ');
    store().setSketchPlane(id, { preset: 'XZ', offset: -8 });
    expect(store().activeSketch().name).toBe('OP20 face');
    expect(store().activeSketch().plane).toEqual({ preset: 'XZ', offset: -8 });
    expect(store().sk.entities.size).toBe(before);
  });

  it('refuses a blank rename and an unknown plane preset', () => {
    const id = store().activeId;
    expect(store().renameSketch(id, '   ')).toBe(false);
    expect(store().setSketchPlane(id, { preset: 'NOPE' })).toEqual({ preset: 'XY', offset: 0 });
  });

  it('never removes the last sketch — there is always one to draw on', () => {
    expect(store().removeSketch(store().activeId)).toBe(false);
    expect(store().sketches).toHaveLength(1);
  });

  it('moves to a surviving sketch when the active one is removed', () => {
    const first = store().activeId;
    const second = store().addSketch({});
    expect(store().removeSketch(second)).toBe(true);
    expect(store().activeId).toBe(first);
    expect(store().sk).toBe(store().activeSketch().doc);
  });
});

describe('serializeSketches / loadSketches', () => {
  it('round-trips every sketch with its plane and which one was active', () => {
    draw(store().sk, 0);
    const second = store().addSketch({ name: 'Front', plane: { preset: 'XZ', offset: 5 } });
    draw(store().sk, 50);
    draw(store().sk, 90);
    const saved = JSON.parse(JSON.stringify(store().serializeSketches()));

    store().clear();
    store().removeSketch(second);
    expect(store().sketches).toHaveLength(1);

    expect(store().loadSketches(saved)).toBe(true);
    expect(store().sketches).toHaveLength(2);
    expect(store().sketches[1].name).toBe('Front');
    expect(store().sketches[1].plane).toEqual({ preset: 'XZ', offset: 5 });
    expect(store().activeId).toBe(second);
    expect(store().sk.entities.size).toBe(7); // origin + two lines' points and lines
  });

  it('leaves the store alone for a project that carries no sketch list', () => {
    draw(store().sk, 0);
    const before = store().sk;
    expect(store().loadSketches(null)).toBe(false);
    expect(store().loadSketches({ items: [] })).toBe(false);
    expect(store().sk).toBe(before);
  });

  it('hands the next new sketch an id that cannot collide with a loaded one', () => {
    const saved = { active: 9, items: [{ id: 9, name: 'S9', plane: { preset: 'XY', offset: 0 }, doc: { entities: [], constraints: [], nextId: 1 } }] };
    expect(store().loadSketches(saved)).toBe(true);
    expect(store().addSketch({})).toBe(10);
  });

  it('reports a malformed sketch instead of half-loading the list', () => {
    const saved = { active: 1, items: [{ id: 1, name: 'ok', plane: {}, doc: null }] };
    expect(store().loadSketches(saved)).toBe(false);
    expect(store().error).toMatch(/sketches/i);
  });
});

describe('sketchOnFace — starting a second operation on the part', () => {
  const face = (normal, centroid, facing) => ({ normal, centroid, facing, area: 100 });

  it('starts a sketch on the picked face, as the machine\'s own plane when it is one', () => {
    useCamPlanStore.setState({ selectedFeature: face([0, 0, 1], [3, 4, 12], 'up') });
    const id = store().sketchOnFace();
    expect(id).toBeTruthy();
    expect(store().activeId).toBe(id);
    // An axis-aligned face keeps the machine's axes and reads as an offset.
    expect(store().activeSketch().plane).toEqual({ preset: 'XY', offset: 12 });
    expect(store().activeSketch().name).toMatch(/Top \(XY\) \+12/);
  });

  it('builds a custom frame sitting on an angled face', () => {
    useCamPlanStore.setState({
      selectedFeature: face([0, Math.SQRT1_2, Math.SQRT1_2], [1, 2, 3], 'angled'),
    });
    store().sketchOnFace();
    const plane = store().activeSketch().plane;
    expect(plane.preset).toBeUndefined();
    expect(plane.origin).toEqual([1, 2, 3]);
  });

  it('moves the sketch already open onto the face instead of starting a new one', () => {
    const before = store().activeId;
    const count = store().sketches.length;
    useCamPlanStore.setState({ selectedFeature: face([1, 0, 0], [8, 0, 0], 'right') });
    expect(store().sketchOnFace({ onto: before })).toBe(before);
    expect(store().sketches).toHaveLength(count);
    expect(store().activeSketch().plane).toEqual({ preset: 'YZ', offset: 8 });
  });

  it('keeps the geometry when a sketch is moved onto a face', () => {
    draw(store().sk, 0);
    const before = store().sk.entities.size;
    useCamPlanStore.setState({ selectedFeature: face([0, 0, 1], [0, 0, 5], 'up') });
    store().sketchOnFace({ onto: store().activeId });
    expect(store().sk.entities.size).toBe(before);
  });

  it('asks for a face rather than guessing when nothing is picked', () => {
    useCamPlanStore.setState({ selectedFeature: null });
    expect(store().sketchOnFace()).toBeNull();
    expect(store().error).toMatch(/Pick a face on the part first/i);
  });
});

describe('importDxf', () => {
  const dxf = (entities) => [
    '0', 'SECTION', '2', 'ENTITIES', entities, '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const line = (x1, y1, x2, y2) => [
    '0', 'LINE', '8', 'SKETCH',
    '10', String(x1), '20', String(y1), '30', '0',
    '11', String(x2), '21', String(y2), '31', '0',
  ].join('\n');
  const rectDxf = dxf([
    line(0, 0, 40, 0), line(40, 0, 40, 20), line(40, 20, 0, 20), line(0, 20, 0, 0),
  ].join('\n'));

  it('lands the drawing in a new sketch rather than on top of the open one', () => {
    draw(store().sk, 0);
    const before = store().sk;
    const res = store().importDxf(rectDxf, { name: 'bracket' });
    expect(res).toBeTruthy();
    expect(store().sketches).toHaveLength(2);
    expect(store().activeSketch().name).toBe('bracket');
    expect(store().sk).not.toBe(before);
    // The sketch it was drawn beside is untouched.
    expect(store().sketches[0].doc).toBe(before);
  });

  it('keeps `sk` and the active entry the same object after an import', () => {
    store().importDxf(rectDxf);
    expect(store().sk).toBe(store().activeSketch().doc);
  });

  it('imports onto the plane the sketcher is already on', () => {
    store().setSketchPlane(store().activeId, { preset: 'XZ', offset: 7 });
    store().importDxf(rectDxf);
    expect(store().activeSketch().plane).toEqual({ preset: 'XZ', offset: 7 });
  });

  it('gives back a profile that closes, ready to extrude', () => {
    const res = store().importDxf(rectDxf);
    expect(res.counts.line).toBe(4);
    expect(store().regions().regions).toHaveLength(1);
    expect(store().regions().regions[0].area).toBeCloseTo(800);
  });

  it('reports what it had to leave out instead of importing quietly', () => {
    store().importDxf(dxf([line(0, 0, 10, 0), '0', 'SPLINE', '8', 'SKETCH', '10', '0', '20', '0'].join('\n')));
    expect(store().error).toMatch(/SPLINE/);
  });

  it('reports a bad file and starts no sketch for it', () => {
    const count = store().sketches.length;
    expect(store().importDxf('not a dxf')).toBeNull();
    expect(store().error).toMatch(/not a DXF|no ENTITIES/i);
    expect(store().sketches).toHaveLength(count);
  });
});

describe('slot and polygon survive the pick tolerance the zoom hands them', () => {
  /** Drive the three slot clicks the way the toolbar does. */
  const drawSlot = (pickTol, r) => {
    store().clear();
    store().setError(null);
    store().setTool('slot');
    useSketchStore.setState({ pickTol });
    store().clickAt(0, 0);
    store().clickAt(30, 0);
    store().clickAt(15, r);
  };

  it('builds at a working zoom, and at one where the tolerance is 6× the radius', () => {
    // `pickTol` is `9 / zoom`, so it grows without limit as the view zooms out.
    // It used to be handed to the slot builder to weld the slot's *own* tangent
    // points, so at pickTol 9 every slot narrower than ~18 mm collapsed and
    // three clicks produced nothing at all — no shape, no message.
    for (const pickTol of [1.5, 9]) {
      drawSlot(pickTol, 5);
      const { loops } = sketchRegionsOf();
      // eslint-disable-next-line jest/valid-expect
      expect(loops, `pickTol=${pickTol}`).toHaveLength(1);
      expect(Math.round(loops[0].area)).toBe(378); // 30×10 plus a circle of r=5
    }
  });

  it('says so when the zoom is so far out that both axis ends are one point', () => {
    // Two clicks 30 mm apart are ~9 px apart at that zoom, so merging them is
    // right — staying silent about it was not.
    drawSlot(30, 5);
    expect(store().error).toMatch(/landed on one point/i);
  });

  it('says so when the third click sets no radius', () => {
    store().clear();
    store().setError(null);
    store().setTool('slot');
    useSketchStore.setState({ pickTol: 1.5 });
    store().clickAt(0, 0);
    store().clickAt(30, 0);
    store().clickAt(15, 0); // on the axis
    expect(store().error).toMatch(/click to one side of the axis/i);
  });

  it('builds a polygon at a coarse tolerance too', () => {
    store().clear();
    store().setTool('polygon');
    useSketchStore.setState({ pickTol: 9 });
    store().setPolygonSides(6);
    store().clickAt(0, 0);
    store().clickAt(6, 0);
    expect(sketchRegionsOf().loops).toHaveLength(1);
  });
});
