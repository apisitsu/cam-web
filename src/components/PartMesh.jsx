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
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { getMesh, useCamPlanStore } from '../stores/camPlanStore.js';
import { faceOfTriangle } from '../engine/mesh/features.js';
import { featureAtPoint } from '../engine/mesh/pickEdge.js';
import { originMarkerSize, rotaryAxisLength } from '../engine/view/originMarker.js';
import { CAD } from '../theme.js';

const ORIGIN_AXES = [
  { dir: [1, 0, 0], color: CAD.rapid },
  { dir: [0, 1, 0], color: CAD.feed },
  { dir: [0, 0, 1], color: CAD.accent },
];

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
  const previewFeatureAt = useCamPlanStore((s) => s.previewFeatureAt);
  const features = useCamPlanStore((s) => s.features);
  // The id currently highlighted, so a pointer move that stays on the same
  // feature costs nothing. A ref, not state: it must not itself re-render.
  const hoverIdRef = useRef(null);
  const datumPickMode = useCamPlanStore((s) => s.datumPickMode);
  const pickAxisOrigin = useCamPlanStore((s) => s.pickAxisOrigin);
  const pickRotaryCenter = useCamPlanStore((s) => s.pickRotaryCenter);
  const pickRotaryZero = useCamPlanStore((s) => s.pickRotaryZero);
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
   * A click on the model picks the whole face, not the triangle — unless the
   * operator is setting one axis of the origin, the rotary centre, or the A0
   * face, in which case the click means something else entirely: not "machine
   * this", but "X0 (or Y0, or Z0) is here", "the A-axis runs through here", or
   * "this face should read as A0". That has to be checked first and
   * unconditionally, because turning has no detected faces at all (`features()`
   * returns none for it) and would otherwise swallow the click below before a
   * lathe part ever got a chance to set its origin.
   *
   * The raycast reports one triangle out of hundreds; nobody means "that
   * triangle". `faceOfTriangle` maps it back to the merged face, which is the
   * thing the operator was pointing at.
   */
  const onClick = (event) => {
    // `event.point` is in WORLD space. That equals the part's own frame only
    // while the `part-work` group wrapping this mesh is unrotated — but in the
    // machine ("Work rotates") frame, which is a 4-axis mill's default, that
    // group is turned by the playhead's A index (`workTransform`). Picking then
    // would store an origin rotated by that angle. `worldToLocal` strips the
    // group transform, landing the pick in the mesh's own (laid-down, datum-
    // shifted) frame — which is exactly what the datum store expects.
    // `event.face.normal` needs no such fix: three.js reports it in geometry
    // space already, unaffected by any ancestor transform.
    const localPoint = () => event.object.worldToLocal(event.point.clone()).toArray();

    // An armed axis pick ('x'/'y'/'z') sets just that axis's zero at the clicked
    // point — no plane, no reorientation, the other two axes left alone.
    const axis = { x: 0, y: 1, z: 2 }[datumPickMode];
    if (axis !== undefined) {
      event.stopPropagation();
      pickAxisOrigin(axis, localPoint());
      return;
    }
    if (datumPickMode === 'rotary') {
      event.stopPropagation();
      pickRotaryCenter(localPoint());
      return;
    }
    if (datumPickMode === 'zero') {
      event.stopPropagation();
      if (event.face?.normal) pickRotaryZero(event.face.normal.toArray());
      return;
    }
    const picked = featureUnder(event);
    if (picked === undefined) return;
    event.stopPropagation();
    selectFeature(picked);
  };

  /**
   * What the cursor is over: the edge it is sitting on, else the merged face.
   * `undefined` means "nothing detected here" — which is not the same as `null`,
   * a deliberate miss that clears the selection.
   */
  const featureUnder = (event) => {
    const detected = features();
    if (!detected?.faces?.length) return undefined;
    return featureAtPoint({
      edges: detected.edges,
      face: faceOfTriangle(detected, event.faceIndex),
      point: event.point?.toArray?.(),
    });
  };

  /**
   * Hover highlights what a click would take.
   *
   * The list in the CAM panel used to be the only thing that could do this, so
   * the model was a click target you had to aim at blind. One rule for both —
   * `featureAtPoint` — because a highlight that follows a different rule from
   * the click after it teaches the wrong place to aim.
   *
   * Guarded on the id: a pointer move fires on every pixel, and re-setting the
   * same feature would re-render the panel and the overlay for nothing.
   */
  const onPointerMove = (event) => {
    if (datumPickMode) return;   // the cursor means an origin right now, not a feature
    const picked = featureUnder(event);
    if (picked === undefined) return;
    if ((picked?.id ?? null) !== (hoverIdRef.current ?? null)) {
      hoverIdRef.current = picked?.id ?? null;
      previewFeatureAt(picked ?? null);
    }
  };

  const onPointerOut = () => {
    if (hoverIdRef.current === null) return;
    hoverIdRef.current = null;
    previewFeatureAt(null);
  };

  return (
    // Named so it can be picked out of the scene graph — by a test asking
    // "is the part actually on screen?", and by anyone inspecting the scene.
    <mesh
      name="imported-part"
      geometry={geometry}
      castShadow
      receiveShadow
      onClick={onClick}
      onPointerMove={onPointerMove}
      onPointerOut={onPointerOut}
    >
      {/* Distinct from the simulated stock's aluminium grey: this is the model
          to be made, not the material it is made from. DoubleSide because an
          inside-out STL is common enough that back faces must still draw —
          `analyzeMesh` warns about the winding rather than leaving a hole. */}
      <meshStandardMaterial
        color="#93a7bd"
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
        <lineBasicMaterial color={CAD.skHover} linewidth={2} depthTest={false} />
      </line>
    );
  }
  return (
    <mesh name="feature-highlight" geometry={highlight.geometry}>
      {/* polygonOffset lifts it off the face it covers, or the two planes fight
          for the same depth and the highlight flickers. */}
      <meshBasicMaterial
        color={CAD.skHover}
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

/**
 * A small axis triad at (0,0,0), drawn once a datum is set.
 *
 * `applyDatum` bakes the picked origin straight into the mesh's own
 * coordinates, so the physical point the operator picked is *literally*
 * world (0,0,0) the moment a datum is active — this only has to say so,
 * rather than track where it is. Without it, picking a point is a number in
 * a panel the operator has to trust; with it, the confirmation is on screen
 * next to the part.
 */
export function OriginMarker({ meshVer }) {
  const hasDatum = useCamPlanStore((s) => Boolean(s.datum.point));
  const bounds = useCamPlanStore((s) => s.analysis?.bounds);
  const size = originMarkerSize(bounds);

  const axes = useMemo(
    () => ORIGIN_AXES.map(({ dir, color }) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(
        [0, 0, 0, dir[0] * size, dir[1] * size, dir[2] * size],
        3,
      ));
      return { color, geometry: g };
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [size, meshVer],
  );

  useEffect(() => () => axes.forEach((a) => a.geometry.dispose()), [axes]);

  if (!hasDatum) return null;

  return (
    <group name="origin-marker">
      {axes.map((a) => (
        <line key={a.color} geometry={a.geometry}>
          <lineBasicMaterial color={a.color} depthTest={false} />
        </line>
      ))}
    </group>
  );
}

/**
 * A line through the picked A-axis centre, running the length of the part.
 *
 * Unlike the origin point, a datum's rotary centre is never baked into the
 * mesh's own coordinates — it only changes how `indexAt` pivots — so this has
 * to place itself at `displayedRotaryCenter()`'s Y/Z rather than always
 * drawing at (0,0,0).
 */
export function RotaryAxisLine({ meshVer }) {
  // Subscribe to the *function*, not its result — `displayedRotaryCenter()`
  // builds a fresh array every call, and a selector that never returns the
  // same reference twice re-renders forever.
  const displayedRotaryCenter = useCamPlanStore((s) => s.displayedRotaryCenter);
  const bounds = useCamPlanStore((s) => s.analysis?.bounds);
  const center = displayedRotaryCenter();
  const length = rotaryAxisLength(bounds);

  const geometry = useMemo(() => {
    if (!center) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-length / 2, center[0], center[1], length / 2, center[0], center[1]],
      3,
    ));
    return g;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.[0], center?.[1], length, meshVer]);

  useEffect(() => {
    if (!geometry) return undefined;
    return () => geometry.dispose();
  }, [geometry]);

  if (!geometry) return null;

  return (
    <line name="rotary-axis-line" geometry={geometry}>
      {/* Solid, not dashed — a dashed THREE.Line needs `computeLineDistances()`
          called imperatively on the object, which a declarative <line> here
          cannot do; amber keeps it visually distinct from the origin triad. */}
      <lineBasicMaterial color={CAD.skHover} depthTest={false} />
    </line>
  );
}
