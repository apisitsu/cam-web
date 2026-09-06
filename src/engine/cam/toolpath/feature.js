/**
 * Toolpaths for a feature the operator picked, rather than for the whole part.
 *
 * Everything else in `toolpath/` starts from "here is a part, machine it". This
 * starts from "here is the face I want flat" or "here is the edge I want
 * followed", which is how a person actually thinks at the machine and is the
 * only way to program the ninety percent of jobs that are a fixture, a repair,
 * or one feature on an otherwise finished part.
 *
 * Two operations, because two things are worth pointing at:
 *
 * - **A planar face** → clear it. Concentric offsets inward from its outline,
 *   down to its own plane. This is a pocket floor, a boss top, a spot face.
 * - **An edge** → follow it. One pass along the polyline, at a chosen depth and
 *   optionally offset to one side, which covers tracing, engraving, chamfering
 *   and slot-following.
 *
 * The unavoidable limitation, stated here rather than discovered at the
 * machine: this is **3-axis code**, so only a face whose normal points up the
 * tool axis can be cut where it lies. A side face has to be indexed round
 * first, and the planner refuses rather than pretending. `recipe.js` enforces
 * that; the check lives here too so the module cannot be misused directly.
 *
 * Pure functions over plain data. No React, no store, no three.js.
 */

import { millingSpeeds, millingEngagement } from '../feeds.js';
import { clearingRings, areaOf } from '../offset.js';

