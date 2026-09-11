import { describe, it, expect } from 'vitest';
import { useSketchStore } from './sketchStore.js';
import {
  createSketch, addPoint, addLine, addCircle, addArc, addConstraint, dof,
} from '../engine/sketch/model.js';

const DEG = Math.PI / 180;

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** A sketch seeded with a fixed origin (0,0), like the store's real sketches. */
function withOrigin() {
  const sk = createSketch();
  const o = addPoint(sk, 0, 0, true);
  sk.entities.get(o).origin = true;
  return { sk, origin: o };
}

/** A sketch with a horizontal base line and a vertical line sharing the origin. */
function corner() {
  const sk = createSketch();
  const o = addPoint(sk, 0, 0);
  const bx = addPoint(sk, 10, 0);
  const uy = addPoint(sk, 0, 10);
  const base = addLine(sk, o, bx); // horizontal, dir 0°
  const up = addLine(sk, o, uy); // vertical, dir 90°
  return { sk, base, up };
}

describe('resolveDimension — axis-locked (horizontal/vertical) dimensions', () => {
  // Reset the sticky axis mode so these tests don't leak into each other.
  const setAxis = (axis) => useSketchStore.getState().setDimensionAxis(axis);

  it('defaults to the aligned true distance', () => {
    const { sk, origin } = withOrigin();
    const p = addPoint(sk, 3, 4);
    setAxis('aligned');
    useSketchStore.setState({ sk, selection: [p] });
    const spec = useSketchStore.getState().resolveDimension();
    expect(spec.kind).toBe('distance');
    expect(near(spec.current, 5)).toBe(true);
    expect(spec.refs).toEqual([origin, p]);
    expect(spec.axial).toBe(true); // the toggle is offered
  });

  it('axis "x" measures the horizontal gap only', () => {
    const { sk, origin } = withOrigin();
    const p = addPoint(sk, 3, 4);
    setAxis('x');
    useSketchStore.setState({ sk, selection: [p] });
    const spec = useSketchStore.getState().resolveDimension();
    expect(spec.kind).toBe('distanceX');
    expect(near(spec.current, 3)).toBe(true);
    expect(spec.refs).toEqual([origin, p]);
  });

  it('axis "y" measures the vertical gap only', () => {
    const { sk } = withOrigin();
    const p = addPoint(sk, 3, 4);
    setAxis('y');
    useSketchStore.setState({ sk, selection: [p] });
    const spec = useSketchStore.getState().resolveDimension();
    expect(spec.kind).toBe('distanceY');
    expect(near(spec.current, 4)).toBe(true);
  });

  it('orders refs so the typed value is positive when the gap runs backwards', () => {
    const { sk, origin } = withOrigin();
    const p = addPoint(sk, -8, 0); // left of the origin → raw dX is negative
    setAxis('x');
    useSketchStore.setState({ sk, selection: [p] });
    const spec = useSketchStore.getState().resolveDimension();
    expect(spec.refs).toEqual([p, origin]); // reversed
    expect(near(spec.current, 8)).toBe(true); // positive magnitude
  });

  it('applies to a line length and to centre-to-centre as well', () => {
    const sk = createSketch();
    const l = addLine(sk, addPoint(sk, 1, 1), addPoint(sk, 11, 7));
    setAxis('x');
    useSketchStore.setState({ sk, selection: [l] });
    const spec = useSketchStore.getState().resolveDimension();
    expect(spec.kind).toBe('distanceX');
    expect(near(spec.current, 10)).toBe(true);
    setAxis('aligned');
  });

  it('a non-point dimension ignores the axis mode', () => {
    const sk = createSketch();
    const c = addCircle(sk, addPoint(sk, 0, 0), 5);
    setAxis('x');
    useSketchStore.setState({ sk, selection: [c] });
    const spec = useSketchStore.getState().resolveDimension();
    expect(spec.kind).toBe('diameter'); // still Ø, no axial variant
    expect(spec.axial).toBeUndefined();
    setAxis('aligned');
  });
});

