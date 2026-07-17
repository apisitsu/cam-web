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
import { invalidate, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useSketchStore } from '../stores/sketchStore.js';

const noRaycast = () => null;
const Z = 0.05; // lift a hair above the Z=0 pick plane to avoid z-fighting
const PREVIEW = '#f59e0b'; // amber rubber-band while drawing
const SNAP_COLOR = '#f0abfc'; // magenta snap indicator (vertex / rim)
const TANGENT_COLOR = '#34d399'; // green — tangent snap indicator
const AXIS_COLOR = '#22d3ee'; // cyan — angle-lock guide axis

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
const HOVER = '#fbbf24'; // amber pre-select highlight (the entity a click will pick)
const SELECTED = '#f43f5e'; // red selected highlight
const GEOM = '#38bdf8'; // default geometry colour
const ANGLE_BASE = '#22d3ee'; // cyan — the fixed reference line of an angle dimension
const ANGLE_ROTATE = '#f59e0b'; // amber — the line the angle rotates

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

const DIM_COLOR = '#facc15'; // yellow — placed dimensions (witness/dimension lines)
/** Trim a value to at most 2 decimals, dropping trailing zeros. */
const fmtDim = (v) => String(Math.round(v * 100) / 100);
const dimLabelStyle = {
  color: '#fde68a', background: 'rgba(15,23,42,0.85)', border: '1px solid #a16207',
  borderRadius: 4, font: '600 11px monospace', padding: '0 4px',
  whiteSpace: 'nowrap', userSelect: 'none', pointerEvents: 'none',
};

/** Live angle/length readout shown at the line rubber-band's tip while drawing. */
const angleReadoutStyle = (locked) => ({
  color: locked ? '#0f172a' : '#e2e8f0',
  background: locked ? AXIS_COLOR : 'rgba(15,23,42,0.9)',
  border: `1px solid ${locked ? AXIS_COLOR : '#475569'}`,
  borderRadius: 4, font: '600 11px monospace', padding: '1px 5px',
  whiteSpace: 'nowrap', userSelect: 'none', pointerEvents: 'none',
  transform: 'translate(12px, -18px)',
});

/**
 * On-canvas annotations for every *dimensional* constraint (one carrying a value)
 * so it's visible which lines / distances are already sized:
 *   - distance          → parallel dimension line + witness lines + value;
 *   - pointLineDistance → the perpendicular dimension line (point → foot on the
 *     line), which is what a 2-line/parallel gap, point↔line and line↔centre use;
 *   - angle             → an arc swept between the two legs + the degree value;
 *   - radius / lockX / lockY → a value tag on the geometry.
 * Non-dimensional constraints (horizontal, coincident, …) are not drawn here —
 * they remove DOF but aren't "sizes". Purely visual: labels use
 * `pointerEvents:none` and the lines opt out of raycasting, so picking is
 * unaffected.
 */
