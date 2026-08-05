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
    note: 'Two flutes, centre-cutting. Plunges a slot to a set depth of cut without rubbing.',
    profile: 'flat',
    flutes: 2,
    fluteRange: [2, 3],
    bodyRatio: 3,
    // The one type whose second dimension is a number the operator knows and
    // the diameter cannot imply: how deep the cutting body reaches — the depth
    // of cut it can take in one pass. Every other type's cutting body just
    // follows its diameter through `bodyRatio`.
    thicknessAdjustable: true,
    thicknessRange: [0.5, 200],
    // ...and the same for the shank. A slot mill is commonly necked — a wide
    // cutting body on a narrower shank, so the shank clears the walls of the
    // slot it has just cut. Every other type's shank is its own diameter, near
    // enough that asking would be noise.
    shankAdjustable: true,
    shankRange: [0.5, 200],
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
  {
    id: 'drill',
    label: 'Twist drill',
    // A drill was the one common tool with no shape here, so it carved as a
    // flat-bottomed disc: a blind hole came out with a square floor, which is
    // the one thing every machinist knows a drill does not leave. The point
    // angle is the cone it leaves, and 118° is what general-purpose drills are
    // ground to — 135° for split points in harder material, so it is adjustable.
    note: 'Point angle 118° as standard, 135° for split points. Leaves a cone in the bottom of a blind hole.',
    profile: 'cone',
    flutes: 2,
    fluteRange: [2, 3],
    angle: 118,
    angleAdjustable: true,
    bodyRatio: 5,
  },
];

export const DEFAULT_CUTTER = 'endmill';

const BY_ID = new Map(CUTTERS.map((c) => [c.id, c]));

/** Look a cutter up, falling back to the endmill rather than throwing. */
export function cutterById(id) {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_CUTTER);
}

/**
 * The cutter a program's own tool comment describes.
 *
 * `gcode/tools.js` classifies `T1(SHOULDERMILL D32 - FACE MILLING)` into a
 * normalised type; this says which of the shapes above that type *is*, so a
 * detected tool draws and carves as itself instead of as whatever the fallback
 * picker happens to hold.
 *
 * A **twist drill** now has a shape of its own, and it earns it: the cone it
 * leaves in the bottom of a blind hole is the difference between a hole that
 * looks drilled and one that looks bored square. A **centre drill** is spotting
 * a cone too, and the chamfer mill's is the same shape.
 *
 * Still `null` for the types that cut no new bore of their own — a reamer sizes
 * a hole that is already there, a tap cuts threads into one, a boring bar opens
 * one out. Those keep the plain flat/ball at their own diameter, which is what
 * they leave behind. Callers treat `null` as "keep the plain flat/ball".
 */
const CUTTER_FOR_TYPE = {
  endmill: 'endmill',
  // A bull nose is an endmill with a corner radius; square-ended is the closer
  // of the two shapes we have (a ball nose has no flat at all).
  bullmill: 'endmill',
  slotmill: 'slot',
  shouldermill: 'shoulder',
  facemill: 'face',
  ballmill: 'ball',
  chamfer: 'chamfer',
  drill: 'drill',
};

export function cutterFromType(type) {
  return CUTTER_FOR_TYPE[String(type ?? '').toLowerCase()] ?? null;
}

/**
 * How thick the cutting body is — the axial length of the flutes, in mm.
 *
 * This is the tool's *second* dimension, and for most types it is not worth
 * asking for: an endmill's flute length follows its diameter closely enough
 * that `bodyRatio` can imply it, and a face mill is a shallow disc whatever its
 * size. A slot cutter is the exception — it is specified as Ø × thickness, and
 * the thickness is the width of the slot it leaves, so it cannot be derived
 * from anything. `thickness` (from the tool table, or the fallback picker)
 * overrides the implied value when the operator has one.
 *
 * Floored at 2 mm: a zero-length cutting body is not a thin tool, it is an
 * invisible one.
 */
export function defaultThickness(id, diameter = 6) {
  return Math.max(2, Math.max(diameter, 0) * cutterById(id).bodyRatio);
}

