/**
 * Phase 1 simulation entry: parse G-code → carve stock → build a render mesh.
 * Returns typed-array buffers ready to transfer out of the worker.
 */
import { interpret } from '../gcode/interpreter.js';
import { stockFromBounds, simulate } from './dexel.js';
import { heightmapToSolidMesh } from './mesh.js';
import { dominantIndex, boundsOf, feedTopZ, toolResolver } from './session.js';
import { createVoxelStock, carveVoxels, voxelSurfaceMesh } from './voxel.js';
import {
  createTurningStock, carveTurning, carveTurningMove, resetTurningStock,
  turningMesh, turningNoseResolver, detectFaceZ,
} from './turning.js';

export { createStock, stockFromBounds, resetStock, stamp, cutSegment, simulate } from './dexel.js';
export { heightmapToMesh, heightmapToSolidMesh } from './mesh.js';
export { createSession, carveTo, dominantIndex, boundsOf, feedTopZ, toolResolver } from './session.js';
export { createVoxelStock, carveVoxels, voxelSurfaceMesh, toolAxisFor } from './voxel.js';
export {
  createTurningStock, carveTurning, turningMesh, resetTurningStock,
  turningNoseResolver, STANDARD_TURN_TOOLS,
} from './turning.js';

/**
 * @param {string} text  G-code program
 * @param {{radius?:number, toolType?:'flat'|'ball', cellSize?:number, margin?:number}} opts
 */

export function runSimulation(text, opts = {}) {
  const { radius = 3, toolType = 'flat', cellSize = 0.5, margin = 5, top, base } = opts;
  // The height field assumes the tool points along +Z, which is only true in the
  // machine frame and only for one rotary index at a time.
  const { segments: all, stats } = interpret(text, { ...opts, rotaryFrame: 'machine' });
  const aIndex = opts.aIndex ?? dominantIndex(all);
  const segments = all.filter((s) => s.a4 === aIndex);
  const bounds = boundsOf(segments);
  const autoTop = top ?? feedTopZ(segments, bounds.max[2]);
  const stock = stockFromBounds(bounds, { margin, cellSize, top: autoTop, base });
  // Carve each move with its cutter — user tool-table edits win over detection,
  // UI slider as the last fallback.
  const resolve = toolResolver(stats.tools, { radius, type: toolType }, opts.toolOverrides);
  const { removedVolume } = simulate(stock, segments, resolve);
  const mesh = heightmapToSolidMesh(stock);
  return {
    positions: mesh.positions,
    indices: mesh.indices,
    nx: mesh.nx,
    ny: mesh.ny,
    removedVolume,
    stockTop: stock.top,
  };
}

/**
 * Full-part voxel simulation: carve every rotary face into one 3D block, with
 * undercuts. Unlike runSimulation this works in the *part* frame and consumes
 * all A/B indices at once, so a 4-/5-axis job comes out whole. Heavier than the
 * height field — meant as a one-shot, coarser default resolution.
 *
 * @param {{voxelSize?:number, margin?:number, radius?:number, toolType?:string}} opts
 * @returns {{positions:Float32Array, normals:Float32Array, indices:Uint32Array,
 *   removedVolume:number, cells:number}}
 */
export function runVoxelSimulation(text, opts = {}) {
  const { voxelSize = 1, margin = 3, radius = 3, toolType = 'flat' } = opts;
  // Part frame (default): every face is assembled onto the workpiece and each
  // segment keeps its A/B index so the swept tool is oriented correctly.
  const { segments, bounds, stats } = interpret(text, { ...opts, rotaryFrame: 'part' });
  const fit = bounds.feedMin && Number.isFinite(bounds.feedMin[0])
    ? { min: bounds.feedMin, max: bounds.feedMax }
    : bounds;
  const vox = createVoxelStock(fit, { margin, cellSize: voxelSize });
  const resolve = toolResolver(stats.tools, { radius, type: toolType }, opts.toolOverrides);
  const { removedVolume } = carveVoxels(vox, segments, resolve);
  const mesh = voxelSurfaceMesh(vox);
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    indices: mesh.indices,
    removedVolume,
    cells: vox.count,
  };
}

