/**
 * Public entry for the G-code engine.
 *
 * `parseGcode` runs the interpreter and packs the resulting segments into flat
 * Float32Arrays laid out for THREE.LineSegments (each segment = 2 vertices =
 * 6 floats). Rapids and feeds are separated so the viewport can colour them
 * differently. The returned buffers are transferable out of a Web Worker.
 */
import { interpret } from './interpreter.js';
import { buildPath } from './path.js';

export { interpret } from './interpreter.js';
export { tokenizeLine } from './tokenizer.js';
export { buildPath, sliceUpTo, feedsBefore, feedsBeforeAt, lineAt, timeAt, rotaryAt, toolAt } from './path.js';
export { expandProgram } from './macro.js';

/** @param {{mode?:'mill'|'turn', rapidRate?:number, diameterMode?:boolean}} opts */
export function parseGcode(text, opts) {
  const { segments, bounds, stats } = interpret(text, opts);
  const path = buildPath(segments);

  let rapidCount = 0;
  let feedCount = 0;
  for (const s of segments) {
    if (s.type === 'rapid') rapidCount++;
    else feedCount++;
  }

  const rapids = new Float32Array(rapidCount * 6);
  const feeds = new Float32Array(feedCount * 6);
  let ri = 0;
  let fi = 0;
  for (const s of segments) {
    const buf = s.type === 'rapid' ? rapids : feeds;
    let i = s.type === 'rapid' ? ri : fi;
    buf[i++] = s.a[0]; buf[i++] = s.a[1]; buf[i++] = s.a[2];
    buf[i++] = s.b[0]; buf[i++] = s.b[1]; buf[i++] = s.b[2];
    if (s.type === 'rapid') ri = i; else fi = i;
  }

  return { rapids, feeds, bounds, stats, path };
}