describe('clickAt (dimension tool) — placement picks the orientation, SW-style', () => {
  /** Select `sel`, then place the dimension by clicking empty space at (x,y). */
  const place = (sk, sel, x, y) => {
    useSketchStore.setState({
      sk, selection: sel, tool: 'dimension', dimensionAxis: 'aligned',
      dimensionPending: null, pickTol: 1.5,
    });
    useSketchStore.getState().clickAt(x, y);
    return useSketchStore.getState();
  };

  /** Origin + a point offset diagonally, like the reported Ø100 circle case. */
  const diag = () => {
    const { sk, origin } = withOrigin();
    const p = addPoint(sk, 100, 40);
    return { sk, origin, p };
  };

  it('placing below the pair gives a horizontal (dX) dimension', () => {
    const { sk, p } = diag();
    const st = place(sk, [p], 50, -60);
    expect(st.dimensionAxis).toBe('x');
    expect(st.dimensionPending.kind).toBe('distanceX');
    expect(near(st.dimensionPending.current, 100)).toBe(true);
  });

  it('placing out to the side gives a vertical (dY) dimension', () => {
    const { sk, p } = diag();
    const st = place(sk, [p], 190, 20);
    expect(st.dimensionAxis).toBe('y');
    expect(st.dimensionPending.kind).toBe('distanceY');
    expect(near(st.dimensionPending.current, 40)).toBe(true);
  });

  it('placing square off the line keeps the aligned true distance', () => {
    const { sk, p } = diag();
    const len = Math.hypot(100, 40);
    const st = place(sk, [p], 50 + (-40 / len) * 40, 20 + (100 / len) * 40);
    expect(st.dimensionAxis).toBe('aligned');
    expect(st.dimensionPending.kind).toBe('distance');
    expect(near(st.dimensionPending.current, len)).toBe(true);
  });

  it('the toggle still overrides the placement afterwards', () => {
    const { sk, p } = diag();
    place(sk, [p], 50, -60); // placement chose dX
    useSketchStore.getState().setDimensionAxis('y'); // user overrides
    const st = useSketchStore.getState();
    expect(st.dimensionPending.kind).toBe('distanceY');
    expect(near(st.dimensionPending.current, 40)).toBe(true);
  });

  it('a non-axial dimension is unaffected by where it is placed', () => {
    const sk = createSketch();
    const c = addCircle(sk, addPoint(sk, 0, 0), 5);
    const st = place(sk, [c], 80, -80);
    expect(st.dimensionPending.kind).toBe('diameter');
    expect(st.dimensionAxis).toBe('aligned'); // untouched
  });
});

describe('resolveDimension — angle vs gap on two lines', () => {
  it('two non-parallel lines resolve to an angle (degrees, base = first ref)', () => {
    const { sk, base, up } = corner();
    useSketchStore.setState({ sk, selection: [base, up] });
    const spec = useSketchStore.getState().resolveDimension();
    expect(spec.kind).toBe('angle');
    expect(spec.angular).toBe(true);
    expect(spec.unit).toBe('°');
    expect(spec.refs).toEqual([base, up]);
    expect(near(spec.current, 90)).toBe(true);
  });

  it('two parallel lines resolve to a gap distance, not an angle', () => {
    const sk = createSketch();
    const l1 = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0));
    const l2 = addLine(sk, addPoint(sk, 0, 5), addPoint(sk, 10, 5));
    useSketchStore.setState({ sk, selection: [l1, l2] });
    const spec = useSketchStore.getState().resolveDimension();
    expect(spec.kind).toBe('pointLineDistance');
    expect(spec.angular).toBeUndefined();
  });
});

describe('resolveDimension — dimensioning to the origin', () => {
  it('a single non-origin point resolves to a distance from the origin', () => {
    const { sk, origin } = withOrigin();
    const p = addPoint(sk, 3, 4);
    useSketchStore.setState({ sk, selection: [p] });
    const spec = useSketchStore.getState().resolveDimension();
    expect(spec.kind).toBe('distance');
    expect(spec.label).toBe('To origin');
    expect(spec.refs).toEqual([origin, p]);
    expect(near(spec.current, 5)).toBe(true); // 3-4-5
  });

  it('the origin itself selected alone is not dimensionable', () => {
    const { sk, origin } = withOrigin();
    useSketchStore.setState({ sk, selection: [origin] });
    expect(useSketchStore.getState().resolveDimension()).toBeNull();
  });

  it('origin + a line resolves to a perpendicular point-to-line distance', () => {
    const { sk, origin } = withOrigin();
    // A horizontal line y = 5, so the origin sits 5 below it.
    const line = addLine(sk, addPoint(sk, -10, 5), addPoint(sk, 10, 5));
    useSketchStore.setState({ sk, selection: [origin, line] });
    const spec = useSketchStore.getState().resolveDimension();
    expect(spec.kind).toBe('pointLineDistance');
    expect(spec.refs).toEqual([origin, line]);
    expect(near(spec.current, 5)).toBe(true);
  });
});

