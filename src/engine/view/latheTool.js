/**
 * Lathe tool-marker geometry — the numbers behind the OD holder, boring bar and
 * parting blade, separated from the meshes that draw them.
 *
 * Turning cuts in the plane through the spindle axis (Y = 0), so **every marker's
 * cutting corner sits at Y = 0 with the body hanging below it**: the insert's
 * rake face is the top. Getting that wrong is invisible in a screenshot but
 * obvious in a number, which is why it lives here — the insert was once mounted
 * on the holder's side face and floated 1–5 mm clear of the plane it cuts in.
 *
 * ## Why the insert stands proud (`standout`)
 *
 * The insert used to sit exactly flush in its seat: its rake face on Y = 0 and
 * the holder's top face on Y = 0 as well, and the head's bevelled walls lying
 * *along* the insert's own two edges. Every one of those is a pair of
 * **coplanar** faces, and a depth buffer cannot order two surfaces at the same
 * depth — so the insert and the holder took turns winning, pixel by pixel, and
 * the tool flickered between gold and grey as the view moved. It reads as a
 * rendering fault, which it is, and no amount of re-colouring fixes it.
 *
 * A real insert is not flush either: it stands out of its pocket, which is what
 * lets it cut. So the *body* is dropped `standout` below the cutting plane and
 * recessed the same amount radially behind the insert's corner. The insert keeps
 * Y = 0 — the invariant above is untouched, and it is the insert that cuts.
 */

const DEG = Math.PI / 180;

/**
 * Shared sizes, from the marker radius the viewport passes in.
 *
 * `standout` is how far the insert stands out of its seat — small enough to look
 * like a seated insert, large enough that no viewing angle brings the two
 * surfaces within the depth buffer's resolution.
 */
export function toolScale(radius) {
  const s = Math.max(radius * 7, 6);
  const thickY = Math.max(radius * 2.4, 1.8);
  return { s, thickY, standout: thickY * 0.16 };
}

/**
 * OD turning holder. Returns the extruded silhouette (in the X-Z profile plane,
 * tip at the origin), the depth it hangs down −Y, and where the insert and its
 * clamp screw sit.
 *
 * The insert sits at the lead angle: its long diagonal is rotated `t` from
 * vertical (`t` = lead + angle/2 − 90, mirrored by `flip`). The shank stays
 * vertical; only its head is bevelled to the insert's two edges, so the tip juts
 * past the shank's front face on its own.
 */
export function odHolderGeometry(radius = 0.8, shape = {}) {
  const { s, thickY, standout } = toolScale(radius);
  const sides = shape.sides ?? 4;
  const angle = shape.angle ?? 35;
  const lead = shape.lead ?? 93;
  const flip = !!shape.flip;
  const r = s * 0.62;
  // tan(angle/2) is the insert's own half-nose-angle ratio — true of a pointed
  // diamond (sides: 4) exactly as much as a pointed V (sides: 3, the threading
  // tool/bar): both are a corner with two flanks at `angle` to each other. The
  // old `sides === 4` gate left every non-diamond insert at a hard-coded 1 —
  // for a 60°-V threading tool that is ~1.7× its real tan(30°) ≈ 0.577 — which
  // swung the holder's `shift` (below) the wrong way in Z on a flipped holder,
  // pointing the shank back toward the chuck instead of away from it.
  const zScale = Math.max(Math.tan((angle / 2) * DEG), 0.2);
  const depth = thickY * 1.5;

  const sgn = flip ? -1 : 1;
  const t = sgn * ((lead + angle / 2) * DEG - Math.PI / 2);
  const ct = Math.cos(t);
  const st = Math.sin(t);
  const insert = { x: r * ct, z: -r * st, rot: t, r, thickY, zScale, sides };

  // Ratios of Z gained per unit up the shank along the insert's trailing (+Z)
  // and leading (−Z) edges; the head bevels follow them.
  const eX = ct + zScale * st;
  const eZ = zScale * ct - st;
  const fX = ct - zScale * st;
  const fZ = -zScale * ct - st;
  const ratioBack = Math.abs(eX) > 1e-4 ? eZ / eX : 0;
  const ratioFront = Math.abs(fX) > 1e-4 ? fZ / fX : 0;
  const span = Math.max(ratioBack - ratioFront, 0.2);

  const W = s * 1.1;
  const topX = s * 5.0;          // fixed holder height, same for every insert
  const Xbot = W / span;         // head height → shank width stays W across angles
  const shift = flip ? Math.max(0, r * fZ - Xbot * ratioFront) : 0;
  const Zf = Xbot * ratioFront + shift;
  const Zb = Xbot * ratioBack + shift;

  return {
    depth,
    // Silhouette in (x = radial, y = along Z), apex first. The whole wedge is
    // pushed `standout` radially outward, so its walls run parallel to the
    // insert's two edges but a hair behind them and its apex stops short of the
    // cutting corner — the insert's corner is the tip of the tool, on its own.
    outline: [
      [standout, 0], [Xbot + standout, Zf], [topX, Zf], [topX, Zb], [Xbot + standout, Zb],
    ],
    insert,
    // Y placement: the insert's rake face is the cutting plane, and the body it
    // is seated in hangs from `standout` below that face down to `bodyY - depth`.
    insertY: -thickY / 2,
    bodyY: -standout,
    standout,
    screwY: 0,
    screwR: s * 0.16,
    screwH: thickY * 0.4,
    shankWidth: W,
    height: topX,
  };
}

