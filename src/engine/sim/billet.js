/**
 * The billet, as an operator describes it: X × Y × Z, top face on Z0.
 *
 * The simulator used to take the blank as `top` / `base` / `margin` — the Z the
 * solid starts at, the Z it ends at, and how far it overhangs the toolpath in
 * XY. Those are the three numbers the *carver* wants, and none of them is a
 * number anyone has. What you have is a piece of material, and you know what
 * size it is, because you cut it off a bar or took it out of a rack: 100 × 60 ×
 * 20. Asking for T/B/M made the operator solve for the machine's variables
 * before they could describe their own stock, and getting the arithmetic wrong
 * silently produced a blank that either floated above the cut or swallowed it.
 *
 * So: **size** — three dimensions — and **origin** — where the block sits in
 * work coordinates. The origin is the block's **minimum corner**: the X−, Y−,
 * Z− face. Stock then spans `[origin, origin + size]` on each axis, which is
 * the one definition that never needs a diagram to disambiguate.
 *
 * Z0 on the top face is the **default**, not a rule. It is what setting up
 * usually does — touch the cutter off on the top of the blank, zero Z there,
 * and every depth in the program is measured down from it — so leaving the Z
 * origin blank puts the top on zero. But it is not the only way a job is ever
 * dialled in (a datum on the vice, on a fixture plate, or on a finished face
 * below the raw top are all real), and forcing it made those unrepresentable.
 * Type a Z origin and the block goes exactly where you put it.
 *
 * In X and Y a blank origin **centres the block on the toolpath**, because
 * there is no equivalent convention to lean on — X0/Y0 can be a corner, a
 * centre, or a bore, and the geometry cannot tell which. Centring on the
 * cutting is what `margin` effectively did before and is the answer that is
 * never badly wrong: a blank big enough for the job is a blank the job fits
 * inside.
 *
 * With no size given at all, an axis falls back to the original automatic fit
 * for that axis alone, so a program still simulates with nothing filled in.
 *
 * Pure functions over plain numbers. No stock grid, no three.js, no store.
 */

/** The centre of a bounds range on one axis. */
const mid = (lo, hi) => (lo + hi) / 2;

/** A dimension counts as given only when it is a real, positive number. */
const sizeGiven = (n) => Number.isFinite(n) && n > 0;
/** An origin counts as given at any finite value — including 0, and negatives. */
const originGiven = (n) => Number.isFinite(n);

/** Has the operator stated any dimension at all? */
export function anySized(size) {
  return ['x', 'y', 'z'].some((k) => sizeGiven(size?.[k]));
}

/**
 * The extent the blank should be fitted and centred against: **the cutting**.
 *
 * The full toolpath bounds are the wrong measure and were quietly being used.
 * A program that rapids out to X200 to clear the vice has bounds reaching X200,
 * so a stated 60 mm blank centred on them landed at X70…130 while the part
 * being cut sat at X0…20 — the blank beside the job rather than around it,
 * which looks exactly like a carve that removed the wrong material.
 *
 * The interpreter already separates the two (`feedMin`/`feedMax` are the feed
 * moves alone), so preferring them fixes every caller that hands over a parsed
 * bounds object. Callers that hold the segments themselves pass their own
 * cutting extent — see `cuttingBounds` in `removal.js`.
 */
export function cuttingExtent(bounds) {
  const finite = (a) => Array.isArray(a) && a.every(Number.isFinite);
  if (finite(bounds?.feedMin) && finite(bounds?.feedMax)) {
    return { min: bounds.feedMin, max: bounds.feedMax };
  }
  return bounds ?? null;
}

/**
 * Bounds to measure the automatic fit against — a zero box when there is no
 * program yet.
 *
 * Setting up the material comes **before** the program: you know what is in the
 * vice long before you know what will be cut out of it, and a blank that cannot
 * be described until a `.nc` is loaded is a blank you cannot set up against.
 * Requiring real bounds here is what stopped the stock being drawn at all on an
 * empty viewport — the geometry was right, and there was simply never anything
 * to hand it.
 *
 * A stated size does not consult these at all, so the fallback only matters for
 * the axes still on automatic, where a zero box degenerates to `±margin`
 * about the origin. That is the honest answer to "how big is the blank around a
 * toolpath that does not exist yet".
 */
function usableBounds(bounds) {
  const cut = cuttingExtent(bounds);
  const ok = cut?.min && cut?.max
    && cut.min.every(Number.isFinite) && cut.max.every(Number.isFinite);
  return ok ? cut : { min: [0, 0, 0], max: [0, 0, 0] };
}

