/**
 * Turning profile extraction — the (radius, axial) outline of a solid of
 * revolution.
 *
 * A lathe part is fully described by one cross-section through its spindle
 * axis, so this is the whole of "CAD" for the turning side: section the mesh on
 * a plane containing the axis, then read the material out of it.
 *
 * The reading is done by **scanline**, not by walking the section loop. At each
 * axial station the loop is crossed by a radial line, and the crossings sort
 * into pairs that bracket solid material. That falls out of the geometry rather
 * than being pattern-matched, so bores, grooves, and steps all come for free
 * instead of each needing its own detector:
 *
 *     crossings at r>0:  {10}          -> material 0..10   (solid bar)
 *     crossings at r>0:  {4, 10}       -> material 4..10   (bored)
 *     crossings at r>0:  {4, 6, 8, 10} -> two annuli       (internal recess)
 *
 * An odd count means the axis itself is inside material, which is why a solid
 * shaft reports a single crossing and still yields a filled section.
 *
 * Pure functions. No three.js, no store, no DOM.
 */

import { sliceLoops } from './slice.js';

const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/**
 * Section the mesh on a plane containing the spindle axis.
 *
 * Only one angular position is sampled. For a true revolve that is the entire
 * shape; the error is the faceting sagitta, which at a typical 32–72 facet
 * export is under 0.01 mm on a 50 mm part — far below anything the lathe will
 * hold anyway. A part that is *not* a revolve must not be sent here, which is
 * what `rotationalSymmetry` is for.
 *
 * @returns {{loops: object[], radialAxis: number, axialAxis: number, center: number[]}}
 *   loop points are `[radius, axial, ...]` with the axis at radius 0.
 */
export function axialSection(mesh, axis = 'z', opts = {}) {
  const axial = AXIS_INDEX[axis];
  if (axial === undefined) throw new Error(`axialSection: bad axis ${axis}`);
  const [t0, t1] = [0, 1, 2].filter((k) => k !== axial);
  // Cut on the plane spanned by the axis and the first transverse axis, i.e.
  // the plane whose normal is the second transverse axis.
  const normal = t1;
  const center = opts.center ?? centerOf(mesh, normal);

  const { loops, openCount } = sliceLoops(mesh, normal, center, opts);
  // sliceLoops returns the two axes other than `normal`, in ascending order.
  const [a, b] = [0, 1, 2].filter((k) => k !== normal);
  const radialIsFirst = a === t0;

  // Re-express every loop as [radius, axial] and shift the radius onto the axis.
  const radialCenter = opts.radialCenter ?? centerOf(mesh, t0);
  const out = loops.map((l) => {
    const pts = new Array(l.points.length);
    for (let i = 0; i < l.points.length; i += 2) {
      const first = l.points[i], second = l.points[i + 1];
      pts[i] = (radialIsFirst ? first : second) - radialCenter;
      pts[i + 1] = radialIsFirst ? second : first;
    }
    return { ...l, points: pts };
  });

  return { loops: out, radialAxis: t0, axialAxis: axial, center, openCount, radialCenter };
}

function centerOf(mesh, k) {
  const p = mesh.positions;
  let lo = Infinity, hi = -Infinity;
  for (let i = k; i < p.length; i += 3) {
    if (p[i] < lo) lo = p[i];
    if (p[i] > hi) hi = p[i];
  }
  return Number.isFinite(lo) ? (lo + hi) / 2 : 0;
}

/**
 * Radial material intervals at one axial station.
 *
 * @returns {Array<[number, number]>} inner/outer radius pairs, innermost first.
 *   Empty when the station is off the end of the part.
 */