/**
 * Boring bar: a round shank along +Z with a small insert at the tip.
 *
 * The insert's own `x`/`z` are computed here, not left for `Viewport.jsx` to
 * place inline the way an earlier version of this did — the file's own
 * header says every number lives here *because* it's tested, and an inline
 * position in the component is exactly the untested exception that slips
 * past that. It mattered in practice: the insert is a `sides`-gon rotated
 * 45° about its own axis (so a square insert reads as a diamond), and its
 * reach toward the bar is `r·cos(45°)`.
 *
 * Two generations of this bug, both from the same root cause: nothing here
 * pinned the insert's actual **cutting corner** to the tip (Z=0, the one
 * invariant every other marker's insert keeps — see this file's header) or
 * put the bar's own face anywhere near it. The first fix (`barRadius -
 * reach·0.7`, since replaced) stopped the insert's far corner from landing
 * exactly *on* the bar's face with no rounding margin — but the bar's face
 * itself still sat a full `barRadius` away from the tip (the bar's own
 * *radius*, reused as a Z offset for no reason tied to the insert at all).
 * Against that gap, a single corner poking `0.3·reach` past the face reads
 * as a kite grazing a block from a distance, not a seated insert — visibly
 * disconnected over most of its own silhouette, closing to a point only
 * right at that one corner.
 *
 * Now: the insert's centre is placed so its **cutting corner lands exactly
 * on the tip**, the same way `odHolderGeometry`'s insert does, and the
 * bar's face sits `standout` behind the cutting plane — the same clearance
 * every other marker's body keeps, not `barRadius`. With the gap it has to
 * cross cut from ~6 units to ~0.6, the insert's far half is now solidly
 * inside the bar's footprint rather than just touching it.
 *
 * A third generation of the same bug, found after the above shipped: which
 * *vertex* is "the cutting corner" was still hard-coded as the 4-sided
 * insert's own `(reach, −reach)` offset, true only for a square rotated 45°.
 * `threadbar` (sides: 3) hits this same code with a triangular insert, whose
 * vertices sit at completely different angles — pinning that offset to the
 * tip pinned empty space next to the insert instead, leaving it floating
 * off the bar's face by about a unit with no vertex anywhere near (0, 0).
 * A fourth, found immediately after *that* one shipped: picking the tip
 * vertex by "whichever one a flat 45° mount leaves nearest the tip" (then
 * "whichever one's own local angle is closest to 90°, mounted to match
 * sides: 4's old −45°") both pin a real vertex, but neither one is
 * guaranteed to be the insert's own **axis of symmetry** — a V insert
 * mounted off that axis reads as skewed even once its tip is correctly
 * pinned to (0, 0), because the two flanks either side of the point are no
 * longer mirror images of each other on screen.
 *
 * Only one vertex is ever *actually* on that axis, for any `sides`: the one
 * at local angle 0°, i.e. index 0 — because `zScale` only scales the local
 * Z axis, and scaling along an axis can never break mirror symmetry *about*
 * that same axis (every other vertex's own line is off-axis, and the
 * anisotropic scale does break symmetry about those). So: always vertex 0,
 * and mounted at a **fixed** 90° — which, for a point that starts out lying
 * exactly on local Z with zero local X, always rotates it onto world +X
 * with zero world Z, for any `sides`/`zScale` at all. That isn't a
 * coincidence to re-derive per shape; it's point lies at **(0, r·zScale)**.
 * Centring the insert at **(−r·zScale, 0)** is what lands that point
 * exactly on the tip — closed-form, no per-`sides` solving left to do, and
 * the remaining two (or more) vertices come out as exact mirror images of
 * each other in Z, either side of that line — the "base parallel to Z"
 * a real threading insert's own symmetry demands, not a diagonal lean left
 * over from matching a diamond holder's own, unrelated 45° convention.
 *
 * `shape.barDiameter` (mm, one of `App.jsx`'s `BORING_BAR_DIAMETERS` —
 * standard shank sizes, not a free-form number) sets `barRadius` directly —
 * `barDiameter / 2`, literally, in the same units as everything else this
 * marker draws in. An earlier version of this scaled a decorative `s*0.55`
 * baseline proportionally instead, so picking "6" drew whatever the old
 * unlabelled default happened to be (12.3 units) rather than 6 — correct by
 * the marker's own "decorative, not a real dimension" convention, but not
 * what a picker labelled with real shank sizes should do. Direct means a 6mm
 * pick can draw a bar thinner than the insert sitting on it (the insert's
 * own radius, `r`, is still the generic decorative size every OD/boring/
 * parting insert uses, unrelated to `barDiameter`) — accepted deliberately,
 * since the alternative (every pick drawing in proportion to 6, never its
 * own stated size) is the wrong trade the first time round.
 *
 * `shape.insertTilt` (degrees, default 0) adds to the fixed 90° mount —
 * `boring`'s own catalogue entry carries −35° so its insert sits tilted off
 * the bar's own axis rather than mounted dead square to it, same spirit as
 * `odHolderGeometry`'s lead angle.
 *
 * A later attempt moved the insert itself — solving its Z so the near
 * corner landed exactly on `barNearZ`, no wedge needed — and that was wrong
 * in a way the earlier, smaller-gap generations of this bug were not: the
 * near corner's own natural distance from the tip (`boringInsertVertex`'s
 * own geometry, not a small margin) runs to several units, several times
 * `standout` itself, so "solve the setback" dragged the *tip* — the one
 * point every marker in this file promises sits on the cutting plane itself
 * (see this file's header) — off the programmed cutting position by the
 * same several units, in the wrong direction, for both `boring` and
 * `threadbar` alike (tilt only changes *how much*, never whether). The tip
 * stays pinned at (0, 0); `boringConnectorWedge` below is what makes the
 * near corner read as flush with the bar without moving the insert off that
 * invariant to do it.
 */
