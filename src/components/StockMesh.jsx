/**
 * StockMesh — renders the simulated remaining stock (height field, voxel block
 * or turned solid) as a shaded surface. Built from the worker's transferred
 * position/colour/index buffers; normals are computed once for lighting unless
 * the engine shipped exact ones.
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
    // Per-vertex colours tell machined material from raw stock — all three
    // simulators ship them now, from the one palette in `sim/stockColors.js`.
    // Without them a face the tool has just been through looks exactly like one
    // it has never touched, and "did that pass cut anything?" has no answer.
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
        // White under vertex colours, so the palette comes through unshifted.
        color={hasColors ? '#ffffff' : '#9aa4b2'}
        vertexColors={hasColors}
        // Kept low for the same reason as `theme.js`'s `metal()`: there is no
        // environment map, so metalness costs the billet its own colour.
        metalness={0.2}
        roughness={0.6}
        flatShading={!smooth}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
