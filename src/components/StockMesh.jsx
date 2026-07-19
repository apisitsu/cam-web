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
    // The turning sim ships exact normals for its solid of revolution; the
    // voxel/dexel meshes don't, so those are averaged from the faces here.
    if (sim.normals) g.setAttribute('normal', new THREE.BufferAttribute(sim.normals, 3));
    else g.computeVertexNormals();
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
  // Turned parts arrive with exact normals and must shade smoothly — a solid of
  // revolution is genuinely round, and flat shading made it read as stepped.
  // Milled stock keeps flat shading, where the facets *are* the machined marks.
  const smooth = !!getBuf().sim?.normals;

  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      {/* Aluminium billet; per-vertex colours (turning: cut vs raw) when present. */}
      <meshStandardMaterial
        color={hasColors ? '#ffffff' : '#9aa4b2'}
        vertexColors={hasColors}
        metalness={0.35}
        roughness={0.6}
        flatShading={!smooth}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
