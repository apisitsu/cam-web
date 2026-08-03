/**
 * Is the carved stock square to the tool?
 *
 * The reported symptom: "the material removed is not square with the cutting
 * tool" — a pocket wall leaning instead of standing vertical. It was never a
 * carving error. The height field held the right numbers and the triangulation
 * misrepresented them: one vertex per cell at its *centre*, quads joining
 * neighbours, so the step between a full cell and a cut one was drawn as a
 * single sloped face spanning the gap between the two centres.
 *
 * The invariant that fixes it is easy to state and easy to check: a height
 * field has flat tops and vertical walls, so **every triangle in the mesh is
 * axis-aligned**. Any sloped facet is the bug coming back.
 */
import { describe, it, expect } from 'vitest';
import { createStock, stamp, cutSegment } from './dexel.js';
import { heightmapToSolidMesh } from './mesh.js';

/** A block with a square pocket cut 5 mm into it. */
function pocketed({ cellSize = 1 } = {}) {
  const s = createStock({
    xMin: 0, yMin: 0, xMax: 20, yMax: 20, top: 0, base: -10, cellSize,
  });
  for (let x = 6; x <= 14; x += cellSize / 4) {
    for (let y = 6; y <= 14; y += cellSize / 4) {
      stamp(s, x, y, -5, { radius: 0.1, type: 'flat' });
    }
  }
  return s;
}

/** Unit normals of every non-degenerate triangle. */
function normals(mesh) {
  const out = [];
  for (let k = 0; k < mesh.indices.length; k += 3) {
    const p = [0, 1, 2].map((n) => {
      const i = mesh.indices[k + n] * 3;
      return [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
    });
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const w = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = [
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    ];
    const len = Math.hypot(...n);
    if (len > 1e-9) out.push(n.map((c) => c / len));
  }
  return out;
}

const axisAligned = (n) => Math.max(...n.map(Math.abs)) > 0.9999;

describe('the carved surface is square to the tool', () => {
  it('has no sloped facet anywhere', () => {
    const mesh = heightmapToSolidMesh(pocketed());
    const bad = normals(mesh).filter((n) => !axisAligned(n));
    expect(bad).toHaveLength(0);
  });

  it('holds at a fine cell size too', () => {
    const bad = normals(heightmapToSolidMesh(pocketed({ cellSize: 0.25 })))
      .filter((n) => !axisAligned(n));
    expect(bad).toHaveLength(0);
  });

  it('holds for a sloped RAMP cut, where the steps are real', () => {
    // A ramped move genuinely leaves a staircase in a height field. Each tread
    // is still flat and each riser still vertical — the steps are the honest
    // resolution limit, not a smoothed-over wall.
    const s = createStock({
      xMin: 0, yMin: 0, xMax: 20, yMax: 20, top: 0, base: -10, cellSize: 0.5,
    });
    cutSegment(s, [2, 10, -1], [18, 10, -8], { radius: 2, type: 'flat' });
    const bad = normals(heightmapToSolidMesh(s)).filter((n) => !axisAligned(n));
    expect(bad).toHaveLength(0);
  });

  it('holds for a ball nose, whose surface is genuinely curved', () => {
    const s = createStock({
      xMin: 0, yMin: 0, xMax: 20, yMax: 20, top: 0, base: -10, cellSize: 0.5,
    });
    cutSegment(s, [4, 10, -4], [16, 10, -4], { radius: 3, type: 'ball' });
    const bad = normals(heightmapToSolidMesh(s)).filter((n) => !axisAligned(n));
    expect(bad).toHaveLength(0);
  });

  it('still produces a closed solid, not a floating sheet', () => {
    const mesh = heightmapToSolidMesh(pocketed());
    const ns = normals(mesh);
    const has = (axis, sign) => ns.some((n) => Math.abs(n[axis] - sign) < 1e-6);
    expect(has(2, 1) || has(2, -1)).toBe(true);   // tops / floor
    expect(has(0, 1) || has(0, -1)).toBe(true);   // X walls
    expect(has(1, 1) || has(1, -1)).toBe(true);   // Y walls
  });
});

describe('the pocket that was cut is the pocket that is drawn', () => {
  it('puts the wall at the edge of the cut, not half a cell inside it', () => {
    // Vertices used to sit at cell CENTRES, so the wall landed half a cell off
    // as well as leaning. Corners now sit on the grid lines.
    const mesh = heightmapToSolidMesh(pocketed({ cellSize: 1 }));
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] < minX) minX = mesh.positions[i];
      if (mesh.positions[i] > maxX) maxX = mesh.positions[i];
    }
    expect(minX).toBeCloseTo(0);    // the billet's own edge, exactly
    expect(maxX).toBeCloseTo(20);
  });

  it('reaches the pocket floor', () => {
    const mesh = heightmapToSolidMesh(pocketed());
    let atFloor = 0;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      if (Math.abs(mesh.positions[i] + 5) < 1e-6) atFloor++;
    }
    expect(atFloor).toBeGreaterThan(0);
  });

  it('leaves the untouched top at Z0', () => {
    const mesh = heightmapToSolidMesh(pocketed());
    let atTop = 0;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      if (Math.abs(mesh.positions[i]) < 1e-6) atTop++;
    }
    expect(atTop).toBeGreaterThan(0);
  });
});
