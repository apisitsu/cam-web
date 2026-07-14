/**
 * SketchLayer — renders the live sketch inside the R3F viewport and turns
 * pointer-picks on the Z=0 plane into sketch edits (Phase 2, slice 4).
 *
 * The scene is Z-up with the machine XY plane at Z=0, so sketch (x, y) maps
 * straight to world (x, y, 0) and R3F's `event.point` already gives sketch
 * coordinates — no manual raycasting. All geometry/selection logic lives in the
 * Node-tested store/edit layer; this component is just render + event wiring.
 */
import { useMemo, useEffect } from 'react';
import { Line } from '@react-three/drei';
import { invalidate } from '@react-three/fiber';
import * as THREE from 'three';
import { useSketchStore } from '../stores/sketchStore.js';

const noRaycast = () => null;
const Z = 0.05; // lift a hair above the grid to avoid z-fighting
const PREVIEW = '#f59e0b'; // amber rubber-band while drawing
const SNAP_COLOR = '#f0abfc'; // magenta snap indicator

const TWO_PI = Math.PI * 2;
const norm = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/** Polyline sweeping counter-clockwise from angle a0 to a1 (planegcs arc order). */
function arcRing(cx, cy, r, a0, a1, segs = 48) {
  const span = norm(a1 - a0) || TWO_PI;
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (span * i) / segs;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), Z]);
  }
  return pts;
}