/**
 * The insert mesh's own mount rotation about Y — fixed at 90° for every
 * `sides`/`angle`. See `boringBarGeometry`'s header for the derivation: a
 * point lying exactly on the local Z axis (zero local X) always rotates
 * onto world +X with zero world Z at a 90° mount, for any anisotropic
 * Z-only scale. There is nothing left to solve per shape.
 */
const BORING_INSERT_MOUNT_ROT = Math.PI / 2;

/**
 * The insert's own tip-vertex offset from its centre, before mounting —
 * local (0, r·zScale) rotated by `rot` (default the fixed 90° mount — see
 * `BORING_INSERT_MOUNT_ROT`'s own header). Vertex index 0 is the one vertex
 * guaranteed to sit on the insert's own axis of symmetry regardless of
 * `zScale`; every other vertex's own line is off that axis and the
 * anisotropic scale breaks symmetry about it. `rot` is a parameter, not
 * always the fixed constant, because a catalogue entry can dial in extra
 * tilt on top of it (`shape.insertTilt` — see `boringBarGeometry`) and the
 * tip still has to land wherever that rotated mount actually puts it.
 */
function boringInsertTip(r, zScale, rot = BORING_INSERT_MOUNT_ROT, sides = 4, index = 0) {
  return boringInsertVertex(0, 0, r, zScale, sides, index, rot);
}

