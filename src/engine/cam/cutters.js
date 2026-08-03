/**
 * Milling cutter **types** — what shape the thing on the spindle actually is.
 *
 * The sim only ever knew two cutters: `flat` and `ball`. That is enough to
 * carve a height field and not enough to describe a tool: a Ø50 face mill and a
 * Ø6 slot drill are both "flat", and they are not remotely the same tool. The
 * difference shows up in three places that all matter:
 *
 * - **the feed rate.** `feeds.js` computes `feed = rpm × flutes × fz`, so a
 *   6-insert face mill feeds three times a 2-flute slot drill at the same rpm
 *   and chip load. Flute count is not decoration; it is a term in the cycle
 *   time.
 * - **the cut.** A chamfer mill leaves a cone, not a flat bottom. Carving it as
 *   flat draws a square-shouldered pocket where the part has a chamfer, which
 *   is the one thing the simulation exists to show you.
 * - **the picture.** A face mill is a wide disc on a big arbor; an endmill is a
 *   long thin stick. A marker that draws both the same is not telling you
 *   whether the holder will clear the fixture.
 *
 * So a cutter here carries its own geometry, its own sensible flute count, and
 * the range of flute counts that is honest for it — a 12-flute slot drill is
 * not a thing, and the UI should not offer one.
 *
 * `profileRise(cutter, d)` is the shared surface function: **how far above the
 * tool tip the cutting surface sits, at distance `d` from the tool axis**. The
 * dexel and voxel carvers both stamp with it, so a new cutter shape becomes
 * available to both at once and cannot disagree between them.
 *
 * Pure data + pure maths: no React, no store, no three.js.
 */

/**
 * @typedef {object} Cutter
 * @property {string} id
 * @property {string} label
 * @property {string} note        one line on what it is for
 * @property {'flat'|'ball'|'cone'} profile  the surface `profileRise` builds
 * @property {number} flutes      the flute/insert count to start from
 * @property {[number,number]} fluteRange  the counts worth offering
 * @property {number} [angle]     cone cutters: included angle, degrees
 * @property {boolean} [angleAdjustable]
 * @property {number} bodyRatio   flute length as a multiple of diameter — a
 *   face mill is a disc, an endmill is a stick, and the marker needs to know
 * @property {number} [minDiameter] below this the type is not made
 */

/** @type {Cutter[]} */
export const CUTTERS = [
  {
    id: 'endmill',
    label: 'Endmill',
    note: 'Square end. Cuts on the side and the bottom — the general-purpose cutter.',
    profile: 'flat',
    flutes: 4,
    fluteRange: [2, 6],
    bodyRatio: 3,
  },
  {
    id: 'shoulder',
    label: 'Shoulder mill',
    note: 'Indexed, cuts a true 90° wall against a floor. Heavy radial cuts, shallow.',
    profile: 'flat',
    flutes: 3,
    fluteRange: [2, 5],
    bodyRatio: 1.2,
    minDiameter: 10,
  },
  {
    id: 'face',
    label: 'Face mill',
    note: 'Large indexed disc for clearing a flat face fast. Shallow depth, wide bite.',
    profile: 'flat',
    flutes: 6,
    fluteRange: [3, 10],
    bodyRatio: 0.35,
    minDiameter: 25,
  },
  {
    id: 'slot',
    label: 'Slot mill',
    note: 'Two flutes, centre-cutting. Plunges and cuts a full-width slot without rubbing.',
    profile: 'flat',
    flutes: 2,
    fluteRange: [2, 3],
    bodyRatio: 3,
  },
  {
    id: 'ball',
    label: 'Ball nose',
    note: 'Spherical end for 3D surfacing and blending. Leaves a scallop, never a sharp corner.',
    profile: 'ball',
    flutes: 2,
    fluteRange: [2, 4],
    bodyRatio: 3,
  },
  {
    id: 'chamfer',
    label: 'Chamfer mill',
    note: 'Conical point for breaking edges and spotting holes. The angle is the chamfer you get.',
    profile: 'cone',
    flutes: 2,
    fluteRange: [1, 4],
    angle: 90,
    angleAdjustable: true,
    bodyRatio: 1.5,
  },
];

