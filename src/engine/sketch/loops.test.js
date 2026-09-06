import { describe, it, expect } from 'vitest';
import {
  createSketch, addPoint, addLine, addCircle, addArc, addConstraint,
} from './model.js';
import {
  sketchLoops, sketchRegions, tessellateArc, arcSegments, CHORD_TOL,
} from './loops.js';
import { loopArea } from '../mesh/slice.js';

/** A closed rectangle from four shared corner points. Returns the point ids. */
function rect(sk, x0, y0, x1, y1) {
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

/** Every point of a loop, as [x, y] pairs. */
const pairs = (pts) => {
  const out = [];
  for (let i = 0; i < pts.length; i += 2) out.push([pts[i], pts[i + 1]]);
  return out;
};

describe('arcSegments', () => {
  it('splits finely enough that no chord strays past the tolerance', () => {
    const r = 25;
    const span = Math.PI / 2;
    const n = arcSegments(r, span, CHORD_TOL);
    // Sagitta of one chord must be within tolerance.
    const sagitta = r * (1 - Math.cos(span / n / 2));
    expect(sagitta).toBeLessThanOrEqual(CHORD_TOL + 1e-12);
  });

  it('never collapses an arc to a single chord, and caps a hairline radius', () => {
    expect(arcSegments(50, Math.PI, CHORD_TOL)).toBeGreaterThanOrEqual(2);
    expect(arcSegments(0.001, Math.PI * 2, CHORD_TOL)).toBeLessThanOrEqual(720);
  });
});

describe('tessellateArc', () => {
  it('runs counter-clockwise from the start angle and includes both ends', () => {
    const pts = pairs(tessellateArc(0, 0, 10, 0, Math.PI / 2));
    expect(pts[0][0]).toBeCloseTo(10);
    expect(pts[0][1]).toBeCloseTo(0);
    expect(pts[pts.length - 1][0]).toBeCloseTo(0);
    expect(pts[pts.length - 1][1]).toBeCloseTo(10);
    // Every point sits on the rim.
    for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeCloseTo(10, 6);
  });

  it('treats a zero sweep as a full turn (a circle asks for 0 → 2π)', () => {
    const pts = pairs(tessellateArc(0, 0, 5, 0, 0));
    expect(pts.length).toBeGreaterThan(8);
    expect(pts[pts.length - 1][0]).toBeCloseTo(5);
  });
});

describe('sketchLoops — chaining', () => {
  it('chains four lines sharing corner points into one closed loop', () => {
    const sk = createSketch();
    rect(sk, 0, 0, 40, 20);
    const { loops, open, branches } = sketchLoops(sk);
    expect(loops).toHaveLength(1);
    expect(open).toHaveLength(0);
    expect(branches).toHaveLength(0);
    expect(pairs(loops[0].points)).toHaveLength(4);
    expect(loops[0].area).toBeCloseTo(800);
    expect(loops[0].entities).toHaveLength(4);
  });

  it('winds an outer boundary counter-clockwise however it was drawn', () => {
    // Drawn clockwise: the loop still comes back positive.
    const sk = createSketch();
    const p1 = addPoint(sk, 0, 0);
    const p2 = addPoint(sk, 0, 20);
    const p3 = addPoint(sk, 40, 20);
    const p4 = addPoint(sk, 40, 0);
    addLine(sk, p1, p2);
    addLine(sk, p2, p3);
    addLine(sk, p3, p4);
    addLine(sk, p4, p1);
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(1);
    expect(loopArea(loops[0].points)).toBeGreaterThan(0);
    expect(loops[0].isHole).toBe(false);
  });

  it('treats a circle as a closed loop on its own', () => {
    const sk = createSketch();
    const c = addPoint(sk, 5, 5);
    addCircle(sk, c, 10);
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(1);
    expect(loopArea(loops[0].points)).toBeGreaterThan(0);
    // Tessellation is **inscribed** — every point sits on the true rim — so the
    // polygon is fractionally inside the circle and its area fractionally under
    // πr². The deficit is bounded by the chord tolerance it was built to
    // (≈ ⅔ · perimeter · sagitta), which is the promise `chordTol` makes.
    const exact = Math.PI * 100;
    const bound = (2 / 3) * (Math.PI * 20) * CHORD_TOL;
    expect(loops[0].area).toBeLessThan(exact);
    expect(exact - loops[0].area).toBeLessThan(bound * 1.1);
  });

  it('closes a slot: two lines joined by two arcs', () => {
    const sk = createSketch();
    const r = 5;
    // Straight flanks at y = ±5 between x = 0 and x = 30, capped by semicircles.
    const a = addPoint(sk, 0, r);
    const b = addPoint(sk, 30, r);
    const c = addPoint(sk, 30, -r);
    const d = addPoint(sk, 0, -r);
    const rightC = addPoint(sk, 30, 0);
    const leftC = addPoint(sk, 0, 0);
    addLine(sk, a, b);
    // Arcs sweep counter-clockwise start → end, so each cap is named from the
    // end that puts the sweep on the *outside* — the other order carves the cap
    // back into the slot.
    addArc(sk, rightC, c, b, r); // 270° → 90° the short way, round the right
    addLine(sk, c, d);
    addArc(sk, leftC, a, d, r); // 90° → 270° the short way, round the left
    const { loops, open, branches } = sketchLoops(sk);
    expect(open).toHaveLength(0);
    expect(branches).toHaveLength(0);
    expect(loops).toHaveLength(1);
    // 30 × 10 rectangle plus a full circle of r=5 from the two end caps.
    expect(loops[0].area).toBeCloseTo(300 + Math.PI * 25, 0);
  });

  it('joins two points a coincident constraint made one vertex', () => {
    const sk = createSketch();
    // A triangle whose last corner is two separate points tied together.
    const p1 = addPoint(sk, 0, 0);
    const p2 = addPoint(sk, 30, 0);
    const p3a = addPoint(sk, 0, 40);
    const p3b = addPoint(sk, 0, 40);
    addLine(sk, p1, p2);
    addLine(sk, p2, p3a);
    addLine(sk, p3b, p1);
    addConstraint(sk, 'coincident', [p3a, p3b]);
    const { loops, open } = sketchLoops(sk, { weldTol: 0 });
    expect(open).toHaveLength(0);
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBeCloseTo(600);
  });

  it('welds points that a solve left sitting on top of each other', () => {
    const sk = createSketch();
    const p1 = addPoint(sk, 0, 0);
    const p2 = addPoint(sk, 30, 0);
    const p3a = addPoint(sk, 0, 40);
    const p3b = addPoint(sk, 0, 40 + 1e-9); // no constraint, just coincident in fact
    addLine(sk, p1, p2);
    addLine(sk, p2, p3a);
    addLine(sk, p3b, p1);
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(1);
  });
});

describe('sketchLoops — what does not close', () => {
  it('reports an unclosed chain instead of inventing a loop', () => {
    const sk = createSketch();
    const p1 = addPoint(sk, 0, 0);
    const p2 = addPoint(sk, 40, 0);
    const p3 = addPoint(sk, 40, 20);
    addLine(sk, p1, p2);
    addLine(sk, p2, p3); // three corners, only two edges
    const { loops, open } = sketchLoops(sk);
    expect(loops).toHaveLength(0);
    expect(open).toHaveLength(1);
    expect(pairs(open[0].points)).toHaveLength(3);
  });

  it('prunes a stray line off a corner and still finds the profile', () => {
    const sk = createSketch();
    const [p1] = rect(sk, 0, 0, 40, 20);
    // A line drawn off a corner and left there hangs by one end. It bounds
    // nothing, so it is peeled off rather than making the corner "ambiguous" —
    // which used to lose the whole rectangle with it.
    const stray = addPoint(sk, -10, -10);
    addLine(sk, p1, stray);
    const { loops, open } = sketchLoops(sk);
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBeCloseTo(800);
    // And what was dropped is reported, not hidden.
    expect(open).toHaveLength(1);
  });

  it('peels a whole dangling chain, not just its last edge', () => {
    const sk = createSketch();
    const [p1] = rect(sk, 0, 0, 40, 20);
    const a = addPoint(sk, -10, -10);
    const b = addPoint(sk, -20, -20);
    const c = addPoint(sk, -30, -30);
    addLine(sk, p1, a);
    addLine(sk, a, b);
    addLine(sk, b, c);
    const { loops, open } = sketchLoops(sk);
    expect(loops).toHaveLength(1);
    expect(open).toHaveLength(1);
    expect(pairs(open[0].points)).toHaveLength(4); // p1 → a → b → c
  });

  it('ignores construction geometry entirely', () => {
    const sk = createSketch();
    rect(sk, 0, 0, 40, 20);
    // A construction diagonal would otherwise split the rectangle at two corners.
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 40, 20);
    const diag = addLine(sk, a, b);
    sk.entities.get(diag).construction = true;
    const { loops, branches } = sketchLoops(sk);
    expect(branches).toHaveLength(0);
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBeCloseTo(800);
  });

  it('drops a zero-length line rather than chaining through it', () => {
    const sk = createSketch();
    rect(sk, 0, 0, 40, 20);
    const z1 = addPoint(sk, 60, 60);
    const z2 = addPoint(sk, 60, 60);
    addLine(sk, z1, z2);
    const { loops, open } = sketchLoops(sk);
    expect(loops).toHaveLength(1);
    expect(open).toHaveLength(0);
  });
});

