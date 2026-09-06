/**
 * Backplot — renders the parsed toolpath as coloured line segments.
 *
 * Rapids (G0) are drawn dashed/red, cutting feeds (G1/G2/G3) solid/green,
 * matching the CNC-verification mental model in cam_web.txt. Geometry is built
 * directly from the transferred Float32Arrays — one draw call each.
 *
 * The position buffers are read from the module view-cache (keyed on the scalar
 * `drawVer` token) rather than received as props: React 19's dev Performance
 * Track walks changed props element-by-element and Performance.measure() then
 * structured-clones them, which throws `DataCloneError: out of memory` for the
 * large typed arrays a toolpath produces.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { getView } from '../engine/bufferCache.js';
import { CAD } from '../theme.js';

function LineSet({ bufKey, drawVer, color, dashed }) {
  const object = useMemo(() => {
    const positions = getView()[bufKey];
    if (!positions || positions.length === 0) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = dashed
      ? new THREE.LineDashedMaterial({
          color,
          dashSize: 1.2,
          gapSize: 0.8,
          transparent: true,
          opacity: 0.9,
        })
      : new THREE.LineBasicMaterial({ color });

    const seg = new THREE.LineSegments(geometry, material);
    if (dashed) seg.computeLineDistances();
    return seg;
  // Rebuilt whenever the drawn buffer changes (parse / playback scrub).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufKey, drawVer, color, dashed]);

  // Playback rebuilds these every tick; free the GPU/CPU resources of the
  // superseded object so the leak doesn't itself exhaust memory over a run.
  useEffect(() => {
    if (!object) return undefined;
    return () => {
      object.geometry.dispose();
      object.material.dispose();
    };
  }, [object]);

  if (!object) return null;
  return <primitive object={object} />;
}

export default function Backplot({ drawVer, visible = true }) {
  return (
    // **Hidden, not unmounted.** Each `LineSet` renders a `<primitive>`, and R3F
    // does not own an object it was handed — taking the component away does not
    // reliably take the object out of the scene, so the lines went on being
    // drawn. Measured: toggling the backplot off changed 0.00% of viewport
    // pixels until some later input forced a repaint, and 9.7% once it did.
    // `visible` is honoured by three at draw time, which cannot go wrong that
    // way, and it keeps the geometry ready for the next toggle instead of
    // rebuilding it.
    <group visible={visible}>
      <LineSet bufKey="feeds" drawVer={drawVer} color={CAD.feed} />
      <LineSet bufKey="rapids" drawVer={drawVer} color={CAD.rapid} dashed />
    </group>
  );
}
