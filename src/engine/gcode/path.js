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
 *   feedPrefixAt: Map<aIndex, Uint32Array> — the segment positions of that
 *     index's feed moves, ascending, so `feedsBeforeAt` (called once per
 *     playback tick) is a binary search instead of a rescan. Positions and not a
 *     running count because a continuously rotating A makes nearly every block
 *     its own index — see `feedPositionsByIndex`.
 *   lines: lines[i] = 1-based source line number that produced segment i
 *   blockEnd: blockEnd[i] = index of the last segment of the *block* segment i
 *     belongs to — a block being one source line, which an arc or a helix
 *     tessellates into thousands of segments. Precomputed for the same reason
 *     `feedPrefixAt` is: single-block stepping and the distance-to-go readout
 *     both ask for it once per tick, and a scan would be O(block length).
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
  // What the control is posting alongside the position: the feed in effect
  // (mm/min), the spindle speed, and the feed mode that says how to read the
  // first of them. See `interpret`'s emit().
  const rates = new Float32Array(n);
  const rpms = new Float32Array(n);
  const feedModes = new Uint8Array(n);
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
    rates[i] = s.f || 0;
    rpms[i] = s.rpm || 0;
    feedModes[i] = s.fm || 0;
  }
  return {
    positions, types, feedPrefix, lines, timePrefix, rotary, rotaryB, tools,
    rates, rpms, feedModes,
    feedPrefixAt: feedPositionsByIndex(types, rotary, n),
    blockEnd: blockEnds(lines, n),
    totalTime: elapsed,
    count: n,
  };
}

/**
 * Last segment index of each segment's block, walked backwards so every segment
 * of a block inherits the same end in one pass.
 *
 * A block is a maximal run of segments carrying the same source line. That is
 * what a control means by a block: `G2 X50 Y20 R25` is one block however many
 * chords `interpret()` broke the arc into.
 */
function blockEnds(lines, n) {
  const end = new Uint32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    end[i] = i + 1 < n && lines[i + 1] === lines[i] ? end[i + 1] : i;
  }
  return end;
}

/**
 * Last segment index of the block containing segment `i`.
 *
 * Falls back to a scan for a path built before `blockEnd` existed (or hand-made
 * in a test), so nothing here depends on the array being present.
 */
function blockEndIndex(path, i) {
  if (path.blockEnd) return path.blockEnd[i];
  let j = i;
  while (j + 1 < path.count && path.lines[j + 1] === path.lines[i]) j++;
  return j;
}

/**
 * The playhead one block on from `k` — SINGLE BLOCK on a control: finish the
 * block in progress and stop.
 *
 * `k` counts segments *executed*, so segment `k` is the one about to run. Parked
 * on a block boundary that is the whole of the next block; parked part-way
 * through a move (where a time-paced playhead usually sits) it is the remainder
 * of the move being made. Both are what "one more block" means from there.
 */
export function nextBlockEnd(path, k) {
  if (!path || path.count === 0) return 0;
  const kk = Math.max(0, Math.min(k, path.count));
  if (kk >= path.count) return path.count;
  return blockEndIndex(path, kk) + 1;
}

/**
 * The playhead one block back from `k`: the start of the block that just ran, so
 * pressing it re-runs that block.
 */
export function prevBlockStart(path, k) {
  if (!path || path.count === 0) return 0;
  const kk = Math.max(0, Math.min(k, path.count));
  if (kk <= 0) return 0;
  let i = kk - 1;
  // Part-way through a block, rewind to its start; already at a block start,
  // step over into the block before it.
  while (i > 0 && path.lines[i - 1] === path.lines[i]) i--;
  return i;
}

/**
 * Per rotary index, **where** its feed segments are — ascending segment
 * positions, one entry per feed move at that index.
 *
 * ## Why this is not a prefix array any more
 *
 * It was: one `Uint32Array(n)` per distinct index, each carrying that index's
 * running count forward at every `i`, which made `feedsBeforeAt` a single array
 * read. That rested on an assumption written into its own comment — *"the number
 * of distinct indices in a real program is small (four quarters, six sixths)"* —
 * and a **continuously rotating 4th axis breaks it completely**. `A` is not
 * normalised (a rotary engraving winds on to A3600 and beyond), so nearly every
 * block is its own index: memory and build time both went quadratic in the
 * program's length. Measured: 2,000 blocks cost 15 MB, 4,000 cost 61 MB, and a
 * real 50,000-segment program asks for about 10 GB — which is exactly the
 * *"Parse failed — Array buffer allocation failed"* it produced.
 *
 * Storing positions instead makes the total exactly the number of feed segments,
 * whatever the indices do: one entry each, never a full-length array per index.
 * `feedsBeforeAt` becomes a binary search — O(log) rather than O(1), which is
 * nothing at one call per playback tick, and is the trade that stops the parse
 * failing outright.
 */
