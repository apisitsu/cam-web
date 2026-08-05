/**
 * Material-removal simulation worker (Phase 1) with playback support.
 *
 * `run` does a one-shot full simulation. `init` + `carve` drive a stateful
 * session so the viewport can scrub the cut cheaply (incremental forward,
 * reset-and-recarve backward). All heavy carving stays off the main thread; the
 * resulting mesh buffers transfer back zero-copy.
 */
import * as Comlink from 'comlink';
import {
  runSimulation, runVoxelSimulation, runTurningSimulation, createSession, carveTo,
  createTurningSession, carveTurningSessionTo,
  createVoxelSession, carveVoxelSessionTo,
} from '../engine/sim/index.js';

let session = null;
let turnSession = null;
let voxSession = null;

const api = {
  run(text, opts) {
    const result = runSimulation(text, opts);
    return Comlink.transfer(result, [result.positions.buffer, result.indices.buffer]);
  },

  // NOTE: the height-field meshes below ship `colors` too (cut vs raw stock).
  // Those share the mesh builder's own buffer, which is re-created per carve,
  // so they are transferred with the rest.

  /**
   * One-shot voxel simulation: the whole part, all rotary faces, undercuts
   * included. Returns a surface mesh (positions + indices); StockMesh recomputes
   * normals, so we don't ship them.
   */
  runVoxel(text, opts) {
    const {
      positions, normals, colors, indices, removedVolume, cells,
    } = runVoxelSimulation(text, opts);
    return Comlink.transfer(
      { positions, normals, colors, indices, removedVolume, cells },
      [positions.buffer, normals.buffer, colors.buffer, indices.buffer],
    );
  },

  /**
   * Start a voxel playback session; returns totalFeeds and the uncut block.
   *
   * The voxel sim used to be one-shot — the finished part, with no way to watch
   * it happen. Since an undercutting cutter now needs this model for ordinary
   * work, that trade is no longer one the operator can avoid, so it is a
   * session like the other two.
   */
  initVoxel(text, opts) {
    voxSession = createVoxelSession(text, opts);
    const r = carveVoxelSessionTo(voxSession, 0);
    r.box = voxSession.box;
    return Comlink.transfer(r,
      [r.positions.buffer, r.normals.buffer, r.colors.buffer, r.indices.buffer]);
  },

  /** Carve the voxel session until `k` feed moves have run. */
  carveVoxelStep(k) {
    if (!voxSession) throw new Error('voxel session not initialised');
    const r = carveVoxelSessionTo(voxSession, k);
    return Comlink.transfer(r,
      [r.positions.buffer, r.normals.buffer, r.colors.buffer, r.indices.buffer]);
  },

  /** Turning sim: revolve the carved radial profile into a solid. */
  runTurning(text, opts) {
    const r = runTurningSimulation(text, opts);
    return Comlink.transfer(
      {
        positions: r.positions, indices: r.indices, colors: r.colors,
        normals: r.normals,
        removedVolume: r.removedVolume,
        rings: r.rings, zMin: r.zMin, zMax: r.zMax, rStock: r.rStock,
      },
      // A revolve's normals are exact, so they are computed in the engine and
      // shipped with the mesh rather than re-derived by face averaging.
      [r.positions.buffer, r.indices.buffer, r.colors.buffer, r.normals.buffer],
    );
  },

  /** Start a turning playback session; returns totalFeeds + the fully-cut part. */
  initTurning(text, opts) {
    turnSession = createTurningSession(text, opts);
    const r = carveTurningSessionTo(turnSession, turnSession.totalFeeds);
    return Comlink.transfer(r, [r.positions.buffer, r.indices.buffer, r.colors.buffer, r.normals.buffer]);
  },

  /** Carve the turning session until `k` feed moves have run (for playback). */
  carveTurningStep(k) {
    if (!turnSession) throw new Error('turning session not initialised');
    const r = carveTurningSessionTo(turnSession, k);
    return Comlink.transfer(r, [r.positions.buffer, r.indices.buffer, r.colors.buffer, r.normals.buffer]);
  },

  /** Start a playback session; returns totalFeeds + the uncut stock mesh. */
  init(text, opts) {
    session = createSession(text, opts);
    const result = carveTo(session, 0);
    // Carried back so the store can say *why* a carve removed nothing instead
    // of leaving a solid block to speak for itself — see `sim/removal.js`.
    result.cutBounds = session.cutBounds;
    result.box = session.box;
    // The grid this session settled on — refined to the smallest cutter, and
    // held back if a budget said so. The store reports it: a run that simulates
    // at something other than the number in the box owes the operator that.
    result.cellSize = session.cellSize;
    result.cellSizeLimited = session.cellSizeLimited;
    return Comlink.transfer(result,
      [result.positions.buffer, result.colors.buffer, result.indices.buffer]);
  },

  /** Carve the active session until `k` feed moves have run. */
  carve(k) {
    if (!session) throw new Error('sim session not initialised');
    const result = carveTo(session, k);
    return Comlink.transfer(result,
      [result.positions.buffer, result.colors.buffer, result.indices.buffer]);
  },
};

Comlink.expose(api);