/**
 * Front clearance of a seated insert: the edge facing the part's face leans
 * back this far from the face plane (Z = 0), like the end-cutting-edge angle of
 * a real boring insert. Not zero — an edge lying exactly in Z = 0 would be
 * coplanar with the face it is cutting and z-fight it.
 */
const BORING_FRONT_CLEARANCE = 3 * DEG;

/** How far (mm) a `flushHead` insert's tip stands out of the bar's top. */
const BORING_HEAD_PROTRUSION = 1.5;

/**
 * Which corner of the insert is the cutting tip, and the mount rotation that
 * seats it so **nothing of the insert lies ahead of the tip (Z < 0) or beyond
 * it radially (X > 0)** — the one place a boring bar really cuts.
 *
 * The default mount pins vertex 0 as the tip. For a `sides: 4` diamond that
 * vertex is the *obtuse* 145° corner (the 35° corners are vertices 1 and 3),
 * and a polygon whose tip angle is wider than 90° cannot fit behind a tip that
 * is meant to be the extreme point in both Z and X: with the tilt dialled in by
 * eye (−35°) one corner sat ~3 mm ahead of the tip, so at Z0 the tool read as
 * already cutting into the part's face. So here the tip is the *sharpest*
 * corner, and the rotation is solved (not dialled): the edge nearer the face
 * lies at `BORING_FRONT_CLEARANCE` off the face plane, the other edge `nose`
 * further round, so the whole convex polygon sits inside that wedge. Valid
 * while the sharpest corner is under 90° − clearance — every real insert.
 */
function boringSeatMount(r, zScale, sides) {
  const local = Array.from({ length: sides }, (_, i) => {
    const theta = (i / sides) * 2 * Math.PI;
    return { x: r * Math.sin(theta), z: r * Math.cos(theta) * zScale };
  });
  const edgeAngle = (from, to) => Math.atan2(to.z - from.z, to.x - from.x);
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const interior = (i) => {
    const c = local[i];
    const prev = local[(i + sides - 1) % sides];
    const next = local[(i + 1) % sides];
    return Math.abs(wrap(edgeAngle(c, next) - edgeAngle(c, prev)));
  };
  let tipIndex = 0;
  for (let i = 1; i < sides; i += 1) {
    if (interior(i) < interior(tipIndex) - 1e-9) tipIndex = i;
  }
  const c = local[tipIndex];
  const aPrev = edgeAngle(c, local[(tipIndex + sides - 1) % sides]);
  const aNext = edgeAngle(c, local[(tipIndex + 1) % sides]);
  // A world edge direction is (local angle − rot); the face-side edge is the
  // one with the larger world angle, pointing nearest −X.
  const front = wrap(aNext - aPrev) > 0 ? aNext : aPrev;
  return { tipIndex, rot: front - (Math.PI - BORING_FRONT_CLEARANCE) };
}

/**
 * One of the insert's own vertices, in absolute (tip-relative) coordinates —
 * `boringInsertTip`'s own derivation, generalised to any vertex index and
 * (so a tilted mount keeps every vertex consistent, not just the tip) any
 * mount rotation.
 */
export function boringInsertVertex(insertX, insertZ, r, zScale, sides, i, rot = BORING_INSERT_MOUNT_ROT) {
  const theta = (i / sides) * 2 * Math.PI;
  const lx = r * Math.sin(theta);
  const lz = r * Math.cos(theta) * zScale;
  return {
    x: insertX + (lx * Math.cos(rot) + lz * Math.sin(rot)),
    z: insertZ + (-lx * Math.sin(rot) + lz * Math.cos(rot)),
  };
}

