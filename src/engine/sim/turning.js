/**
 * Phase 1 — turning material-removal simulation (radial profile field).
 *
 * A lathe part is a solid of revolution, so the milling height field doesn't
 * fit: the stock is a spinning cylinder and the tool removes material in the ZX
 * plane. The natural analogue of the dexel here is a **radial** field — one
 * remaining-radius per Z slice. The insert sweeps the ZX profile, lowering the
 * radius wherever it passes, and the finished `radius[z]` curve is revolved back
 * into a shaded solid.
 *
 * Turn-mode segments are already [radius, 0, z] (the interpreter halves the
 * diameter X into a radius and works in G18/ZX), so a feed move is just a line
 * in the (r, z) plane. The tool's **nose radius** rounds the swept profile, the
 * one insert parameter that actually changes the cut, so it is a first-class
 * input here. Pure JS, no three / no DOM.
 *
 * `radius[z]` alone can only ever shrink from the outside, which is correct
 * for an OD pass but not for a drill, a boring bar or an internal thread: a
 * move that reaches a small X on the centreline has to leave an **annulus**
 * — the OD intact, a hole bored through the middle — not collapse the whole
 * slice down to that X. `bore[z]`, the second radial field added alongside
 * `turningCutModeResolver`, is exactly that second boundary: it only grows,
 * from the inside out, and only where a tool whose own type says it cuts the
 * ID is actually active. Without it, every drilled or bored feature in a
 * program read as the stock vanishing along the whole length of the cut —
 * which is what the radial field was already doing correctly for OD work,
 * applied to a move it had no way to tell apart from one.
 */
import { CUT, RAW } from './stockColors.js';

/**
 * The two standard OD toolholders drawn for the marker, taken from the catalogue
 * drawings (image_tool/): **MVJNR** at a 93° lead (its insert angle is
 * adjustable) and **MVVNN** at a 72.5° lead (a fixed VNMG 35° insert). `lead`
 * fixes the holder's approach angle; `angle` is the insert's included nose angle
 * (adjustable only when `adjustable`); the sim itself always cuts sharp.
 */
export const STANDARD_TURN_TOOLS = [
  // OD turning holders — a straight shank with an insert seated at the lead angle.
  { id: 'mvjnr', label: 'MVJNR · 93° OD (insert adj.)', kind: 'od', lead: 93, sides: 4, angle: 35, adjustable: true, tipOut: 1.8, flip: true },
  { id: 'mvvnn', label: 'MVVNN · 72.5° OD (VNMG 35°)', kind: 'od', lead: 72.5, sides: 4, angle: 35, adjustable: false, tipOut: 0 },
  { id: 'dclnr', label: 'DCLNR · 95° OD (DNMG 55°)', kind: 'od', lead: 95, sides: 4, angle: 55, adjustable: false, flip: true },
  { id: 'sclcr', label: 'SCLCR · 95° OD (CNMG 80°)', kind: 'od', lead: 95, sides: 4, angle: 80, adjustable: false, flip: true },
  // External threading tool — same holder geometry as an OD tool, but a
  // triangular full-profile insert (sides: 3) at the thread's own included
  // angle, not a diamond. `kind: 'od'` is deliberate: it mounts and marks up
  // exactly like an OD holder, just with a pointed insert — no new geometry
  // code is needed for it. Added alongside the G76 expansion (see
  // `interpreter.js`): before that, a threading pass had nowhere to point in
  // this list and no cutting motion to simulate either.
  //
  // `flip: false` here, unlike its three OD siblings above — not an
  // inconsistency. `odHolderGeometry`'s `t` is built from `lead + angle/2`
  // against a 90° pivot; every sibling's `lead + angle/2` lands *above* 90°
  // (104.5–135°), so their `flip: true` is what turns the holder away from
  // the chuck. This tool's lead is only 29.5° (a thread's V-point has no real
  // "lead angle" the way a turning insert does — this value was chosen to
  // orient the point, not copied off a catalogue approach angle), putting
  // `lead + angle/2` at 59.5° — *below* 90° — so the same `flip: true` pivots
  // it the other way and swings the holder body back toward the chuck
  // instead of away from it. `flip: false` is what keeps this tool's holder
  // on the same side of the tip (away from the chuck) as the other three —
  // verified against `odHolderGeometry()`'s own numbers: the outline's Z
  // span is [0, 13ish] for all four with this setting, not negative only for
  // this one.
  { id: 'threadtool', label: 'Threading tool · 60° V (external)', kind: 'od', lead: 29.5, sides: 3, angle: 60, adjustable: false, flip: false },
  // A boring bar reaching into the bore, insert cutting the ID (marker only —
  // the sim still carves an outer profile).
  // `insertTilt` is `boringBarGeometry`'s own shape field (see its header) —
  // dialled in by eye against the live render, not derived from anything
  // else on this row. The insert's Z placement itself is not a shape field
  // at all: `boringBarGeometry` always solves it so the insert sits flush
  // against the bar's own face, for whatever `insertTilt` ends up being.
  { id: 'boring', label: 'Boring bar · ID (insert adj.)', kind: 'boring', lead: 93, sides: 4, angle: 35, adjustable: true, insertTilt: -35 },
  // Internal threading bar — same reasoning as the external entry above, on
  // the boring-bar body instead of the OD holder.
  // `lead` is unused by `boringBarGeometry` (only `odHolderGeometry` reads
  // it) — carried anyway, same as the 'boring' entry above, because
  // `turning_check.mjs` asserts every catalogue entry has one, for the same
  // "one family of markers" reason it also requires `angle`/`sides`.
  // No `insertTilt` here — only `boring`'s insert was asked to tilt.
  { id: 'threadbar', label: 'Threading bar · 60° V (internal)', kind: 'boring', lead: 93, sides: 3, angle: 60, adjustable: false },
  // Axial tools — a centre/spot drill, twist drill, reamer or tap, held in
  // the tailstock or turret and cutting on the spindle centreline. These get
  // their own `kind: 'drill'` marker (`drillGeometry`/`DrillTool`), not the
  // boring bar's: a boring bar's shank is genuinely offset sideways to reach
  // into a bore from one side, which looks visibly wrong for a tool that is
  // actually coaxial with the spindle. `angle` here is a literal tool point
  // angle (a twist drill really is ~118°) — `drillGeometry` has no
  // singularity near 90° the way `odHolderGeometry` does (see the OD/boring
  // entries' angles, all kept under 90° for exactly that reason), so the
  // real angles are used directly.
  { id: 'centerdrill', label: 'Centre / spot drill', kind: 'drill', lead: 93, sides: 4, angle: 120, adjustable: false },
  { id: 'drillbit', label: 'Drill', kind: 'drill', lead: 93, sides: 4, angle: 118, adjustable: false },
  { id: 'reamerbit', label: 'Reamer', kind: 'drill', lead: 93, sides: 4, angle: 45, adjustable: false },
  { id: 'tapbit', label: 'Tap', kind: 'drill', lead: 93, sides: 4, angle: 60, adjustable: false },
  // A thin parting/grooving blade; `grooveW` is the cut width in mm.
  { id: 'parting', label: 'Parting / grooving blade', kind: 'parting', lead: 90, sides: 4, angle: 3, adjustable: false, grooveW: 3 },
];