export function radialIntervalsAt(loops, z, eps = 1e-9) {
  const xs = [];
  for (const l of loops) {
    const pts = l.points;
    const n = pts.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ri = pts[i * 2], zi = pts[i * 2 + 1];
      const rj = pts[j * 2], zj = pts[j * 2 + 1];
      if ((zi > z) === (zj > z)) continue; // edge does not straddle this station
      const r = ri + ((rj - ri) * (z - zi)) / (zj - zi);
      if (r > eps) xs.push(r);
    }
  }
  if (xs.length === 0) return [];
  xs.sort((a, b) => a - b);
  // Odd count: the crossing at r=0 is implicit, so material starts on the axis.
  if (xs.length % 2 === 1) xs.unshift(0);
  const intervals = [];
  for (let i = 0; i + 1 < xs.length; i += 2) intervals.push([xs[i], xs[i + 1]]);
  return intervals;
}

/**
 * Ramer–Douglas–Peucker simplification of a polyline given as {z, r} points.
 *
 * A section sampled every 0.1 mm along a 100 mm shaft is a thousand points
 * describing what is usually four straight faces. Simplifying to a chord
 * tolerance keeps the toolpath readable and the NC file small, and the
 * tolerance is a machining number — the deviation the finished profile is
 * allowed to have from the model.
 */
