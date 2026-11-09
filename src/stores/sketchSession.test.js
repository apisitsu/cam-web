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

  it('never guesses a line as the axis until Line is chosen', () => {
    const { a, b } = twoLines();
    sketch().beginMirror();
    sketch().toggleSelect(a);
    sketch().toggleSelect(b);
    expect(sketch().mirrorAxis()).toBeNull();
    sketch().mirror();
    expect(sketch().error).toMatch(/Choose what to mirror about/);
    expect(sketch().mirrorPending).toBe(true);
  });

  it.each([
    ['x', ([x, y]) => [x, -y]],
    ['y', ([x, y]) => [-x, y]],
  ])('mirrors everything picked about the %s axis', (axis, image) => {
    const { sk } = sketch();
    const p = addPoint(sk, 10, 5);
    const q = addPoint(sk, 30, 25);
    const line = addLine(sk, p, q);
    sketch()._bump();
    sketch().beginMirror();
    sketch().toggleSelect(line);
    sketch().setMirrorAbout(axis);
    expect(sketch().mirrorAxis()).toBe(axis);
    sketch().mirror();
    expect(sketch().mirrorPending).toBe(false);
    const made = [...sk.entities.values()].filter((e) => e.type === 'line' && !e.construction && e.id !== line);
    expect(made).toHaveLength(1);
    const at = (id) => [sk.entities.get(id).x, sk.entities.get(id).y];
    expect(at(made[0].p1)).toEqual(image([10, 5]));
    expect(at(made[0].p2)).toEqual(image([30, 25]));
    expect([...sk.entities.values()].filter((e) => e.type === 'line' && e.construction)).toHaveLength(1);
  });

  it('a box selection that caught the origin leaves the origin alone', () => {
    const { sk } = sketch();
    const origin = [...sk.entities.values()].find((e) => e.origin).id;
    const line = addLine(sk, addPoint(sk, 10, 5), addPoint(sk, 30, 5));
    sketch()._bump();
    sketch().beginMirror();
    useSketchStore.setState({ selection: [origin, line] });
    sketch().setMirrorAbout('y');
    sketch().mirror();
    expect([...sk.entities.values()].filter((e) => e.type === 'point' && e.x === 0 && e.y === 0)).toHaveLength(1);
  });

  it('takes the first line clicked after Centerline / Line as the axis, not as something to mirror', () => {
    const { a, b } = twoLines();
    sketch().beginMirror();
    sketch().setMirrorAbout('line');
    sketch().toggleSelect(b);
    expect(sketch().mirrorAxis()).toBe(b);
    expect(sketch().selection).toEqual([]);
    sketch().toggleSelect(a);
    expect(sketch().selection).toEqual([a]);
    expect(sketch().mirrorAxis()).toBe(b);
    const lines = () => [...sketch().sk.entities.values()].filter((e) => e.type === 'line').length;
    const before = lines();
    sketch().mirror();
    expect(lines()).toBe(before + 1);
    expect(sketch().mirrorPending).toBe(false);
  });

  it('clicking the chosen axis again lets another be picked', () => {
    const { a, b } = twoLines();
    sketch().beginMirror();
    sketch().setMirrorAbout('line');
    sketch().toggleSelect(b);
    sketch().toggleSelect(b);
    expect(sketch().mirrorAxis()).toBeNull();
    sketch().toggleSelect(a);
    expect(sketch().mirrorAxis()).toBe(a);
  });

  it('a construction line is the axis wherever it comes in the picking', () => {
    const { a, b } = twoLines();
    sketch().sk.entities.get(a).construction = true;
    sketch().beginMirror();
    sketch().toggleSelect(a);
    sketch().toggleSelect(b);
    expect(sketch().mirrorAxis()).toBe(a);
  });
});