/**
 * Auto-detected `gcode/tools.js` type -> the one holder it unambiguously
 * implies. 'od' is deliberately absent: an OD turning tool needs no special
 * case to land on the global default, because that default already IS an OD
 * holder. 'thread' resolves to the external tool unless the comment itself says
 * INTERNAL / ID, which `effectiveTurnTool` turns into the threading bar. 'chamfer' is
 * here, not missing: `gcode/tools.js` gives a centre/spot drill that same
 * type (it shares one mill-oriented category with an actual chamfer mill),
 * and on a lathe a "chamfer" comment is a centre drill far more often than
 * anything else.
 */
const TYPE_TO_INSERT = {
  bore: 'boring', parting: 'parting', thread: 'threadtool',
  drill: 'drillbit', reamer: 'reamerbit', tap: 'tapbit', chamfer: 'centerdrill',
};

/**
 * Which toolholder a lathe tool's marker — and its row in the Tool table —
 * should show: the operator's own pick for this tool number, else the one
 * the program's own comment unambiguously implies, else the global default
 * picker. Mirrors `cam/effectiveTool.js`'s precedence for milling cutters.
 *
 * Before this, `App.jsx` read only the operator's pick and the global
 * default (`ov.insert ?? turnTool`) — so a program's own `T0909(INTERNAL
 * THREAD BAR ..)` or `T1010(PARTING TOOL ..)`, however clearly worded, could
 * never move the marker off whatever the global picker held. Every tool in
 * the spindle looked like the same one holder, which reads exactly like a
 * picker that does nothing — `gcode/tools.js` already named the shape; only
 * the marker wasn't listening.
 *
 * @param {{detected?:object|null, overrideId?:string|null, fallbackId?:string, custom?:object[]}} args
 *   `detected` is a row of `stats.tools`; `overrideId` is
 *   `toolOverrides[n]?.insert`; `fallbackId` is the global `turnTool` pick;
 *   `custom` is `camStore.customTurnTools` — operator-defined holders, same
 *   shape as a `STANDARD_TURN_TOOLS` entry, searched alongside it so a picked
 *   or detected id can resolve to either. A dangling id (its custom tool was
 *   since deleted) falls through to the same `STANDARD_TURN_TOOLS[0]` default
 *   as any other unknown id — nothing has to scrub `turnTool`/`toolOverrides`
 *   when a custom tool is removed.
 */
export function effectiveTurnTool({
  detected, overrideId, fallbackId, custom = [],
}) {
  // A thread comment that says INTERNAL / ID is a boring-bar thread, the same words
  // `turningCutMode` reads; with neither it stays external (the common case).
  const internalThread = detected?.type === 'thread' && /INTERNAL|\bID\b/i.test(detected?.desc ?? '');
  const id = overrideId ?? (internalThread ? 'threadbar' : TYPE_TO_INSERT[detected?.type]) ?? fallbackId;
  const all = custom.length ? [...STANDARD_TURN_TOOLS, ...custom] : STANDARD_TURN_TOOLS;
  return all.find((t) => t.id === id) ?? STANDARD_TURN_TOOLS[0];
}

/**
 * Auto-detected type -> which radial boundary the tool's cuts grow or shrink
 * (see `carveTurningMove`'s `mode`). A boring bar, drill, reamer, tap or
 * centre drill all cut the ID, whatever their marker — this is a narrower
 * question than `TYPE_TO_INSERT` above, and answers it independently rather
 * than deriving it from the holder id, because a future holder added there
 * for cosmetic reasons only would otherwise silently start carving wrong.
 */
const ID_TYPES = new Set(['bore', 'drill', 'reamer', 'tap', 'chamfer']);

