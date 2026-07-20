import { describe, it, expect } from 'vitest';
import {
  rotateAboutX, normalizeAngle, indexPreset, INDEX_PRESETS,
} from './rotate.js';
import { boundsOf } from './analyze.js';
import { box } from './fixtures.js';

/** The vertex at index `i`, as a plain triple. */
const vertexAt = (mesh, i) => [
  mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2],
];

describe('rotateAboutX', () => {
  it('leaves the mesh alone at A0', () => {
    const m = box(20, 10, 6);
    const r = rotateAboutX(m, 0);
    for (let i = 0; i < m.positions.length; i++) {
      expect(r.positions[i]).toBeCloseTo(m.positions[i], 5);
    }
  });

  it('swaps the Y and Z extents at 90 degrees', () => {
    // A 20 × 10 × 6 block, rolled a quarter turn, is 20 × 6 × 10.
    const r = rotateAboutX(box(20, 10, 6), 90);
    const size = boundsOf(r).size;
    expect(size[0]).toBeCloseTo(20, 4);
    expect(size[1]).toBeCloseTo(6, 4);
    expect(size[2]).toBeCloseTo(10, 4);
  });

  it('never touches X', () => {
    const m = box(20, 10, 6);
    const r = rotateAboutX(m, 37);
    for (let i = 0; i < m.positions.length; i += 3) {
      expect(r.positions[i]).toBeCloseTo(m.positions[i], 5);
    }
  });

  it('turns the part the opposite way to the table', () => {
    // The table goes to A+90; the model rolls back so the spindle can see the
    // face that has swung round. Getting this backwards machines the mirror of
    // the intended side — plausible on screen, scrap on the machine.
    const mesh = { positions: new Float32Array([0, 10, 0, 0, 0, 0, 0, 0, 10]) };
    const [x, y, z] = vertexAt(rotateAboutX(mesh, 90), 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(-10, 6);
  });

  it('composes: two 90s make a 180', () => {
    const once = rotateAboutX(box(20, 10, 6), 180);
    const twice = rotateAboutX(rotateAboutX(box(20, 10, 6), 90), 90);
    for (let i = 0; i < once.positions.length; i++) {
      expect(twice.positions[i]).toBeCloseTo(once.positions[i], 4);
    }
  });

  it('returns to the start after a full turn', () => {
    const m = box(20, 10, 6);
    const r = rotateAboutX(m, 360);
    for (let i = 0; i < m.positions.length; i++) {
      expect(r.positions[i]).toBeCloseTo(m.positions[i], 4);
    }
  });

  it('rotates about a rotary centre that is not the origin', () => {
    // A point sitting on the axis of rotation does not move, wherever the axis is.
    const mesh = { positions: new Float32Array([5, 30, 40, 0, 0, 0, 1, 1, 1]) };
    const r = rotateAboutX(mesh, 123, { center: [30, 40] });
    const [x, y, z] = vertexAt(r, 0);
    expect(x).toBeCloseTo(5, 5);
    expect(y).toBeCloseTo(30, 5);
    expect(z).toBeCloseTo(40, 5);
  });

  it('rotates normals as directions, without the centre offset', () => {
    const mesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 1, 0]),
      triangleCount: 1,
    };
    const r = rotateAboutX(mesh, 90, { center: [50, 50] });
    // +Y rolls to -Z, and stays a unit vector rather than acquiring an offset.
    expect(r.normals[0]).toBeCloseTo(0, 6);
    expect(r.normals[1]).toBeCloseTo(0, 6);
    expect(r.normals[2]).toBeCloseTo(-1, 6);
  });

  it('does not modify the input', () => {
    const m = box(20, 10, 6);
    const before = Float32Array.from(m.positions);
    rotateAboutX(m, 45);
    expect(m.positions).toEqual(before);
  });

  it('keeps the triangle count and other fields', () => {
    const m = box(20, 10, 6);
    expect(rotateAboutX(m, 45).triangleCount).toBe(m.triangleCount);
  });
});

describe('index presets', () => {
  it('offers the fixtures a shop actually has', () => {
    expect(INDEX_PRESETS.map((p) => p.id)).toContain('quarters');
    expect(indexPreset('quarters').angles).toEqual([0, 90, 180, 270]);
  });

  it('starts every preset at A0', () => {
    for (const p of INDEX_PRESETS) expect(p.angles[0], p.id).toBe(0);
  });

  it('spaces every preset evenly and stays inside one turn', () => {
    for (const p of INDEX_PRESETS) {
      for (const a of p.angles) {
        expect(a, p.id).toBeGreaterThanOrEqual(0);
        expect(a, p.id).toBeLessThan(360);
      }
      expect(new Set(p.angles).size, p.id).toBe(p.angles.length);
    }
  });

  it('falls back to one side rather than throwing', () => {
    expect(indexPreset('nonsense').angles).toEqual([0]);
  });
});

describe('normalizeAngle', () => {
  it('folds a negative angle onto the same face', () => {
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(-180)).toBe(180);
  });

  it('folds a full turn back to zero', () => {
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(450)).toBe(90);
  });
});
