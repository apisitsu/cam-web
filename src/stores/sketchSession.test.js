/**
 * A sketch is opened, drawn, and closed: picking a plane starts one, building
 * from it closes it, and finishing an edit brings the part up to date.
 */
import {
  describe, it, expect, beforeEach,
} from 'vitest';
import { useSketchStore } from './sketchStore.js';
import { getRawMesh } from './camPlanStore.js';
import { useCamStore } from './camStore.js';
import { useFeatureStore } from './featureStore.js';
import { addPoint, addLine } from '../engine/sketch/model.js';
import { boundsOf } from '../engine/mesh/analyze.js';

const sketch = () => useSketchStore.getState();
const tree = () => useFeatureStore.getState();
const partLength = () => boundsOf(getRawMesh().soup).size[0];

function rect(x1, y1) {
  const { sk } = sketch();
  const p1 = addPoint(sk, 0, 0);
  const p2 = addPoint(sk, x1, 0);
  const p3 = addPoint(sk, x1, y1);
  const p4 = addPoint(sk, 0, y1);
  addLine(sk, p1, p2);
  addLine(sk, p2, p3);
  addLine(sk, p3, p4);
  addLine(sk, p4, p1);
  sketch()._bump();
}

/** Stretch the rectangle: every corner at x = `from` moves to `to`. */
function moveEdge(from, to) {
  const { sk } = sketch();
  for (const e of sk.entities.values()) if (e.type === 'point' && e.x === from) e.x = to;
  sketch()._bump();
}

beforeEach(() => {
  tree().clear();
  sketch().clear();
  useSketchStore.setState({
    sketches: [{
      id: 1, name: 'Sketch1', plane: { preset: 'XY', offset: 0 }, doc: sketch().sk,
    }],
    activeId: 1,
    nextSketchId: 2,
    sketchOpen: false,
    past: [],
    future: [],
    error: null,
  });
  useCamStore.setState({ page: 'sketch', mode: 'mill', view: 'iso' });
});

describe('picking a plane', () => {
  it('uses the blank first sketch rather than leaving it behind empty', () => {
    const id = tree().startSketch({ preset: 'XZ', offset: 0 });
    expect(id).toBe(1);
    expect(sketch().sketches).toHaveLength(1);
    expect(sketch().activeSketch().plane.preset).toBe('XZ');
    expect(sketch().sketchOpen).toBe(true);
  });

  it('starts a new sketch once the last one has been built, and turns the view square to it', async () => {
    tree().startSketch({ preset: 'XY', offset: 0 });
    rect(40, 20);
    await tree().buildFromSketch({ op: 'extrude', depth: 10 });

    const id = tree().startSketch({ preset: 'XZ', offset: 0 });
    expect(id).toBe(2);
    expect(sketch().activeSketch().name).toBe('Sketch2');
    expect(sketch().sk.entities.size).toBe(1); // only the origin
    expect(useCamStore.getState().view).toEqual({ dir: [0, -1, 0], up: [0, 0, 1] });
  });

  it('keeps a sketch with geometry and opens a new one beside it', () => {
    tree().startSketch({ preset: 'XY', offset: 0 });
    rect(40, 20);
    expect(tree().startSketch({ preset: 'YZ', offset: 0 })).toBe(2);
    expect(sketch().sketches).toHaveLength(2);
  });
});

describe('building', () => {
  it('closes the sketch and stays on the Sketch page, in a view showing the planes', async () => {
    tree().startSketch({ preset: 'XY', offset: 0 });
    rect(40, 20);
    await tree().buildFromSketch({ op: 'extrude', depth: 10 });
    expect(sketch().sketchOpen).toBe(false);
    expect(useCamStore.getState().page).toBe('sketch');
    expect(useCamStore.getState().view).toBe('iso');
  });

  it('leaves a sketch open when the build fails', async () => {
    tree().startSketch({ preset: 'XY', offset: 0 });
    await tree().buildFromSketch({ op: 'extrude', depth: 10 });
    expect(sketch().sketchOpen).toBe(true);
  });
});

describe('editing a built sketch', () => {
  beforeEach(async () => {
    tree().startSketch({ preset: 'XY', offset: 0 });
    rect(40, 20);
    await tree().buildFromSketch({ op: 'extrude', depth: 10 });
  });

  it('opens from another page and comes back to the Sketch page', () => {
    useCamStore.setState({ page: 'mill' });
    expect(tree().editSketch(1)).toBe(true);
    expect(sketch().sketchOpen).toBe(true);
    expect(useCamStore.getState().page).toBe('sketch');
  });

  it('finishing rebuilds the part with the edit, and stays on the page', async () => {
    tree().editSketch(1);
    moveEdge(40, 60);
    expect(tree().dirty).toBe(true);
    await tree().finishSketch();
    expect(partLength()).toBeCloseTo(60);
    expect(tree().dirty).toBe(false);
    expect(useCamStore.getState().page).toBe('sketch');
    expect(sketch().sketchOpen).toBe(false);
  });

  it('finishing without an edit does not rebuild', async () => {
    tree().editSketch(1);
    expect(await tree().finishSketch()).toBeNull();
  });

  it('leaving by a tab finishes the sketch too', async () => {
    tree().editSketch(1);
    moveEdge(40, 75);
    await useCamStore.getState().setPage('mill');
    await expect.poll(() => tree().dirty).toBe(false);
    expect(sketch().sketchOpen).toBe(false);
    expect(partLength()).toBeCloseTo(75);
  });
});

