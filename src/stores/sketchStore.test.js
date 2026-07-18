import { describe, it, expect } from 'vitest';
import { useSketchStore } from './sketchStore.js';
import {
  createSketch, addPoint, addLine, addCircle, addConstraint, dof,
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