describe('editing a placed dimension (double-click)', () => {
  it('seeds the editor with the current value — mm for a distance', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    addConstraint(sk, 'distance', [a, b], 10);
    useSketchStore.setState({ sk, editingConstraint: null });
    useSketchStore.getState().beginEditConstraint(0);
    const ec = useSketchStore.getState().editingConstraint;
    expect(ec.index).toBe(0);
    expect(ec.kind).toBe('distance');
    expect(ec.angular).toBe(false);
    expect(near(ec.value, 10)).toBe(true);
  });

  it('seeds an angle in degrees and stores the edited value back in radians', () => {
    const { sk, base, up } = corner();
    const idx = addConstraint(sk, 'angle', [base, up], 90 * DEG);
    useSketchStore.setState({ sk, editingConstraint: null, past: [], future: [] });
    useSketchStore.getState().beginEditConstraint(idx);
    const ec = useSketchStore.getState().editingConstraint;
    expect(ec.angular).toBe(true);
    expect(near(ec.value, 90)).toBe(true); // shown in degrees
    // Commit 45° → stored as radians on the constraint, editor closed.
    useSketchStore.getState().applyEditConstraint(45);
    expect(near(useSketchStore.getState().sk.constraints[idx].value, 45 * DEG)).toBe(true);
    expect(useSketchStore.getState().editingConstraint).toBeNull();
  });

  it('refuses to edit a non-dimensional constraint', () => {
    const { sk, base, up } = corner();
    addConstraint(sk, 'parallel', [base, up]);
    useSketchStore.setState({ sk, editingConstraint: null });
    useSketchStore.getState().beginEditConstraint(0);
    expect(useSketchStore.getState().editingConstraint).toBeNull();
  });
});

describe('deleting a placed dimension from the viewport', () => {
  const dimensioned = () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    addLine(sk, a, b);
    addConstraint(sk, 'horizontal', [a, b]);              // idx 0 — not a dimension
    const di = addConstraint(sk, 'distance', [a, b], 10); // idx 1 — a dimension
    useSketchStore.setState({ sk, selection: [], selectedDims: [], past: [], future: [] });
    return { sk, di };
  };

  it('toggleDimSelect only takes a dimensional constraint', () => {
    const { di } = dimensioned();
    useSketchStore.getState().toggleDimSelect(0); // horizontal — not a dim
    expect(useSketchStore.getState().selectedDims).toEqual([]);
    useSketchStore.getState().toggleDimSelect(di);
    expect(useSketchStore.getState().selectedDims).toEqual([di]);
    useSketchStore.getState().toggleDimSelect(di); // toggle off
    expect(useSketchStore.getState().selectedDims).toEqual([]);
  });

  it('Delete removes the selected dimension, leaving the other constraints', () => {
    const { sk, di } = dimensioned();
    useSketchStore.getState().toggleDimSelect(di);
    const before = sk.constraints.length;
    useSketchStore.getState().deleteSelected();
    expect(sk.constraints.length).toBe(before - 1);
    expect(sk.constraints.some((c) => c.kind === 'distance')).toBe(false);
    expect(sk.constraints.some((c) => c.kind === 'horizontal')).toBe(true);
    expect(useSketchStore.getState().selectedDims).toEqual([]);
    expect(useSketchStore.getState().past.length).toBe(1); // one undo step
  });

  it('an edit invalidates a stale dimension selection', () => {
    const { di } = dimensioned();
    useSketchStore.getState().toggleDimSelect(di);
    useSketchStore.getState()._snapshot();
    expect(useSketchStore.getState().selectedDims).toEqual([]);
  });
});

describe('setDimensionOffset — dragging a placed dimension', () => {
  const withDim = () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    const ci = addConstraint(sk, 'distance', [a, b], 10);
    useSketchStore.setState({ sk, past: [], future: [], version: 0 });
    return { sk, ci };
  };

  it('locks a raw pointer offset to the dimension axis, and bumps the version', () => {
    const { sk, ci } = withDim(); // a distance measured along X → locked to Y
    useSketchStore.getState().setDimensionOffset(ci, [3, -4]);
    expect(sk.constraints[ci].labelOffset).toEqual([0, -4]); // X component dropped
    expect(useSketchStore.getState().version).toBeGreaterThan(0);
  });

  it('collapses a whole drag to one undo step', () => {
    const { ci } = withDim();
    const s = useSketchStore.getState();
    s.setDimensionOffset(ci, [0, 1]);                      // first move — snapshots
    s.setDimensionOffset(ci, [0, 2], { snapshot: false }); // ...the rest of the drag
    s.setDimensionOffset(ci, [1, 5], { snapshot: false });
    expect(useSketchStore.getState().past.length).toBe(1);
    expect(useSketchStore.getState().sk.constraints[ci].labelOffset).toEqual([0, 5]);
  });

  it('undo puts the dimension back where it was', () => {
    const { ci } = withDim();
    useSketchStore.getState().setDimensionOffset(ci, [8, 8]);
    useSketchStore.getState().undo();
    expect(useSketchStore.getState().sk.constraints[ci].labelOffset).toBeUndefined();
  });

  it('does nothing for a non-dimensional constraint', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    addConstraint(sk, 'horizontal', [a, b]);
    useSketchStore.setState({ sk, past: [] });
    useSketchStore.getState().setDimensionOffset(0, [3, 3]);
    expect(sk.constraints[0].labelOffset).toBeUndefined();
    expect(useSketchStore.getState().past.length).toBe(0);
  });
});

