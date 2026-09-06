/**
 * The program's headline numbers, as rows to draw.
 *
 * Cycle time, cutting length, rapid length and the block count used to sit in the
 * sidebar, which meant they were behind the Setup drawer — and the drawer covers the
 * viewport. Judging a simulation by them therefore meant opening a panel over the
 * thing being judged, reading four numbers, and closing it again. They belong on the
 * viewport with the run they describe, in both milling and turning.
 *
 * Pure. No React, no store — the view decides where the panel sits, this decides what
 * is in it, and a test can assert the numbers without rendering anything.
 */

/** Seconds → `1:02:03` / `2:03` / `0:03`, the way a control posts cycle time. */
export function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Thousands-grouped to `n` decimals, always in `en-US`.
 *
 * The locale is named rather than left to the host: a program is 12,345.6 mm long on
 * the shop's machines whatever a browser is set to, and a locale that groups with a
 * dot would print that as `12.345,6` — which reads as twelve millimetres.
 */
function mm(value, decimals = 1) {
  const n = Number(value);
  if (!isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * The four numbers, in the order they are read.
 *
 * Returns `[]` for a program that has not been parsed, so the view can render the
 * panel or not from the array's length alone and never has to null-check a field.
 *
 * @param {object|null} stats  the interpreter's `stats`
 * @returns {{key: string, label: string, value: string}[]}
 */
export function programStatRows(stats) {
  if (!stats) return [];
  return [
    { key: 'cycleTime', label: 'Cycle time', value: formatDuration(stats.cycleTime) },
    { key: 'feedLength', label: 'Cutting length', value: mm(stats.feedLength), unit: 'mm' },
    { key: 'rapidLength', label: 'Rapid', value: mm(stats.rapidLength), unit: 'mm' },
    { key: 'blocks', label: 'Segments', value: mm(stats.blocks, 0) },
  ];
}

/**
 * Where the cycle time went — the tooltip behind it.
 *
 * Dwell is named only when there is some: a machine that never dwells reading
 * "dwell 0:00" invites the question of what it was waiting for.
 */
export function timingBreakdown(stats) {
  if (!stats) return '';
  const parts = [
    `feed ${formatDuration(stats.feedTime)}`,
    `rapid ${formatDuration(stats.rapidTime)}`,
  ];
  if (stats.dwellTime > 0) parts.push(`dwell ${formatDuration(stats.dwellTime)}`);
  return parts.join(' · ');
}
