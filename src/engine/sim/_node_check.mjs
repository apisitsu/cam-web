/**
 * Dependency-free validation of the Phase 1 dexel material-removal engine.
 * Run:  node --test src/engine/sim/_node_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStock, stockFromBounds, stamp, cutSegment, simulate } from './dexel.js';
import { heightmapToMesh, heightmapToSolidMesh } from './mesh.js';
import { CUT, RAW } from './stockColors.js';
import { toolResolver } from './session.js';
import { interpret } from '../gcode/interpreter.js';
import { parseToolTable } from '../gcode/tools.js';
import {
  runSimulation, runVoxelSimulation, createVoxelSession, carveVoxelSessionTo,
  createSession, carveTo,
} from './index.js';

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

test('heightmapToSolidMesh is a stepped solid: quads, floor, in-range', () => {
  // This check still described the ORIGINAL construction — one vertex per cell
  // centre, quads joining neighbours — which was replaced because it drew every
  // vertical face a cutter leaves as a quad *leaning* by one cell width (see
  // the note in `mesh.js`). It has been failing ever since, which is exactly as
  // useful as no check at all, so it now describes what is built: four fresh
  // vertices per planar quad, stepped.
  const s = createStock({ xMin: 0, yMin: 0, xMax: 4, yMax: 3, top: 0, base: -10, cellSize: 1 });
  stamp(s, 2, 1.5, -3, { radius: 1, type: 'flat' });
  const { positions, indices, colors } = heightmapToSolidMesh(s);

  assert.equal(positions.length % 12, 0, 'four vertices per quad');
  const verts = positions.length / 3;
  assert.equal(indices.length, (verts / 4) * 6, 'two triangles per quad');
  assert.equal(colors.length, positions.length, 'one colour per vertex');
  assert.ok(indices.every((ix) => ix < verts));

  // The floor is there, at or below the stated base.
  let floorZ = Infinity;
  for (let i = 2; i < positions.length; i += 3) floorZ = Math.min(floorZ, positions[i]);
  assert.ok(floorZ <= s.base + 1e-6, `floor ${floorZ} vs base ${s.base}`);
  // ...and nothing pokes above the blank's own top.
  let ceil = -Infinity;
  for (let i = 2; i < positions.length; i += 3) ceil = Math.max(ceil, positions[i]);
  assert.ok(ceil <= s.top + 1e-6);
});

test('a cut surface is a different colour from raw stock', () => {
  // A single-colour block answers "what shape is left" and nothing else. It
  // cannot answer "did this pass cut anything, and where?", because a face the
  // tool has been through looks exactly like one it has never touched.
  const s = createStock({ xMin: -6, yMin: -6, xMax: 6, yMax: 6, top: 0, base: -10, cellSize: 0.5 });
  const raw = heightmapToSolidMesh(s).colors;
  const only = new Set();
  for (let i = 0; i < raw.length; i += 3) only.add(raw.slice(i, i + 3).join(','));
  assert.equal(only.size, 1, 'an uncut billet is all one colour');

  stamp(s, 0, 0, -3, { radius: 2, type: 'flat' });
  const cut = heightmapToSolidMesh(s).colors;
  // Float32 rounds the palette, so match on distance rather than on text.
  const isCol = (i, c) => Math.abs(cut[i] - c[0]) + Math.abs(cut[i + 1] - c[1])
    + Math.abs(cut[i + 2] - c[2]) < 1e-6;
  let cutFaces = 0;
  let rawFaces = 0;
  for (let i = 0; i < cut.length; i += 3) {
    if (isCol(i, CUT)) cutFaces++;
    else if (isCol(i, RAW)) rawFaces++;
    else assert.fail(`a colour that is neither: ${cut[i]},${cut[i + 1]},${cut[i + 2]}`);
  }
  assert.ok(cutFaces > 0, 'the pocket floor and walls are machined');
  assert.ok(rawFaces > 0, 'the rest of the billet is not');
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
  // A shoulder mill is not a face mill: it is a squat body cutting a true 90°
  // wall, and it is drawn and fed as its own tool. "FACE MILLING" in the
  // operation tail must not turn it into one.
  assert.equal(t.get(1).type, 'shouldermill');
  assert.equal(t.get(1).cutter, 'shoulder');
  assert.equal(t.get(1).diameter, 32);
  assert.equal(t.get(2).type, 'drill');
  assert.equal(t.get(2).diameter, 9);          // bare number, no D word
  assert.equal(t.get(2).cutter, null);         // none of the milling shapes is a drill
  assert.equal(t.get(3).type, 'endmill');
  assert.equal(t.get(3).radius, 3.5);          // D7 -> radius 3.5
  assert.equal(t.get(3).length, 48);
  assert.equal(t.get(3).lengthMax, 54);
  assert.equal(t.get(8).type, 'reamer');
  assert.equal(t.get(9).simType, 'ball');      // ball-nose carves rounded
  assert.equal(t.get(9).cutter, 'ball');
});

test('a slot drill is a slot mill, not a drill', () => {
  // `SLOT DRILL` used to fall through to the DRILL rule, so a Ø6 slot mill was
  // listed — and drawn — as a twist drill.
  const t = parseToolTable(['T4(SLOT DRILL D6)', 'M6', 'T5(FACEMILL D50)', 'M6'].join('\n'));
  assert.equal(t.get(4).type, 'slotmill');
  assert.equal(t.get(4).cutter, 'slot');
  assert.equal(t.get(5).cutter, 'face');
});

test('a detected chamfer mill carves its cone, at the size the comment gave', () => {
  // The whole point of carrying the cutter id through: the tool table, the
  // marker and the carvers all read the same field.
  const tools = [
    { n: 1, type: 'chamfer', simType: 'flat', cutter: 'chamfer', diameter: 10, radius: 5 },
  ];
  const t = toolResolver(tools, { radius: 1, type: 'flat' })({ tool: 1 });
  assert.equal(t.type, 'cone');
  assert.equal(t.angle, 90);
  assert.equal(t.radius, 5);
});

test('a tool-table cutter type wins over the program comment', () => {
  const tools = [{ n: 1, type: 'endmill', simType: 'flat', cutter: 'endmill', diameter: 10, radius: 5 }];
  const resolve = toolResolver(tools, { radius: 1, type: 'flat' }, { 1: { cutter: 'ball' } });
  assert.equal(resolve({ tool: 1 }).type, 'ball');
  assert.equal(resolve({ tool: 1 }).radius, 5);
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

test('every cutter type reaches the carve, not just the picture', () => {
  // The complaint this answers: the removed material did not follow the tool
  // that was chosen. A ball leaves a rounded floor and a chamfer mill a cone,
  // so each takes out a measurably different amount of the same cut.
  const prog = ['G21 G90', 'G0 X-20 Y0 Z5', 'G1 Z-3 F200', 'G1 X20 F400', 'G0 Z5'].join('\n');
  const opts = { cellSize: 0.25, margin: 10, radius: 10 };
  const of = (cutter) => runSimulation(prog, { ...opts, cutter }).removedVolume;
  const flat = of('endmill');
  assert.ok(flat > 0);
  // Square-ended types are the same tool to a height field, and should be.
  for (const same of ['shoulder', 'face', 'slot']) {
    assert.ok(Math.abs(of(same) - flat) < 1, `${same} ${of(same)} vs endmill ${flat}`);
  }
  // The shaped ones are not.
  assert.ok(of('ball') < flat * 0.95, `ball ${of('ball')} vs flat ${flat}`);
  assert.ok(of('chamfer') < of('ball'), `chamfer ${of('chamfer')} vs ball ${of('ball')}`);
});

test('the size the program named is the size that carves', () => {
  // A posted program describes its tools in a comment; the carve must be at
  // that diameter, not at the fallback slider's.
  const prog = [
    '(TOOL: T1 ENDMILL Ø20)', 'T1 M06',
    'G21 G90', 'G0 X-20 Y0 Z5', 'G1 Z-3 F200', 'G1 X20 F400', 'G0 Z5',
  ].join('\n');
  const wide = runSimulation(prog, { cellSize: 0.25, margin: 12, radius: 1 }).removedVolume;
  const bare = runSimulation(
    prog.split('\n').slice(2).join('\n'),
    { cellSize: 0.25, margin: 12, radius: 1 },
  ).removedVolume;
  assert.ok(wide > bare * 5, `Ø20 from the comment ${wide} vs Ø2 fallback ${bare}`);
});

test('a stated cutting-body length stops the voxel cut where the tool ends', () => {
  // The one place a cutting body's length can show in the removal: a tool that
  // only cuts for its first few mm leaves material standing above that, which a
  // height field (one top-Z per column) can never express.
  const prog = ['G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-20 F200', 'G1 X20 F400', 'G0 Z5'].join('\n');
  const opts = { voxelSize: 0.5, margin: 6, radius: 4, cutter: 'slot' };
  const full = runVoxelSimulation(prog, opts).removedVolume;
  const stub = runVoxelSimulation(prog, { ...opts, thickness: 5 }).removedVolume;
  assert.ok(stub < full * 0.8, `5 mm body ${stub.toFixed(0)} vs full ${full.toFixed(0)}`);
  assert.ok(stub > 0);
});

test('the voxel sim carves step by step, not all at once', () => {
  // A one-shot model shows the finished part and nothing of how it got there.
  // An undercutting cutter needs this model for ordinary work now, so losing
  // playback with it is not a trade the operator can opt out of.
  const prog = [
    'G21 G90', 'G0 X-40 Y0 Z-10',
    'G1 X-20 F300', 'G1 X0 F300', 'G1 X20 F300',
  ].join('\n');
  const opts = {
    voxelSize: 1, margin: 4, radius: 5, cutter: 'slot', thickness: 4,
    stockSize: { x: 90, y: 30, z: 25 }, stockOrigin: { x: -45, y: -15, z: -25 },
  };
  const s = createVoxelSession(prog, opts);
  assert.equal(s.totalFeeds, 3);

  const at = [0, 1, 2, 3].map((k) => carveVoxelSessionTo(s, k).removedVolume);
  assert.equal(at[0], 0, 'nothing is cut before the playhead moves');
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i] > at[i - 1], `feed ${i} removed nothing (${at[i]} vs ${at[i - 1]})`);
  }
  // Scrubbing back refills the block and re-carves: the same playhead gives the
  // same part, whichever direction it was reached from.
  assert.ok(Math.abs(carveVoxelSessionTo(s, 1).removedVolume - at[1]) < 1e-9);
  assert.ok(Math.abs(carveVoxelSessionTo(s, 3).removedVolume - at[3]) < 1e-9);
});

test('the voxel grid is refined to hold the groove the cutter leaves', () => {
  // A cut is rounded out to whole voxels: a 0.5 mm cutting body on the 1 mm
  // grid the box asks for comes back as a 1 mm groove — twice the tool, which
  // is what "the slot is taller than the cutter" looks like.
  const prog = ['G21 G90', 'G0 X-40 Y0 Z-10', 'G1 X0 F300'].join('\n');
  const opts = {
    voxelSize: 1, margin: 4, radius: 10, cutter: 'slot',
    stockSize: { x: 60, y: 30, z: 25 }, stockOrigin: { x: -50, y: -15, z: -25 },
  };
  const coarse = createVoxelSession(prog, { ...opts, thickness: undefined });
  assert.equal(coarse.cellSizeZ, 1, 'a plain cutter carves at the size asked for');

  const fine = createVoxelSession(prog, { ...opts, thickness: 0.5 });
  // Fine enough to hold the groove, or held back by the grid budget and saying
  // so — never quietly carved at a resolution that cannot show the cut. Only
  // the HEIGHT is refined: the footprint stays where it was asked for, which is
  // what keeps the cost proportional instead of cubic.
  assert.ok(fine.cellSizeZ <= 0.5 / 4 || fine.limited,
    `0.5 mm body wants fine layers, got ${fine.cellSizeZ}`);
  assert.equal(fine.cellSize, coarse.cellSize, 'the footprint is left alone');
  assert.ok(fine.cellSizeZ < coarse.cellSizeZ);

  // ...and the groove that comes out is the height of the tool, not the grid.
  carveVoxelSessionTo(fine, fine.totalFeeds);
  const v = fine.vox;
  const j = Math.floor((0 - v.oy) / v.cs);
  const i = Math.floor((-20 - v.ox) / v.cs);
  let lo = null;
  let hi = null;
  for (let k = 0; k < v.nz; k++) {
    if (!v.solid[k * v.nx * v.ny + j * v.nx + i]) {
      const z = v.oz + (k + 0.5) * v.csz;
      if (lo === null) lo = z - v.csz / 2;
      hi = z + v.csz / 2;
    }
  }
  assert.ok(Math.abs((hi - lo) - 0.5) <= v.cs, `groove ${(hi - lo).toFixed(3)} mm for a 0.5 mm tool`);
});

test('a cutting body typed anywhere reaches the tool that is cutting', () => {
  // The program names its tool, so detection wins on the type and the size —
  // but no comment syntax states a cutting-body length, so the only number in
  // the room is the one the operator typed. Dropping it is how "I told it the
  // cutter is 3 mm thick and the groove came out 10" happens.
  const prog = [
    '(TOOL: T1 SLOT DRILL Ø20)', 'T1 M06',
    'G21 G90', 'G0 X-40 Y0 Z-10', 'G1 X0 F300', 'G1 X20 F300',
  ].join('\n');
  const base = {
    voxelSize: 1, margin: 4, radius: 3, cutter: 'slot',
    stockSize: { x: 90, y: 30, z: 25 }, stockOrigin: { x: -45, y: -15, z: -25 },
  };
  const height = (opts) => {
    const s = createVoxelSession(prog, { ...base, ...opts });
    carveVoxelSessionTo(s, s.totalFeeds);
    const v = s.vox;
    const j = Math.floor((0 - v.oy) / v.cs);
    const i = Math.floor((-20 - v.ox) / v.cs);
    let lo = null;
    let hi = null;
    for (let k = 0; k < v.nz; k++) {
      if (!v.solid[k * v.nx * v.ny + j * v.nx + i]) {
        const z = v.oz + (k + 0.5) * v.csz;
        if (lo === null) lo = z - v.csz / 2;
        hi = z + v.csz / 2;
      }
    }
    return { groove: hi - lo, cs: s.cellSizeZ };
  };

  // Typed on the fallback picker...
  const a = height({ thickness: 3 });
  assert.ok(Math.abs(a.groove - 3) <= a.cs, `fallback: ${a.groove} mm groove for a 3 mm tool`);
  // ...or on the tool's own row. Same tool, same answer.
  const b = height({ toolOverrides: { 1: { cutter: 'slot', simType: 'flat', thickness: 3 } } });
  assert.ok(Math.abs(b.groove - 3) <= b.cs, `row: ${b.groove} mm groove for a 3 mm tool`);
  // ...and the grid follows a per-row thickness, not just the picker's.
  const c = height({ toolOverrides: { 1: { cutter: 'slot', simType: 'flat', thickness: 0.8 } } });
  assert.ok(c.cs < 0.8, `layers of ${c.cs} mm cannot hold a 0.8 mm groove`);
  assert.ok(Math.abs(c.groove - 0.8) <= c.cs, `row: ${c.groove} mm groove for a 0.8 mm tool`);
});

test('the cut follows the tool along a move, not a whole block at a time', () => {
  // The complaint this answers: a 100 mm `G1` is ONE feed move, so counting
  // whole moves let the tool cross the part with nothing happening and then
  // dropped the entire cut in at the end of it.
  const prog = ['G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-2 F600', 'G1 X100 F600'].join('\n');
  const opts = {
    cellSize: 0.5, margin: 5, radius: 4,
    stockSize: { x: 120, y: 20, z: 10 }, stockOrigin: { x: -10, y: -10, z: -10 },
  };
  const s = createSession(prog, opts);
  const at = (k) => carveTo(s, k).removedVolume;

  const quarter = at(1.25);
  const half = at(1.5);
  const whole = at(2);
  assert.ok(quarter > 0, 'a quarter of the way along the cut, something is gone');
  assert.ok(half > quarter, `half ${half} should be past quarter ${quarter}`);
  assert.ok(whole > half, `whole ${whole} should be past half ${half}`);
  // ...and a quarter of the move takes off roughly a quarter of what it will.
  assert.ok(Math.abs(quarter / whole - 0.25) < 0.1, `quarter/whole = ${(quarter / whole).toFixed(2)}`);
  assert.ok(Math.abs(half / whole - 0.5) < 0.1, `half/whole = ${(half / whole).toFixed(2)}`);
});

test('scrubbing back into a move re-carves it from the start', () => {
  const prog = ['G21 G90', 'G0 X0 Y0 Z5', 'G1 Z-2 F600', 'G1 X100 F600'].join('\n');
  const opts = {
    cellSize: 0.5, margin: 5, radius: 4,
    stockSize: { x: 120, y: 20, z: 10 }, stockOrigin: { x: -10, y: -10, z: -10 },
  };
  const s = createSession(prog, opts);
  const forward = carveTo(s, 1.5).removedVolume;
  carveTo(s, 2);
  const back = carveTo(s, 1.5).removedVolume;
  assert.ok(Math.abs(back - forward) < 1e-6, `${back} should match ${forward}`);
});

test('the voxel session follows the tool along a move too', () => {
  const prog = [
    '(TOOL: T1 SLOT DRILL Ø20)', 'T1 M06',
    'G21 G90', 'G0 X-40 Y0 Z-10', 'G1 X40 F300',
  ].join('\n');
  const s = createVoxelSession(prog, {
    voxelSize: 1, margin: 4, radius: 3, cutter: 'slot', thickness: 3,
    stockSize: { x: 100, y: 30, z: 25 }, stockOrigin: { x: -50, y: -15, z: -25 },
  });
  assert.equal(s.totalFeeds, 1, 'one long feed move — the case that looked broken');
  const quarter = carveVoxelSessionTo(s, 0.25).removedVolume;
  const half = carveVoxelSessionTo(s, 0.5).removedVolume;
  const whole = carveVoxelSessionTo(s, 1).removedVolume;
  assert.ok(quarter > 0 && half > quarter && whole > half,
    `${quarter} < ${half} < ${whole}`);
});

test('the two simulators agree on the blank, and cut from the first pass', () => {
  // A plunge is a feed move and it BEGINS in the air above the billet, so a
  // block sized to the raw feed bounds grows a slab of phantom material on top.
  // The height field always inferred the surface; the voxel block did not, so
  // the same job simulated several passes deep before anything visibly came
  // off — and a cutter with a limited cutting length cannot clear that slab at
  // all, it just stands there as a roof.
  const prog = ['G21 G90', 'G0 X-40 Y0 Z5'];
  for (let p = 1; p <= 10; p++) {
    prog.push(`G1 Z${-p} F200`, 'G1 X40 F400', 'G1 X-40 F400');
  }
  const src = prog.join('\n');
  const opts = { margin: 5, radius: 5, cutter: 'endmill' };

  const v = createVoxelSession(src, { ...opts, voxelSize: 0.5 });
  const h = createSession(src, { ...opts, cellSize: 0.5 });
  assert.ok(Math.abs(v.box.top - h.box.top) < 1e-6,
    `voxel top ${v.box.top} vs height field ${h.box.top}`);
  assert.ok(v.box.top < 0, `the surface is the cut, not the clearance plane (${v.box.top})`);

  // Both take material off from the first pass that goes below the surface,
  // and land within a couple of percent of each other by the end.
  const vv = carveVoxelSessionTo(v, 5).removedVolume;
  const hh = carveTo(h, 5).removedVolume;
  assert.ok(vv > 0 && hh > 0, `nothing cut in the first passes (${vv}, ${hh})`);
  const vAll = carveVoxelSessionTo(v, v.totalFeeds).removedVolume;
  const hAll = carveTo(h, h.totalFeeds).removedVolume;
  assert.ok(Math.abs(vAll - hAll) / hAll < 0.05,
    `voxel ${vAll.toFixed(0)} vs height field ${hAll.toFixed(0)} mm³`);
});

test('the voxel block tells a machined face from the blank\'s own outside', () => {
  // The block starts solid, so an exposed face is either the blank's outside
  // (still off the grid edge) or one the tool made by taking its neighbour
  // away. That is the whole distinction, and it costs one bounds test.
  const prog = ['G21 G90', 'G0 X-40 Y0 Z-10', 'G1 X40 F300'].join('\n');
  const opts = {
    voxelSize: 1, margin: 4, radius: 5, cutter: 'slot', thickness: 3,
    stockSize: { x: 100, y: 30, z: 25 }, stockOrigin: { x: -50, y: -15, z: -25 },
  };
  const before = runVoxelSimulation(prog.replace('G1 X40 F300', 'G0 X40'), opts).colors;
  const after = runVoxelSimulation(prog, opts).colors;
  const count = (arr, c) => {
    let n = 0;
    for (let i = 0; i < arr.length; i += 3) {
      if (Math.abs(arr[i] - c[0]) + Math.abs(arr[i + 1] - c[1]) + Math.abs(arr[i + 2] - c[2]) < 1e-6) n++;
    }
    return n;
  };
  assert.equal(count(before, CUT), 0, 'an uncut block has no machined faces');
  assert.ok(count(after, CUT) > 0, 'the groove is machined');
  assert.ok(count(after, RAW) > 0, 'the outside of the billet is not');
});
