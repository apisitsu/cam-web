import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { sectionPlane, useSectionStore } from './sectionStore.js';

const kept = (plane, p) => plane.distanceToPoint(new THREE.Vector3(...p)) >= 0;

describe('sectionPlane', () => {
  it('keeps the half whose cut face looks at the isometric view', () => {
    expect(kept(sectionPlane(0, 10, false), [5, 0, 0])).toBe(true); // right end cut away
    expect(kept(sectionPlane(0, 10, false), [15, 0, 0])).toBe(false);
    expect(kept(sectionPlane(1, 10, false), [0, 15, 0])).toBe(true); // front cut away
    expect(kept(sectionPlane(2, 10, false), [0, 0, 5])).toBe(true); // top cut away
  });

  it('keeps the other half when flipped', () => {
    expect(kept(sectionPlane(1, 10, true), [0, 5, 0])).toBe(true);
    expect(kept(sectionPlane(1, 10, true), [0, 15, 0])).toBe(false);
  });
});

describe('useSectionStore', () => {
  it('starts each section at the middle of the part again', () => {
    const s = useSectionStore.getState();
    s.toggle();
    s.setOffset(3);
    s.setAxis(2);
    expect(useSectionStore.getState().offset).toBe(null);
    s.toggle();
    expect(useSectionStore.getState().active).toBe(false);
  });
});