describe('the modify tools can be pressed before anything is picked', () => {
  const twoLines = () => {
    tree().startSketch({ preset: 'XY', offset: 0 });
    const { sk } = sketch();
    const a = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 0, 10));
    const b = addLine(sk, addPoint(sk, 20, 0), addPoint(sk, 20, 10));
    sketch()._bump();
    return { a, b };
  };

  it.each([
    ['beginOffset', 'offsetPending'],
    ['beginLinearPattern', 'linearPatternPending'],
    ['beginCircularPattern', 'circularPatternPending'],
    ['beginMirror', 'mirrorPending'],
  ])('%s opens its panel with nothing selected, and from any tool', (begin, flag) => {
    twoLines();
    sketch().setTool('line');
    sketch()[begin]();
    expect(sketch()[flag]).toBe(true);
    expect(sketch().tool).toBe('select');
    expect(sketch().error).toBeNull();
  });

  it('one panel replaces another, and Escape closes it', () => {
    twoLines();
    sketch().beginOffset();
    sketch().beginMirror();
    expect(sketch().offsetPending).toBe(false);
    expect(sketch().mirrorPending).toBe(true);
    sketch().cancelPending();
    expect(sketch().mirrorPending).toBe(false);
  });

  it('mirrors about the last line picked when none is construction', () => {
    const { a, b } = twoLines();
    sketch().beginMirror();
    sketch().toggleSelect(a);
    sketch().toggleSelect(b);
    expect(sketch().mirrorAxis()).toBe(b);
    const lines = () => [...sketch().sk.entities.values()].filter((e) => e.type === 'line').length;
    const before = lines();
    sketch().mirror();
    expect(lines()).toBe(before + 1);
    expect(sketch().mirrorPending).toBe(false);
  });

  it('a construction line is the axis wherever it comes in the picking', () => {
    const { a, b } = twoLines();
    sketch().sk.entities.get(a).construction = true;
    sketch().toggleSelect(a);
    sketch().toggleSelect(b);
    expect(sketch().mirrorAxis()).toBe(a);
  });
});

describe('dimensioning to the part', () => {
  beforeEach(async () => {
    tree().startSketch({ preset: 'XY', offset: 0 });
    rect(40, 20);
    await tree().buildFromSketch({ op: 'extrude', depth: 10 });
    tree().startSketch({ preset: 'XY', offset: 10 });
    useSketchStore.setState({ pickTol: 1 });
    sketch().setTool('dimension');
  });

  const pickPointAndEdge = () => {
    const p = addPoint(sketch().sk, 10, 5);
    sketch().clickAt(10, 5);
    expect(sketch().selection).toEqual([p]);
    sketch().clickAt(25, 20); // the far long edge
    return p;
  };

  it('an edge of the part becomes the second pick, and the dimension can be placed', () => {
    pickPointAndEdge();
    const [, ref] = sketch().selection;
    const line = sketch().sk.entities.get(ref);
    expect(line).toMatchObject({ type: 'line', construction: true, ref: true });
    sketch().clickAt(30, 40);
    expect(sketch().dimensionPending).toMatchObject({ kind: 'pointLineDistance' });
  });

  it('after two picks a click on an edge is the placement, not a third pick', () => {
    pickPointAndEdge();
    sketch().clickAt(40, 10);
    expect(sketch().selection).toHaveLength(2);
    expect(sketch().dimensionPending).not.toBeNull();
  });

  it('a corner of the part is picked as a point', () => {
    sketch().clickAt(40, 20);
    expect(sketch().sk.entities.get(sketch().selection[0])).toMatchObject({ type: 'point', fixed: true, ref: true });
  });

  it('hover names the edge; sketch geometry under the cursor comes first', () => {
    sketch().hoverPartRef(25, 20);
    expect(sketch().partRefHover).toMatchObject({ kind: 'line' });
    addPoint(sketch().sk, 25, 20);
    sketch().hoverPartRef(25, 20);
    expect(sketch().partRefHover).toBeNull();
  });

  it('a reference cannot be dragged, and an unused one goes when the sketch closes', () => {
    sketch().clickAt(40, 20);
    const [ref] = sketch().selection;
    expect(sketch().beginDrag(ref)).toBe(false);
    sketch().closeSketch();
    expect(sketch().sk.entities.has(ref)).toBe(false);
  });
});