describe('patterns of points', () => {
  const at = (id) => [sketch().sk.entities.get(id).x, sketch().sk.entities.get(id).y];
  const closeTo = (got, want) => { expect(got[0]).toBeCloseTo(want[0], 6); expect(got[1]).toBeCloseTo(want[1], 6); };
  const freePoint = (x, y) => { const id = addPoint(sketch().sk, x, y); sketch()._bump(); return id; };

  it('repeats a point in a line', () => {
    const p = freePoint(5, 5);
    sketch().beginLinearPattern();
    sketch().toggleSelect(p);
    sketch().linearPattern(3, 10, 0);
    expect(sketch().linearPatternPending).toBe(false);
    expect(sketch().selection).toHaveLength(2);
    closeTo(at(sketch().selection[1]), [25, 5]);
  });

  it('repeats a point round the origin where it already is', () => {
    const p = freePoint(20, 0);
    sketch().beginCircularPattern();
    sketch().toggleSelect(p);
    expect(sketch().circularPolar().pcd).toBeCloseTo(40, 6);
    sketch().circularPattern(4, 360);
    expect(at(p)).toEqual([20, 0]);
    expect(sketch().selection).toHaveLength(3);
    closeTo(at(sketch().selection[0]), [0, 20]);
  });

  it('puts it on the PCD and start angle asked for', () => {
    const p = freePoint(20, 0);
    sketch().beginCircularPattern();
    sketch().toggleSelect(p);
    sketch().circularPattern(2, 360, { pcd: 100, startDeg: 90 });
    closeTo(at(p), [0, 50]);
    closeTo(at(sketch().selection[0]), [0, -50]);
  });

  it('steps by the angle between neighbours', () => {
    const p = freePoint(10, 0);
    sketch().beginCircularPattern();
    sketch().toggleSelect(p);
    sketch().circularPattern(3, 30, { byStep: true });
    closeTo(at(sketch().selection[1]), [10 * Math.cos(Math.PI / 3), 10 * Math.sin(Math.PI / 3)]);
  });

  it('turns about a clicked point, which is not itself repeated', () => {
    const centre = freePoint(100, 100);
    const p = freePoint(110, 100);
    sketch().beginCircularPattern();
    sketch().setCircularAbout('point');
    sketch().toggleSelect(centre);
    expect(sketch().selection).toEqual([]);
    sketch().toggleSelect(p);
    expect(sketch().circularSeeds()).toEqual([p]);
    sketch().circularPattern(2, 360);
    closeTo(at(sketch().selection[0]), [90, 100]);
  });

  it('refuses what sits on the centre until a PCD puts it somewhere', () => {
    const p = freePoint(0, 0);
    sketch().beginCircularPattern();
    sketch().toggleSelect(p);
    sketch().circularPattern(4, 360);
    expect(sketch().error).toMatch(/enter a PCD/);
    sketch().circularPattern(4, 360, { pcd: 20, startDeg: 0 });
    closeTo(at(p), [10, 0]);
  });

  it('never repeats the origin', () => {
    const origin = [...sketch().sk.entities.values()].find((e) => e.origin).id;
    sketch().beginCircularPattern();
    useSketchStore.setState({ selection: [origin] });
    expect(sketch().circularSeeds()).toEqual([]);
  });
});

describe('Hole Wizard at picked points', () => {
  const volumeOf = () => getRawMesh().soup.triangleCount;
  let points;

  beforeEach(async () => {
    tree().startSketch({ preset: 'XY', offset: 0 });
    rect(40, 40);
    await tree().buildFromSketch({ op: 'extrude', depth: 10 });
    tree().startSketch({ preset: 'XY', offset: 10 });
    const { sk } = sketch();
    points = [[10, 10], [30, 10], [20, 30]].map(([x, y]) => addPoint(sk, x, y));
    sketch()._bump();
  });

  const drill = (d) => tree().buildHole({ diameter: d, depth: 5, end: 'blind', holeType: 'drill' });
  const holes = () => tree().features.filter((f) => f.kind === 'hole');

  it('makes nothing with no point picked', async () => {
    const triangles = volumeOf();
    expect(await drill(6)).toBeNull();
    expect(sketch().error).toMatch(/Click the points/);
    expect(holes()).toHaveLength(0);
    expect(volumeOf()).toBe(triangles);
  });

  it('cuts only the points picked, and stays open for the next kind', async () => {
    sketch().toggleSelect(points[0]);
    await drill(6);
    expect(holes()).toHaveLength(1);
    expect(holes()[0].pointIds).toEqual([points[0]]);
    expect(sketch().sketchOpen).toBe(true);
    expect(sketch().selection).toEqual([]);
  });

  it('closes once every point has a hole', async () => {
    sketch().toggleSelect(points[0]);
    await drill(6);
    sketch().toggleSelect(points[1]);
    sketch().toggleSelect(points[2]);
    await drill(8);
    expect(holes().map((f) => f.pointIds)).toEqual([[points[0]], [points[1], points[2]]]);
    expect(sketch().sketchOpen).toBe(false);
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