/** Clamp a thickness to what the type is sensibly made in. */
export function clampThickness(id, mm) {
  const c = cutterById(id);
  const [lo, hi] = c.thicknessRange ?? [0.5, 200];
  if (!Number.isFinite(mm)) return null;
  return Math.max(lo, Math.min(hi, mm));
}

/**
 * Shank diameter (mm) — the plain part above the flutes, which the holder grips.
 *
 * Almost always the cutting diameter, and it is drawn a hair under so the flutes
 * read as flutes rather than as more shank. A slot mill is the exception worth
 * asking about: a necked cutter runs a wide body on a narrow shank precisely so
 * the shank clears the slot walls, and a marker that draws it full width says
 * the tool will rub when it will not.
 */
export function defaultShank(id, diameter = 6) {
  const d = Math.max(diameter, 0);
  return Math.max(d * 0.9, d - 1, 0.1);
}

/** Clamp a shank diameter to what the type is sensibly made in. */
export function clampShank(id, mm) {
  const c = cutterById(id);
  const [lo, hi] = c.shankRange ?? [0.5, 200];
  if (!Number.isFinite(mm)) return null;
  return Math.max(lo, Math.min(hi, mm));
}

/**
 * The `flat`/`ball` the older carving code understands.
 *
 * A cone has no equivalent there, and saying "flat" for one would carve a
 * square-bottomed pocket. It maps to `ball` instead — wrong in detail, but
 * wrong in the *direction of a rounded bottom* rather than a sharp corner,
 * which is the safer of the two lies for anything that has not been taught
 * cones. A disc keeps `flat`, which is the shape it used to be carved as
 * everywhere — a wrong slot width is a smaller lie than a rounded floor.
 * Everything that stamps through `cutFootprint` gets the real shape.
 */
export function simTypeOf(id) {
  const c = cutterById(id);
  return c.profile === 'ball' || c.profile === 'cone' ? 'ball' : 'flat';
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
 * Where the cutter's surface sits above the tip, at an offset `(u, w)` from the
 * tool axis. `null` means the point is clear of the cutter and the cell is not
 * touched — which is what separates "no material removed here" from "removed
 * down to the tip", and is why the carvers ask this rather than testing the
 * radius themselves.
 *
 * Every cutter is a solid of revolution about the spindle axis, so only the
 * distance from the axis matters and the two offsets are interchangeable. They
 * are kept separate because a cell's offset is naturally two numbers, and one
 * `Math.hypot` here is cheaper than every caller repeating the same test.
 *
 * @param {{radius:number, type?:string, angle?:number}} tool
 * @param {number} u  offset from the tool axis, mm
 * @param {number} w  offset from the tool axis at right angles to `u`, mm
 * @returns {number|null} height above the tip, or null when outside the cutter
 */
export function cutFootprint(tool, u, w) {
  const r = Math.max(tool.radius ?? 0, 1e-9);
  const d = Math.hypot(u, w);
  if (d > r) return null;
  return profileRise(tool, d);
}

/**
 * The carving geometry for a cutter type at a diameter — what `toolResolver`
 * hands each stamp.
 */
export function cutterGeometry({
  cutter = DEFAULT_CUTTER, diameter = 6, angle, thickness,
} = {}) {
  const c = cutterById(cutter);
  return {
    radius: Math.max(diameter, 1e-6) / 2,
    type: c.profile,
    ...(c.profile === 'cone' ? { angle: angle ?? c.angle ?? 90 } : {}),
    // How far up the tool the cutting body reaches, and only when the operator
    // has actually said. The height field cannot use it — a column has nothing
    // below its own top — but the voxel carver can, and a cutter that only cuts
    // for its first few mm leaves material standing above that. An *implied*
    // thickness must not do this: it is a drawing default, not a measurement,
    // and silently capping every cut at 3× the diameter is not something a
    // guess has earned.
    ...(c.thicknessAdjustable && thickness > 0 ? { thickness } : {}),
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
