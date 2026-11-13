/**
 * Section View — the part cut open by a plane square to X, Y or Z.
 *
 * The part's own material is clipped (`useSectionClip`), and the opening is
 * closed with the section face (`SectionCap`), so what shows is a cut solid, not
 * a hollow shell. Only the part is cut: the sketch, the planes and the toolpath
 * stay whole.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import {
  Segmented, Slider, Button, Tooltip,
} from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import { useSectionStore, sectionPlane } from '../stores/sectionStore.js';
import { getMesh, getRawMesh } from '../stores/camPlanStore.js';
import { boundsOf } from '../engine/mesh/analyze.js';
import { sectionCap } from '../engine/mesh/sectionCap.js';

/** Section faces in the colour CAD packages use for a cut: a warm, flat fill. */
const CAP_COLOR = '#e0a35a';

function partBounds(raw) {
  const { soup } = raw ? getRawMesh() : getMesh();
  return soup?.triangleCount ? boundsOf(soup) : null;
}

/** Where the section is, along its axis: the stored offset, or the part's middle. */
function sectionCoord(state, bounds) {
  if (Number.isFinite(state.offset)) return state.offset;
  if (!bounds) return 0;
  return (bounds.min[state.axis] + bounds.max[state.axis]) / 2;
}

/**
 * The clip planes for the part's material, or null when the section is off.
 * `meshVer` keeps "the middle" following a rebuilt part.
 */
export function useSectionClip(raw, meshVer) {
  const state = useSectionStore();
  return useMemo(() => {
    if (!state.active) return null;
    const coord = sectionCoord(state, partBounds(raw));
    return [sectionPlane(state.axis, coord, state.flip)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active, state.axis, state.offset, state.flip, raw, meshVer]);
}

/** The cut face, drawn where the plane is. Also switches clipping on in the renderer. */
export function SectionCap({ raw = false, meshVer }) {
  const gl = useThree((s) => s.gl);
  const state = useSectionStore();
  useEffect(() => { gl.localClippingEnabled = true; }, [gl]);
  const geometry = useMemo(() => {
    if (!state.active) return null;
    const { welded } = raw ? getRawMesh() : getMesh();
    if (!welded) return null;
    const coord = sectionCoord(state, partBounds(raw));
    const pos = sectionCap(welded, state.axis, coord);
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active, state.axis, state.offset, raw, meshVer]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <mesh geometry={geometry} raycast={() => null} name="section-cap">
      <meshBasicMaterial color={CAP_COLOR} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
    </mesh>
  );
}

/** The controls beside the Section button: which axis, where, and which side. */
export function SectionControls({ raw = false }) {
  const state = useSectionStore();
  const bounds = partBounds(raw);
  if (!state.active || !bounds) return null;
  const lo = bounds.min[state.axis];
  const hi = bounds.max[state.axis];
  const coord = sectionCoord(state, bounds);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} data-section-controls>
      <Segmented
        size="small"
        value={state.axis}
        onChange={(v) => state.setAxis(v)}
        options={[{ value: 0, label: 'X' }, { value: 1, label: 'Y' }, { value: 2, label: 'Z' }]}
      />
      <Slider
        min={Math.floor(lo * 10) / 10}
        max={Math.ceil(hi * 10) / 10}
        step={0.1}
        value={Math.round(coord * 10) / 10}
        onChange={(v) => state.setOffset(v)}
        style={{ width: 140, margin: '0 6px' }}
        tooltip={{ formatter: (v) => `${'XYZ'[state.axis]} ${v}` }}
      />
      <Tooltip title="Keep the other side">
        <Button size="small" icon={<SwapOutlined />} type={state.flip ? 'primary' : 'default'} onClick={() => state.setFlip(!state.flip)} />
      </Tooltip>
    </span>
  );
}