/**
 * A small flat triangle, same material as the bar, bridging the gap between
 * the insert's near corner (vertex `sides − 1`, the one neighbouring the
 * tip on the bar's side) and the bar's own face — not by moving the insert
 * (see `boringBarGeometry`'s header for why solving the insert's own
 * position for this broke the tip-at-origin invariant instead), purely a
 * cosmetic infill the way `odHolderGeometry`'s own bevelled head is. One
 * triangle: [the tip, the near corner, and the bar's own near-top corner —
 * `-standout` in X, not `-barRadius`: the bar mesh in `Viewport.jsx` is
 * positioned at `-(barRadius + standout)`, so its own near surface (the one
 * facing the cutting plane) sits at X = -standout, and `barRadius` deep is
 * the middle of its solid body, not its edge. A version of this briefly
 * used `-barRadius` instead, on the assumption that the bar's crown was the
 * target — it looked plausible in Front/Iso, where the wedge is seen
 * near edge-on, but a close Top view showed the wedge now overlapping the
 * bar's own cylinder rather than meeting its face, a visible seam where the
 * two surfaces crossed instead of touching]. The edge from the tip to the
 * near corner is already the insert's own edge, so this reads as a
 * seamless continuation of it.
 *
 * Only called for an **untilted** mount (see `boringBarGeometry`): at
 * `mountRot = 90°` the near corner's own local-X contribution is zero, so
 * it stays close to the tip's own X and the triangle reads as a thin
 * sliver. A real tilt swings that same corner — it is still a rigid
 * rotation about the pinned tip, so every *other* vertex necessarily moves
 * in an arc around it — out to an X far from the tip's own, several units
 * wide, the same order as the insert's own radius: not a sliver bridging a
 * gap any more but a second, wide, flat face of roughly the insert's own
 * size, open in the air in front of the bar rather than hidden inside it.
 * That is what read as a slab of "extra" bar material. There is no bend of
 * this triangle that stays thin across a real tilt, so a tilted insert
 * draws with no wedge at all instead — see `boringBarGeometry`.
 */
function boringConnectorWedge(insert, standout, barNearZ) {
  const tip = boringInsertVertex(insert.x, insert.z, insert.r, insert.zScale, insert.sides, 0, insert.rot);
  const nearIndex = insert.sides - 1;
  const near = boringInsertVertex(insert.x, insert.z, insert.r, insert.zScale, insert.sides, nearIndex, insert.rot);
  return {
    points: [[tip.x, tip.z], [near.x, near.z], [-standout, barNearZ]],
  };
}

