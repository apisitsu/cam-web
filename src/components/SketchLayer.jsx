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

export default function SketchLayer() {
  const version = useSketchStore((s) => s.version);
  const sk = useSketchStore((s) => s.sk);
  const tool = useSketchStore((s) => s.tool);
  const selection = useSketchStore((s) => s.selection);
  const pending = useSketchStore((s) => s.pending);
  const clickAt = useSketchStore((s) => s.clickAt);

  const { points, lines } = useMemo(() => {
    const pts = [];
    const lns = [];
    for (const e of sk.entities.values()) if (e.type === 'point') pts.push(e);
    for (const e of sk.entities.values()) {
      if (e.type === 'line') {
        const a = sk.entities.get(e.p1);
        const b = sk.entities.get(e.p2);
        if (a && b) lns.push({ id: e.id, a, b });
      }
    }
    return { points: pts, lines: lns };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sk, version]);

  useEffect(() => {
    invalidate();
  }, [version]);

  const drawing = tool === 'point' || tool === 'line';
  const selected = new Set(selection);

  return (
    <group>
      {/* Pick plane — only while a draw tool is active, so OrbitControls keeps
          the viewport interactive in select mode. */}
      {drawing && (
        <mesh
          onPointerDown={(e) => {
            e.stopPropagation();
            clickAt(e.point.x, e.point.y);
          }}
        >
          <planeGeometry args={[4000, 4000]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {lines.map((l) => (
        <Line
          key={l.id}
          points={[
            [l.a.x, l.a.y, Z],
            [l.b.x, l.b.y, Z],
          ]}
          color="#38bdf8"
          lineWidth={2}
          raycast={noRaycast}
        />
      ))}

      {points.map((p) => {
        const isSel = selected.has(p.id);
        const isPending = p.id === pending;
        return (
          <mesh
            key={p.id}
            position={[p.x, p.y, Z]}
            raycast={tool === 'select' ? undefined : noRaycast}
            onClick={(e) => {
              if (tool !== 'select') return;
              e.stopPropagation();
              clickAt(p.x, p.y);
            }}
          >
            <sphereGeometry args={[isSel || isPending ? 1.2 : 0.8, 16, 16]} />
            <meshBasicMaterial color={isPending ? '#f59e0b' : isSel ? '#f43f5e' : '#e2e8f0'} />
          </mesh>
        );
      })}
    </group>
  );
}