describe('construction geometry & driven dimensions', () => {
  it('toggleConstruction flips the flag on selected geometry only', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0);
    const line = addLine(sk, a, b);
    useSketchStore.setState({ sk, selection: [line, a], past: [] });
    useSketchStore.getState().toggleConstruction();
    expect(sk.entities.get(line).construction).toBe(true); // geometry flagged
    expect(sk.entities.get(a).construction).toBeUndefined(); // points untouched
    useSketchStore.getState().toggleConstruction(); // toggle back off
    expect(sk.entities.get(line).construction).toBe(false);
  });

  it('a driven dimension removes no degrees of freedom', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 10, 0); // 2 free points → 4 DOF
    addConstraint(sk, 'distance', [a, b], 10); // driving → removes 1
    expect(dof(sk).removed).toBe(1);
    sk.constraints[0].driven = true; // reference only
    expect(dof(sk).removed).toBe(0);
  });
});

describe('fillet (R) between two curves', () => {
  /** Two trimmed circles meeting at (40, ±30) — endpoints coincident, not merged. */
  const lens = () => {
    const sk = createSketch();
    const arc1 = addArc(sk, addPoint(sk, 0, 0), addPoint(sk, 40, -30), addPoint(sk, 40, 30), 50);
    const arc2 = addArc(sk, addPoint(sk, 80, 0), addPoint(sk, 40, 30), addPoint(sk, 40, -30), 50);
    return { sk, arc1, arc2 };
  };
  const arcCount = (sk) => [...sk.entities.values()].filter((e) => e.type === 'arc').length;
  // solve() needs a Worker, which node has no notion of — it sets its own error
  // after the geometry is already built. Only fillet's own refusals matter here.
  const filletError = (e) => (e && /trim|meet|too large/i.test(e) ? e : null);

  it('rounds the corner between two arcs left by trimming circles', () => {
    const { sk, arc1, arc2 } = lens();
    useSketchStore.setState({
      sk, selection: [arc1, arc2], past: [], error: null,
      chamferPick: { x: 40, y: 30 }, pickTol: 1.5,
    });
    useSketchStore.getState().fillet(5);
    expect(filletError(useSketchStore.getState().error)).toBeNull();
    expect(arcCount(sk)).toBe(3); // the two originals + the fillet
  });

  it('rounds the corner nearest the pick when the arcs meet at two', () => {
    for (const pick of [{ x: 40, y: 30 }, { x: 40, y: -30 }]) {
      const { sk, arc1, arc2 } = lens();
      useSketchStore.setState({
        sk, selection: [arc1, arc2], past: [], error: null, chamferPick: pick, pickTol: 1.5,
      });
      useSketchStore.getState().fillet(5);
      expect(filletError(useSketchStore.getState().error)).toBeNull();
      // The fillet arc is the newest one; its centre must be by the picked corner.
      const arcs = [...sk.entities.values()].filter((e) => e.type === 'arc');
      const f = arcs[arcs.length - 1];
      const fc = sk.entities.get(f.center);
      expect(Math.hypot(fc.x - pick.x, fc.y - pick.y) < 20).toBe(true);
    }
  });

  it('fillets two whole crossing circles directly, auto-trimming them to arcs', () => {
    const sk = createSketch();
    const c1 = addCircle(sk, addPoint(sk, 0, 0), 50);
    const c2 = addCircle(sk, addPoint(sk, 80, 0), 50);
    useSketchStore.setState({
      sk, selection: [c1, c2], past: [], error: null,
      chamferPick: { x: 40, y: 30 }, chamferPicks: {},
    });
    useSketchStore.getState().fillet(5);
    expect(filletError(useSketchStore.getState().error)).toBeNull();
    expect([...sk.entities.values()].filter((e) => e.type === 'circle').length).toBe(0);
    expect(arcCount(sk)).toBe(3); // two trimmed arcs + the fillet
  });

  it('still asks for a manual trim when a circle is paired with a line', () => {
    const sk = createSketch();
    const c = addCircle(sk, addPoint(sk, 0, 0), 50);
    const l = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 90, 0));
    useSketchStore.setState({ sk, selection: [c, l], past: [], error: null });
    useSketchStore.getState().fillet(5);
    const st = useSketchStore.getState();
    expect(st.error).toMatch(/trim/i);
    expect(st.past.length).toBe(0); // nothing was mutated
  });

  it('reports when two circles are too far apart to fillet', () => {
    const sk = createSketch();
    const c1 = addCircle(sk, addPoint(sk, 0, 0), 10);
    const c2 = addCircle(sk, addPoint(sk, 500, 0), 10);
    useSketchStore.setState({ sk, selection: [c1, c2], past: [], error: null, chamferPicks: {} });
    useSketchStore.getState().fillet(3);
    expect(useSketchStore.getState().error).toMatch(/cross|too large/i);
    expect(useSketchStore.getState().past.length).toBe(0); // rolled back
  });

  it('says the two picks do not meet when they are far apart', () => {
    const sk = createSketch();
    const a1 = addArc(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 0), addPoint(sk, 0, 10), 10);
    const a2 = addArc(sk, addPoint(sk, 500, 0), addPoint(sk, 510, 0), addPoint(sk, 500, 10), 10);
    useSketchStore.setState({ sk, selection: [a1, a2], past: [], error: null, chamferPick: null });
    useSketchStore.getState().fillet(3);
    expect(useSketchStore.getState().error).toMatch(/don't meet|do not meet/i);
  });

  it('fillets two lines whose corner points coincide but were never merged', () => {
    const sk = createSketch();
    const l1 = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 30, 0));
    const l2 = addLine(sk, addPoint(sk, 0.4, -0.3), addPoint(sk, 0, 30)); // corner ≈ l1's, separate point
    useSketchStore.setState({ sk, selection: [l1, l2], past: [], error: null, pickTol: 1.5 });
    useSketchStore.getState().fillet(5);
    expect(filletError(useSketchStore.getState().error)).toBeNull();
    expect(arcCount(sk)).toBe(1); // the fillet arc got made — the weld worked
  });

  it('tells two loose lines to share an endpoint, not "R too large"', () => {
    const sk = createSketch();
    const l1 = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 30, 0));
    const l2 = addLine(sk, addPoint(sk, 50, 5), addPoint(sk, 50, 30)); // nowhere near l1
    useSketchStore.setState({ sk, selection: [l1, l2], past: [], error: null, pickTol: 1.5 });
    useSketchStore.getState().fillet(5);
    expect(useSketchStore.getState().error).toMatch(/don't meet|shared endpoint|Coincident/i);
    expect(useSketchStore.getState().error).not.toMatch(/too large/i);
  });
});