export function boringBarGeometry(radius = 0.8, shape = {}) {
  const { s, thickY, standout } = toolScale(radius);
  const sides = shape.sides ?? 4;
  const angle = shape.angle ?? 35;
  // 6 mm, unprompted, matches the Tool table's own default display
  // (`BORING_BAR_DIAMETERS[0]` in App.jsx) — an unset override must draw
  // what the picker already claims to be showing.
  const barRadius = (shape.barDiameter ?? 6) / 2;
  // The insert is a `sides`-gon prism extruded along Y (see its `thickY`
  // below) — read face-on from Top, which looks straight down that same
  // axis. `s * 0.42` was tuned by eye against Front/Iso only, where the
  // insert is seen near edge-on and reads as a modest wedge; from Top the
  // same number reads as the insert's full, undistorted width, and at the
  // old value that width ran well past the bar carrying it — a real boring
  // insert projects past its bar only modestly, for bore clearance, not by
  // half again its width. Capped at the bar's own radius for that reason.
  const r = Math.min(s * 0.42, barRadius);
  // Same fix as odHolderGeometry's zScale: a pointed insert's half-nose
  // angle, not a hard-coded 1 for anything that isn't a 4-sided diamond.
  const zScale = Math.max(Math.tan((angle / 2) * DEG), 0.2);
  // `frontSeat` solves the tip corner and rotation so the insert never lies
  // ahead of the tip (see `boringSeatMount`); otherwise the legacy mount.
  const seat = shape.frontSeat ? boringSeatMount(r, zScale, sides) : null;
  const tipIndex = seat ? seat.tipIndex : 0;
  const mountRot = seat ? seat.rot : BORING_INSERT_MOUNT_ROT + (shape.insertTilt ?? 0) * DEG;
  const tip = boringInsertTip(r, zScale, mountRot, sides, tipIndex);
  // The bar sits on the spindle axis — Y=0, the same plane the stock itself
  // is centred on (a round bar of material is symmetric about that axis by
  // construction). A centring pass through here once moved the *insert* to
  // the bar's own axis instead, to read as seated through the bar's middle
  // from Front — which left the insert sitting well clear of the stock's
  // own centre once the stock was visible alongside it, looking like it
  // was cutting at nothing. Centring the bar here instead keeps both where
  // the workpiece actually is; `depthTest: false` on the insert (set in
  // `Viewport.jsx`) is what keeps it visible over the bar's crown in Top
  // view now that the crown can reach above Y=0, not a Y offset.
  const barY = 0;
  const insert = {
    r,
    thickY,
    sides,
    zScale,
    // Which vertex is the cutting tip, pinned at (0, 0) — 0 unless `frontSeat`.
    tipIndex,
    // `Viewport.jsx` mounts the insert mesh at this rotation.
    rot: mountRot,
    // The insert's centre sits exactly far enough back to cancel its own
    // tip vertex's rotated offset (`boringInsertTip`), so that vertex —
    // the one actually doing the cutting, not an assumed one — lands
    // precisely on (0, 0), same invariant as every other marker here, for
    // any `mountRot` at all.
    x: -tip.x,
    z: -tip.z,
  };
  // `flushHead` (threading bar, trigon bar): the bar's head is carried forward
  // to the insert's frontmost corner, so nothing of the insert hangs out past
  // the bar's face in Z, and the tip stands `BORING_HEAD_PROTRUSION` proud of
  // the bar's top in X — a real insert reaches out of its head to cut, but only
  // a millimetre or two (level with the top read as not reaching at all; the
  // legacy 0.6 mm gap read as hardly proud). Otherwise the legacy gap: face just
  // behind the cutting plane, top `standout` below the tip.
  const flush = Boolean(shape.flushHead) && !seat;
  const frontZ = flush
    ? Math.min(0, ...Array.from({ length: sides }, (_, i) => boringInsertVertex(
      insert.x, insert.z, r, zScale, sides, i, mountRot,
    ).z))
    : standout;
  const barNearZ = frontZ;
  const barGap = flush ? BORING_HEAD_PROTRUSION : standout;
  return {
    barRadius,
    barGap,
    barLength: s * 6,
    barY,
    // The bar's FACE (its near end, not just its crown) sits here too — a
    // hair behind the cutting plane, same reasoning as `barY`, not `barRadius`
    // away from it. `Viewport.jsx` reads this for the bar's Z position.
    barNearZ,
    insert,
    // Flush with the cutting plane, same invariant as every other marker's
    // insert (see this file's header) — and, since the bar is now centred
    // on Y=0 too, this also sits close to the bar's own middle rather than
    // its crown, without the two requirements fighting each other.
    insertY: -thickY / 2,
    standout,
    // See `boringConnectorWedge`'s own header — fills the gap `barNearZ`
    // otherwise leaves open between the (pinned-at-origin) tip and the
    // bar's face, without moving the insert off that invariant to do it.
    // Only for an untilted mount: a real tilt swings the vertex this
    // triangle's far corner uses out to roughly the insert's own size,
    // reading as a slab of "extra" bar material rather than a thin sliver.
    //
    // A "fill every floating vertex" backing pad was tried here and reverted:
    // it papered over the real fault (a corner ahead of the tip, see
    // `boringSeatMount`) with solid grey that read as tool material already
    // cut through the part's face. The fix is in where the insert sits, so a
    // `frontSeat` insert needs no wedge at all.
    connectorWedge: !seat && !flush && (shape.insertTilt ?? 0) === 0
      ? boringConnectorWedge(insert, standout, barNearZ)
      : null,
  };
}

/**
 * A coaxial axial tool — a drill, reamer, tap or centre drill — on the
 * spindle centreline: a straight round shaft along +Z ending in a pointed
 * tip, **not** a boring bar's offset shank. A boring bar reaches into a bore
 * from one side, which is why its geometry shifts sideways in X as well as
 * dropping in Y; a drill's own axis *is* the spindle axis, so it stays on
 * X = 0 and only the tip's point angle changes its silhouette.
 *
 * `angle` is a literal tool point angle here, not an insert-corner angle like
 * the OD/boring markers use — a twist drill really is ~118°, and nothing
 * about this shape goes singular as the angle passes 90° the way
 * `odHolderGeometry`'s does (see the comment on the catalogue entries), so
 * the real angle can be used directly.
 *
 * No `standout` drop, unlike every other marker here: that trick exists for
 * a *flat* face sitting coplanar with another flat face (an insert's rake
 * face against the cutting plane) — a drill's tip is a single vertex and its
 * shaft a curved surface, neither of which can coplanar-fight anything. The
 * first version of this dropped the shaft only, leaving the cone sitting flush
 * at the join — the step between the two read as a blunt, rounded cap
 * instead of a point, not a subtle depth-fight at all.
 */
