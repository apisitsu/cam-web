/**
 * Viewport — R3F canvas configured for CNC machine coordinates (Z up).
 *
 * Auto-frames the parsed toolpath bounds so any loaded program is visible
 * without manual navigation, and snaps to the standard orthographic-style view
 * presets (iso / top / front / back / left / right). A small RGB axes gizmo marks
 * the work origin (G54-ish).
 */
import { useMemo, useRef, useEffect } from 'react';
import { Canvas, useThree, invalidate } from '@react-three/fiber';
import { OrbitControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import Backplot from './Backplot.jsx';
import StockMesh from './StockMesh.jsx';
import StockPreview from './StockPreview.jsx';
import PartMesh, { FeatureHighlight, OriginMarker, RotaryAxisLine } from './PartMesh.jsx';
import SketchLayer from './SketchLayer.jsx';
import { getBuf, setView } from '../engine/bufferCache.js';
import { sliceUpTo } from '../engine/gcode/path.js';
import { useSketchStore } from '../stores/sketchStore.js';
import { framing, unionBounds } from '../engine/view/camera.js';
import { endMillGeometry } from '../engine/view/millTool.js';
import {
  odHolderGeometry, boringBarGeometry, partingBladeGeometry,
} from '../engine/view/latheTool.js';
import { workTransform, toolTilt } from '../engine/view/rotaryFrame.js';
import { CAD, metal } from '../theme.js';

/**
 * Eye directions for each preset, in machine coordinates (X right, Y away,
 * Z up). Top/bottom look straight down the world up-axis, which would leave
 * OrbitControls' spherical coords degenerate, so they are tilted a hair off
 * the pole — enough to keep +Y pointing up the screen and orbiting sane.
 */
export { VIEW_DIRS, TURN_VIEW_DIRS } from '../engine/view/camera.js';

/**
 * Frame an **orthographic** camera on the toolpath from `view`.
 *
 * Orthographic (not perspective) so a Top/Front/Side preset is a true flat 2D
 * projection with no vanishing-point distortion, and — because dollying an ortho
 * camera scales its frustum instead of moving it through the scene — zooming
 * can't push geometry past the near/far planes and drop it. We still place the
 * camera well outside a generous depth slab so orbiting never clips either.
 *
 * The fit projects the box onto the screen axes for this view and sets
 * `camera.zoom` so the larger of the two in-plane extents fills the canvas. That
 * uses only the in-plane dimensions, so wide-shallow and tall-narrow parts both
 * fill — where the old 3D-diagonal fit zoomed out for an out-of-plane dimension
 * (a 4-axis part's rotated rapid retracts) and shrank the part to a sliver.
 */
/**
 * How many pixels of the canvas each edge's floating chrome covers.
 *
 * Measured from the DOM rather than hard-coded, because the rail wraps to a
 * second row on a narrow viewport and the readout comes and goes — a constant
 * would be wrong exactly when it mattered. Elements opt in with
 * `data-cam-overlay="top|right|bottom|left"`; anything transient (a popover, a
 * prompt) deliberately does not, so aiming the camera never depends on what was
 * open at the time.
 */
function overlayInsets(canvasEl) {
  const out = {
    left: 0, right: 0, top: 0, bottom: 0,
  };
  if (!canvasEl || typeof document === 'undefined') return out;
  const c = canvasEl.getBoundingClientRect();
  if (!c.width || !c.height) return out;
  for (const el of document.querySelectorAll('[data-cam-overlay]')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // Ignore anything not actually over this canvas.
    if (r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom) continue;
    const side = el.getAttribute('data-cam-overlay');
    if (side === 'top') out.top = Math.max(out.top, r.bottom - c.top);
    else if (side === 'bottom') out.bottom = Math.max(out.bottom, c.bottom - r.top);
    else if (side === 'left') out.left = Math.max(out.left, r.right - c.left);
    else if (side === 'right') out.right = Math.max(out.right, c.right - r.left);
  }
  // A little air between the geometry and the panel it sits beside.
  for (const k of ['left', 'right', 'top', 'bottom']) if (out[k] > 0) out[k] += 8;
  return out;
}

function CameraRig({ bounds, sketchFit, view, viewNonce, controlsRef, mode }) {
  const { camera, size: canvasSize, gl } = useThree();
  // Refit ONLY when the view, the fit request, or the bounds *values* change —
  // never on an incidental re-render. Keying the effect on this string means
  // playback (which re-renders every tick but changes none of these) can't snap
  // the camera back to the fit and undo the user's zoom.
  const fitKey = [
    mode, view, viewNonce,
    bounds ? bounds.min.map((n) => Math.round(n * 100)).join(',') : 'x',
    bounds ? bounds.max.map((n) => Math.round(n * 100)).join(',') : 'x',
  ].join('|');
  useEffect(() => {
    // Fit target = toolpath bounds unioned with the live sketch bounds, so an
    // explicit Fit frames whichever exists (or both). `sketchFit` is
    // intentionally read here but excluded from `fitKey`, so ongoing sketch
    // edits don't refit.
    const box = unionBounds(bounds ?? null, sketchFit ?? null);
    // All the arithmetic — view direction, screen axes, zoom, standoff — lives in
    // `engine/view/camera.js` so it can be tested without a canvas.
    // Measured now rather than tracked as state: the rail may have wrapped or
    // the readout appeared since the last fit, and this is the moment it matters.
    const f = framing(mode, view, box, canvasSize, {
      inset: overlayInsets(gl?.domElement),
    });
    camera.zoom = f.zoom;
    // Orient the camera with the same screen-up the fit was measured against.
    // Using world-up here instead rolls the view whenever the two disagree, and
    // goes degenerate when world-up is parallel to the view direction.
    camera.up.set(...f.up);
    camera.position.set(...f.position);
    camera.near = f.near;
    camera.far = f.far;
    camera.updateProjectionMatrix();
    const target = new THREE.Vector3(...f.target);
    camera.lookAt(target);
    if (controlsRef.current) {
      controlsRef.current.target.copy(target);
      controlsRef.current.update();
    }
    invalidate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  return null;
}

/**
 * Cutting tool + collet drawn at the current tool tip (Z-up machine coords).
 * The tip sits at `pos`; cutter and holder rise along +Z. Cylinders are modelled
 * along local Y, so each mesh is rotated +90° about X to stand up in world Z.
 *
 * `length` is the gauge length — tip to the collet face. When known (from the
 * tool table) the flutes + shank span exactly that far and the collet sits at
 * the collet face, so the stick-out is shown to scale; otherwise a sensible
 * default is used.
 */
function EndMill({
  radius = 3, type = 'flat', cutter, angle, thickness, shankDiameter, length = 0,
  arbor = true,
}) {
  // All the stacking arithmetic lives in engine/view/millTool.js, where it is
  // tested — a wrong offset here draws a tool floating off its own tip. The
  // cutter TYPE changes the whole silhouette, not just the tip: a face mill is
  // a wide shallow disc, an endmill a long stick.
  const { nose, flutes, shank, arbor: holder } = endMillGeometry({
    radius, type, cutter, angle, thickness, shank: shankDiameter, length, arbor,
  });

  return (
    <>
      {/* Named so the scene-graph tests can tell the parts apart — a tapered
          cylinder is not a reliable way to find the arbor. */}
      {/* The nose: a full sphere for a ball (upper half hidden inside the
          cutter), or a cone standing on its point for a chamfer mill. */}
      {nose && nose.kind === 'ball' && (
        <mesh name="tool-nose" position={[0, 0, nose.z]}>
          <sphereGeometry args={[nose.radius, 24, 16]} />
          <meshStandardMaterial {...metal('#e2e8f0', 0.3)} />
        </mesh>
      )}
      {nose && nose.kind === 'cone' && (
        // cylinderGeometry with a zero bottom radius IS a cone; modelled along
        // local Y like the rest, so it stands up with the same +90° about X.
        <mesh name="tool-nose" position={[0, 0, nose.z]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[nose.radius, 0, nose.height, 32]} />
          <meshStandardMaterial {...metal('#e2e8f0', 0.3)} />
        </mesh>
      )}
      {/* Cutter / flutes. */}
      <mesh name="tool-flutes" position={[0, 0, flutes.z]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[flutes.radius, flutes.radius, flutes.length, 32]} />
        <meshStandardMaterial {...metal('#cbd5e1', 0.3)} />
      </mesh>
      {/* Shank up to the collet face. */}
      <mesh name="tool-shank" position={[0, 0, shank.z]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[shank.radius, shank.radius, shank.length, 24]} />
        <meshStandardMaterial {...metal('#94a3b8', 0.35)} />
      </mesh>
      {/* Collet / arbor above the gauge line — hidden when it is in the way. */}
      {holder && (
        <mesh name="tool-arbor" position={[0, 0, holder.z]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[holder.rBottom, holder.rTop, holder.length, 32]} />
          <meshStandardMaterial {...metal('#eab308', 0.25)} />
        </mesh>
      )}
    </>
  );
}

/**
 * Turning tool at the cutting tip, styled after the catalogue holders (MVJNR /
 * MVVNN in image_tool). The holder is ONE continuous solid — a **straight**
 * vertical shank whose **front-bottom is beveled at the lead angle** into a head
 * that seats the insert — extruded from a single silhouette (not stacked boxes).
 * A gold insert with a centre clamp screw sits on that beveled seat, acute corner
 * at the tip. Turn geometry runs along world Z (spindle) with X radial.
 */
function ODHolder({ radius = 0.8, shape }) {
  // Every number comes from `engine/view/latheTool.js`, which is tested — the
  // silhouette, where the insert sits on it, and how far the body is set back
  // from the cutting corner so the two never share a surface. This file used to
  // carry its own copy of that trigonometry, which is how the seated-flush
  // flicker survived a fix to the module: there were two of it.
  const g = odHolderGeometry(radius, shape ?? {});
  const { insert } = g;
  const baseRot = insert.sides === 3 ? Math.PI : 0;
  // A key over the numbers the silhouette is built from: `g` is a fresh object
  // every render, so it cannot be a dependency itself.
  const shapeKey = `${g.outline.flat().join(',')}|${g.depth}`;

  const holderGeo = useMemo(() => {
    const sh = new THREE.Shape();    // shape (x = world X, y = world Z)
    g.outline.forEach(([x, z], i) => (i === 0 ? sh.moveTo(x, z) : sh.lineTo(x, z)));
    sh.closePath();
    const geo = new THREE.ExtrudeGeometry(sh, { depth: g.depth, bevelEnabled: false });
    // rotateX maps the extrusion (shape +z) onto world −Y, so the solid hangs
    // from the shape plane downward; the mesh is then placed at `bodyY`, a hair
    // under the cutting plane, and the insert alone reaches Y=0.
    geo.rotateX(Math.PI / 2);                 // shape (X,Z) → world XZ, depth → −Y
    geo.computeVertexNormals();
    return geo;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeKey]);

  useEffect(() => () => holderGeo.dispose(), [holderGeo]);

  return (
    <>
      <mesh geometry={holderGeo} position={[0, g.bodyY, 0]}>
        <meshStandardMaterial {...metal('#a7afbd')} side={THREE.DoubleSide} />
      </mesh>
      {/* Gold insert at the lead angle, acute corner at the tip. Its rake face
          sits on Y=0, so the cutting corner is exactly at spindle centre — and
          it stands proud of the seat below it, as a real insert does. */}
      <mesh
        position={[insert.x, g.insertY, insert.z]}
        rotation={[0, insert.rot + baseRot, 0]}
        scale={[1, 1, insert.zScale]}
      >
        <cylinderGeometry args={[insert.r, insert.r, insert.thickY, insert.sides]} />
        <meshStandardMaterial {...metal('#e0a92a', 0.3)} />
      </mesh>
      {/* Centre clamp screw, head proud of the rake face. */}
      <mesh position={[insert.x, g.screwY, insert.z]}>
        <cylinderGeometry args={[g.screwR, g.screwR, g.screwH, 14]} />
        <meshStandardMaterial {...metal('#3f4653', 0.45)} />
      </mesh>
    </>
  );
}

/**
 * A boring bar: a round shank lying along the spindle (+Z, out toward the turret)
 * with a small insert at the tip cutting the bore wall from inside (facing +X).
 * Marker only — the sim still carves the outer profile.
 */
function BoringBar({ radius = 0.8, shape }) {
  const g = boringBarGeometry(radius, shape ?? {});
  const { insert } = g;
  return (
    <>
      {/* Round bar along +Z, hanging below the cutting plane — its crown clears
          that plane by `standout` rather than touching it. */}
      <mesh
        position={[-g.barRadius, g.barY, g.barRadius + g.barLength / 2]}
        rotation={[Math.PI / 2, 0, 0]}
      >
        <cylinderGeometry args={[g.barRadius, g.barRadius, g.barLength, 20]} />
        <meshStandardMaterial {...metal('#a7afbd')} />
      </mesh>
      {/* Gold insert at the tip, acute corner down toward the axis, cutting the
          ID. Rake face on Y=0 so the cutting corner is at spindle centre. */}
      <mesh
        position={[-insert.r * 0.4, g.insertY, insert.r * 0.6]}
        rotation={[0, Math.PI / 4, 0]}
        scale={[1, 1, insert.zScale]}
      >
        <cylinderGeometry args={[insert.r, insert.r, insert.thickY, insert.sides]} />
        <meshStandardMaterial {...metal('#e0a92a', 0.3)} />
      </mesh>
    </>
  );
}

/**
 * A parting / grooving blade: a thin tall plate coming down to a narrow cutting
 * edge at the tip. `grooveW` sets the cut width. Marker only.
 */
function PartingBlade({ radius = 0.8, shape }) {
  const g = partingBladeGeometry(radius, shape ?? {});
  return (
    <>
      {/* Thin blade rising from the tip, hanging below the cutting plane and set
          back from it by `standout` in both directions — so neither its top face
          nor its leading face shares a plane with the cutting tip's. */}
      <mesh position={[g.height / 2 + g.standout, g.bladeY, 0]}>
        <boxGeometry args={[g.height, g.depth, g.width]} />
        <meshStandardMaterial {...metal('#a7afbd')} />
      </mesh>
      {/* Cutting tip — a small block proud of the blade on every side, its top
          edge on Y=0 so the cut is at spindle centre. */}
      <mesh position={[g.tipHeight / 2, g.tipY, 0]}>
        <boxGeometry args={[g.tipHeight, g.depth * 1.02, g.width * 1.15]} />
        <meshStandardMaterial {...metal('#e0a92a', 0.3)} />
      </mesh>
    </>
  );
}

/** Dispatch to the marker for the selected turning-tool kind. */
function LatheTool({ radius = 0.8, shape }) {
  const kind = shape?.kind ?? 'od';
  if (kind === 'boring') return <BoringBar radius={radius} shape={shape} />;
  if (kind === 'parting') return <PartingBlade radius={radius} shape={shape} />;
  return <ODHolder radius={radius} shape={shape} />;
}

/**
 * A 3-jaw chuck gripping the workpiece at the −Z (spindle) end. `zEnd` is the
 * chuck's front face — placed a few mm past the deepest cut, so the jaws grip the
 * raw bar behind it (extending −Z) rather than swallowing the machined part.
 */
function Chuck({ zEnd, od }) {
  const bodyR = Math.max(od * 2.2, od + 20);
  const bodyLen = 30;
  const jawProtrude = 12;            // jaws stick forward (+Z) of the body face
  const bodyFace = zEnd - jawProtrude; // body front face, behind the jaws
  const jawOuter = bodyR * 0.95;     // jaws reach out nearly to the body rim
  const rMid = (od + jawOuter) / 2;
  const angles = [0, 120, 240].map((d) => (d * Math.PI) / 180);
  const steel = (c, r = 0.45) => <meshStandardMaterial {...metal(c, r)} />;

  return (
    <group>
      {/* Chuck body — a medium-grey cylinder behind the jaws (not too dark). */}
      <mesh position={[0, 0, bodyFace - bodyLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[bodyR, bodyR, bodyLen, 48]} />
        {steel('#8a94a6')}
      </mesh>
      {/* Three jaws protruding forward of the body face, so they're clearly
          visible gripping the bar OD. Lighter steel than the body. */}
      {angles.map((th, i) => (
        <group key={i} rotation={[0, 0, th]}>
          <mesh position={[rMid, 0, bodyFace + jawProtrude / 2]}>
            <boxGeometry args={[jawOuter - od, Math.max(od * 1.1, 8), jawProtrude]} />
            {steel('#c3cad6', 0.5)}
          </mesh>
          {/* Stepped gripping face pressing on the bar (nearest the workpiece). */}
          <mesh position={[od + (jawOuter - od) * 0.2, 0, zEnd - 1.5]}>
            <boxGeometry args={[(jawOuter - od) * 0.4, Math.max(od * 0.9, 6), 5]} />
            {steel('#d7dde6', 0.5)}
          </mesh>
        </group>
      ))}
    </group>
  );
}

/**
 * Cutting tool at the current tip.
 *
 * In the **part** frame the backplot is drawn with the table's rotation undone
 * (each face sits where it belongs on the workpiece), so the tool has to be
 * tilted the same way to stand normal to the face being cut — otherwise it
 * points straight up +Z through the side of the part. In the **machine** frame
 * there is nothing to undo and the tool stays upright, which is what a real
 * spindle does. `toolTilt` decides between them; nesting the groups composes
 * Ry(-B)·Rx(-A), matching the interpreter's toPartFrame(). The tip stays pinned
 * at `pos` because every rotation is about the group origin.
 */
function Tool({
  pos, rotary, radius, type, cutter, angle, thickness, shank, length, insert, mode,
  showArbor = true,
  rotaryFrame = 'part',
}) {
  if (!pos) return null;
  const tilt = toolTilt(rotaryFrame, rotary);
  return (
    <group position={pos} rotation={[0, tilt.b, 0]}>
      <group rotation={[tilt.a, 0, 0]}>
        {mode === 'turn'
          ? <LatheTool radius={Math.min(radius, 1.6)} shape={insert} />
          : (
            <EndMill
              radius={radius}
              type={type}
              cutter={cutter}
              angle={angle}
              thickness={thickness}
              shankDiameter={shank}
              length={length}
              arbor={showArbor}
            />
          )}
      </group>
    </group>
  );
}

/**
 * Everything that rides the rotary table, placed for the frame being drawn.
 *
 * Two nested groups, always — translate to the A axis, turn, translate back —
 * because the physical axis runs through wherever it was touched off, not
 * through the part's own zero. The structure is unconditional even when the
 * transform is identity: collapsing it would remount the part and stock
 * geometry every time the angle crossed zero.
 */
function WorkGroup({ t, name, children }) {
  return (
    <group name={name} position={t.pivot} rotation={t.rotation}>
      <group position={t.unpivot}>{children}</group>
    </group>
  );
}

// X/Y/Z labels at the ends of the origin axes (DOM overlay — no font fetch).
function AxisLabels({ len = 22 }) {
  const style = (color) => ({
    color,
    fontWeight: 700,
    fontFamily: 'monospace',
    fontSize: 14,
    // A white halo, because the label now sits on a light viewport — the black
    // one it used to carry made the letters look bruised rather than legible.
    textShadow: '0 0 3px #fff, 0 0 6px #fff',
    userSelect: 'none',
    pointerEvents: 'none', // don't intercept orbit drags
  });
  return (
    <group>
      <Html position={[len, 0, 0]} center><div style={style(CAD.rapid)}>X</div></Html>
      <Html position={[0, len, 0]} center><div style={style(CAD.feed)}>Y</div></Html>
      <Html position={[0, 0, len]} center><div style={style(CAD.accent)}>Z</div></Html>
    </group>
  );
}

/** The lathe spindle axis (Z), drawn as a centreline through the work origin. */
function SpindleAxis({ bounds }) {
  const [zMin, zMax] = useMemo(() => {
    if (!bounds) return [-50, 50];
    return [Math.min(bounds.min[2], -10) - 20, Math.max(bounds.max[2], 10) + 20];
  }, [bounds]);
  const points = useMemo(
    () => new Float32Array([0, 0, zMin, 0, 0, zMax]),
    [zMin, zMax]
  );
  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[points, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={CAD.sceneLine} />
    </lineSegments>
  );
}

/**
 * Everything drawn inside the canvas.
 *
 * Split out of `Viewport` so it can be mounted directly by
 * `@react-three/test-renderer`, which builds its own canvas and cannot host a
 * nested `<Canvas>`. That makes the scene graph — is the imported part actually
 * there? is the backplot? — testable without WebGL, which is the only way the
 * viewport gets any automated coverage at all.
 */
export function SceneContents({
  bounds, turnChuck, showStock, toolPos, toolRotary, toolRadius, toolType,
  toolCutter, toolAngle, toolThickness, toolShank, toolLength, turnInsert, bufVer, drawVer, partVer,
  showPart = true,
  mode = 'mill', sketching = false, showArbor = true, showToolpath = true,
  rotaryFrame = 'part', rotaryCenter, simFrameA = 0, stockSolid = null,
}) {
  // **If the scene re-rendered, the scene needs painting.**
  //
  // The canvas is `frameloop="demand"`, so nothing reaches the screen without an
  // `invalidate()`. `Viewport` has one, outside the `<Canvas>`, with a hand-kept
  // list of every prop that ought to trigger a frame — and a list like that is
  // only ever as right as the last person to add a prop. It was already wrong:
  // toggling the arbor changed the scene graph and left the last frame on
  // screen, so the button flipped and the picture did not. Measured: 0.00% of
  // viewport pixels changed on the toggle, 9.78% once the camera was nudged into
  // repainting.
  //
  // This one is bound to *this* root (`useThree`, from inside the canvas) and
  // has **no dependency array on purpose**: React re-rendering these contents is
  // itself the signal, and it costs exactly the one frame that was wanted.
  const requestFrame = useThree((s) => s.invalidate);
  useEffect(() => { requestFrame(); });

  // Where the workpiece and the carved stock sit for this frame. They can differ:
  // the height-field sim carves one index in the machine frame, so its block is
  // already turned to `simFrameA` and must only travel the rest of the way.
  const a = toolRotary?.a ?? 0;
  const partT = workTransform(rotaryFrame, { a, center: rotaryCenter });
  const stockT = workTransform(rotaryFrame, { a, baseA: simFrameA, center: rotaryCenter });
  return (
    <>
      {/* Key light over the operator's shoulder, plus a weak fill from the
          opposite side so a face turned away from the key still has a value
          rather than going flat to the ambient. Two lights is the whole rig —
          the materials are shaded, not simulated (see `metal()` in theme.js),
          and shading is all they need. */}
      <ambientLight intensity={0.72} />
      <directionalLight position={[100, 100, 200]} intensity={0.75} />
      <directionalLight position={[-140, -80, 60]} intensity={0.28} />

      <axesHelper args={[20]} />
      <AxisLabels len={22} />

      {/* CAM geometry (backplot, stock, tool, lathe fixtures) belongs to the
          Milling / Turning pages; the Sketch page shows only the sketcher. */}
      {sketching ? (
        <SketchLayer />
      ) : (
        <>
          {mode === 'turn' && <SpindleAxis bounds={bounds} />}
          {mode === 'turn' && turnChuck && (
            <Chuck zEnd={turnChuck.z - 5} od={turnChuck.od} />
          )}

          {/* The backplot is never rotated: it is where the tool went, and in
              the machine frame that is exactly the stationary trail the
              programmed coordinates describe. */}
          <Backplot drawVer={drawVer} visible={showToolpath} />
          <WorkGroup name="stock-work" t={stockT}>
            <StockMesh simVer={bufVer} visible={showStock} />
            {/* The uncarved blank, live off the store. Yielded to the carved
                block the moment there is one — two overlapping stocks would be
                a picture of nothing. */}
            <StockPreview solid={stockSolid} visible={showStock} />
          </WorkGroup>
          {/* The imported model and its datum, on the table. Drawn on both
              machining pages: a part is a part whether it is going to be turned
              or milled. Picking a datum off it reads world coordinates, which is
              only the part's own frame while this group is unrotated — true
              whenever a program is not mid-index, which is when picking happens. */}
          <WorkGroup name="part-work" t={partT}>
            <PartMesh meshVer={partVer} visible={showPart} />
            {showPart && <FeatureHighlight meshVer={partVer} />}
            {showPart && <OriginMarker meshVer={partVer} />}
            {showPart && <RotaryAxisLine meshVer={partVer} />}
          </WorkGroup>
          <Tool
            pos={toolPos}
            rotary={toolRotary}
            radius={toolRadius}
            type={toolType}
            cutter={toolCutter}
            angle={toolAngle}
            thickness={toolThickness}
            shank={toolShank}
            length={toolLength}
            insert={turnInsert}
            mode={mode}
            showArbor={showArbor}
            rotaryFrame={rotaryFrame}
          />
        </>
      )}
    </>
  );
}

export default function Viewport({
  bounds, fitBounds, sketchFit, turnChuck, showStock, toolPos, toolRotary, toolRadius, toolType,
  toolCutter, toolAngle, toolThickness, toolShank, toolLength, turnInsert, bufVer, playhead, partVer,
  showPart = true,
  mode = 'mill', sketching = false, view = 'iso', viewNonce = 0, showArbor = true,
  showToolpath = true,
  rotaryFrame = 'part', rotaryCenter, simFrameA = 0, stockSolid = null,
}) {
  const controlsRef = useRef();
  // Disable orbit while dragging a sketch point so the drag moves the point,
  // not the camera (SolidWorks drags geometry, not the view).
  const sketchDragging = useSketchStore((s) => s.dragging);
  // And turn off left-drag *rotate* whenever the sketch Select tool is active, so
  // a drag on empty space is free for a marquee (SketchLayer) rather than
  // tumbling the view. Pan (right-drag) and zoom (wheel) are untouched; other
  // sketch tools get orbit back.
  const sketchTool = useSketchStore((s) => s.tool);

  // Resolve which rapids/feeds to draw (full backplot, or the sliced sub-path
  // during playback) and stash them in the module view-cache. Children read
  // them from there keyed on the scalar `drawVer` token below — the arrays are
  // never passed as React props, so React's dev Performance Track can't walk
  // them into Performance.measure() and blow up with DataCloneError.
  const drawVer = useMemo(() => {
    const { rapids, feeds, path } = getBuf();
    const count = path?.count ?? 0;
    const partial = playhead != null && path && playhead < count;
    if (partial) {
      const sliced = sliceUpTo(path, playhead);
      setView({ rapids: sliced.rapids, feeds: sliced.feeds });
    } else {
      setView({ rapids, feeds });
    }
    return `${bufVer}:${playhead}`;
  }, [bufVer, playhead]);

  // Re-render the demand-mode canvas whenever inputs change.
  useEffect(() => {
    invalidate();
  // `showArbor` belongs here: the canvas is frameloop="demand", so dropping the
  // holder would not appear on screen until some other input happened to change.
  // `rotaryFrame`/`simFrameA` belong here for the same reason `showArbor` does:
  // the canvas is frameloop="demand", so flipping the frame would not appear on
  // screen until some other input happened to change.
  }, [drawVer, showStock, toolPos, toolRotary, toolRadius, toolType, toolLength, turnInsert, mode, partVer, showPart, showArbor, showToolpath, rotaryFrame, simFrameA, stockSolid, toolCutter, toolAngle, toolThickness, toolShank]);

  // The gradient goes on the canvas ELEMENT, not on a three.js scene background:
  // CSS paints it for free behind the renderer's transparent clear colour, where
  // a scene background would be a texture to build, upload and keep in step with
  // the canvas size. This is the SolidWorks/CATIA viewport — slate blue at the
  // horizon fading to near-white at the floor, which is what gives an unlit face
  // something to be seen against.
  return (
    <Canvas
      frameloop="demand"
      orthographic
      camera={{ position: [80, -80, 80], up: [0, 0, 1], zoom: 6, near: 0.1, far: 100000 }}
      style={{ background: CAD.viewport }}
    >
      <SceneContents
        bounds={bounds}
        turnChuck={turnChuck}
        showStock={showStock}
        toolPos={toolPos}
        toolRotary={toolRotary}
        toolRadius={toolRadius}
        toolType={toolType}
        toolCutter={toolCutter}
        toolAngle={toolAngle}
        toolThickness={toolThickness}
        toolShank={toolShank}
        toolLength={toolLength}
        turnInsert={turnInsert}
        bufVer={bufVer}
        drawVer={drawVer}
        partVer={partVer}
        showPart={showPart}
        mode={mode}
        sketching={sketching}
        showArbor={showArbor}
        showToolpath={showToolpath}
        rotaryFrame={rotaryFrame}
        rotaryCenter={rotaryCenter}
        simFrameA={simFrameA}
        stockSolid={stockSolid}
      />

      <CameraRig
        bounds={fitBounds ?? bounds}
        sketchFit={sketchFit}
        view={view}
        viewNonce={viewNonce}
        controlsRef={controlsRef}
        mode={mode}
      />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enabled={!(sketching && sketchDragging)}
        enableRotate={!(sketching && sketchTool === 'select')}
        minZoom={0.05}
        maxZoom={2000}
      />
    </Canvas>
  );
}