/**
 * Work out the blank's box from the size and origin the operator gave, and the
 * toolpath it has to contain.
 *
 * @param {{min:number[], max:number[]}} bounds  toolpath extent
 * @param {{x?:number|null, y?:number|null, z?:number|null}} [size]
 *   billet dimensions in mm; null/undefined on an axis means "work it out"
 * @param {{margin?:number, origin?:object, defaultTopZ?:number,
 *   autoTop?:number, autoBase?:number}} [opts]
 *   margin — XY overhang used only where a size was not given
 *   origin — the block's minimum corner (X−, Y−, Z−) in work coordinates;
 *     blank on an axis centres it on the cutting (X/Y) or hangs it from
 *     `defaultTopZ` (Z)
 *   defaultTopZ — where the top face goes when the Z origin is blank (0: the
 *     usual touch-off, and now only a default)
 *   autoTop / autoBase — the Z the toolpath implies, used when `z` is unsized
 * @returns {{xMin:number, yMin:number, xMax:number, yMax:number,
 *   top:number, base:number, sized:object, placed:object}}
 */
export function billetBox(bounds, size = {}, opts = {}) {
  const { margin = 5, defaultTopZ = 0, autoTop, autoBase, origin = {} } = opts;
  const b = usableBounds(bounds);
  const [minx, miny, minz] = b.min;
  const [maxx, maxy, maxz] = b.max;

  const sized = {
    x: sizeGiven(size.x), y: sizeGiven(size.y), z: sizeGiven(size.z),
  };
  // An origin only means anything once that axis has a length to measure from.
  const placed = {
    x: sized.x && originGiven(origin.x),
    y: sized.y && originGiven(origin.y),
    z: sized.z && originGiven(origin.z),
  };

  /** Span one linear axis: placed → from the origin; sized → centred; else wrap. */
  const span = (isSized, isPlaced, length, at, centre, lo, hi) => {
    if (isPlaced) return [at, at + length];
    if (isSized) return [centre - length / 2, centre + length / 2];
    return [lo - margin, hi + margin];
  };

  const [xMin, xMax] = span(sized.x, placed.x, size.x, origin.x, mid(minx, maxx), minx, maxx);
  const [yMin, yMax] = span(sized.y, placed.y, size.y, origin.y, mid(miny, maxy), miny, maxy);

  // Z is the same shape of decision, only the *default* differs: with a
  // thickness but no origin, the top goes on Z0 — the touch-off nearly every
  // job uses. Stating a Z origin overrides it outright.
  let top;
  let base;
  if (placed.z) {
    base = origin.z;
    top = origin.z + size.z;
  } else if (sized.z) {
    top = defaultTopZ;
    base = defaultTopZ - size.z;
  } else {
    top = autoTop ?? maxz;
    base = autoBase ?? minz - 2;
  }

  return { xMin, yMin, xMax, yMax, top, base, sized, placed };
}

/**
 * Whether a stated billet actually contains the program, and what is wrong if
 * not.
 *
 * This is the check the T/B/M form could not make, because it had no idea what
 * the blank was — only where the carver should start and stop. Now that the
 * blank is stated, a program that reaches outside it is a fact worth putting on
 * screen *before* the sim runs and quietly clips: cutting air in the simulation
 * looks identical to cutting air on the machine, and only one of them is free.
 *
 * Z is measured downward from the top: a cut below `base` is deeper than the
 * material is thick. Cuts *above* Z0 are not flagged — that is the tool clear
 * of the work, which is where it spends most of the program.
 *
 * @returns {string[]} one line per problem, empty when the blank is big enough
 */
export function billetWarnings(box, bounds) {
  const out = [];
  const cut = usableBounds(bounds);
  const over = (label, cut, edge, dir) => {
    const by = dir > 0 ? cut - edge : edge - cut;
    if (by > 1e-6) out.push(`${label} by ${by.toFixed(2)} mm`);
  };
  over('The program cuts past the billet in +X', cut.max[0], box.xMax, 1);
  over('The program cuts past the billet in −X', cut.min[0], box.xMin, -1);
  over('The program cuts past the billet in +Y', cut.max[1], box.yMax, 1);
  over('The program cuts past the billet in −Y', cut.min[1], box.yMin, -1);
  over('The program cuts deeper than the billet is thick', cut.min[2], box.base, -1);
  return out;
}

