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
import { cutterGeometry } from '../cam/cutters.js';
import { billetBox } from './billet.js';
import { voxelSizeFor, thinnestCut, cellSizeFor, cutterSpan } from './method.js';
import {
  createVoxelStock, carveVoxelMove, voxelSurfaceMesh, toolAxisFor,
} from './voxel.js';
import { effectiveTool } from '../cam/effectiveTool.js';
import { cuttingBounds } from './removal.js';

/**
 * Build a per-segment cutter resolver from the tool table.
 *
 * `tools` is `stats.tools` (auto-detected from the program's comments); each feed
 * move carries the tool number that cut it, so a slot roughed with a Ø7 endmill
 * and a hole bored with a Ø9 drill each carve at their own size. `overrides` is
 * the user's tool-table edits, keyed by tool number ({ diameter?, cutter?,
 * simType? }), which win over detection — so a program whose comments are wrong
 * or missing can still be simulated with the right cutter. Anything unresolved
 * falls back to `defaultTool`.
 *
 * The precedence itself is `cam/effectiveTool.js`, shared with the tool marker:
 * the cutter that carves and the cutter drawn on screen are the same decision,
 * and they were once made twice.
 *
 * @param {Object<number,{diameter?:number, cutter?:string, simType?:string}>} [overrides]
 * @returns {(seg:object)=>{radius:number, type:string, angle?:number}}
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
    const t = effectiveTool({
      detected: detected.get(n),
      override: overrides && overrides[n],
      fallback: defaultTool,
    });
    if (t.radius > 0) byNum.set(n, t);
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
 *
 * A **ramp** travels in XY too, and it also begins in the air: `G1 X50 Z-1`
 * entering from a Z5 clearance plane cuts nothing for most of its length. So a
 * travelling move is credited with the *lower* of its two ends — where it has
 * actually reached material — not the higher. Crediting the high end put the
 * clearance plane back on top of the blank as a slab of phantom material, and
 * a job then simulated three or four passes deep before anything visibly came
 * off.
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
      // The lower end: a ramp's high end is still in the air.
      const lo = Math.min(s.a[2], s.b[2]);
      if (lo > cutHi) cutHi = lo;
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
  const {
    radius = 3, toolType = 'flat', cellSize = 0.5, margin = 5, top, base,
    stockSize, stockOrigin,
  } = opts;
  // Machine frame: the tool is along +Z, which is what the height field assumes.
  // opts also carries the machine mode / diameter flag; interpret ignores the
  // tool + stock keys it doesn't recognise.
  const { segments, stats } = interpret(text, { ...opts, rotaryFrame: 'machine' });

  const aIndex = opts.aIndex ?? dominantIndex(segments);
  const atIndex = segments.filter((s) => s.a4 === aIndex);
  const feeds = atIndex.filter((s) => s.type !== 'rapid'); // cutting moves, in order

  // Size the billet to this index's moves only — the other faces are machined
  // in a different orientation and would inflate the grid to no purpose. A
  // billet the operator actually stated overrides that per axis: this is the
  // path the Simulate button drives (store → worker `init` → here), so a stock
  // box ignored at this line is a stock box ignored everywhere it can be seen.
  const bounds = boundsOf(atIndex);
  // Fitted and centred on the CUTTING, never on the rapids: a clearance move
  // out to X200 would otherwise drag the blank off the part it belongs to.
  const fit = cuttingBounds(feeds) ?? bounds;
  const autoTop = top ?? feedTopZ(feeds, bounds.max[2]);
  // A chosen cutter TYPE wins over the bare flat/ball for anything the program
  // never described — see `cam/cutters.js`.
  const fallbackTool = opts.cutter
    ? cutterGeometry({
      cutter: opts.cutter,
      diameter: radius * 2,
      angle: opts.angle,
      thickness: opts.thickness,
    })
    : { radius, type: toolType };
  // How fine to carve. The operator's cell size is a ceiling: a round feature is
  // only as round as the grid under it, so the smallest cutter in the cut pulls
  // it finer — bounded by what the grid costs to scan and the cut costs to
  // stamp. See `cellSizeFor`.
  const grid = cellSizeFor({
    requested: cellSize,
    span: cutterSpan({
      tools: stats.tools, fallbackTool, overrides: opts.toolOverrides,
    }),
    bounds: fit,
    cutLength: stats.feedLength,
  });
  const stock = stockFromBounds(fit, {
    margin, cellSize: grid.size, top: autoTop, base, size: stockSize, origin: stockOrigin,
  });
  return {
    stock,
    feeds,
    // What the grid actually came out at, and whether a budget decided it — a
    // run that quietly simulates coarser than it was asked to owes a sentence.
    cellSize: grid.size,
    cellSizeAsked: cellSize,
    cellSizeLimited: grid.limited,
    // Each feed carves with its own cutter — user tool-table edits win over
    // detection; the fallback above covers tools never described.
    tool: toolResolver(stats.tools, fallbackTool, opts.toolOverrides),
    cursor: 0,   // whole feed moves already carved
    partial: 0,  // how far into the NEXT one — see `advanceCut`
    removed: 0,
    totalFeeds: feeds.length,
    bounds,
    // Where the tool actually cuts, so "why did nothing come off?" can be
    // answered against the blank rather than guessed at — see `removal.js`.
    cutBounds: cuttingBounds(feeds),
    box: {
      xMin: stock.xMin, xMax: stock.xMax,
      yMin: stock.yMin, yMax: stock.yMax,
      base: stock.base, top: stock.top,
    },
    aIndex,
  };
}

/** A point `t` of the way along a move. */
function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Advance a session's cut to `target` feed moves — **fractional**, so the cut
 * can stop part way along the move in progress.
 *
 * Whole moves were the unit before, and that is why the material came off a
 * block at a time: a 50 mm `G1` is one feed move, so the tool crossed the part
 * with nothing happening and then the whole cut appeared at the end of it.
 *
 * Going backwards refills the stock and re-carves — neither model keeps a
 * record of what it removed.
 *
 * @param {object} session  carries `feeds`, `cursor`, `partial`, `removed`
 * @param {number} target   fractional feed count
 * @param {{reset:Function, cut:(seg:object,t0:number,t1:number)=>number}} io
 */
