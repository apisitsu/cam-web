/**
 * Turning toolpaths — facing, roughing, finishing, grooving, boring, parting.
 *
 * Every move here is `{t, x, z}` with **x as a radius**, never a diameter. The
 * post-processor doubles it when the control is in diameter mode, which is
 * where that decision belongs: the geometry has no opinion about how a
 * particular Fanuc is configured, and keeping radii throughout means the
 * arithmetic in this file matches the profile it came from.
 *
 * Roughing and finishing work from the **filled** profile (see
 * `fillRecesses`) so a profiling insert is never fed into a groove. Grooves are
 * cut afterwards by a blade narrow enough to reach them.
 *
 * Pure functions. No React, no store, no DOM.
 */

import { fillRecesses } from '../../mesh/profile.js';
import { turningSpeeds } from '../feeds.js';

/** Resample a {z,r} polyline onto a uniform axial grid, ascending in z. */
function resample(profile, step) {
  const pts = [...profile].sort((a, b) => a.z - b.z);
  if (pts.length === 0) return [];
  const out = [];
  const zMin = pts[0].z, zMax = pts[pts.length - 1].z;
  let k = 0;
  for (let z = zMin; z <= zMax + 1e-9; z += step) {
    while (k < pts.length - 2 && pts[k + 1].z < z) k++;
    const a = pts[k], b = pts[Math.min(k + 1, pts.length - 1)];
    const t = b.z === a.z ? 0 : (z - a.z) / (b.z - a.z);
    out.push({ z, r: a.r + (b.r - a.r) * Math.max(0, Math.min(1, t)) });
  }
  return out;
}

/** Length of a move list, counting feed moves only — rapids are not cutting. */
export function cutLengthOf(moves) {
  let len = 0;
  for (let i = 1; i < moves.length; i++) {
    if (moves[i].t !== 'feed') continue;
    len += Math.hypot(moves[i].x - moves[i - 1].x, moves[i].z - moves[i - 1].z);
  }
  return len;
}

/** Assemble an operation record, deriving the numbers the UI reports. */
function makeOp(kind, name, tool, speeds, moves, notes = []) {
  const cutLength = cutLengthOf(moves);
  // Lathe feed is mm/rev, so minutes = length / (fn * rpm).
  const feedPerMin = (speeds.fn ?? speeds.feed) * speeds.rpm;
  return {
    kind, name, tool, speeds, moves, notes,
    cutLength: Number(cutLength.toFixed(2)),
    estMinutes: feedPerMin > 0 ? Number((cutLength / feedPerMin).toFixed(2)) : 0,
  };
}

/**
 * Face the free end down to centre.
 *
 * Facing exists to give every later Z a datum: the raw bar is sawn off crooked
 * and long, so the first cut squares it and defines Z0. Passes step in from the
 * stock face until the finished face is reached.
 */
export function facingOp(profile, opts) {
  const { material, stock, tool, machine, clearance = 2, doc = 1 } = opts;
  const faceZ = profile.zMax;
  const startZ = stock.zMax ?? faceZ + 2;
  const rOut = stock.radius;
  const rIn = 0; // face right through centre

  const speeds = turningSpeeds({ material, diameter: rOut * 2, noseRadius: tool.noseRadius, machine });
  const moves = [];
  const passes = Math.max(1, Math.ceil((startZ - faceZ) / doc));
  for (let i = 1; i <= passes; i++) {
    const z = startZ - ((startZ - faceZ) * i) / passes;
    moves.push({ t: 'rapid', x: rOut + clearance, z });
    moves.push({ t: 'feed', x: rOut + clearance, z });
    // Feed inward across the face; nose radius keeps it from reaching true zero.
    moves.push({ t: 'feed', x: rIn - tool.noseRadius, z });
    moves.push({ t: 'rapid', x: rOut + clearance, z });
  }
  return makeOp('face', 'Face free end', tool, speeds, moves, [
    `${passes} pass(es) removing ${(startZ - faceZ).toFixed(2)} mm of end stock`,
  ]);
}

/**
 * OD roughing — profile-following passes from the bar down toward the finished
 * shape.
 *
 * Each pass has a target radius, but the tool does **not** run at that radius
 * all the way along: where the finished profile is already outside it, the pass
 * follows the profile instead. Written as `max(passRadius, profile + allowance)`
 * that is one line, and it is the difference between a program that works and
 * one that does not.
 *
 * A constant-radius pass looks correct until a stepped shaft goes through it.
 * On a Ø30 body stepping down to Ø16 out of Ø33 bar, the passes land at radius
 * 12.5 and 8.5 — both far inside the Ø30 body, which is therefore never
 * cuttable at any pass, so the 1.5 mm of stock over it survives roughing
 * entirely and lands on the finishing insert. Following the profile removes it
 * on the first pass, which is what a G71 type II cycle does on the control.
 *
 * A span is cut only where this pass leaves the previous one behind, so no pass
 * re-cuts air.
 */
