/**
 * How much of a detected feature list is worth putting on screen.
 *
 * `detectFeatures` recovers *every* merged face, and on an organic model — a
 * curved fork, anything with a blend or a fillet — the 1° coplanarity tolerance
 * that correctly keeps a 2° draft distinct from a flat floor also means a curved
 * wall arrives as thousands of one-triangle faces. Seven thousand is normal, not
 * pathological.
 *
 * That is fine for the geometry (picking on the model maps a triangle back to
 * its face regardless) and ruinous for the panel, which was rendering a row per
 * face. Every unrelated store change — including the `planning → ready` flip
 * each rebuild causes — reconciled the whole list, so adjusting any setting
 * stuttered in proportion to how curvy the part was.
 *
 * Faces arrive sorted biggest-first, so a prefix is exactly the useful part:
 * `detectPlanarFaces` sorts that way precisely because "the face someone means
 * is nearly always a big one, and a list that opens on 400 slivers is a list
 * nobody reads". The remainder stays pickable on the model itself.
 *
 * Pure. No React, no store.
 */

/**
 * Rows worth rendering. Comfortably more than anyone scrolls through, and small
 * enough that re-rendering the list is never what makes the panel feel slow.
 */
export const FEATURE_LIST_LIMIT = 150;

/**
 * Split a sorted feature list into what to draw and what to summarise.
 *
 * @param {object[]} items faces or edges, already sorted most-significant first
 * @param {number} limit   how many rows to draw
 * @returns {{shown: object[], hidden: number}}
 */
export function visibleFeatures(items, limit = FEATURE_LIST_LIMIT) {
  const list = items ?? [];
  if (limit < 0 || list.length <= limit) return { shown: list, hidden: 0 };
  return { shown: list.slice(0, limit), hidden: list.length - limit };
}

/** The note shown under a truncated list, or null when nothing was cut. */
export function hiddenNote(hidden, noun = 'face') {
  if (!hidden) return null;
  return `+${hidden} smaller ${noun}${hidden === 1 ? '' : 's'} — click the model to pick one`;
}