export function advanceCut(session, target, { reset, cut }) {
  const clamped = Math.max(0, Math.min(target, session.totalFeeds));
  const whole = Math.min(Math.floor(clamped), session.totalFeeds);
  const frac = clamped - whole;
  const partial = session.partial || 0;
  if (whole < session.cursor || (whole === session.cursor && frac < partial - 1e-9)) {
    reset();
    session.cursor = 0;
    session.partial = 0;
    session.removed = 0;
  }
  while (session.cursor < whole) {
    const seg = session.feeds[session.cursor];
    session.removed += cut(seg, session.partial || 0, 1);
    session.cursor += 1;
    session.partial = 0;
  }
  if (session.cursor < session.totalFeeds && frac > (session.partial || 0) + 1e-9) {
    const seg = session.feeds[session.cursor];
    session.removed += cut(seg, session.partial || 0, frac);
    session.partial = frac;
  }
  return session;
}

/**
 * Carve until `k` feed moves have executed (0..totalFeeds). `k` may be
 * fractional — see `advanceCut`.
 */
export function carveTo(session, k) {
  advanceCut(session, k, {
    reset: () => resetStock(session.stock),
    cut: (seg, t0, t1) => cutSegment(
      session.stock, lerp(seg.a, seg.b, t0), lerp(seg.a, seg.b, t1), session.tool(seg),
    ),
  });
  const mesh = heightmapToSolidMesh(session.stock);
  return {
    positions: mesh.positions,
    colors: mesh.colors,
    indices: mesh.indices,
    nx: mesh.nx,
    ny: mesh.ny,
    removedVolume: session.removed,
    cursor: session.cursor,
    totalFeeds: session.totalFeeds,
    aIndex: session.aIndex,
  };
}

/**
 * A **voxel** playback session — the same contract as `createSession`, on the
 * model that can hold an undercut.
 *
 * The voxel sim was a one-shot: press Simulate and the finished part appears,
 * with no way to watch it happen. That is a fair trade for a slow model but a
 * poor one to force, and it is exactly what an operator loses the moment a
 * cutter needs this model at all — which, since a slot cutter's groove has a
 * roof on it, is now an ordinary milling job rather than an exotic one.
 *
 * Scrubbing backwards refills the block and re-carves, as the height field
 * does: a voxel that has been cleared carries no record of what was above it.
 *
 * The grid is refined to hold the thinnest cut — see `voxelSizeFor`. Carving a
 * 0.5 mm cutting body on a 1 mm grid rounds the groove out to 1 mm, twice the
 * tool, and reads as a simulator that cannot count.
 */
