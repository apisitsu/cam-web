/**
 * Section View: whether the part is cut open, across which axis, and where.
 *
 * `offset` is in the frame of the part on screen; null means "the middle of the
 * part", worked out where it is drawn, so turning the section on always shows
 * something. `flip` keeps the other side.
 */
import { create } from 'zustand';
import * as THREE from 'three';

export const useSectionStore = create((set, get) => ({
  active: false,
  axis: 1, // 0 X, 1 Y, 2 Z — Y cuts front-to-back, the usual first look inside
  offset: null,
  flip: false,

  toggle() { set({ active: !get().active, offset: null }); },
  setAxis(axis) { set({ axis, offset: null }); },
  setOffset(offset) { set({ offset }); },
  setFlip(flip) { set({ flip }); },
}));

/**
 * Which half stays by default, per axis: the one whose cut face looks at the
 * standard isometric view (from the front, the right and above) — the right end
 * is cut away across X, the front across Y, the top across Z. +1 keeps the half
 * above `coord`, −1 the half below.
 */
const KEEP = [-1, 1, -1];

/**
 * The clip plane for a section at `coord` along `axis`: three.js keeps what is
 * on the plane's positive side, so the normal points at the half that stays.
 */
export function sectionPlane(axis, coord, flip) {
  const keep = flip ? -KEEP[axis] : KEEP[axis];
  const n = new THREE.Vector3();
  n.setComponent(axis, keep);
  return new THREE.Plane(n, -keep * coord);
}