export function roughingOp(profile, opts) {
  const {
    material, stock, tool, machine, allowance = 0.4, clearance = 2, step = 0.25,
  } = opts;
  const doc = Math.min(opts.doc ?? tool.maxDoc ?? 2, tool.maxDoc ?? 2);
  const filled = resample(fillRecesses(profile.outer), step);
  if (filled.length === 0) return null;

  const rStock = stock.radius;
  let rMin = Infinity;
  for (const p of filled) rMin = Math.min(rMin, p.r);
  const target = rMin + allowance;
  if (rStock <= target + 1e-6) return null; // nothing to rough

  const speeds = turningSpeeds({ material, diameter: rStock * 2, noseRadius: tool.noseRadius, machine });
  const moves = [];
  const passes = Math.max(1, Math.ceil((rStock - target) / doc));
  // Free end first: that is the direction the turret approaches from.
  const ordered = [...filled].sort((a, b) => b.z - a.z);

  for (let i = 1; i <= passes; i++) {
    const rp = rStock - ((rStock - target) * i) / passes;
    const prev = rStock - ((rStock - target) * (i - 1)) / passes;

    // Walk the part, collecting the runs this pass actually removes metal on.
    const spans = [];
    let open = null;
    for (const p of ordered) {
      const cutR = Math.max(rp, p.r + allowance);
      if (cutR < prev - 1e-9) {
        if (!open) spans.push(open = []);
        open.push({ z: p.z, r: cutR });
      } else open = null;
    }

    for (const span of spans) {
      if (span.length < 2) continue;
      // The span is a stepped polyline; simplifying it keeps the NC readable
      // without moving the cut, since the tolerance is well under the allowance.
      const path = simplifySpan(span, 0.02);
      moves.push({ t: 'rapid', x: path[0].r, z: path[0].z + clearance });
      for (const p of path) moves.push({ t: 'feed', x: p.r, z: p.z });
      const last = path[path.length - 1];
      moves.push({ t: 'feed', x: last.r + clearance, z: last.z }); // clear the wall
      moves.push({ t: 'rapid', x: rStock + clearance, z: path[0].z + clearance });
    }
  }

  if (moves.length === 0) return null;
  return makeOp('rough', 'OD roughing', tool, speeds, moves, [
    `${passes} pass(es) at ${((rStock - target) / passes).toFixed(2)} mm depth of cut`,
    `${allowance} mm left on for finishing`,
    'Passes follow the profile where it stands outside the pass radius',
  ]);
}

/** Drop collinear points from a {z,r} run — the cut is unchanged, the file shorter. */
function simplifySpan(pts, tol) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const dz = c.z - a.z, dr = c.r - a.r;
    const len = Math.hypot(dz, dr);
    const dist = len > 0 ? Math.abs(dz * (a.r - b.r) - (a.z - b.z) * dr) / len : 0;
    if (dist > tol) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * OD finishing — one pass following the finished profile.
 *
 * Runs lighter and faster than roughing: a smaller feed per revolution is what
 * actually buys surface finish, and `turningSpeeds` reports the Ra that feed
 * implies so the operator can see whether the insert or the feedrate is the
 * limit.
 */
export function finishingOp(profile, opts) {
  const { material, tool, machine, clearance = 2, fnScale = 0.5 } = opts;
  const path = fillRecesses(profile.outer); // already free-end -> chuck
  if (path.length < 2) return null;

  const dia = profile.maxDiameter;
  const speeds = turningSpeeds({
    material, diameter: dia, fnScale, noseRadius: tool.noseRadius, machine,
  });

  const moves = [{ t: 'rapid', x: path[0].r, z: path[0].z + clearance }];
  for (const p of path) moves.push({ t: 'feed', x: p.r, z: p.z });
  const last = path[path.length - 1];
  moves.push({ t: 'rapid', x: last.r + clearance, z: last.z });

  return makeOp('finish', 'OD finishing', tool, speeds, moves, [
    `Estimated Ra ${speeds.estimatedRa} µm at ${speeds.fn} mm/rev with a ${tool.noseRadius} mm nose`,
  ]);
}

/**
 * Groove a single recess by plunging.
 *
 * A blade wider than the groove cannot enter, and one much narrower wastes
 * plunges, so the planner picks the tool; this only has to space the plunges.
 * Successive plunges overlap by 20% of the blade width — enough that the wall
 * between them never becomes a thin fin that snaps off into the cut.
 */
