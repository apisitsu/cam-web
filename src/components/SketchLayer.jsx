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

export default function SketchLayer() {
  const version = useSketchStore((s) => s.version);
  const sk = useSketchStore((s) => s.sk);
  const tool = useSketchStore((s) => s.tool);
  const selection = useSketchStore((s) => s.selection);
  const pending = useSketchStore((s) => s.pending);
  const cursor = useSketchStore((s) => s.cursor);
  const clickAt = useSketchStore((s) => s.clickAt);
  const hover = useSketchStore((s) => s.hover);
  const toggleSelect = useSketchStore((s) => s.toggleSelect);
  const cancelPending = useSketchStore((s) => s.cancelPending);
  const deleteSelected = useSketchStore((s) => s.deleteSelected);
  const undo = useSketchStore((s) => s.undo);
  const redo = useSketchStore((s) => s.redo);

  const { points, lines, circles } = useMemo(() => {
    const pts = [];
    const lns = [];
    const circs = [];
    for (const e of sk.entities.values()) if (e.type === 'point') pts.push(e);
    for (const e of sk.entities.values()) {
      if (e.type === 'line') {
        const a = sk.entities.get(e.p1);
        const b = sk.entities.get(e.p2);
        if (a && b) lns.push({ id: e.id, a, b });
      } else if (e.type === 'circle') {
        const c = sk.entities.get(e.center);
        if (c) circs.push({ id: e.id, cx: c.x, cy: c.y, r: e.r });
      }
    }
    return { points: pts, lines: lns, circles: circs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sk, version]);

  // Redraw on geometry change and on every pointer move (rubber-band preview).
  useEffect(() => {
    invalidate();
  }, [version, cursor]);

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

  const drawing = tool === 'point' || tool === 'line' || tool === 'rectangle' || tool === 'circle';
  const picking = tool === 'select' || tool === 'dimension'; // geometry is clickable
  const selected = new Set(selection);

  // Rubber-band preview from the pending corner/centre to the live cursor.
  const anchor = pending != null ? sk.entities.get(pending) : null;
  const preview = useMemo(() => {
    if (!anchor || !cursor) return null;
    if (tool === 'line') {
      return [[anchor.x, anchor.y, Z], [cursor.x, cursor.y, Z]];
    }
    if (tool === 'rectangle') {
      return [
        [anchor.x, anchor.y, Z], [cursor.x, anchor.y, Z],
        [cursor.x, cursor.y, Z], [anchor.x, cursor.y, Z],
        [anchor.x, anchor.y, Z],
      ];
    }
    if (tool === 'circle') {
      const r = Math.hypot(cursor.x - anchor.x, cursor.y - anchor.y);
      const segs = 64;
      const ring = [];
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        ring.push([anchor.x + r * Math.cos(a), anchor.y + r * Math.sin(a), Z]);
      }
      return ring;
    }
    return null;
  }, [anchor, cursor, tool]);

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
            if (!drawing) return;
            e.stopPropagation();
            hover(e.point.x, e.point.y);
          }}
          onClick={(e) => {
            if (!picking) return;
            e.stopPropagation();
            clickAt(e.point.x, e.point.y);
          }}
        >
          <planeGeometry args={[4000, 4000]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {preview && (
        <Line points={preview} color={PREVIEW} lineWidth={1.5} dashed dashSize={0.8} gapSize={0.5} raycast={noRaycast} />
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
              toggleSelect(l.id);
            }}
          />
        );
      })}

      {circles.map((c) => {
        // Outline only — the centre point already renders via the points loop.
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
            color="#38bdf8"
            lineWidth={2}
            raycast={noRaycast}
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