/**
 * 'od' (shrink the outer boundary, the existing behaviour) or 'id' (grow the
 * inner bore) for one detected tool row.
 *
 * 'thread' is the one type this can't read off `type` alone: the same
 * category covers an external and an internal threading pass, and nothing
 * about *threading* says which. It reads the tool's own description for the
 * word a comment names it with — the same ones `T0202(EXTERNAL THREAD TOOL)`
 * / `T0909(INTERNAL THREAD BAR)` already use — and falls back to 'od' when
 * neither is there: external is the far more common case, and 'od' is also
 * what every tool carved as before this distinction existed, so an
 * unrecognised thread comment degrades to the old behaviour rather than a
 * new, silent one.
 */
export function turningCutMode(detected) {
  const type = detected?.type;
  if (type === 'thread') {
    return /INTERNAL|\bID\b/i.test(detected?.desc ?? '') ? 'id' : 'od';
  }
  return ID_TYPES.has(type) ? 'id' : 'od';
}

/**
 * Per-tool `modeOf` resolver for `carveTurning` — same shape as
 * `turningNoseResolver`, built once from the detected tool table and then
 * looked up by `seg.tool` per move.
 * @param {object[]} [detectedTools] rows of `stats.tools`
 * @returns {(seg:object)=>'od'|'id'}
 */
export function turningCutModeResolver(detectedTools = []) {
  const byNum = new Map((detectedTools || []).map((t) => [t.n, turningCutMode(t)]));
  return (seg) => byNum.get(seg.tool) ?? 'od';
}

/**
 * Types whose bore is the tool's own diameter, not the path it is fed along.
 * A drill, reamer and tap are all driven straight down the spindle centreline
 * — the program's X is ~0 for the whole cut — and a centre/spot drill is the
 * same move, just shallow. The bore they cut is a property of the tool, read
 * once off its comment (`DRILL DIA 8.5 MM` → `tools.js`'s `diameterOf`), not
 * of where its tip happens to be. A boring bar is deliberately excluded: it
 * genuinely is fed along the bore's own profile, so its X is real and must
 * not be overridden.
 */
const FIXED_RADIUS_TYPES = new Set(['drill', 'reamer', 'tap', 'chamfer']);

/**
 * Per-tool fixed-bore-radius resolver, paired with `turningCutModeResolver`.
 * Returns 0 (no floor) for a tool whose radius isn't known or doesn't apply —
 * `carveTurningMove` then carves the segment's own X as before, so a program
 * with no diameter word in its comments, and no operator override, carves
 * exactly as it always has.
 * @param {object[]} [detectedTools] rows of `stats.tools`
 * @param {Object<number,{diameter?:number}>} [overrides] the Tool table's own
 *   `toolOverrides` — the operator's `⌀` beats the comment's, the same
 *   precedence `effectiveTool` uses for the marker, so the hole on screen and
 *   the hole actually cut never disagree.
 * @returns {(seg:object)=>number}
 */
export function turningCutRadiusResolver(detectedTools = [], overrides = {}) {
  const byNum = new Map();
  for (const t of (detectedTools || [])) {
    if (!FIXED_RADIUS_TYPES.has(t.type)) continue;
    const ov = (overrides && overrides[t.n]) || {};
    const diameter = ov.diameter ?? t.diameter ?? null;
    if (diameter > 0) byNum.set(t.n, diameter / 2);
  }
  return (seg) => byNum.get(seg.tool) ?? 0;
}

/**
 * Per-tool groove width for a parting/cut-off tool — paired with the
 * exact-zero-dz case in `carveTurningMove`. A blade is flat-faced and some
 * real width wide (3 mm by default, the Tool table's own "w" field —
 * `App.jsx`'s `grooveW`), not the one grid cell the move's own path states.
 * Without this the groove the operator sees on the marker read nothing like
 * the sliver actually carved.
 *
 * Only a tool resolved as 'parting' gets one: a facing pass run with an OD
 * tool is also a zero-dz move, and widening *that* would eat into material
 * on both sides of a plain facing cut that never asked to be a groove.
 * @param {object[]} [detectedTools] rows of `stats.tools`
 * @param {Object<number,{insert?:string,grooveW?:number}>} [overrides]
 * @returns {(seg:object)=>number} groove width in mm, 0 for anything else
 */
export function turningGrooveWidthResolver(detectedTools = [], overrides = {}) {
  const byNum = new Map();
  for (const t of (detectedTools || [])) {
    const ov = (overrides && overrides[t.n]) || {};
    if (t.type !== 'parting' && ov.insert !== 'parting') continue;
    byNum.set(t.n, Math.max(0, ov.grooveW ?? 3));
  }
  return (seg) => byNum.get(seg.tool) ?? 0;
}

/**
 * The Z of the facing cut — the finished +Z face of the part.
 *
 * A facing pass runs mostly radially (near-constant Z); everything on its +Z
 * side is scrap the operator faces (or parts) off. Without this the raw
 * bar's clearance end (a couple mm past Z0) survives as a stub sticking out
 * beyond the face. Returns null when the program never faces.
 *
 * Does **not** require the cut to reach near the centreline — a part with a
 * bore (drilled or bored by a separate tool) never gets OD-faced that close
 * to Ø0, so that requirement used to make this return null for any such
 * part, falling back to `bounds.feedMax` — which, for a G71 profile whose
 * own first point is a bare `N100 G0 X..` inheriting Z from before the
 * cycle, is itself a couple of mm past the true face (see `interpreter.js`'s
 * semi-finish-pass comment). Taking the *highest* Z among radial, feed-only
 * cuts is enough on its own: the true face, by construction, is the
 * outermost Z where the program does any facing-like cutting at all, found
 * or not near the axis.
 */