export function groovingOp(recess, opts) {
  const { material, tool, machine, clearance = 1, fnScale = 0.4 } = opts;
  const w = tool.width;
  if (w > recess.width + 1e-6) return null; // blade will not fit

  const speeds = turningSpeeds({
    material, diameter: recess.shoulderRadius * 2, fnScale,
    noseRadius: tool.noseRadius, machine,
  });

  // Plunge centres, from one wall to the other, blade edges flush with each.
  const first = recess.zStart + w / 2;
  const last = recess.zEnd - w / 2;
  const span = Math.max(0, last - first);
  const steps = Math.max(1, Math.ceil(span / (w * 0.8)));
  const moves = [];
  for (let i = 0; i <= steps; i++) {
    const z = steps === 0 ? first : first + (span * i) / steps;
    moves.push({ t: 'rapid', x: recess.shoulderRadius + clearance, z });
    moves.push({ t: 'feed', x: recess.minRadius, z });
    moves.push({ t: 'rapid', x: recess.shoulderRadius + clearance, z });
  }

  return makeOp('groove', `Groove at Z${recess.zStart.toFixed(1)}`, tool, speeds, moves, [
    `${steps + 1} plunge(s) with a ${w} mm blade across a ${recess.width.toFixed(2)} mm groove`,
    `${recess.depth.toFixed(2)} mm deep`,
  ]);
}

/**
 * Bore an existing hole out to the finished size.
 *
 * The bore is cut from the free end inward like OD work, but the tool grows the
 * hole rather than shrinking the bar, so the passes step *outward*. Boring bars
 * are long and slender, so the depth of cut is deliberately lighter than the
 * insert's nominal maximum — chatter, not insert strength, is what limits a
 * bore.
 */
export function boringOp(profile, opts) {
  const {
    material, tool, machine, allowance = 0.2, clearance = 1, step = 0.25, startRadius,
  } = opts;
  if (!profile.hasBore || profile.bore.length === 0) return null;
  const doc = Math.min(opts.doc ?? tool.maxDoc ?? 1, tool.maxDoc ?? 1);

  const bore = resample(profile.bore.filter((p) => p.r > 0), step);
  if (bore.length === 0) return null;
  let rTarget = 0;
  for (const p of bore) rTarget = Math.max(rTarget, p.r);
  const r0 = startRadius ?? Math.max(0, rTarget - 4);
  if (rTarget <= r0 + 1e-6) return null;

  const speeds = turningSpeeds({
    material, diameter: rTarget * 2, noseRadius: tool.noseRadius, machine,
  });
  const zHi = Math.max(...bore.map((p) => p.z));
  const zLo = Math.min(...bore.map((p) => p.z));

  const moves = [];
  const passes = Math.max(1, Math.ceil((rTarget - r0) / doc));
  for (let i = 1; i <= passes; i++) {
    const rp = r0 + ((rTarget - r0 - allowance) * i) / passes;
    moves.push({ t: 'rapid', x: rp, z: zHi + clearance });
    moves.push({ t: 'feed', x: rp, z: zLo });
    moves.push({ t: 'feed', x: rp - clearance / 2, z: zLo }); // pull off the wall
    moves.push({ t: 'rapid', x: rp - clearance / 2, z: zHi + clearance });
  }

  return makeOp('bore', 'Bore', tool, speeds, moves, [
    `${passes} pass(es) from Ø${(r0 * 2).toFixed(1)} to Ø${(rTarget * 2).toFixed(1)}`,
    `${allowance} mm left on for finishing`,
  ]);
}

/**
 * Part the finished piece off the bar.
 *
 * Feeds at a fraction of normal: as the blade approaches centre the surface
 * speed collapses, and a blade that is still being fed hard at that point digs
 * in and snaps. Stopping a nose radius short of zero leaves the small pip that
 * every parted part has.
 */
export function partingOp(profile, opts) {
  const { material, stock, tool, machine, clearance = 2, fnScale = 0.35 } = opts;
  const z = profile.zMin;
  const speeds = turningSpeeds({
    material, diameter: stock.radius * 2, fnScale,
    noseRadius: tool.noseRadius, machine,
  });
  const moves = [
    { t: 'rapid', x: stock.radius + clearance, z },
    { t: 'feed', x: 0.2, z },
    { t: 'rapid', x: stock.radius + clearance, z },
  ];
  return makeOp('part', 'Part off', tool, speeds, moves, [
    `${tool.width} mm blade at Z${z.toFixed(2)}`,
    'Feed is reduced near centre, where surface speed collapses',
  ]);
}