function feedPositionsByIndex(types, rotary, n) {
  // Count first so each index's array is allocated exactly once at its real
  // size — the growable-array version of this is what the old code's memory
  // profile is a warning about.
  const counts = new Map();
  for (let i = 0; i < n; i++) {
    if (types[i] !== 1) continue;
    const a = rotary[i];
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  const byIndex = new Map();
  const fill = new Map();
  for (const [a, c] of counts) {
    byIndex.set(a, new Uint32Array(c));
    fill.set(a, 0);
  }
  for (let i = 0; i < n; i++) {
    if (types[i] !== 1) continue;
    const a = rotary[i];
    const at = fill.get(a);
    byIndex.get(a)[at] = i;
    fill.set(a, at + 1);
  }
  return byIndex;
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

/**
 * What the control is running at after `k` segments — the feed rate, the
 * spindle speed, and the feed mode to read the rate in.
 *
 * One accessor rather than three because the three are one reading: a lathe's
 * `feed` only means anything next to its `feedMode`, and the rpm is what turns
 * the first into the mm/rev the programmer typed (see `view/dro.js`). Zeroes
 * for a path built before these existed, or hand-made in a test — the readout
 * posts a dash then, as a control does before the first F word.
 */
export function runningAt(path, k) {
  const none = { feed: 0, rpm: 0, feedMode: 0, rapid: false };
  if (!path || k <= 0 || path.count === 0 || !path.rates) return none;
  const i = Math.min(k, path.count) - 1;
  return {
    feed: path.rates[i] || 0,
    rpm: path.rpms ? path.rpms[i] || 0 : 0,
    feedMode: path.feedModes ? path.feedModes[i] || 0 : 0,
    rapid: path.types[i] === 0,
  };
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
 *
 * A binary search over that index's feed positions (built once in `buildPath`),
 * not a rescan — this runs once per playback tick, and an O(k) scan here made a
 * long 4-axis program's simulation get slower and slower as the playhead
 * advanced. See `feedPositionsByIndex` for why it is positions and not a running
 * count.
 */
export function feedsBeforeAt(path, k, aIndex) {
  const kk = Math.max(0, Math.min(k, path.count));
  if (kk === 0) return 0;
  const arr = path.feedPrefixAt?.get(aIndex);
  if (!arr || arr.length === 0) return 0;
  // How many recorded positions are < kk — i.e. how many of this index's feed
  // moves are already behind the playhead.
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < kk) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * How far the cut has actually got, as a **fractional** feed count: whole feed
 * moves completed, plus how far into the one in progress.
 *
 * The integer version is what the carvers were driven by, and it is why the
 * material came off a whole block at a time: a 50 mm `G1` is one feed move, so
 * the tool crossed the part with nothing happening and then the entire cut
 * appeared at the end of it. Following the tool means carving part of a move.
 *
 * `aIndex` restricts the count to one rotary index — the height field carves
 * one face, so a move at another index adds nothing to its cursor.
 *
 * @param {object} path
 * @param {number} seconds machine time (the same clock the marker rides)
 * @param {number} [aIndex]
 * @returns {number} feeds, fractional
 */
export function feedProgressAt(path, seconds, aIndex) {
  if (!path || path.count === 0 || seconds <= 0) return 0;
  const i = segmentIndexAt(path, seconds);
  if (i < 0) return 0;
  const done = aIndex === undefined
    ? feedsBefore(path, i)
    : feedsBeforeAt(path, i, aIndex);
  // A rapid in progress cuts nothing, and neither does a feed at another index.
  if (path.types[i] !== 1) return done;
  if (aIndex !== undefined && path.rotary && path.rotary[i] !== aIndex) return done;
  const tp = path.timePrefix;
  if (seconds >= tp[path.count - 1]) return done + 1;
  const t0 = i > 0 ? tp[i - 1] : 0;
  const t1 = tp[i];
  const u = t1 > t0 ? (seconds - t0) / (t1 - t0) : 1;
  return done + Math.max(0, Math.min(1, u));
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
 * Index of the segment executing at an exact machine time (-1 before the program
 * starts). Unlike `segmentAtTime`, which counts segments *entered*, this is the
 * one move in progress — what the readouts and the marker are looking at.
 */
export function segmentIndexAt(path, seconds) {
  if (!path || path.count === 0 || seconds <= 0) return -1;
  const tp = path.timePrefix;
  if (seconds >= tp[path.count - 1]) return path.count - 1;
  // Smallest i with tp[i] > seconds — the segment in progress.
  let lo = 0;
  let hi = path.count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tp[mid] > seconds) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** A point `f` of the way along segment `i` (f = 1 is its end point). */
function posAt(path, i, f) {
  const o = i * 6;
  return [
    path.positions[o] + (path.positions[o + 3] - path.positions[o]) * f,
    path.positions[o + 1] + (path.positions[o + 4] - path.positions[o + 1]) * f,
    path.positions[o + 2] + (path.positions[o + 5] - path.positions[o + 2]) * f,
  ];
}

/**
 * Tool-tip position at an exact machine time, interpolated *within* the segment
 * that is executing then. Segment-boundary positions make a program of few, long
 * moves (a lathe pass can run 13 s) jump and stutter; lerping by time lets the
 * marker glide smoothly along each cut.
 */
export function toolPointAt(path, seconds) {
  const i = segmentIndexAt(path, seconds);
  if (i < 0) return null;
  const tp = path.timePrefix;
  if (seconds >= tp[path.count - 1]) return posAt(path, i, 1);
  const t0 = i > 0 ? tp[i - 1] : 0;
  const t1 = tp[i];
  return posAt(path, i, t1 > t0 ? (seconds - t0) / (t1 - t0) : 1);
}

/**
 * Where the block in progress at `seconds` ends up — the end point of its last
 * segment, which is the position the block was programmed to reach.
 *
 * This is the target the DISTANCE TO GO readout counts down to, and it is the
 * *block's* end rather than the segment's on purpose: mid-arc, the segment end is
 * a chord away (a few microns) and would read as 0.000 for the whole move, while
 * the number an operator wants is how far this G2 still has to run.
 *
 * Stopped exactly on a block boundary, the segment "in progress" is the first of
 * the block about to run, so the readout posts the move that is queued up — what
 * the next cycle start will do.
 */
export function blockTargetAt(path, seconds) {
  const i = segmentIndexAt(path, seconds);
  if (i < 0) return null;
  return posAt(path, blockEndIndex(path, i), 1);
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