export function detectFaceZ(segments) {
  let faceZ = -Infinity;
  for (const s of segments || []) {
    if (s.type === 'rapid') continue;
    const dz = Math.abs(s.b[2] - s.a[2]);
    const dr = Math.abs(s.b[0] - s.a[0]);
    // dr's floor used to be 1mm (radius) — fine for a part faced down toward
    // Ø0, but a small part's *own* facing step can be smaller than that: this
    // file's own "turn up to main OD" move is exactly 1.0mm of radius (a 2mm
    // diameter step), and `> 1` excluded it by the width of a rounding error.
    // 0.3mm still clears any real corner blend/chamfer the dz ratio below
    // doesn't already rule out.
    if (dr > 0.3 && dz < dr * 0.25) {
      faceZ = Math.max(faceZ, s.a[2], s.b[2]);
    }
  }
  return Number.isFinite(faceZ) ? faceZ : null;
}

/**
 * Cylindrical stock over a Z range: one remaining outer radius per slice,
 * plus one inner bore radius (0 = solid, no hole yet) grown from the centre
 * out by ID-type tools — see `turningCutMode`.
 * @param {{min:number[],max:number[]}} bounds  turn-mode (radius,_,z) bounds
 * @param {number} [faceZ]  cap the +Z end here (the faced-off face)
 */
export function createTurningStock(
  bounds, { cellSize = 0.5, margin = 1, rStock, faceZ, chuckClear = 0 } = {},
) {
  const cs = cellSize;
  // End the billet at the faced face when the program faces off the end, so no
  // scrap stub survives past Z0; otherwise leave a small clearance.
  const zMax = faceZ != null ? faceZ : bounds.max[2] + margin;
  // Extend the −Z end by the chuck clearance so the raw bar reaches into the
  // chuck (held past the deepest cut); this section is never machined, so it
  // stays at the full bar radius.
  const zMinWanted = bounds.min[2] - Math.max(margin, chuckClear);
  const nz = Math.max(1, Math.ceil((zMax - zMinWanted) / cs));
  // Align the grid so its **+Z edge lands exactly on zMax**, taking up the
  // rounding at the −Z end (which is buried in the chuck). Otherwise the last
  // cell straddles the faced face: the billet pokes past it, and the facing
  // move — a purely axial cut this radial field cannot represent — lands inside
  // that cell and collapses it to r=0, so the face reads as a cone, not flat.
  const zMin = zMax - nz * cs;
  // Raw bar radius: the widest the tool reaches (the OD it starts from), unless
  // the caller pins it. Clamp to a sane minimum so a degenerate program still
  // shows a billet.
  const r0 = rStock ?? Math.max(bounds.max[0], 0.5);
  const radius = new Float32Array(nz).fill(r0);
  const bore = new Float32Array(nz); // 0 everywhere: solid bar, no hole yet
  return { zMin, zMax, cs, nz, radius, bore, rStock: r0 };
}

/** Reset a turning stock to the solid bar (for scrubbing back). */
export function resetTurningStock(stock) {
  stock.radius.fill(stock.rStock);
  stock.bore.fill(0);
}

function zCell(stock, z) {
  return Math.floor((z - stock.zMin) / stock.cs);
}

/**
 * Apply one radius reading at slice `k` in the given mode: 'od' shrinks the
 * outer boundary (never below the bore already cut, so an OD pass can't cut
 * through into a hole from outside), 'id' grows the inner one (never past
 * the OD still standing there, so a bore can't exceed the material it's in).
 * Returns the radius actually removed, for the volume tally.
 */
function applyRadius(stock, k, r, mode) {
  if (mode === 'id') {
    const grown = Math.min(Math.max(0, r), stock.radius[k]);
    if (grown > stock.bore[k]) {
      const d = grown - stock.bore[k];
      stock.bore[k] = grown;
      return d;
    }
    return 0;
  }
  const shrunk = Math.max(0, r, stock.bore[k]);
  if (shrunk < stock.radius[k]) {
    const d = stock.radius[k] - shrunk;
    stock.radius[k] = shrunk;
    return d;
  }
  return 0;
}

/** Stamp the round nose at profile point (r, z): lower each slice it reaches. */
function stampTurning(stock, r, z, noseR, mode) {
  const rr = Math.max(0, r);
  let removed = 0;
  // A cut at (or past) the faced face is the facing pass itself. The billet is
  // already truncated there, so stamping it would only eat into the last slice
  // and round the face off. Belt-and-braces with the grid alignment above, which
  // puts zMax on a cell edge — this also absorbs floating-point drift.
  if (stock.zMax != null && z >= stock.zMax - 1e-9) return removed;
  if (noseR <= 0) {
    const k = zCell(stock, z);
    if (k >= 0 && k < stock.nz) removed += applyRadius(stock, k, rr, mode);
    return removed;
  }
  const k0 = Math.max(0, zCell(stock, z - noseR));
  const k1 = Math.min(stock.nz - 1, zCell(stock, z + noseR));
  for (let k = k0; k <= k1; k++) {
    const dz = stock.zMin + (k + 0.5) * stock.cs - z;
    if (Math.abs(dz) > noseR) continue;
    // Nose surface: a circle of radius noseR whose lowest point is the tip.
    // An 'id' nose reaches *less* far at the edges than at the tip (the same
    // roundover, mirrored inward), which is the sign flip from the 'od' case.
    const surf = mode === 'id'
      ? Math.max(0, rr - noseR + Math.sqrt(noseR * noseR - dz * dz))
      : Math.max(0, rr + noseR - Math.sqrt(noseR * noseR - dz * dz));
    removed += applyRadius(stock, k, surf, mode);
  }
  return removed;
}

