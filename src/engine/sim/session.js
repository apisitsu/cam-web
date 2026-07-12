/**
 * Stateful simulation session for playback ("watch it cut").
 *
 * Building a fresh stock and re-carving the whole program on every slider tick
 * is wasteful. A session keeps the stock + ordered cutting moves in memory and
 * a cursor over the feed moves:
 *   - scrubbing forward carves only the newly-passed moves (incremental, cheap)
 *   - scrubbing backward resets the stock and re-carves to the target
 *
 * Playback is expressed in *feed* moves (rapids remove nothing), so the caller
 * maps its all-segment playhead through feedsBefore() before calling carveTo.
 *
 * The stock is a Z-up height field, which is only meaningful while the tool
 * points along +Z. On a 4-axis program that holds for one rotary index at a
 * time, so a session carves a single A index, in machine coordinates.
 */
import { interpret } from '../gcode/interpreter.js';
import { stockFromBounds, resetStock, cutSegment } from './dexel.js';
import { heightmapToSolidMesh } from './mesh.js';

/**
 * Build a per-segment cutter resolver from the tool table.
 *
 * `tools` is `stats.tools` (auto-detected from the program's comments); each feed
 * move carries the tool number that cut it, so a slot roughed with a Ø7 endmill
 * and a hole bored with a Ø9 drill each carve at their own size. `overrides` is
 * the user's tool-table edits, keyed by tool number ({ diameter?, simType? }),
 * which win over detection — so a program whose comments are wrong or missing can
 * still be simulated with the right cutter. Anything unresolved falls back to
 * `defaultTool`.
 *
 * @param {Object<number,{diameter?:number, simType?:string}>} [overrides]
 * @returns {(seg:object)=>{radius:number, type:string}}
 */
export function toolResolver(tools, defaultTool, overrides = {}) {
  const detected = new Map((tools || []).map((t) => [t.n, t]));
  const nums = new Set([
    ...detected.keys(),
    ...Object.keys(overrides || {}).map(Number),
  ]);
  const byNum = new Map();
  for (const n of nums) {
    if (!n) continue;
    const d = detected.get(n) || {};
    const o = (overrides && overrides[n]) || {};
    const diameter = o.diameter ?? d.diameter;
    const radius = diameter != null ? diameter / 2 : d.radius;
    const type = o.simType ?? d.simType ?? 'flat';
    if (radius > 0) byNum.set(n, { radius, type });
  }
  if (byNum.size === 0) return () => defaultTool;
  return (seg) => byNum.get(seg.tool) || defaultTool;
}

/** The A index that does the most cutting — the sensible thing to show first. */
export function dominantIndex(segments) {
  const cut = new Map();
  for (const s of segments) {
    if (s.type === 'rapid') continue;
    cut.set(s.a4, (cut.get(s.a4) || 0) + 1);
  }
  let best = 0;
  let bestN = -1;
  for (const [a, n] of cut) if (n > bestN) { best = a; bestN = n; }
  return best;
}

/** Axis-aligned bounds of a segment list (empty list → a degenerate box at 0). */
export function boundsOf(segments) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const s of segments) {
    for (const p of [s.a, s.b]) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    }
  }
  if (!isFinite(min[0])) { min.fill(0); max.fill(0); }
  return { min, max };
}

/**
 * Height of the material surface, inferred from the toolpath.
 *
 * The highest Z of any feed move is wrong: a plunge is a feed move, and it
 * begins in the air above the billet (`G1 Z18.4 F800` from a Z30 clearance
 * height starts at Z30). What actually proves material is there is a feed move
 * that travels in XY — the cut itself. Fall back to the plunge height for a
 * pure drilling program, which never cuts sideways.
 */
export function feedTopZ(segments, fallback) {
  let cutHi = -Infinity;      // highest Z of a feed move that travels in XY
  let cutLo = Infinity;       // lowest such Z
  let plungeTop = -Infinity;  // highest Z any feed move reaches (a plunge's air start)
  for (const s of segments) {
    if (s.type === 'rapid') continue;
    const hi = Math.max(s.a[2], s.b[2]);
    if (hi > plungeTop) plungeTop = hi;
    const movesInXY = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > 1e-6;
    if (movesInXY) {
      if (hi > cutHi) cutHi = hi;
      const lo = Math.min(s.a[2], s.b[2]);
      if (lo < cutLo) cutLo = lo;
    }
  }
  if (isFinite(cutHi)) {
    // Cutting at several depths: the shallowest cut sits at (or just under) the
    // material surface, so its Z is the tightest honest stock top.
    if (cutHi > cutLo + 1e-6) return cutHi;
    // Cutting at a single depth (a slot/pocket plunged straight to size): the
    // highest cut is also the deepest, so a stock top flush with it would leave
    // nothing above the tool and remove zero material. The surface is above the
    // cut; the best proxy we have is where the plunge feed enters from the
    // clearance plane (the top of the plunging move).
    return plungeTop > cutHi ? plungeTop : cutHi;
  }
  return isFinite(plungeTop) ? plungeTop : fallback;
}

export function createSession(text, opts = {}) {
  const { radius = 3, toolType = 'flat', cellSize = 0.5, margin = 5, top, base } = opts;
  // Machine frame: the tool is along +Z, which is what the height field assumes.
  // opts also carries the machine mode / diameter flag; interpret ignores the
  // tool + stock keys it doesn't recognise.
  const { segments, stats } = interpret(text, { ...opts, rotaryFrame: 'machine' });

  const aIndex = opts.aIndex ?? dominantIndex(segments);
  const atIndex = segments.filter((s) => s.a4 === aIndex);
  const feeds = atIndex.filter((s) => s.type !== 'rapid'); // cutting moves, in order

  // Size the billet to this index's moves only — the other faces are machined
  // in a different orientation and would inflate the grid to no purpose.
  const bounds = boundsOf(atIndex);
  const autoTop = top ?? feedTopZ(feeds, bounds.max[2]);
  const stock = stockFromBounds(bounds, { margin, cellSize, top: autoTop, base });
  return {
    stock,
    feeds,
    // Each feed carves with its own cutter — user tool-table edits win over
    // detection; the UI slider is the fallback for tools never described.
    tool: toolResolver(stats.tools, { radius, type: toolType }, opts.toolOverrides),
    cursor: 0, // number of feed moves already carved
    removed: 0,
    totalFeeds: feeds.length,
    bounds,
    aIndex,
  };
}

/** Carve until exactly `k` feed moves have executed (0..totalFeeds). */
export function carveTo(session, k) {
  const target = Math.max(0, Math.min(k, session.totalFeeds));
  if (target < session.cursor) {
    resetStock(session.stock);
    session.cursor = 0;
    session.removed = 0;
  }
  for (; session.cursor < target; session.cursor++) {
    const s = session.feeds[session.cursor];
    session.removed += cutSegment(session.stock, s.a, s.b, session.tool(s));
  }
  const mesh = heightmapToSolidMesh(session.stock);
  return {
    positions: mesh.positions,
    indices: mesh.indices,
    nx: mesh.nx,
    ny: mesh.ny,
    removedVolume: session.removed,
    cursor: session.cursor,
    totalFeeds: session.totalFeeds,
    aIndex: session.aIndex,
  };
}