export function simplify(points, tol = 0.01) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const az = points[lo].z, ar = points[lo].r;
    const bz = points[hi].z, br = points[hi].r;
    const dz = bz - az, dr = br - ar;
    const len = Math.hypot(dz, dr);
    let worst = -1, worstI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = len > 0
        ? Math.abs(dz * (ar - points[i].r) - (az - points[i].z) * dr) / len
        : Math.hypot(points[i].z - az, points[i].r - ar);
      if (d > worst) { worst = d; worstI = i; }
    }
    if (worst > tol) {
      keep[worstI] = 1;
      stack.push([lo, worstI], [worstI, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * The full turning profile of a mesh.
 *
 * `outer` and `bore` are simplified polylines running from the **free end
 * (+axial) toward the chuck**, which is the direction a lathe actually cuts and
 * therefore the order the toolpath wants them in.
 *
 * `recesses` are the axial ranges an ordinary OD tool cannot reach by feeding
 * along the part — anywhere the radius dips below the largest diameter on
 * *both* sides of it. Those are grooves, and calling them out here is what lets
 * the planner route them to a grooving blade instead of quietly generating a
 * profile pass that would smash the tool into a shoulder.
 *
 * @param {object} mesh welded mesh
 * @param {'x'|'y'|'z'} axis spindle axis
 * @param {{step?:number, tol?:number}} opts
 */
export function turningProfile(mesh, axis = 'z', opts = {}) {
  const { tol = 0.01 } = opts;
  const section = axialSection(mesh, axis, opts);
  const { loops } = section;

  let zMin = Infinity, zMax = -Infinity, rMax = 0;
  for (const l of loops) {
    for (let i = 0; i < l.points.length; i += 2) {
      const r = Math.abs(l.points[i]), z = l.points[i + 1];
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
      if (r > rMax) rMax = r;
    }
  }
  if (!Number.isFinite(zMin)) {
    return { outer: [], bore: [], recesses: [], length: 0, maxRadius: 0, maxDiameter: 0, hasBore: false, warnings: ['No section could be taken — is the axis right?'] };
  }

  const length = zMax - zMin;
  const step = opts.step ?? Math.max(length / 2000, 0.02);
  // Sample just inside each end: a station exactly on the face crosses no edge.
  const inset = Math.min(step / 2, length / 1000);

  const outerRaw = [];
  const boreRaw = [];
  let hasBore = false;
  for (let z = zMin + inset; z <= zMax - inset; z += step) {
    const iv = radialIntervalsAt(loops, z);
    if (iv.length === 0) continue;
    const outer = iv[iv.length - 1][1];
    const inner = iv[0][0];
    outerRaw.push({ z, r: outer });
    if (inner > 1e-6) { hasBore = true; boreRaw.push({ z, r: inner }); }
    else boreRaw.push({ z, r: 0 });
  }

  // Cut from the free end toward the chuck.
  outerRaw.reverse();
  boreRaw.reverse();

  const recesses = findRecesses(outerRaw, Math.max(tol * 2, 0.05));
  const warnings = [];
  if (section.openCount > 0) {
    warnings.push(`${section.openCount} open edge chains in the section — the profile may be incomplete.`);
  }
  if (recesses.length > 0) {
    warnings.push(`${recesses.length} recess(es) found — these need a grooving tool, not a profiling pass.`);
  }

  return {
    axis,
    outer: simplify(outerRaw, tol),
    bore: hasBore ? simplify(boreRaw, tol) : [],
    recesses,
    zMin, zMax, length,
    maxRadius: rMax,
    maxDiameter: rMax * 2,
    hasBore,
    boreDiameter: hasBore ? Math.min(...boreRaw.filter((p) => p.r > 0).map((p) => p.r)) * 2 : 0,
    warnings,
  };
}

/**
 * Axial ranges the OD profile dips into and comes back out of.
 *
 * A point is in a recess when a larger radius exists on *both* sides of it: the
 * tool would have to pass over a bigger diameter to reach it, which a profiling
 * insert cannot do without gouging. Comparing against the running maximum from
 * each end states that condition directly, and needs no assumption about how
 * many grooves there are or what shape they have.
 */
export function findRecesses(profile, tol = 0.05) {
  const n = profile.length;
  if (n < 3) return [];
  const leftMax = new Float64Array(n);
  const rightMax = new Float64Array(n);
  let run = -Infinity;
  for (let i = 0; i < n; i++) { run = Math.max(run, profile[i].r); leftMax[i] = run; }
  run = -Infinity;
  for (let i = n - 1; i >= 0; i--) { run = Math.max(run, profile[i].r); rightMax[i] = run; }

  const recesses = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    const blocked = Math.min(leftMax[i], rightMax[i]) - profile[i].r > tol;
    if (blocked && start < 0) start = i;
    else if (!blocked && start >= 0) {
      recesses.push(rangeOf(profile, start, i - 1, leftMax, rightMax));
      start = -1;
    }
  }
  if (start >= 0) recesses.push(rangeOf(profile, start, n - 1, leftMax, rightMax));
  return recesses;
}

/**
 * The profile with every recess filled back up to its shoulder.
 *
 * This is the shape an **OD profiling tool can actually follow**. A groove has
 * to be cut by plunging a narrow blade straight in; a profiling insert fed
 * along the part would drop into it and then drive its flank into the far wall
 * on the way out. Roughing and finishing therefore work from the filled
 * profile, and the grooves are cut separately by the tool that can reach them.
 *
 * Filling is just the running-maximum envelope from both ends — the same
 * quantity `findRecesses` thresholds, used here as geometry rather than as a
 * test.
 */
export function fillRecesses(profile) {
  const n = profile.length;
  if (n === 0) return [];
  const leftMax = new Float64Array(n);
  const rightMax = new Float64Array(n);
  let run = -Infinity;
  for (let i = 0; i < n; i++) { run = Math.max(run, profile[i].r); leftMax[i] = run; }
  run = -Infinity;
  for (let i = n - 1; i >= 0; i--) { run = Math.max(run, profile[i].r); rightMax[i] = run; }
  return profile.map((p, i) => ({ z: p.z, r: Math.min(leftMax[i], rightMax[i]) }));
}

function rangeOf(profile, i0, i1, leftMax, rightMax) {
  const zs = [profile[i0].z, profile[i1].z];
  let minR = Infinity;
  for (let i = i0; i <= i1; i++) minR = Math.min(minR, profile[i].r);
  // Depth is measured from the shoulder the groove is cut into — the smaller of
  // the two radii walling it in — not from the deepest point inside the groove,
  // which is what the tool has to plunge past.
  const shoulder = Math.min(leftMax[i0], rightMax[i1]);
  return {
    zStart: Math.min(...zs),
    zEnd: Math.max(...zs),
    width: Math.abs(zs[1] - zs[0]),
    minRadius: minR,
    shoulderRadius: shoulder,
    depth: shoulder - minR,
  };
}