/**
 * Sweep one feed move a→b (points are [radius,_,z]) with the insert.
 * @param {'od'|'id'} [mode] which boundary this move carves — 'od' (default,
 *   the existing behaviour) shrinks the outer radius; 'id' grows the inner
 *   bore instead, for a drill, boring bar, reamer, tap or internal thread —
 *   see `turningCutMode`. Only the destination boundary differs; the sweep
 *   geometry below is identical either way.
 * @param {number} [minRadius] floor for an 'id' move's radius — a drill fed
 *   down the centreline programs X~0, which is not the hole it cuts; see
 *   `turningCutRadiusResolver`. No effect in 'od' mode or when 0/omitted.
 * @param {number} [grooveWidth] how wide a pure-radial (exact-zero-dz) move
 *   carves, for a parting/cut-off blade — see `turningGrooveWidthResolver`.
 *   0/omitted carves the one cell nearest the move, same as before this
 *   existed. No effect on a move that has any real Z extent of its own.
 */
export function carveTurningMove(stock, a, b, noseR, mode = 'od', minRadius = 0, grooveWidth = 0) {
  const ra = mode === 'id' ? Math.max(a[0], minRadius) : a[0];
  const rb = mode === 'id' ? Math.max(b[0], minRadius) : b[0];
  const za = a[2];
  const zb = b[2];

  if (noseR > 0) {
    // Round nose: sweep-sample and spread the nose over neighbouring slices.
    const dr = rb - ra;
    const dz = zb - za;
    const len = Math.hypot(dr, dz);
    const step = Math.max(stock.cs * 0.5, 1e-6);
    const n = Math.max(1, Math.ceil(len / step));
    let removed = 0;
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      removed += stampTurning(stock, ra + dr * t, za + dz * t, noseR, mode);
    }
    return removed;
  }

  // Sharp corner: the exact lower envelope. A slice is cut only where the move
  // actually **crosses its centre**, and it takes the segment's radius there, so
  // the profile follows the programmed path.
  //
  // A move that stops short of a centre carves nothing. That matters on curves:
  // near the pole of an R or a spherical end the chords are very short in Z, and
  // treating them as facing cuts — collapsing the whole cell to their smallest
  // radius — punched a notch into the surface where the part is actually solid.
  const dz = zb - za;
  // A pure radial move — a facing pass, or a parting/cut-off stroke — has no
  // Z extent at all: the program gave no Z word, so `za` and `zb` are the
  // same stored number, bit for bit. zLo/zHi below would then be a
  // zero-width range that can never contain a slice centre, and the loop
  // would carve nothing — which is exactly the "cut-off does nothing"
  // symptom. A tessellated curve's short chord is not the same thing: it
  // always has *some* real, if tiny, dz from the trig that built it, so this
  // only fires for a move that is genuinely, exactly radial.
  //
  // At the true faced end this is deliberately still a no-op (the same guard
  // `stampTurning` carries): the face comes from the billet being truncated
  // there, not from this move, and carving the last slice anyway collapsed it
  // to the move's own smallest radius — a cone instead of a flat end.
  if (dz === 0) {
    if (stock.zMax != null && za >= stock.zMax - 1e-9) return 0;
    // The whole sweep lands at one Z, so only the extreme it reaches matters:
    // the smallest radius for an 'od' move (it cuts inward), the largest for
    // an 'id' one (it grows the bore outward) — the same across every slice
    // the blade's width spans, since its cutting edge is flat.
    const extreme = Math.max(0, mode === 'id' ? Math.max(ra, rb) : Math.min(ra, rb));
    // Edge-referenced, not centred: a real tool offset is touched off to ONE
    // point on the insert, so the programmed Z sits flush against the
    // material being kept and the kerf lands entirely on the far (scrap/
    // chuck) side of it — the same side a facing move's own billet
    // truncation already treats as +Z. Centring it here used to eat half
    // the blade width into the already-turned good length (a part
    // programmed to come out 30.5mm read as 29.5mm for a 2mm blade).
    const zLo = za - Math.max(0, grooveWidth);
    const k0 = Math.max(0, Math.ceil((zLo - stock.zMin) / stock.cs - 0.5));
    const k1 = Math.min(stock.nz - 1, Math.floor((za - stock.zMin) / stock.cs - 0.5));
    let removed = 0;
    if (k1 >= k0) {
      for (let k = k0; k <= k1; k++) removed += applyRadius(stock, k, extreme, mode);
    } else {
      // No slice centre falls even in the widened range (a groove narrower
      // than one cell, or none given at all) — fall back to the one nearest.
      const k = Math.max(0, Math.min(stock.nz - 1, zCell(stock, za)));
      removed += applyRadius(stock, k, extreme, mode);
    }
    return removed;
  }
  const zLo = Math.min(za, zb);
  const zHi = Math.max(za, zb);
  // Slice centres sit at zMin + (k + 0.5)·cs, so the first centre at or above zLo
  // is k = ceil((zLo − zMin)/cs − 0.5).
  const k0 = Math.max(0, Math.ceil((zLo - stock.zMin) / stock.cs - 0.5));
  const k1 = Math.min(stock.nz - 1, Math.floor((zHi - stock.zMin) / stock.cs - 0.5));
  let removed = 0;
  for (let k = k0; k <= k1; k++) {
    const zc = stock.zMin + (k + 0.5) * stock.cs;
    const t = Math.abs(dz) < 1e-12 ? 0 : Math.max(0, Math.min(1, (zc - za) / dz));
    const r = Math.max(0, ra + (rb - ra) * t);
    removed += applyRadius(stock, k, r, mode);
  }
  return removed;
}