export const DEFAULT_CUTTER = 'endmill';

const BY_ID = new Map(CUTTERS.map((c) => [c.id, c]));

/** Look a cutter up, falling back to the endmill rather than throwing. */
export function cutterById(id) {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_CUTTER);
}

/**
 * The `flat`/`ball` the older carving code understands.
 *
 * A cone has no equivalent there, and saying "flat" for one would carve a
 * square-bottomed pocket. It maps to `ball` instead — wrong in detail, but
 * wrong in the *direction of a rounded bottom* rather than a sharp corner,
 * which is the safer of the two lies for anything that has not been taught
 * cones. Everything that stamps through `profileRise` gets the real shape.
 */
export function simTypeOf(id) {
  const c = cutterById(id);
  return c.profile === 'flat' ? 'flat' : 'ball';
}

/**
 * Clamp a flute count into what the type is actually made in.
 *
 * Not pedantry: flutes multiply the feed rate directly, so a 12-flute slot
 * drill typed in by accident produces a cycle time that is quietly six times
 * too fast, and nothing else on screen would contradict it.
 */
export function clampFlutes(id, n) {
  const [lo, hi] = cutterById(id).fluteRange;
  if (!Number.isFinite(n)) return cutterById(id).flutes;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/** The flute count to start from when the type changes under the operator. */
export function defaultFlutes(id) {
  return cutterById(id).flutes;
}

/**
 * How far above the tip the cutting surface sits, `d` out from the tool axis.
 *
 * This is the one function that defines what each cutter *is* to the carvers.
 * Both stamps ask it per cell, so the dexel height field and the voxel block
 * cannot disagree about the shape of a tool.
 *
 * - **flat** — 0 everywhere: a plane at the tip.
 * - **ball** — the sphere of radius r tangent to the tip: `r − √(r² − d²)`.
 * - **cone** — a chamfer/spot mill of included angle θ rises at the cotangent
 *   of the half-angle. A 90° cutter rises 1 mm per mm out (45° flank), a 60°
 *   one rises √3 — steeper, as the sharper point should be.
 *
 * Beyond the cutter's own radius the surface is not defined; callers already
 * skip those cells, and the value is clamped rather than left to go imaginary.
 *
 * @param {{radius:number, type?:string, angle?:number}} tool
 * @param {number} d  distance from the tool axis, mm
 */
export function profileRise(tool, d) {
  const r = Math.max(tool.radius ?? 0, 1e-9);
  const dist = Math.min(Math.abs(d), r);
  if (tool.type === 'ball') {
    return r - Math.sqrt(Math.max(0, r * r - dist * dist));
  }
  if (tool.type === 'cone' || tool.type === 'chamfer') {
    // Included angle θ → half-angle θ/2 from the axis. Guard the degenerate
    // ends: 180° is a flat cutter and 0° is a needle, neither of which should
    // divide by zero, and a NaN angle must not poison the height field.
    const deg = Number.isFinite(tool.angle) ? tool.angle : 90;
    const half = Math.max(1, Math.min(89.9, deg / 2));
    return dist / Math.tan((half * Math.PI) / 180);
  }
  return 0;
}

/**
 * The carving geometry for a cutter type at a diameter — what `toolResolver`
 * hands each stamp.
 */
export function cutterGeometry({ cutter = DEFAULT_CUTTER, diameter = 6, angle } = {}) {
  const c = cutterById(cutter);
  return {
    radius: Math.max(diameter, 1e-6) / 2,
    type: c.profile,
    ...(c.profile === 'cone' ? { angle: angle ?? c.angle ?? 90 } : {}),
  };
}

/**
 * Is this diameter plausible for this type?
 *
 * Advisory, never a block — shops do own odd tooling, and refusing to simulate
 * a Ø8 face mill would be the app telling a machinist what exists. It returns a
 * sentence to show, and the operator decides.
 */
export function cutterWarning({ cutter = DEFAULT_CUTTER, diameter = 6 } = {}) {
  const c = cutterById(cutter);
  if (c.minDiameter && diameter < c.minDiameter) {
    return `A ${c.label.toLowerCase()} is not usually made below Ø${c.minDiameter}.`;
  }
  return null;
}