/**
 * The billet the toolpath implies, for pre-filling the form.
 *
 * Offered rather than imposed: it is the size a blank would have to be to hold
 * this program with `margin` all round, rounded up to whole millimetres because
 * nobody stocks material to two decimal places. Z is measured from Z0 down to
 * the deepest cut, which is the thickness the setup actually needs — not the
 * thickness of whatever is in the rack.
 */
/**
 * The box as three ranges, for showing the operator where the blank ended up.
 *
 * The one thing a size-plus-origin form cannot convey on its own is *which*
 * corner the origin is, and no label solves that as well as printing the
 * resulting extents next to the fields. Once "X −10.0 … 70.0" is on screen
 * there is nothing left to misread.
 */
export function billetExtents(box) {
  if (!box) return null;
  return {
    x: [box.xMin, box.xMax],
    y: [box.yMin, box.yMax],
    z: [box.base, box.top],
  };
}

/**
 * The box as a centre and a size, for drawing it.
 *
 * An *uncut* billet is a box and nothing more, which is the whole reason the
 * viewport can show it the instant a number changes: there is no carving to do,
 * no worker to wake, no height field to triangulate. Pressing Simulate is what
 * turns this into a shape with material removed from it; until then the honest
 * picture is the blank itself, and it costs six numbers to draw.
 *
 * Returns null for a box that has no volume — a degenerate or infinite one from
 * a program with no moves in it. A zero-sized mesh renders as nothing anyway,
 * but an `Infinity` in a geometry argument takes the whole canvas down.
 */
export function billetSolid(box) {
  if (!box) return null;
  const sx = box.xMax - box.xMin;
  const sy = box.yMax - box.yMin;
  const sz = box.top - box.base;
  if (![sx, sy, sz].every((n) => Number.isFinite(n) && n > 1e-6)) return null;
  if (![box.xMin, box.yMin, box.base].every(Number.isFinite)) return null;
  return {
    center: [box.xMin + sx / 2, box.yMin + sy / 2, box.base + sz / 2],
    size: [sx, sy, sz],
  };
}

/**
 * The blank to draw in the viewport right now, or null when there is nothing
 * worth drawing.
 *
 * One function rather than a `billetBox` → `billetSolid` pair at the call site,
 * because the "is there anything to show?" rule is genuinely part of the answer
 * and does not survive being left in a component:
 *
 * - a **stated** size draws, program or no program — material is in the vice
 *   before the `.nc` exists;
 * - with a **program** and nothing stated, the automatic fit around the
 *   toolpath draws, so you can see the blank the sim would pick;
 * - with **neither**, nothing draws. A `±margin` box round the origin is not a
 *   billet, it is the absence of one, and putting a 10 mm cube on an empty
 *   viewport says something false.
 */
export function previewSolid(bounds, size = {}, opts = {}) {
  const cut = cuttingExtent(bounds);
  const known = cut?.min && cut?.max
    && cut.min.every(Number.isFinite) && cut.max.every(Number.isFinite);
  if (!known && !anySized(size)) return null;
  return billetSolid(billetBox(bounds, size, opts));
}

/**
 * A complete blank the program fits inside: size *and* where to put it.
 *
 * Suggesting a size without an origin is half an answer — it leaves the block
 * wherever the defaults happen to place it, which may still not contain the
 * cutting. This returns both, so filling the form from it is guaranteed to
 * clear every warning.
 */
export function suggestBillet(bounds, { margin = 5 } = {}) {
  const size = suggestBilletSize(bounds, { margin });
  if (!size) return null;
  const cut = cuttingExtent(bounds);
  const cx = mid(cut.min[0], cut.max[0]);
  const cy = mid(cut.min[1], cut.max[1]);
  return {
    size,
    // Minimum corner: centred on the cutting in X/Y, top on Z0 as usual.
    origin: {
      x: round2(cx - size.x / 2),
      y: round2(cy - size.y / 2),
      z: round2(-size.z),
    },
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

export function suggestBilletSize(bounds, { margin = 5 } = {}) {
  const cut = cuttingExtent(bounds);
  if (!cut?.min || !Number.isFinite(cut.min[0])) return null;
  const up = (n) => Math.max(1, Math.ceil(n - 1e-9));
  return {
    x: up(cut.max[0] - cut.min[0] + margin * 2),
    y: up(cut.max[1] - cut.min[1] + margin * 2),
    // Below Z0 only. A program that never goes below zero still needs a blank,
    // so this never suggests nothing.
    z: up(Math.max(-cut.min[2], 1)),
  };
}
