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
  const zScale = sides === 4 ? Math.max(Math.tan((angle / 2) * DEG), 0.2) : 1;
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

/** Boring bar: a round shank along +Z with a small insert at the tip. */
export function boringBarGeometry(radius = 0.8, shape = {}) {
  const { s, thickY, standout } = toolScale(radius);
  const sides = shape.sides ?? 4;
  const angle = shape.angle ?? 35;
  const r = s * 0.42;
  const barRadius = s * 0.55;
  return {
    barRadius,
    barLength: s * 6,
    // The bar's crown clears the cutting plane by `standout`, so the insert's
    // rake face is not tangent to it — a cylinder touching a plane along a line
    // fights for that line exactly as two coplanar faces do.
    barY: -(barRadius + standout),
    insert: { r, thickY, sides, zScale: sides === 4 ? Math.max(Math.tan((angle / 2) * DEG), 0.2) : 1 },
    insertY: -thickY / 2,
    standout,
  };
}

/** Parting / grooving blade: a thin tall plate down to a narrow edge. */
export function partingBladeGeometry(radius = 0.8, shape = {}) {
  const { s, standout } = toolScale(radius);
  const depth = Math.max(radius * 2.4, 1.8) * 1.4;
  return {
    width: Math.max((shape.grooveW ?? 3) * 0.35, s * 0.18),
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
 * 0 — the cutting corner on the spindle centre plane — for every marker.
 */
export function markerYSpan(kind, radius, shape = {}) {
  if (kind === 'boring') {
    const g = boringBarGeometry(radius, shape);
    return [Math.min(g.barY - g.barRadius, g.insertY - g.insert.thickY / 2), 0];
  }
  if (kind === 'parting') {
    const g = partingBladeGeometry(radius, shape);
    return [Math.min(g.bladeY - g.depth / 2, g.tipY - (g.depth * 1.02) / 2), 0];
  }
  const g = odHolderGeometry(radius, shape);
  return [g.bodyY - g.depth, 0];
}
