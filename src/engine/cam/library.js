/**
 * Tool and material library — the reference data the planner picks from.
 *
 * Everything here is a **starting point, not a guarantee**. Cutting data depends
 * on the machine's rigidity, the workholding, the coolant, and the tool's actual
 * brand; a table can only put you in the right neighbourhood. The planner's job
 * is to pick something sane and show its working, and the operator's job is to
 * trim it at the machine. That caveat is carried through to the UI, not buried
 * here.
 *
 * Cutting speeds are for coated carbide, which is what the vast majority of
 * shops run. HSS would be roughly a third of these numbers.
 *
 * Pure data + pure lookups: no React, no store, no DOM.
 */

/**
 * Work materials.
 *
 * - `vcMill` / `vcTurn` — cutting speed (m/min). Turning tolerates more surface
 *   speed than milling because the cut is continuous rather than interrupted.
 * - `fzBase` — feed per tooth (mm) for a 10 mm mill; scaled by diameter in
 *   `feeds.js`, since a small cutter cannot take the same chip.
 * - `fnTurn` — feed per revolution (mm/rev) for finishing on the lathe.
 * - `apFactor` — roughing depth of cut as a multiple of tool diameter.
 * - `aeFactor` — roughing stepover as a fraction of tool diameter.
 */
export const MATERIALS = [
  { id: 'aluminium', label: 'Aluminium (6061 / 7075)', vcMill: 400, vcTurn: 500, fzBase: 0.06, fnTurn: 0.15, apFactor: 1.0, aeFactor: 0.45 },
  // T7351 is overaged/stress-relieved for stress-corrosion resistance, which
  // also leaves it a touch softer and less gummy than 7075's peak-strength
  // T6 temper — still tougher than 6061, so a notch below the generic
  // aluminium entry rather than sharing its numbers.
  { id: 'al-7075-t7351', label: 'Aluminium 7075-T7351', vcMill: 350, vcTurn: 450, fzBase: 0.055, fnTurn: 0.14, apFactor: 0.9, aeFactor: 0.4 },
  { id: 'brass', label: 'Brass / Bronze', vcMill: 250, vcTurn: 300, fzBase: 0.05, fnTurn: 0.12, apFactor: 0.8, aeFactor: 0.45 },
  { id: 'mild-steel', label: 'Mild steel (S45C / 1045)', vcMill: 150, vcTurn: 200, fzBase: 0.04, fnTurn: 0.12, apFactor: 0.5, aeFactor: 0.35 },
  { id: 'alloy-steel', label: 'Alloy steel (SCM440 / 4140)', vcMill: 110, vcTurn: 160, fzBase: 0.035, fnTurn: 0.10, apFactor: 0.4, aeFactor: 0.30 },
  { id: 'stainless', label: 'Stainless (SUS304 / 316)', vcMill: 90, vcTurn: 120, fzBase: 0.03, fnTurn: 0.10, apFactor: 0.35, aeFactor: 0.25 },
  // Precipitation-hardening stainless — gummy and work-hardens fast like 304,
  // but the aged (H900-class) condition most shops actually cut runs harder,
  // so it sits below plain stainless and alongside tool steel rather than
  // sharing 304/316's numbers.
  { id: '17-4ph', label: '17-4PH stainless (H900, UNS S17400)', vcMill: 55, vcTurn: 75, fzBase: 0.025, fnTurn: 0.09, apFactor: 0.3, aeFactor: 0.22 },
  { id: '15-5ph', label: '15-5PH stainless (H900, UNS S15500)', vcMill: 55, vcTurn: 78, fzBase: 0.025, fnTurn: 0.09, apFactor: 0.3, aeFactor: 0.22 },
  { id: 'tool-steel', label: 'Tool steel (SKD11, hardened)', vcMill: 60, vcTurn: 80, fzBase: 0.025, fnTurn: 0.08, apFactor: 0.25, aeFactor: 0.20 },
  { id: 'titanium', label: 'Titanium (Ti-6Al-4V)', vcMill: 50, vcTurn: 60, fzBase: 0.03, fnTurn: 0.10, apFactor: 0.3, aeFactor: 0.20 },
  { id: 'plastic', label: 'Plastic (POM / nylon / ABS)', vcMill: 500, vcTurn: 400, fzBase: 0.08, fnTurn: 0.20, apFactor: 1.5, aeFactor: 0.50 },
];