/** Shared with mill.js in spirit; duplicated rather than exported across. */
function cutLengthOf(moves) {
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

/**
 * Append the moves that cut one closed flat loop, entering from a safe height.
 *
 * The approach rapids down to a millimetre above the cut and only then feeds.
 * Feeding the whole way from safe Z is not wrong, it is just slow — and it
 * quietly inflates the cycle-time estimate with air the machine would have
 * rapided through.
 */
function cutLoop(moves, loop, z, safeZ) {
  const n = loop.length / 2;
  if (n < 3) return;
  moves.push({ t: 'rapid', x: loop[0], y: loop[1], z: safeZ });
  moves.push({ t: 'rapid', x: loop[0], y: loop[1], z: z + 1 });
  moves.push({ t: 'feed', x: loop[0], y: loop[1], z });
  for (let i = 1; i < n; i++) moves.push({ t: 'feed', x: loop[i * 2], y: loop[i * 2 + 1], z });
  moves.push({ t: 'feed', x: loop[0], y: loop[1], z });
  moves.push({ t: 'rapid', x: loop[0], y: loop[1], z: safeZ });
}

/**
 * A face's outline as flat XY loops, with the winding the offsetter expects.
 *
 * Only meaningful for an up-facing face — which is exactly why `faceRegionOp`
 * refuses the others rather than silently projecting a wall onto the table and
 * machining its shadow.
 */
export function faceToLoops(face) {
  const loops = face.loops.map((points) => {
    const flat = [];
    for (const [x, y] of points) flat.push(x, y);
    return flat;
  }).filter((l) => l.length >= 6);
  if (loops.length === 0) return [];

  // The largest loop is the outline; anything else is a hole in it. Windings
  // are normalised the way `sliceLoops` does it, because `offsetLoops` reads
  // inside from outside off the winding alone.
  const withArea = loops.map((points) => ({ points, area: areaOf(points) }));
  withArea.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  return withArea.map((l, i) => {
    const wantCCW = i === 0;                 // outer CCW, holes CW
    const isCCW = l.area > 0;
    return isCCW === wantCCW ? l.points : reverseLoop(l.points);
  });
}

function reverseLoop(flat) {
  const out = [];
  for (let i = flat.length - 2; i >= 0; i -= 2) out.push(flat[i], flat[i + 1]);
  return out;
}

/**
 * Clear a picked planar face, from a start height down to the face's own plane.
 *
 * Concentric rings from the outline inward — the same clearing strategy the
 * Z-level rougher uses, applied to one region instead of a whole slice. Depth
 * comes in `ap` steps, so a deep spot face is stepped down rather than plunged.
 *
 * @param {object} face      from `mesh/features.js`
 * @param {object} opts      { material, tool, machine, from, safeZ, allowance }
 * @returns {object|null}    null when the face cannot be cut this way
 */
export function faceRegionOp(face, opts) {
  const { material, tool, machine, safeZ = 10, allowance = 0 } = opts;
  if (face.facing !== 'up') return null;

  const z = face.centroid[2] + allowance;
  // Where the cut starts. Defaults to the top of the face's own bounding box,
  // which for a flat face is the face itself — so a bare call skims it once
  // rather than guessing at a stock height it was not told about.
  const from = opts.from ?? face.bounds.max[2];
  const loops = faceToLoops(face);
  if (loops.length === 0) return null;

  const speeds = millingSpeeds({
    material, diameter: tool.diameter, flutes: tool.flutes, machine,
  });
  const { ap, ae } = millingEngagement({
    material, diameter: tool.diameter, type: tool.type, machine,
  });
  const rings = clearingRings(loops, tool.diameter / 2, ae);
  if (rings.length === 0) return null;

  const depth = Math.max(0, from - z);
  const passes = Math.max(1, Math.ceil(depth / Math.max(ap, 1e-6)));

  const moves = [];
  for (let p = 1; p <= passes; p++) {
    const levelZ = depth > 0 ? from - (depth * p) / passes : z;
    // Outermost ring first: the cutter meets the wall on a full-width cut once
    // and spirals inward into air it has already made, rather than repeatedly
    // slotting into solid material.
    for (const ring of rings) {
      for (const loop of ring.loops) cutLoop(moves, loop, levelZ, safeZ);
    }
  }
  if (moves.length === 0) return null;

  return makeOp('region', `Clear ${face.facing} face`, tool, speeds, moves, [
    `${rings.length} ring${rings.length === 1 ? '' : 's'} at ${ae.toFixed(2)} mm stepover`,
    passes > 1 ? `${passes} passes of ${(depth / passes).toFixed(2)} mm` : 'single depth pass',
    `face plane Z${z.toFixed(2)}`,
  ]);
}

/**
 * Follow a picked edge.
 *
 * The polyline is cut as it is, at a Z taken from the edge itself plus whatever
 * depth is asked for. No offsetting to a side yet: which side of a line the
 * cutter should walk is a question about the *part*, not the line, and guessing
 * it wrong cuts the feature away instead of beside it. Depth per pass is
 * respected so a deep trace is stepped rather than dragged in one go.
 *
 * @param {object} edge   from `detectSharpEdges`
 * @param {object} opts   { material, tool, machine, depth, passes, safeZ }
 */
export function traceOp(edge, opts) {
  const { material, tool, machine, safeZ = 10, depth = 0 } = opts;
  const points = edge.points;
  if (!points || points.length < 2) return null;

  const speeds = millingSpeeds({
    material, diameter: tool.diameter, flutes: tool.flutes, vcScale: 1.25, machine,
  });
  const { ap } = millingEngagement({
    material, diameter: tool.diameter, type: tool.type, machine,
  });
  const passes = depth > 0 ? Math.max(1, Math.ceil(depth / Math.max(ap, 1e-6))) : 1;

  // A closed chain from `detectSharpEdges` already repeats its first point, so
  // its length includes the closing segment. Adding another one would cut the
  // same millimetre twice and report a cycle time that says so.
  const last = points[points.length - 1];
  const alreadyClosed = edge.closed
    && Math.hypot(last[0] - points[0][0], last[1] - points[0][1], last[2] - points[0][2]) < 1e-6;

  const moves = [];
  for (let p = 1; p <= passes; p++) {
    const drop = (depth * p) / passes;
    const first = points[0];
    const entryZ = first[2] - drop;
    moves.push({ t: 'rapid', x: first[0], y: first[1], z: safeZ });
    moves.push({ t: 'rapid', x: first[0], y: first[1], z: entryZ + 1 });
    moves.push({ t: 'feed', x: first[0], y: first[1], z: entryZ });
    for (const [x, y, zz] of points.slice(1)) {
      moves.push({ t: 'feed', x, y, z: zz - drop });
    }
    if (edge.closed && !alreadyClosed) {
      moves.push({ t: 'feed', x: first[0], y: first[1], z: entryZ });
    }
    const end = edge.closed ? first : last;
    moves.push({ t: 'rapid', x: end[0], y: end[1], z: safeZ });
  }

  return makeOp('trace', `Trace ${edge.closed ? 'closed' : 'open'} edge`, tool, speeds, moves, [
    `${edge.length.toFixed(1)} mm of edge, ${points.length} points`,
    depth > 0 ? `${passes} pass${passes === 1 ? '' : 'es'} to ${depth.toFixed(2)} mm deep` : 'following the edge at its own height',
    'The cutter runs on the line itself — no side offset is applied.',
  ]);
}
