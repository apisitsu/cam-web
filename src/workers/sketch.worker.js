/**
 * Sketch constraint-solver worker (Phase 2).
 *
 * Wraps the planegcs (WASM) bridge so the FreeCAD PlaneGCS solve runs off the
 * main thread, exactly like the gcode/sim workers. Sketches cross the Comlink
 * boundary in serialized (plain-object) form; the worker deserializes, solves,
 * and returns the solved sketch plus planegcs' conflict/redundancy report.
 *
 * WASM loading differs from the Node path: vite emits `planegcs.wasm` as an
 * asset and `?url` gives its runtime URL, which we hand to the bridge (the Node
 * tests resolve the same file via createRequire instead).
 */
import * as Comlink from 'comlink';
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { createSolver } from '../engine/sketch/planegcs.js';
import { deserialize, serialize } from '../engine/sketch/model.js';

let solverPromise = null;
const getSolver = () => (solverPromise ??= createSolver({ wasmPath: wasmUrl }));

const api = {
  /**
   * @param {object} doc serialized sketch (from `serialize()`)
   * @returns {{success:boolean, status:number, conflicting:string[], redundant:string[], sketch:object}}
   */
  async solve(doc, opts) {
    const solver = await getSolver();
    const sk = deserialize(doc);
    const res = solver.solve(sk, opts);
    return { ...res, sketch: serialize(sk) };
  },
};

Comlink.expose(api);