/**
 * Per-tool nose-radius resolver: the user's override for a tool number wins,
 * else the global default. Lets a two-tool lathe program (a roughing insert then
 * a finishing insert) carve each pass with its own nose radius.
 * @param {Object<number,{noseR?:number}>} [overrides]
 * @returns {(seg:object)=>number}
 */
export function turningNoseResolver(defaultNose, overrides = {}) {
  const byNum = new Map(
    Object.entries(overrides || {})
      .filter(([, o]) => o && o.noseR != null)
      .map(([n, o]) => [Number(n), Math.max(0, o.noseR)]),
  );
  const base = Math.max(0, defaultNose ?? 0);
  return (seg) => (byNum.has(seg.tool) ? byNum.get(seg.tool) : base);
}

/**
 * Carve every feed move into the radial field.
 * @param {{noseR:number} | ((seg:object)=>number)} tool  one nose radius for all
 *   moves, or a resolver returning the nose radius for a given segment.
 * @param {(seg:object)=>('od'|'id')} [modeOf] which boundary each move
 *   carves — defaults to every move being 'od', the field's original,
 *   OD-only behaviour, so a caller that never passes this still carves
 *   exactly as before. `turningCutModeResolver` builds the real one.
 * @param {(seg:object)=>number} [radiusOf] fixed-bore radius floor for an
 *   'id' move (see `carveTurningMove`'s `minRadius`) — defaults to 0 (no
 *   floor). `turningCutRadiusResolver` builds the real one.
 * @param {(seg:object)=>number} [grooveOf] groove width for a parting/cut-off
 *   move (see `carveTurningMove`'s `grooveWidth`) — defaults to 0 (the one
 *   nearest cell). `turningGrooveWidthResolver` builds the real one.
 */
export function carveTurning(stock, segments, tool, modeOf, radiusOf, grooveOf) {
  const noseOf = typeof tool === 'function' ? tool : () => Math.max(0, tool.noseR ?? 0);
  const modeFn = typeof modeOf === 'function' ? modeOf : () => 'od';
  const radiusFn = typeof radiusOf === 'function' ? radiusOf : () => 0;
  const grooveFn = typeof grooveOf === 'function' ? grooveOf : () => 0;
  let dropped = 0; // sum of radius reductions (for a rough removed-volume proxy)
  for (const s of segments) {
    if (s.type === 'rapid') continue;
    dropped += carveTurningMove(stock, s.a, s.b, noseOf(s), modeFn(s), radiusFn(s), grooveFn(s));
  }
  // Proper removed volume: π·(r0² − router² + rinner²) summed over slices —
  // the stock between router and rinner (the annulus) is what's left, so
  // subtracting it from the solid billet counts the bore as removed too.
  let removed = 0;
  for (let k = 0; k < stock.nz; k++) {
    const router = stock.radius[k];
    const rinner = stock.bore[k];
    removed += Math.PI * (stock.rStock * stock.rStock - router * router + rinner * rinner) * stock.cs;
  }
  return { removedVolume: removed, dropped };
}

/**
 * Revolve the radius profile into a shaded solid of revolution around the Z
 * (spindle) axis. Returns transferable typed arrays **including exact normals**
 * — a revolve's normals are known analytically, and letting the renderer average
 * face normals instead made the barrel read as a ring of flat facets.
 * @param {number} sides  angular divisions of the revolve
 * @param {number} [creaseDeg]  profile turns sharper than this keep a hard edge
 * @param {number} [simplifyTol]  mm the meshed profile may deviate from the field
 */
/**
 * Douglas–Peucker on the (z, r) profile: drop stations the surface does not need,
 * keeping every point within `tol` of the simplified polyline. The ends are
 * always kept. Pure; exported for testing.
 */
