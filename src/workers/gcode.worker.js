/**
 * G-code parse worker.
 *
 * Runs the (potentially heavy) tokenize + interpret + tessellate pipeline off
 * the main thread so the R3F viewport never drops below 60fps. Exposed via
 * Comlink; the packed Float32Array buffers are transferred (zero-copy) back.
 */
import * as Comlink from 'comlink';
import { parseGcode } from '../engine/gcode/index.js';

const api = {
  /**
   * @param {string} text raw G-code program
   * @param {{mode?:string, rapidRate?:number, diameterMode?:boolean}} opts
   * @returns {{rapids:Float32Array, feeds:Float32Array, bounds:object, stats:object}}
   */
  parse(text, opts) {
    const result = parseGcode(text, opts);
    return Comlink.transfer(result, [
      result.rapids.buffer,
      result.feeds.buffer,
      result.path.positions.buffer,
      result.path.types.buffer,
      result.path.feedPrefix.buffer,
      result.path.lines.buffer,
      result.path.timePrefix.buffer,
      result.path.rotary.buffer,
      result.path.rotaryB.buffer,
      result.path.tools.buffer,
    ]);
  },
};

Comlink.expose(api);