export const DEFAULT_MATERIAL = 'aluminium';

/** Look a material up by id, falling back to the default rather than throwing. */
export function materialById(id) {
  return MATERIALS.find((m) => m.id === id) || MATERIALS.find((m) => m.id === DEFAULT_MATERIAL);
}

/**
 * Milling cutters, ordered small to large within each type.
 *
 * `cornerRadius` is what limits which internal corners a cutter can reach:
 * an endmill of diameter D leaves a D/2 radius in every inside corner, so the
 * planner's finishing choice is bounded by the smallest concave radius on the
 * part. `fluteLength` bounds the depth it can reach without the holder rubbing.
 */
export const MILL_TOOLS = [
  { id: 'em2', type: 'endmill', label: 'Endmill Ø2', diameter: 2, flutes: 2, fluteLength: 8, simType: 'flat' },
  { id: 'em3', type: 'endmill', label: 'Endmill Ø3', diameter: 3, flutes: 3, fluteLength: 12, simType: 'flat' },
  { id: 'em4', type: 'endmill', label: 'Endmill Ø4', diameter: 4, flutes: 3, fluteLength: 16, simType: 'flat' },
  { id: 'em6', type: 'endmill', label: 'Endmill Ø6', diameter: 6, flutes: 4, fluteLength: 22, simType: 'flat' },
  { id: 'em8', type: 'endmill', label: 'Endmill Ø8', diameter: 8, flutes: 4, fluteLength: 26, simType: 'flat' },
  { id: 'em10', type: 'endmill', label: 'Endmill Ø10', diameter: 10, flutes: 4, fluteLength: 30, simType: 'flat' },
  { id: 'em12', type: 'endmill', label: 'Endmill Ø12', diameter: 12, flutes: 4, fluteLength: 35, simType: 'flat' },
  { id: 'em16', type: 'endmill', label: 'Endmill Ø16', diameter: 16, flutes: 4, fluteLength: 40, simType: 'flat' },
  { id: 'em20', type: 'endmill', label: 'Endmill Ø20', diameter: 20, flutes: 4, fluteLength: 45, simType: 'flat' },
  { id: 'bn3', type: 'ballmill', label: 'Ball Ø3', diameter: 3, flutes: 2, fluteLength: 12, simType: 'ball' },
  { id: 'bn6', type: 'ballmill', label: 'Ball Ø6', diameter: 6, flutes: 2, fluteLength: 22, simType: 'ball' },
  { id: 'bn8', type: 'ballmill', label: 'Ball Ø8', diameter: 8, flutes: 2, fluteLength: 26, simType: 'ball' },
  { id: 'bn10', type: 'ballmill', label: 'Ball Ø10', diameter: 10, flutes: 2, fluteLength: 30, simType: 'ball' },
  { id: 'fm50', type: 'facemill', label: 'Facemill Ø50', diameter: 50, flutes: 5, fluteLength: 6, simType: 'flat' },
  { id: 'fm63', type: 'facemill', label: 'Facemill Ø63', diameter: 63, flutes: 6, fluteLength: 6, simType: 'flat' },
];

/** Twist drills, in the sizes a shop actually keeps on the shelf. */
export const DRILL_TOOLS = [
  1, 1.5, 2, 2.5, 3, 3.3, 4, 4.2, 5, 5.5, 6, 6.8, 7, 8, 8.5, 9, 10, 10.5,
  11, 12, 13, 14, 15, 16, 18, 20,
].map((d) => ({
  id: `dr${String(d).replace('.', '_')}`,
  type: 'drill',
  label: `Drill Ø${d}`,
  diameter: d,
  flutes: 2,
  fluteLength: d * 5,
  simType: 'flat',
}));