export function drillGeometry(radius = 0.8, shape = {}) {
  // True to scale with `radius` itself — unlike the OD/boring/parting markers,
  // which run it through `toolScale()`'s proportional blow-up (that `radius`
  // is a small nose-radius-like number, not a real dimension). A drill's
  // radius *is* the hole it cuts (`turningCutRadiusResolver` carves the same
  // number), so scaling it up here would draw a bit visibly narrower than the
  // bore it is shown making.
  const shaftRadius = Math.max(radius, 0.25);
  const angle = shape.angle ?? 118;
  const tipHeight = shaftRadius / Math.max(Math.tan((angle / 2) * DEG), 0.05);
  return { shaftRadius, shaftLength: Math.max(shaftRadius * 8, 5), tipHeight };
}

/** Parting / grooving blade: a thin tall plate down to a narrow edge. */
export function partingBladeGeometry(radius = 0.8, shape = {}) {
  const { s, standout } = toolScale(radius);
  const depth = Math.max(radius * 2.4, 1.8) * 1.4;
  return {
    // True to scale with `grooveW` — this is the one dimension of the blade
    // that is a real, measured number rather than a decorated drawing: it
    // is the kerf, and `turningGrooveWidthResolver` carves exactly this wide.
    // Scaling it by `toolScale()`'s proportional factor (as every other
    // dimension here still is) drew a groove on the marker visibly narrower
    // than the one actually cut.
    width: Math.max(shape.grooveW ?? 3, 0.3),
    height: s * 5,
    depth,
    // Blade top `standout` under the plane; the cutting tip is what reaches it.
    bladeY: -depth / 2 - standout,
    tipY: -(depth * 1.02) / 2,
    tipHeight: s * 0.55,
    standout,
  };
}

/**
 * The Y span a marker occupies, as [low, high]. The whole point: `high` must be
 * 0 — the cutting corner on the spindle centre plane — for every marker,
 * **except `boring`**: its bar is centred on that same plane (matching the
 * stock, which is centred on it too — see `boringBarGeometry`'s header), so
 * its crown can reach *above* Y=0 rather than stopping there.
 */
export function markerYSpan(kind, radius, shape = {}) {
  if (kind === 'boring') {
    const g = boringBarGeometry(radius, shape);
    return [
      Math.min(g.barY - g.barRadius, g.insertY - g.insert.thickY / 2),
      Math.max(g.barY + g.barRadius, 0),
    ];
  }
  if (kind === 'parting') {
    const g = partingBladeGeometry(radius, shape);
    return [Math.min(g.bladeY - g.depth / 2, g.tipY - (g.depth * 1.02) / 2), 0];
  }
  if (kind === 'drill') {
    // No standout (see drillGeometry's own doc) — the marker is perfectly
    // coaxial, so its span is simply the shaft diameter either side of the
    // centreline, down to the tip sitting exactly on Y=0.
    const g = drillGeometry(radius, shape);
    return [-2 * g.shaftRadius, 0];
  }
  const g = odHolderGeometry(radius, shape);
  return [g.bodyY - g.depth, 0];
}

/**
 * Should the show/hide-tool control be offered at all?
 *
 * Only for turning. The lathe marker is one piece — holder and insert
 * together — so there is nothing inside it to partially drop the way
 * `showArbor` drops just the collet above a mill's cutter (see
 * `millTool.js`'s `offerArborToggle`); this toggle hides the whole thing,
 * which is exactly what a lathe operator wants when the holder sits over the
 * cut they are trying to look at. The sketch page has no tool at all.
 */
export function offerToolToggle({ mode = 'mill', sketching = false } = {}) {
  return !sketching && mode === 'turn';
}

/**
 * Standard boring-bar shank diameters (mm) — the sizes a boring bar actually
 * ships in, not an arbitrary continuous range. Drives both the bar diameter
 * picker below and `boringBarGeometry`'s `barDiameter` shape field.
 */
export const BORING_BAR_DIAMETERS = [6, 8, 10, 12, 16, 20, 25, 32];
