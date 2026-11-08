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
import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import * as THREE from 'three';
import { getMesh, getRawMesh, useCamPlanStore } from '../stores/camPlanStore.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { useFeatureStore } from '../stores/featureStore.js';
import { useCamStore } from '../stores/camStore.js';
import { planeBasis } from '../engine/sketch/plane.js';
import { detectFeatures, faceOfTriangle } from '../engine/mesh/features.js';
import { measurePick } from '../engine/mesh/measure.js';
import { useMeasureStore } from '../stores/measureStore.js';
import { featureAtPoint } from '../engine/mesh/pickEdge.js';
import { circlesAt, nearestCircle } from '../engine/mesh/circlePick.js';
import { originMarkerSize, rotaryAxisLength } from '../engine/view/originMarker.js';
import { CAD } from '../theme.js';

/** The model to be made, distinct from the simulated stock's aluminium grey. */
const PART_COLOR = '#93a7bd';

/** A Measure pick from a hit on `welded`, at `point` in its frame. */
const pickFor = (welded, event, point) => measurePick(
  welded,
  event.faceIndex,
  point,
  event.face?.normal?.toArray() ?? [0, 0, 1],
);

/** Flat-shaded geometry for a soup, one normal per facet (see the note at the top). */
function soupGeometry(soup) {
  if (!soup || soup.triangleCount === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(soup.positions, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

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
  const pickCircleCenter = useCamPlanStore((s) => s.pickCircleCenter);
  const pickRotaryCenter = useCamPlanStore((s) => s.pickRotaryCenter);
  const pickRotaryZero = useCamPlanStore((s) => s.pickRotaryZero);
  const setDatumHover = useCamPlanStore((s) => s.setDatumHover);
  const measuring = useMeasureStore((s) => s.active);
  const addMeasure = useMeasureStore((s) => s.add);
  const circleCache = useRef(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geometry = useMemo(() => soupGeometry(getMesh().soup), [meshVer]);

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
    // point, and the normal lets a flat face turn square to that axis.
    const axis = { x: 0, y: 1, z: 2 }[datumPickMode];
    if (axis !== undefined) {
      event.stopPropagation();
      pickAxisOrigin(axis, localPoint(), event.face?.normal?.toArray());
      return;
    }
    if (datumPickMode === 'circle') {
      event.stopPropagation();
      if (event.face?.normal) pickCircleCenter(localPoint(), event.face.normal.toArray());
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
    // Measure, when it is on, takes the click: it is what the operator just asked for.
    if (measuring) {
      event.stopPropagation();
      addMeasure(pickFor(getMesh().welded, event, localPoint()));
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
    // The cursor means an origin right now, not a feature, so show that instead.
    if (datumPickMode) { hoverDatum(event); return; }
    if (measuring) return;
    const picked = featureUnder(event);
    if (picked === undefined) return;
    if ((picked?.id ?? null) !== (hoverIdRef.current ?? null)) {
      hoverIdRef.current = picked?.id ?? null;
      previewFeatureAt(picked ?? null);
    }
  };

  /**
   * What a click would take while a pick is armed: the flat face for an axis or A0
   * pick, and the circle for a centre pick, by the same rule the click itself uses.
   *
   * The sections behind a circle are cut once per facet, not once per pixel. The
   * nearest one is still chosen on every move, because one end face holds both a
   * bore and a boss and which is meant depends on where in that facet the cursor is.
   */
  const hoverDatum = (event) => {
    if (datumPickMode === 'circle') {
      if (!event.face?.normal) return;
      const point = event.object.worldToLocal(event.point.clone()).toArray();
      const key = `${meshVer}:${event.faceIndex}`;
      if (circleCache.current?.key !== key) {
        circleCache.current = {
          key,
          circles: circlesAt(getMesh().welded, point, event.face.normal.toArray()),
        };
      }
      const circle = nearestCircle(circleCache.current.circles, point);
      // Keep the marker on show until another circle replaces it, or it would vanish
      // on the way to it: the ring sits on an edge, where the cursor crosses a
      // chamfer or leaves the part altogether.
      if (!circle) return;
      const across = circle.center.filter((_, i) => i !== circle.axis).map((v) => v.toFixed(3));
      setDatumHover({ id: `circle:${circle.axis}:${across.join(',')}:${circle.radius.toFixed(3)}`, circle });
      return;
    }
    if (datumPickMode === 'rotary') return;
    const detected = features();
    const face = detected?.faces?.length ? faceOfTriangle(detected, event.faceIndex) : null;
    setDatumHover(face ? { id: `face:${face.id}`, face } : null);
  };

  const onPointerOut = () => {
    if (datumPickMode !== 'circle') setDatumHover(null);
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
        color={PART_COLOR}
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
 * The part on the Sketch page, solid, the way SolidWorks keeps it on screen while
 * you sketch on it.
 *
 * It is the part **as built** (`getRawMesh`), not as laid down for machining: that
 * is the frame the solids and the sketches live in, so a sketch on a face sits on
 * that face here.
 *
 * Drawn first and then the depth is cleared, so the sketch draws over it: lines
 * on a face would otherwise fight the face for the same depth, and a sketch plane
 * inside the part would vanish behind it. The part still hides its own back faces.
 *
 * While Sketch on Face waits (`facePick`), the face under the cursor is lit, and a
 * click starts a sketch on it and turns the view square to it. Otherwise the part
 * has no handlers at all, so it never takes a click meant for the sketch.
 */
export function SketchPart({ meshVer, visible = true }) {
  const facePick = useSketchStore((s) => s.facePick);
  const measuring = useMeasureStore((s) => s.active);
  const addMeasure = useMeasureStore((s) => s.add);
  const [hover, setHover] = useState(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geometry = useMemo(() => soupGeometry(getRawMesh().soup), [meshVer]);
  const highlight = useMemo(
    () => highlightGeometry(hover, getRawMesh().soup),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hover, meshVer],
  );

  useEffect(() => {
    if (!geometry) return undefined;
    return () => geometry.dispose();
  }, [geometry]);
  useEffect(() => {
    if (!highlight) return undefined;
    return () => highlight.geometry.dispose();
  }, [highlight]);
  useEffect(() => { if (!facePick) setHover(null); }, [facePick]);

  if (!geometry || !visible) return null;

  const faceUnder = (event) => {
    const { welded } = getRawMesh();
    return welded ? faceOfTriangle(detectFeatures(welded), event.faceIndex) : null;
  };

  // Measure takes clicks here as on the machining pages, in the frame the part
  // was built in; Sketch on Face, armed on purpose, comes first.
  const measure = measuring && !facePick ? {
    onClick: (event) => {
      event.stopPropagation();
      addMeasure(pickFor(getRawMesh().welded, event, event.point.toArray()));
    },
  } : {};
  const pick = facePick ? {
    onPointerMove: (event) => {
      event.stopPropagation();
      const face = faceUnder(event);
      if ((face?.id ?? null) !== (hover?.id ?? null)) setHover(face);
    },
    onPointerOut: () => setHover(null),
    onClick: (event) => {
      event.stopPropagation();
      const face = faceUnder(event);
      if (!face) return;
      useSketchStore.getState().setFacePick(false);
      const id = useFeatureStore.getState().sketchOnFace({ face });
      const plane = useSketchStore.getState().sketches.find((s) => s.id === id)?.plane;
      if (!plane) return;
      const { n, v } = planeBasis(plane);
      useCamStore.getState().normalTo(n, v);
    },
  } : {};

  return (
    <group name="sketch-part">
      <mesh
        name="built-part"
        geometry={geometry}
        renderOrder={-1}
        onAfterRender={(renderer) => renderer.clearDepth()}
        {...measure}
        {...pick}
      >
        <meshStandardMaterial color={PART_COLOR} metalness={0.1} roughness={0.65} side={THREE.DoubleSide} />
      </mesh>
      {highlight?.kind === 'face' && (
        <mesh geometry={highlight.geometry}>
          <meshBasicMaterial
            color={CAD.skHover} transparent opacity={0.6} side={THREE.DoubleSide} depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}

/**
 * What Measure has picked, drawn on the part: the face lit, the circle ringed,
 * and a dot where a distance is taken from. Drawn over everything, since a mark
 * hidden behind the part it marks says nothing.
 *
 * `raw` is the frame the picks were made in — the part as built on the Sketch
 * page, as set up for machining elsewhere.
 */
export function MeasureMarks({ meshVer, raw = false }) {
  const picks = useMeasureStore((s) => s.picks);
  const bounds = useCamPlanStore((s) => s.analysis?.bounds);
  const size = originMarkerSize(bounds);
  const geometries = useMemo(() => {
    const soup = (raw ? getRawMesh() : getMesh()).soup;
    const out = [];
    for (const p of picks) {
      if (p.kind === 'face') {
        const built = highlightGeometry(p.face, soup);
        if (built) out.push(built.geometry);
      }
      if (p.kind === 'circle') out.push(...circleMarkerGeometry(p.circle, size));
      else {
        const dot = new THREE.SphereGeometry(size * 0.04, 12, 8);
        dot.translate(p.point[0], p.point[1], p.point[2]);
        out.push(dot);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks, size, meshVer, raw]);

  useEffect(() => () => geometries.forEach((g) => g.dispose()), [geometries]);

  if (!geometries.length) return null;
  return (
    <group name="measure-marks">
      {geometries.map((g) => (
        <mesh key={g.uuid} geometry={g} renderOrder={11} raycast={() => null}>
          <meshBasicMaterial
            color={CAD.accent} transparent opacity={0.7} side={THREE.DoubleSide} depthTest={false} depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/** A ring and a centre dot, as one geometry per part, for a circle in the mesh's own frame. */
function circleMarkerGeometry({ axis, center, radius }, size) {
  // A real tube rather than a line, because WebGL draws every line one pixel wide
  // however it is asked, and one pixel is what could not be seen on the part.
  const tube = Math.max(radius * 0.04, size * 0.02);
  const ring = new THREE.TorusGeometry(radius, tube, 8, 72);
  if (axis === 0) ring.rotateY(Math.PI / 2);
  if (axis === 1) ring.rotateX(Math.PI / 2);
  ring.translate(center[0], center[1], center[2]);
  const dot = new THREE.SphereGeometry(tube * 2.5, 12, 8);
  dot.translate(center[0], center[1], center[2]);
  return [ring, dot];
}

/**
 * What the next click would take while a pick is armed, drawn over the part.
 *
 * Not `FeatureHighlight`: that one shows a selected face in preference to a hover,
 * so an operator with a face selected would see nothing change under the cursor.
 */
export function DatumPickHighlight({ meshVer }) {
  const hover = useCamPlanStore((s) => (s.datumPickMode ? s.datumHover : null));
  const pickCircleCenter = useCamPlanStore((s) => s.pickCircleCenter);
  const bounds = useCamPlanStore((s) => s.analysis?.bounds);
  const size = originMarkerSize(bounds);
  // The ring is a click target of its own, because half of it can hang off the
  // edge of the part, where a click would otherwise hit nothing.
  const onClick = hover?.circle
    ? (event) => { event.stopPropagation(); pickCircleCenter(); }
    : undefined;
  const geometries = useMemo(() => {
    if (hover?.circle) return circleMarkerGeometry(hover.circle, size);
    if (hover?.face) {
      const built = highlightGeometry(hover.face, getMesh().soup);
      return built ? [built.geometry] : [];
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, size, meshVer]);

  useEffect(() => () => geometries.forEach((g) => g.dispose()), [geometries]);

  if (!geometries.length) return null;

  return (
    <group name="datum-pick-highlight">
      {geometries.map((g) => (
        <mesh key={g.uuid} geometry={g} renderOrder={10} onClick={onClick}>
          {/* A circle draws over the part, so a bore is still marked from a view
              that hides its far edge. A face keeps its depth test and only lifts
              off the facets it covers, so it shows which side is being picked. */}
          <meshBasicMaterial
            color={CAD.skHover}
            transparent
            opacity={hover?.circle ? 0.95 : 0.75}
            side={THREE.DoubleSide}
            depthTest={!hover?.circle}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-2}
          />
        </mesh>
      ))}
    </group>
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
