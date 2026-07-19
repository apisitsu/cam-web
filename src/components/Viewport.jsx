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
import SketchLayer from './SketchLayer.jsx';
import { getBuf, setView } from '../engine/bufferCache.js';
import { sliceUpTo } from '../engine/gcode/path.js';
import { useSketchStore } from '../stores/sketchStore.js';

/**
 * Eye directions for each preset, in machine coordinates (X right, Y away,
 * Z up). Top/bottom look straight down the world up-axis, which would leave
 * OrbitControls' spherical coords degenerate, so they are tilted a hair off
 * the pole — enough to keep +Y pointing up the screen and orbiting sane.
 */
export const VIEW_DIRS = {
  iso:    [1, -1, 1],
  top:    [0, -1e-3, 1],
  bottom: [0, 1e-3, -1],
  front:  [0, -1, 0],
  back:   [0, 1, 0],
  right:  [1, 0, 0],
  left:   [-1, 0, 0],
};

/**
 * Turning overrides the side views. The lathe is drawn with the spindle along Z,
 * so **Front looks down the X axis and shows the Y-Z plane** (Z across, Y up);
 * the X-Z plane moved onto Right/Left. Top/bottom/iso keep the shared directions.
 */
export const TURN_VIEW_DIRS = {
  front: [-1, 0, 0],
  back:  [1, 0, 0],
  right: [0, 1, 0],
  left:  [0, -1, 0],
};

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
    // A lathe gets its own side views (see TURN_VIEW_DIRS): Front is the Y-Z
    // plane, looking down the X axis, with the spindle (Z) still across screen.
    const dirArr = (mode === 'turn' ? TURN_VIEW_DIRS[view] : null)
      ?? VIEW_DIRS[view] ?? VIEW_DIRS.iso;
    const dir = new THREE.Vector3(...dirArr).normalize();
    // Fit target = toolpath bounds unioned with the live sketch bounds, so an
    // explicit Fit frames whichever exists (or both). `sketchFit` is intentionally
    // read here but excluded from `fitKey`, so ongoing sketch edits don't refit.
    let fmin = bounds ? bounds.min : null;
    let fmax = bounds ? bounds.max : null;
    if (sketchFit) {
      fmin = fmin ? fmin.map((v, i) => Math.min(v, sketchFit.min[i])) : sketchFit.min;
      fmax = fmax ? fmax.map((v, i) => Math.max(v, sketchFit.max[i])) : sketchFit.max;
    }
    // Nothing loaded or drawn yet → frame a sensible working area around the
    // origin rather than the degenerate ±1 box. That box fits so tightly on the
    // origin point that the camera zooms in absurdly far. ±80 mm ≈ the Canvas'
    // initial zoom, so the app opens on a calm working area around the origin.
    const D = 80;
    const min = new THREE.Vector3(...(fmin ?? [-D, -D, 0]));
    const max = new THREE.Vector3(...(fmax ?? [D, D, 0]));
    const center = min.clone().add(max).multiplyScalar(0.5);

    // World up: milling is Z-up. Turning is drawn with the spindle along Z and
    // the radius along X, so making **X** up lays the part out horizontally with
    // the tool coming in from the top — the conventional lathe view.
    const worldUp = mode === 'turn'
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 0, 1);

    // Screen axes for this view. viewDir is camera→target (−dir); pick an up
    // reference that isn't parallel to it.
    const viewDir = dir.clone().negate();
    let upRef = worldUp.clone();
    if (Math.abs(viewDir.dot(upRef)) > 0.99) {
      // Looking straight down the world-up axis. On a lathe that's the new
      // Front/Back (down X), where Y up keeps the spindle (Z) running across the
      // screen instead of standing the part on end; Y also suits the mill's Top.
      upRef = new THREE.Vector3(0, 1, 0);
    }
    const right = new THREE.Vector3().crossVectors(viewDir, upRef).normalize();
    const up = new THREE.Vector3().crossVectors(right, viewDir).normalize();

    // Half-extents of the box along screen-right, screen-up, and the bounding
    // radius (for placing the camera outside the scene).
    let hw = 1e-3;
    let hh = 1e-3;
    let radius = 1e-3;
    const c = new THREE.Vector3();
    for (let xi = 0; xi < 2; xi++) {
      for (let yi = 0; yi < 2; yi++) {
        for (let zi = 0; zi < 2; zi++) {
          c.set(xi ? max.x : min.x, yi ? max.y : min.y, zi ? max.z : min.z).sub(center);
          hw = Math.max(hw, Math.abs(c.dot(right)));
          hh = Math.max(hh, Math.abs(c.dot(up)));
          radius = Math.max(radius, c.length());
        }
      }
    }

    // R3F sizes an ortho camera's frustum to the canvas pixels at zoom 1, so the
    // visible world span is (pixels / zoom). Pick the zoom that fits both axes,
    // with 8% breathing room.
    const margin = 1.08;
    const zoomX = canvasSize.width / (2 * hw * margin);
    const zoomY = canvasSize.height / (2 * hh * margin);
    camera.zoom = Math.max(Math.min(zoomX, zoomY), 1e-3);

    // Distance is irrelevant to ortho scale — only push far enough that the whole
    // scene sits inside a generous [near, far] slab, so zoom/orbit never clips.
    const dist = radius * 3 + 100;
    camera.up.copy(worldUp); // X-up for turning, Z-up for milling
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = 0.1;
    camera.far = dist + radius * 3 + 1000;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    if (controlsRef.current) {
      controlsRef.current.target.copy(center);
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
function EndMill({ radius = 3, type = 'flat', length = 0 }) {
  const noseOffset = type === 'ball' ? radius : 0; // ball nose occupies 0..radius
  const flute = Math.max(8, radius * 4);
  const arborR = Math.max(radius * 1.8, radius + 4);
  const colletLen = 26;
  // Distance from tip to the collet face. Below the flute length there is no
  // room for a shank, so clamp.
  const gauge = Math.max(length > 0 ? length : flute + radius * 3, flute + 1);
  const fluteLen = Math.min(flute, gauge - noseOffset);
  const shankR = Math.max(radius * 0.9, radius - 0.5);
  const shankBot = noseOffset + fluteLen;
  const shankLen = Math.max(0.01, gauge - shankBot);

  return (
    <>
      {/* Ball nose (full sphere; upper half is hidden inside the cutter). */}
      {type === 'ball' && (
        <mesh position={[0, 0, radius]}>
          <sphereGeometry args={[radius, 24, 16]} />
          <meshStandardMaterial color="#e2e8f0" metalness={0.6} roughness={0.3} />
        </mesh>
      )}
      {/* Cutter / flutes. */}
      <mesh position={[0, 0, noseOffset + fluteLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[radius, radius, fluteLen, 32]} />
        <meshStandardMaterial color="#cbd5e1" metalness={0.7} roughness={0.3} />
      </mesh>
      {/* Shank up to the collet face. */}
      <mesh position={[0, 0, shankBot + shankLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[shankR, shankR, shankLen, 24]} />
        <meshStandardMaterial color="#94a3b8" metalness={0.6} roughness={0.35} />
      </mesh>
      {/* Collet / holder above the gauge line. */}
      <mesh position={[0, 0, gauge + colletLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[arborR, arborR * 0.7, colletLen, 32]} />
        <meshStandardMaterial color="#eab308" metalness={0.75} roughness={0.25} />
      </mesh>
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
  const depth = thickY * 1.5;                         // holder depth (Y)
  const front = depth / 2;                            // holder front face (toward camera +Y)

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
    g.translate(0, 0, -depth / 2);            // centre the depth (Y)
    g.rotateX(Math.PI / 2);                   // shape (X,Z) → world XZ, depth → Y
    g.computeVertexNormals();
    return g;
  }, [s, r, fZ, ratioFront, ratioBack, span, flip, depth]);

  useEffect(() => () => holderGeo.dispose(), [holderGeo]);

  return (
    <>
      <mesh geometry={holderGeo}>
        <meshStandardMaterial color="#a7afbd" metalness={0.6} roughness={0.42} side={THREE.DoubleSide} />
      </mesh>
      {/* Gold insert at the lead angle, acute corner at the tip. */}
      <mesh position={[iX, front, iZ]} rotation={[0, t + baseRot, 0]} scale={[1, 1, zScale]}>
        <cylinderGeometry args={[r, r, thickY, sides]} />
        <meshStandardMaterial color="#e0a92a" metalness={0.72} roughness={0.3} />
      </mesh>
      {/* Centre clamp screw on the insert face. */}
      <mesh position={[iX, front + thickY * 0.75, iZ]}>
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
      {/* Round bar along +Z, its top just under the tip so the insert pokes up. */}
      <mesh position={[-rBar, 0, rBar + barLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[rBar, rBar, barLen, 20]} />
        <meshStandardMaterial color="#a7afbd" metalness={0.6} roughness={0.42} />
      </mesh>
      {/* Gold insert at the tip, acute corner down toward the axis, cutting the ID. */}
      <mesh position={[-r * 0.4, 0, r * 0.6]} rotation={[0, Math.PI / 4, 0]} scale={[1, 1, zScale]}>
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
      {/* Thin blade rising from the tip. */}
      <mesh position={[bladeH / 2, 0, 0]}>
        <boxGeometry args={[bladeH, depth, w]} />
        <meshStandardMaterial color="#a7afbd" metalness={0.6} roughness={0.42} />
      </mesh>
      {/* Cutting tip — a small block flush with the blade's leading (−Z) face. */}
      <mesh position={[s * 0.28, 0, 0]}>
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
 * Cutting tool at the current tip. On a 4-/5-axis program the backplot geometry
 * is drawn in the *part* frame (the table's rotation is undone so each face sits
 * where it belongs), so the tool has to be tilted the same way to stand normal
 * to the face being cut — otherwise it points straight up +Z through the side of
 * the part. `rotary` carries the A (about X) and B (about Y) index in degrees;
 * nesting the groups composes Ry(-B)·Rx(-A), matching the interpreter's
 * toPartFrame(). The tip stays pinned at `pos` because every rotation is about
 * the group origin.
 */
function Tool({ pos, rotary, radius, type, length, insert, mode }) {
  if (!pos) return null;
  const thetaA = -(rotary?.a || 0) * DEG;
  const thetaB = -(rotary?.b || 0) * DEG;
  return (
    <group position={pos} rotation={[0, thetaB, 0]}>
      <group rotation={[thetaA, 0, 0]}>
        {mode === 'turn'
          ? <LatheTool radius={Math.min(radius, 1.6)} shape={insert} />
          : <EndMill radius={radius} type={type} length={length} />}
      </group>
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

export default function Viewport({
  bounds, fitBounds, sketchFit, turnChuck, showStock, toolPos, toolRotary, toolRadius, toolType,
  toolLength, turnInsert, bufVer, playhead,
  mode = 'mill', sketching = false, view = 'iso', viewNonce = 0,
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
  }, [drawVer, showStock, toolPos, toolRotary, toolRadius, toolType, toolLength, turnInsert, mode]);

  return (
    <Canvas
      orthographic
      camera={{ position: [80, -80, 80], up: [0, 0, 1], zoom: 6, near: 0.1, far: 100000 }}
      style={{ background: '#0f172a' }}
    >
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

          <Backplot drawVer={drawVer} />
          <StockMesh simVer={bufVer} visible={showStock} />
          <Tool
            pos={toolPos}
            rotary={toolRotary}
            radius={toolRadius}
            type={toolType}
            length={toolLength}
            insert={turnInsert}
            mode={mode}
          />
        </>
      )}

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