describe('chamfer via the store', () => {
  it('welds a coincident-but-separate corner, and names the real failure otherwise', () => {
    const sk = createSketch();
    const l1 = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 30, 0));
    const l2 = addLine(sk, addPoint(sk, 0.5, 0.2), addPoint(sk, 0, 30));
    useSketchStore.setState({ sk, selection: [l1, l2], past: [], error: null, pickTol: 1.5 });
    useSketchStore.getState().chamfer(4);
    // The chamfer went through (a `solve()` error from the missing Worker in
    // node is unrelated) — no "don't meet / too large" refusal, and a 3rd line
    // (the chamfer edge) now exists.
    expect(useSketchStore.getState().error || '').not.toMatch(/too large|don't meet|shared endpoint|Coincident/i);
    expect([...sk.entities.values()].filter((x) => x.type === 'line').length).toBe(3);

    // Two lines that genuinely don't touch → the corner message, not the size one.
    const sk2 = createSketch();
    const a = addLine(sk2, addPoint(sk2, 0, 0), addPoint(sk2, 30, 0));
    const b = addLine(sk2, addPoint(sk2, 100, 0), addPoint(sk2, 100, 30));
    useSketchStore.setState({ sk: sk2, selection: [a, b], past: [], error: null, pickTol: 1.5 });
    useSketchStore.getState().chamfer(4);
    expect(useSketchStore.getState().error).toMatch(/don't meet|shared endpoint/i);
  });
});

describe('drag-to-modify (arm / end)', () => {
  it('arms a drag on a normal point: pins it, no snapshot yet', () => {
    const sk = createSketch();
    const p = addPoint(sk, 5, 5);
    useSketchStore.setState({ sk, dragging: null, past: [] });
    const started = useSketchStore.getState().beginDrag(p);
    expect(started).toBe(true);
    expect(sk.entities.get(p).fixed).toBe(true); // pinned for the live solve
    expect(useSketchStore.getState().dragging.id).toBe(p);
    expect(useSketchStore.getState().dragging.moved).toBe(false);
    expect(useSketchStore.getState().past.length).toBe(0); // snapshot deferred to first move
  });

  it('refuses to drag the origin (fixed datum)', () => {
    const { sk, origin } = withOrigin();
    useSketchStore.setState({ sk, dragging: null });
    expect(useSketchStore.getState().beginDrag(origin)).toBe(false);
    expect(useSketchStore.getState().dragging).toBeNull();
  });

  it('endDrag restores the fixed flag and reports no movement for a bare grab', () => {
    const sk = createSketch();
    const p = addPoint(sk, 5, 5); // wasFixed = false
    useSketchStore.setState({ sk, dragging: null, past: [] });
    useSketchStore.getState().beginDrag(p);
    const moved = useSketchStore.getState().endDrag();
    expect(moved).toBe(false); // a click, not a drag
    expect(sk.entities.get(p).fixed).toBe(false); // pin released
    expect(useSketchStore.getState().dragging).toBeNull();
  });
});