/**
 * Turning material-removal: sweep the ZX profile with a round-nosed insert and
 * revolve the remaining radius into a solid. Turn mode only.
 * @param {{cellSize?:number, margin?:number, noseR?:number, rStock?:number}} opts
 */
export function runTurningSimulation(text, opts = {}) {
  const { cellSize = 0.5, margin = 1, stockOversize = 1 } = opts;
  const { segments, bounds } = interpret(text, { ...opts, mode: 'turn' });
  const fit = bounds.feedMin && Number.isFinite(bounds.feedMin[0])
    ? { min: bounds.feedMin, max: bounds.feedMax }
    : bounds;
  const faceZ = detectFaceZ(segments);
  const gap = 5;         // clearance the operator leaves between the cut and chuck
  const chuckClear = 20; // raw bar reaching past the deepest cut into the chuck
  // Raw bar sized `stockOversize` mm over the largest turned *diameter* (so half
  // that on the radius), leaving real material to cut down to the profile.
  const rStock = opts.rStock ?? (fit.max[0] + stockOversize / 2);
  const stock = createTurningStock(fit, { cellSize, margin, rStock, faceZ, chuckClear });
  // Sharp corner: the profile follows the tool path exactly (no nose-radius comp).
  const { removedVolume } = carveTurning(stock, segments, { noseR: 0 });
  const mesh = turningMesh(stock);
  return {
    positions: mesh.positions,
    indices: mesh.indices,
    colors: mesh.colors,
    normals: mesh.normals,
    removedVolume,
    rings: mesh.rings,
    // Geometry the viewport needs to place the chuck: its face sits `gap` mm past
    // the deepest cut so the workpiece doesn't disappear into the jaws.
    zMin: stock.zMin,
    zMax: stock.zMin + stock.nz * stock.cs,
    rStock: stock.rStock,
    chuckFaceZ: fit.min[2] - gap,
  };
}

/**
 * Stateful turning session for cut-with-playback: keeps the radial stock and the
 * ordered feed moves so the viewport can watch the bar turn down as the playhead
 * advances (incremental forward; reset-and-recarve when scrubbing back).
 */
export function createTurningSession(text, opts = {}) {
  const { cellSize = 0.5, margin = 1, stockOversize = 1 } = opts;
  const { segments, bounds } = interpret(text, { ...opts, mode: 'turn' });
  const fit = bounds.feedMin && Number.isFinite(bounds.feedMin[0])
    ? { min: bounds.feedMin, max: bounds.feedMax }
    : bounds;
  const stock = createTurningStock(fit, {
    cellSize, margin, faceZ: detectFaceZ(segments), chuckClear: 20,
    rStock: opts.rStock ?? (fit.max[0] + stockOversize / 2),
  });
  const feeds = segments.filter((s) => s.type !== 'rapid'); // cutting moves, in order
  return { stock, feeds, cursor: 0, totalFeeds: feeds.length };
}

/** Carve the turning session until exactly `k` feed moves have run. */
export function carveTurningSessionTo(session, k) {
  const target = Math.max(0, Math.min(k, session.totalFeeds));
  if (target < session.cursor) {
    resetTurningStock(session.stock);
    session.cursor = 0;
  }
  for (; session.cursor < target; session.cursor++) {
    const s = session.feeds[session.cursor];
    carveTurningMove(session.stock, s.a, s.b, 0); // sharp corner, follows the path
  }
  const mesh = turningMesh(session.stock);
  return {
    positions: mesh.positions,
    indices: mesh.indices,
    colors: mesh.colors,
    normals: mesh.normals,
    cursor: session.cursor,
    totalFeeds: session.totalFeeds,
  };
}
