/**
 * Dependency-free validation of the voxel (undercut-capable) sim.
 * Run:  node --test src/engine/sim/voxel_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoxelStock, carveVoxelMove, carveVoxels, voxelSurfaceMesh, toolAxisFor,
} from './voxel.js';

const bounds = { min: [-10, -10, -10], max: [10, 10, 10] };

test('toolAxisFor matches the part-frame rotation of machine +Z', () => {
  const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  assert.ok(near(toolAxisFor(0, 0), [0, 0, 1]));   // no index -> straight up
  assert.ok(near(toolAxisFor(90, 0), [0, 1, 0]));  // A90 -> +Y
  assert.ok(near(toolAxisFor(270, 0), [0, -1, 0])); // A270 -> -Y
  assert.ok(near(toolAxisFor(0, 90), [-1, 0, 0])); // B90 -> -X
});

test('a Z-down plunge clears a vertical column of voxels', () => {
  const v = createVoxelStock(bounds, { margin: 0, cellSize: 1 });
  const before = v.solid.reduce((s, x) => s + x, 0);
  // Plunge straight down at the centre with a Ø4 flat tool.
  carveVoxelMove(v, [0, 0, 10], [0, 0, -5], [0, 0, 1], { radius: 2, type: 'flat' });
  const after = v.solid.reduce((s, x) => s + x, 0);
  assert.ok(after < before, 'material should be removed');
  // Everything above z=-5 within the tool radius at the centre must be gone.
  const idx = (i, j, k) => k * v.nx * v.ny + j * v.nx + i;
  const ci = Math.floor((0 - v.ox) / v.cs);
  const cj = Math.floor((0 - v.oy) / v.cs);
  const kAbove = Math.floor((3 - v.oz) / v.cs);   // z=+3, above the cut
  const kBelow = Math.floor((-8 - v.oz) / v.cs);  // z=-8, below the tip
  assert.equal(v.solid[idx(ci, cj, kAbove)], 0, 'above the tip is cleared');
  assert.equal(v.solid[idx(ci, cj, kBelow)], 1, 'below the tip stays solid');
});

test('UNDERCUT: a tool reaching in from +Y leaves material above the pocket', () => {
  // This is the case a Z-up height field cannot represent: cut a horizontal
  // bore into the +Y face at mid-height, and material above it must survive.
  const v = createVoxelStock(bounds, { margin: 0, cellSize: 1 });
  const axis = toolAxisFor(90, 0); // tool points +Y (A90 index)
  // Tip travels from y=+10 inward to y=-2, at z=0 (mid-height), x=0.
  carveVoxelMove(v, [0, 10, 0], [0, -2, 0], axis, { radius: 2.5, type: 'flat', length: 30 });

  const idx = (i, j, k) => k * v.nx * v.ny + j * v.nx + i;
  const ci = Math.floor((0 - v.ox) / v.cs);
  const cj = Math.floor((0 - v.oy) / v.cs); // y=0, inside the bore
  const kMid = Math.floor((0 - v.oz) / v.cs);   // z=0, on the bore axis
  const kAbove = Math.floor((6 - v.oz) / v.cs); // z=+6, roof over the bore

  assert.equal(v.solid[idx(ci, cj, kMid)], 0, 'the bore itself is hollow');
  assert.equal(v.solid[idx(ci, cj, kAbove)], 1, 'material above the bore SURVIVES (undercut)');
});

test('carveVoxels drives all segments with per-tool geometry + orientation', () => {
  const v = createVoxelStock(bounds, { margin: 0, cellSize: 1 });
  const segments = [
    { type: 'rapid', a: [0, 0, 20], b: [0, 0, 10], a4: 0, b4: 0, tool: 1 },
    { type: 'feed', a: [0, 0, 10], b: [0, 0, -5], a4: 0, b4: 0, tool: 1 },
    { type: 'feed', a: [0, 10, 0], b: [0, -2, 0], a4: 90, b4: 0, tool: 2 },
  ];
  const geom = new Map([[1, { radius: 2, type: 'flat' }], [2, { radius: 2.5, type: 'flat', length: 30 }]]);
  const resolve = (s) => geom.get(s.tool) || { radius: 1, type: 'flat' };
  const { removedVolume } = carveVoxels(v, segments, resolve);
  assert.ok(removedVolume > 0, 'material removed across both orientations');
});

test('voxelSurfaceMesh emits only exposed faces, as a closed hull', () => {
  const v = createVoxelStock({ min: [0, 0, 0], max: [2, 2, 2] }, { margin: 0, cellSize: 1 });
  const mesh = voxelSurfaceMesh(v);
  // A solid a×b×c block exposes 2(ab+bc+ca) unit faces; interior faces are hidden.
  const { nx, ny, nz } = v;
  const expectedQuads = 2 * (nx * ny + ny * nz + nz * nx);
  assert.equal(mesh.quads, expectedQuads, `${mesh.quads} vs ${expectedQuads}`);
  assert.equal(mesh.indices.length, expectedQuads * 6);
  assert.equal(mesh.positions.length, expectedQuads * 4 * 3);
  // Every normal is a unit axis vector.
  for (let i = 0; i < mesh.normals.length; i += 3) {
    const m = Math.abs(mesh.normals[i]) + Math.abs(mesh.normals[i + 1]) + Math.abs(mesh.normals[i + 2]);
    assert.equal(m, 1);
  }
});
