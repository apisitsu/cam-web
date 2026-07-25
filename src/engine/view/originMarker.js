/**
 * Sizing for the origin marker — the small axis triad drawn at (0,0,0) once a
 * datum is set, so picking a point reads as visible confirmation rather than
 * a number in a panel the operator has to trust.
 *
 * A fixed size would be wrong at both ends of this app's actual parts (a
 * 10mm pin and a 600mm lathe bar cannot share one marker), so it scales off
 * the part's own bounding diagonal instead.
 */

const MIN_SIZE = 2;
const FRACTION = 0.12;

/** Axis length for the marker, in mm, given the part's `analyzeMesh` bounds. */
export function originMarkerSize(bounds) {
  const diagonal = bounds?.diagonal;
  if (!Number.isFinite(diagonal) || diagonal <= 0) return MIN_SIZE;
  return Math.max(diagonal * FRACTION, MIN_SIZE);
}

/**
 * Length of the rotary-axis line drawn through a picked A-axis centre.
 *
 * The axis runs the length of X, so — unlike the origin triad, which only
 * needs to read as "a point" — this should visibly span the part rather than
 * sit at one scale-independent size. A margin either side keeps it from
 * looking clipped to exactly the part's own extent.
 */
export function rotaryAxisLength(bounds) {
  const spanX = bounds?.size?.[0];
  if (!Number.isFinite(spanX) || spanX <= 0) return MIN_SIZE;
  return spanX * 1.2;
}