describe('line guides — angle lock & tangent snap (hover)', () => {
  it('grabs the vertical axis from the tight band; only shows a guide from the wide one', () => {
    const sk = createSketch();
    const anchor = addPoint(sk, 0, 0);
    useSketchStore.setState({ sk, tool: 'line', pending: anchor, snap: null, axisSnap: null });

    // ~89° — inside the lock band → the endpoint snaps onto the axis.
    useSketchStore.getState().hover(0.15, 9.9);
    const s1 = useSketchStore.getState();
    expect(s1.axisSnap.locked).toBe(true);
    expect(s1.axisSnap.deg).toBe(90);
    expect(near(s1.axisSnap.x, 0)).toBe(true); // snapped onto the vertical axis
    expect(near(s1.lineAngle, 90)).toBe(true);

    // ~84° — in the show band, not the lock band → a hint only: the point stays
    // where the cursor is and the raw angle is reported.
    useSketchStore.getState().hover(1.05, 9.9);
    const s2 = useSketchStore.getState();
    expect(s2.axisSnap.locked).toBe(false);
    expect(s2.axisSnap.deg).toBe(90);        // guide still points at vertical
    expect(near(s2.axisSnap.x, 1.05)).toBe(true); // ...but the endpoint is not pulled
    expect(near(s2.lineAngle, 84, 1)).toBe(true);

    // ~30° — nothing near → no guide at all.
    useSketchStore.getState().hover(10, 5.77);
    expect(useSketchStore.getState().axisSnap).toBeNull();
  });

  it('offers a tangent snap when the line approaches a circle rim', () => {
    const sk = createSketch();
    const anchor = addPoint(sk, 30, 0); // external anchor
    const c = addPoint(sk, 0, 0);
    const circle = addCircle(sk, c, 10);
    useSketchStore.setState({ sk, tool: 'line', pending: anchor, snap: null, axisSnap: null });
    // Hover near the upper-right rim → tangent target, not a plain rim landing.
    useSketchStore.getState().hover(7, 7.4);
    const { snap } = useSketchStore.getState();
    expect(snap).not.toBeNull();
    expect(snap.tangent).toBe(true);
    expect(snap.tangentOf).toBe(circle);
    expect(near(Math.hypot(snap.x, snap.y), 10, 1e-6)).toBe(true); // lies on the rim
  });

  it('locks parallel to the line the anchor continues, and the click adds the relation', () => {
    const sk = createSketch();
    const p0 = addPoint(sk, 0, 0);
    const p1 = addPoint(sk, 10, 6); // ref ~31°
    const ref = addLine(sk, p0, p1);
    const refDeg = (Math.atan2(6, 10) * 180) / Math.PI;
    useSketchStore.setState({ sk, tool: 'line', pending: p1, snap: null, axisSnap: null, selection: [], pickTol: 1.5 });
    // Draw on from the ref's far end, roughly along the same 31°.
    useSketchStore.getState().hover(20, 12.15);
    const s = useSketchStore.getState();
    expect(s.axisSnap.kind).toBe('parallel');
    expect(s.axisSnap.ref).toBe(ref);
    expect(s.axisSnap.locked).toBe(true);
    expect(near(s.axisSnap.deg, refDeg, 0.01)).toBe(true);

    useSketchStore.getState().clickAt(20, 12.15);
    const st = useSketchStore.getState();
    const newLine = [...st.sk.entities.values()].find((e) => e.type === 'line' && e.id !== ref);
    const par = st.sk.constraints.find((c) => c.kind === 'parallel');
    expect(par).toBeTruthy();
    expect(par.refs).toEqual(expect.arrayContaining([ref, newLine.id]));
  });

  it('does NOT infer parallel from a line far from the anchor and the cursor', () => {
    const sk = createSketch();
    addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 10, 6)); // ~31°, but off in a corner
    const anchor = addPoint(sk, 0, 200);
    useSketchStore.setState({ sk, tool: 'line', pending: anchor, snap: null, axisSnap: null, pickTol: 1.5 });
    useSketchStore.getState().hover(100, 260); // ~31° from the anchor, nowhere near the ref line
    // No axis is close either, so no guide at all.
    expect(useSketchStore.getState().axisSnap).toBeNull();
  });

  it('locks perpendicular to the anchor line', () => {
    const sk = createSketch();
    const p0 = addPoint(sk, 0, 0);
    const p1 = addPoint(sk, 10, 6);
    const ref = addLine(sk, p0, p1);
    const perpRad = ((Math.atan2(6, 10) * 180) / Math.PI + 90) * (Math.PI / 180);
    const anchor = sk.entities.get(p1);
    useSketchStore.setState({ sk, tool: 'line', pending: p1, snap: null, axisSnap: null, pickTol: 1.5 });
    useSketchStore.getState().hover(anchor.x + Math.cos(perpRad) * 15, anchor.y + Math.sin(perpRad) * 15);
    const s = useSketchStore.getState();
    expect(s.axisSnap.kind).toBe('perpendicular');
    expect(s.axisSnap.ref).toBe(ref);
  });

  it('locks to the plain horizontal axis, not "parallel to a horizontal line"', () => {
    const sk = createSketch();
    const a = addPoint(sk, 0, 0);
    const b = addPoint(sk, 20, 0);
    addLine(sk, a, b); // axis-aligned — skipped as a parallel/perp reference
    useSketchStore.setState({ sk, tool: 'line', pending: b, snap: null, axisSnap: null, pickTol: 1.5 });
    // Continue from the horizontal line's end, ~1° above horizontal.
    useSketchStore.getState().hover(30, 0.17);
    const s = useSketchStore.getState();
    expect(s.axisSnap.kind).toBe('axis');
    expect(s.axisSnap.hv).toBe('horizontal');
    expect(s.axisSnap.ref).toBeNull();
  });
});

