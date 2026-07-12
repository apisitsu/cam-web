/**
 * StockMesh — renders the simulated remaining stock (dexel height field) as a
 * shaded surface. Built from the worker's transferred position/index buffers;
 * normals are computed once for lighting.
 *
 * The buffers are read from the module cache (keyed on the scalar `simVer`)
 * rather than received as props, so React 19's dev Performance Track can't walk
 * the large typed arrays into Performance.measure() (DataCloneError: out of
 * memory).
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { getBuf } from '../engine/bufferCache.js';

export default function StockMesh({ simVer, visible }) {
  const geometry = useMemo(() => {
    const sim = getBuf().sim;
    if (!sim) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(sim.positions, 3));
    // Per-vertex colours (turning) tell machined vs raw stock apart.
    if (sim.colors) g.setAttribute('color', new THREE.BufferAttribute(sim.colors, 3));
    g.setIndex(new THREE.BufferAttribute(sim.indices, 1));
    g.computeVertexNormals();
    return g;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simVer]);

  // Free the previous mesh's buffers when a re-sim replaces the geometry.
  useEffect(() => {
    if (!geometry) return undefined;
    return () => geometry.dispose();
  }, [geometry]);

  if (!geometry || !visible) return null;
  const hasColors = geometry.hasAttribute('color');

  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      {/* Aluminium billet; flatShading reveals the faceted machined surface. When
          the mesh carries per-vertex colours (turning: cut vs raw), use them. */}
      <meshStandardMaterial
        color={hasColors ? '#ffffff' : '#9aa4b2'}
        vertexColors={hasColors}
        metalness={0.35}
        roughness={0.6}
        flatShading
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
