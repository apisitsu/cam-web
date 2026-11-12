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

import {
  sliceLoops, zLevels, normalizeLoops, eachTriangle,
} from '../../mesh/slice.js';
import {
  offsetLoops, clearingRings, differenceLoops, booleanLoops, rectLoop, perimeterOf, areaOf,
} from '../offset.js';
import {
  millingSpeeds, millingEngagement, engagementWith, drillingSpeeds, tappingSpeeds,
} from '../feeds.js';

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

/** Coarsest spacing (mm) the part is sampled at for what hangs over a cutting level. */
const SHADOW_STEP = 0.5;
/** Most samples the shadow takes over the whole part, so a tall one stays quick. */
const SHADOW_SAMPLES = 200;
/** How far either side of a flat face it is sectioned, to catch thin flanges. */
const FLAT_OFFSET = 1e-3;

/** The heights of the part's flat faces, highest first. */
function flatHeights(mesh, part) {
  const seen = new Set();
  eachTriangle(mesh, (a, b, c, p) => {
    if (Math.abs(p[a + 2] - p[b + 2]) < 1e-5 && Math.abs(p[a + 2] - p[c + 2]) < 1e-5) {
      seen.add(Number(p[a + 2].toFixed(3)));
    }
  });
  return [...seen].filter((z) => z <= part.top && z >= part.bottom).sort((x, y) => y - x);
}

const netArea = (loops) => loops.reduce((sum, l) => sum + areaOf(l.points), 0);

/**
 * What a cutter coming down from above has to stay clear of at each level.
 *
 * A 3-axis tool's body occupies everything above its tip, so at height z it must
 * avoid the part at z **and at every height above z**. Using only the section at z
 * sends the cutter straight through whatever overhangs that level.
 *
 * Returns a function to call with descending heights. It gives the section at z,
 * the accumulated `outline` and whether anything overhangs z.
 */
function partShadow(mesh, part) {
  const step = Math.max(SHADOW_STEP, (part.top - part.bottom) / SHADOW_SAMPLES);
  const flats = flatHeights(mesh, part);
  let shadow = [];
  let previous = part.top;

  const add = (loops) => {
    if (loops.length) shadow = normalizeLoops(booleanLoops(shadow, loops, 'union'));
  };

  return (z) => {
    const samples = new Set();
    for (let s = previous - step; s > z; s -= step) samples.add(s);
    for (const f of flats) {
      for (const s of [f + FLAT_OFFSET, f - FLAT_OFFSET]) {
        if (s < previous && s > z) samples.add(s);
      }
    }
    for (const s of [...samples].sort((a, b) => b - a)) add(sliceLoops(mesh, 2, s).loops);

    // Exactly at the bottom face a section comes back empty, which would read as
    // "no part here" and send the cutter straight through it.
    const section = sliceLoops(mesh, 2, Math.max(z, part.bottom + FLAT_OFFSET)).loops;
    add(section);
    previous = z;
    const sectionArea = netArea(section);
    return {
      section,
      outline: shadow,
      overhang: netArea(shadow) - sectionArea > Math.max(0.05, sectionArea * 0.002),
    };
  };
}

/** The loops of an outline that are real walls at this level, not overhang edges. */
function wallsAtLevel(outline, section) {
  const key = (x, y) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const onSection = new Set();
  for (const l of section) {
    for (let i = 0; i < l.points.length; i += 2) onSection.add(key(l.points[i], l.points[i + 1]));
  }
  return outline.filter((l) => {
    for (let i = 0; i < l.points.length; i += 2) {
      if (onSection.has(key(l.points[i], l.points[i + 1]))) return true;
    }
    return false;
  });
}