export function simplifyProfile(pts, tol) {
  if (!(tol > 0) || pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const a = pts[lo];
    const b = pts[hi];
    const dz = b.z - a.z;
    const dr = b.r - a.r;
    const len = Math.hypot(dz, dr);
    let worst = -1;
    let worstAt = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = pts[i];
      // Perpendicular distance to the chord (degenerate chord → point distance).
      const d = len < 1e-12
        ? Math.hypot(p.z - a.z, p.r - a.r)
        : Math.abs(dr * (p.z - a.z) - dz * (p.r - a.r)) / len;
      if (d > worst) { worst = d; worstAt = i; }
    }
    if (worst > tol) {
      keep[worstAt] = 1;
      stack.push([lo, worstAt], [worstAt, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

export function turningMesh(stock, sides = 96, { creaseDeg = 25, simplifyTol = 0.01 } = {}) {
  const { zMin, cs, nz, radius, rStock } = stock;
  const positions = [];
  const normals = [];
  const indices = [];
  const colors = [];
  // Machined (cut) surfaces read as bright steel; raw bar (never turned, still
  // at the stock radius) reads as amber. Shared with the milling models, so all
  // three tell cut from raw the same way — see `stockColors.js`.
  const colOf = (k) => (radius[k] < rStock - 0.02 ? CUT : RAW);
  const rOf = (k) => Math.max(radius[k], 0);

  // Profile stations: the slice centres, **plus the billet's two true ends**.
  // Capping at the outermost slice centres instead would leave the part half a
  // cell short of the faced face, so a faced end would sit shy of where the tool
  // actually left it. The end stations repeat their neighbour's radius, making
  // the first and last bands cylindrical.
  const zMaxEdge = stock.zMax ?? zMin + nz * cs;
  const full = [];
  full.push({ z: zMin, r: rOf(0), col: colOf(0) });
  for (let k = 0; k < nz; k++) full.push({ z: zMin + (k + 0.5) * cs, r: rOf(k), col: colOf(k) });
  full.push({ z: zMaxEdge, r: rOf(nz - 1), col: colOf(nz - 1) });

  // Curved features (an R, a spherical end) need a *fine* radial field to be
  // accurate — near a vertical tangent the radius swings right across one slice —
  // but a fine field would also mean a ring per slice and a huge mesh. So the
  // profile is simplified to `simplifyTol` first: the field stays dense, while
  // long straight runs collapse to a couple of rings and rings are spent where
  // the profile actually curves.
  const st = simplifyProfile(full, simplifyTol);
  const ns = st.length;

  // Normals are computed here rather than left to the renderer's face averaging,
  // because we know the exact surface: a solid of revolution. Each band between
  // two rings is a frustum whose normal in the (radial, z) plane is perpendicular
  // to the profile, and revolving that gives an exact normal at every vertex —
  // so the barrel shades as a true cylinder instead of a ring of facets.
  const band = [];
  for (let k = 0; k < ns - 1; k++) {
    const dr = st[k + 1].r - st[k].r;
    const dz = st[k + 1].z - st[k].z;
    const len = Math.hypot(dz, dr) || 1;
    band.push({ nr: dz / len, nz: -dr / len });
  }

  // One ring of vertices at station `k`, carrying the profile normal `n`.
  let vcount = 0;
  const pushRing = (k, n, col) => {
    const base = vcount;
    const { z, r } = st[k];
    const c = col ?? st[k].col;
    for (let a = 0; a < sides; a++) {
      const th = (a / sides) * Math.PI * 2;
      const ca = Math.cos(th);
      const sa = Math.sin(th);
      positions.push(r * ca, r * sa, z);
      normals.push(n.nr * ca, n.nr * sa, n.nz);
      colors.push(c[0], c[1], c[2]);
    }
    vcount += sides;
    return base;
  };

  // Where two bands meet gently the ring is shared and its normal averaged, so
  // the surface reads as one continuous curve. Where they meet at a real corner
  // — a shoulder, the faced end — the ring is emitted twice, once per band, so
  // the edge stays crisp instead of being smeared round.
  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
  const bandStart = new Array(Math.max(0, ns - 1));
  const bandEnd = new Array(Math.max(0, ns - 1));
  for (let k = 0; k < ns; k++) {
    const left = k > 0 ? band[k - 1] : null;
    const right = k < ns - 1 ? band[k] : null;
    if (left && right) {
      if (left.nr * right.nr + left.nz * right.nz >= cosCrease) {
        const nr = left.nr + right.nr;
        const nzz = left.nz + right.nz;
        const l = Math.hypot(nr, nzz) || 1;
        const base = pushRing(k, { nr: nr / l, nz: nzz / l });
        bandEnd[k - 1] = base;
        bandStart[k] = base;
      } else {
        bandEnd[k - 1] = pushRing(k, left);
        bandStart[k] = pushRing(k, right);
      }
    } else if (right) {
      bandStart[k] = pushRing(k, right);
    } else if (left) {
      bandEnd[k - 1] = pushRing(k, left);
    } else {
      pushRing(k, { nr: 1, nz: 0 }); // single-slice stock: a bare disc
    }
  }

  // Side wall quads, each band between its own start/end ring copies. Wound so
  // the faces agree with the outward normals above — the old winding was inward
  // and only went unnoticed because the material draws both sides.
  for (let k = 0; k < ns - 1; k++) {
    const b = bandStart[k];
    const n = bandEnd[k];
    for (let a = 0; a < sides; a++) {
      const a2 = (a + 1) % sides;
      indices.push(b + a, n + a2, n + a, b + a, b + a2, n + a2);
    }
  }

  // End caps. Usually a centre vertex fanned to a dedicated rim ring facing
  // along the axis, so the cap stays flat and its edge sharp — but where a
  // bore reaches this end (a through-hole, or a counterbore open to the
  // face), there is no material at the centre to fan to, so the cap is an
  // annulus instead: an inner rim at the bore radius, facing the *same*
  // direction as the outer rim, with the fan fan replaced by a quad ring
  // between the two. The −Z cap is the raw bar end (into the chuck); the +Z
  // cap is the faced (cut) face.
  const cap = (k, dir, col, boreR) => {
    const rim = pushRing(k, { nr: 0, nz: dir }, col);
    if (boreR > 1e-6) {
      const inner = vcount;
      const { z } = st[k];
      for (let a = 0; a < sides; a++) {
        const th = (a / sides) * Math.PI * 2;
        positions.push(boreR * Math.cos(th), boreR * Math.sin(th), z);
        normals.push(0, 0, dir);
        colors.push(col[0], col[1], col[2]);
      }
      vcount += sides;
      for (let a = 0; a < sides; a++) {
        const a2 = (a + 1) % sides;
        if (dir < 0) indices.push(rim + a, rim + a2, inner + a, inner + a, rim + a2, inner + a2);
        else indices.push(rim + a, inner + a, rim + a2, rim + a2, inner + a, inner + a2);
      }
      return;
    }
    const centre = vcount;
    positions.push(0, 0, st[k].z);
    normals.push(0, 0, dir);
    colors.push(col[0], col[1], col[2]);
    vcount += 1;
    for (let a = 0; a < sides; a++) {
      const a2 = (a + 1) % sides;
      if (dir < 0) indices.push(centre, rim + a2, rim + a);
      else indices.push(centre, rim + a, rim + a2);
    }
  };
  cap(0, -1, RAW, stock.bore[0]);          // the raw bar end, inside the chuck
  cap(ns - 1, 1, CUT, stock.bore[nz - 1]); // the faced face, at the billet's +Z edge

  // The bore: wherever it's grown above 0, a hole has been cut through the
  // middle of what the outer-profile mesh above still draws as solid. Each
  // contiguous run of slices gets an inward-facing wall (independent flat
  // bands, not crease-smoothed like the outer wall — this is a secondary
  // surface and a plain faceted one is a fair trade for not duplicating that
  // machinery) plus a floor wherever the run stops *short* of a true end —
  // a blind hole's bottom. A run that reaches a true end needs no floor: the
  // annular cap just added above already closes it there.
  const boreCol = CUT; // a bored/drilled surface is by definition cut, never raw
  let k = 0;
  while (k < nz) {
    if (!(stock.bore[k] > 1e-6)) { k += 1; continue; }
    let k1 = k;
    while (k1 + 1 < nz && stock.bore[k1 + 1] > 1e-6) k1 += 1;
    const atStart = k === 0;
    const atEnd = k1 === nz - 1;
    // Inner profile for this run, extended to the true edges exactly like the
    // outer one is, so the wall meets the annular cap edge-on with no gap.
    const stations = [];
    stations.push({ z: atStart ? zMin : zMin + (k + 0.5) * cs, r: stock.bore[k] });
    for (let i = k + 1; i <= k1; i++) stations.push({ z: zMin + (i + 0.5) * cs, r: stock.bore[i] });
    if (atEnd) stations.push({ z: zMaxEdge, r: stock.bore[k1] });
    // A single isolated cell touching neither edge is one station so far — the
    // wall loop below needs at least two to have a band to build, so widen it
    // to the cell's own width rather than leaving a point-sized hole.
    if (stations.length === 1) {
      const z0 = stations[0].z;
      stations[0] = { z: z0 - cs / 2, r: stations[0].r };
      stations.push({ z: z0 + cs / 2, r: stock.bore[k] });
    }

    const pushBoreRing = (z, r, n) => {
      const base = vcount;
      for (let a = 0; a < sides; a++) {
        const th = (a / sides) * Math.PI * 2;
        const ca = Math.cos(th);
        const sa = Math.sin(th);
        positions.push(r * ca, r * sa, z);
        normals.push(n.nr * ca, n.nr * sa, n.nz);
        colors.push(boreCol[0], boreCol[1], boreCol[2]);
      }
      vcount += sides;
      return base;
    };

    for (let i = 0; i < stations.length - 1; i++) {
      const a0 = stations[i];
      const a1 = stations[i + 1];
      const dr = a1.r - a0.r;
      const dz = a1.z - a0.z;
      const len = Math.hypot(dz, dr) || 1;
      // Mirror of the outer band normal: material sits *outside* a bore wall
      // rather than inside it, so the surface faces inward, not outward.
      const n = { nr: -dz / len, nz: dr / len };
      const r0v = pushBoreRing(a0.z, a0.r, n);
      const r1v = pushBoreRing(a1.z, a1.r, n);
      for (let a = 0; a < sides; a++) {
        const a2 = (a + 1) % sides;
        // Reversed winding from the outer wall's, to match the flipped normal.
        indices.push(r0v + a, r0v + a2, r1v + a, r1v + a, r0v + a2, r1v + a2);
      }
    }

    // Floor(s): close the run wherever it does *not* reach a true end — the
    // bottom of a blind hole, facing back the way the tool came from.
    if (!atStart) {
      const z0 = stations[0].z;
      const r0v = pushBoreRing(z0, stations[0].r, { nr: 0, nz: -1 });
      const centre = vcount;
      positions.push(0, 0, z0);
      normals.push(0, 0, -1);
      colors.push(boreCol[0], boreCol[1], boreCol[2]);
      vcount += 1;
      for (let a = 0; a < sides; a++) {
        const a2 = (a + 1) % sides;
        indices.push(centre, r0v + a, r0v + a2);
      }
    }
    if (!atEnd) {
      const zN = stations[stations.length - 1].z;
      const rN = stations[stations.length - 1].r;
      const rNv = pushBoreRing(zN, rN, { nr: 0, nz: 1 });
      const centre = vcount;
      positions.push(0, 0, zN);
      normals.push(0, 0, 1);
      colors.push(boreCol[0], boreCol[1], boreCol[2]);
      vcount += 1;
      for (let a = 0; a < sides; a++) {
        const a2 = (a + 1) % sides;
        indices.push(centre, rNv + a2, rNv + a);
      }
    }

    k = k1 + 1;
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    colors: new Float32Array(colors),
    rings: nz,
  };
}