function DimensionAnnotations({ sk, version }) {
  const { segs, labels } = useMemo(() => {
    const P = (id) => sk.entities.get(id);
    const ls = [];
    const bs = [];
    let k = 0;
    sk.constraints.forEach((c) => {
      if (c.value == null) return;
      if (c.kind === 'distance') {
        const a = P(c.refs[0]);
        const b = P(c.refs[1]);
        if (!a || !b) return;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len;
        const py = dx / len;
        const off = Math.max(len * 0.14, 4); // stand the dimension line off the geometry
        const a2 = [a.x + px * off, a.y + py * off, Z];
        const b2 = [b.x + px * off, b.y + py * off, Z];
        ls.push({ key: `s${k++}`, pts: [[a.x, a.y, Z], a2] }); // witness lines
        ls.push({ key: `s${k++}`, pts: [[b.x, b.y, Z], b2] });
        ls.push({ key: `s${k++}`, pts: [a2, b2] }); // dimension line
        bs.push({ key: `b${k++}`, pos: [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2, Z], text: fmtDim(c.value) });
      } else if (c.kind === 'pointLineDistance') {
        // Perpendicular distance from a point to a line — this is what a 2-line
        // (parallel) dimension, a point↔line, and a line↔circle-centre resolve to.
        // Draw the dimension line as the actual perpendicular (point → its foot on
        // the line), extending a witness along the line when the foot lands past
        // the drawn segment (the common parallel-gap case).
        const p = P(c.refs[0]);
        const l = P(c.refs[1]);
        const a = l && P(l.p1);
        const b = l && P(l.p2);
        if (!p || !a || !b) return;
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const len2 = abx * abx + aby * aby || 1;
        const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
        const fx = a.x + abx * t;
        const fy = a.y + aby * t;
        ls.push({ key: `s${k++}`, pts: [[p.x, p.y, Z], [fx, fy, Z]] }); // dimension line
        if (t < 0 || t > 1) {
          const near = t < 0 ? a : b; // witness: extend the line to reach the foot
          ls.push({ key: `s${k++}`, pts: [[near.x, near.y, Z], [fx, fy, Z]] });
        }
        bs.push({ key: `b${k++}`, pos: [(p.x + fx) / 2, (p.y + fy) / 2, Z], text: fmtDim(c.value) });
      } else if (c.kind === 'radius') {
        const circ = P(c.refs[0]);
        const ctr = circ && P(circ.center);
        if (!ctr) return;
        bs.push({ key: `b${k++}`, pos: [ctr.x + circ.r * 0.7, ctr.y + circ.r * 0.7, Z], text: `R${fmtDim(c.value)}` });
      } else if (c.kind === 'angle') {
        // Draw an angle arc between the two legs around their shared vertex, so a
        // 2-line angle dimension reads like a real angle, not a bare number.
        const l1 = P(c.refs[0]);
        const l2 = P(c.refs[1]);
        if (!l1 || !l2) return;
        const sharedId = [l1.p1, l1.p2].find((id) => id === l2.p1 || id === l2.p2);
        const vId = sharedId != null ? sharedId : l1.p1;
        const v = P(vId);
        const f1 = P(l1.p1 === vId ? l1.p2 : l1.p1);
        const f2 = P(l2.p1 === vId ? l2.p2 : l2.p1);
        if (!v || !f1 || !f2) return;
        const a1 = Math.atan2(f1.y - v.y, f1.x - v.x);
        const a2 = Math.atan2(f2.y - v.y, f2.x - v.x);
        const legMin = Math.min(Math.hypot(f1.x - v.x, f1.y - v.y), Math.hypot(f2.x - v.x, f2.y - v.y));
        const r = Math.max(3, Math.min(legMin * 0.4, 14));
        let d = a2 - a1; // sweep the shorter way between the legs
        while (d > Math.PI) d -= TWO_PI;
        while (d < -Math.PI) d += TWO_PI;
        const N = 24;
        const pts = [];
        for (let i = 0; i <= N; i++) {
          const a = a1 + (d * i) / N;
          pts.push([v.x + r * Math.cos(a), v.y + r * Math.sin(a), Z]);
        }
        ls.push({ key: `s${k++}`, pts });
        const mid = a1 + d / 2;
        bs.push({ key: `b${k++}`, pos: [v.x + (r + 2) * Math.cos(mid), v.y + (r + 2) * Math.sin(mid), Z], text: `${fmtDim((c.value * 180) / Math.PI)}°` });
      } else if (c.kind === 'lockX' || c.kind === 'lockY') {
        const p = P(c.refs[0]);
        if (!p) return;
        const dyOff = c.kind === 'lockY' ? 2 : -2;
        bs.push({ key: `b${k++}`, pos: [p.x + 1.6, p.y + dyOff, Z], text: `${c.kind === 'lockX' ? 'X' : 'Y'}${fmtDim(c.value)}` });
      }
    });
    return { segs: ls, labels: bs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sk, version]);

  return (
    <group>
      {segs.map((s) => (
        <Line key={s.key} points={s.pts} color={DIM_COLOR} lineWidth={1} dashed dashSize={0.6} gapSize={0.4} transparent opacity={0.85} raycast={noRaycast} />
      ))}
      {labels.map((b) => (
        <Html key={b.key} position={b.pos} center zIndexRange={[2, 0]}>
          <div style={dimLabelStyle}>{b.text}</div>
        </Html>
      ))}
    </group>
  );
}

export default function SketchLayer() {
  const version = useSketchStore((s) => s.version);
  const sk = useSketchStore((s) => s.sk);
  const tool = useSketchStore((s) => s.tool);
  const selection = useSketchStore((s) => s.selection);
  const pending = useSketchStore((s) => s.pending);
  const cursor = useSketchStore((s) => s.cursor);
  const snap = useSketchStore((s) => s.snap);
  const axisSnap = useSketchStore((s) => s.axisSnap);
  const lineAngle = useSketchStore((s) => s.lineAngle);
  const pending2 = useSketchStore((s) => s.pending2);
  const hoverId = useSketchStore((s) => s.hoverId);
  const dimensionPending = useSketchStore((s) => s.dimensionPending);
  const clickAt = useSketchStore((s) => s.clickAt);
  const hover = useSketchStore((s) => s.hover);
  const clearHover = useSketchStore((s) => s.clearHover);
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

  // Redraw on geometry change and on every pointer move (rubber-band + hover).
  useEffect(() => {
    invalidate();
  }, [version, cursor, snap, axisSnap, lineAngle, hoverId]);

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
  // Geometry is clickable in select/dimension (pick), trim (cut) and chamfer
  // (pick two lines) modes.
  const picking = tool === 'select' || tool === 'dimension' || tool === 'trim' || tool === 'chamfer';
  // Circles/arcs are directly selectable (their own raycast) only when picking a
  // selection — not while trimming/chamfering (both act on lines).
  const selecting = tool === 'select' || tool === 'dimension';
  const selected = new Set(selection);
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
      <DimensionAnnotations sk={sk} version={version} />

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
          onPointerLeave={() => clearHover()}
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

      {/* Angle-lock guide: a cyan axis through the anchor along the locked
          standard direction, so it's obvious the line snapped to 0/45/90/…°. */}
      {tool === 'line' && anchor && axisSnap && (() => {
        const a = axisSnap.deg * (Math.PI / 180);
        const L = Math.max(Math.hypot(tip.x - anchor.x, tip.y - anchor.y) * 1.5, 12);
        return (
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
            opacity={0.7}
            raycast={noRaycast}
          />
        );
      })()}

      {/* Live angle / length readout at the tip while drawing a line. */}
      {tool === 'line' && anchor && tip && lineAngle != null && (
        <Html position={[tip.x, tip.y, Z]} zIndexRange={[3, 0]}>
          <div style={angleReadoutStyle(!!axisSnap)}>
            {lineAngle.toFixed(1)}° · {Math.hypot(tip.x - anchor.x, tip.y - anchor.y).toFixed(1)} mm
          </div>
        </Html>
      )}

      {/* Snap indicator: a constant-screen-size ring on the point a click will
          snap to. Magenta for a vertex / rim landing; green for a tangent target
          (drawing a line), with a small "Tangent" tag so it's unmistakable. */}
      {(drawing || picking) && snap && (
        <>
          <ScreenRing x={snap.x} y={snap.y} color={snap.tangent ? TANGENT_COLOR : SNAP_COLOR} />
          {snap.tangent && (
            <Html position={[snap.x, snap.y, Z]} zIndexRange={[3, 0]}>
              <div style={{
                color: '#0f172a', background: TANGENT_COLOR, borderRadius: 4,
                font: '600 10px monospace', padding: '0 4px', whiteSpace: 'nowrap',
                userSelect: 'none', pointerEvents: 'none', transform: 'translate(10px, 6px)',
              }}>
                Tangent
              </div>
            </Html>
          )}
        </>
      )}

      {lines.map((l) => {
        const isBase = l.id === angleBase;
        const isRotate = l.id === angleRotate;
        const isSel = selected.has(l.id);
        const isHover = picking && !isSel && hoverId === l.id;
        // Angle base/rotate colouring wins over the normal selected/hover styling.
        const color = isBase ? ANGLE_BASE : isRotate ? ANGLE_ROTATE
          : isSel ? SELECTED : isHover ? HOVER : GEOM;
        return (
          <Line
            key={l.id}
            points={[
              [l.a.x, l.a.y, Z],
              [l.b.x, l.b.y, Z],
            ]}
            color={color}
            lineWidth={isBase || isRotate || isSel ? 4 : isHover ? 3 : 2}
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
        const isHover = picking && !isSel && hoverId === c.id;
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
            color={isSel ? SELECTED : isHover ? HOVER : GEOM}
            lineWidth={isSel ? 4 : isHover ? 3 : 2}
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
            points={arcRing(a.cx, a.cy, a.r, a.a0, a.a1, 64)}
            color={isSel ? SELECTED : isHover ? HOVER : GEOM}
            lineWidth={isSel ? 4 : isHover ? 3 : 2}
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
        // Origin: fixed green reference point (a touch larger); still selectable
        // so you can dimension/constrain from it. Precedence: pending → selected →
        // hover (amber "lock") → origin → plain vertex.
        const color = isPending ? '#f59e0b' : isSel ? SELECTED : isHover ? HOVER : p.origin ? '#22c55e' : '#e2e8f0';
        const radius = p.origin ? 1.3 : isSel || isPending || isHover ? 1.3 : 0.8;
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
