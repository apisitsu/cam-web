/**
 * Milling tool-marker geometry — the numbers behind the cutter, shank and arbor
 * drawn at the tool tip.
 *
 * This arithmetic used to sit inside `EndMill` in `Viewport.jsx`. It is exactly
 * the kind the project keeps out of components: four stacked cylinders whose
 * lengths and centres are derived from a gauge length that may or may not be
 * known, with clamps at both ends. A mistake here does not throw — it draws a
 * tool floating above its own tip, or a shank of negative length, and only a
 * person looking at the screen would notice.
 *
 * Everything is in the tip's local frame: **+Z runs up the tool, 0 is the tip**.
 * The caller rotates the cylinders to stand up in world Z.
 *
 * Pure. No three.js, no React.
 */

/** Arbor (collet/holder) length in mm — a fixed lump, it is not to scale. */
export const ARBOR_LENGTH = 26;

/**
 * The four parts of the marker, as plain data.
 *
 * `length` is the gauge length from the tool table — tip to the collet face. When
 * it is known the flutes and shank span exactly that far, so the stick-out is to
 * scale; when it is not, a plausible default stands in. Below the flute length
 * there is no room for a shank at all, hence the clamp.
 *
 * @param {{radius?:number, type?:'flat'|'ball', length?:number,
 *   arbor?:boolean}} opts
 *   `arbor: false` omits the holder — it is the widest thing on the tool and it
 *   hides the cut it is making. See `showArbor` in camStore.
 * @returns {{nose:object|null, flutes:object, shank:object, arbor:object|null,
 *   gauge:number}} each part as `{radius|rBottom/rTop, length, z}` where `z` is
 *   the mesh centre along the tool axis.
 */
export function endMillGeometry({
  radius = 3, type = 'flat', length = 0, arbor = true,
} = {}) {
  const r = Math.max(radius, 1e-6);
  // A ball nose occupies the first `r` of the tool, so the flutes start above it.
  const noseOffset = type === 'ball' ? r : 0;
  const flute = Math.max(8, r * 4);
  const arborR = Math.max(r * 1.8, r + 4);
  const gauge = Math.max(length > 0 ? length : flute + r * 3, flute + 1);
  const fluteLen = Math.min(flute, gauge - noseOffset);
  const shankR = Math.max(r * 0.9, r - 0.5);
  const shankBot = noseOffset + fluteLen;
  // Never zero-length: a degenerate cylinder renders as a glitch, not as nothing.
  const shankLen = Math.max(0.01, gauge - shankBot);

  return {
    nose: type === 'ball' ? { radius: r, z: r } : null,
    flutes: { radius: r, length: fluteLen, z: noseOffset + fluteLen / 2 },
    shank: { radius: shankR, length: shankLen, z: shankBot + shankLen / 2 },
    arbor: arbor
      ? {
          rBottom: arborR,
          rTop: arborR * 0.7,
          length: ARBOR_LENGTH,
          z: gauge + ARBOR_LENGTH / 2,
        }
      : null,
    gauge,
  };
}

/**
 * Should the show/hide-arbor control be offered at all?
 *
 * Only for milling: the lathe marker is a holder drawn in the cutting plane (see
 * `latheTool.js`), not a collet above the tool, so the toggle would do nothing
 * there — and a dead control is worse than no control. The sketch page has no
 * tool at all.
 */
export function offerArborToggle({ mode = 'mill', sketching = false } = {}) {
  return !sketching && mode === 'mill';
}
