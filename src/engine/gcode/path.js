/**
 * Ordered toolpath representation for playback.
 *
 * The static backplot only needs rapids/feeds split by colour, but scrubbing
 * through a program needs the moves *in execution order*. buildPath packs every
 * segment sequentially; sliceUpTo returns the sub-path visible at a given
 * playhead plus the tool position there.
 */

/**
 * @param {{type:string, a:number[], b:number[], t?:number, a4?:number, b4?:number}[]} segments  in execution order
 * @returns {{positions:Float32Array, types:Uint8Array, feedPrefix:Uint32Array, lines:Uint32Array, timePrefix:Float32Array, rotary:Float32Array, rotaryB:Float32Array, totalTime:number, count:number}}
 *   positions: 6 floats per segment (ax,ay,az,bx,by,bz)
 *   types: 0 = rapid, 1 = feed
 *   feedPrefix: feedPrefix[i] = number of feed segments in [0, i]
 *   lines: lines[i] = 1-based source line number that produced segment i
 *   timePrefix: timePrefix[i] = seconds elapsed once segment i has run
 *   rotary: rotary[i] = A-axis index (degrees) segment i was machined at
 *   rotaryB: rotaryB[i] = B-axis index (degrees) segment i was machined at
 */
export function buildPath(segments) {
  const n = segments.length;
  const positions = new Float32Array(n * 6);
  const types = new Uint8Array(n);
  const feedPrefix = new Uint32Array(n);
  const lines = new Uint32Array(n);
  const timePrefix = new Float32Array(n);
  const rotary = new Float32Array(n);
  const rotaryB = new Float32Array(n);
  const tools = new Uint16Array(n);
  let feeds = 0;
  let elapsed = 0;
  for (let i = 0; i < n; i++) {
    const s = segments[i];
    const o = i * 6;
    positions[o] = s.a[0]; positions[o + 1] = s.a[1]; positions[o + 2] = s.a[2];
    positions[o + 3] = s.b[0]; positions[o + 4] = s.b[1]; positions[o + 5] = s.b[2];
    if (s.type !== 'rapid') feeds++;
    types[i] = s.type === 'rapid' ? 0 : 1;
    feedPrefix[i] = feeds;
    lines[i] = s.line || 0;
    elapsed += s.t || 0;
    timePrefix[i] = elapsed;
    rotary[i] = s.a4 || 0;
    rotaryB[i] = s.b4 || 0;
    tools[i] = s.tool || 0;
  }
  return { positions, types, feedPrefix, lines, timePrefix, rotary, rotaryB, tools, totalTime: elapsed, count: n };
}

/** Rotary indices (A/B degrees) in effect after `k` segments have run. */
export function rotaryAt(path, k) {
  if (!path || k <= 0 || path.count === 0) return { a: 0, b: 0 };
  const i = Math.min(k, path.count) - 1;
  return { a: path.rotary[i] || 0, b: path.rotaryB ? path.rotaryB[i] || 0 : 0 };
}

/** Tool number in effect after `k` segments have run (0 = none stated). */
export function toolAt(path, k) {
  if (!path || k <= 0 || path.count === 0 || !path.tools) return 0;
  const i = Math.min(k, path.count) - 1;
  return path.tools[i] || 0;
}

/** 1-based source line that is executing after `k` segments have run (0 = none). */
export function lineAt(path, k) {
  if (!path || k <= 0 || path.count === 0) return 0;
  const i = Math.min(k, path.count) - 1;
  return path.lines[i];
}

/** Number of feed (cutting) segments executed by the time `k` segments have run. */
export function feedsBefore(path, k) {
  if (k <= 0 || path.count === 0) return 0;
  const i = Math.min(k, path.count) - 1;
  return path.feedPrefix[i];
}

/**
 * Feed segments machined at rotary index `aIndex` by the time `k` segments have
 * run. The simulator only carves one index, so this — not feedsBefore — is what
 * maps the playhead onto its cursor.
 */
export function feedsBeforeAt(path, k, aIndex) {
  const kk = Math.max(0, Math.min(k, path.count));
  let n = 0;
  for (let i = 0; i < kk; i++) {
    if (path.types[i] === 1 && path.rotary[i] === aIndex) n++;
  }
  return n;
}

/** Seconds of machine time elapsed once `k` segments have run. */
export function timeAt(path, k) {
  if (!path || k <= 0 || path.count === 0) return 0;
  const i = Math.min(k, path.count) - 1;
  return path.timePrefix[i];
}

/**
 * Playhead (segments executed) at a given machine time. The inverse of timeAt,
 * so playback can advance by *time* rather than by segment count — otherwise a
 * tool whose moves tessellate into many short segments (a helix) hogs the
 * animation while a tool with a few long moves (a face mill) flashes past.
 */
export function segmentAtTime(path, seconds) {
  if (!path || path.count === 0 || seconds <= 0) return 0;
  const tp = path.timePrefix;
  if (seconds >= tp[path.count - 1]) return path.count;
  // Smallest i with tp[i] >= seconds; the playhead is that many segments + 1.
  let lo = 0;
  let hi = path.count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tp[mid] >= seconds) hi = mid; else lo = mid + 1;
  }
  return lo + 1;
}

/**
 * Tool-tip position at an exact machine time, interpolated *within* the segment
 * that is executing then. Segment-boundary positions make a program of few, long
 * moves (a lathe pass can run 13 s) jump and stutter; lerping by time lets the
 * marker glide smoothly along each cut.
 */
export function toolPointAt(path, seconds) {
  if (!path || path.count === 0 || seconds <= 0) return null;
  const tp = path.timePrefix;
  const total = tp[path.count - 1];
  const posAt = (i, f) => {
    const o = i * 6;
    return [
      path.positions[o] + (path.positions[o + 3] - path.positions[o]) * f,
      path.positions[o + 1] + (path.positions[o + 4] - path.positions[o + 1]) * f,
      path.positions[o + 2] + (path.positions[o + 5] - path.positions[o + 2]) * f,
    ];
  };
  if (seconds >= total) return posAt(path.count - 1, 1);
  // Smallest i with tp[i] > seconds — the segment in progress.
  let lo = 0;
  let hi = path.count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tp[mid] > seconds) hi = mid; else lo = mid + 1;
  }
  const t0 = lo > 0 ? tp[lo - 1] : 0;
  const t1 = tp[lo];
  return posAt(lo, t1 > t0 ? (seconds - t0) / (t1 - t0) : 1);
}

/**
 * Return the sub-path visible after `k` segments have executed, split by type,
 * plus the current tool tip position (end of segment k-1, or null at k=0).
 */
export function sliceUpTo(path, k) {
  const kk = Math.max(0, Math.min(k, path.count));
  let rapidN = 0;
  for (let i = 0; i < kk; i++) if (path.types[i] === 0) rapidN++;
  const feedN = kk - rapidN;

  const rapids = new Float32Array(rapidN * 6);
  const feeds = new Float32Array(feedN * 6);
  let ri = 0;
  let fi = 0;
  for (let i = 0; i < kk; i++) {
    const src = i * 6;
    const buf = path.types[i] === 0 ? rapids : feeds;
    let d = path.types[i] === 0 ? ri : fi;
    for (let c = 0; c < 6; c++) buf[d + c] = path.positions[src + c];
    if (path.types[i] === 0) ri += 6; else fi += 6;
  }

  let tool = null;
  if (kk > 0) {
    const o = (kk - 1) * 6;
    tool = [path.positions[o + 3], path.positions[o + 4], path.positions[o + 5]];
  }
  return { rapids, feeds, tool };
}