export default function SketchLayer() {
  const version = useSketchStore((s) => s.version);
  const sk = useSketchStore((s) => s.sk);
  const tool = useSketchStore((s) => s.tool);
  const selection = useSketchStore((s) => s.selection);
  const pending = useSketchStore((s) => s.pending);
  const cursor = useSketchStore((s) => s.cursor);
  const snap = useSketchStore((s) => s.snap);
  const pending2 = useSketchStore((s) => s.pending2);
  const clickAt = useSketchStore((s) => s.clickAt);
  const hover = useSketchStore((s) => s.hover);
  const toggleSelect = useSketchStore((s) => s.toggleSelect);
  const cancelPending = useSketchStore((s) => s.cancelPending);
  const deleteSelected = useSketchStore((s) => s.deleteSelected);
  const undo = useSketchStore((s) => s.undo);
  const redo = useSketchStore((s) => s.redo);

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
        if (a && b) lns.push({ id: e.id, a, b });
      } else if (e.type === 'circle') {
        const c = sk.entities.get(e.center);
        if (c) circs.push({ id: e.id, cx: c.x, cy: c.y, r: e.r });
      } else if (e.type === 'arc') {
        const c = sk.entities.get(e.center);
        const s = sk.entities.get(e.start);
        const en = sk.entities.get(e.end);
        if (c && s && en) {
          ars.push({
            id: e.id, cx: c.x, cy: c.y, r: e.r,
            a0: Math.atan2(s.y - c.y, s.x - c.x),
            a1: Math.atan2(en.y - c.y, en.x - c.x),
          });
        }
      }
    }
    return { points: pts, lines: lns, circles: circs, arcs: ars };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sk, version]);

  // Redraw on geometry change and on every pointer move (rubber-band preview).
  useEffect(() => {
    invalidate();
  }, [version, cursor, snap]);

  // Keyboard: Esc cancels a pending draw, Delete removes the selection,
  // Ctrl/Cmd+Z undoes and Ctrl/Cmd+Y (or Shift+Z) redoes. Ignore while typing.
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        cancelPending();
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
  }, [cancelPending, deleteSelected, undo, redo]);

  const drawing = tool === 'point' || tool === 'line' || tool === 'rectangle'
    || tool === 'circle' || tool === 'arc';
  // Geometry is clickable in select/dimension (pick) and trim (cut) modes.
  const picking = tool === 'select' || tool === 'dimension' || tool === 'trim';
  // Circles/arcs are directly selectable (their own raycast) only when picking
  // a selection — not while trimming (trim acts on lines).
  const selecting = tool === 'select' || tool === 'dimension';
  const selected = new Set(selection);

  // The live cursor, snapped to a nearby existing point when there is one — so the
  // rubber-band lands exactly where the click will (getOrCreatePoint snaps too).
  const tip = snap ?? cursor;

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
      return arcRing(anchor.x, anchor.y, r, 0, TWO_PI, 64);
    }
    if (tool === 'arc') {
      // Click 1 done (centre = anchor): show the radius as a spoke to the cursor.
      // Click 2 done (start = arcStart): show the arc swept CCW to the cursor.
      if (!arcStart) return [[anchor.x, anchor.y, Z], [tip.x, tip.y, Z]];
      const r = Math.hypot(arcStart.x - anchor.x, arcStart.y - anchor.y);
      const a0 = Math.atan2(arcStart.y - anchor.y, arcStart.x - anchor.x);
      const a1 = Math.atan2(tip.y - anchor.y, tip.x - anchor.x);
      return arcRing(anchor.x, anchor.y, r, a0, a1, 48);
    }
    return null;
  }, [anchor, arcStart, tip, tool]);

  return (
    <group>
      {/* Pick plane. In draw mode it takes pointer-downs immediately and tracks
          moves for the rubber-band. In pick mode (select/dimension) it handles
          `onClick` only — a tap, not a drag — so OrbitControls still rotates the
          view, while a tap routes through `clickAt`'s tolerant hit-tests
          (point → line → circle within SNAP) instead of the razor-thin line ray. */}
      {(drawing || picking) && (
        <mesh
          onPointerDown={(e) => {
            if (!drawing) return;
            e.stopPropagation();
            clickAt(e.point.x, e.point.y);
          }}
          onPointerMove={(e) => {
            // Track the cursor for the rubber-band (draw) and the snap indicator
            // (both). In pick modes don't stopPropagation, so OrbitControls still
            // rotates the view while snapping shows which point a click will grab.
            if (drawing) {
              e.stopPropagation();
              hover(e.point.x, e.point.y);
            } else if (picking) {
              hover(e.point.x, e.point.y);
            }
          }}
          onClick={(e) => {
            if (!picking) return;
            e.stopPropagation();
            clickAt(e.point.x, e.point.y);
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

      {/* Snap indicator: a magenta ring on the existing point the cursor will
          snap to — while drawing (connect to a shared corner) and while picking
          (lock onto the point a click will select). */}
      {(drawing || picking) && snap && (
        <Line
          points={arcRing(snap.x, snap.y, 1.6, 0, TWO_PI, 24)}
          color={SNAP_COLOR}
          lineWidth={1.5}
          raycast={noRaycast}
        />
      )}

      {lines.map((l) => {
        const isSel = selected.has(l.id);
        return (
          <Line
            key={l.id}
            points={[
              [l.a.x, l.a.y, Z],
              [l.b.x, l.b.y, Z],
            ]}
            color={isSel ? '#f43f5e' : '#38bdf8'}
            lineWidth={isSel ? 4 : 2}
            // Pickable only in select mode, same convention as points below.
            raycast={picking ? undefined : noRaycast}
            onClick={(e) => {
              if (!picking) return;
              e.stopPropagation();
              // Trim cuts the segment at the click point; select toggles the line.
              if (tool === 'trim') clickAt(e.point.x, e.point.y);
              else toggleSelect(l.id);
            }}
          />
        );
      })}

      {circles.map((c) => {
        // Outline only — the centre point already renders via the points loop.
        const isSel = selected.has(c.id);
        const segs = 64;
        const ring = [];
        for (let i = 0; i <= segs; i++) {
          const a = (i / segs) * Math.PI * 2;
          ring.push([c.cx + c.r * Math.cos(a), c.cy + c.r * Math.sin(a), Z]);
        }
        return (
          <Line
            key={c.id}
            points={ring}
            color={isSel ? '#f43f5e' : '#38bdf8'}
            lineWidth={isSel ? 4 : 2}
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
        return (
          <Line
            key={a.id}
            points={arcRing(a.cx, a.cy, a.r, a.a0, a.a1, 64)}
            color={isSel ? '#f43f5e' : '#38bdf8'}
            lineWidth={isSel ? 4 : 2}
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
        // Origin: fixed green reference point (a touch larger); still selectable
        // so you can dimension/constrain from it. Selection tint wins over green.
        const color = isPending ? '#f59e0b' : isSel ? '#f43f5e' : p.origin ? '#22c55e' : '#e2e8f0';
        const radius = p.origin ? 1.3 : isSel || isPending ? 1.2 : 0.8;
        return (
          <mesh
            key={p.id}
            position={[p.x, p.y, Z]}
            raycast={picking ? undefined : noRaycast}
            onClick={(e) => {
              if (!picking) return;
              e.stopPropagation();
              clickAt(p.x, p.y);
            }}
          >
            <sphereGeometry args={[radius, 16, 16]} />
            <meshBasicMaterial color={color} />
          </mesh>
        );
      })}
    </group>
  );
}
