/**
 * Pocket and profile from a sketch.
 *
 * A sketch is what the part was drawn from, so its loops are exact where a slice
 * of the mesh is only faceted: a circle comes out as a fine polyline that the post
 * writes back as G02/G03.
 *
 * The sketch has to lie flat in the setup (its plane facing up the tool axis). It
 * is cut from the sketch's own height down by `depth`.
 *
 * Pure functions. No React, no store, no DOM.
 */
import { planeToWorld } from '../../sketch/plane.js';
import { normalizeLoops, zLevels } from '../../mesh/slice.js';
import { offsetLoops, clearingRings } from '../offset.js';
import { millingSpeeds, engagementWith } from '../feeds.js';
import { cutLengthOf } from './mill.js';

const FLAT = 0.999;

/**
 * A sketch's regions in the setup frame.
 *
 * @param {{plane:object, regions:{outer:number[], holes?:number[][]}[]}} sketch
 * @param {(p:number[]) => number[]} toFrame  world point to setup point
 * @returns {{z:number, loops:object[]}|{error:string}}
 */
export function sketchInFrame(sketch, toFrame) {
  const at = (x, y) => toFrame(planeToWorld(sketch.plane, x, y));
  const o = at(0, 0);
  const u = at(1, 0).map((v, i) => v - o[i]);
  const v = at(0, 1).map((w, i) => w - o[i]);
  const nz = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(nz) < FLAT) return { error: 'The sketch is not flat in this setup: its plane must face the spindle.' };
  const raw = [];
  for (const region of sketch.regions || []) {
    for (const loop of [region.outer, ...(region.holes || [])]) {
      const pts = [];
      for (let i = 0; i < loop.length; i += 2) {
        const p = at(loop[i], loop[i + 1]);
        pts.push(p[0], p[1]);
      }
      raw.push(pts);
    }
  }
  if (raw.length === 0) return { error: 'The sketch has no closed profile.' };
  return { z: o[2], loops: normalizeLoops(raw) };
}

/**
 * The Z levels of a pocket or profile, and the stock it leaves.
 *
 * Rough: steps of `ap` down to the floor, `leave` mm left on the walls and the
 * floor for a finishing pass. Finish: one pass at the full depth, nothing left.
 * No `pass` (a recipe saved before Rough/Finish existed) cuts as it always did:
 * stepped, nothing left.
 */
function passLevels(top, depth, ap, { pass, leave }) {
  const left = pass === 'rough' && leave > 0 ? Math.min(leave, depth) : 0;
  const bottom = top - depth + left;
  const levels = pass === 'finish' ? [bottom] : zLevels(top, bottom, ap);
  return { levels, left };
}

function passNote(pass, levels, ap, depth) {
  return pass === 'finish'
    ? `Finish: ${depth} mm deep in one pass`
    : `${depth} mm deep in ${levels.length} level(s) at ${ap.toFixed(2)} mm`;
}

function sketchOp(kind, name, tool, speeds, moves, notes, engagement) {
  const cutLength = cutLengthOf(moves);
  return {
    kind,
    name,
    tool,
    speeds,
    moves,
    notes,
    engagement,
    cutLength: Number(cutLength.toFixed(2)),
    estMinutes: speeds.feed > 0 ? Number((cutLength / speeds.feed).toFixed(2)) : 0,
  };
}

function cutLoopAt(moves, loop, z, safeZ) {
  const pts = Array.isArray(loop) ? loop : loop.points;
  const n = pts.length / 2;
  if (n < 3) return;
  moves.push({ t: 'rapid', x: pts[0], y: pts[1], z: safeZ });
  moves.push({ t: 'rapid', x: pts[0], y: pts[1], z: z + 1 });
  moves.push({ t: 'feed', x: pts[0], y: pts[1], z });
  for (let i = 1; i < n; i++) moves.push({ t: 'feed', x: pts[i * 2], y: pts[i * 2 + 1], z });
  moves.push({ t: 'feed', x: pts[0], y: pts[1], z });
  moves.push({ t: 'rapid', x: pts[0], y: pts[1], z: safeZ });
}

/**
 * Clear the inside of the sketch's profiles, islands kept, level by level.
 *
 * @param {{z:number, loops:object[]}} shape  from `sketchInFrame`
 */
export function pocketOp(shape, opts) {
  const {
    material, tool, machine, depth, safeZ = 10, pass, leave = 0,
  } = opts;
  if (!(depth > 0)) return null;
  const speeds = millingSpeeds({
    material, diameter: tool.diameter, flutes: tool.flutes, machine,
  });
  const { ap, ae } = engagementWith({
    material, diameter: tool.diameter, type: tool.type, machine,
  }, opts);
  const { levels, left } = passLevels(shape.z, depth, ap, { pass, leave });
  const rings = clearingRings(shape.loops, tool.diameter / 2 + left, ae);
  if (rings.length === 0) return null;
  const moves = [];
  for (const z of levels) {
    // Innermost first: start in the middle, finish on the wall.
    for (const ring of [...rings].reverse()) {
      for (const loop of ring.loops) cutLoopAt(moves, loop, z, safeZ);
    }
  }
  return sketchOp('pocket', 'Pocket', tool, speeds, moves, [
    passNote(pass, levels, ap, depth),
    `${ae.toFixed(2)} mm stepover`,
    ...(left > 0 ? [`${left} mm left on the walls and floor for finishing`] : []),
    'Plunges straight in at the middle of each level; no ramp entry yet',
  ], { pass: pass ?? 'rough', stepdown: ap, stepover: ae, leave: left });
}

/**
 * Follow the sketch's outer profiles, the cutter outside them or inside them.
 *
 * @param {{z:number, loops:object[]}} shape  from `sketchInFrame`
 * @param {{side:'outside'|'inside'}} opts
 */
export function profileOp(shape, opts) {
  const {
    material, tool, machine, depth, side = 'outside', safeZ = 10, pass, leave = 0,
  } = opts;
  if (!(depth > 0)) return null;
  const speeds = millingSpeeds({
    material, diameter: tool.diameter, flutes: tool.flutes, machine,
  });
  const { ap } = engagementWith({
    material, diameter: tool.diameter, type: tool.type, machine,
  }, opts);
  const { levels, left } = passLevels(shape.z, depth, ap, { pass, leave });
  const outers = shape.loops.filter((l) => !l.isHole);
  const r = tool.diameter / 2 + left;
  const paths = offsetLoops(outers, side === 'inside' ? -r : r);
  if (paths.length === 0) return null;
  const moves = [];
  for (const z of levels) {
    for (const loop of paths) cutLoopAt(moves, loop, z, safeZ);
  }
  return sketchOp('profile', `Profile ${side}`, tool, speeds, moves, [
    passNote(pass, levels, ap, depth),
    left > 0
      ? `Cutter ${side} the profile, ${left} mm left on for finishing`
      : `Cutter ${side} the profile, no finishing allowance`,
  ], { pass: pass ?? 'rough', stepdown: ap, leave: left });
}