const OVERHANG_NOTE = 'Material under an overhang cannot be reached from above and is left on';

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
  const { ap, ae } = engagementWith({ material, diameter: tool.diameter, type: tool.type, machine }, opts);
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

  const op = makeOp('face', 'Face top', tool, speeds, moves, [
    `${passes} pass(es) removing ${depth.toFixed(2)} mm`,
    `${lanes + 1} lanes at ${ae.toFixed(2)} mm stepover`,
  ]);
  op.engagement = { pass: 'rough', stepdown: ap, stepover: ae };
  return op;
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
  const { material, tool, machine, safeZ = 10 } = opts;
  const allowance = Number.isFinite(opts.leave) && opts.leave >= 0 ? opts.leave : (opts.allowance ?? 0.3);
  const speeds = millingSpeeds({
    material, diameter: tool.diameter, flutes: tool.flutes, machine,
  });
  const { ap, ae } = engagementWith({ material, diameter: tool.diameter, type: tool.type, machine }, opts);
  const r = tool.diameter / 2;

  const levels = zLevels(part.top, part.bottom, ap);
  // The sides of a block are open: the cutter may run past them. Without this a
  // margin narrower than the cutter leaves nowhere for its centre to go.
  const open = r * 2;
  const stockRect = [rectLoop(stock.minX - open, stock.minY - open, stock.maxX + open, stock.maxY + open)];
  const moves = [];
  let cleared = 0;
  let overhung = false;
  const shadowAt = partShadow(mesh, part);

  for (const z of levels) {
    const { section, outline, overhang } = shadowAt(z);
    overhung = overhung || overhang;
    const loops = overhang ? outline : section;
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
  const op = makeOp('rough', 'Z-level roughing', tool, speeds, moves, [
    `${cleared} level(s) at ${ap.toFixed(2)} mm depth of cut`,
    `${ae.toFixed(2)} mm stepover, ${allowance} mm left on for finishing`,
    ...(overhung ? [OVERHANG_NOTE] : []),
  ]);
  op.engagement = { pass: 'rough', stepdown: ap, stepover: ae, leave: allowance };
  return op;
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
  let overhung = false;
  const shadowAt = partShadow(mesh, part);
  for (const z of zLevels(part.top, part.bottom, step)) {
    const { section, outline, overhang } = shadowAt(z);
    if (section.length === 0) continue;
    overhung = overhung || overhang;
    const loops = overhang ? wallsAtLevel(outline, section) : section;
    // Outers grow by the radius; holes shrink by it. offsetLoops does both from
    // the winding, which is why sliceLoops normalises it.
    for (const loop of offsetLoops(loops, r)) cutLoop(moves, loop, z, safeZ, z + 1);
  }

  if (moves.length === 0) return null;
  const op = makeOp('finish', 'Contour', tool, speeds, moves, [
    `${step.toFixed(2)} mm stepdown following the part wall`,
    ...(overhung ? [OVERHANG_NOTE] : []),
  ]);
  op.engagement = { pass: 'finish', stepdown: step };
  return op;
}

/** Empty probes in a row that end a hole (see `detectHoles`). */
const MISSES = 3;

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
 *
 * The section is taken at a few depths just under the top, not one: where a
 * boolean left a hole's mouth imperfect the loop at one depth can come back
 * broken, and a hole found at any of them is the hole.
 */
export function detectHoles(mesh, part, opts = {}) {
  const { roundness = 0.02, probeDepth = 0.5 } = opts;
  const height = part.top - part.bottom;
  const holes = [];
  for (const entry of [probeDepth, probeDepth * 2, probeDepth * 4].filter((d) => d < height)) {
    for (const l of sliceLoops(mesh, 2, part.top - entry).loops) {
      if (!l.isHole) continue;
      const [cx, cy] = areaCentroid(l.points);
      if (holes.some((h) => Math.hypot(h.x - cx, h.y - cy) < h.diameter / 4)) continue;
      const hole = holeFrom(mesh, part, l.points, cx, cy, entry, { roundness, probeDepth });
      if (hole) holes.push(hole);
    }
  }
  return holes;
}