export function createVoxelSession(text, opts = {}) {
  const {
    voxelSize = 1, margin = 3, radius = 3, toolType = 'flat', stockSize, stockOrigin,
  } = opts;
  // Part frame: every face is assembled onto the workpiece and each segment
  // keeps its A/B index, so the swept tool is oriented correctly.
  const { segments, bounds, stats } = interpret(text, { ...opts, rotaryFrame: 'part' });
  const feeds = segments.filter((s) => s.type !== 'rapid');
  // Where the material's surface actually is. The highest feed move is NOT it:
  // a plunge is a feed move and it begins in the air above the billet, so a
  // block sized to the raw feed bounds grows a slab of phantom material on top
  // — the height field has always inferred the top with `feedTopZ` and this did
  // not, which is why the same job simulated a good few passes deep before
  // anything visibly came off. A cutter with a limited cutting length cannot
  // clear that slab either, so it stands there as a roof over the whole cut.
  //
  // Only for a single rotary index: with the part frame assembling several
  // faces, "the top" is not one direction and the raw feed bounds are the
  // honest answer.
  const indices = new Set(feeds.map((f) => f.a4 || 0));
  const raw = bounds.feedMin && Number.isFinite(bounds.feedMin[0])
    ? { min: bounds.feedMin, max: bounds.feedMax }
    : bounds;
  const oneFace = indices.size <= 1;
  const fit = oneFace ? (cuttingBounds(feeds) ?? raw) : raw;
  const autoTop = oneFace ? feedTopZ(feeds, raw.max[2]) : undefined;
  const box = billetBox(fit, stockSize ?? {}, {
    margin, origin: stockOrigin ?? {}, autoTop,
  });
  const block = {
    min: [box.xMin, box.yMin, box.base],
    max: [box.xMax, box.yMax, box.top],
  };
  const { size, sizeZ, limited } = voxelSizeFor({
    requested: voxelSize,
    // Every tool in play, not just the fallback picker's: a thickness stated on
    // a Tool table row is exactly as thin, and just as unable to be held by a
    // grid coarser than itself.
    thickness: thinnestCut({
      fallbackTool: { thickness: opts.thickness },
      overrides: opts.toolOverrides,
    }),
    bounds: block,
  });
  const vox = createVoxelStock(block, { margin: 0, cellSize: size, cellSizeZ: sizeZ });
  const fallbackTool = opts.cutter
    ? cutterGeometry({
      cutter: opts.cutter,
      diameter: radius * 2,
      angle: opts.angle,
      thickness: opts.thickness,
    })
    : { radius, type: toolType };
  return {
    vox,
    feeds,
    tool: toolResolver(stats.tools, fallbackTool, opts.toolOverrides),
    axes: new Map(),
    cursor: 0,
    partial: 0,
    removed: 0,
    totalFeeds: feeds.length,
    cellSize: size,
    cellSizeZ: sizeZ,
    limited,
    box: {
      xMin: box.xMin, xMax: box.xMax, yMin: box.yMin, yMax: box.yMax,
      base: box.base, top: box.top,
    },
  };
}

/** Carve the voxel session until exactly `k` feed moves have run. */
export function carveVoxelSessionTo(session, k) {
  advanceCut(session, k, {
    reset: () => session.vox.solid.fill(1),
    cut: (seg, t0, t1) => {
      const key = `${seg.a4 || 0}/${seg.b4 || 0}`;
      let axis = session.axes.get(key);
      if (!axis) {
        axis = toolAxisFor(seg.a4 || 0, seg.b4 || 0);
        session.axes.set(key, axis);
      }
      return carveVoxelMove(
        session.vox, lerp(seg.a, seg.b, t0), lerp(seg.a, seg.b, t1), axis, session.tool(seg),
      );
    },
  });
  const mesh = voxelSurfaceMesh(session.vox);
  const { cs, csz } = session.vox;
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    colors: mesh.colors,
    indices: mesh.indices,
    removedVolume: session.removed * cs * cs * csz,
    cells: session.vox.count,
    cellSize: session.cellSize,
    cellSizeZ: session.cellSizeZ,
    limited: session.limited,
    cursor: session.cursor,
    totalFeeds: session.totalFeeds,
  };
}
