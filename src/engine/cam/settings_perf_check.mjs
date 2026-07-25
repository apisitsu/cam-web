/**
 * Guard against the settings-panel stutter coming back.
 *
 * Reported: after importing a curvy STL, adjusting any CAM setting stuttered.
 * The cause was that `camPlanStore.prepare()` re-lays-down the part from the
 * pristine import on every machine / process / datum change, producing a **new
 * mesh object** each time and invalidating everything keyed on the mesh —
 * feature detection, the slice index, the analysis, the lay-down. One change
 * cost ~100 ms on a ~15 k-triangle part; six dropped frames.
 *
 * The fix was a set of mesh-identity caches (`reorient`, `analyzeMesh`,
 * `detectFeatures`, `sliceIndexFor`), sound because meshes here are immutable.
 * They only help if `reorient` returns the **identical** object for an
 * unchanged lay-down — that is the linchpin the others hang on.
 *
 * A raw millisecond budget would be flaky across machines, so this asserts the
 * machine-independent invariant instead: repeating an identical settings change
 * (caches warm) must be dramatically cheaper than the same work on a freshly
 * built mesh (caches cold). If someone removes a cache, the ratio collapses and
 * this fails — which is the regression, caught.
 *
 * Run:  node --test src/engine/cam/settings_perf_check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weld } from '../mesh/stl.js';
import { planContext, planJob } from './plan.js';
import { post } from './post/fanuc.js';
import * as recipeOps from './recipe.js';
import { machineById } from './machines.js';

const MACHINE = 'haas-vf2';

/**
 * A bumpy plate standing on end — the shortest extent is along X, so the
 * planner lays it down, which is exactly the case that used to rebuild a new
 * mesh on every settings change. ~15 k triangles, like a real imported part.
 */
function standingPlate(nx = 60, ny = 60, sy = 100, sz = 100, h = 20) {
  const tris = [];
  const xTop = (i, j) => h + 3 * Math.sin((i / nx) * Math.PI * 3) * Math.cos((j / ny) * Math.PI * 3);
  const P = (i, j, top) => [top ? xTop(i, j) : 0, (i / nx) * sy - sy / 2, (j / ny) * sz - sz / 2];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      tris.push([P(i, j, 1), P(i + 1, j, 1), P(i + 1, j + 1, 1)], [P(i, j, 1), P(i + 1, j + 1, 1), P(i, j + 1, 1)]);
      tris.push([P(i, j, 0), P(i + 1, j + 1, 0), P(i + 1, j, 0)], [P(i, j, 0), P(i, j + 1, 0), P(i + 1, j + 1, 0)]);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (const j of [0, ny]) tris.push([P(i, j, 0), P(i + 1, j, 0), P(i + 1, j, 1)], [P(i, j, 0), P(i + 1, j, 1), P(i, j, 1)]);
  }
  for (let j = 0; j < ny; j++) {
    for (const i of [0, nx]) tris.push([P(i, j, 0), P(i, j + 1, 0), P(i, j + 1, 1)], [P(i, j, 0), P(i, j + 1, 1), P(i, j, 1)]);
  }
  const positions = new Float32Array(tris.length * 9);
  let o = 0;
  for (const t of tris) for (const t2 of t) for (const c of t2) positions[o++] = c;
  return { positions, normals: new Float32Array(tris.length * 3), triangleCount: tris.length };
}

const SOUP = standingPlate();

/** One full settings change, as the panel drives it: prepare + rebuild + the
 *  `features()` read the panel does on the following render. */
function settingsChange(soup, welded, recipe) {
  const ctx = planContext(soup, welded, { mode: 'mill', machineId: MACHINE });
  const reconciled = recipeOps.reconcile(recipe, ctx);
  const plan = planJob(soup, welded, { ctx, recipe: reconciled, material: 'aluminium', machineId: MACHINE });
  post(
    {
      name: 'part', mode: plan.mode, material: plan.material,
      machineLabel: machineById(MACHINE).label, stock: plan.stock, operations: plan.operations,
    },
    { diameterMode: true, programNumber: 1, controller: 'fanuc' },
  );
  // The panel reads the pickable features on the next render.
  void ctx.features;
  return { ctx, recipe: reconciled };
}

/** Best-of-`runs` wall time for `fn`, to shrug off GC and scheduler noise. */
function best(fn, runs = 5) {
  let min = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    min = Math.min(min, performance.now() - t);
  }
  return min;
}

test('the part is one the planner must lay down (the stutter case)', () => {
  const welded = weld(SOUP);
  const ctx = planContext(SOUP, welded, { mode: 'mill', machineId: MACHINE });
  assert.equal(ctx.orientation.changed, true, 'fixture should stand on end so it gets laid down');
});

test('reorient returns the identical mesh for an unchanged lay-down', async () => {
  // The linchpin: if this stops holding, every downstream mesh-keyed cache
  // misses on every settings change and the stutter is back.
  const { reorient } = await import('../mesh/orient.js');
  const welded = weld(SOUP);
  const T = { order: [1, 2, 0], flipY: false };
  assert.equal(reorient(welded, T), reorient(welded, T), 'same mesh + same transform must return the same object');
});

test('a repeated settings change is far cheaper than one on a fresh mesh', () => {
  // Warm: reuse the raw import, exactly as the store does — _raw never changes,
  // so `reorient` (and the caches it feeds) hit on every repeat.
  const welded = weld(SOUP);
  let recipe = recipeOps.autoRecipe(planContext(SOUP, welded, { mode: 'mill', machineId: MACHINE }));
  const warm = best(() => { recipe = settingsChange(SOUP, welded, recipe).recipe; });

  // Cold: a freshly built mesh each time, which is what prepare() effectively
  // produced before `reorient` was memoised — every mesh-keyed cache misses.
  const cold = best(() => {
    const soup = { positions: Float32Array.from(SOUP.positions), normals: SOUP.normals, triangleCount: SOUP.triangleCount };
    const w = weld(soup);
    settingsChange(soup, w, recipe);
  });

  // Optimised is ~5× here; require a conservative 1.8× so the check is a
  // structural guard, not a timing benchmark, and never flakes on slow CI.
  const ratio = cold / warm;
  console.log(`  settings change: warm ${warm.toFixed(1)}ms  cold ${cold.toFixed(1)}ms  (${ratio.toFixed(1)}× faster warm)`);
  assert.ok(
    ratio >= 1.8,
    `expected the cached repeat to be >=1.8x faster than a cold rebuild, got ${ratio.toFixed(1)}x — a mesh-identity cache is likely broken`,
  );
});
