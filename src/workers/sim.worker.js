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
} from '../engine/sim/index.js';

let session = null;
let turnSession = null;

const api = {
  run(text, opts) {
    const result = runSimulation(text, opts);
    return Comlink.transfer(result, [result.positions.buffer, result.indices.buffer]);
  },

  /**
   * One-shot voxel simulation: the whole part, all rotary faces, undercuts
   * included. Returns a surface mesh (positions + indices); StockMesh recomputes
   * normals, so we don't ship them.
   */
  runVoxel(text, opts) {
    const { positions, indices, removedVolume, cells } = runVoxelSimulation(text, opts);
    return Comlink.transfer(
      { positions, indices, removedVolume, cells },
      [positions.buffer, indices.buffer],
    );
  },

  /** Turning sim: revolve the carved radial profile into a solid. */
  runTurning(text, opts) {
    const r = runTurningSimulation(text, opts);
    return Comlink.transfer(
      {
        positions: r.positions, indices: r.indices, colors: r.colors,
        removedVolume: r.removedVolume,
        rings: r.rings, zMin: r.zMin, zMax: r.zMax, rStock: r.rStock,
      },
      [r.positions.buffer, r.indices.buffer, r.colors.buffer],
    );
  },

  /** Start a turning playback session; returns totalFeeds + the fully-cut part. */
  initTurning(text, opts) {
    turnSession = createTurningSession(text, opts);
    const r = carveTurningSessionTo(turnSession, turnSession.totalFeeds);
    return Comlink.transfer(r, [r.positions.buffer, r.indices.buffer, r.colors.buffer]);
  },

  /** Carve the turning session until `k` feed moves have run (for playback). */
  carveTurningStep(k) {
    if (!turnSession) throw new Error('turning session not initialised');
    const r = carveTurningSessionTo(turnSession, k);
    return Comlink.transfer(r, [r.positions.buffer, r.indices.buffer, r.colors.buffer]);
  },

  /** Start a playback session; returns totalFeeds + the uncut stock mesh. */
  init(text, opts) {
    session = createSession(text, opts);
    const result = carveTo(session, 0);
    return Comlink.transfer(result, [result.positions.buffer, result.indices.buffer]);
  },

  /** Carve the active session until `k` feed moves have run. */
  carve(k) {
    if (!session) throw new Error('sim session not initialised');
    const result = carveTo(session, k);
    return Comlink.transfer(result, [result.positions.buffer, result.indices.buffer]);
  },
};

Comlink.expose(api);
