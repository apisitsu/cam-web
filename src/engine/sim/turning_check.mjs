/**
 * Dependency-free validation of the turning (radial profile) sim.
 * Run:  node --test src/engine/sim/turning_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTurningStock, carveTurning, carveTurningMove, turningMesh, resetTurningStock,
  turningNoseResolver, detectFaceZ, STANDARD_TURN_TOOLS,
} from './turning.js';

const bounds = { min: [0, 0, -50], max: [12, 0, 0] };

test('standard tool list defines OD, boring and parting holders', () => {
  assert.ok(STANDARD_TURN_TOOLS.length >= 2);
  for (const t of STANDARD_TURN_TOOLS) {
    assert.ok(typeof t.id === 'string' && t.label);
    assert.ok(t.lead > 0, `${t.id} needs a lead angle`);
    assert.ok(t.angle > 0 && t.sides >= 3, `${t.id} needs an insert shape`);
    assert.ok(['od', 'boring', 'parting'].includes(t.kind), `${t.id} needs a kind`);
  }
  // Some holders have an adjustable insert angle (MVJNR, boring), some are fixed.
  assert.ok(STANDARD_TURN_TOOLS.some((t) => t.adjustable));
  assert.ok(STANDARD_TURN_TOOLS.some((t) => !t.adjustable));
  // The three kinds are all represented.
  for (const k of ['od', 'boring', 'parting']) {
    assert.ok(STANDARD_TURN_TOOLS.some((t) => t.kind === k), `missing kind ${k}`);
  }
});

test('stock starts as a solid bar at the OD radius', () => {
  const s = createTurningStock(bounds, { cellSize: 0.5, margin: 1 });
  assert.equal(s.rStock, 12);
  assert.ok(s.radius.every((r) => r === 12));
});

test('an OD turning pass lowers the radius over its Z span', () => {
  const s = createTurningStock(bounds, { cellSize: 0.5, margin: 1 });
  // Turn the bar down to radius 8 from Z0 to Z-40.
  const feed = { type: 'feed', a: [8, 0, 0], b: [8, 0, -40] };
  const { removedVolume } = carveTurning(s, [feed], { noseR: 0 });
  assert.ok(removedVolume > 0);
  // Slices inside the pass dropped to 8; slices outside (Z beyond -40) stay 12.
  const at = (z) => s.radius[Math.floor((z - s.zMin) / s.cs)];
  assert.ok(Math.abs(at(-20) - 8) < 1e-6, `mid-pass radius ${at(-20)} should be 8`);
  assert.ok(Math.abs(at(-48) - 12) < 1e-6, `beyond the pass stays 12, got ${at(-48)}`);
});

test('nose radius rounds a step instead of leaving a sharp inside corner', () => {
  const s = createTurningStock(bounds, { cellSize: 0.25, margin: 1 });
  // A shoulder: face down to r=6 at Z-20 (a step in the profile).
  carveTurningMove(s, [6, 0, -20], [6, 0, -20.01], 0.8); // stamp the nose at the corner
  const at = (z) => s.radius[Math.floor((z - s.zMin) / s.cs)];
  // At the tip the radius is 6; a nose-radius away it rises back toward the bar,
  // so an adjacent slice is strictly between 6 and 12 (the round leaves a fillet).
  assert.ok(Math.abs(at(-20) - 6) < 0.05, `tip radius ${at(-20)}`);
  const near = at(-20 + 0.6); // 0.6mm along Z, within the 0.8 nose
  assert.ok(near > 6 && near < 12, `nose should fillet: ${near}`);
});

test('scrub-back reset restores the solid bar', () => {
  const s = createTurningStock(bounds, { cellSize: 0.5, margin: 1 });
  carveTurning(s, [{ type: 'feed', a: [4, 0, 0], b: [4, 0, -30] }], { noseR: 0.4 });
  assert.ok(s.radius.some((r) => r < 12));
  resetTurningStock(s);
  assert.ok(s.radius.every((r) => r === 12));
});

test('turningNoseResolver gives each tool its own nose radius', () => {
  const resolve = turningNoseResolver(0.4, { 606: { noseR: 0.8 }, 404: { noseR: 0.2 } });
  assert.equal(resolve({ tool: 606 }), 0.8); // roughing insert
  assert.equal(resolve({ tool: 404 }), 0.2); // finishing insert
  assert.equal(resolve({ tool: 999 }), 0.4); // untouched -> global default
  // carveTurning accepts the resolver and cuts.
  const s = createTurningStock({ min: [0, 0, -20], max: [10, 0, 0] }, { cellSize: 0.5, margin: 0 });
  const { removedVolume } = carveTurning(
    s,
    [{ type: 'feed', a: [6, 0, 0], b: [6, 0, -18], tool: 606 }],
    resolve,
  );
  assert.ok(removedVolume > 0);
});

test('facing trim ends the billet at the faced face — no +Z stub', () => {
  const segs = [
    { type: 'rapid', a: [12, 0, 2], b: [12, 0, 0] },
    { type: 'feed', a: [12, 0, 0], b: [-0.5, 0, 0] }, // facing to centre at Z0
    { type: 'feed', a: [8, 0, 2], b: [8, 0, -40] },   // OD roughing from the clearance
  ];
  assert.equal(detectFaceZ(segs), 0, 'the facing pass is at Z0');
  // Without the cap the billet would run to +2 (the clearance); with it, to ~0.
  const capped = createTurningStock({ min: [-0.5, 0, -40], max: [12, 0, 2] },
    { cellSize: 0.5, margin: 1, faceZ: detectFaceZ(segs) });
  const zMax = capped.zMin + capped.nz * capped.cs;
  assert.ok(zMax <= 0.6, `billet should end at the face (~0), got ${zMax}`);
  const uncapped = createTurningStock({ min: [-0.5, 0, -40], max: [12, 0, 2] },
    { cellSize: 0.5, margin: 1 });
  assert.ok(uncapped.zMin + uncapped.nz * uncapped.cs > 2, 'without a face it keeps the clearance');
});

test('chuck clearance extends the raw bar past the deepest cut', () => {
  // Without chuckClear the billet ends at the deepest cut (− margin).
  const plain = createTurningStock({ min: [0, 0, -40], max: [12, 0, 0] },
    { cellSize: 0.5, margin: 1 });
  assert.ok(Math.abs(plain.zMin - -41) < 1e-6, `plain zMin ${plain.zMin}`);
  // With it, the −Z end reaches into the chuck (raw bar), so a gap + grip fit.
  const gripped = createTurningStock({ min: [0, 0, -40], max: [12, 0, 0] },
    { cellSize: 0.5, margin: 1, chuckClear: 20 });
  assert.ok(Math.abs(gripped.zMin - -60) < 1e-6, `gripped zMin ${gripped.zMin}`);
  // The extension stays at the full bar radius (never machined).
  assert.equal(gripped.radius[0], gripped.rStock);
});

test('session carves the bar down progressively and scrubs back', () => {
  const bar = createTurningStock({ min: [0, 0, -30], max: [10, 0, 0] }, { cellSize: 0.5, margin: 1 });
  const sum = (st) => st.radius.reduce((a, b) => a + b, 0);
  const raw = sum(bar);
  // Emulate a session: carve feeds one at a time, radius must only shrink.
  const feeds = [
    { type: 'feed', a: [8, 0, 0], b: [8, 0, -25] },
    { type: 'feed', a: [6, 0, 0], b: [6, 0, -20] },
    { type: 'feed', a: [4, 0, 0], b: [4, 0, -15] },
  ];
  let prev = raw;
  for (const f of feeds) {
    carveTurning(bar, [f], { noseR: 0 });
    const now = sum(bar);
    assert.ok(now <= prev, 'material only comes off as the tool advances');
    prev = now;
  }
  assert.ok(prev < raw, 'the bar is smaller than the raw stock after cutting');
  // Scrubbing back resets to the raw bar.
  resetTurningStock(bar);
  assert.ok(Math.abs(sum(bar) - raw) < 1e-6, 'reset restores the raw bar');
});

test('turningMesh revolves the profile into a closed solid', () => {
  const s = createTurningStock(bounds, { cellSize: 1, margin: 0 });
  carveTurning(s, [{ type: 'feed', a: [8, 0, 0], b: [8, 0, -40] }], { noseR: 0 });
  const mesh = turningMesh(s, 24);
  assert.ok(mesh.positions.length > 0 && mesh.indices.length > 0);
  assert.equal(mesh.positions.length % 3, 0);
  // Indices reference valid vertices.
  const nv = mesh.positions.length / 3;
  for (const i of mesh.indices) assert.ok(i < nv);
  // Side rings + 2 cap centres.
  assert.equal(nv, s.nz * 24 + 2);
});