/** The hole a round loop found `entry` under the top is, or null if it is not round. */
function holeFrom(mesh, part, pts, cx, cy, entry, { roundness, probeDepth }) {
  const n = pts.length / 2;
  const height = part.top - part.bottom;
  let sum = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(pts[i * 2] - cx, pts[i * 2 + 1] - cy);
    sum += d; min = Math.min(min, d); max = Math.max(max, d);
  }
  const mean = sum / n;
  if (mean <= 0 || (max - min) / mean > roundness) return null;
  const sameHole = (h) => h.isHole && centroidDist(h.points, cx, cy) < mean * 0.5;

  // Find how deep it goes by probing down until the loop disappears. One level
  // or two can come back empty where a boolean left the wall imperfect — a hole
  // that reappears below them is the same hole, not a new one — so it is only
  // over when it has been gone for MISSES levels running.
  let depth = entry;
  const stepZ = Math.max(height / 40, 0.2);
  let missed = 0;
  for (let probe = part.top - entry; probe >= part.bottom; probe -= stepZ) {
    if (!sliceLoops(mesh, 2, probe).loops.some(sameHole)) {
      missed += 1;
      if (missed >= MISSES) break;
      continue;
    }
    missed = 0;
    depth = part.top - probe;
  }
  // The same hole just above the bottom face means it goes through, whatever
  // the probes between made of a wall a boolean left uneven.
  if (sliceLoops(mesh, 2, part.bottom + probeDepth).loops.some(sameHole)) {
    depth = height - probeDepth;
  }

  return {
    x: Number(cx.toFixed(4)),
    y: Number(cy.toFixed(4)),
    diameter: Number((max * 2).toFixed(3)), // circumscribed, not inscribed
    depth: Number(depth.toFixed(3)),
    throughHole: depth >= height - stepZ,
  };
}

/**
 * Give holes found in the mesh the exact data of the CAD hole at the same place.
 *
 * Only a hole drilled along the tool axis qualifies. A hole with no CAD record, such
 * as any hole in an imported STL, is left exactly as the mesh measured it.
 *
 * @param {object[]} holes  from `detectHoles`
 * @param {object[]} cadHoles  from `holeRecords`, in the frame the mesh is in
 */
export function attachCadHoles(holes, cadHoles, part) {
  if (!cadHoles?.length) return holes;
  return holes.map((h) => {
    const cad = cadHoles.find((c) => c.axis[2] < -0.99
      && Math.hypot(c.at[0] - h.x, c.at[1] - h.y) < Math.max(h.diameter / 4, 0.2));
    if (!cad) return h;
    return {
      ...h,
      x: cad.at[0],
      y: cad.at[1],
      diameter: cad.drill,
      depth: cad.through ? part.top - part.bottom : part.top - cad.at[2] + cad.depth + cad.tip,
      throughHole: cad.through,
      cad,
    };
  });
}

function centroidDist(pts, cx, cy) {
  const [ax, ay] = areaCentroid(pts);
  return Math.hypot(ax - cx, ay - cy);
}

/**
 * The centre of the area a loop encloses — not the average of its corners.
 *
 * A loop cut from a mesh a boolean has been through has its corners bunched
 * where the evaluator split the wall and sparse elsewhere; averaging them pulled
 * the "centre" of a Ø6 hole far enough off to fail the roundness test, and the
 * hole went undrilled. The area centroid depends only on the shape.
 */
function areaCentroid(pts) {
  const n = pts.length / 2;
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
    a += cross;
    x += (pts[i * 2] + pts[j * 2]) * cross;
    y += (pts[i * 2 + 1] + pts[j * 2 + 1]) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += pts[i * 2]; sy += pts[i * 2 + 1]; }
    return [sx / n, sy / n];
  }
  return [x / (3 * a), y / (3 * a)];
}

/**
 * Drill a set of holes with one tool, as canned cycles.
 *
 * Emitting `G81`/`G83` rather than explicit peck moves keeps the program short
 * and lets the control handle the retracts, which is both what an operator
 * expects to read and what they can edit at the machine.
 */
