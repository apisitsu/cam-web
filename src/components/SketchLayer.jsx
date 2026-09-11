/**
 * SketchLayer — renders the live sketch inside the R3F viewport and turns
 * pointer-picks on the Z=0 plane into sketch edits (Phase 2, slice 4).
 *
 * The scene is Z-up with the machine XY plane at Z=0, so sketch (x, y) maps
 * straight to world (x, y, 0) and R3F's `event.point` already gives sketch
 * coordinates — no manual raycasting. All geometry/selection logic lives in the
 * Node-tested store/edit layer; this component is just render + event wiring.
 */
import { useMemo, useEffect, useRef } from 'react';
import { Line, Html } from '@react-three/drei';
import { invalidate, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useSketchStore } from '../stores/sketchStore.js';
import { dimensionAnnotations } from '../engine/sketch/annotations.js';
import { polygonPreview, slotPreview, axisDistance } from '../engine/sketch/shapes.js';
import { tessellateArc, CHORD_TOL } from '../engine/sketch/loops.js';
import { planeMatrix } from '../engine/sketch/plane.js';
import { CAD } from '../theme.js';

/**
 * A preview only when there is something to draw.
 *
 * A drei `<Line>` with fewer than two points throws: `LineGeometry.setPositions`
 * sizes a `Float32Array` at `count - 6` and asks for a negative length. An empty
 * array is *truthy*, so `{preview && <Line …/>}` does not catch it — and the
 * slot preview is legitimately empty whenever the cursor sits on the slot's own
 * axis, which is most of the time while the third click is being aimed.
 */
const drawable = (pts) => (Array.isArray(pts) && pts.length >= 2 ? pts : null);

const noRaycast = () => null;
const Z = 0.05; // lift a hair above the Z=0 pick plane to avoid z-fighting
const PREVIEW = CAD.skPreview; // amber rubber-band while drawing
const SNAP_COLOR = CAD.skSnap; // magenta snap indicator (vertex / rim)
const TANGENT_COLOR = CAD.skTangent; // green — tangent snap indicator
const INTERSECT_COLOR = CAD.skIntersect; // gold — two curves crossing
const QUADRANT_COLOR = CAD.skQuadrant; // violet — circle/arc quadrant (high point)
const MIDPOINT_COLOR = CAD.skMidpoint; // blue — line-segment midpoint
const AXIS_COLOR = CAD.skAxis; // cyan — angle-lock guide axis

// Unit circle in the XY plane (local coords), for the screen-scaled snap ring.
const UNIT_RING = (() => {
  const a = [];
  for (let i = 0; i <= 32; i++) { const t = (i / 32) * Math.PI * 2; a.push([Math.cos(t), Math.sin(t), 0]); }
  return a;
})();

/**
 * A ring drawn at a **constant pixel size** regardless of zoom. The snap
 * indicator used to be a fixed 1.6 mm circle, which shrank to invisibility when
 * zoomed far out; here the group is rescaled every frame to `pixels / zoom` world
 * units so the ring always reads the same on screen. (Demand-mode canvas → this
 * only runs on real redraws, e.g. while zooming or hovering.)
 */
function ScreenRing({ x, y, color, pixels = 10 }) {
  const ref = useRef();
  useFrame(({ camera }) => {
    if (ref.current) ref.current.scale.setScalar(pixels / (camera.zoom || 1));
  });
  return (
    <group ref={ref} position={[x, y, Z]}>
      <Line points={UNIT_RING} color={color} lineWidth={1.5} raycast={noRaycast} />
    </group>
  );
}

// Vertex marker radius in *screen pixels*, so a dot reads about as heavy as a
// line (drei `<Line lineWidth>` is pixels too) at any zoom. The dots used to be
// a fixed model-space sphere — 0.8 mm radius — which on a ~15 mm profile drew a
// blob that buried the geometry. `pixels / zoom` world units, rescaled per frame
// like ScreenRing, keeps them constant on screen. Emphasised (selected / hover /
// pending / origin) a bit larger so a point stays easy to grab for a drag.
const VERTEX_PX = 2.2;
const VERTEX_PX_EMPH = 3.6;

