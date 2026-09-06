/**
 * Phase 1 simulation entry: parse G-code → carve stock → build a render mesh.
 * Returns typed-array buffers ready to transfer out of the worker.
 */
import { interpret } from '../gcode/interpreter.js';
import { stockFromBounds, simulate } from './dexel.js';
import { billetBox } from './billet.js';
import { cuttingBounds } from './removal.js';
import { cutterGeometry } from '../cam/cutters.js';
import { heightmapToSolidMesh } from './mesh.js';
import {
  dominantIndex, boundsOf, feedTopZ, toolResolver, advanceCut,
} from './session.js';
import { voxelSizeFor, thinnestCut, cellSizeFor, cutterSpan } from './method.js';
import { createVoxelStock, carveVoxels, voxelSurfaceMesh } from './voxel.js';
import {
  createTurningStock, carveTurning, carveTurningMove, resetTurningStock,
  turningMesh, detectFaceZ,
} from './turning.js';

export { createStock, stockFromBounds, resetStock, stamp, cutSegment, simulate } from './dexel.js';
export { heightmapToMesh, heightmapToSolidMesh } from './mesh.js';
export {
  createSession, carveTo, createVoxelSession, carveVoxelSessionTo,
  dominantIndex, boundsOf, feedTopZ, toolResolver,
} from './session.js';
export {
  simMethodFor, undercutting, voxelSizeFor, thinnestCut, cellSizeFor, cutterSpan,
} from './method.js';
export { removalDiagnosis, cuttingBounds } from './removal.js';
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
  const {
    radius = 3, toolType = 'flat', cellSize = 0.5, margin = 5, top, base,
    stockSize, stockOrigin,
  } = opts;
  // The height field assumes the tool points along +Z, which is only true in the
  // machine frame and only for one rotary index at a time.
  const { segments: all, stats } = interpret(text, { ...opts, rotaryFrame: 'machine' });
  const aIndex = opts.aIndex ?? dominantIndex(all);
  const segments = all.filter((s) => s.a4 === aIndex);
  const bounds = boundsOf(segments);
  // Centred on the cutting, not on a clearance rapid — see `billet.js`.
  const fit = cuttingBounds(segments) ?? bounds;
  const autoTop = top ?? feedTopZ(segments, bounds.max[2]);
  // Carve each move with its cutter — user tool-table edits win over detection,
  // UI slider as the last fallback.
  // The fallback cutter, for moves whose tool the program never described. A
  // chosen TYPE wins over the bare flat/ball, so a chamfer mill carves its cone
  // instead of a flat floor — see `cam/cutters.js`.
  const fallbackTool = opts.cutter
    ? cutterGeometry({
      cutter: opts.cutter,
      diameter: radius * 2,
      angle: opts.angle,
      thickness: opts.thickness,
    })
    : { radius, type: toolType };
  // The grid is refined to the smallest cutter in the cut and bounded by what
  // it costs — the same rule the playback session uses, so pressing Simulate
  // and scrubbing the playhead cannot show two different parts.
  const grid = cellSizeFor({
    requested: cellSize,
    span: cutterSpan({ tools: stats.tools, fallbackTool, overrides: opts.toolOverrides }),
    bounds: fit,
    cutLength: stats.feedLength,
  });
  // A stated billet — size, and the corner it sits on — wins per axis; anything
  // left blank still falls back to wrapping the toolpath. See `billet.js`.
  const stock = stockFromBounds(fit, {
    margin, cellSize: grid.size, top: autoTop, base, size: stockSize, origin: stockOrigin,
  });
  const resolve = toolResolver(stats.tools, fallbackTool, opts.toolOverrides);
  const { removedVolume } = simulate(stock, segments, resolve);
  const mesh = heightmapToSolidMesh(stock);
  return {
    positions: mesh.positions,
    // Cut faces are a different colour from raw stock — see `stockColors.js`.
    colors: mesh.colors,
    indices: mesh.indices,
    nx: mesh.nx,
    ny: mesh.ny,
    removedVolume,
    stockTop: stock.top,
    // What the grid came out at, and whether a budget rather than the tooling
    // decided it — see `cellSizeFor`.
    cellSize: grid.size,
    cellSizeLimited: grid.limited,
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
  const {
    voxelSize = 1, margin = 3, radius = 3, toolType = 'flat', stockSize, stockOrigin,
  } = opts;
  // Part frame (default): every face is assembled onto the workpiece and each
  // segment keeps its A/B index so the swept tool is oriented correctly.
  const { segments, bounds, stats } = interpret(text, { ...opts, rotaryFrame: 'part' });
  const feeds = segments.filter((s) => s.type !== 'rapid');
  const indices = new Set(feeds.map((f) => f.a4 || 0));
  const raw = bounds.feedMin && Number.isFinite(bounds.feedMin[0])
    ? { min: bounds.feedMin, max: bounds.feedMax }
    : bounds;
  // The surface is where a feed move TRAVELS, not where the highest one starts
  // — a plunge begins in the air. See `createVoxelSession`.
  const oneFace = indices.size <= 1;
  const fit = oneFace ? (cuttingBounds(feeds) ?? raw) : raw;
  const autoTop = oneFace ? feedTopZ(feeds, raw.max[2]) : undefined;
  // The stated billet, where there is one. `margin` is dropped to zero for a
  // sized axis: the operator gave the blank's real dimensions and padding them
  // would quietly hand back a block bigger than the material they have.
  const box = billetBox(fit, stockSize ?? {}, {
    margin, origin: stockOrigin ?? {}, autoTop,
  });
  const block = {
    min: [box.xMin, box.yMin, box.base],
    max: [box.xMax, box.yMax, box.top],
  };
  // A cut is rounded out to whole voxels, so the grid has to be fine enough to
  // hold the thinnest thing being cut — see `voxelSizeFor`.
  const { size: cellSize, sizeZ: cellSizeZ } = voxelSizeFor({
    requested: voxelSize,
    thickness: thinnestCut({
      fallbackTool: { thickness: opts.thickness },
      overrides: opts.toolOverrides,
    }),
    bounds: block,
  });
  const vox = createVoxelStock(block, { margin: 0, cellSize, cellSizeZ });
  // The fallback cutter, for moves whose tool the program never described. A
  // chosen TYPE wins over the bare flat/ball, so a chamfer mill carves its cone
  // instead of a flat floor — see `cam/cutters.js`.
  const fallbackTool = opts.cutter
    ? cutterGeometry({
      cutter: opts.cutter,
      diameter: radius * 2,
      angle: opts.angle,
      thickness: opts.thickness,
    })
    : { radius, type: toolType };
  const resolve = toolResolver(stats.tools, fallbackTool, opts.toolOverrides);
  const { removedVolume } = carveVoxels(vox, segments, resolve);
  const mesh = voxelSurfaceMesh(vox);
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    colors: mesh.colors,
    indices: mesh.indices,
    removedVolume,
    cells: vox.count,
    cellSize,
    cellSizeZ,
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
  // `partial` and `removed` are `advanceCut`'s bookkeeping — the fraction of the
  // move in progress that has been cut, and the running total. Turning kept
  // neither while it stepped whole moves.
  return {
    stock, feeds, cursor: 0, partial: 0, removed: 0, totalFeeds: feeds.length,
  };
}

/** A point `t` of the way along a turning move (`[radius, _, z]`). */
function lerpTurn(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Carve the turning session to `k` feed moves — **fractional**.
 *
 * It used to round `k` down and step whole moves, which is why the stock came
 * off a step at a time instead of under the insert: a roughing pass is one long
 * `G1`, so the tool travelled the length of the part with nothing happening and
 * then the whole cut appeared at the end of it. Milling and the voxel block had
 * already been given `advanceCut` for exactly this; turning was the one left
 * counting whole moves, and it is the model where a single move is longest.
 */
export function carveTurningSessionTo(session, k) {
  advanceCut(session, k, {
    reset: () => resetTurningStock(session.stock),
    // Sharp corner: the envelope follows the programmed path.
    cut: (seg, t0, t1) => carveTurningMove(
      session.stock, lerpTurn(seg.a, seg.b, t0), lerpTurn(seg.a, seg.b, t1), 0,
    ),
  });
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