describe('sketchLoops — nesting', () => {
  it('marks a circle inside a rectangle as a hole, wound the other way', () => {
    const sk = createSketch();
    rect(sk, 0, 0, 40, 40);
    const c = addPoint(sk, 20, 20);
    addCircle(sk, c, 5);
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(2);
    // Biggest first.
    expect(loops[0].isHole).toBe(false);
    expect(loops[1].isHole).toBe(true);
    expect(loopArea(loops[0].points)).toBeGreaterThan(0);
    expect(loopArea(loops[1].points)).toBeLessThan(0);
  });

  it('brings an island inside a pocket back out as solid', () => {
    const sk = createSketch();
    rect(sk, 0, 0, 100, 100);
    const cOuter = addPoint(sk, 50, 50);
    addCircle(sk, cOuter, 30); // pocket
    const cInner = addPoint(sk, 50, 50);
    addCircle(sk, cInner, 10); // island standing in it
    const { loops } = sketchLoops(sk);
    expect(loops.map((l) => l.isHole)).toEqual([false, true, false]);
    expect(loops[2].depth).toBe(2);
  });

  it('keeps two side-by-side profiles separate, both solid', () => {
    const sk = createSketch();
    rect(sk, 0, 0, 20, 20);
    rect(sk, 40, 0, 60, 20);
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(2);
    expect(loops.every((l) => !l.isHole)).toBe(true);
  });
});

