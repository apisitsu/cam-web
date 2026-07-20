/**
 * Milling toolpaths — facing, Z-level roughing, contour finishing, drilling.
 *
 * Moves are `{t, x, y, z}` in part coordinates, with Z0 at the top of the
 * finished part and cuts going negative. That matches how a setter actually
 * touches off, and it means the numbers in the NC file read the way an operator
 * expects without the post having to shift anything.
 *
 * Roughing is **stock minus part**, not "offset the part inward". Those are
 * different shapes the moment the part is not a simple boss, and computing the
 * difference explicitly is what makes an island in the middle of a pocket come
 * out as an island rather than being machined away.
 *
 * Pure functions. No React, no store, no DOM.
 */

import { sliceLoops } from '../../mesh/slice.js';
import { zLevels } from '../../mesh/slice.js';
import {
  offsetLoops, clearingRings, differenceLoops, rectLoop, perimeterOf, areaOf,
} from '../offset.js';
import { millingSpeeds, millingEngagement, drillingSpeeds } from '../feeds.js';

/** Total length of the feed moves in a list. */
export function cutLengthOf(moves) {
  let len = 0;
  for (let i = 1; i < moves.length; i++) {
    if (moves[i].t !== 'feed') continue;
    const a = moves[i - 1], b = moves[i];
    len += Math.hypot(b.x - a.x, b.y - a.y, (b.z ?? 0) - (a.z ?? 0));
  }
  return len;
}

function makeOp(kind, name, tool, speeds, moves, notes = []) {
  const cutLength = cutLengthOf(moves);
  return {
    kind, name, tool, speeds, moves, notes,
    cutLength: Number(cutLength.toFixed(2)),
    estMinutes: speeds.feed > 0 ? Number((cutLength / speeds.feed).toFixed(2)) : 0,
  };
}

/** Append the moves that cut one closed loop, entering from a safe height. */
function cutLoop(moves, loop, z, safeZ, plungeZ) {
  const n = loop.length / 2;
  if (n < 3) return;
  moves.push({ t: 'rapid', x: loop[0], y: loop[1], z: safeZ });
  moves.push({ t: 'rapid', x: loop[0], y: loop[1], z: plungeZ });
  moves.push({ t: 'feed', x: loop[0], y: loop[1], z });
  for (let i = 1; i < n; i++) moves.push({ t: 'feed', x: loop[i * 2], y: loop[i * 2 + 1], z });
  moves.push({ t: 'feed', x: loop[0], y: loop[1], z }); // close it
  moves.push({ t: 'rapid', x: loop[0], y: loop[1], z: safeZ });
}

/**
 * Face the top of the stock down to the top of the part.
 *
 * A back-and-forth raster with the cutter stepping over by 70% of its diameter.
 * The path runs a full tool radius past each end so the cutter exits the
 * material completely — stopping flush leaves a witness mark where the trailing
 * edge is still engaged as the feed direction reverses.
 */
export function facingOp(stock, part, opts) {
  const { material, tool, machine, safeZ = 10 } = opts;
  const depth = stock.top - part.top;
  if (depth <= 1e-6) return null;

  const speeds = millingSpeeds({
    material, diameter: tool.diameter, flutes: tool.flutes, machine,
  });
  const { ap, ae } = millingEngagement({ material, diameter: tool.diameter, type: tool.type, machine });
  const passes = Math.max(1, Math.ceil(depth / ap));
  const r = tool.diameter / 2;

  const moves = [];
  const lanes = Math.max(1, Math.ceil((stock.maxY - stock.minY) / ae));
  for (let p = 1; p <= passes; p++) {
    const z = stock.top - (depth * p) / passes;
    for (let i = 0; i <= lanes; i++) {
      const y = stock.minY + ((stock.maxY - stock.minY) * i) / lanes;
      const [x0, x1] = i % 2 === 0
        ? [stock.minX - r, stock.maxX + r]
        : [stock.maxX + r, stock.minX - r];
      if (i === 0) {
        moves.push({ t: 'rapid', x: x0, y, z: safeZ });
        moves.push({ t: 'feed', x: x0, y, z });
      } else {
        moves.push({ t: 'feed', x: x0, y, z });
      }
      moves.push({ t: 'feed', x: x1, y, z });
    }
    moves.push({ t: 'rapid', x: stock.maxX + r, y: stock.maxY, z: safeZ });
  }

  return makeOp('face', 'Face top', tool, speeds, moves, [
    `${passes} pass(es) removing ${depth.toFixed(2)} mm`,
    `${lanes + 1} lanes at ${ae.toFixed(2)} mm stepover`,
  ]);
}

