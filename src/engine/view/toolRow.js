/**
 * The Tool table's compact row — one line per tool, not the wall of pickers it
 * used to be. Editing itself moved into a per-tool dialog (`App.jsx`'s
 * `ToolEditDialog`); this is what the row shows at a glance so it is worth
 * showing without opening anything: the diameter and, picked or detected,
 * what the tool actually is.
 *
 * Pure. No React, no store — same reasoning as `programStats.js`.
 */

/**
 * @param {{turning?: boolean, diameter?: number|null,
 *   holderLabel?: string|null, cutterLabel?: string|null}} args
 *   `holderLabel` is a turning holder's catalogue label (`sim/turning.js`);
 *   `cutterLabel` is a milling cutter's (`cam/cutters.js`). Only the one for
 *   the current mode is read.
 * @returns {string}
 */
export function toolSpecSummary({
  turning = false, diameter = null, holderLabel = null, cutterLabel = null,
} = {}) {
  const dia = diameter != null && diameter > 0 ? `⌀${diameter}` : '⌀—';
  const what = turning ? holderLabel : cutterLabel;
  return what ? `${dia} · ${what}` : dia;
}