describe('sketchRegions', () => {
  it('hands back one region per outer boundary with its holes attached', () => {
    const sk = createSketch();
    rect(sk, 0, 0, 40, 40);
    const c = addPoint(sk, 20, 20);
    addCircle(sk, c, 5);
    const { regions } = sketchRegions(sk);
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
    // Net area is the plate less the bore.
    expect(regions[0].area).toBeCloseTo(1600 - Math.PI * 25, 0);
  });

  it('gives an island its own region rather than folding it into the pocket', () => {
    const sk = createSketch();
    rect(sk, 0, 0, 100, 100);
    const a = addPoint(sk, 50, 50);
    addCircle(sk, a, 30);
    const b = addPoint(sk, 50, 50);
    addCircle(sk, b, 10);
    const { regions } = sketchRegions(sk);
    expect(regions).toHaveLength(2);
    expect(regions[0].holes).toHaveLength(1); // plate with the pocket
    expect(regions[1].holes).toHaveLength(0); // the island
    expect(regions[1].area).toBeCloseTo(Math.PI * 100, 0);
  });

  it('is empty for a sketch holding nothing but its origin', () => {
    const sk = createSketch();
    addPoint(sk, 0, 0, true);
    const { regions, open, branches } = sketchRegions(sk);
    expect(regions).toHaveLength(0);
    expect(open).toHaveLength(0);
    expect(branches).toHaveLength(0);
  });
});

