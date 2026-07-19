/**
 * Scene-setup derivations that used to sit inline in `App.jsx`: how the fit box
 * and the chuck are worked out from the parsed bounds.
 *
 * Pure, because both were wrong at some point in exactly the way arithmetic goes
 * wrong — reading the radius off the wrong axis — and the chuck then collapsed to
 * nothing on screen with no error anywhere.
 */

/**
 * Scene axis the turning radius runs along. A lathe programs it as X and the
 * scene is not rotated, so anything pulling a radius out of bounds uses this
 * rather than a bare index.
 */
export const TURN_RADIAL = 0;
/** Spindle axis for turning. */
export const TURN_AXIAL = 2;

/**
 * The box the camera should frame. For turning the backplot is one-sided in the
 * radial axis (radius ≥ 0) and the part revolves, so the box is made symmetric
 * about the spindle and pulled back toward the chuck — otherwise the view frames
 * half a part and looks off-centre.
 *
 * @param {'mill'|'turn'} mode
 * @param {{min:number[],max:number[],feedMin?:number[],feedMax?:number[]}|null} bounds
 */
export function fitBoundsFor(mode, bounds) {
  if (!bounds) return null;
  const hasFeeds = bounds.feedMin && Number.isFinite(bounds.feedMin[0]);
  const min = [...(hasFeeds ? bounds.feedMin : bounds.min)];
  const max = [...(hasFeeds ? bounds.feedMax : bounds.max)];
  if (mode === 'turn') {
    const r = Math.max(max[TURN_RADIAL], 1) * 1.5;
    min[0] = -r; max[0] = r;
    min[1] = -r; max[1] = r;
    min[TURN_AXIAL] -= 10;
  }
  return { min, max };
}

/**
 * Where the chuck sits and how big it grips, from the *cutting* bounds (not the
 * padded fit) so the clearance to the deepest cut is preserved however the view
 * is framed. The chuck grips the **raw bar** — the turned OD plus the oversize —
 * so the whole bar reads as one stock size.
 *
 * Returns null when there is nothing to grip (no feed moves, or milling).
 */
export function chuckFromBounds(mode, bounds, stockOversize = 0) {
  if (mode !== 'turn' || !bounds?.feedMin || !Number.isFinite(bounds.feedMin[0])) return null;
  return {
    z: bounds.feedMin[TURN_AXIAL],
    od: Math.max(bounds.feedMax[TURN_RADIAL] + stockOversize / 2, 1),
  };
}
