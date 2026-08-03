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
import { workTransform, toolTilt } from '../engine/view/rotaryFrame.js';

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
function CameraRig({ bounds, sketchFit, view, viewNonce, controlsRef, mode }) {
  const { camera, size: canvasSize } = useThree();
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
    const f = framing(mode, view, box, canvasSize);
    camera.zoom = f.zoom;
    // Orient the camera with the same screen-up the fit was measured against.
    // Using world-up here instead rolls the view whenever the two disagree, and
    // goes degenerate when world-up is parallel to the view direction.
    camera.up.set(...f.up);
    camera.position.set(...f.position);
    camera.near = f.near;
    camera.far = f.far;
    camera.updateProjectionMatrix();
    const target = new THREE.Vector3(...f.center);
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
function EndMill({ radius = 3, type = 'flat', cutter, angle, length = 0, arbor = true }) {
  // All the stacking arithmetic lives in engine/view/millTool.js, where it is
  // tested — a wrong offset here draws a tool floating off its own tip. The
  // cutter TYPE changes the whole silhouette, not just the tip: a face mill is
  // a wide shallow disc, an endmill a long stick.
  const { nose, flutes, shank, arbor: holder } = endMillGeometry({
    radius, type, cutter, angle, length, arbor,
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
          <meshStandardMaterial color="#e2e8f0" metalness={0.6} roughness={0.3} />
        </mesh>
      )}
      {nose && nose.kind === 'cone' && (
        // cylinderGeometry with a zero bottom radius IS a cone; modelled along
        // local Y like the rest, so it stands up with the same +90° about X.
        <mesh name="tool-nose" position={[0, 0, nose.z]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[nose.radius, 0, nose.height, 32]} />
          <meshStandardMaterial color="#e2e8f0" metalness={0.6} roughness={0.3} />
        </mesh>
      )}
      {/* Cutter / flutes. */}
      <mesh name="tool-flutes" position={[0, 0, flutes.z]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[flutes.radius, flutes.radius, flutes.length, 32]} />
        <meshStandardMaterial color="#cbd5e1" metalness={0.7} roughness={0.3} />
      </mesh>
      {/* Shank up to the collet face. */}
      <mesh name="tool-shank" position={[0, 0, shank.z]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[shank.radius, shank.radius, shank.length, 24]} />
        <meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.35} />
      </mesh>
      {/* Collet / arbor above the gauge line — hidden when it is in the way. */}
      {holder && (
        <mesh name="tool-arbor" position={[0, 0, holder.z]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[holder.rBottom, holder.rTop, holder.length, 32]} />
          <meshStandardMaterial color="#eab308" metalness={0.75} roughness={0.25} />
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
  const sides = shape?.sides ?? 4;
  const angle = shape?.angle ?? 35;
  const lead = shape?.lead ?? 93;
  const s = Math.max(radius * 7, 6);
  const thickY = Math.max(radius * 2.4, 1.8);
  const r = s * 0.62;
  const zScale = sides === 4 ? Math.max(Math.tan((angle / 2) * DEG), 0.2) : 1;
  const baseRot = sides === 3 ? Math.PI : 0;
  // Holder depth runs **down** from the cutting plane: a lathe cuts in the plane
  // through the spindle axis (Y=0), so the insert's rake face is at Y=0 and the
  // whole tool hangs below it. Looking down from Top you see the rake face lying
  // exactly on the toolpath.
  const depth = thickY * 1.5;                         // holder depth (down −Y)

  // The insert sits at the lead angle: its long diagonal is rotated `t` from
  // vertical (`t` = lead + angle/2 − 90, mirrored by `flip`; MVVNN 72.5°+35° → 0
  // upright, MVJNR 93° tips it back). Its acute corner is the cutting tip at the
  // origin. The SHANK stays vertical; only its HEAD (the bevelled front-bottom)
  // is cut to the insert angle — the bevel runs along the insert's trailing (+Z)
  // edge, so the tip juts past the shank's front face on its own.
  const flip = !!shape?.flip;
  const sgn = flip ? -1 : 1;
  const bis = (lead + angle / 2) * DEG;
  const t = sgn * (bis - Math.PI / 2);
  const ct = Math.cos(t);
  const st = Math.sin(t);
  const iX = r * ct;                                  // insert centre (world X, Z)
  const iZ = -r * st;
  // The two insert edges from the tip. Trailing (+Z, toward the shank) and
  // leading (−Z). Each `ratio` is the Z gained per unit up the shank along that
  // edge; the head bevels follow them so its walls lie on the insert's edges.
  const eX = ct + zScale * st, eZ = zScale * ct - st;      // trailing
  const fX = ct - zScale * st, fZ = -zScale * ct - st;     // leading
  const ratioBack = Math.abs(eX) > 1e-4 ? eZ / eX : 0;
  const ratioFront = Math.abs(fX) > 1e-4 ? fZ / fX : 0;
  const span = Math.max(ratioBack - ratioFront, 0.2);     // guard degenerate wedge

  // Vertical shank (front/back sides at constant Z) over a wedge head whose two
  // walls follow the insert's two edges. The head height gives a FIXED shank
  // width W for every insert angle, and the top sits at a FIXED height so all
  // four holders read the same width and height. `shift` nudges the shank +Z only
  // when a laid-over insert (MVJNR 80°) would otherwise poke its cutting edge past
  // the shank's front face; for MVVNN and the tighter MVJNR angles it is 0.
  const holderGeo = useMemo(() => {
    const W = s * 1.1;
    const topX = s * 5.0;            // fixed holder height (radial), same for every insert
    const Xbot = W / span;           // head height → shank width stays W across angles
    const shift = flip ? Math.max(0, r * fZ - Xbot * ratioFront) : 0;
    const Zf = Xbot * ratioFront + shift;    // front-bottom on the leading-edge line
    const Zb = Xbot * ratioBack + shift;     // back-bottom on the trailing-edge line
    const sh = new THREE.Shape();    // shape (x = world X, y = world Z)
    sh.moveTo(0, 0);                          // A tip
    sh.lineTo(Xbot, Zf);                      // B shank front-bottom (bevel = leading edge)
    sh.lineTo(topX, Zf);                      // C shank front-top (straight up +X)
    sh.lineTo(topX, Zb);                      // D shank back-top
    sh.lineTo(Xbot, Zb);                     // E shank back-bottom (bevel = trailing edge)
    sh.closePath();                           // E → A (head bottom-back edge)
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false });
    // rotateX maps the extrusion (shape +z) onto world −Y, so leaving it
    // untranslated hangs the solid from Y=0 down to −depth: the top face is the
    // cutting plane. (It used to be centred, which floated the tip off Y=0.)
    g.rotateX(Math.PI / 2);                   // shape (X,Z) → world XZ, depth → −Y
    g.computeVertexNormals();
    return g;
  }, [s, r, fZ, ratioFront, ratioBack, span, flip, depth]);

  useEffect(() => () => holderGeo.dispose(), [holderGeo]);

  return (
    <>
      <mesh geometry={holderGeo}>
        <meshStandardMaterial color="#a7afbd" metalness={0.6} roughness={0.42} side={THREE.DoubleSide} />
      </mesh>
      {/* Gold insert at the lead angle, acute corner at the tip. Its rake face
          sits on Y=0, so the cutting corner is exactly at spindle centre. */}
      <mesh position={[iX, -thickY / 2, iZ]} rotation={[0, t + baseRot, 0]} scale={[1, 1, zScale]}>
        <cylinderGeometry args={[r, r, thickY, sides]} />
        <meshStandardMaterial color="#e0a92a" metalness={0.72} roughness={0.3} />
      </mesh>
      {/* Centre clamp screw, head proud of the rake face. */}
      <mesh position={[iX, 0, iZ]}>
        <cylinderGeometry args={[s * 0.16, s * 0.16, thickY * 0.4, 14]} />
        <meshStandardMaterial color="#3f4653" metalness={0.6} roughness={0.45} />
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
  const sides = shape?.sides ?? 4;
  const angle = shape?.angle ?? 35;
  const s = Math.max(radius * 7, 6);
  const thickY = Math.max(radius * 2.4, 1.8);
  const r = s * 0.42;                                 // small insert
  const zScale = sides === 4 ? Math.max(Math.tan((angle / 2) * DEG), 0.2) : 1;
  const rBar = s * 0.55;                              // bar radius
  const barLen = s * 6;
  return (
    <>
      {/* Round bar along +Z, hanging below the cutting plane (its top is Y=0). */}
      <mesh position={[-rBar, -rBar, rBar + barLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[rBar, rBar, barLen, 20]} />
        <meshStandardMaterial color="#a7afbd" metalness={0.6} roughness={0.42} />
      </mesh>
      {/* Gold insert at the tip, acute corner down toward the axis, cutting the
          ID. Rake face on Y=0 so the cutting corner is at spindle centre. */}
      <mesh position={[-r * 0.4, -thickY / 2, r * 0.6]} rotation={[0, Math.PI / 4, 0]} scale={[1, 1, zScale]}>
        <cylinderGeometry args={[r, r, thickY, sides]} />
        <meshStandardMaterial color="#e0a92a" metalness={0.72} roughness={0.3} />
      </mesh>
    </>
  );
}

/**
 * A parting / grooving blade: a thin tall plate coming down to a narrow cutting
 * edge at the tip. `grooveW` sets the cut width. Marker only.
 */
function PartingBlade({ radius = 0.8, shape }) {
  const s = Math.max(radius * 7, 6);
  const w = Math.max((shape?.grooveW ?? 3) * 0.35, s * 0.18);  // blade thickness (Z)
  const bladeH = s * 5;
  const depth = Math.max(radius * 2.4, 1.8) * 1.4;
  return (
    <>
      {/* Thin blade rising from the tip, hanging below the cutting plane. */}
      <mesh position={[bladeH / 2, -depth / 2, 0]}>
        <boxGeometry args={[bladeH, depth, w]} />
        <meshStandardMaterial color="#a7afbd" metalness={0.6} roughness={0.42} />
      </mesh>
      {/* Cutting tip — a small block flush with the blade's leading (−Z) face,
          its top edge on Y=0 so the cut is at spindle centre. */}
      <mesh position={[s * 0.28, -depth * 1.02 / 2, 0]}>
        <boxGeometry args={[s * 0.55, depth * 1.02, w * 1.15]} />
        <meshStandardMaterial color="#e0a92a" metalness={0.72} roughness={0.3} />
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
  const steel = (c, r = 0.45) => <meshStandardMaterial color={c} metalness={0.55} roughness={r} />;

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

const DEG = Math.PI / 180;

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
  pos, rotary, radius, type, cutter, angle, length, insert, mode, showArbor = true,
  rotaryFrame = 'part',
}) {
  if (!pos) return null;
  const tilt = toolTilt(rotaryFrame, rotary);
  return (
    <group position={pos} rotation={[0, tilt.b, 0]}>
      <group rotation={[tilt.a, 0, 0]}>
        {mode === 'turn'
          ? <LatheTool radius={Math.min(radius, 1.6)} shape={insert} />
          : <EndMill radius={radius} type={type} cutter={cutter} angle={angle} length={length} arbor={showArbor} />}
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
    textShadow: '0 0 3px #000',
    userSelect: 'none',
    pointerEvents: 'none', // don't intercept orbit drags
  });
  return (
    <group>
      <Html position={[len, 0, 0]} center><div style={style('#ef4444')}>X</div></Html>
      <Html position={[0, len, 0]} center><div style={style('#22c55e')}>Y</div></Html>
      <Html position={[0, 0, len]} center><div style={style('#3b82f6')}>Z</div></Html>
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
      <lineBasicMaterial color="#475569" />
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
  toolCutter, toolAngle, toolLength, turnInsert, bufVer, drawVer, partVer, showPart = true,
  mode = 'mill', sketching = false, showArbor = true,
  rotaryFrame = 'part', rotaryCenter, simFrameA = 0, stockSolid = null,
}) {
  // Where the workpiece and the carved stock sit for this frame. They can differ:
  // the height-field sim carves one index in the machine frame, so its block is
  // already turned to `simFrameA` and must only travel the rest of the way.
  const a = toolRotary?.a ?? 0;
  const partT = workTransform(rotaryFrame, { a, center: rotaryCenter });
  const stockT = workTransform(rotaryFrame, { a, baseA: simFrameA, center: rotaryCenter });
  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[100, 100, 200]} intensity={0.6} />

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
          <Backplot drawVer={drawVer} />
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
  toolCutter, toolAngle, toolLength, turnInsert, bufVer, playhead, partVer, showPart = true,
  mode = 'mill', sketching = false, view = 'iso', viewNonce = 0, showArbor = true,
  rotaryFrame = 'part', rotaryCenter, simFrameA = 0, stockSolid = null,
}) {
  const controlsRef = useRef();
  // Disable orbit while dragging a sketch point so the drag moves the point,
  // not the camera (SolidWorks drags geometry, not the view).
  const sketchDragging = useSketchStore((s) => s.dragging);

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
  }, [drawVer, showStock, toolPos, toolRotary, toolRadius, toolType, toolLength, turnInsert, mode, partVer, showPart, showArbor, rotaryFrame, simFrameA, stockSolid, toolCutter, toolAngle]);

  return (
    <Canvas
      frameloop="demand"
      orthographic
      camera={{ position: [80, -80, 80], up: [0, 0, 1], zoom: 6, near: 0.1, far: 100000 }}
      style={{ background: '#0f172a' }}
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
        toolLength={toolLength}
        turnInsert={turnInsert}
        bufVer={bufVer}
        drawVer={drawVer}
        partVer={partVer}
        showPart={showPart}
        mode={mode}
        sketching={sketching}
        showArbor={showArbor}
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
      <OrbitControls ref={controlsRef} makeDefault enabled={!(sketching && sketchDragging)} minZoom={0.05} maxZoom={2000} />
    </Canvas>
  );
}