describe('intersection snap (hover + click)', () => {
  const crossed = () => {
    const sk = createSketch();
    const h = addLine(sk, addPoint(sk, -10, 0), addPoint(sk, 10, 0));
    const v = addLine(sk, addPoint(sk, 0, -10), addPoint(sk, 0, 10)); // cross at (0,0)
    useSketchStore.setState({
      sk, tool: 'point', pickTol: 1.5, snap: null, past: [], future: [],
    });
    return { sk, h, v };
  };

  it('reports a gold intersection snap under the cursor while a placing tool is active', () => {
    crossed();
    useSketchStore.getState().hover(0.4, -0.3);
    const { snap } = useSketchStore.getState();
    expect(snap.intersection).toBe(true);
    expect(near(snap.x, 0) && near(snap.y, 0)).toBe(true);
    expect(snap.of).toHaveLength(2);
  });

  it('does not run the pairwise scan for a non-placing tool', () => {
    crossed();
    useSketchStore.setState({ tool: 'select' });
    useSketchStore.getState().hover(0.4, -0.3);
    expect(useSketchStore.getState().snap).toBeNull();
  });

  it('a click there drops a point on the crossing, pinned to both lines', () => {
    const { sk, h, v } = crossed();
    useSketchStore.getState().clickAt(0.3, 0.2);
    const pts = [...sk.entities.values()].filter((e) => e.type === 'point');
    const placed = pts[pts.length - 1];
    expect(near(placed.x, 0) && near(placed.y, 0)).toBe(true);
    const added = sk.constraints.filter((c) => c.refs.includes(placed.id));
    expect(added.map((c) => c.kind).sort()).toEqual(['pointOnLine', 'pointOnLine']);
    expect(added.some((c) => c.refs.includes(h))).toBe(true);
    expect(added.some((c) => c.refs.includes(v))).toBe(true);
  });
});

describe('quadrant snap (circle high points)', () => {
  const withCircle = () => {
    const sk = createSketch();
    const ctr = addPoint(sk, 5, 5);
    const circle = addCircle(sk, ctr, 10); // right quadrant at (15, 5)
    useSketchStore.setState({
      sk, tool: 'point', pickTol: 1.5, snap: null, past: [], future: [],
    });
    return { sk, ctr, circle };
  };

  it('reports a violet quadrant snap near a circle high point', () => {
    withCircle();
    useSketchStore.getState().hover(14.7, 5.2);
    const { snap } = useSketchStore.getState();
    expect(snap.quadrant).toBe(true);
    expect(near(snap.x, 15) && near(snap.y, 5)).toBe(true);
    expect(snap.quadAxis).toBe('h');
  });

  it('a click there pins the point on the circle and level with its centre', () => {
    const { sk, ctr, circle } = withCircle();
    useSketchStore.getState().clickAt(14.7, 5.2);
    const placed = [...sk.entities.values()].filter((e) => e.type === 'point').pop();
    expect(near(placed.x, 15) && near(placed.y, 5)).toBe(true);
    const kinds = sk.constraints.filter((c) => c.refs.includes(placed.id)).map((c) => c.kind).sort();
    expect(kinds).toEqual(['horizontal', 'pointOnCircle']); // right quadrant → horizontal to centre
    const hz = sk.constraints.find((c) => c.kind === 'horizontal' && c.refs.includes(placed.id));
    expect(hz.refs).toContain(ctr);
    const on = sk.constraints.find((c) => c.kind === 'pointOnCircle');
    expect(on.refs).toContain(circle);
  });
});