/**
 * Z-level roughing: clear the stock down to the part, one level at a time.
 *
 * At each level the material still to remove is the stock section minus the
 * part section grown by the finishing allowance, and that region is cleared
 * with concentric offsets. Levels are spaced evenly by `zLevels` so no pass is
 * unexpectedly deeper than the others.
 *
 * Levels that turn out to have nothing left to cut are skipped rather than
 * emitted empty — a program full of no-op tool moves is how an operator loses
 * confidence in a generated file.
 */
export function roughingOp(mesh, stock, part, opts) {
  const { material, tool, machine, allowance = 0.3, safeZ = 10 } = opts;
  const speeds = millingSpeeds({
    material, diameter: tool.diameter, flutes: tool.flutes, machine,
  });
  const { ap, ae } = millingEngagement({ material, diameter: tool.diameter, type: tool.type, machine });
  const r = tool.diameter / 2;

  const levels = zLevels(part.top, part.bottom, ap);
  const stockRect = [rectLoop(stock.minX, stock.minY, stock.maxX, stock.maxY)];
  const moves = [];
  let cleared = 0;

  for (const z of levels) {
    const { loops } = sliceLoops(mesh, 2, z);
    // Grow the part by the allowance so the finisher has stock to cut.
    const keepOut = loops.length ? offsetLoops(loops, allowance) : [];
    const toRemove = keepOut.length ? differenceLoops(stockRect, keepOut) : stockRect;
    if (toRemove.length === 0) continue;

    const rings = clearingRings(toRemove, r, ae);
    if (rings.length === 0) continue;
    cleared++;
    for (const ring of rings) {
      for (const loop of ring.loops) cutLoop(moves, loop, z, safeZ, z + 1);
    }
  }

  if (moves.length === 0) return null;
  return makeOp('rough', 'Z-level roughing', tool, speeds, moves, [
    `${cleared} level(s) at ${ap.toFixed(2)} mm depth of cut`,
    `${ae.toFixed(2)} mm stepover, ${allowance} mm left on for finishing`,
  ]);
}

/**
 * Contour finishing: follow the part boundary at each Z level.
 *
 * The path is the part outline offset outward by exactly the tool radius, so
 * the cutter's flank lands on the finished wall. Feeds and speeds run lighter
 * and faster than roughing, which is what a finish pass is for.
 */
export function contourOp(mesh, part, opts) {
  const { material, tool, machine, safeZ = 10, stepdown } = opts;
  const speeds = millingSpeeds({
    material, diameter: tool.diameter, flutes: tool.flutes, vcScale: 1.25, machine,
  });
  const r = tool.diameter / 2;
  const step = stepdown ?? tool.diameter * 0.5;

  const moves = [];
  for (const z of zLevels(part.top, part.bottom, step)) {
    const { loops } = sliceLoops(mesh, 2, z);
    if (loops.length === 0) continue;
    // Outers grow by the radius; holes shrink by it. offsetLoops does both from
    // the winding, which is why sliceLoops normalises it.
    for (const loop of offsetLoops(loops, r)) cutLoop(moves, loop, z, safeZ, z + 1);
  }

  if (moves.length === 0) return null;
  return makeOp('finish', 'Contour finishing', tool, speeds, moves, [
    `${step.toFixed(2)} mm stepdown following the part wall`,
  ]);
}

/**
 * Circular holes found by sectioning just under the top face.
 *
 * A loop is called a hole when it is an inner loop *and* nearly circular:
 * every vertex the same distance from its centroid, within 2%. That is a
 * deliberately strict test — a rounded-corner pocket would otherwise be drilled
 * — and it is checked against the vertex spread rather than a fitted radius so
 * a faceted export cannot sneak through as an ellipse.
 *
 * The diameter is reported as the **circumscribed** value, since STL inscribes
 * its polygon inside the true circle and so always reads small.
 */
