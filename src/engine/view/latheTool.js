/**
 * Lathe tool-marker geometry — the numbers behind the OD holder, boring bar and
 * parting blade, separated from the meshes that draw them.
 *
 * Turning cuts in the plane through the spindle axis (Y = 0), so **every marker's
 * cutting corner sits at Y = 0 with the body hanging below it**: the insert's
 * rake face is the top. Getting that wrong is invisible in a screenshot but
 * obvious in a number, which is why it lives here — the insert was once mounted
 * on the holder's side face and floated 1–5 mm clear of the plane it cuts in.
 */

const DEG = Math.PI / 180;

/** Shared sizes, from the marker radius the viewport passes in. */
export function toolScale(radius) {
  const s = Math.max(radius * 7, 6);
  const thickY = Math.max(radius * 2.4, 1.8);
  return { s, thickY };
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
  const { s, thickY } = toolScale(radius);
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
    // Silhouette in (x = radial, y = along Z), tip first.
    outline: [[0, 0], [Xbot, Zf], [topX, Zf], [topX, Zb], [Xbot, Zb]],
    insert,
    // Y placement: the insert's rake face is the cutting plane.
    insertY: -thickY / 2,
    screwY: 0,
    screwR: s * 0.16,
    screwH: thickY * 0.4,
    shankWidth: W,
    height: topX,
  };
}

/** Boring bar: a round shank along +Z with a small insert at the tip. */
export function boringBarGeometry(radius = 0.8, shape = {}) {
  const { s, thickY } = toolScale(radius);
  const sides = shape.sides ?? 4;
  const angle = shape.angle ?? 35;
  const r = s * 0.42;
  return {
    barRadius: s * 0.55,
    barLength: s * 6,
    barY: -(s * 0.55),               // top of the bar on the cutting plane
    insert: { r, thickY, sides, zScale: sides === 4 ? Math.max(Math.tan((angle / 2) * DEG), 0.2) : 1 },
    insertY: -thickY / 2,
  };
}

/** Parting / grooving blade: a thin tall plate down to a narrow edge. */
export function partingBladeGeometry(radius = 0.8, shape = {}) {
  const { s } = toolScale(radius);
  const depth = Math.max(radius * 2.4, 1.8) * 1.4;
  return {
    width: Math.max((shape.grooveW ?? 3) * 0.35, s * 0.18),
    height: s * 5,
    depth,
    bladeY: -depth / 2,
    tipY: -(depth * 1.02) / 2,
    tipHeight: s * 0.55,
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
  return [-g.depth, 0];
}