describe('midpoint snap (line centre)', () => {
  const withLine = () => {
    const sk = createSketch();
    const l = addLine(sk, addPoint(sk, 0, 0), addPoint(sk, 20, 0)); // midpoint (10, 0)
    useSketchStore.setState({ sk, tool: 'point', pickTol: 1.5, snap: null, past: [], future: [] });
    return { sk, l };
  };

  it('reports a midpoint snap near the centre of a segment', () => {
    withLine();
    useSketchStore.getState().hover(10.2, 0.3);
    const { snap } = useSketchStore.getState();
    expect(snap.midpoint).toBe(true);
    expect(near(snap.x, 10) && near(snap.y, 0)).toBe(true);
  });

  it('a click there pins the point with a midpoint relation to the line', () => {
    const { sk, l } = withLine();
    useSketchStore.getState().clickAt(10.2, 0.3);
    const placed = [...sk.entities.values()].filter((e) => e.type === 'point').pop();
    expect(near(placed.x, 10) && near(placed.y, 0)).toBe(true);
    const c = sk.constraints.find((k) => k.kind === 'midpoint' && k.refs.includes(placed.id));
    expect(c).toBeTruthy();
    expect(c.refs).toContain(l);
  });
});

describe('marquee (box) selection', () => {
  const scene = () => {
    const sk = createSketch();
    const inside = addLine(sk, addPoint(sk, 1, 1), addPoint(sk, 4, 4));
    const straddle = addLine(sk, addPoint(sk, 3, 3), addPoint(sk, 20, 20));
    useSketchStore.setState({
      sk, tool: 'select', selection: [], boxSelect: null, _boxStart: null, pickTol: 0.5,
    });
    return { sk, inside, straddle };
  };

  it('a left→right drag encloses; a bare press never touches the selection', () => {
    const { inside, straddle } = scene();
    const s = useSketchStore.getState();
    s.beginBoxSelect(0, 0);
    s.updateBoxSelect(10, 10); // grows past the click slop → marquee appears
    expect(useSketchStore.getState().boxSelect).not.toBeNull();
    expect(s.endBoxSelect()).toBe(true);
    expect(useSketchStore.getState().selection).toEqual([inside]);
    expect(useSketchStore.getState().selection).not.toContain(straddle);
  });

  it('a right→left drag also grabs what the box touches', () => {
    const { inside, straddle } = scene();
    const s = useSketchStore.getState();
    s.beginBoxSelect(10, 10);
    s.updateBoxSelect(0, 0);
    s.endBoxSelect();
    const sel = useSketchStore.getState().selection;
    expect(sel).toContain(inside);
    expect(sel).toContain(straddle);
  });

  it('a press that never grows past the slop commits nothing', () => {
    scene();
    useSketchStore.setState({ selection: [99] });
    const s = useSketchStore.getState();
    s.beginBoxSelect(5, 5);
    s.updateBoxSelect(5.1, 5.1);
    expect(useSketchStore.getState().boxSelect).toBeNull();
    expect(s.endBoxSelect()).toBe(false);
    expect(useSketchStore.getState().selection).toEqual([99]);
  });

  it('does not arm outside the Select tool', () => {
    scene();
    useSketchStore.setState({ tool: 'line' });
    useSketchStore.getState().beginBoxSelect(0, 0);
    expect(useSketchStore.getState()._boxStart).toBeNull();
  });
});

describe('swapDimensionRefs', () => {
  it('flips the ref order but keeps the interior corner angle', () => {
    const { sk, base, up } = corner(); // 90° corner sharing the origin
    const spec = { kind: 'angle', refs: [base, up], label: 'Angle', unit: '°', angular: true, current: 90 };
    useSketchStore.setState({ sk, selection: [base, up], dimensionPending: spec });
    useSketchStore.getState().swapDimensionRefs();
    const dp = useSketchStore.getState().dimensionPending;
    expect(dp.refs).toEqual([up, base]);
    // The interior angle is a magnitude — still 90° whichever line is first.
    expect(near(dp.current, 90)).toBe(true);
  });

  it('is a no-op for a non-angular dimension', () => {
    const spec = { kind: 'distance', refs: [1, 2], label: 'Length', current: 10 };
    useSketchStore.setState({ dimensionPending: spec });
    useSketchStore.getState().swapDimensionRefs();
    expect(useSketchStore.getState().dimensionPending).toBe(spec);
  });
});