/** A sketch vertex dot at a constant on-screen size (see VERTEX_PX). */
function Vertex({ x, y, color, pixels, pickable, onPointerDown, onClick }) {
  const ref = useRef();
  useFrame(({ camera }) => {
    if (ref.current) ref.current.scale.setScalar(pixels / (camera.zoom || 1));
  });
  return (
    <mesh
      ref={ref}
      position={[x, y, Z]}
      raycast={pickable ? undefined : noRaycast}
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      <sphereGeometry args={[1, 16, 16]} />
      <meshBasicMaterial color={color} />
    </mesh>
  );
}
const CONSTRUCTION = CAD.skConstruction; // slate — construction (reference) geometry, drawn dashed
const HOVER = CAD.skHover; // amber pre-select highlight (the entity a click will pick)
const SELECTED = CAD.skSelected; // green selected highlight (SolidWorks' own)
const GEOM = CAD.skUnder; // default geometry colour
const ANGLE_BASE = CAD.skAxis; // cyan — the fixed reference line of an angle dimension
const ANGLE_ROTATE = CAD.skPreview; // amber — the line the angle rotates

const TWO_PI = Math.PI * 2;
/**
 * Polyline sweeping counter-clockwise from a0 to a1 (planegcs arc order), lifted
 * to the sketch layer's Z.
 *
 * Delegates to the **same** `tessellateArc` the geometry uses, rather than
 * splitting the sweep into a fixed number of segments as this did before. Two
 * copies at different fidelities meant the screen and the solid disagreed, and
 * they disagreed most where it matters: at R200 a fixed 64 segments strays
 * 0.24 mm from the true arc while the geometry stays within 0.01 mm. The
 * operator decides from the picture, so the picture has to be the thing that
 * gets cut.
 */
function arcRing(cx, cy, r, a0, a1, chordTol = CHORD_TOL) {
  const flat = tessellateArc(cx, cy, r, a0, a1, chordTol);
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1], Z]);
  return pts;
}

const DIM_COLOR = CAD.skDim; // near-black — placed dimensions (witness/dimension lines)
const dimLabelStyle = {
  color: CAD.skDim, background: CAD.glassSolid, border: `1px solid ${CAD.border}`,
  borderRadius: 4, font: '600 11px monospace', padding: '0 4px',
  whiteSpace: 'nowrap', userSelect: 'none',
  // Pointer events on so a dimension label is double-clickable to edit its value
  // and can be dragged to reposition the whole dimension; the label is small and
  // stood off from the geometry, so picking the sketch under it is unaffected.
  pointerEvents: 'auto', cursor: 'move',
};

/** Live angle/length readout shown at the line rubber-band's tip while drawing. */
const angleReadoutStyle = (locked) => ({
  color: locked ? CAD.surface : CAD.text,
  background: locked ? AXIS_COLOR : CAD.glassSolid,
  border: `1px solid ${locked ? AXIS_COLOR : CAD.border}`,
  borderRadius: 4, font: '600 11px monospace', padding: '1px 5px',
  whiteSpace: 'nowrap', userSelect: 'none', pointerEvents: 'none',
  transform: 'translate(12px, -18px)',
});

/**
 * On-canvas annotations for every *dimensional* constraint (one carrying a value)
 * so it's visible which lines / distances are already sized:
 *   - distance          → parallel dimension line + witness lines + value;
 *   - distanceX/Y       → the same, but locked to the x or y axis (SW horizontal
 *     and vertical dimensions), so the line never runs diagonally;
 *   - pointLineDistance → the perpendicular dimension line (point → foot on the
 *     line), which is what a 2-line/parallel gap, point↔line and line↔centre use;
 *   - angle             → an arc swept between the two legs + the degree value;
 *   - radius / lockX / lockY → a value tag on the geometry.
 * Non-dimensional constraints (horizontal, coincident, …) are not drawn here —
 * they remove DOF but aren't "sizes". The dimension *lines* opt out of
 * raycasting so they never intercept a sketch pick; the *labels* do take pointer
 * events — double-click edits the value, drag slides the whole dimension — but
 * they are small and stood off the geometry, so picking under them still works.
 */