describe('sketchLoops — geometry that splits into several regions', () => {
  it('splits a rectangle in two when a line crosses it corner to corner', () => {
    // The case the old degree-2 walk gave up on. A vertex with three edges is
    // not ambiguous — every CAD shows two regions here — it just needs a rule
    // for which way to turn.
    const sk = createSketch();
    const [p1, p2, p3, p4] = rect(sk, 0, 0, 40, 20);
    addLine(sk, p1, p3); // the diagonal
    const { loops, branches } = sketchLoops(sk);
    expect(loops).toHaveLength(2);
    expect(loops.every((l) => !l.isHole)).toBe(true);
    expect(loops[0].area + loops[1].area).toBeCloseTo(800);
    expect(loops[0].area).toBeCloseTo(400);
    // The junctions are still reported — as information, not as a refusal, and
    // as coordinates: a junction can be a crossing the arrangement created,
    // which is no point the user ever drew.
    expect(branches).toHaveLength(2);
    const xs = branches.map((b) => Math.round(b[0])).sort((a, b) => a - b);
    expect(xs).toEqual([0, 40]);
    expect(p1 && p2 && p3 && p4).toBeTruthy();
  });

  it('makes three regions from two lines across one rectangle', () => {
    const sk = createSketch();
    const [p1, p2, p3, p4] = rect(sk, 0, 0, 60, 20);
    const m1 = addPoint(sk, 20, 0);
    const m2 = addPoint(sk, 20, 20);
    const m3 = addPoint(sk, 40, 0);
    const m4 = addPoint(sk, 40, 20);
    // The rectangle's own bottom/top are replaced by segments through the
    // junctions, because a T-junction only exists where a vertex is shared.
    sk.entities.delete([...sk.entities.values()].find((e) => e.type === 'line' && e.p1 === p1 && e.p2 === p2).id);
    sk.entities.delete([...sk.entities.values()].find((e) => e.type === 'line' && e.p1 === p3 && e.p2 === p4).id);
    addLine(sk, p1, m1); addLine(sk, m1, m3); addLine(sk, m3, p2);
    addLine(sk, p3, m4); addLine(sk, m4, m2); addLine(sk, m2, p4);
    addLine(sk, m1, m2);
    addLine(sk, m3, m4);
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(3);
    expect(loops.reduce((s, l) => s + l.area, 0)).toBeCloseTo(1200);
  });

  it('splits with a curved divider, ordering by the arc\'s tangent not its chord', () => {
    // The arc leaves p1 heading straight up while its chord points up-right; an
    // ordering taken from the chord picks the wrong turn and merges the regions.
    const sk = createSketch();
    const [p1, p2, p3] = rect(sk, 0, 0, 40, 40);
    // Centred on the bottom-right corner with r = 40, so both the bottom-left
    // and top-right corners sit exactly on the rim.
    const c = addPoint(sk, 40, 0);
    addArc(sk, c, p3, p1, 40); // CCW quarter from (40,40) round to (0,0)
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(2);
    expect(loops.reduce((s, l) => s + l.area, 0)).toBeCloseTo(1600, 0);
    // The quarter-disc is one of them.
    const quarter = (Math.PI * 1600) / 4;
    expect(Math.min(...loops.map((l) => l.area))).toBeCloseTo(1600 - quarter, 0);
    expect(p2).toBeTruthy();
  });

  it('keeps a hole a hole when the outer profile is also split', () => {
    const sk = createSketch();
    const [p1, p2, p3] = rect(sk, 0, 0, 100, 100);
    addLine(sk, p1, p3); // split the plate
    const c = addPoint(sk, 80, 20);
    addCircle(sk, c, 5); // a bore inside the lower-right half
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(3);
    expect(loops.filter((l) => l.isHole)).toHaveLength(1);
    expect(p2).toBeTruthy();
  });

  it('assigns the hole to the region that actually contains it', () => {
    const sk = createSketch();
    const [p1, , p3] = rect(sk, 0, 0, 100, 100);
    addLine(sk, p1, p3);
    const c = addPoint(sk, 80, 20); // below the diagonal
    addCircle(sk, c, 5);
    const { regions } = sketchRegions(sk);
    expect(regions).toHaveLength(2);
    const withHole = regions.filter((r) => r.holes.length);
    expect(withHole).toHaveLength(1);
    expect(withHole[0].area).toBeCloseTo(5000 - Math.PI * 25, 0);
  });

  it('finds both regions of a figure of eight', () => {
    // Two squares meeting along one shared edge.
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    const c = addPoint(sk, 10, 10);
    const d = addPoint(sk, 0, 10);
    const e = addPoint(sk, 20, 0);
    const f = addPoint(sk, 20, 10);
    addLine(sk, a, b); addLine(sk, b, c); addLine(sk, c, d); addLine(sk, d, a);
    addLine(sk, b, e); addLine(sk, e, f); addLine(sk, f, c);
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(2);
    expect(loops.every((l) => !l.isHole)).toBe(true);
    expect(loops.reduce((s, l) => s + l.area, 0)).toBeCloseTo(200);
  });
});