export function drillingOp(holes, opts) {
  const { material, tool, machine, part, retract = 2 } = opts;
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

/** Where a hole opens: its CAD mouth, or the top of the part for one found in the mesh. */
const mouthOf = (h, part) => h.cad?.at[2] ?? part.top;

/** A canned cycle at every hole, each to its own depth. */
function cycleOp(kind, name, tool, speeds, holes, zOf, part, notes, retract = 2) {
  if (holes.length === 0) return null;
  const moves = holes.map((h) => ({
    cycle: speeds.cycle,
    x: h.x,
    y: h.y,
    z: zOf(h),
    r: part.top + retract,
    peck: speeds.peck,
  }));
  return makeOp(kind, name, tool, speeds, moves, notes);
}

const halfAngle = (tool) => ((tool.angle ?? 90) * Math.PI) / 360;

/**
 * The diameter a spot drill leaves at a hole's mouth: the drawn chamfer when the
 * hole has one, otherwise a centre a little under the drill.
 */
export function spotDiameter(hole, toolDiameter) {
  // A counterbore's chamfer is on its own mouth, not the hole's.
  if (hole.cad?.counterbore && hole.cad.chamfer > 0) return hole.cad.counterbore.diameter + hole.cad.chamfer * 2;
  if (hole.cad?.chamfer > 0) return hole.diameter + hole.cad.chamfer * 2;
  return Math.min(hole.diameter * 0.6, toolDiameter);
}

/** Spot every hole: a centre so the drill cannot wander, and any mouth chamfer. */
export function spotOp(holes, opts) {
  const {
    material, tool, machine, part,
  } = opts;
  const speeds = {
    ...drillingSpeeds({
      material, diameter: tool.diameter, depth: 0, machine,
    }),
    cycle: 'G81',
    peck: null,
  };
  const chamfered = holes.filter((h) => h.cad?.chamfer > 0).length;
  return cycleOp(
    'spot',
    `Spot ${holes.length} hole${holes.length > 1 ? 's' : ''}`,
    tool,
    speeds,
    holes,
    (h) => mouthOf(h, part) - spotDiameter(h, tool.diameter) / 2 / Math.tan(halfAngle(tool)),
    part,
    [
      'G81 to the depth that leaves the spot or chamfer diameter',
      ...(chamfered ? [`${chamfered} hole${chamfered > 1 ? 's' : ''} chamfered to the size drawn`] : []),
    ],
  );
}

/** The diameter of a counterbored hole's chamfer, where it meets the counterbore floor. */
export const holeChamferDiameter = (hole) => hole.diameter + hole.cad.holeChamfer * 2;

/**
 * Chamfer the hole's edge on the counterbore floor. After the counterbore, so the
 * spot drill reaches the floor through air; its body has to fit the counterbore.
 */
export function counterboreChamferOp(holes, opts) {
  const {
    material, tool, machine, part,
  } = opts;
  const speeds = {
    ...drillingSpeeds({
      material, diameter: tool.diameter, depth: 0, machine,
    }),
    cycle: 'G81',
    peck: null,
  };
  return cycleOp(
    'cboreChamfer',
    `Chamfer ${holes.length} hole${holes.length > 1 ? 's' : ''} in the counterbore`,
    tool,
    speeds,
    holes,
    (h) => mouthOf(h, part) - h.cad.counterbore.depth - holeChamferDiameter(h) / 2 / Math.tan(halfAngle(tool)),
    part,
    ['G81 from the counterbore floor, to the chamfer diameter drawn'],
  );
}

/** Countersink holes to the diameter the Hole Wizard was given. */
export function countersinkOp(holes, opts) {
  const {
    material, tool, machine, part,
  } = opts;
  const speeds = {
    ...drillingSpeeds({
      material, diameter: tool.diameter, depth: 0, machine,
    }),
    cycle: 'G81',
    peck: null,
  };
  return cycleOp(
    'csink',
    `Countersink ${holes.length} × Ø${holes[0]?.cad.countersink.diameter}`,
    tool,
    speeds,
    holes,
    (h) => mouthOf(h, part) - h.cad.countersink.diameter / 2 / Math.tan(halfAngle(tool)),
    part,
    ['G81 to the depth that leaves the countersink diameter at the face'],
  );
}

/** Tap holes with a canned G84: the feed is the pitch on every turn. */
export function tapOp(holes, opts) {
  const {
    material, tool, machine, part,
  } = opts;
  const speeds = tappingSpeeds({
    material, diameter: tool.diameter, pitch: tool.pitch, machine,
  });
  return cycleOp(
    'tap',
    `Tap ${holes.length} × ${tool.thread}`,
    tool,
    speeds,
    holes,
    (h) => mouthOf(h, part) - h.cad.thread.depth,
    part,
    [
      `G84 at F = S × ${tool.pitch} pitch`,
      'Rigid tapping on many Fanuc controls needs M29 S before G84; add it if this machine asks',
    ],
  );
}

/** How many points a full circle of radius `r` is drawn with. */
const circlePoints = (r) => Math.max(24, Math.min(144, Math.ceil((2 * Math.PI * r) / 0.5)));

/**
 * Counterbore: circular passes round each hole, level by level, out to the
 * counterbore's wall. The drilled hole is already there, so the passes start
 * at the smallest circle that still clears everything between it and the wall.
 */
export function counterboreOp(holes, opts) {
  const {
    material, tool, machine, part, safeZ = 10,
  } = opts;
  if (holes.length === 0) return null;
  const { diameter, depth } = holes[0].cad.counterbore;
  const rt = tool.diameter / 2;
  const R = diameter / 2;
  if (rt >= R) return null;
  const speeds = millingSpeeds({
    material, diameter: tool.diameter, flutes: tool.flutes, machine,
  });
  const { ap, ae } = millingEngagement({
    material, diameter: tool.diameter, type: tool.type, machine,
  });

  const radii = [];
  for (let rho = R - rt; rho > 0; rho -= ae) radii.push(rho);
  const moves = [];
  for (const h of holes) {
    const top = mouthOf(h, part);
    const inner = h.diameter / 2;
    // Smallest first; stop once the cutter reaches the drilled hole.
    const passes = radii.filter((rho, i) => i === 0 || radii[i - 1] - rt > inner).reverse();
    for (const z of zLevels(top, top - depth, ap)) {
      moves.push({ t: 'rapid', x: h.x, y: h.y, z: safeZ });
      moves.push({ t: 'rapid', x: h.x, y: h.y, z: z + 1 });
      moves.push({ t: 'feed', x: h.x, y: h.y, z });
      for (const rho of passes) {
        const n = circlePoints(rho);
        for (let k = 0; k <= n; k++) {
          const a = (2 * Math.PI * k) / n;
          moves.push({
            t: 'feed', x: h.x + rho * Math.cos(a), y: h.y + rho * Math.sin(a), z,
          });
        }
      }
      moves.push({ t: 'feed', x: h.x, y: h.y, z });
      moves.push({ t: 'rapid', x: h.x, y: h.y, z: safeZ });
    }
  }
  return makeOp('cbore', `Counterbore ${holes.length} × Ø${diameter}`, tool, speeds, moves, [
    `${depth} mm deep in ${zLevels(0, -depth, ap).length} level(s)`,
    'Plunges into the drilled hole; drill before counterboring',
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
    const tangent = tangents(pts, arc, minArc / 2);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const along = Math.min(arc[j] - arc[i], total - (arc[j] - arc[i]));
        if (along < minArc) continue;
        const dx = pts[j * 2] - pts[i * 2];
        const dy = pts[j * 2 + 1] - pts[i * 2 + 1];
        const d = Math.hypot(dx, dy);
        if (d >= best || d === 0) continue;
        // A neck is across the gap: square to the wall at both ends. A line that
        // runs along the wall instead is only a chord of a curve — on a hole, a
        // chord `minArc` long, which made every hole a ~3 mm "neck".
        if (Math.abs(dx * tangent[i * 2] + dy * tangent[i * 2 + 1]) / d > ACROSS) continue;
        if (Math.abs(dx * tangent[j * 2] + dy * tangent[j * 2 + 1]) / d > ACROSS) continue;
        best = d;
      }
    }
  }
  return best;
}

