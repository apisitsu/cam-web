/**
 * Dependency-free validation of the Phase 1 dexel material-removal engine.
 * Run:  node --test src/engine/sim/_node_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStock, stockFromBounds, stamp, cutSegment, simulate } from './dexel.js';
import { heightmapToMesh, heightmapToSolidMesh } from './mesh.js';
import { toolResolver } from './session.js';
import { interpret } from '../gcode/interpreter.js';
import { parseToolTable } from '../gcode/tools.js';

const near = (a, b, eps) => Math.abs(a - b) <= eps;

test('createStock discretises bounds correctly', () => {
  const s = createStock({ xMin: 0, yMin: 0, xMax: 10, yMax: 20, top: 5, cellSize: 1 });
  assert.equal(s.nx, 10);
  assert.equal(s.ny, 20);
  assert.equal(s.heights.length, 200);
  assert.ok(s.heights.every((h) => h === 5));
});

test('flat stamp removes ~π·r²·depth and lowers cells', () => {
  const s = createStock({ xMin: -10, yMin: -10, xMax: 10, yMax: 10, top: 0, cellSize: 0.25 });
  const removed = stamp(s, 0, 0, -3, { radius: 4, type: 'flat' });
  const expected = Math.PI * 16 * 3; // disc area × depth
  // Grid discretisation → within a few percent.
  assert.ok(near(removed, expected, expected * 0.05), `removed=${removed} expected≈${expected}`);
  // Centre cell lowered to tool tip.
  const ci = Math.floor((0 - s.xMin) / s.cellSize);
  const cj = Math.floor((0 - s.yMin) / s.cellSize);
  assert.ok(near(s.heights[cj * s.nx + ci], -3, 1e-6));
  // A cell outside the tool radius is untouched.
  const oi = Math.floor((8 - s.xMin) / s.cellSize);
  assert.equal(s.heights[cj * s.nx + oi], 0);
});

test('ball tool leaves a rounded bottom (centre deeper than edge)', () => {
  const s = createStock({ xMin: -6, yMin: -6, xMax: 6, yMax: 6, top: 0, cellSize: 0.25 });
  stamp(s, 0, 0, -2, { radius: 4, type: 'ball' });
  const ci = Math.floor((0 - s.xMin) / s.cellSize);
  const cj = Math.floor((0 - s.yMin) / s.cellSize);
  const centre = s.heights[cj * s.nx + ci];
  const edgeI = Math.floor((3.5 - s.xMin) / s.cellSize); // near tool edge
  const edge = s.heights[cj * s.nx + edgeI];
  assert.ok(centre < edge, `centre=${centre} should be below edge=${edge}`);
  // Near the axis the ball tip ≈ -2; allow one cell of radial offset from the grid.
  assert.ok(near(centre, -2, 0.02), `centre=${centre} expected≈-2`);
});

test('cutSegment carves a continuous slot (no skipped stamps)', () => {
  const s = createStock({ xMin: -2, yMin: -2, xMax: 22, yMax: 2, top: 0, cellSize: 0.5 });
  const removed = cutSegment(s, [0, 0, -1], [20, 0, -1], { radius: 1, type: 'flat' });
  assert.ok(removed > 0);
  // Every cell along the centre line at y≈0 should be cut to -1.
  const cj = Math.floor((0 - s.yMin) / s.cellSize);
  for (let x = 1; x <= 19; x++) {
    const ci = Math.floor((x - s.xMin) / s.cellSize);
    assert.ok(near(s.heights[cj * s.nx + ci], -1, 1e-6), `gap at x=${x}`);
  }
});

test('simulate ignores rapids, only feeds remove material', () => {
  const s1 = createStock({ xMin: -2, yMin: -2, xMax: 12, yMax: 2, top: 0, cellSize: 0.5 });
  const s2 = createStock({ xMin: -2, yMin: -2, xMax: 12, yMax: 2, top: 0, cellSize: 0.5 });
  const tool = { radius: 1 };
  const feed = [{ type: 'feed', a: [0, 0, -1], b: [10, 0, -1] }];
  const rapid = [{ type: 'rapid', a: [0, 0, -1], b: [10, 0, -1] }];
  const rFeed = simulate(s1, feed, tool).removedVolume;
  const rRapid = simulate(s2, rapid, tool).removedVolume;
  assert.ok(rFeed > 0);
  assert.equal(rRapid, 0);
});

test('heightmapToMesh yields nx·ny verts and 2 tris per quad', () => {
  const s = createStock({ xMin: 0, yMin: 0, xMax: 4, yMax: 3, top: 0, cellSize: 1 });
  const { positions, indices } = heightmapToMesh(s);
  assert.equal(positions.length, s.nx * s.ny * 3);
  assert.equal(indices.length, (s.nx - 1) * (s.ny - 1) * 6);
  // Every index is in range.
  assert.ok(indices.every((ix) => ix < s.nx * s.ny));
});

test('heightmapToSolidMesh is a closed box: doubled verts, walls, bottom, in-range', () => {
  const s = createStock({ xMin: 0, yMin: 0, xMax: 4, yMax: 3, top: 0, base: -10, cellSize: 1 });
  const { positions, indices } = heightmapToSolidMesh(s);
  const N = s.nx * s.ny;
  assert.equal(positions.length, N * 2 * 3); // top grid + mirrored floor grid
  const topTris = (s.nx - 1) * (s.ny - 1) * 2;
  const wallTris = (2 * (s.nx - 1) + 2 * (s.ny - 1)) * 2;
  assert.equal(indices.length, (topTris + wallTris + 2) * 3); // +2 bottom tris
  assert.ok(indices.every((ix) => ix < N * 2));
  // Floor verts sit at/below base; some floor Z equals the billet bottom.
  let floorZ = Infinity;
  for (let g = N; g < 2 * N; g++) floorZ = Math.min(floorZ, positions[g * 3 + 2]);
  assert.ok(floorZ <= s.base + 1e-6);
});

test('end-to-end: parse G-code then simulate removes material', () => {
  const prog = ['G21 G90 G0 Z5', 'G0 X0 Y0', 'G1 Z-2 F100', 'G1 X30', 'G1 Y10', 'G0 Z5'].join('\n');
  const { segments, bounds } = interpret(prog);
  const stock = stockFromBounds(bounds, { margin: 3, cellSize: 0.5 });
  const { removedVolume } = simulate(stock, segments, { radius: 2 });
  assert.ok(removedVolume > 0);
  // Some stock cell was actually lowered below the original top.
  assert.ok(stock.heights.some((h) => h < stock.top));
});

test('parseToolTable reads type, diameter and length from comments', () => {
  const prog = [
    'T1(SHOULDERMILL D32 - FACE MILLING)', 'M6',
    'T2(DRILL 9 CB - PRE-DRILL)', 'M6',
    'T3(ENDMILL D7 L48-54 - ROUGH B2)', 'M6',
    'T8(REAMER D3)', 'M6',
    'T9(BALLNOSE D6 - FINISH)', 'M6',
  ].join('\n');
  const t = parseToolTable(prog);
  assert.equal(t.get(1).type, 'facemill');
  assert.equal(t.get(1).diameter, 32);
  assert.equal(t.get(2).type, 'drill');
  assert.equal(t.get(2).diameter, 9);          // bare number, no D word
  assert.equal(t.get(3).type, 'endmill');
  assert.equal(t.get(3).radius, 3.5);          // D7 -> radius 3.5
  assert.equal(t.get(3).length, 48);
  assert.equal(t.get(3).lengthMax, 54);
  assert.equal(t.get(8).type, 'reamer');
  assert.equal(t.get(9).simType, 'ball');      // ball-nose carves rounded
});

test('per-tool geometry: each move carves at its own detected diameter', () => {
  // Same slot cut twice: once tagged as a Ø4 tool, once as a Ø12 tool. The
  // wider tool must remove more material, proving the resolver picks per-tool.
  const feed = (tool) => ({ type: 'feed', a: [0, 0, -1], b: [20, 0, -1], tool });
  const tools = [
    { n: 1, simType: 'flat', radius: 2 },
    { n: 2, simType: 'flat', radius: 6 },
  ];
  const resolve = toolResolver(tools, { radius: 1, type: 'flat' });

  const narrow = createStock({ xMin: -8, yMin: -8, xMax: 28, yMax: 8, top: 0, cellSize: 0.5 });
  const wide = createStock({ xMin: -8, yMin: -8, xMax: 28, yMax: 8, top: 0, cellSize: 0.5 });
  const vN = simulate(narrow, [feed(1)], resolve).removedVolume;
  const vW = simulate(wide, [feed(2)], resolve).removedVolume;
  assert.ok(vW > vN * 2, `Ø12 (${vW}) should remove far more than Ø4 (${vN})`);

  // A move whose tool isn't in the table falls back to the default cutter.
  const fb = createStock({ xMin: -8, yMin: -8, xMax: 28, yMax: 8, top: 0, cellSize: 0.5 });
  assert.ok(simulate(fb, [feed(99)], resolve).removedVolume > 0);
});

test('tool-table overrides win over detected geometry', () => {
  // Detected as Ø4, but the user pins T1 to Ø12 and a ball nose.
  const tools = [{ n: 1, simType: 'flat', radius: 2, diameter: 4 }];
  const overrides = { 1: { diameter: 12, simType: 'ball' } };
  const resolve = toolResolver(tools, { radius: 1, type: 'flat' }, overrides);
  const t = resolve({ tool: 1 });
  assert.equal(t.radius, 6, 'Ø12 override -> radius 6');
  assert.equal(t.type, 'ball');
  // An override can also define a tool the comments never mentioned.
  const resolve2 = toolResolver([], { radius: 1, type: 'flat' }, { 5: { diameter: 8 } });
  assert.equal(resolve2({ tool: 5 }).radius, 4);
});