describe('sketchLoops — geometry that crosses without sharing a vertex', () => {
  it('splits a rectangle with a divider whose ends land ON the edges', () => {
    // The T-junction. Nothing here shares a point id: the divider's ends sit on
    // the interior of the top and bottom edges. Before the arrangement this came
    // back as one 800 mm² rectangle with the divider pruned away as dangling.
    const sk = createSketch();
    rect(sk, 0, 0, 40, 20);
    addLine(sk, addPoint(sk, 20, 0), addPoint(sk, 20, 20));
    const { loops, open } = sketchLoops(sk);
    expect(open).toHaveLength(0);
    expect(loops).toHaveLength(2);
    expect(loops.map((l) => Math.round(l.area))).toEqual([400, 400]);
  });

  it('splits at a divider that is off centre', () => {
    const sk = createSketch();
    rect(sk, 0, 0, 40, 20);
    addLine(sk, addPoint(sk, 10, 0), addPoint(sk, 10, 20));
    const { loops } = sketchLoops(sk);
    expect(loops.map((l) => Math.round(l.area)).sort((a, b) => b - a)).toEqual([600, 200]);
  });

  it('arranges two overlapping rectangles that share no vertex into three regions', () => {
    // Two 20×20 squares overlapping by 10×10: two L-shapes and the overlap.
    // Extruding these unarranged counted the overlap twice.
    const sk = createSketch();
    rect(sk, 0, 0, 20, 20);
    rect(sk, 10, 10, 30, 30);
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(3);
    expect(loops.reduce((s, l) => s + l.area, 0)).toBeCloseTo(400 + 400 - 100, 6);
    expect(loops.map((l) => Math.round(l.area)).sort((a, b) => b - a)).toEqual([300, 300, 100]);
  });

  it('cuts a circle where a line crosses it', () => {
    const sk = createSketch();
    const c = addPoint(sk, 0, 0);
    addCircle(sk, c, 10);
    // A chord straight through the middle: two half-discs.
    addLine(sk, addPoint(sk, -20, 0), addPoint(sk, 20, 0));
    const { loops } = sketchLoops(sk);
    expect(loops).toHaveLength(2);
    for (const l of loops) expect(l.area).toBeCloseTo((Math.PI * 100) / 2, 0);
  });

  it('leaves a circle whole when nothing touches it', () => {
    const sk = createSketch();
    rect(sk, 0, 0, 40, 40);
    addCircle(sk, addPoint(sk, 20, 20), 5);
    const { loops } = sketchLoops(sk);
    expect(loops.map((l) => l.isHole)).toEqual([false, true]);
  });

  it('does not split where two lines merely touch at a shared corner', () => {
    // A plain rectangle must stay one region — a cut at a joint is no cut.
    const sk = createSketch();
    rect(sk, 0, 0, 40, 20);
    const { loops, branches } = sketchLoops(sk);
    expect(loops).toHaveLength(1);
    expect(branches).toHaveLength(0);
  });
});