export function detectHoles(mesh, part, opts = {}) {
  const { roundness = 0.02, probeDepth = 0.5 } = opts;
  const z = part.top - probeDepth;
  const { loops } = sliceLoops(mesh, 2, z);
  const holes = [];

  for (const l of loops) {
    if (!l.isHole) continue;
    const pts = l.points;
    const n = pts.length / 2;
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += pts[i * 2]; cy += pts[i * 2 + 1]; }
    cx /= n; cy /= n;

    let sum = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(pts[i * 2] - cx, pts[i * 2 + 1] - cy);
      sum += d; min = Math.min(min, d); max = Math.max(max, d);
    }
    const mean = sum / n;
    if (mean <= 0 || (max - min) / mean > roundness) continue;

    // Find how deep it goes by probing down until the loop disappears.
    let depth = probeDepth;
    const stepZ = Math.max((part.top - part.bottom) / 40, 0.2);
    for (let probe = z; probe >= part.bottom; probe -= stepZ) {
      const here = sliceLoops(mesh, 2, probe).loops;
      const still = here.some((h) => h.isHole
        && Math.abs(centroidDist(h.points, cx, cy)) < mean * 0.5);
      if (!still) break;
      depth = part.top - probe;
    }

    holes.push({
      x: Number(cx.toFixed(4)),
      y: Number(cy.toFixed(4)),
      diameter: Number((max * 2).toFixed(3)), // circumscribed, not inscribed
      depth: Number(depth.toFixed(3)),
      throughHole: depth >= (part.top - part.bottom) - stepZ,
    });
  }
  return holes;
}

function centroidDist(pts, cx, cy) {
  const n = pts.length / 2;
  let ax = 0, ay = 0;
  for (let i = 0; i < n; i++) { ax += pts[i * 2]; ay += pts[i * 2 + 1]; }
  return Math.hypot(ax / n - cx, ay / n - cy);
}

/**
 * Drill a set of holes with one tool, as canned cycles.
 *
 * Emitting `G81`/`G83` rather than explicit peck moves keeps the program short
 * and lets the control handle the retracts, which is both what an operator
 * expects to read and what they can edit at the machine.
 */
export function drillingOp(holes, opts) {
  const { material, tool, machine, part, safeZ = 10, retract = 2 } = opts;
  if (holes.length === 0) return null;
  const depth = Math.max(...holes.map((h) => h.depth));
  const data = drillingSpeeds({ material, diameter: tool.diameter, depth, machine });

  const moves = holes.map((h) => ({
    cycle: data.cycle,
    x: h.x, y: h.y,
    // Drill a little past a through hole so the point breaks clean out.
    z: part.top - (h.throughHole ? h.depth + tool.diameter * 0.3 : h.depth),
    r: part.top + retract,
    peck: data.peck,
  }));

  return makeOp('drill', `Drill ${holes.length} × Ø${tool.diameter}`, tool, data, moves, [
    `${data.cycle} at depth ratio ${data.depthRatio}×D`,
    ...(data.peck ? [`Pecking ${data.peck} mm — deeper than 3×D`] : []),
    ...(holes.some((h) => h.throughHole) ? ['Through holes are drilled past the far face'] : []),
  ]);
}

/**
 * The narrowest place a cutter has to fit through, at one Z level.
 *
 * Measured as the shortest line between two points on the boundary that are far
 * apart *along* the boundary. Nearby vertices are always close together — that
 * is just faceting — so only pairs separated by more than `minArc` of perimeter
 * are considered, and what survives is a genuine neck: the gap between two
 * walls of a slot, or between an island and the pocket around it.
 *
 * This is what actually bounds tool size, and it is honest in a way a corner
 * radius is not: a sharp internal corner cannot be machined by any round tool,
 * so sizing off corners would drive the choice to zero on every prismatic part.
 * A neck, by contrast, is a real constraint the cutter has to pass.
 *
 * Returns Infinity when nothing constrains the tool.
 */
export function narrowestPassage(loops, opts = {}) {
  const { minArc = 3 } = opts;
  let best = Infinity;
  for (const l of loops) {
    const pts = l.points ?? l;
    const n = pts.length / 2;
    if (n < 6) continue;
    // Arc length along the loop, so "far apart along the boundary" is measurable.
    const arc = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      arc[i] = arc[i - 1] + Math.hypot(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]);
    }
    const total = arc[n - 1];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const along = Math.min(arc[j] - arc[i], total - (arc[j] - arc[i]));
        if (along < minArc) continue;
        const d = Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** Stock box around a part's bounds, with margin on the sides and top. */
export function stockFor(bounds, opts = {}) {
  const { side = 2, top = 1 } = opts;
  return {
    minX: bounds.min[0] - side, maxX: bounds.max[0] + side,
    minY: bounds.min[1] - side, maxY: bounds.max[1] + side,
    bottom: bounds.min[2], top: bounds.max[2] + top,
    sizeX: bounds.size[0] + side * 2,
    sizeY: bounds.size[1] + side * 2,
    sizeZ: bounds.size[2] + top,
  };
}

export { perimeterOf, areaOf };
