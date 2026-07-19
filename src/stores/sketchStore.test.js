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
  it('locks the rubber-band to the nearest 45° axis when close, and reports the angle', () => {
    const sk = createSketch();
    const anchor = addPoint(sk, 0, 0);
    useSketchStore.setState({ sk, tool: 'line', pending: anchor, snap: null, axisSnap: null });
    // Cursor at ~87° — within 5° of the vertical axis → lock to 90°.
    useSketchStore.getState().hover(0.5, 9.9);
    const s1 = useSketchStore.getState();
    expect(s1.axisSnap).not.toBeNull();
    expect(s1.axisSnap.deg).toBe(90);
    expect(near(s1.axisSnap.x, 0)).toBe(true); // snapped onto the vertical axis
    expect(near(s1.lineAngle, 90)).toBe(true);
    // Cursor at 30° — far from any 45° axis → no lock, raw angle reported.
    useSketchStore.getState().hover(10, 5.77);
    const s2 = useSketchStore.getState();
    expect(s2.axisSnap).toBeNull();
    expect(near(s2.lineAngle, 30, 0.2)).toBe(true);
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
