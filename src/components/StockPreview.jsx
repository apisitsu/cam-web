/**
 * The blank, drawn live — before a single move has been carved out of it.
 *
 * Sizing stock used to be typing numbers into a form and pressing Simulate to
 * find out what they meant. That is a slow loop for a fast question ("is my
 * 50 × 50 billet big enough, and is it sitting where I think?"), and it is
 * slow for no reason: an *uncut* billet is a box. There is nothing to carve,
 * no worker to wake, no height field to triangulate — six numbers and a
 * `boxGeometry`. So this updates on the keystroke, and Simulate goes back to
 * meaning only what it should: run the program through the material.
 *
 * Drawn as a translucent solid with its edges picked out, because the two jobs
 * it has are different: the faces show where the block sits against the
 * toolpath, and the wireframe shows exactly where its corners are even when the
 * backplot runs through the middle of it.
 *
 * `solid` is `{center, size}` straight from `engine/sim/billet.js` — this
 * component computes nothing, which is what keeps the geometry testable
 * without a canvas.
 */
import { useMemo, useEffect } from 'react';
import * as THREE from 'three';

export default function StockPreview({ solid, visible = true }) {
  const geometry = useMemo(
    () => (solid ? new THREE.BoxGeometry(...solid.size) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [solid?.size?.[0], solid?.size?.[1], solid?.size?.[2]],
  );
  const edges = useMemo(
    () => (geometry ? new THREE.EdgesGeometry(geometry) : null),
    [geometry],
  );

  useEffect(() => () => {
    geometry?.dispose();
    edges?.dispose();
  }, [geometry, edges]);

  if (!solid || !geometry || !visible) return null;

  return (
    // Named so the scene-graph tests can find it without guessing at materials.
    <group name="stock-preview" position={solid.center}>
      <mesh name="stock-preview-solid" geometry={geometry}>
        {/* Faint, and never writing depth: the whole point is to see the
            toolpath and the part *through* the material it will be cut from.
            A preview that hides what it is measured against is no use. */}
        <meshStandardMaterial
          color="#94a3b8"
          transparent
          opacity={0.16}
          depthWrite={false}
          side={THREE.DoubleSide}
          metalness={0.1}
          roughness={0.9}
        />
      </mesh>
      <lineSegments name="stock-preview-edges" geometry={edges}>
        <lineBasicMaterial color="#7dd3fc" transparent opacity={0.75} />
      </lineSegments>
    </group>
  );
}
