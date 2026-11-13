/**
 * SketchStage — what the Sketch page's scene holds besides the part.
 *
 * With a sketch open, the sketcher. With none open, the three reference planes:
 * clicking one starts a sketch on it, or, with Measure on, measures to it. A
 * sketch that a feature was built from is not drawn once closed; it is part of
 * the solid now. One closed before any
 * feature used it stays visible, read-only, since it can still be built.
 */
import { useMemo, useState } from 'react';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import SketchLayer from './SketchLayer.jsx';
import { useSketchStore } from '../stores/sketchStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { useEdgeTreatStore } from '../stores/edgeTreatStore.js';
import { useMeasureStore } from '../stores/measureStore.js';
import { planeClickPick } from '../engine/mesh/measure.js';
import { getRawMesh } from '../stores/camPlanStore.js';
import { boundsOf } from '../engine/mesh/analyze.js';
import { PLANE_PRESETS, planeMatrix } from '../engine/sketch/plane.js';
import { CAD } from '../theme.js';

const MIN_HALF = 30; // mm — the planes' half-width with no part to size them from
/** px the pointer may travel and still be a click rather than an orbit drag. */
export const CLICK_SLOP = 4;

const overPart = (event) => event.intersections.some((i) => i.object.name === 'built-part');

function ReferencePlane({ preset, label, half }) {
  const [pointerOver, setHover] = useState(false);
  // Lit when the pointer is on the plane itself or on its button in the sketch rail.
  const hover = useSketchStore((s) => s.hoverPlane === preset) || pointerOver;
  const matrix = useMemo(() => new THREE.Matrix4().fromArray(planeMatrix({ preset, offset: 0 })), [preset]);
  const corners = [[-half, -half, 0], [half, -half, 0], [half, half, 0], [-half, half, 0], [-half, -half, 0]];

  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      {/* Not stopped: the part behind a plane still gets the event, and wins. */}
      <mesh
        name={`plane-${preset}`}
        onPointerMove={(e) => setHover(!overPart(e))}
        onPointerOut={() => setHover(false)}
        onClick={(e) => {
          if (e.delta > CLICK_SLOP || overPart(e)) return;
          e.stopPropagation();
          // With Measure on, a plane is one of the things it measures.
          if (useMeasureStore.getState().active) useMeasureStore.getState().add(planeClickPick(getRawMesh().welded, preset, e.point.toArray()));
          else useFeatureStore.getState().startSketch({ preset, offset: 0 });
        }}
      >
        <planeGeometry args={[half * 2, half * 2]} />
        {/* Pushed back in depth: a face of the part lying on this plane (the
            bottom of a part drawn on Top, its front on Front) must win, not
            flicker in triangles with the plane's tint. */}
        <meshBasicMaterial
          color={CAD.accent}
          transparent
          opacity={hover ? 0.3 : 0.07}
          depthWrite={false}
          side={THREE.DoubleSide}
          polygonOffset
          polygonOffsetFactor={2}
          polygonOffsetUnits={2}
        />
      </mesh>
      <Line points={corners} color={CAD.accent} lineWidth={hover ? 2 : 1} transparent opacity={0.6} />
      <Html position={[-half, half, 0]} zIndexRange={[2, 0]}>
        <div style={{
          color: CAD.accent, fontSize: 11, whiteSpace: 'nowrap', userSelect: 'none', pointerEvents: 'none',
        }}
        >
          {label}
        </div>
      </Html>
    </group>
  );
}

export default function SketchStage({ meshVer }) {
  const sketchOpen = useSketchStore((s) => s.sketchOpen);
  const measuring = useMeasureStore((s) => s.active);
  // Picking edges for a Chamfer or Fillet: a click on empty space must not start a sketch.
  const treating = useEdgeTreatStore((s) => Boolean(s.active));
  const activeId = useSketchStore((s) => s.activeId);
  const built = useFeatureStore((s) => s.features.some((f) => f.sketchId === activeId));
  const half = useMemo(() => {
    const { soup } = getRawMesh();
    if (!soup?.triangleCount) return MIN_HALF;
    const { min, max } = boundsOf(soup);
    return Math.max(MIN_HALF, ...min.map(Math.abs), ...max.map(Math.abs)) * 1.2;
  }, [meshVer]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {(sketchOpen || !built) && <SketchLayer />}
      {(!sketchOpen || measuring) && !treating && Object.entries(PLANE_PRESETS).map(([preset, p]) => (
        <ReferencePlane key={preset} preset={preset} label={p.label} half={half} />
      ))}
    </>
  );
}