/** cos of the angle to the wall above which a line is along it rather than across (~78°). A round hole then reads within 2% of its diameter. */
const ACROSS = 0.2;

/**
 * The wall's direction at each corner of a closed loop, as a unit vector, from the
 * corners `reach` either side along it — so a corner where a boolean left many
 * points close together still reads the wall's direction, not its noise.
 */
function tangents(pts, arc, reach) {
  const n = pts.length / 2;
  const total = arc[n - 1] + Math.hypot(pts[0] - pts[(n - 1) * 2], pts[1] - pts[(n - 1) * 2 + 1]);
  const out = new Float64Array(n * 2);
  const ahead = (i, sign) => {
    let k = i;
    for (let step = 0; step < n; step++) {
      k = (k + sign + n) % n;
      const gap = sign > 0 ? (arc[k] - arc[i] + total) % total : (arc[i] - arc[k] + total) % total;
      if (gap >= reach) return k;
    }
    return (i + sign + n) % n;
  };
  for (let i = 0; i < n; i++) {
    const a = ahead(i, -1);
    const b = ahead(i, 1);
    const tx = pts[b * 2] - pts[a * 2];
    const ty = pts[b * 2 + 1] - pts[a * 2 + 1];
    const len = Math.hypot(tx, ty) || 1;
    out[i * 2] = tx / len;
    out[i * 2 + 1] = ty / len;
  }
  return out;
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
