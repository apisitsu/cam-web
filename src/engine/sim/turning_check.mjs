/**
 * Dependency-free validation of the turning (radial profile) sim.
 * Run:  node --test src/engine/sim/turning_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTurningStock, carveTurning, carveTurningMove, turningMesh, resetTurningStock,
  turningNoseResolver, detectFaceZ, STANDARD_TURN_TOOLS, simplifyProfile,
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
  // Whole rings plus the two cap centres.
  assert.equal(nv % 24, 2);
  assert.equal(mesh.normals.length, mesh.positions.length);
  // The profile is simplified before meshing, so a plain stepped bar needs only
  // a handful of rings — far fewer than one per slice — while still being a
  // closed solid. (It used to emit a ring per slice: nz=50 → 1346 vertices.)
  assert.ok(nv < s.nz * 24 / 4, `mesh is decimated (got ${nv} for ${s.nz} slices)`);
});

test('turningMesh ships exact unit normals for the revolve', () => {
  const s = createTurningStock(bounds, { cellSize: 1, margin: 0 });
  carveTurning(s, [{ type: 'feed', a: [8, 0, 0], b: [8, 0, -40] }], { noseR: 0 });
  const m = turningMesh(s, 24);
  const P = m.positions;
  const N = m.normals;
  let radialChecked = 0;
  for (let i = 0; i < N.length; i += 3) {
    const len = Math.hypot(N[i], N[i + 1], N[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-5, `normal ${i / 3} is unit (got ${len})`);
    // On the straight barrel the normal must point straight out from the axis:
    // parallel to (x, y, 0) — that is what makes it shade as a true cylinder
    // instead of a ring of facets.
    if (Math.abs(N[i + 2]) < 1e-6) {
      const r = Math.hypot(P[i], P[i + 1]);
      if (r > 1e-6) {
        assert.ok(Math.abs(N[i] - P[i] / r) < 1e-5 && Math.abs(N[i + 1] - P[i + 1] / r) < 1e-5);
        radialChecked++;
      }
    }
  }
  assert.ok(radialChecked > 0, 'the barrel has purely radial normals');
});

test('a faced end stays flat and lands exactly on the faced Z', () => {
  // Facing is an axial cut this radial field cannot hold, so the billet is
  // truncated at the faced Z instead. If that Z falls inside a cell, the facing
  // move used to collapse the last slice to r=0 and the face came out as a cone.
  // −50.3 deliberately does not divide by the 0.5 cell size.
  const b = { min: [0, 0, -50.3], max: [12, 0, 0] };
  const s = createTurningStock(b, { cellSize: 0.5, margin: 1, rStock: 12, faceZ: 0, chuckClear: 20 });
  assert.ok(Math.abs(s.zMin + s.nz * s.cs) < 1e-9, 'the grid ends exactly on the faced Z');
  carveTurning(s, [
    { type: 'feed', a: [12, 0, 0], b: [0, 0, 0] },        // the facing pass
    { type: 'feed', a: [8, 0, 0], b: [8, 0, -30] },       // then turn the OD
  ], { noseR: 0 });
  assert.ok(s.radius[s.nz - 1] > 1, `end slice keeps material (got ${s.radius[s.nz - 1]})`);

  // The mesh's +Z cap must sit on the faced Z, not half a cell short of it.
  const m = turningMesh(s, 24);
  let maxZ = -Infinity;
  for (let i = 2; i < m.positions.length; i += 3) maxZ = Math.max(maxZ, m.positions[i]);
  assert.ok(Math.abs(maxZ - 0) < 1e-6, `part ends at the faced Z (got ${maxZ})`);
});

test('turningMesh faces are wound to agree with the outward normals', () => {
  // The winding used to be inward, which only went unnoticed because the
  // material draws both sides; with real normals shipped it would have lit the
  // part from the inside.
  const s = createTurningStock(bounds, { cellSize: 1, margin: 0 });
  carveTurning(s, [{ type: 'feed', a: [8, 0, 0], b: [8, 0, -30] }], { noseR: 0 });
  const { positions: P, normals: N, indices: I } = turningMesh(s, 24);
  for (let t = 0; t < I.length; t += 3) {
    const [i, j, k] = [I[t], I[t + 1], I[t + 2]];
    const p = [i, j, k].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
    const e1 = p[1].map((v, n) => v - p[0][n]);
    const e2 = p[2].map((v, n) => v - p[0][n]);
    const fn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(...fn) || 1;
    const dot = (fn[0] * N[i * 3] + fn[1] * N[i * 3 + 1] + fn[2] * N[i * 3 + 2]) / len;
    assert.ok(dot > 0, `triangle ${t / 3} faces outward (dot ${dot.toFixed(3)})`);
  }
});

test('turningMesh keeps a shoulder sharp but a taper smooth', () => {
  // A shoulder: Ø16 for 20 mm, then straight down to Ø8. The corner rings must
  // be duplicated (one normal per side) so the edge does not smear round, while
  // a gentle taper stays a single shared ring.
  const shoulder = createTurningStock(bounds, { cellSize: 1, margin: 0 });
  carveTurning(shoulder, [
    { type: 'feed', a: [8, 0, 0], b: [8, 0, -20] },
    { type: 'feed', a: [4, 0, -20], b: [4, 0, -50] },
  ], { noseR: 0 });
  const sharp = turningMesh(shoulder, 24);

  const taper = createTurningStock(bounds, { cellSize: 1, margin: 0 });
  carveTurning(taper, [{ type: 'feed', a: [8, 0, 0], b: [7, 0, -50] }], { noseR: 0 });
  const smooth = turningMesh(taper, 24);

  const rings = (m) => m.positions.length / 3 / 24;
  assert.ok(rings(sharp) > rings(smooth), 'the shoulder splits a ring, the taper does not');
});

test('simplifyProfile keeps every point within tolerance and both ends', () => {
  // A quarter-circle profile sampled finely: simplification must shrink it a lot
  // while never straying further than the tolerance from the original.
  const pts = [];
  for (let i = 0; i <= 400; i++) {
    const t = (i / 400) * (Math.PI / 2);
    pts.push({ z: -12 * (1 - Math.cos(t)), r: 12 * Math.sin(t) });
  }
  const tol = 0.01;
  const out = simplifyProfile(pts, tol);
  assert.ok(out.length < pts.length / 4, `decimated (${out.length} of ${pts.length})`);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[out.length - 1], pts[pts.length - 1]);
  // Every original point is within `tol` of the simplified polyline.
  const distToSeg = (p, a, b) => {
    const dz = b.z - a.z;
    const dr = b.r - a.r;
    const l2 = dz * dz + dr * dr;
    const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.z - a.z) * dz + (p.r - a.r) * dr) / l2));
    return Math.hypot(p.z - (a.z + dz * t), p.r - (a.r + dr * t));
  };
  for (const p of pts) {
    let best = Infinity;
    for (let i = 0; i < out.length - 1; i++) best = Math.min(best, distToSeg(p, out[i], out[i + 1]));
    assert.ok(best <= tol + 1e-9, `point (${p.z.toFixed(3)}, ${p.r.toFixed(3)}) within tol (got ${best})`);
  }
});

test('a spherical end carves close to the true sphere', () => {
  // The regression this guards: near the pole the chords are very short in Z, and
  // collapsing such a move onto a whole cell punched a notch metres out of scale
  // (worst error was 1.73 mm on a Ø24 ball).
  const R = 12;
  const feeds = [];
  let prev = [0, 0, 0];
  for (let i = 1; i <= 200; i++) {
    const t = (i / 200) * (Math.PI / 2);
    const p = [R * Math.sin(t), 0, -R * (1 - Math.cos(t))];
    feeds.push({ type: 'feed', a: prev, b: p });
    prev = p;
  }
  const s = createTurningStock({ min: [0, 0, -R], max: [R, 0, 0] },
    { cellSize: 0.05, margin: 1, rStock: R + 1, faceZ: 0, chuckClear: 5 });
  carveTurning(s, feeds, { noseR: 0 });
  let worst = 0;
  for (let k = 0; k < s.nz; k++) {
    const z = s.zMin + (k + 0.5) * s.cs;
    if (z < -R || z > 0) continue;
    const trueR = Math.sqrt(Math.max(0, R * R - (z + R) * (z + R)));
    worst = Math.max(worst, Math.abs(s.radius[k] - trueR));
  }
  assert.ok(worst < 0.05, `sphere carved within 0.05 mm (worst ${worst.toFixed(4)})`);
});