/**
 * Turning inserts.
 *
 * `noseRadius` is the parameter that actually changes the cut — it rounds every
 * corner of the finished profile and sets the floor on achievable surface
 * finish, which is why `sim/turning.js` treats it as first class too.
 * `maxDoc` is the depth of cut the insert geometry supports.
 */
export const TURN_TOOLS = [
  { id: 'cnmg-rough', type: 'turn-od', label: 'CNMG 120408 · OD roughing', holder: 'sclcr', noseRadius: 0.8, maxDoc: 4, lead: 95 },
  { id: 'dnmg-finish', type: 'turn-od', label: 'DNMG 110404 · OD finishing', holder: 'dclnr', noseRadius: 0.4, maxDoc: 1.5, lead: 95 },
  { id: 'vnmg-profile', type: 'turn-od', label: 'VNMG 160404 · OD profiling', holder: 'mvvnn', noseRadius: 0.4, maxDoc: 2, lead: 72.5 },
  { id: 'ccmt-bore', type: 'turn-id', label: 'CCMT 09T304 · boring bar Ø16', holder: 'boring', noseRadius: 0.4, maxDoc: 1.5, minBore: 18, lead: 93 },
  { id: 'ccmt-bore-sm', type: 'turn-id', label: 'CCMT 06T204 · boring bar Ø10', holder: 'boring', noseRadius: 0.2, maxDoc: 0.8, minBore: 12, lead: 93 },
  { id: 'groove-3', type: 'turn-groove', label: 'Grooving blade 3 mm', holder: 'parting', noseRadius: 0.2, width: 3, maxDoc: 6 },
  { id: 'groove-2', type: 'turn-groove', label: 'Grooving blade 2 mm', holder: 'parting', noseRadius: 0.2, width: 2, maxDoc: 4 },
  { id: 'part-3', type: 'turn-part', label: 'Parting blade 3 mm', holder: 'parting', noseRadius: 0.2, width: 3, maxDoc: 25 },
  { id: 'thread-ext', type: 'turn-thread', label: 'Threading insert 60° · external', holder: 'parting', noseRadius: 0.1, angle: 60 },
];

export const ALL_TOOLS = [...MILL_TOOLS, ...DRILL_TOOLS, ...TURN_TOOLS];

/** Look up any tool by id. Returns undefined for an unknown id. */
export function toolById(id) {
  return ALL_TOOLS.find((t) => t.id === id);
}

/**
 * The largest cutter of `type` that still fits a geometric limit.
 *
 * "Fits" means its corner radius clears the tightest inside corner it has to
 * reach, and its flute length covers the depth. Picking the largest is the
 * right default: a bigger tool is stiffer, cuts faster, and deflects less, so
 * the only reason to go smaller is that the geometry demands it.
 *
 * @param {string} type 'endmill' | 'ballmill' | 'facemill' | 'drill'
 * @param {{maxRadius?:number, maxDiameter?:number, depth?:number}} limits
 * @returns {object|null} the chosen tool, or null when nothing in the library fits
 */
export function largestToolFitting(type, limits = {}) {
  const { maxRadius = Infinity, maxDiameter = Infinity, depth = 0 } = limits;
  const candidates = ALL_TOOLS
    .filter((t) => t.type === type)
    .filter((t) => t.diameter / 2 <= maxRadius + 1e-9)
    .filter((t) => t.diameter <= maxDiameter + 1e-9)
    .filter((t) => t.fluteLength >= depth)
    .sort((a, b) => b.diameter - a.diameter);
  return candidates[0] || null;
}

/**
 * The drill whose diameter is closest to a measured hole, preferring one that
 * does not overcut.
 *
 * A hole measured off a faceted STL is always a little undersized (the polygon
 * is inscribed), so a drill slightly *under* the reading is the safe error —
 * material left can be bored out, material gone cannot be put back.
 */
export function drillForHole(diameter, tol = 0.25) {
  const under = DRILL_TOOLS.filter((d) => d.diameter <= diameter + tol)
    .sort((a, b) => b.diameter - a.diameter);
  return under[0] || null;
}
