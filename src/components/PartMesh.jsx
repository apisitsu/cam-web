/**
 * PartMesh — the imported STL model, drawn in the viewport.
 *
 * Without this an STL could be read, analysed and machined, but never *seen*,
 * which makes every plan impossible to sanity-check: the whole point of showing
 * the model is that a wrong axis or a mis-scaled file is obvious in a glance and
 * invisible in a table of numbers.
 *
 * The geometry is built from the **soup** (three unshared corners per triangle)
 * rather than the welded mesh, so `computeVertexNormals` gives one normal per
 * facet and the part shades flat. That is honest for an STL — the facets really
 * are the model — and welding first would smooth genuine sharp edges into
 * rounded mush.
 *
 * Positions are read from the module-level mesh cache keyed on the scalar
 * `meshVer`, never passed as props, for the same reason `StockMesh` does it:
 * React's dev Performance Track structured-clones changed props and dies on
 * large typed arrays.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { getMesh, useCamPlanStore } from '../stores/camPlanStore.js';
import { faceOfTriangle } from '../engine/mesh/features.js';

/**
 * Geometry for the highlight drawn over a picked face or edge.
 *
 * Built here rather than in the store because it is a three.js object and
 * nothing below the view layer is allowed to hold one. What it is built *from*
 * — the face's triangles, the edge's polyline — is plain data that
 * `engine/mesh/features.js` produced and tested.
 */
function highlightGeometry(feature, soup) {
  if (!feature) return null;

  if (feature.points) {                      // an edge chain
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(feature.points.flat(), 3));
    return { kind: 'line', geometry: g };
  }

  if (feature.triangles && soup) {           // a merged planar face
    const out = new Float32Array(feature.triangles.length * 9);
    feature.triangles.forEach((t, i) => {
      out.set(soup.positions.subarray(t * 9, t * 9 + 9), i * 9);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    g.computeVertexNormals();
    return { kind: 'face', geometry: g };
  }
  return null;
}

export default function PartMesh({ meshVer, visible = true, wireframe = false }) {
  const selectFeature = useCamPlanStore((s) => s.selectFeature);
  const features = useCamPlanStore((s) => s.features);
  const geometry = useMemo(() => {
    const { soup } = getMesh();
    if (!soup || soup.triangleCount === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(soup.positions, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meshVer]);

  useEffect(() => {
    if (!geometry) return undefined;
    return () => geometry.dispose();
  }, [geometry]);

  if (!geometry || !visible) return null;

  /**
   * A click on the model picks the whole face, not the triangle.
   *
   * The raycast reports one triangle out of hundreds; nobody means "that
   * triangle". `faceOfTriangle` maps it back to the merged face, which is the
   * thing the operator was pointing at.
   */
  const onClick = (event) => {
    const detected = features();
    if (!detected?.faces?.length) return;
    event.stopPropagation();
    const face = faceOfTriangle(detected, event.faceIndex);
    selectFeature(face ?? null);
  };

  return (
    // Named so it can be picked out of the scene graph — by a test asking
    // "is the part actually on screen?", and by anyone inspecting the scene.
    <mesh name="imported-part" geometry={geometry} castShadow receiveShadow onClick={onClick}>
      {/* Distinct from the simulated stock's aluminium grey: this is the model
          to be made, not the material it is made from. DoubleSide because an
          inside-out STL is common enough that back faces must still draw —
          `analyzeMesh` warns about the winding rather than leaving a hole. */}
      <meshStandardMaterial
        color="#38bdf8"
        metalness={0.1}
        roughness={0.65}
        transparent
        opacity={0.85}
        wireframe={wireframe}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/**
 * The picked face or edge, drawn over the part.
 *
 * Kept as a sibling of the model rather than a child so it is never affected by
 * the model's transparency — a highlight you can see through the part it is
 * highlighting tells you nothing about which side you are looking at.
 */
export function FeatureHighlight({ meshVer }) {
  // The decision wins over the hover: once a face is picked, moving the mouse
  // across the list must not appear to change what you picked.
  const selected = useCamPlanStore((s) => s.selectedFeature ?? s.previewFeature);
  const highlight = useMemo(
    () => highlightGeometry(selected, getMesh().soup),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, meshVer],
  );

  useEffect(() => {
    if (!highlight) return undefined;
    return () => highlight.geometry.dispose();
  }, [highlight]);

  if (!highlight) return null;

  if (highlight.kind === 'line') {
    return (
      <line name="feature-highlight" geometry={highlight.geometry}>
        <lineBasicMaterial color="#fbbf24" linewidth={2} depthTest={false} />
      </line>
    );
  }
  return (
    <mesh name="feature-highlight" geometry={highlight.geometry}>
      {/* polygonOffset lifts it off the face it covers, or the two planes fight
          for the same depth and the highlight flickers. */}
      <meshBasicMaterial
        color="#fbbf24"
        transparent
        opacity={0.55}
        side={THREE.DoubleSide}
        polygonOffset
        polygonOffsetFactor={-2}
        depthWrite={false}
      />
    </mesh>
  );
}