function DimensionAnnotations({ sk, version }) {
  const beginEditConstraint = useSketchStore((s) => s.beginEditConstraint);
  const setDimensionOffset = useSketchStore((s) => s.setDimensionOffset);
  const selectedDims = useSketchStore((s) => s.selectedDims);
  const toggleDimSelect = useSketchStore((s) => s.toggleDimSelect);
  const camera = useThree((s) => s.camera);
  const selDim = new Set(selectedDims);
  // The geometry is built by a pure module (`engine/sketch/annotations.js`) so
  // it can be tested without a renderer; this component only maps it to drei.
  const { segs, labels } = useMemo(
    () => dimensionAnnotations(sk, { z: Z }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sk, version],
  );

  // Drag a dimension label to slide the whole dimension (line + value) clear of
  // the geometry. The pointer delta is in CSS pixels; for the orthographic
  // sketch camera, world units = pixels / zoom (the same factor `ScreenRing`
  // uses), and screen-Y is inverted. This holds while the sketch is viewed
  // face-on, which is when dimensions are placed. `snapshot` only on the first
  // move so the whole drag is one undo step; a sub-3px twitch is a mis-click and
  // ignored, leaving the double-click-to-edit behaviour intact.
  const drag = useRef(null);
  const onLabelDown = (e, ci) => {
    e.stopPropagation();
    const base = sk.constraints[ci]?.labelOffset;
    drag.current = {
      ci, x: e.clientX, y: e.clientY,
      base: Array.isArray(base) ? base : [0, 0],
      moved: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onLabelMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dxPx = e.clientX - d.x;
    const dyPx = e.clientY - d.y;
    if (!d.moved && Math.hypot(dxPx, dyPx) < 3) return;
    const z = camera?.zoom || 1;
    setDimensionOffset(
      d.ci,
      [d.base[0] + dxPx / z, d.base[1] - dyPx / z],
      { snapshot: !d.moved },
    );
    d.moved = true;
  };
  // A no-move release is a click → toggle this dimension's selection (Delete
  // then removes it). A release that moved was a reposition, so it does not.
  const clickWasDrag = useRef(false);
  const onLabelUp = (e) => {
    if (drag.current) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      clickWasDrag.current = drag.current.moved;
    }
    drag.current = null;
  };
  const onLabelClick = (e, ci) => {
    e.stopPropagation();
    if (clickWasDrag.current) { clickWasDrag.current = false; return; }
    toggleDimSelect(ci);
  };

  return (
    <group>
      {segs.map((s) => {
        const sel = selDim.has(s.ci);
        return (
          <Line
            key={s.key}
            points={s.pts}
            color={sel ? SELECTED : DIM_COLOR}
            lineWidth={sel ? 2 : 1}
            dashed={!sel}
            dashSize={0.6}
            gapSize={0.4}
            transparent
            opacity={sel ? 1 : 0.85}
            raycast={noRaycast}
          />
        );
      })}
      {labels.map((b) => {
        // A driven (reference) dimension is shown in parentheses and a muted
        // purple, like SolidWorks reference dimensions.
        const driven = sk.constraints[b.ci]?.driven;
        const sel = selDim.has(b.ci);
        const base = driven
          ? { ...dimLabelStyle, color: CAD.skDriven, borderColor: CAD.skDriven, fontStyle: 'italic' }
          : dimLabelStyle;
        return (
          <Html key={b.key} position={b.pos} center zIndexRange={[2, 0]}>
            <div
              style={sel ? { ...base, borderColor: SELECTED, color: SELECTED, boxShadow: `0 0 0 1px ${SELECTED}` } : base}
              title={sel
                ? 'Selected — press Delete to remove · drag to move · double-click to edit'
                : 'Click to select (Delete removes) · drag to move · double-click to edit'}
              onPointerDown={(e) => onLabelDown(e, b.ci)}
              onPointerMove={onLabelMove}
              onPointerUp={onLabelUp}
              onPointerCancel={onLabelUp}
              onClick={(e) => onLabelClick(e, b.ci)}
              onDoubleClick={(e) => { e.stopPropagation(); beginEditConstraint(b.ci); }}
            >
              {driven ? `(${b.text})` : b.text}
            </div>
          </Html>
        );
      })}
    </group>
  );
}

/**
 * Sketch coordinates from a pointer event.
 *
 * `event.point` is in **world** space. That used to be the same thing as sketch
 * space, because the sketch was always the Z=0 plane; now the layer sits under
 * the active sketch's plane matrix, so a click on the front plane arrives as
 * (x, 0, z) and reading `.x` / `.y` off it would drop the sketch's whole second
 * axis. Asking the picked object to convert undoes exactly the transform that
 * was applied to draw it, whatever plane that is.
 */
const localPoint = (e) => {
  const p = e.point.clone();
  return e.object?.parent ? e.object.worldToLocal(p) : p;
};

export default function SketchLayer() {
  const version = useSketchStore((s) => s.version);
  const sk = useSketchStore((s) => s.sk);
  const sketches = useSketchStore((s) => s.sketches);
  const activeId = useSketchStore((s) => s.activeId);
  const tool = useSketchStore((s) => s.tool);
  const selection = useSketchStore((s) => s.selection);
  const pending = useSketchStore((s) => s.pending);
  const cursor = useSketchStore((s) => s.cursor);
  const snap = useSketchStore((s) => s.snap);
  const axisSnap = useSketchStore((s) => s.axisSnap);
  const lineAngle = useSketchStore((s) => s.lineAngle);
  const pending2 = useSketchStore((s) => s.pending2);
  const hoverId = useSketchStore((s) => s.hoverId);
  const dofState = useSketchStore((s) => s.dofState);
  const solveResult = useSketchStore((s) => s.solveResult);
  const dimensionPending = useSketchStore((s) => s.dimensionPending);
  const polygonSides = useSketchStore((s) => s.polygonSides);
  const clickAt = useSketchStore((s) => s.clickAt);
  const hover = useSketchStore((s) => s.hover);
  const clearHover = useSketchStore((s) => s.clearHover);
  const toggleSelect = useSketchStore((s) => s.toggleSelect);
  const beginDrag = useSketchStore((s) => s.beginDrag);
  const dragTo = useSketchStore((s) => s.dragTo);
  const endDrag = useSketchStore((s) => s.endDrag);
  const setPickTol = useSketchStore((s) => s.setPickTol);
  const cancelPending = useSketchStore((s) => s.cancelPending);
  const deleteSelected = useSketchStore((s) => s.deleteSelected);
  const undo = useSketchStore((s) => s.undo);
  const redo = useSketchStore((s) => s.redo);
  const boxSelect = useSketchStore((s) => s.boxSelect);
  const beginBoxSelect = useSketchStore((s) => s.beginBoxSelect);
  const updateBoxSelect = useSketchStore((s) => s.updateBoxSelect);
  const endBoxSelect = useSketchStore((s) => s.endBoxSelect);
  const cancelBoxSelect = useSketchStore((s) => s.cancelBoxSelect);
  const clearDimSelect = useSketchStore((s) => s.clearDimSelect);

  const { points, lines, circles, arcs } = useMemo(() => {
    const pts = [];
    const lns = [];
    const circs = [];
    const ars = [];
    for (const e of sk.entities.values()) if (e.type === 'point') pts.push(e);
    for (const e of sk.entities.values()) {
      if (e.type === 'line') {
        const a = sk.entities.get(e.p1);
        const b = sk.entities.get(e.p2);
        if (a && b) lns.push({ id: e.id, a, b, construction: !!e.construction });
      } else if (e.type === 'circle') {
        const c = sk.entities.get(e.center);
        if (c) circs.push({ id: e.id, cx: c.x, cy: c.y, r: e.r, construction: !!e.construction });
      } else if (e.type === 'arc') {
        const c = sk.entities.get(e.center);
        const s = sk.entities.get(e.start);
        const en = sk.entities.get(e.end);
        if (c && s && en) {
          ars.push({
            id: e.id, cx: c.x, cy: c.y, r: e.r, construction: !!e.construction,
            a0: Math.atan2(s.y - c.y, s.x - c.x),
            a1: Math.atan2(en.y - c.y, en.x - c.x),
          });
        }
      }
    }
    return { points: pts, lines: lns, circles: circs, arcs: ars };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sk, version]);

  // Redraw on geometry change and on every pointer move (rubber-band + hover).
  useEffect(() => {
    invalidate();
  }, [version, cursor, snap, axisSnap, lineAngle, hoverId, boxSelect]);

  // Keep the pick/snap tolerance a constant ~9 px on screen (SolidWorks picks by
  // pixels, not model units): world tol = pixels / zoom, updated when zoom shifts.
  const lastZoom = useRef(0);
  useFrame(({ camera }) => {
    const z = camera.zoom || 1;
    if (Math.abs(z - lastZoom.current) / (lastZoom.current || 1) > 0.02) {
      lastZoom.current = z;
      setPickTol(9 / z);
    }
  });

  // Drag-to-modify (SolidWorks): a point pointer-down arms a drag; the pick plane
  // feeds cursor moves to the solver; releasing anywhere ends it. A no-move grab
  // is just a selection click. Refs (not state) so the handlers don't churn.
  const dragId = useRef(null);
  const swallowClick = useRef(false); // eat the synthetic click after a no-move grab
  useEffect(() => {
    const onUp = () => {
      if (dragId.current != null) {
        const moved = endDrag();
        if (!moved) { toggleSelect(dragId.current); swallowClick.current = true; }
        dragId.current = null;
        return;
      }
      // A marquee release lands here (the drag was on the pick plane, so it never
      // set `dragId`). `endBoxSelect` commits the selection and reports whether a
      // real box happened, so we can eat the trailing click.
      const st = useSketchStore.getState();
      if (st._boxStart || st.boxSelect) {
        if (endBoxSelect()) swallowClick.current = true;
      }
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, [endDrag, toggleSelect, endBoxSelect]);

  // Keyboard: Esc cancels a pending draw, Delete removes the selection,
  // Ctrl/Cmd+Z undoes and Ctrl/Cmd+Y (or Shift+Z) redoes. Ignore while typing.
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        cancelPending();
        cancelBoxSelect();
        clearDimSelect();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        deleteSelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelPending, cancelBoxSelect, clearDimSelect, deleteSelected, undo, redo]);

  const drawing = tool === 'point' || tool === 'line' || tool === 'rectangle'
    || tool === 'circle' || tool === 'arc' || tool === 'slot' || tool === 'polygon';
  // Geometry is clickable in select/dimension (pick), trim (cut) and chamfer
  // (pick two lines) modes.
  const picking = tool === 'select' || tool === 'dimension' || tool === 'trim' || tool === 'chamfer';
  // Circles/arcs are directly selectable (their own raycast) only when picking a
  // selection — not while trimming/chamfering (both act on lines).
  const selecting = tool === 'select' || tool === 'dimension';
  const selected = new Set(selection);
  // SolidWorks' solve-state colouring of the geometry, now literally its three
  // colours on a light ground: under-defined stays blue (still has freedom),
  // fully defined goes black (done), and an over-defined/conflicting sketch goes
  // red. Selection/hover still win.
  const overDefined = dofState?.state === 'over' || (solveResult && !solveResult.success && solveResult.conflicting?.length > 0);
  const baseGeom = overDefined ? CAD.skOver : dofState?.state === 'full' ? CAD.skFull : GEOM;
  // While an angle dimension is being entered, colour its base (fixed reference)
  // and rotating line distinctly so it's clear which one moves to the set angle.
  const angleBase = dimensionPending?.angular ? dimensionPending.refs[0] : null;
  const angleRotate = dimensionPending?.angular ? dimensionPending.refs[1] : null;

  // The live drawing endpoint: a positional snap (vertex / rim / tangent) wins,
  // then the angle-lock axis point, else the raw cursor — matching exactly where
  // the click will land (clickAt resolves the same order).
  const tip = snap ?? axisSnap ?? cursor;

  // Rubber-band preview from the pending point(s) to the live (snapped) cursor.
  const anchor = pending != null ? sk.entities.get(pending) : null;
  const arcStart = pending2 != null ? sk.entities.get(pending2) : null;
  const preview = useMemo(() => {
    if (!anchor || !tip) return null;
    if (tool === 'line') {
      return [[anchor.x, anchor.y, Z], [tip.x, tip.y, Z]];
    }
    if (tool === 'rectangle') {
      return [
        [anchor.x, anchor.y, Z], [tip.x, anchor.y, Z],
        [tip.x, tip.y, Z], [anchor.x, tip.y, Z],
        [anchor.x, anchor.y, Z],
      ];
    }
    if (tool === 'circle') {
      const r = Math.hypot(tip.x - anchor.x, tip.y - anchor.y);
      return arcRing(anchor.x, anchor.y, r, 0, TWO_PI);
    }
    if (tool === 'polygon') {
      return drawable(polygonPreview(anchor.x, anchor.y, tip.x, tip.y, polygonSides)
        .map(([px, py]) => [px, py, Z]));
    }
    if (tool === 'slot') {
      // Click 1 done (one end of the axis): show the axis to the cursor. Click 2
      // done: show the whole slot, its radius following the cursor off the axis.
      if (!arcStart) return [[anchor.x, anchor.y, Z], [tip.x, tip.y, Z]];
      const r = axisDistance(tip.x, tip.y, anchor, arcStart);
      return drawable(slotPreview(anchor.x, anchor.y, arcStart.x, arcStart.y, r)
        .map(([px, py]) => [px, py, Z]));
    }
    if (tool === 'arc') {
      // Click 1 done (centre = anchor): show the radius as a spoke to the cursor.
      // Click 2 done (start = arcStart): show the arc swept CCW to the cursor.
      if (!arcStart) return [[anchor.x, anchor.y, Z], [tip.x, tip.y, Z]];
      const r = Math.hypot(arcStart.x - anchor.x, arcStart.y - anchor.y);
      const a0 = Math.atan2(arcStart.y - anchor.y, arcStart.x - anchor.x);
      const a1 = Math.atan2(tip.y - anchor.y, tip.x - anchor.x);
      return arcRing(anchor.x, anchor.y, r, a0, a1);
    }
    return null;
  }, [anchor, arcStart, tip, tool, polygonSides]);

  // The whole layer is drawn in sketch coordinates and then placed by the active
  // sketch's plane, so nothing below this line had to learn about planes: local
  // (x, y, 0) lands wherever the plane puts it. `matrixAutoUpdate={false}` is
  // required — three.js would otherwise recompose the matrix from the group's
  // (untouched) position/rotation/scale on the next frame and wipe it out.
  const planeMat = useMemo(() => {
    const entry = sketches.find((s) => s.id === activeId) || sketches[0];
    return new THREE.Matrix4().fromArray(planeMatrix(entry?.plane));
  }, [sketches, activeId]);

  return (
    <group matrix={planeMat} matrixAutoUpdate={false}>
      <DimensionAnnotations sk={sk} version={version} />

      {/* Pick plane. In draw mode it takes pointer-downs immediately and tracks
          moves for the rubber-band. In pick mode a tap routes through `clickAt`'s
          tolerant hit-tests (point → line → circle within SNAP) instead of the
          razor-thin line ray; in the Select tool a *drag* on empty space is a
          marquee (`Viewport` turns OrbitControls' left-drag rotate off while
          Select is active so the drag is ours). */}
      {(drawing || picking) && (
        <mesh
          onPointerDown={(e) => {
            if (drawing) {
              e.stopPropagation();
              const p = localPoint(e);
              clickAt(p.x, p.y);
              return;
            }
            // Arm a marquee. No stopPropagation: a bare press must still reach
            // `onClick` for a tap-select.
            if (tool === 'select') {
              const p = localPoint(e);
              beginBoxSelect(p.x, p.y);
            }
          }}
          onPointerMove={(e) => {
            const p = localPoint(e);
            // A drag in progress steers the pinned point; check the store live so
            // we never miss a move to a stale render.
            if (useSketchStore.getState().dragging) { dragTo(p.x, p.y); return; }
            // A marquee in progress grows to the cursor and owns the drag.
            if (useSketchStore.getState()._boxStart != null) {
              e.stopPropagation();
              updateBoxSelect(p.x, p.y);
              return;
            }
            if (drawing) {
              e.stopPropagation();
              hover(p.x, p.y);
            } else if (picking) {
              hover(p.x, p.y);
            }
          }}
          onPointerLeave={() => clearHover()}
          onClick={(e) => {
            if (!picking) return;
            e.stopPropagation();
            if (swallowClick.current) { swallowClick.current = false; return; }
            const p = localPoint(e);
            clickAt(p.x, p.y);
          }}
        >
          {/* Large enough that clicks still land on the plane when zoomed far out. */}
          <planeGeometry args={[200000, 200000]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {preview && (
        <Line points={preview} color={PREVIEW} lineWidth={1.5} dashed dashSize={0.8} gapSize={0.5} raycast={noRaycast} />
      )}

      {/* Marquee: solid cyan for a left→right (enclose) drag, dashed green for a
          right→left (crossing) drag — the SolidWorks convention. */}
      {boxSelect && (() => {
        const cross = boxSelect.x1 < boxSelect.x0;
        return (
          <Line
            points={[
              [boxSelect.x0, boxSelect.y0, Z],
              [boxSelect.x1, boxSelect.y0, Z],
              [boxSelect.x1, boxSelect.y1, Z],
              [boxSelect.x0, boxSelect.y1, Z],
              [boxSelect.x0, boxSelect.y0, Z],
            ]}
            color={cross ? TANGENT_COLOR : AXIS_COLOR}
            lineWidth={1}
            dashed={cross}
            dashSize={1.2}
            gapSize={0.8}
            transparent
            opacity={0.9}
            raycast={noRaycast}
          />
        );
      })()}

      {/* Angle guide: a cyan axis through the anchor along an inference
          direction — a standard 0/45/90/…° axis, or parallel / perpendicular to
          an existing line. Faint when it is only a *hint*; when the cursor is
          on it (`locked`) it firms up, the reference line is highlighted and a
          ∥ / ⊥ glyph shows, SolidWorks-style. */}
      {tool === 'line' && anchor && axisSnap && (() => {
        const a = axisSnap.deg * (Math.PI / 180);
        const L = Math.max(Math.hypot(tip.x - anchor.x, tip.y - anchor.y) * 1.5, 12);
        const on = !!axisSnap.locked;
        const ref = on && axisSnap.ref != null ? sk.entities.get(axisSnap.ref) : null;
        const ra = ref && sk.entities.get(ref.p1);
        const rb = ref && sk.entities.get(ref.p2);
        const glyph = on
          ? (axisSnap.kind === 'parallel' ? '∥' : axisSnap.kind === 'perpendicular' ? '⊥' : null)
          : null;
        return (
          <>
            <Line
              points={[
                [anchor.x - Math.cos(a) * L, anchor.y - Math.sin(a) * L, Z],
                [anchor.x + Math.cos(a) * L, anchor.y + Math.sin(a) * L, Z],
              ]}
              color={AXIS_COLOR}
              lineWidth={1}
              dashed
              dashSize={1.2}
              gapSize={0.8}
              transparent
              opacity={on ? 0.7 : 0.28}
              raycast={noRaycast}
            />
            {ra && rb && (
              <Line
                points={[[ra.x, ra.y, Z], [rb.x, rb.y, Z]]}
                color={AXIS_COLOR}
                lineWidth={2.5}
                transparent
                opacity={0.6}
                raycast={noRaycast}
              />
            )}
            {glyph && (
              <Html position={[anchor.x, anchor.y, Z]} zIndexRange={[3, 0]}>
                <div style={{
                  color: CAD.surface, background: AXIS_COLOR, borderRadius: 4,
                  font: '600 11px monospace', padding: '0 4px', whiteSpace: 'nowrap',
                  userSelect: 'none', pointerEvents: 'none', transform: 'translate(10px, -20px)',
                }}>
                  {glyph}
                </div>
              </Html>
            )}
          </>
        );
      })()}

      {/* Live angle / length readout at the tip while drawing a line. */}
      {tool === 'line' && anchor && tip && lineAngle != null && (
        <Html position={[tip.x, tip.y, Z]} zIndexRange={[3, 0]}>
          <div style={angleReadoutStyle(!!axisSnap?.locked)}>
            {lineAngle.toFixed(1)}° · {Math.hypot(tip.x - anchor.x, tip.y - anchor.y).toFixed(1)} mm
          </div>
        </Html>
      )}

      {/* Snap indicator: a constant-screen-size ring on the point a click will
          snap to. Magenta for a vertex / rim landing; green for a tangent target
          (drawing a line); gold for two curves crossing; violet for a circle
          quadrant; blue for a line midpoint — each with a small tag so it's
          unmistakable. */}
      {(drawing || picking) && snap && (() => {
        const kind = snap.tangent ? 'Tangent'
          : snap.intersection ? 'Intersection'
            : snap.quadrant ? 'Quadrant'
              : snap.midpoint ? 'Midpoint' : null;
        const color = snap.tangent ? TANGENT_COLOR
          : snap.intersection ? INTERSECT_COLOR
            : snap.quadrant ? QUADRANT_COLOR
              : snap.midpoint ? MIDPOINT_COLOR : SNAP_COLOR;
        return (
          <>
            <ScreenRing x={snap.x} y={snap.y} color={color} />
            {kind && (
              <Html position={[snap.x, snap.y, Z]} zIndexRange={[3, 0]}>
                <div style={{
                  color: CAD.surface, background: color, borderRadius: 4,
                  font: '600 10px monospace', padding: '0 4px', whiteSpace: 'nowrap',
                  userSelect: 'none', pointerEvents: 'none', transform: 'translate(10px, 6px)',
                }}>
                  {kind}
                </div>
              </Html>
            )}
          </>
        );
      })()}

      {lines.map((l) => {
        const isBase = l.id === angleBase;
        const isRotate = l.id === angleRotate;
        const isSel = selected.has(l.id);
        const isHover = picking && !isSel && hoverId === l.id;
        // Angle base/rotate colouring wins over the normal selected/hover styling;
        // construction geometry is muted slate and dashed.
        const color = isBase ? ANGLE_BASE : isRotate ? ANGLE_ROTATE
          : isSel ? SELECTED : isHover ? HOVER : l.construction ? CONSTRUCTION : baseGeom;
        return (
          <Line
            key={l.id}
            points={[
              [l.a.x, l.a.y, Z],
              [l.b.x, l.b.y, Z],
            ]}
            color={color}
            lineWidth={isBase || isRotate || isSel ? 4 : isHover ? 3 : l.construction ? 1.5 : 2}
            dashed={l.construction}
            dashSize={l.construction ? 0.9 : undefined}
            gapSize={l.construction ? 0.6 : undefined}
            // Pickable only in select mode, same convention as points below.
            raycast={picking ? undefined : noRaycast}
            onClick={(e) => {
              if (!picking) return;
              e.stopPropagation();
              // Trim cuts the segment at the click point; select toggles the line.
              if (tool === 'trim') { const p = localPoint(e); clickAt(p.x, p.y); }
              else toggleSelect(l.id);
            }}
          />
        );
      })}

      {circles.map((c) => {
        // Outline only — the centre point already renders via the points loop.
        const isSel = selected.has(c.id);
        const isHover = picking && !isSel && hoverId === c.id;
        const ring = arcRing(c.cx, c.cy, c.r, 0, TWO_PI);
        return (
          <Line
            key={c.id}
            points={ring}
            color={isSel ? SELECTED : isHover ? HOVER : c.construction ? CONSTRUCTION : baseGeom}
            lineWidth={isSel ? 4 : isHover ? 3 : c.construction ? 1.5 : 2}
            dashed={c.construction}
            dashSize={c.construction ? 0.9 : undefined}
            gapSize={c.construction ? 0.6 : undefined}
            // Directly pickable when selecting (the pick plane's hitTestCircle is
            // a tolerant fallback); off while trimming/drawing.
            raycast={selecting ? undefined : noRaycast}
            onClick={(e) => {
              if (!selecting) return;
              e.stopPropagation();
              toggleSelect(c.id);
            }}
          />
        );
      })}

      {arcs.map((a) => {
        // Outline only (endpoints/centre render via the points loop). Directly
        // pickable when selecting; the pick plane's hitTestArc is the fallback.
        const isSel = selected.has(a.id);
        const isHover = picking && !isSel && hoverId === a.id;
        return (
          <Line
            key={a.id}
            points={arcRing(a.cx, a.cy, a.r, a.a0, a.a1)}
            color={isSel ? SELECTED : isHover ? HOVER : a.construction ? CONSTRUCTION : baseGeom}
            lineWidth={isSel ? 4 : isHover ? 3 : a.construction ? 1.5 : 2}
            dashed={a.construction}
            dashSize={a.construction ? 0.9 : undefined}
            gapSize={a.construction ? 0.6 : undefined}
            raycast={selecting ? undefined : noRaycast}
            onClick={(e) => {
              if (!selecting) return;
              e.stopPropagation();
              toggleSelect(a.id);
            }}
          />
        );
      })}

      {points.map((p) => {
        const isSel = selected.has(p.id);
        const isPending = p.id === pending;
        const isHover = selecting && !isSel && hoverId === p.id;
        const onDown = (e) => {
          // Select mode: grab the point for a drag (SW drag-to-modify). The origin
          // and construction "virtual sharp" points aren't draggable — they fall
          // through to a normal select click.
          if (tool !== 'select' || p.construction) return;
          swallowClick.current = false;
          if (beginDrag(p.id)) { e.stopPropagation(); dragId.current = p.id; }
        };
        const onClk = (e) => {
          if (!picking) return;
          e.stopPropagation();
          if (swallowClick.current) { swallowClick.current = false; return; }
          clickAt(p.x, p.y);
        };
        // A construction point (chamfer/fillet virtual sharp) reads as a small dim
        // "×", SW-style — present for dimensioning but visually quiet.
        if (p.construction) {
          const s = 1.1;
          const col = isSel ? SELECTED : isHover ? HOVER : CONSTRUCTION;
          return (
            <group key={p.id}>
              <Line points={[[p.x - s, p.y - s, Z], [p.x + s, p.y + s, Z]]} color={col} lineWidth={1.4} raycast={noRaycast} />
              <Line points={[[p.x - s, p.y + s, Z], [p.x + s, p.y - s, Z]]} color={col} lineWidth={1.4} raycast={noRaycast} />
              <mesh position={[p.x, p.y, Z]} raycast={picking ? undefined : noRaycast} onPointerDown={onDown} onClick={onClk}>
                <sphereGeometry args={[1, 12, 12]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            </group>
          );
        }
        // Origin: fixed green reference point (a touch larger); still selectable
        // so you can dimension/constrain from it. Precedence: pending → selected →
        // hover (amber "lock") → origin → plain vertex.
        const color = isPending ? CAD.skPreview : isSel ? SELECTED : isHover ? HOVER : p.origin ? CAD.feed : CAD.text;
        const pixels = p.origin || isSel || isPending || isHover ? VERTEX_PX_EMPH : VERTEX_PX;
        return (
          <Vertex
            key={p.id}
            x={p.x}
            y={p.y}
            color={color}
            pixels={pixels}
            pickable={picking}
            onPointerDown={onDown}
            onClick={onClk}
          />
        );
      })}
    </group>
  );
}
